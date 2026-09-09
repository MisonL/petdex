import { describe, expect, it } from "bun:test";

import {
  isCollectionRequestBody,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
} from "@/lib/collection-input";

describe("normalizeCollectionInput", () => {
  it("trims fields, lowercases and deduplicates pet slugs", () => {
    expect(
      normalizeCollectionInput({
        title: "  My set ",
        description: "  pets  ",
        petSlugs: [" Boba ", "boba", "Dora"],
      }),
    ).toEqual({
      title: "My set",
      description: "pets",
      petSlugs: ["boba", "dora"],
    });
  });

  it("rejects invalid title and description lengths", () => {
    expect(() => normalizeCollectionInput({ title: "x" })).toThrow(
      "title_length",
    );
    expect(() =>
      normalizeCollectionInput({
        title: "valid",
        description: "x".repeat(281),
      }),
    ).toThrow("description_length");
  });

  it("rejects malformed pet slug values", () => {
    expect(() =>
      normalizeCollectionInput({ title: "valid", petSlugs: ["bad slug"] }),
    ).toThrow("pet_slug");
  });

  it("accepts object request bodies and rejects null or invalid flags", () => {
    expect(isCollectionRequestBody({ title: "valid" })).toBe(true);
    expect(isCollectionRequestBody(null)).toBe(false);
    expect(isCollectionRequestBody([])).toBe(false);
    expect(
      isCollectionRequestBody({ title: "valid", allApproved: "yes" }),
    ).toBe(false);
  });

  it("normalizes optional external URLs and cover slugs", () => {
    expect(normalizeCollectionExternalUrl(" https://example.test/path ")).toBe(
      "https://example.test/path",
    );
    expect(normalizeCollectionExternalUrl("javascript:alert(1)")).toBe(false);
    expect(normalizeCollectionExternalUrl("")).toBeNull();
    expect(normalizeCollectionCover(" Boba ")).toBe("boba");
    expect(normalizeCollectionCover("")).toBeNull();
    expect(normalizeCollectionCover(42)).toBe(false);
  });
});
