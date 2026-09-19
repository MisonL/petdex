import { describe, expect, it } from "bun:test";

import {
  collectionRequest,
  hasBooleanFlag,
  MAX_COLLECTION_PETS,
  overCollectionPetLimit,
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

  it("defers an over-cap edit to the server but still rejects a create", () => {
    // The two entry points that gate on the cap — the argument parser and the
    // --all-approved preflight in the entrypoint — share this predicate, so a
    // change to the create/edit split lands in both.
    expect(overCollectionPetLimit("create", MAX_COLLECTION_PETS + 1)).toBe(
      true,
    );
    expect(overCollectionPetLimit("create", MAX_COLLECTION_PETS)).toBe(false);
    // An edit may hold more than the cap: the answer depends on the stored
    // members, which only the server has.
    expect(overCollectionPetLimit("edit", MAX_COLLECTION_PETS + 6)).toBe(false);
    expect(overCollectionPetLimit("delete", 99)).toBe(false);
    expect(overCollectionPetLimit("list", 99)).toBe(false);
  });

  it("lets an edit past the local cap and defers to the server", () => {
    // The cap bounds growth, so whether an over-cap list is allowed depends on
    // what the collection already stores. A collection created before the cap
    // existed still holds its members, and renaming it resends that same list.
    // Rejecting it here would make the collection uneditable from the CLI even
    // though the server accepts an unchanged over-cap list.
    const stored = Array.from(
      { length: MAX_COLLECTION_PETS + 6 },
      (_, index) => `pet-${index}`,
    );

    expect(
      parseCollectionArgs([
        "edit",
        "c1",
        "--title",
        "New",
        "--pets",
        stored.join(","),
      ]).petSlugs,
    ).toHaveLength(MAX_COLLECTION_PETS + 6);
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

  it("accepts --flag=true for the boolean flags", () => {
    // args.includes("--yes") is false for "--yes=true", so a caller who wrote
    // the value form was told the flag was missing.
    expect(parseCollectionArgs(["delete", "c1", "--yes=true"])).toMatchObject({
      yes: true,
    });
    expect(
      parseCollectionArgs(["create", "--title", "T", "--all-approved=true"]),
    ).toMatchObject({ allApproved: true });
    expect(parseCollectionArgs(["list", "--json=true"])).toMatchObject({
      json: true,
    });
  });

  it("refuses an empty --pets list instead of emptying the collection", () => {
    // `--pets ""` and `--pets $UNSET_VAR` both parse to []. The server treats
    // an empty list as "replace the members with nothing", so sending it would
    // silently wipe the collection on a typo.
    for (const args of [
      ["edit", "c1", "--pets", ""],
      ["edit", "c1", "--pets="],
      ["edit", "c1", "--pets", ","],
      ["edit", "c1", "--pets", " , "],
    ]) {
      expect(() => parseCollectionArgs(args)).toThrow("empty_pets");
    }
  });

  it("still accepts a real --pets list and treats an absent flag as unchanged", () => {
    expect(
      parseCollectionArgs(["edit", "c1", "--pets", "boba"]).petSlugs,
    ).toEqual(["boba"]);
    // Absent stays null so the server leaves the current members alone.
    expect(
      parseCollectionArgs(["edit", "c1", "--desc", "x"]).petSlugs,
    ).toBeNull();
    // --all-approved replaces the list server-side, so an empty --pets is moot.
    expect(
      parseCollectionArgs(["edit", "c1", "--all-approved", "--pets", ""])
        .petSlugs,
    ).toBeNull();
  });

  it("reports --json=true as machine-readable output", () => {
    // The entrypoint suppresses the first-run notice before it parses the
    // arguments, so it asks hasBooleanFlag directly. Reading the raw args
    // there would let a `--json=true` invocation print the notice into the
    // JSON stream a caller is piping.
    expect(hasBooleanFlag(["list", "--json=true"], "--json")).toBe(true);
    expect(hasBooleanFlag(["list", "--json"], "--json")).toBe(true);
    expect(hasBooleanFlag(["list", "--json=false"], "--json")).toBe(false);
    expect(hasBooleanFlag(["list"], "--json")).toBe(false);
  });

  it("treats an explicit false value as absent", () => {
    expect(parseCollectionArgs(["delete", "c1", "--yes=false"])).toMatchObject({
      yes: false,
    });
    expect(
      parseCollectionArgs(["create", "--title", "T", "--all-approved=0"]),
    ).toMatchObject({ allApproved: false });
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
