import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { HeadObjectCommand } from "@aws-sdk/client-s3";

import * as schema from "@/lib/db/schema";
import * as realRatelimit from "@/lib/ratelimit";

// `applyPetEdit` is the shared tail of the web and CLI edit routes. An
// oversized pending asset is worse here than at submit: it is promoted onto
// the live row on approval, and until then the public page serves the OLD
// bytes, so a reviewer never sees what will actually ship. The guard runs
// before any write, so a refused edit leaves the pet untouched.
//
// The db stub answers only the ownership lookup; any write throws, which is
// what proves the refusal happens before persistence.

process.env.R2_ACCOUNT_ID ??= "test-account";
process.env.R2_ACCESS_KEY_ID ??= "test-access-key";
process.env.R2_SECRET_ACCESS_KEY ??= "test-secret-key";
process.env.R2_BUCKET ??= "petdex-pets";

const r2mod = await import("@/lib/r2");
const { PET_ASSET_MAX_BYTES } = await import("@/lib/upload-limits");

type R2Like = { send: (command: unknown) => Promise<unknown> };
const client = r2mod.r2 as unknown as R2Like;
const originalSend = client.send;

const SLUG = "boba";
const BUCKET = "https://assets.petdex.dev";
const PENDING_SPRITE = `${BUCKET}/pets/${SLUG}-pending-0123456789ab/sprite.webp`;

let contentLength: number;
let wrote: boolean;

const ROW = {
  id: "pet_1",
  slug: SLUG,
  ownerId: "user_1",
  status: "approved",
  displayName: "Boba",
  description: "A very round cat that sits on keyboards.",
  tags: [],
  spritesheetUrl: `${BUCKET}/pets/${SLUG}-fedcba987654/sprite.webp`,
  petJsonUrl: `${BUCKET}/pets/${SLUG}-fedcba987654/petjson.json`,
  zipUrl: `${BUCKET}/pets/${SLUG}-fedcba987654/zip.zip`,
  spriteVersionNumber: 2,
  editCount: 0,
  lastEditAt: null,
  approvedAt: null,
  pendingDisplayName: null,
  pendingDescription: null,
  pendingTags: null,
  pendingSubmittedAt: null,
  pendingSpritesheetUrl: null,
  pendingPetJsonUrl: null,
  pendingZipUrl: null,
  pendingSpritesheetWidth: null,
  pendingSpritesheetHeight: null,
  pendingSpriteVersionNumber: null,
  pendingDhash: null,
  pendingReviewId: null,
};

mock.module("server-only", () => ({}));
mock.module("@/lib/ratelimit", () => ({
  ...realRatelimit,
  editRatelimit: { limit: async () => ({ success: true }) },
}));
mock.module("@/lib/db/client", () => ({
  db: {
    query: { submittedPets: { findFirst: async () => ROW } },
    update: () => {
      wrote = true;
      throw new Error("write reached before the size check");
    },
    execute: () => {
      wrote = true;
      throw new Error("write reached before the size check");
    },
  },
  // The real schema: `applyPetEdit` builds its WHERE from
  // `schema.submittedPets.id`, so a bare `{}` throws before the guard runs.
  schema,
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { applyPetEdit } = await import("@/lib/pet-edit");

beforeEach(() => {
  wrote = false;
  contentLength = PET_ASSET_MAX_BYTES + 1;
  client.send = async (command: unknown) => {
    if (!(command instanceof HeadObjectCommand)) {
      throw new Error("unexpected command");
    }
    return { ContentLength: contentLength };
  };
});

afterAll(() => {
  client.send = originalSend;
  mock.restore();
});

describe("applyPetEdit asset size guard", () => {
  it("refuses an oversized pending sprite before writing", async () => {
    const res = await applyPetEdit({
      id: "pet_1",
      userId: "user_1",
      body: {
        spritesheetUrl: PENDING_SPRITE,
        spritesheetWidth: 1536,
        spritesheetHeight: 2288,
        spriteVersionNumber: 2,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "asset_too_large",
      field: "spritesheetUrl",
    });
    expect(wrote).toBe(false);
  });

  it("does not HEAD the bucket when no asset changed", async () => {
    // A text-only edit must not pay for a size check it cannot fail. The
    // write stub throws, so the outcome is a rejection — the assertion is the
    // HEAD count, which is what proves the guard skipped the bucket.
    let heads = 0;
    client.send = async () => {
      heads += 1;
      return { ContentLength: PET_ASSET_MAX_BYTES + 1 };
    };
    await expect(
      applyPetEdit({
        id: "pet_1",
        userId: "user_1",
        body: { displayName: "Boba the Second" },
      }),
    ).rejects.toThrow();
    expect(heads).toBe(0);
  });
});
