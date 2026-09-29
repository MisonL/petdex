import "server-only";

import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import {
  posixInstallScript,
  posixNotFoundScript,
  powershellInstallScript,
  powershellNotFoundScript,
  type ResolvedPet,
} from "@/lib/install-script-render";
import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

export {
  posixInstallScript,
  posixNotFoundScript,
  powershellInstallScript,
  powershellNotFoundScript,
  type ResolvedPet,
};

export async function resolveInstallablePet(
  slug: string,
  _origin: string,
): Promise<ResolvedPet | null> {
  const submitted = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
  });
  if (!submitted || submitted.status !== "approved") return null;

  // Rewrite before validating, not after. Stored rows predate the current
  // bucket host, so checking the URL as stored rejects every pet whose assets
  // were written under a legacy host — which is most of them — while the
  // rewrite that would have made them valid never runs.
  //
  // The security property is unchanged, and depends on the order: the value
  // that gets validated is the value that gets served. `toCurrentR2PublicUrl`
  // returns its input untouched when the host is not one it recognizes, so an
  // attacker-controlled host still fails the check below and is never
  // downloaded from. Without that, a malicious pet.json plus shell-injected
  // URL chars could break out of the curl single-quotes and execute commands
  // on every viewer who pipes the script through sh.
  const petJsonUrl = toCurrentR2PublicUrl(submitted.petJsonUrl);
  const spritesheetUrl = toCurrentR2PublicUrl(submitted.spritesheetUrl);
  if (!isAllowedAssetUrl(petJsonUrl) || !isAllowedAssetUrl(spritesheetUrl)) {
    return null;
  }
  return {
    slug,
    displayName: submitted.displayName,
    petJsonUrl,
    spritesheetUrl,
    spriteExt: spritesheetUrl.endsWith(".png") ? "png" : "webp",
  };
}
