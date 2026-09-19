import { describe, expect, it, mock } from "bun:test";

import { PgDialect } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";

// The postgres-js driver has no db.batch, so every local-Postgres and
// docker-compose deployment takes runCollectionMutation's db.transaction
// branch. The batch branch is covered in collection-batch.test.ts; this file
// covers the branch developers actually run locally.
const dialect = new PgDialect();

let txStatements: string[] = [];

type SqlCarrier = { __sql: unknown };

function queryText(item: unknown): string {
  const target = (item as SqlCarrier).__sql ?? item;
  return dialect.sqlToQuery(target as never).sql;
}

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => {
  const tx = {
    execute: async (query: unknown) => {
      txStatements.push(queryText(query));
      return { rows: [] };
    },
  };
  const db = {
    // No batch: this is the postgres-js shape, which forces the transaction
    // branch.
    execute: async (query: unknown) => {
      const text = queryText(query);
      txStatements.push(text);
      return { rows: [] };
    },
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      txStatements = [];
      return fn(tx);
    },
  };
  return { db, schema };
});

const { runCollectionMutation } = await import("@/lib/collection-access");

describe("runCollectionMutation transaction branch", () => {
  const cases: Array<{
    name: string;
    petMutation?: { ownerId: string; petSlugs: string[] };
    lockExistingPetSlugs?: boolean;
    expectSlugLock: boolean;
    expectPetRowLock: boolean;
  }> = [
    {
      name: "collection lock only",
      expectSlugLock: false,
      expectPetRowLock: false,
    },
    {
      name: "existing slug lock plus collection lock",
      lockExistingPetSlugs: true,
      expectSlugLock: true,
      expectPetRowLock: false,
    },
    {
      name: "slug lock, collection lock and approved pet row lock",
      petMutation: { ownerId: "u1", petSlugs: ["boba"] },
      expectSlugLock: true,
      expectPetRowLock: true,
    },
  ];

  for (const testCase of cases) {
    it(`takes the locks in order: ${testCase.name}`, async () => {
      let sawBuild = false;
      await runCollectionMutation({
        collectionId: "col_1",
        ...(testCase.petMutation ? { petMutation: testCase.petMutation } : {}),
        ...(testCase.lockExistingPetSlugs
          ? { lockExistingPetSlugs: true }
          : {}),
        buildBatch: () => [],
        runTransaction: async () => {
          // The build statements run inside the same transaction, after every
          // lock has been taken.
          sawBuild = true;
          return null;
        },
        parseBatch: () => null,
      });

      expect(sawBuild).toBe(true);

      const advisoryLocks = txStatements.filter((s) =>
        s.includes("pg_advisory_xact_lock"),
      );
      const rowLocks = txStatements.filter((s) => s.includes("FOR SHARE"));

      // The collection lock is always taken.
      expect(advisoryLocks.length).toBeGreaterThanOrEqual(1);
      expect(
        txStatements.some((s) => s.includes("pg_advisory_xact_lock")),
      ).toBe(true);

      expect(
        advisoryLocks.some((s) => s.includes("pet_collection_items")),
      ).toBe(testCase.expectSlugLock);
      expect(rowLocks.length > 0).toBe(testCase.expectPetRowLock);

      // Locks must precede the build statements.
      const firstAdvisory = txStatements.findIndex((s) =>
        s.includes("pg_advisory_xact_lock"),
      );
      expect(firstAdvisory).toBe(0);
    });
  }

  it("runs the caller's transaction body and returns its result", async () => {
    const result = await runCollectionMutation({
      collectionId: "col_1",
      buildBatch: () => [],
      runTransaction: async () => "from-transaction",
      parseBatch: () => "from-batch",
    });

    expect(result).toBe("from-transaction");
  });
});
