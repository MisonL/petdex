import { NextResponse } from "next/server";

import { and, asc, eq, inArray } from "drizzle-orm";

import { verifyCliBearer } from "@/lib/cli-auth";
import {
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
import { cliVerifyRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

function ip(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
}

export async function GET(req: Request): Promise<Response> {
  const limit = await cliVerifyRatelimit.limit(ip(req));
  if (!limit.success)
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const includeApprovedPetCount =
    new URL(req.url).searchParams.get("includeApprovedPetCount") === "1";
  const rows = await db
    .select()
    .from(schema.petCollections)
    .where(eq(schema.petCollections.ownerId, principal.userId))
    .orderBy(asc(schema.petCollections.title));
  const itemRows = rows.length
    ? await db
        .select({
          collectionId: schema.petCollectionItems.collectionId,
          slug: schema.petCollectionItems.petSlug,
        })
        .from(schema.petCollectionItems)
        .where(
          inArray(
            schema.petCollectionItems.collectionId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(
          asc(schema.petCollectionItems.collectionId),
          asc(schema.petCollectionItems.position),
        )
    : [];
  const slugsByCollection = new Map<string, string[]>();
  for (const item of itemRows) {
    const slugs = slugsByCollection.get(item.collectionId) ?? [];
    slugs.push(item.slug);
    slugsByCollection.set(item.collectionId, slugs);
  }
  const items = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    externalUrl: row.externalUrl,
    coverPetSlug: row.coverPetSlug,
    featured: row.featured,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    petSlugs: slugsByCollection.get(row.id) ?? [],
  }));
  if (!includeApprovedPetCount)
    return NextResponse.json({ collections: items });

  const approvedPets = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, principal.userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    )
    .orderBy(asc(schema.submittedPets.slug));

  return NextResponse.json({
    collections: items,
    approvedPetCount: approvedPets.length,
  });
}

export async function POST(req: Request): Promise<Response> {
  const limit = await cliVerifyRatelimit.limit(ip(req));
  if (!limit.success)
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  const approved = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, principal.userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    );
  const allowed = new Set(approved.map((p) => p.slug));
  const requested =
    body.allApproved === true ? [...allowed].sort() : input.petSlugs;
  if (requested.length > MAX_COLLECTION_PETS)
    return NextResponse.json(
      { error: "collection_pet_limit", max: MAX_COLLECTION_PETS },
      { status: 400 },
    );
  if (requested.some((slug) => !allowed.has(slug)))
    return NextResponse.json(
      { error: "pet_not_owned_or_approved" },
      { status: 422 },
    );
  const externalUrl = normalizeCollectionExternalUrl(body.externalUrl);
  if (externalUrl === false)
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  const requestedCover = normalizeCollectionCover(body.coverPetSlug);
  if (requestedCover === false)
    return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
  if (requestedCover !== null && !requested.includes(requestedCover))
    return NextResponse.json(
      { error: "cover_not_in_collection" },
      { status: 400 },
    );
  const coverPetSlug = requestedCover ?? requested[0] ?? null;
  const id = `col_${crypto.randomUUID().replace(/-/g, "")}`;
  const requestedSlug = `collection-${crypto.randomUUID().replace(/-/g, "")}`;
  const created = await createOwnerCollection({
    id,
    slug: requestedSlug,
    title: input.title,
    description: input.description,
    ownerId: principal.userId,
    externalUrl,
    coverPetSlug,
    petSlugs: requested,
  });
  if (created.status === "cap")
    return NextResponse.json(
      { error: "collection_cap_reached", max: MAX_OWNER_COLLECTIONS },
      { status: 400 },
    );
  if (created.status === "pets_not_owned_or_approved")
    return NextResponse.json(
      { error: "pet_not_owned_or_approved" },
      { status: 422 },
    );
  if (created.status === "slug_conflict")
    return NextResponse.json(
      { error: "collection_slug_conflict" },
      { status: 409 },
    );
  const slug = created.slug;
  await revalidateCollectionTags(slug);
  return NextResponse.json(
    {
      ok: true,
      collection: {
        id,
        slug,
        title: input.title,
        description: input.description,
        externalUrl,
        coverPetSlug,
        petSlugs: requested,
      },
    },
    { status: 201 },
  );
}
