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

const PET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ERROR_MESSAGES: Record<string, string> = {
  collection_cap_reached: "collection limit reached",
  cover_not_in_collection: "cover pet must be in the collection",
  featured_not_deletable: "featured collections cannot be deleted",
  featured_not_editable: "featured collections cannot be edited",
  invalid_body: "request body must be a JSON object",
  invalid_cover_pet: "invalid cover pet slug",
  invalid_url: "external URL must use http or https",
  nothing_to_update: "nothing to update",
  not_found: "collection not found or not owned by you",
  pet_not_owned_or_approved: "all pets must be approved and owned by you",
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
  const readFlag = (name: string): string | null => {
    const prefix = `${name}=`;
    const equals = args.find((arg) => arg.startsWith(prefix));
    if (equals !== undefined) return equals.slice(prefix.length);
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    return value !== undefined && !value.startsWith("--") ? value : null;
  };
  const petsArg = readFlag("--pets");
  const petSlugs =
    petsArg === null
      ? null
      : Array.from(
          new Set(
            petsArg
              .split(",")
              .map((slug) => slug.trim().toLowerCase())
              .filter(Boolean),
          ),
        );
  if (petSlugs?.some((slug) => !PET_SLUG.test(slug)))
    throw new Error("pet_slug");
  const title = readFlag("--title");
  if (action === "create" && title === null) throw new Error("missing_title");
  const description = readFlag("--desc");
  const coverPetSlug = readFlag("--cover")?.trim().toLowerCase() ?? null;
  if (coverPetSlug && !PET_SLUG.test(coverPetSlug.trim().toLowerCase())) {
    throw new Error("pet_slug");
  }
  const externalUrl = readFlag("--external-url");
  const allApproved = args.includes("--all-approved");
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
    yes: args.includes("--yes"),
    json: args.includes("--json"),
  };
}

export async function collectionRequest(
  baseUrl: string,
  token: string,
  method: string,
  id: string | null,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/cli/collections${id ? `/${encodeURIComponent(id)}` : ""}`;
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
