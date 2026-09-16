import { describe, expect, it } from "bun:test";

import {
  limitCollectionPetSlugs,
  MAX_COLLECTION_PETS,
} from "@/lib/collection-constants";

describe("collection pet limits", () => {
  it("keeps selections at the server limit and preserves the cover", () => {
    const slugs = Array.from(
      { length: MAX_COLLECTION_PETS + 2 },
      (_, index) => `pet-${index}`,
    );

    const limited = limitCollectionPetSlugs(slugs, slugs.at(-1) ?? null);

    expect(limited).toHaveLength(MAX_COLLECTION_PETS);
    expect(limited).toContain(slugs.at(-1));
    expect(new Set(limited).size).toBe(MAX_COLLECTION_PETS);
  });

  it("deduplicates selections without changing valid lists", () => {
    expect(limitCollectionPetSlugs(["boba", "boba", "dora"])).toEqual([
      "boba",
      "dora",
    ]);
  });
});
