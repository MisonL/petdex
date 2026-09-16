import { NextResponse } from "next/server";

import { and, eq, or, sql } from "drizzle-orm";

import { verifyCliBearer } from "@/lib/cli-auth";
import {
  collectionApprovedPetsCondition,
  collectionMutationStatusQuery,
  deleteCollectionItemsQuery,
  hasCollectionMutationRow,
  insertCollectionItemsQuery,
  parseCollectionMutationStatus,
  runCollectionMutation,
} from "@/lib/collection-access";
import {
  type CollectionRequestBody,
  isCollectionRequestBody,
  MAX_COLLECTION_PETS,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
} from "@/lib/collection-input";
import { collectionCoverForPetSlugsQuery } from "@/lib/collection-sql";
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
    if (pets.length > MAX_COLLECTION_PETS)
      return NextResponse.json(
        { error: "collection_pet_limit", max: MAX_COLLECTION_PETS },
        { status: 400 },
      );
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
    coverPetSlug =
      requestedCover ??
      (body.coverPetSlug === undefined &&
      collection.coverPetSlug !== null &&
      pets?.includes(collection.coverPetSlug)
        ? collection.coverPetSlug
        : null) ??
      pets?.[0] ??
      null;
  } else if (body.coverPetSlug !== undefined) {
    const requestedCover = normalizeCollectionCover(body.coverPetSlug);
    if (requestedCover === false)
      return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
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

  // Keep omitted optional fields out of the write so concurrent partial PATCH
  // requests cannot replay a stale snapshot over another field's update.
  const updateSet = {
    ...(body.title !== undefined ? { title: input.title } : {}),
    ...(body.description !== undefined
      ? { description: input.description }
      : {}),
    ...(body.externalUrl !== undefined ? { externalUrl } : {}),
    ...(petsChanged || body.coverPetSlug !== undefined
      ? {
          coverPetSlug:
            petsChanged && body.coverPetSlug === undefined
              ? collectionCoverForPetSlugsQuery(pets ?? [])
              : coverPetSlug,
        }
      : {}),
    updatedAt: new Date(),
  };
  const coverValidationRequired =
    !petsChanged && body.coverPetSlug !== undefined && coverPetSlug !== null;
  const mutationPetSlugs = petsChanged
    ? (pets ?? [])
    : coverValidationRequired
      ? [coverPetSlug as string]
      : undefined;
  const updateBaseWhere = and(
    eq(schema.petCollections.id, collection.id),
    eq(schema.petCollections.ownerId, principal.userId),
    eq(schema.petCollections.featured, false),
  );
  const petAuthorization = mutationPetSlugs
    ? collectionApprovedPetsCondition(principal.userId, mutationPetSlugs)
    : sql`TRUE`;
  const updateWhere = coverValidationRequired
    ? and(
        updateBaseWhere,
        petAuthorization,
        sql`EXISTS (
          SELECT 1
          FROM "pet_collection_items"
          WHERE "collection_id" = ${collection.id}
            AND "pet_slug" = ${coverPetSlug}
        )`,
      )
    : and(updateBaseWhere, petAuthorization);
  const mutationStatusCheck =
    mutationPetSlugs || coverValidationRequired
      ? collectionMutationStatusQuery({
          collectionId: collection.id,
          ownerId: principal.userId,
          petAuthorization,
          ...(coverValidationRequired
            ? { coverPetSlug: coverPetSlug as string }
            : {}),
        })
      : null;
  const deletedItems = petsChanged
    ? deleteCollectionItemsQuery(collection.id, principal.userId, pets ?? [], {
        requireSuccessfulParentUpdate: true,
      })
    : null;
  const insertedItems = petsChanged
    ? insertCollectionItemsQuery(collection.id, pets ?? [], principal.userId, {
        requireSuccessfulParentUpdate: true,
      })
    : null;
  const mutation = await runCollectionMutation({
    collectionId: collection.id,
    petMutation: mutationPetSlugs
      ? { ownerId: principal.userId, petSlugs: mutationPetSlugs }
      : undefined,
    buildBatch: (client) => [
      client
        .update(schema.petCollections)
        .set(updateSet)
        .where(updateWhere)
        .returning({ id: schema.petCollections.id }),
      ...(deletedItems ? [client.execute(deletedItems)] : []),
      ...(insertedItems ? [client.execute(insertedItems)] : []),
      ...(mutationStatusCheck ? [client.execute(mutationStatusCheck)] : []),
    ],
    runTransaction: async (tx) => {
      const updatedRows = await tx
        .update(schema.petCollections)
        .set(updateSet)
        .where(updateWhere)
        .returning({ id: schema.petCollections.id });
      if (updatedRows.length > 0) {
        if (deletedItems) await tx.execute(deletedItems);
        if (insertedItems) await tx.execute(insertedItems);
        return {
          updated: true,
          collectionExists: true,
          petsValid: true,
          coverExists: true,
        };
      }
      if (mutationStatusCheck) {
        const status = parseCollectionMutationStatus(
          await tx.execute(mutationStatusCheck),
        );
        return { updated: false, ...status };
      }
      return {
        updated: false,
        collectionExists: false,
        petsValid: true,
        coverExists: true,
      };
    },
    parseBatch: (results) => {
      const updateResult = results[0];
      const updated = hasCollectionMutationRow(updateResult);
      if (!mutationStatusCheck) {
        return {
          updated,
          collectionExists: updated,
          petsValid: true,
          coverExists: true,
        };
      }
      const status = parseCollectionMutationStatus(results[results.length - 1]);
      return {
        updated,
        ...status,
      };
    },
  });
  if (!mutation.updated) {
    if (!mutation.collectionExists) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!mutation.petsValid) {
      return NextResponse.json(
        { error: "pet_not_owned_or_approved" },
        { status: 422 },
      );
    }
    if (coverValidationRequired && !mutation.coverExists) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
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
  const deleted = await runCollectionMutation({
    collectionId: collection.id,
    lockExistingPetSlugs: true,
    buildBatch: (client) => [
      client
        .delete(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, collection.id),
            eq(schema.petCollections.ownerId, principal.userId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .returning({ id: schema.petCollections.id }),
    ],
    runTransaction: async (tx) => {
      const deletedRows = await tx
        .delete(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, collection.id),
            eq(schema.petCollections.ownerId, principal.userId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .returning({ id: schema.petCollections.id });
      return deletedRows.length > 0;
    },
    parseBatch: (results) => hasCollectionMutationRow(results[0]),
  });
  if (!deleted)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  await revalidateCollectionTags(collection.slug);
  return NextResponse.json({ ok: true });
}
