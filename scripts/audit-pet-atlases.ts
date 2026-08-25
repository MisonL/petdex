import { writeFile } from "node:fs/promises";

import sharp from "sharp";

import { petStates } from "../src/lib/pet-states";
import {
  canonicalSpriteDimensions,
  detectSpriteAtlas,
  SPRITE_COLUMNS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  type SpriteAtlasVersion,
} from "../src/lib/sprite-atlas";

const SEARCH_URL = "https://petdex.dev/api/pets/search";
const MANIFEST_V2_URL = "https://petdex.dev/api/manifest/v2";
const LEGACY_MANIFEST_URL = "https://petdex.dev/api/manifest";
const TRUSTED_ASSET_HOST = "assets.petdex.dev";
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_WINDOW = 64;
const MAX_WINDOW = 500;
const MAX_NETWORK_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

/**
 * Checks that still require a human or Petdex edit/review workflow. Keep
 * these explicit so every manifest entry carries the same review contract.
 */
export const MANUAL_REVIEW_CHECKS = [
  "idle eye-open default state",
  "action continuity and direction consistency",
  "transparent edge bounds and left/right clipping",
  "sprite scale consistency and flattened proportions",
  "state-row proportion and frame-to-frame continuity",
  "compression artifacts and visual integrity",
] as const;

type AuditPet = {
  slug: string;
  approvedAt: string | null;
  spritesheetUrl: string;
  spriteVersionNumber: 1 | 2;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type FrameBounds = {
  row: number;
  column: number;
  width: number;
  height: number;
  touchesEdge: boolean;
};

export type AtlasPixelSummary = {
  expectedFrames: number;
  emptyFrames: number;
  touchingFrames: number;
  geometryOutliers: number;
  rowMedians: Array<{ row: number; width: number; height: number }>;
};

export type AtlasAuditEntry = {
  slug: string;
  approvedAt: string | null;
  declaredVersion: 1 | 2;
  detectedVersion: 1 | 2 | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  summary: AtlasPixelSummary | null;
  error: string | null;
  errorKind: "network" | "asset" | null;
};

export type ManualReviewRecord = {
  status: "pending";
  checks: readonly string[];
};

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function numberArg(args: string[], flag: string, fallback: number): number {
  const value = Number(valueAfter(args, flag));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function expectedColumns(version: SpriteAtlasVersion, row: number): number {
  if (version === 2 && row >= 9) return SPRITE_COLUMNS;
  return petStates.find((state) => state.row === row)?.frames ?? 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Summarize cell geometry from a canonical RGBA atlas. */
export function summarizeAtlasPixels(
  data: Buffer,
  width: number,
  version: SpriteAtlasVersion,
): AtlasPixelSummary {
  const rows = version === 2 ? 11 : 9;
  const frames: FrameBounds[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < expectedColumns(version, row); column++) {
      let minX = SPRITE_FRAME_WIDTH;
      let minY = SPRITE_FRAME_HEIGHT;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < SPRITE_FRAME_HEIGHT; y++) {
        for (let x = 0; x < SPRITE_FRAME_WIDTH; x++) {
          const alpha =
            data[
              ((row * SPRITE_FRAME_HEIGHT + y) * width +
                column * SPRITE_FRAME_WIDTH +
                x) *
                4 +
                3
            ];
          if (alpha <= 8) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      frames.push({
        row,
        column,
        width: maxX >= 0 ? maxX - minX + 1 : 0,
        height: maxY >= 0 ? maxY - minY + 1 : 0,
        touchesEdge:
          minX === 0 ||
          minY === 0 ||
          maxX === SPRITE_FRAME_WIDTH - 1 ||
          maxY === SPRITE_FRAME_HEIGHT - 1,
      });
    }
  }

  const visible = frames.filter((frame) => frame.width > 0 && frame.height > 0);
  const medianWidth = median(visible.map((frame) => frame.width));
  const medianHeight = median(visible.map((frame) => frame.height));
  const geometryOutliers = visible.filter(
    (frame) =>
      frame.width < Math.max(8, medianWidth * 0.45) ||
      frame.width > medianWidth * 1.8 ||
      frame.height < Math.max(8, medianHeight * 0.45) ||
      frame.height > medianHeight * 1.8,
  ).length;

  const rowMedians = Array.from({ length: rows }, (_, row) => {
    const rowFrames = visible.filter((frame) => frame.row === row);
    return {
      row,
      width: median(rowFrames.map((frame) => frame.width)),
      height: median(rowFrames.map((frame) => frame.height)),
    };
  });

  return {
    expectedFrames: frames.length,
    emptyFrames: frames.filter((frame) => frame.width === 0).length,
    touchingFrames: visible.filter((frame) => frame.touchesEdge).length,
    geometryOutliers,
    rowMedians,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableNetworkError(error: unknown): boolean {
  return /socket|timed out|timeout|fetch failed|network|connection|request failed \((408|429|5\d\d)\)/i.test(
    errorMessage(error),
  );
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)),
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt === MAX_NETWORK_ATTEMPTS)
        throw error;
      await waitBeforeRetry(attempt);
    }
  }
  throw lastError;
}

/** Read an asset without allowing a chunked response to exceed the audit cap. */
export async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
  timeoutMs = 15_000,
): Promise<Buffer> {
  if (!response.body) throw new Error("asset response has no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        throw new Error("asset read timed out");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("asset read timed out"));
            }, remaining);
          }),
        ]);
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel("asset exceeds audit limit");
          throw new Error("asset exceeds audit limit");
        }
        chunks.push(Buffer.from(value));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } catch (error) {
    if (timedOut) void reader.cancel("asset read timed out");
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out pending read can still hold the stream lock briefly.
    }
  }
  return Buffer.concat(chunks, total);
}

async function fetchOldestWindow(limit: number): Promise<AuditPet[]> {
  const first = await fetchJson<{
    total?: number;
    pets: Array<Record<string, unknown>>;
  }>(`${SEARCH_URL}?sort=recent&limit=1&includeMeta=1`);
  const total = Number.isInteger(first.total) ? Number(first.total) : 0;
  const start = Math.max(0, total - limit);
  const pets: AuditPet[] = [];
  for (let cursor = start; cursor < total; cursor += 60) {
    const page = await fetchJson<{
      nextCursor: number | null;
      pets: Array<Record<string, unknown>>;
    }>(`${SEARCH_URL}?sort=recent&limit=60&cursor=${cursor}&includeMeta=0`);
    for (const pet of page.pets) {
      if (
        typeof pet.slug === "string" &&
        typeof pet.spritesheetPath === "string"
      ) {
        pets.push({
          slug: pet.slug,
          approvedAt:
            typeof pet.approvedAt === "string" ? pet.approvedAt : null,
          spritesheetUrl: pet.spritesheetPath,
          spriteVersionNumber: pet.spriteVersionNumber === 2 ? 2 : 1,
        });
      }
    }
    if (page.nextCursor === null) break;
  }
  return pets.slice(-limit).reverse();
}

async function fetchManifest(): Promise<AuditPet[]> {
  let compactManifest: unknown;
  try {
    compactManifest = await fetchJson<unknown>(MANIFEST_V2_URL);
  } catch {
    const legacyManifest = await fetchJson<unknown>(LEGACY_MANIFEST_URL);
    return parseLegacyManifest(legacyManifest);
  }
  return parseCompactManifest(compactManifest);
}

export function parseCompactManifest(input: unknown): AuditPet[] {
  if (
    !isRecord(input) ||
    typeof input.assetBase !== "string" ||
    !Array.isArray(input.pets)
  ) {
    throw new Error("invalid compact manifest");
  }
  const assetBase = input.assetBase;
  return input.pets.map((rawPet, index) => {
    if (
      !Array.isArray(rawPet) ||
      typeof rawPet[0] !== "string" ||
      typeof rawPet[4] !== "string" ||
      (rawPet[7] !== 1 && rawPet[7] !== 2)
    ) {
      throw new Error(`invalid compact manifest pet at index ${index}`);
    }
    const slug = rawPet[0];
    const spritesheet = rawPet[4];
    const version = rawPet[7];
    return {
      slug,
      approvedAt: null,
      spritesheetUrl: resolveManifestAsset(assetBase, spritesheet),
      spriteVersionNumber: version,
    };
  });
}

export function parseLegacyManifest(input: unknown): AuditPet[] {
  if (!isRecord(input) || !Array.isArray(input.pets)) {
    throw new Error("invalid legacy manifest");
  }
  return input.pets.map((rawPet, index) => {
    if (
      !isRecord(rawPet) ||
      typeof rawPet.slug !== "string" ||
      typeof rawPet.spritesheetUrl !== "string" ||
      (rawPet.spriteVersionNumber !== undefined &&
        rawPet.spriteVersionNumber !== 1 &&
        rawPet.spriteVersionNumber !== 2)
    ) {
      throw new Error(`invalid legacy manifest pet at index ${index}`);
    }
    return {
      slug: rawPet.slug,
      approvedAt: null,
      spritesheetUrl: resolveManifestAsset(undefined, rawPet.spritesheetUrl),
      spriteVersionNumber: rawPet.spriteVersionNumber === 2 ? 2 : 1,
    };
  });
}

export function resolveManifestAsset(
  assetBase: string | undefined,
  raw: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(
      raw,
      assetBase ? `${assetBase.replace(/\/$/, "")}/` : undefined,
    );
  } catch {
    throw new Error("manifest contains an invalid spritesheet URL");
  }
  if (parsed.protocol !== "https:" || parsed.host !== TRUSTED_ASSET_HOST) {
    throw new Error("manifest contains an untrusted spritesheet host");
  }
  return parsed.toString();
}

async function auditOne(pet: AuditPet): Promise<AtlasAuditEntry> {
  try {
    let buffer: Buffer | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(pet.spritesheetUrl, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
          throw new Error(`asset request failed (${response.status})`);
        const contentLength = Number(response.headers.get("content-length"));
        if (contentLength > MAX_FETCH_BYTES)
          throw new Error("asset exceeds audit limit");
        buffer = await readResponseBodyBounded(response, MAX_FETCH_BYTES);
        break;
      } catch (error) {
        lastError = error;
        if (!isRetryableNetworkError(error) || attempt === MAX_NETWORK_ATTEMPTS)
          throw error;
        await waitBeforeRetry(attempt);
      }
    }
    if (!buffer) throw lastError ?? new Error("asset download failed");
    const metadata = await sharp(buffer).metadata();
    const layout = detectSpriteAtlas(metadata.width, metadata.height);
    if (!layout || !metadata.width || !metadata.height) {
      return {
        slug: pet.slug,
        approvedAt: pet.approvedAt,
        declaredVersion: pet.spriteVersionNumber,
        detectedVersion: null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        bytes: buffer.length,
        summary: null,
        error: "unsupported atlas dimensions",
        errorKind: "asset",
      };
    }
    const canonical = canonicalSpriteDimensions(layout.version);
    const raw = await sharp(buffer)
      .ensureAlpha()
      .resize({
        width: canonical.width,
        height: canonical.height,
        fit: "fill",
        kernel: sharp.kernel.nearest,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      slug: pet.slug,
      approvedAt: pet.approvedAt,
      declaredVersion: pet.spriteVersionNumber,
      detectedVersion: layout.version,
      width: metadata.width,
      height: metadata.height,
      bytes: buffer.length,
      summary: summarizeAtlasPixels(raw.data, raw.info.width, layout.version),
      error:
        layout.version === pet.spriteVersionNumber
          ? null
          : "atlas dimensions disagree with declared sprite version",
      errorKind: layout.version === pet.spriteVersionNumber ? null : "asset",
    };
  } catch (error) {
    return {
      slug: pet.slug,
      approvedAt: pet.approvedAt,
      declaredVersion: pet.spriteVersionNumber,
      detectedVersion: null,
      width: null,
      height: null,
      bytes: null,
      summary: null,
      error: errorMessage(error),
      errorKind: isRetryableNetworkError(error) ? "network" : "asset",
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const limit = Math.min(
    numberArg(args, "--limit", DEFAULT_WINDOW),
    MAX_WINDOW,
  );
  const concurrency = Math.min(numberArg(args, "--concurrency", 4), 12);
  const auditAll = args.includes("--all");
  const oldest = !auditAll;
  const pets = oldest ? await fetchOldestWindow(limit) : await fetchManifest();
  const selected = pets.slice(0, oldest ? limit : undefined);
  const results: AtlasAuditEntry[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= selected.length) return;
        results[index] = await auditOne(selected[index]);
      }
    }),
  );

  const entries = results.map((entry) => ({
    ...entry,
    manualReview: {
      status: "pending" as const,
      checks: MANUAL_REVIEW_CHECKS,
    } satisfies ManualReviewRecord,
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    scope: oldest ? "oldest-approved-window" : "manifest",
    requested: selected.length,
    summary: {
      errors: results.filter((entry) => entry.error !== null).length,
      networkErrors: results.filter((entry) => entry.errorKind === "network")
        .length,
      assetErrors: results.filter((entry) => entry.errorKind === "asset")
        .length,
      unsupportedDimensions: results.filter(
        (entry) => entry.error === "unsupported atlas dimensions",
      ).length,
      versionMismatches: results.filter((entry) =>
        entry.error?.includes("declared sprite version"),
      ).length,
      touchingFrames: results.reduce(
        (sum, entry) => sum + (entry.summary?.touchingFrames ?? 0),
        0,
      ),
      geometryOutliers: results.reduce(
        (sum, entry) => sum + (entry.summary?.geometryOutliers ?? 0),
        0,
      ),
      manualReviewPending: entries.length,
    },
    manualReviewRequired: MANUAL_REVIEW_CHECKS,
    entries,
  };

  const output = valueAfter(args, "--output");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, serialized, "utf8");
  else process.stdout.write(serialized);
}

if (import.meta.main) await main();
