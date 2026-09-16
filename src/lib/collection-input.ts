import { isSafeExternalUrl } from "@/lib/url-allowlist";

export { MAX_COLLECTION_PETS } from "@/lib/collection-constants";

export const MAX_COLLECTION_TITLE = 80;
export const MAX_COLLECTION_DESCRIPTION = 280;

export type CollectionInput = {
  title: unknown;
  description?: unknown;
  petSlugs?: unknown;
};

export type CollectionRequestBody = {
  title?: unknown;
  description?: unknown;
  petSlugs?: unknown;
  allApproved?: unknown;
  externalUrl?: unknown;
  coverPetSlug?: unknown;
};

export function isCollectionRequestBody(
  value: unknown,
): value is CollectionRequestBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    body.allApproved === undefined || typeof body.allApproved === "boolean"
  );
}

export function normalizeCollectionExternalUrl(
  value: unknown,
): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > 300) return false;
  if (!isSafeExternalUrl(raw)) return false;
  return new URL(raw).toString();
}

export function normalizeCollectionCover(
  value: unknown,
): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) ? raw : false;
}

export type NormalizedCollectionInput = {
  title: string;
  description: string;
  petSlugs: string[];
};

export function resolveCollectionCover(
  requestedCover: string | null,
  petSlugs: string[],
  existingCover: string | null = null,
  preserveExisting = false,
): string | null {
  if (requestedCover !== null) return requestedCover;
  if (
    preserveExisting &&
    existingCover !== null &&
    petSlugs.includes(existingCover)
  ) {
    return existingCover;
  }
  return petSlugs[0] ?? null;
}

export function normalizeCollectionInput(
  input: CollectionInput,
): NormalizedCollectionInput {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 2 || title.length > MAX_COLLECTION_TITLE) {
    throw new Error("title_length");
  }

  if (
    input.description !== undefined &&
    typeof input.description !== "string"
  ) {
    throw new Error("description_type");
  }
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > MAX_COLLECTION_DESCRIPTION) {
    throw new Error("description_length");
  }

  if (input.petSlugs !== undefined && !Array.isArray(input.petSlugs)) {
    throw new Error("pet_slugs");
  }
  const petSlugs: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.petSlugs ?? []) {
    if (typeof raw !== "string") throw new Error("pet_slug");
    const slug = raw.trim().toLowerCase();
    if (!slug) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error("pet_slug");
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      petSlugs.push(slug);
    }
  }
  return { title, description, petSlugs };
}
