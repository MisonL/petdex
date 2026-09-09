import { NextResponse } from "next/server";

import { and, eq, or } from "drizzle-orm";

import { verifyCliBearer } from "@/lib/cli-auth";
import {
  type CollectionRequestBody,
  isCollectionRequestBody,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
} from "@/lib/collection-input";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { cliVerifyRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
}

async function findOwnedCollection(reference: string, userId: string) {
  return db.query.petCollections.findFirst({
    where: and(
      eq(schema.petCollections.ownerId, userId),
      or(
        eq(schema.petCollections.id, reference),
        eq(schema.petCollections.slug, reference),
      ),
    ),
  });
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const limit = await cliVerifyRatelimit.limit(clientIp(req));
  if (!limit.success)
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: reference } = await ctx.params;
  const collection = await findOwnedCollection(reference, principal.userId);
  if (!collection)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (collection.featured)
    return NextResponse.json(
      { error: "featured_not_editable" },
      { status: 403 },
    );

  let body: CollectionRequestBody;
  try {
    const parsed = await req.json();
    if (!isCollectionRequestBody(parsed)) throw new Error("invalid_body");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const petsChanged = body.petSlugs !== undefined || body.allApproved === true;
  if (
    body.title === undefined &&
    body.description === undefined &&
    !petsChanged &&
    body.externalUrl === undefined &&
    body.coverPetSlug === undefined
  ) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  let input: ReturnType<typeof normalizeCollectionInput>;
  try {
    input = normalizeCollectionInput({
      title: body.title === undefined ? collection.title : body.title,
      description:
        body.description === undefined
          ? collection.description
          : body.description,
      petSlugs: body.petSlugs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }

  let pets: string[] | undefined;
  if (petsChanged) {
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
    pets = body.allApproved === true ? [...allowed].sort() : input.petSlugs;
    if (pets.some((slug) => !allowed.has(slug)))
      return NextResponse.json(
        { error: "pet_not_owned_or_approved" },
        { status: 422 },
      );
  }

  let coverPetSlug = collection.coverPetSlug;
  if (petsChanged) {
    const requestedCover = normalizeCollectionCover(body.coverPetSlug);
    if (requestedCover === false)
      return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
    if (requestedCover !== null && !pets?.includes(requestedCover))
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    coverPetSlug = requestedCover ?? pets?.[0] ?? null;
  } else if (body.coverPetSlug !== undefined) {
    const requestedCover = normalizeCollectionCover(body.coverPetSlug);
    if (requestedCover === false)
      return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
    if (requestedCover !== null) {
      const items = await db
        .select({ slug: schema.petCollectionItems.petSlug })
        .from(schema.petCollectionItems)
        .where(eq(schema.petCollectionItems.collectionId, collection.id));
      if (!items.some((item) => item.slug === requestedCover))
        return NextResponse.json(
          { error: "cover_not_in_collection" },
          { status: 400 },
        );
    }
    coverPetSlug = requestedCover;
  }

  let externalUrl = collection.externalUrl;
  if (body.externalUrl !== undefined) {
    const normalizedExternalUrl = normalizeCollectionExternalUrl(
      body.externalUrl,
    );
    if (normalizedExternalUrl === false)
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    externalUrl = normalizedExternalUrl;
  }

  await db.transaction(async (tx) => {
    if (petsChanged) {
      await tx
        .delete(schema.petCollectionItems)
        .where(eq(schema.petCollectionItems.collectionId, collection.id));
      if (pets?.length)
        await tx.insert(schema.petCollectionItems).values(
          pets.map((petSlug, position) => ({
            collectionId: collection.id,
            petSlug,
            position: position + 1,
          })),
        );
    }
    await tx
      .update(schema.petCollections)
      .set({
        title: input.title,
        description: input.description,
        ...(body.externalUrl !== undefined ? { externalUrl } : {}),
        ...(petsChanged || body.coverPetSlug !== undefined
          ? { coverPetSlug }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.petCollections.id, collection.id));
  });
  await revalidateCollectionTags(collection.slug);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const limit = await cliVerifyRatelimit.limit(clientIp(req));
  if (!limit.success)
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: reference } = await ctx.params;
  const collection = await findOwnedCollection(reference, principal.userId);
  if (!collection)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (collection.featured)
    return NextResponse.json(
      { error: "featured_not_deletable" },
      { status: 403 },
    );
  await db
    .delete(schema.petCollections)
    .where(eq(schema.petCollections.id, collection.id));
  await revalidateCollectionTags(collection.slug);
  return NextResponse.json({ ok: true });
}
