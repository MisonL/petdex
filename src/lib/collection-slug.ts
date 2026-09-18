import { validateProfileHandle } from "@/lib/profiles";

// Collections use a longer slug budget than pets (src/lib/slug.ts caps at
// 40) because the base is seeded from a profile handle and still has to
// read as a name after the uniqueness suffix is appended.
const MAX_COLLECTION_SLUG_LENGTH = 48;

/** How many `base`, `base-2`, `base-3`, ... candidates a caller probes
 *  before giving up and allocating a random slug. */
export const COLLECTION_SLUG_ATTEMPTS = 20;

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_COLLECTION_SLUG_LENGTH);
}

/**
 * Base slug for a new collection. Reserved handles (which would collide with
 * app routes such as /collections or /admin) and seeds that do not slugify at
 * all fall back to a random slug rather than producing an empty or reserved
 * base.
 */
export function collectionSlugBase(seed: string): string {
  const base = slugify(seed);
  if (!base || validateProfileHandle(base) === "reserved") {
    return `collection-${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return base;
}

/** Candidate slugs to probe for availability, in preference order. */
export function collectionSlugCandidates(
  base: string,
  attempts = COLLECTION_SLUG_ATTEMPTS,
): string[] {
  return Array.from({ length: attempts }, (_, index) =>
    index === 0 ? base : `${base}-${index + 1}`,
  );
}
