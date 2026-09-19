export type CollectionRecord = {
  id: string;
  slug: string;
  title: string;
  description: string;
  externalUrl: string | null;
  coverPetSlug: string | null;
  featured: boolean;
  createdAt: string;
  updatedAt: string;
  petSlugs: string[];
};

export type CollectionAction = "list" | "create" | "edit" | "delete";

export type ParsedCollectionArgs = {
  action: CollectionAction;
  ref: string | null;
  title: string | null;
  description: string | null;
  petSlugs: string[] | null;
  coverPetSlug: string | null;
  externalUrl: string | null;
  allApproved: boolean;
  yes: boolean;
  json: boolean;
};

export const MAX_COLLECTION_PETS = 24;

const PET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a boolean flag is set, accepting both `--flag` and `--flag=true`.
 * Exported because the entrypoint has to answer the same question before it
 * has parsed the arguments: the first-run notice is suppressed for
 * machine-readable output, and `--json=true` counts.
 */
export function hasBooleanFlag(args: string[], name: string): boolean {
  const prefix = `${name}=`;
  const equals = args.find((arg) => arg.startsWith(prefix));
  if (equals !== undefined) {
    const value = equals.slice(prefix.length).trim().toLowerCase();
    return value !== "false" && value !== "0";
  }
  return args.includes(name);
}

/**
 * Whether a locally-computed member list is definitely going to be rejected.
 *
 * Mirrors collectionPetLimitExceeded() on the server: the cap bounds growth, so
 * only a create — which has no stored members to compare against — can be
 * decided from the list alone. An edit may legitimately hold more than the cap
 * (a collection created before it existed), so it is left to the server, which
 * knows what the row already stores.
 */
export function overCollectionPetLimit(
  action: CollectionAction,
  memberCount: number,
): boolean {
  return action === "create" && memberCount > MAX_COLLECTION_PETS;
}

const ERROR_MESSAGES: Record<string, string> = {
  collection_cap_reached: "collection limit reached",
  collection_pet_limit: `collection cannot contain more than ${MAX_COLLECTION_PETS} pets; use --pets with at most ${MAX_COLLECTION_PETS} slugs instead of --all-approved`,
  collection_slug_conflict: "could not allocate a unique collection slug",
  cover_not_in_collection: "cover pet must be in the collection",
  description_length: "description must be at most 280 characters",
  description_type: "description must be a string",
  featured_not_deletable: "featured collections cannot be deleted",
  featured_not_editable: "featured collections cannot be edited",
  invalid_body: "request body must be a JSON object",
  invalid_cover_pet: "invalid cover pet slug",
  invalid_url: "external URL must use https",
  nothing_to_update: "nothing to update",
  not_found: "collection not found or not owned by you",
  pet_not_owned_or_approved: "all pets must be approved and owned by you",
  pet_slug:
    "every pet slug must be lowercase letters, digits and single hyphens",
  pet_slugs: "petSlugs must be a list of pet slugs",
  title_length: "title must be between 2 and 80 characters",
  unauthorized: "not signed in; run `petdex login`",
};

export function parseCollectionArgs(args: string[]): ParsedCollectionArgs {
  const action = args[0];
  if (
    action !== "list" &&
    action !== "create" &&
    action !== "edit" &&
    action !== "delete"
  ) {
    throw new Error("usage");
  }
  const ref =
    action === "create" || action === "list"
      ? null
      : args[1] && !args[1].startsWith("--")
        ? args[1]
        : null;
  if ((action === "edit" || action === "delete") && !ref)
    throw new Error("missing_collection");
  const readBoolean = (name: string): boolean => hasBooleanFlag(args, name);

  const readFlag = (name: string): string | null => {
    const prefix = `${name}=`;
    const equals = args.find((arg) => arg.startsWith(prefix));
    if (equals !== undefined) return equals.slice(prefix.length);
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    return value !== undefined && !value.startsWith("--") ? value : null;
  };
  const allApproved = readBoolean("--all-approved");
  const petsArg = readFlag("--pets");
  // --all-approved replaces the explicit list server-side, so an oversized or
  // malformed --pets is never sent and must not fail the command locally.
  const petSlugs =
    petsArg === null || allApproved
      ? null
      : Array.from(
          new Set(
            petsArg
              .split(",")
              .map((slug) => slug.trim().toLowerCase())
              .filter(Boolean),
          ),
        );
  // `--pets ""` (or `--pets $UNSET_VAR`) parses to an empty list, which the
  // server reads as "replace the members with nothing" and silently empties
  // the collection. Refuse it: an accidental empty expansion must not destroy
  // data, and there is no way to tell the two apart.
  if (petSlugs !== null && petSlugs.length === 0) throw new Error("empty_pets");
  if (petSlugs?.some((slug) => !PET_SLUG.test(slug)))
    throw new Error("pet_slug");
  // Only a create can be judged here. The pet cap bounds growth, so whether an
  // over-cap list is allowed depends on what the collection already stores: a
  // row created before the cap existed keeps its members and may still be
  // renamed or shrunk. A create has no stored row, so over-cap is always a
  // rejection; an edit knows nothing about the stored members yet and has to
  // let the server decide instead of blocking a legal rename locally.
  if (petSlugs && overCollectionPetLimit(action, petSlugs.length))
    throw new Error("collection_pet_limit");
  const title = readFlag("--title");
  if (action === "create" && title === null) throw new Error("missing_title");
  const description = readFlag("--desc");
  const coverPetSlug = readFlag("--cover")?.trim().toLowerCase() ?? null;
  if (coverPetSlug && !PET_SLUG.test(coverPetSlug.trim().toLowerCase())) {
    throw new Error("cover_pet_slug");
  }
  const externalUrl = readFlag("--external-url");
  if (
    action === "edit" &&
    title === null &&
    description === null &&
    petSlugs === null &&
    coverPetSlug === null &&
    externalUrl === null &&
    !allApproved
  ) {
    throw new Error("nothing_to_update");
  }
  return {
    action,
    ref,
    title,
    description,
    petSlugs,
    coverPetSlug,
    externalUrl,
    allApproved,
    yes: readBoolean("--yes"),
    json: readBoolean("--json"),
  };
}

export async function collectionRequest(
  baseUrl: string,
  token: string,
  method: string,
  id: string | null,
  body?: Record<string, unknown>,
  query = "",
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/cli/collections${id ? `/${encodeURIComponent(id)}` : ""}${query}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    [key: string]: unknown;
  };
  if (!res.ok) {
    if (res.status === 429 || data.error === "rate_limited") {
      throw new Error("rate limited; retry later (rate_limited)");
    }
    const code = data.error;
    if (code && ERROR_MESSAGES[code]) {
      throw new Error(`${ERROR_MESSAGES[code]} (${code})`);
    }
    throw new Error(code ?? `request_failed_${res.status}`);
  }
  return data;
}
