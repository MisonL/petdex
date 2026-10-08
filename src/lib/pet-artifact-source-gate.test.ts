import { afterAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { R2_PUBLIC_HOSTS, R2_TRUSTED_HOSTS } from "@/lib/r2-public-url";

// `publishPetPublicArtifacts` gates on the pet's stored spritesheet URL, and a
// URL stored under a legacy public host is deliberately absent from the asset
// allowlist — so checking it as stored refused the pet and it never got a
// thumbnail, preview, or sticker, even though the object was still readable.
// The fix is the one `install-script.ts` carries: rewrite before validating,
// so the value that is checked is the value that is served.
//
// This drives the real function. The R2 stub answers the source GET and each
// HEAD; when the stored `petdex-source-sha256` matches the source, all three
// artifacts are skipped and the function returns before any sharp work — the
// assertion is about which URL passes the gate, not how images are built.
//
// The `@/lib/r2` stub below is process-wide, so it spreads the real module
// (a bare replacement stripped `presignPut` and broke `r2.test.ts` when that
// file loaded later) and restores afterward. `mock.restore()` in `afterAll` is
// what keeps the stub from reaching the next suite.

const legacyHost = [...R2_PUBLIC_HOSTS].find((h) => !R2_TRUSTED_HOSTS.has(h));
if (!legacyHost) {
  throw new Error(
    "no legacy public host to test with: R2_PUBLIC_HOSTS has no entry " +
      "outside R2_TRUSTED_HOSTS, so this guard has nothing to check",
  );
}

const SOURCE = Buffer.from([1, 2, 3, 4]);
const SOURCE_SHA = createHash("sha256").update(SOURCE).digest("hex");

// Mutable so a test can prove that art rendered from an older spritesheet is
// NOT skipped (the #590 staleness fix). Default: every artifact is current.
let storedSourceSha = SOURCE_SHA;

const actualR2 = await import("@/lib/r2");

mock.module("@/lib/r2", () => ({
  ...actualR2,
  r2: {
    send: async (command: { constructor: { name: string } }) => {
      if (command instanceof GetObjectCommand) {
        return {
          Body: { transformToByteArray: async () => new Uint8Array(SOURCE) },
        };
      }
      return { Metadata: { "petdex-source-sha256": storedSourceSha } };
    },
  },
}));

const { publishPetPublicArtifacts } = await import("./pet-public-artifacts");

afterAll(() => {
  mock.restore();
});

describe("publishPetPublicArtifacts source gate", () => {
  test("a legacy public host passes the gate", async () => {
    const result = await publishPetPublicArtifacts({
      slug: "byte-bunny",
      spritesheetUrl: `https://${legacyHost}/pets/abc/sprite.webp`,
    });

    expect(result.failed.map((f) => f.reason)).not.toContain(
      "unsupported_source",
    );
    expect(result.ok).toBe(true);
    // Reached the publish loop: the three artifact keys were checked.
    expect(result.skipped.length).toBe(3);
  });

  test("the canonical host passes the gate", async () => {
    const result = await publishPetPublicArtifacts({
      slug: "byte-bunny",
      spritesheetUrl: "https://assets.petdex.dev/pets/abc/sprite.webp",
    });

    expect(result.failed.map((f) => f.reason)).not.toContain(
      "unsupported_source",
    );
  });

  test("a host that is not ours is still refused", async () => {
    // The rewrite only maps hosts it recognizes, so the allowlist still does
    // its job for an attacker-supplied URL — the security property the
    // reorder must not weaken.
    const result = await publishPetPublicArtifacts({
      slug: "byte-bunny",
      spritesheetUrl: "https://evil.example.com/pets/abc/sprite.webp",
    });

    expect(result.ok).toBe(false);
    expect(result.failed.map((f) => f.reason)).toContain("unsupported_source");
  });

  test("stale artifacts from an older spritesheet are not skipped (#590)", async () => {
    // Existence alone used to be the skip test, so approving new art under an
    // unchanged slug left the old preview/thumb/sticker live forever. With a
    // stored source hash that no longer matches, the artifacts must be
    // republished instead of skipped.
    storedSourceSha = "0".repeat(64);
    try {
      const result = await publishPetPublicArtifacts({
        slug: "byte-bunny",
        spritesheetUrl: "https://assets.petdex.dev/pets/abc/sprite.webp",
      });
      // The source is not a real image, so rendering fails — the point is that
      // the stale objects were NOT taken as a reason to skip.
      expect(result.skipped.length).toBe(0);
    } finally {
      storedSourceSha = SOURCE_SHA;
    }
  });
});
