import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

import { MANUAL_REVIEW_CHECKS } from "./audit-pet-atlases";

type PublicReviewEntry = {
  slug: string;
  spritesheetUrl: string;
  declaredVersion: 1 | 2;
  detectedVersion: 1 | 2 | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  summary: unknown;
  machineFlags: string[];
  errorCode: string | null;
  manualReview: {
    status: "pending";
    checks: readonly string[];
  };
};

type PublicReviewReport = {
  generatedAt: string;
  scope: "oldest-approved-window" | "manifest";
  source: string;
  assetHost: string;
  requested: number;
  entries: PublicReviewEntry[];
};

const docsUrl = new URL("../docs/", import.meta.url);
const MACHINE_FLAGS = new Set([
  "network-error",
  "asset-error",
  "unsupported-dimensions",
  "version-mismatch",
  "empty-frame",
  "edge-touch",
  "left-edge-touch",
  "right-edge-touch",
  "top-edge-touch",
  "bottom-edge-touch",
  "geometry-outlier",
  "flattened-proportion",
  "frame-continuity",
  "row-proportion",
]);

async function readReports(): Promise<{
  review: PublicReviewReport;
  reviewFile: string;
  summary: Record<string, unknown>;
}> {
  const files = await readdir(docsUrl);
  const reviewFiles = files
    .filter((file) => /^pet-atlas-audit-review-.+\.json$/.test(file))
    .sort();
  const summaryFiles = files
    .filter((file) => /^pet-atlas-audit-summary-.+\.json$/.test(file))
    .sort();
  expect(reviewFiles).toHaveLength(1);
  expect(summaryFiles).toHaveLength(1);

  const reviewFile = reviewFiles[0];
  const summaryFile = summaryFiles[0];
  if (!reviewFile || !summaryFile) throw new Error("audit report is missing");

  return {
    review: JSON.parse(
      await readFile(new URL(reviewFile, docsUrl), "utf8"),
    ) as PublicReviewReport,
    reviewFile,
    summary: JSON.parse(
      await readFile(new URL(summaryFile, docsUrl), "utf8"),
    ) as Record<string, unknown>,
  };
}

describe("committed pet atlas audit report", () => {
  it("keeps exactly one current full-manifest report", async () => {
    const { review, reviewFile, summary } = await readReports();
    expect(review.scope).toBe("manifest");
    expect(review.source).toBe("https://petdex.dev/api/manifest/v2");
    expect(review.assetHost).toBe("assets.petdex.dev");
    expect(Number.isNaN(Date.parse(review.generatedAt))).toBe(false);
    expect(reviewFile).toContain(review.generatedAt.slice(0, 10));
    expect(review.requested).toBe(review.entries.length);
    expect(review.entries.length).toBeGreaterThan(4000);

    const summaryCounts = summary.summary as Record<string, unknown>;
    expect(summary.requested).toBe(review.requested);
    expect(summaryCounts.manualReviewPending).toBe(review.requested);
  });

  it("keeps every entry public, trusted, unique, and manually reviewable", async () => {
    const { review } = await readReports();
    const slugs = new Set<string>();
    const serialized = JSON.stringify(review);
    expect(serialized).not.toMatch(
      /(?:\/Users\/|\/Volumes\/|\\\\Users\\\\|\\\\Volumes\\\\)/,
    );
    expect(serialized).not.toMatch(
      /(?:localhost|127\.0\.0\.1|BEGIN [A-Z ]+ KEY)/i,
    );

    for (const entry of review.entries) {
      expect(entry.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(slugs.has(entry.slug)).toBe(false);
      slugs.add(entry.slug);

      const url = new URL(entry.spritesheetUrl);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("assets.petdex.dev");
      expect(entry.machineFlags.every((flag) => MACHINE_FLAGS.has(flag))).toBe(
        true,
      );
      expect(entry.manualReview).toEqual({
        status: "pending",
        checks: MANUAL_REVIEW_CHECKS,
      });
      expect("error" in entry).toBe(false);
      expect("approvedAt" in entry).toBe(false);
    }

    expect(slugs.size).toBe(review.entries.length);
  });
});
