import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

const {
  COLLECTION_SLUG_ATTEMPTS,
  collectionSlugBase,
  collectionSlugCandidates,
} = await import("@/lib/collection-slug");

describe("collection slug base", () => {
  it("slugifies a profile handle into a URL-safe base", () => {
    expect(collectionSlugBase("Lulu Capybara")).toBe("lulu-capybara");
    expect(collectionSlugBase("  Mixed_Case-Name  ")).toBe("mixed-case-name");
  });

  it("keeps the longer collection slug budget instead of the pet slug one", () => {
    const base = collectionSlugBase("a".repeat(80));

    expect(base).toHaveLength(48);
  });

  it("falls back to a random collection slug for reserved handles", () => {
    const base = collectionSlugBase("admin");

    expect(base).toMatch(/^collection-[0-9a-f]{32}$/);
  });

  it("falls back to a random collection slug when nothing slugifies", () => {
    expect(collectionSlugBase("绘梨衣")).toMatch(/^collection-[0-9a-f]{32}$/);
    expect(collectionSlugBase("   ")).toMatch(/^collection-[0-9a-f]{32}$/);
  });
});

describe("collection slug candidates", () => {
  it("tries the base first, then numbered suffixes", () => {
    expect(collectionSlugCandidates("boba", 4)).toEqual([
      "boba",
      "boba-2",
      "boba-3",
      "boba-4",
    ]);
  });

  it("probes the same number of candidates the old inline loop did", () => {
    expect(collectionSlugCandidates("boba")).toHaveLength(
      COLLECTION_SLUG_ATTEMPTS,
    );
    expect(collectionSlugCandidates("boba").at(-1)).toBe(
      `boba-${COLLECTION_SLUG_ATTEMPTS}`,
    );
  });

  it("bounds the number of candidates it will probe", () => {
    expect(collectionSlugCandidates("boba", 3)).toHaveLength(3);
  });
});
