import { describe, expect, it } from "bun:test";

import { collectionRequest, parseCollectionArgs } from "./collections";

describe("collectionRequest", () => {
  it("sends bearer credentials and parses a successful response", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = new Request(input as string, init);
      return new Response(JSON.stringify({ collections: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test/", "token", "GET", null),
      ).resolves.toEqual({ collections: [] });
      expect(request?.url).toBe("https://petdex.test/api/cli/collections");
      expect(request?.headers.get("authorization")).toBe("Bearer token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the server error code", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
      })) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test", "token", "GET", "missing"),
      ).rejects.toThrow("not_found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses equals syntax, preserves empty values, and validates slugs", () => {
    expect(
      parseCollectionArgs([
        "edit",
        "legacy-id",
        "--title=Renamed",
        "--desc",
        "",
        "--pets",
        "Boba,dora,Boba",
        "--cover",
        "boba",
        "--external-url=https://example.test",
        "--json",
      ]),
    ).toMatchObject({
      action: "edit",
      ref: "legacy-id",
      title: "Renamed",
      description: "",
      petSlugs: ["boba", "dora"],
      coverPetSlug: "boba",
      externalUrl: "https://example.test",
      json: true,
    });
    expect(
      parseCollectionArgs(["edit", "legacy-id", "--cover", " Boba "]),
    ).toMatchObject({ coverPetSlug: "boba" });
    expect(() =>
      parseCollectionArgs(["create", "--title", "Pets", "--pets", "bad slug"]),
    ).toThrow("pet_slug");
    expect(() =>
      parseCollectionArgs(["create", "--title", "Pets", "--cover", "bad slug"]),
    ).toThrow("pet_slug");
  });

  it("maps rate limits to an actionable error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
      })) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test", "token", "GET", null),
      ).rejects.toThrow("rate limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
