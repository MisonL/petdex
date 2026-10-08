import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import * as schema from "@/lib/db/schema";

// The withdraw route deletes R2 objects after removing the row. Its asset URLs
// are NOT pinned to the caller's namespace (`validateSubmission` accepts any
// `/pets/`, `/curated/`, `/community/` path), so a submission can point at
// another pet's live spritesheet — deleting on the row's word alone would let
// any user destroy an arbitrary object. These tests pin the reference re-check
// that prevents it, and that an owner's genuinely orphaned asset still goes.

const BUCKET = "https://assets.petdex.dev";
const UPLOAD = "0123456789ab";
const ROW = {
  id: "pet_1",
  ownerId: "user_1",
  slug: "boba",
  status: "pending",
  spritesheetUrl: `${BUCKET}/pets/boba-${UPLOAD}/sprite.webp`,
  petJsonUrl: `${BUCKET}/pets/boba-${UPLOAD}/petjson.json`,
  zipUrl: `${BUCKET}/pets/boba-${UPLOAD}/zip.zip`,
};

let referenced = false;
let deleted: string[][] = [];
let deletedBatches = 0;

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));
mock.module("@/lib/ratelimit", () => ({
  withdrawRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/r2", () => ({
  deleteR2Objects: async (keys: string[]) => {
    deletedBatches += 1;
    deleted = keys;
    return { Deleted: keys.map((Key) => ({ Key })) };
  },
  R2_BUCKET: "petdex-pets",
}));
mock.module("@/lib/db/client", () => ({
  db: {
    query: { submittedPets: { findFirst: async () => ROW } },
    execute: async () => (referenced ? [{ "?column?": 1 }] : []),
  },
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: (result: unknown) => (Array.isArray(result) ? result : []),
}));

const { POST } = await import("@/app/api/my-pets/[id]/withdraw/route");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  referenced = false;
  deleted = [];
  deletedBatches = 0;
});

/**
 * The route's cleanup is fire-and-forget behind dynamic imports, so poll
 * briefly rather than guessing at a microtask count.
 */
async function settle(when: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!when() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withdraw(): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/my-pets/pet_1/withdraw", {
      method: "POST",
      headers: { origin: "https://petdex.dev", host: "petdex.dev" },
    }) as never,
    {
      params: Promise.resolve({ id: "pet_1" }),
    },
  );
}

describe("withdraw asset cleanup", () => {
  it("deletes the owner's orphaned assets when nothing references them", async () => {
    const res = await withdraw();
    expect(res.status).toBe(200);
    await settle(() => deletedBatches > 0);
    expect(deletedBatches).toBe(1);
    expect(deleted).toContain(`pets/boba-${UPLOAD}/sprite.webp`);
    expect(deleted).toContain(`pets/boba-${UPLOAD}/zip.zip`);
  });

  it("does NOT delete a key another row still references", async () => {
    // A submission pointed its asset URLs at another pet's object; the
    // reference row keeps it alive, so the withdraw must leave R2 alone.
    referenced = true;
    const res = await withdraw();
    expect(res.status).toBe(200);
    await settle(() => false);
    expect(deletedBatches).toBe(0);
  });
});
