import * as BunTest from "bun:test";
import { beforeEach, describe, expect, it } from "bun:test";

import * as schema from "@/lib/db/schema";
import * as realRatelimit from "@/lib/ratelimit";

const testMock = (
  BunTest as typeof BunTest & {
    mock: { module: (specifier: string, factory: () => object) => void };
  }
).mock;

/** Keys the per-IP CLI limiter was asked about, in call order. */
const ipLimitKeys: string[] = [];
/** Keys the per-user collection limiter was asked about, in call order. */
const userLimitKeys: string[] = [];
/** Everything createOwnerCollection was called with. */
const created: Array<Record<string, unknown>> = [];

let verifyCalls = 0;
let ipLimitVerdict: { success: boolean; reset?: number } = { success: true };
let userLimitVerdict: { success: boolean; reset?: number } = { success: true };

// The token is the only thing that decides identity, so the route must derive
// the owner from it. "Bearer valid" maps to a fixed user.
testMock.module("@/lib/cli-auth", () => ({
  verifyCliBearer: async (header: string | null) => {
    verifyCalls += 1;
    return header === "Bearer valid"
      ? {
          userId: "user_owner",
          email: null,
          username: null,
          imageUrl: null,
          firstName: null,
          lastName: null,
        }
      : null;
  },
}));

// Spread the real module so a limiter added later is still exported here.
// A partial mock of this specifier breaks the whole run: Bun links the named
// imports of every file that imports it, so a missing export is a SyntaxError
// in every suite that touches the module, not just the one that mocked it.
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

testMock.module("@/lib/collection-access", () => ({
  MAX_OWNER_COLLECTIONS: 10,
  createOwnerCollection: async (input: Record<string, unknown>) => {
    created.push(input);
    return { status: "created", slug: "collection-abc" };
  },
}));

testMock.module("@/lib/db/cached-aggregates", () => ({
  revalidateCollectionTags: async () => {},
}));

testMock.module("@/lib/db/client", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [{ slug: "boba" }],
      }),
    }),
  };
  // mock.module is process-wide for the whole run, not scoped to this file:
  // every suite that imports @/lib/db/client resolves this factory's exports,
  // and one that links a missing name fails with a SyntaxError. Export the
  // real schema so an unrelated DB-backed suite still sees real tables.
  return { db, schema };
});

function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return import("./route").then(({ POST }) =>
    POST(
      new Request("https://petdex.local/api/cli/collections", {
        method: "POST",
        headers: {
          authorization: "Bearer valid",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

describe("POST /api/cli/collections rate limiting", () => {
  beforeEach(() => {
    ipLimitKeys.length = 0;
    userLimitKeys.length = 0;
    created.length = 0;
    verifyCalls = 0;
    ipLimitVerdict = { success: true };
    userLimitVerdict = { success: true };
  });

  it("applies both the per-IP and the per-user ceiling", async () => {
    const response = await post({ title: "My pets" });

    expect(response.status).toBe(201);
    expect(ipLimitKeys).toHaveLength(1);
    // The per-user bucket is what stops one account from spreading writes
    // across source IPs, so it has to be keyed by the verified user.
    expect(userLimitKeys).toEqual(["user_owner"]);
    expect(created).toHaveLength(1);
  });

  it("keys the per-IP limiter off x-real-ip, not a spoofable x-forwarded-for", async () => {
    // A client behind a self-hosted proxy controls the leftmost
    // x-forwarded-for entry; x-real-ip is set by the platform.
    await post(
      { title: "My pets" },
      { "x-real-ip": "198.51.100.4", "x-forwarded-for": "203.0.113.9" },
    );

    expect(ipLimitKeys).toEqual(["198.51.100.4"]);
  });

  it("falls back to the leftmost x-forwarded-for entry without x-real-ip", async () => {
    await post(
      { title: "My pets" },
      { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    );

    expect(ipLimitKeys).toEqual(["203.0.113.9"]);
  });

  it("stops at the per-IP ceiling before authenticating", async () => {
    ipLimitVerdict = { success: false };

    const response = await post({ title: "My pets" });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(verifyCalls).toBe(0);
    expect(userLimitKeys).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("stops at the per-user ceiling before touching the database", async () => {
    userLimitVerdict = { success: false, reset: 1234 };

    const response = await post({ title: "My pets" });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: "rate_limited",
      retryAfter: 1234,
    });
    expect(created).toHaveLength(0);
  });

  it("does not consult the per-user bucket for an unauthenticated caller", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://petdex.local/api/cli/collections", {
        method: "POST",
        headers: {
          authorization: "Bearer invalid",
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "My pets" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(userLimitKeys).toHaveLength(0);
  });
});

describe("POST /api/cli/collections input errors", () => {
  beforeEach(() => {
    ipLimitKeys.length = 0;
    userLimitKeys.length = 0;
    created.length = 0;
    ipLimitVerdict = { success: true };
    userLimitVerdict = { success: true };
  });

  it("reports a validator code for a bad body", async () => {
    const response = await post({ title: "x" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "title_length" });
  });

  it("reports an oversized pet payload as a shape error, not a cap error", async () => {
    // The payload guard and the collection cap are different rules: the cap is
    // a growth limit over the deduplicated list, decided against the stored
    // members, while this is a size bound on what was sent. Reporting
    // collection_pet_limit here would tell a caller to shrink a list that may
    // already be legal.
    const response = await post({
      title: "My pets",
      petSlugs: ["a".repeat(96_001)],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "pet_slugs" });
  });

  it("accepts allApproved without validating the pet list it replaces", async () => {
    // The client sends --all-approved together with a --pets list it may not
    // have validated; the server ignores that list entirely, so an oversized
    // one must not fail the request.
    const response = await post({
      title: "My pets",
      allApproved: true,
      petSlugs: Array.from({ length: 500 }, (_, index) => `pet-${index}`),
    });

    expect(response.status).toBe(201);
    expect(created[0]?.petSlugs).toEqual(["boba"]);
  });
});
