// The install endpoint rejected every pet whose stored asset URLs still point
// at a host the bucket used to serve from: `resolveInstallablePet` checked the
// URL as stored against the trust list that deliberately excludes those legacy
// hosts, and the rewrite that would have made it valid ran afterwards. The
// rewrite has to come first, and the value that gets validated has to be the
// value that gets served.
//
// These drive the real function rather than the helpers it calls: the defect
// was the order of two statements inside it, which no assertion about
// `toCurrentR2PublicUrl` or `isAllowedAssetUrl` alone can see.
import { describe, expect, it, mock } from "bun:test";

import {
  DEFAULT_R2_PUBLIC_BASE,
  R2_PUBLIC_HOSTS,
  R2_TRUSTED_HOSTS,
} from "@/lib/r2-public-url";

const legacyHost = [...R2_PUBLIC_HOSTS].find((h) => !R2_TRUSTED_HOSTS.has(h));

/** The row `findFirst` hands back, replaced per test. */
let row: Record<string, unknown> | undefined;

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({
  schema: { submittedPets: { slug: "slug" } },
  db: { query: { submittedPets: { findFirst: async () => row } } },
}));

const { resolveInstallablePet } = await import("@/lib/install-script");

function approvedRow(petJsonUrl: string, spritesheetUrl: string) {
  return {
    slug: "nukey",
    displayName: "Nukey",
    status: "approved",
    petJsonUrl,
    spritesheetUrl,
  };
}

describe("resolveInstallablePet", () => {
  it("resolves a pet whose stored URLs are on a legacy host", async () => {
    expect(legacyHost).toBeDefined();
    row = approvedRow(
      `https://${legacyHost}/pets/x/petjson.json`,
      `https://${legacyHost}/pets/x/sprite.webp`,
    );

    const pet = await resolveInstallablePet("nukey", "https://petdex.dev");

    expect(pet).not.toBeNull();
    // Rewritten, not echoed back — the whole point of accepting the row.
    expect(pet?.petJsonUrl).toBe(
      `${DEFAULT_R2_PUBLIC_BASE}/pets/x/petjson.json`,
    );
    expect(pet?.spritesheetUrl).toBe(
      `${DEFAULT_R2_PUBLIC_BASE}/pets/x/sprite.webp`,
    );
    expect(pet?.spriteExt).toBe("webp");
  });

  it("still refuses a pet whose assets live on an untrusted host", async () => {
    // The security property the ordering must not break: the rewrite is a
    // no-op for a host it does not recognize, so the check that follows
    // rejects it and no download is ever pointed at attacker infrastructure.
    row = approvedRow(
      "https://evil.example/pets/x/petjson.json",
      "https://evil.example/pets/x/sprite.webp",
    );

    expect(
      await resolveInstallablePet("nukey", "https://petdex.dev"),
    ).toBeNull();
  });

  it("refuses a pet that is not approved", async () => {
    row = {
      ...approvedRow(
        "https://assets.petdex.dev/x/p.json",
        "https://assets.petdex.dev/x/s.webp",
      ),
      status: "pending",
    };
    expect(
      await resolveInstallablePet("nukey", "https://petdex.dev"),
    ).toBeNull();
  });

  it("refuses a missing pet", async () => {
    row = undefined;
    expect(
      await resolveInstallablePet("nukey", "https://petdex.dev"),
    ).toBeNull();
  });
});
