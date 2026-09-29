// Creating a request writes two rows: the request, and the creator's own vote.
// They were separate statements, and `pet_request_votes` carries no foreign
// key, so a vote insert that failed left the request behind — reading the
// column default of 1 until the next upvote on the same text recounted it to
// 0. The route now wraps both in one transaction.
//
// The route is driven for real, against a PGlite database standing in for
// `@/lib/db/client`, because the defect was in how the route sequences its
// writes: a test of `db.transaction` in isolation passes either way.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

const client = new PGlite();
const testDb = drizzle(client, { schema });

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
  clerkClient: {},
}));
// The route reads `db.query.petRequests` for dedup and `db.transaction` for
// the write, so the stand-in has to expose the real drizzle surface.
mock.module("@/lib/db/client", () => ({ db: testDb, schema }));
mock.module("@/lib/ratelimit", () => ({
  petRequestRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));
mock.module("@/lib/query-embed", () => ({ embedQuery: async () => null }));
mock.module("@neondatabase/serverless", () => ({
  // The route's own `rawSql` is only used for the best-effort embedding
  // update and the dedup recount, neither of which this suite exercises.
  neon: () => async () => [],
}));

const { POST } = await import("@/app/api/pet-requests/route");

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_requests" (
      "id" text PRIMARY KEY,
      "query" text NOT NULL,
      "normalized" text NOT NULL,
      "requested_by" text,
      "upvote_count" integer NOT NULL DEFAULT 1,
      "status" text NOT NULL DEFAULT 'open',
      "fulfilled_pet_slug" text,
      "image_url" text,
      "image_review_status" text NOT NULL DEFAULT 'none',
      "image_rejection_reason" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "pet_request_votes" (
      "request_id" text NOT NULL,
      "user_id" text NOT NULL,
      PRIMARY KEY ("request_id", "user_id")
    )
  `);
  // A trigger that rejects the creator's own vote, standing in for any
  // failure of that insert. Without it the happy path succeeds whether or not
  // the two writes share a transaction, and the test cannot tell them apart.
  await testDb.execute(sql`
    CREATE OR REPLACE FUNCTION reject_probe_vote() RETURNS trigger AS $$
    BEGIN
      IF NEW.user_id = 'user_1' THEN
        RAISE EXCEPTION 'probe: vote insert refused';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await testDb.execute(sql`
    CREATE OR REPLACE TRIGGER reject_probe_vote_trigger
    BEFORE INSERT ON "pet_request_votes"
    FOR EACH ROW EXECUTE FUNCTION reject_probe_vote()
  `);
});

afterAll(async () => {
  await client.close();
});

function post(query: string): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/pet-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
}

async function requestCount(): Promise<number> {
  const rows = (await testDb.execute(
    sql`SELECT id FROM "pet_requests"`,
  )) as unknown as { rows?: unknown[] };
  return ((rows.rows ?? rows) as unknown[]).length;
}

describe("POST /api/pet-requests", () => {
  it("leaves no request behind when the creator's vote cannot be written", async () => {
    const before = await requestCount();
    const res = post("a bunny that deploys on fridays");

    // The vote insert is refused by the trigger, so the write fails. The
    // route does not catch it, so the failure surfaces as a rejection rather
    // than a status — what matters is the row count either way: with both
    // writes in one transaction the request is rolled back, and without one
    // it survives as a request nobody voted for.
    await res.catch(() => {});
    expect(await requestCount()).toBe(before);
  });
});
