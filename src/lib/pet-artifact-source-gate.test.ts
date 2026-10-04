import { afterAll, describe, expect, mock, test } from "bun:test";

import { R2_PUBLIC_HOSTS, R2_TRUSTED_HOSTS } from "@/lib/r2-public-url";

// `publishPetPublicArtifacts` gates on the pet's stored spritesheet URL, and a
// URL stored under a legacy public host is deliberately absent from the asset
// allowlist — so checking it as stored refused the pet and it never got a
// thumbnail, preview, or sticker, even though the object was still readable.
// The fix is the one `install-script.ts` carries: rewrite before validating,
// so the value that is checked is the value that is served.
//
// This drives the real function. Every artifact is made to "already exist" so
// it returns at the early-out, before any sharp or R2 work — the assertion is
// about which URL passes the gate, not how the images are built.
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

const actualR2 = await import("@/lib/r2");

mock.module("@/lib/r2", () => ({
  ...actualR2,
  r2: {
    // `r2ObjectExists` reads a resolved send as "present", so all three
    // artifacts are skipped and the function returns at the early-out.
    send: async () => ({}),
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
});
