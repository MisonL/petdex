import * as BunTest from "bun:test";
import { beforeEach, describe, expect, it } from "bun:test";

import * as realCachedAggregates from "@/lib/db/cached-aggregates";
import * as schema from "@/lib/db/schema";
import * as realRatelimit from "@/lib/ratelimit";

const testMock = (
  BunTest as typeof BunTest & {
    mock: { module: (specifier: string, factory: () => object) => void };
  }
).mock;

// collection-access imports "server-only", which throws outside a server
// component context, so it is imported dynamically: a static import is
// evaluated before the stubs below run. The real module is spread into the
// mock so a name this suite does not stub is still exported — mock.module is
// process-wide, and a partial mock is a SyntaxError in the sibling suite.
testMock.module("server-only", () => ({}));
const realCollectionAccess = await import("@/lib/collection-access");

const ipLimitKeys: string[] = [];
const userLimitKeys: string[] = [];
let ipLimitVerdict: { success: boolean; reset?: number } = { success: true };
let userLimitVerdict: { success: boolean; reset?: number } = { success: true };
/** The stored collection row findOwnedCollection resolves, or null for 404. */
let storedCollection: Record<string, unknown> | null = null;
/** Rows the stored-items select returns for the cap comparison. */
let storedItems: Array<{ slug: string }> = [];
/**
 * Rows the approved-pets select returns. Null mirrors `storedItems`, which is
 * what the cap tests want (every stored member is also approved); a test that
 * needs the two to differ — the account with no approved pets left — sets it.
 */
let approvedPets: Array<{ slug: string }> | null = null;
/** Set when runCollectionMutation is reached, so early returns are provable. */
let mutationCalls = 0;

testMock.module("@/lib/cli-auth", () => ({
  verifyCliBearer: async (header: string | null) =>
    header === "Bearer valid"
      ? {
          userId: "user_owner",
          email: null,
          username: null,
          imageUrl: null,
          firstName: null,
          lastName: null,
        }
      : null,
}));

// Spread the real module so a limiter added later is still exported here.
testMock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  cliVerifyRatelimit: {
    limit: async (key: string) => {
      ipLimitKeys.push(key);
      return ipLimitVerdict;
    },
  },
  cliCollectionRatelimit: {
    limit: async (key: string) => {
      userLimitKeys.push(key);
      return userLimitVerdict;
    },
  },
}));

// Spread the real module. mock.module is process-wide for the whole run, so a
// partial mock here is a SyntaxError in the sibling route suite, which links
// names from the same specifier that this stub does not define.
testMock.module("@/lib/collection-access", () => ({
  ...realCollectionAccess,
  collectionApprovedPetsCondition: () => "TRUE",
  collectionMutationStatusQuery: () => ({}),
  deleteCollectionItemsQuery: () => ({}),
  hasCollectionMutationRow: () => false,
  insertCollectionItemsQuery: () => ({}),
  parseCollectionMutationStatus: () => "ok",
  // The route reads this result directly: `updated` truthy is what makes it
  // answer 200. Returning `{ results: [] }` left `updated` undefined, so every
  // non-rejected PATCH fell through to the 404 branch — and a test asserting
  // only "not 400" could not tell a successful edit from a missing collection.
  runCollectionMutation: async () => {
    mutationCalls += 1;
    return {
      updated: true,
      collectionExists: true,
      petsValid: true,
      coverExists: true,
    };
  },
}));

testMock.module("@/lib/collection-sql", () => ({
  collectionCoverForPetSlugsQuery: () => ({}),
}));

// Spread the real module. mock.module is process-wide for the whole run, so a
// partial stub here is a SyntaxError in every suite loaded afterwards that
// links a name this factory omits — and 15+ modules import from this one.
testMock.module("@/lib/db/cached-aggregates", () => ({
  ...realCachedAggregates,
  revalidateCollectionTags: async () => {},
}));

testMock.module("@/lib/db/client", () => {
  const db = {
    query: {
      petCollections: { findFirst: async () => storedCollection },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          // Keyed on the table so the approved-pets select and the stored-items
          // select can return different rows. Collapsing them made every stored
          // member implicitly approved, which hid the empty-approved-set case.
          table === schema.petCollectionItems
            ? storedItems
            : (approvedPets ?? storedItems),
      }),
    }),
  };
  // mock.module is process-wide for the whole run: export the real schema so a
  // suite that links a name from here still resolves it.
  return { db, schema };
});

function patch(body: Record<string, unknown>, reference = "my-coll") {
  return import("./route").then(({ PATCH }) =>
    PATCH(
      new Request(`https://petdex.local/api/cli/collections/${reference}`, {
        method: "PATCH",
        headers: {
          authorization: "Bearer valid",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: reference }) },
    ),
  );
}

const approved = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ slug: `pet-${i}` }));

beforeEach(() => {
  ipLimitKeys.length = 0;
  userLimitKeys.length = 0;
  mutationCalls = 0;
  approvedPets = null;
  ipLimitVerdict = { success: true };
  userLimitVerdict = { success: true };
  // The route reads the stored row for any field the request omits, so the
  // fixture has to carry a valid title and description or the validator
  // rejects the merged input before the cap is ever consulted.
  storedCollection = {
    id: "c1",
    featured: false,
    coverPetSlug: null,
    title: "Stored collection",
    description: "",
    externalUrl: null,
  };
  storedItems = [];
});

describe("PATCH /api/cli/collections/[id] auth and lookup", () => {
  it("rejects an unauthenticated caller before the per-user bucket", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request("https://petdex.local/api/cli/collections/my-coll", {
        method: "PATCH",
        headers: { authorization: "Bearer invalid" },
      }),
      { params: Promise.resolve({ id: "my-coll" }) },
    );

    expect(response.status).toBe(401);
    expect(userLimitKeys).toHaveLength(0);
    expect(mutationCalls).toBe(0);
  });

  it("returns 404 for a collection the caller does not own", async () => {
    storedCollection = null;

    const response = await patch({ title: "New name" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mutationCalls).toBe(0);
  });

  it("refuses to edit a featured collection", async () => {
    storedCollection = { ...storedCollection, featured: true };

    const response = await patch({ title: "New name" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "featured_not_editable" });
    expect(mutationCalls).toBe(0);
  });

  it("rejects a request that changes nothing", async () => {
    const response = await patch({});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "nothing_to_update" });
    expect(mutationCalls).toBe(0);
  });

  it("reports a validator code for a bad body", async () => {
    const response = await patch({ title: "x" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "title_length" });
  });
});

describe("PATCH /api/cli/collections/[id] pet cap", () => {
  it("keeps a collection created before the cap editable", async () => {
    // The regression this guards: the cap bounds growth, not the stored row,
    // so a collection already over it must still accept an unchanged member
    // list — otherwise a rename becomes impossible from the CLI.
    const stored = approved(30);
    storedItems = stored.map((p) => ({ slug: p.slug }));

    const response = await patch({
      petSlugs: stored.map((p) => p.slug),
    });

    // Assert the success itself, not merely "not the cap error": a 404 from a
    // failed lookup also satisfies `not.toBe(400)`, so the weaker assertion
    // passed without ever observing the editability it names.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mutationCalls).toBe(1);
  });

  it("rejects growth past the cap on an over-cap collection", async () => {
    const stored = approved(30);
    storedItems = stored.map((p) => ({ slug: p.slug }));

    const response = await patch({
      petSlugs: [...stored.map((p) => p.slug), "pet-new"],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "collection_pet_limit",
    });
  });

  it("rejects an over-cap list that swaps a member for a new one", async () => {
    const stored = approved(30);
    storedItems = stored.map((p) => ({ slug: p.slug }));

    const response = await patch({
      petSlugs: [...stored.slice(0, -1).map((p) => p.slug), "pet-new"],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "collection_pet_limit",
    });
  });

  it("allows shrinking an over-cap collection past the cap", async () => {
    const stored = approved(30);
    storedItems = stored.map((p) => ({ slug: p.slug }));

    const response = await patch({
      petSlugs: stored.slice(0, 5).map((p) => p.slug),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mutationCalls).toBe(1);
  });
});

describe("PATCH /api/cli/collections/[id] empty member list", () => {
  // deleteCollectionItemsQuery with an empty list emits a DELETE with no
  // pet_slug filter, so an empty list removes every member. It is never a
  // legitimate intent, so both spellings of it are refused before the mutation.
  it("refuses an explicit empty --pets list", async () => {
    storedItems = [{ slug: "boba" }, { slug: "mochi" }];

    const response = await patch({ petSlugs: [] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty_pet_slugs" });
    expect(mutationCalls).toBe(0);
  });

  it("refuses --all-approved when the account has no approved pets left", async () => {
    // Un-approving a pet leaves its pet_collection_items row behind, so this is
    // reachable: the collection still holds members while the approved set is
    // empty. Resolving --all-approved to [] then wiped the collection and
    // answered 200, which is the data loss this guard closes.
    storedItems = [{ slug: "boba" }, { slug: "mochi" }];
    approvedPets = [];

    const response = await patch({ allApproved: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty_pet_slugs" });
    expect(mutationCalls).toBe(0);
  });

  it("still accepts a non-empty --all-approved list", async () => {
    // Guards against the fix overshooting: an account with approved pets keeps
    // the documented `edit <ref> --all-approved` behavior.
    storedItems = [{ slug: "boba" }];
    approvedPets = [{ slug: "boba" }, { slug: "mochi" }];

    const response = await patch({ allApproved: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mutationCalls).toBe(1);
  });
});
