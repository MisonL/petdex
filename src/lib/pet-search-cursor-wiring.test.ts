// The clamp lives in `pet-search-cursor.ts` and its own suite proves it
// works — but nothing proved `pet-search.ts` still calls it. Unwiring it put
// the original bug back (`cursor=99999999999999999999` reaching Postgres as
// `OFFSET 1e20`, answered with `22003 bigint out of range` and a 500) and
// every suite stayed green, including the route test, which only checks the
// value it forwards.
//
// `pet-search.ts` builds its page query with drizzle's builder and opens a
// database client at import time, so this drives the real function against a
// stand-in that records the builder calls and resolves them to no rows.
import { afterAll, describe, expect, it, mock } from "bun:test";

import * as schema from "@/lib/db/schema";
import { MAX_CURSOR } from "@/lib/pet-search-cursor";

const offsets: unknown[] = [];

type Chain = Record<string, (...args: unknown[]) => Chain> & {
  then: (resolve: (value: unknown[]) => void) => void;
};

function recordingChain(): Chain {
  const chain = new Proxy({} as Chain, {
    get(_target, property: string) {
      // Awaiting the chain has to yield rows rather than hang: every page
      // query ends in `.limit(...)`, and the caller awaits that.
      if (property === "then") {
        return (resolve: (value: unknown[]) => void) => resolve([]);
      }
      return (...args: unknown[]) => {
        if (property === "offset") offsets.push(args[0]);
        return chain;
      };
    },
  });
  return chain;
}

// `mock.module` is process-wide and first-registration-wins, so these stubs
// would otherwise supply every later suite in the same `bun test` process.
// The neon stub in particular must spread the real module: a bare replacement
// drops `neonConfig`, `Pool`, and the rest, and a suite that links one of them
// fails with `Export named '...' not found` rather than an assertion.
const actualNeon = await import("@neondatabase/serverless");

mock.module("server-only", () => ({}));
// `pet-search.ts` builds a neon client at import time for its raw-SQL paths.
mock.module("@neondatabase/serverless", () => ({
  ...actualNeon,
  neon: () => async () => [],
}));
mock.module("@/lib/db/client", () => ({
  schema,
  db: {
    select: () => recordingChain(),
    // The page query aliases a CTE before selecting from it.
    $with: () => recordingChain(),
    with: () => recordingChain(),
    execute: async () => [],
    query: {},
  },
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { searchPets } = await import("@/lib/pet-search");

afterAll(() => {
  mock.restore();
});

describe("searchPets cursor wiring", () => {
  it("sends the clamped cursor to the query, not the caller's value", async () => {
    offsets.length = 0;

    // What `parseInt("99999999999999999999")` produces: past Number's safe
    // range and past Postgres bigint, which is what made it a 500.
    await searchPets({ sort: "alpha", cursor: 1e20 });

    expect(offsets).toEqual([MAX_CURSOR]);
  });

  it("keeps an in-range cursor exactly as given", async () => {
    offsets.length = 0;

    await searchPets({ sort: "alpha", cursor: 48 });

    expect(offsets).toEqual([48]);
  });
});
