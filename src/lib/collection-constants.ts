export const MAX_COLLECTION_PETS = 24;

/** Keep a client-side selection within the server collection limit. */
export function limitCollectionPetSlugs(
  slugs: readonly string[],
  coverPetSlug: string | null = null,
): string[] {
  const unique = [...new Set(slugs)];
  if (unique.length <= MAX_COLLECTION_PETS) return unique;

  const limited = unique.slice(0, MAX_COLLECTION_PETS);
  if (
    coverPetSlug !== null &&
    unique.includes(coverPetSlug) &&
    !limited.includes(coverPetSlug)
  ) {
    limited[limited.length - 1] = coverPetSlug;
  }
  return limited;
}
