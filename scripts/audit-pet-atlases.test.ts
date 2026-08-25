import { describe, expect, it } from "bun:test";

import {
  classifyAuditEntry,
  MANUAL_REVIEW_CHECKS,
  parseCompactManifest,
  parseLegacyManifest,
  readResponseBodyBounded,
  resolveManifestAsset,
  summarizeAtlasPixels,
} from "./audit-pet-atlases";

it("keeps every required visual review category explicit", () => {
  expect(MANUAL_REVIEW_CHECKS).toEqual([
    "idle eye-open default state",
    "action continuity and direction consistency",
    "transparent edge bounds and left/right clipping",
    "sprite scale consistency and flattened proportions",
    "state-row proportion and frame-to-frame continuity",
    "compression artifacts and visual integrity",
  ]);
});

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe("bounded asset reads", () => {
  it("reads chunked bodies up to the configured limit", async () => {
    const body = await readResponseBodyBounded(
      responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      4,
    );
    expect(body).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects a chunked body as soon as it exceeds the limit", async () => {
    await expect(
      readResponseBodyBounded(
        responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3])]),
        2,
      ),
    ).rejects.toThrow("asset exceeds audit limit");
  });

  it("cancels a body that stops producing chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    await expect(
      readResponseBodyBounded(new Response(body), 4, 20),
    ).rejects.toThrow("asset read timed out");
  });
});

describe("atlas audit geometry", () => {
  it("counts expected classic cells without treating unused columns as errors", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    const offset = (3 * 208 * width + 10 * width + 2 * 192 + 10) * 4;
    data[offset + 3] = 255;
    const result = summarizeAtlasPixels(data, width, 1);
    expect(result.expectedFrames).toBe(57);
    expect(result.emptyFrames).toBe(56);
    expect(result.touchingFrames).toBe(0);
  });

  it("includes both additional v2 direction rows", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 2288 * 4);
    const offset = (10 * 208 * width + 7 * 192 + 10) * 4;
    data[offset + 3] = 255;
    const result = summarizeAtlasPixels(data, width, 2);
    expect(result.expectedFrames).toBe(73);
    expect(result.emptyFrames).toBe(72);
  });

  function drawOpaqueRect(
    data: Buffer,
    width: number,
    row: number,
    column: number,
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number,
  ) {
    for (let dy = 0; dy < rectHeight; dy++) {
      for (let dx = 0; dx < rectWidth; dx++) {
        const offset =
          ((row * 208 + y + dy) * width + column * 192 + x + dx) * 4;
        data[offset + 3] = 255;
      }
    }
  }

  it("reports aspect-ratio outliers instead of hiding flattened frames in geometry", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    for (let column = 0; column < 6; column++) {
      drawOpaqueRect(data, width, 0, column, 60, 60, 40, 40);
    }
    drawOpaqueRect(data, width, 0, 5, 60, 60, 12, 100);

    const result = summarizeAtlasPixels(data, width, 1);

    expect(result.proportionOutliers).toBe(1);
  });

  it("reports abrupt frame-to-frame jumps while tolerating steady motion", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    drawOpaqueRect(data, width, 0, 0, 60, 60, 40, 40);
    drawOpaqueRect(data, width, 0, 1, 62, 60, 40, 40);
    drawOpaqueRect(data, width, 0, 2, 142, 60, 40, 40);
    drawOpaqueRect(data, width, 0, 3, 144, 60, 40, 40);

    const result = summarizeAtlasPixels(data, width, 1);

    expect(result.continuityOutliers).toBeGreaterThan(0);
  });

  it("reports row-level proportion drift and directional edge contacts", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    for (let row = 0; row < 9; row++) {
      drawOpaqueRect(data, width, row, 0, 40, 60, 40, 40);
    }
    drawOpaqueRect(data, width, 8, 1, 0, 60, 100, 40);

    const result = summarizeAtlasPixels(data, width, 1);

    expect(result.rowProportionOutliers).toBeGreaterThan(0);
    expect(result.edgeTouches.left).toBe(1);
  });
});

it("classifies machine findings without treating manual review as approval", () => {
  const flags = classifyAuditEntry({
    error: "atlas dimensions disagree with declared sprite version",
    errorKind: "asset",
    summary: {
      expectedFrames: 57,
      emptyFrames: 1,
      touchingFrames: 2,
      geometryOutliers: 3,
      proportionOutliers: 4,
      continuityOutliers: 5,
      rowProportionOutliers: 1,
      edgeTouches: { left: 1, right: 0, top: 0, bottom: 1 },
      rowMedians: [],
    },
  });

  expect(flags).toEqual([
    "asset-error",
    "version-mismatch",
    "empty-frame",
    "edge-touch",
    "left-edge-touch",
    "bottom-edge-touch",
    "geometry-outlier",
    "flattened-proportion",
    "frame-continuity",
    "row-proportion",
  ]);
});

it("returns no machine flags for a clean asset while manual review stays separate", () => {
  expect(
    classifyAuditEntry({
      error: null,
      errorKind: null,
      summary: {
        expectedFrames: 57,
        emptyFrames: 0,
        touchingFrames: 0,
        geometryOutliers: 0,
        proportionOutliers: 0,
        continuityOutliers: 0,
        rowProportionOutliers: 0,
        edgeTouches: { left: 0, right: 0, top: 0, bottom: 0 },
        rowMedians: [],
      },
    }),
  ).toEqual([]);
});

describe("manifest parsing", () => {
  it("parses the compact v2 manifest and resolves relative assets", () => {
    const pets = parseCompactManifest({
      assetBase: "https://assets.petdex.dev",
      pets: [
        [
          "demo",
          "Demo",
          "character",
          null,
          "pets/demo/sprite.webp",
          "pets/demo/pet.json",
          null,
          2,
        ],
      ],
    });
    expect(pets).toEqual([
      {
        slug: "demo",
        approvedAt: null,
        spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        spriteVersionNumber: 2,
      },
    ]);
  });

  it("keeps the legacy manifest fallback strict and host-bound", () => {
    const pets = parseLegacyManifest({
      pets: [
        {
          slug: "demo",
          spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        },
      ],
    });
    expect(pets[0]?.spriteVersionNumber).toBe(1);
    expect(() =>
      resolveManifestAsset(undefined, "https://example.test/sprite.webp"),
    ).toThrow("untrusted spritesheet host");
  });

  it("rejects malformed compact entries instead of defaulting their version", () => {
    expect(() =>
      parseCompactManifest({
        assetBase: "https://assets.petdex.dev",
        pets: [["demo", "Demo", "character", null, "pets/demo/sprite.webp"]],
      }),
    ).toThrow("invalid compact manifest pet");
  });
});
