import { describe, expect, it } from "bun:test";

import {
  isCollectionRequestBody,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
  resolveCollectionCover,
} from "@/lib/collection-input";

describe("normalizeCollectionInput", () => {
  it("preserves an existing cover when a partial pet edit keeps it", () => {
    expect(resolveCollectionCover(null, ["first", "hero"], "hero", true)).toBe(
      "hero",
    );
    expect(resolveCollectionCover(null, ["first"], "hero", true)).toBe("first");
    expect(resolveCollectionCover(null, ["first", "hero"], "hero")).toBe(
      "first",
    );
  });

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

  it("rejects non-string descriptions", () => {
    expect(() =>
      normalizeCollectionInput({ title: "valid", description: 123 }),
    ).toThrow("description_type");
    expect(() =>
      normalizeCollectionInput({ title: "valid", description: null }),
    ).toThrow("description_type");
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
    expect(normalizeCollectionExternalUrl("http://example.test/path")).toBe(
      false,
    );
    expect(normalizeCollectionExternalUrl("https://127.0.0.1:8080/")).toBe(
      false,
    );
    expect(
      normalizeCollectionExternalUrl(
        "https://169.254.169.254/latest/meta-data",
      ),
    ).toBe(false);
    expect(normalizeCollectionExternalUrl("https://localhost/")).toBe(false);
    expect(normalizeCollectionExternalUrl("https://[::1]/")).toBe(false);
    expect(normalizeCollectionExternalUrl("https://service.internal/")).toBe(
      false,
    );
    expect(normalizeCollectionExternalUrl("javascript:alert(1)")).toBe(false);
    expect(normalizeCollectionExternalUrl("")).toBeNull();
    expect(normalizeCollectionCover(" Boba ")).toBe("boba");
    expect(normalizeCollectionCover("")).toBeNull();
    expect(normalizeCollectionCover(42)).toBe(false);
  });
});
