import { describe, expect, it } from "bun:test";

import {
  collectionRequest,
  MAX_COLLECTION_PETS,
  parseCollectionArgs,
} from "./collections";

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

  it("supports the approved-pet count preflight query", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = new Request(input as string, init);
      return new Response(
        JSON.stringify({ collections: [], approvedPetCount: 1 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest(
          "https://petdex.test",
          "token",
          "GET",
          null,
          undefined,
          "?includeApprovedPetCount=1",
        ),
      ).resolves.toMatchObject({ approvedPetCount: 1 });
      expect(request?.url).toBe(
        "https://petdex.test/api/cli/collections?includeApprovedPetCount=1",
      );
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
    expect(() =>
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--pets",
        Array.from({ length: 25 }, (_, index) => `pet-${index}`).join(","),
      ]),
    ).toThrow("collection_pet_limit");
  });

  it("ignores --pets validation when --all-approved wins", () => {
    // The server replaces the explicit list with every approved pet whenever
    // allApproved is set, so a --pets list that is oversized or malformed is
    // never sent and must not fail the command locally.
    const oversized = Array.from(
      { length: MAX_COLLECTION_PETS + 1 },
      (_, index) => `pet-${index}`,
    ).join(",");

    expect(
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--all-approved",
        "--pets",
        oversized,
      ]),
    ).toMatchObject({ allApproved: true });

    expect(
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--all-approved",
        "--pets",
        "not a slug",
      ]),
    ).toMatchObject({ allApproved: true });
  });

  it("still validates --pets when --all-approved is absent", () => {
    expect(() =>
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--pets",
        "not a slug",
      ]),
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

  it("maps collection pet limits to an actionable error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "collection_pet_limit" }), {
        status: 400,
      })) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test", "token", "POST", null),
      ).rejects.toThrow("collection cannot contain more than 24 pets");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
