import { describe, expect, it } from "bun:test";

import {
  limitCollectionPetSlugs,
  MAX_COLLECTION_PETS,
  MAX_OWNER_COLLECTIONS,
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

describe("collection limits shared with the client", () => {
  // Both caps are read by client components (the owner manager renders the
  // collection cap, the editor enforces the pet cap), so neither may live in
  // a server-only module.
  it("exports both caps from the client-safe module", () => {
    expect(MAX_OWNER_COLLECTIONS).toBe(10);
    expect(MAX_COLLECTION_PETS).toBe(24);
  });

  it("keeps the server-only module from being the source of the caps", async () => {
    const source = await Bun.file(
      new URL("./collection-access.ts", import.meta.url),
    ).text();

    expect(source).toContain("server-only");
    expect(source).not.toMatch(/export const MAX_OWNER_COLLECTIONS =/);
    expect(source).toMatch(/export \{ MAX_OWNER_COLLECTIONS \}/);
  });
});
