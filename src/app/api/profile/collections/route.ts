import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import {
  canManageCreatorCollections,
  createOwnerCollection,
  MAX_OWNER_COLLECTIONS,
} from "@/lib/collection-access";
import {
  type CollectionRequestBody,
  isCollectionRequestBody,
  MAX_COLLECTION_PETS,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
} from "@/lib/collection-input";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { validateProfileHandle } from "@/lib/profiles";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create a new personal collection. Personal = featured=false. Caps
// at MAX_OWNER_COLLECTIONS per creator.
export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await canManageCreatorCollections(userId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: CollectionRequestBody;
  try {
    const parsed = await req.json();
    if (!isCollectionRequestBody(parsed)) throw new Error("invalid_body");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  let input: ReturnType<typeof normalizeCollectionInput>;
  try {
    input = normalizeCollectionInput({
      title: body.title ?? "",
      description: body.description,
      petSlugs: body.petSlugs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }

  const externalUrl = normalizeCollectionExternalUrl(body.externalUrl);
  if (externalUrl === false) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const requestedCover = normalizeCollectionCover(body.coverPetSlug);
  if (requestedCover === false) {
    return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
  }

  const approvedPets = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    );
  const allowedSlugs = new Set(approvedPets.map((p) => p.slug));
  if (input.petSlugs.length > MAX_COLLECTION_PETS) {
    return NextResponse.json(
      { error: "collection_pet_limit", max: MAX_COLLECTION_PETS },
      { status: 400 },
    );
  }
  if (input.petSlugs.some((slug) => !allowedSlugs.has(slug))) {
    return NextResponse.json(
      { error: "pet_not_owned_or_approved" },
      { status: 422 },
    );
  }
  const petSlugs = input.petSlugs;
  if (requestedCover !== null && !petSlugs.includes(requestedCover)) {
    return NextResponse.json(
      { error: "cover_not_in_collection" },
      { status: 400 },
    );
  }
  const coverPetSlug = requestedCover ?? petSlugs[0] ?? null;

  const profile = await db.query.userProfiles.findFirst({
    where: eq(schema.userProfiles.userId, userId),
  });
  const requestedSlug = await collectionSlugForOwner(
    profile?.handle ?? input.title,
  );
  const id = `col_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = await createOwnerCollection({
    id,
    slug: requestedSlug,
    title: input.title,
    description: input.description,
    ownerId: userId,
    externalUrl,
    coverPetSlug,
    petSlugs,
  });
  if (created.status === "cap") {
    return NextResponse.json(
      { error: "collection_cap_reached", max: MAX_OWNER_COLLECTIONS },
      { status: 400 },
    );
  }
  if (created.status === "pets_not_owned_or_approved") {
    return NextResponse.json(
      { error: "pet_not_owned_or_approved" },
      { status: 422 },
    );
  }
  if (created.status === "slug_conflict") {
    return NextResponse.json(
      { error: "collection_slug_conflict" },
      { status: 409 },
    );
  }
  const slug = created.slug;

  await revalidateCollectionTags(slug);

  return NextResponse.json({
    ok: true,
    collection: {
      id,
      slug,
      title: input.title,
      description: input.description,
      externalUrl,
      coverPetSlug,
      petSlugs,
    },
  });
}

async function collectionSlugForOwner(seed: string): Promise<string> {
  let base = slugify(seed);
  if (!base || validateProfileHandle(base) === "reserved") {
    base = `collection-${crypto.randomUUID().replace(/-/g, "")}`;
  }
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db.query.petCollections.findFirst({
      where: eq(schema.petCollections.slug, candidate),
    });
    if (!existing) return candidate;
  }
  return `collection-${crypto.randomUUID().replace(/-/g, "")}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
