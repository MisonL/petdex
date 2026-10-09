import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";

import * as schema from "@/lib/db/schema";

// The withdraw route deletes R2 objects after removing the row. Its asset URLs
// are NOT pinned to the caller's namespace (`validateSubmission` accepts any
// `/pets/`, `/curated/`, `/community/` path), so a submission can point at
// another pet's live spritesheet — deleting on the row's word alone would let
// any user destroy an arbitrary object. These tests pin the reference re-check
// that prevents it, and that an owner's genuinely orphaned asset still goes.
//
// The R2 client is stubbed by replacing `r2.send` on the module singleton, not
// with `mock.module("@/lib/r2")`. `mock.module` is process-wide and its undo
// is not reliable across files on Bun 1.4.2: a bare `{ deleteR2Objects }`
// replacement here reached `r2.test.ts` loaded later, and `getSignedUrl` died
// on `client.config.endpointProvider`. Patching the method leaves every other
// export — and the client's `config` — intact.

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
let deleted: string[] = [];
let deletedBatches = 0;
// Whether the guarded pet DELETE matched a row. false models a concurrent
// approve/claim winning between the route's read and its write.
let petDeleted = true;

mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_1" }),
}));
mock.module("@/lib/same-origin", () => ({ requireSameOrigin: () => null }));
mock.module("@/lib/ratelimit", () => ({
  withdrawRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/db/client", () => ({
  db: {
    query: { submittedPets: { findFirst: async () => ROW } },
    execute: async () => (referenced ? [{ "?column?": 1 }] : []),
  },
  schema,
  // Statement order is [pet delete, reviews delete]; only the pet delete's
  // rows decide whether the withdraw took effect.
  executeAtomicReturning: async () => [petDeleted ? [{ id: ROW.id }] : [], []],
  rowsOf: (result: unknown) => (Array.isArray(result) ? result : []),
}));

const r2mod = await import("@/lib/r2");
type R2Like = { send: (command: unknown) => Promise<unknown> };
const r2Client = r2mod.r2 as unknown as R2Like;
const originalSend = r2Client.send;
r2Client.send = async (command: unknown) => {
  if (command instanceof DeleteObjectsCommand) {
    deletedBatches += 1;
    const objects = command.input.Delete?.Objects ?? [];
    deleted = objects.map((o) => o.Key ?? "").filter(Boolean);
    return { Deleted: deleted.map((Key) => ({ Key })) };
  }
  return originalSend(command);
};

const { POST } = await import("@/app/api/my-pets/[id]/withdraw/route");

afterAll(() => {
  r2Client.send = originalSend;
  mock.restore();
});

beforeEach(() => {
  referenced = false;
  deleted = [];
  deletedBatches = 0;
  petDeleted = true;
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

  it("reports not-withdrawable and skips cleanup when the guards lost the race", async () => {
    // A concurrent approve/claim won between the route's read and its write:
    // the guarded pet DELETE matched 0 rows, so the pet survived and its
    // reviews must too. The response has to say so instead of `ok:true`, and
    // no R2 cleanup may run for a withdrawal that never happened.
    petDeleted = false;
    const res = await withdraw();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "only_pending_can_be_withdrawn",
    });
    await settle(() => false);
    expect(deletedBatches).toBe(0);
  });
});
