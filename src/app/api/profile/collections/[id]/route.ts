import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";

import {
  canManageCreatorCollections,
  collectionApprovedPetsCondition,
  collectionMutationStatusQuery,
  deleteCollectionItemsQuery,
  hasCollectionMutationRow,
  insertCollectionItemsQuery,
  parseCollectionMutationStatus,
  runCollectionMutation,
} from "@/lib/collection-access";
import { collectionPetLimitExceeded } from "@/lib/collection-constants";
import {
  type CollectionRequestBody,
  collectionInputErrorCode,
  isCollectionRequestBody,
  MAX_COLLECTION_PETS,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
  resolveCollectionCover,
} from "@/lib/collection-input";
import { collectionCoverForPetSlugsQuery } from "@/lib/collection-sql";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

// Edit one of the caller's personal collections. Featured/admin
// collections are NOT editable here even if owner_id matches — those
// are admin-curated.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await canManageCreatorCollections(userId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  const collection = await db.query.petCollections.findFirst({
    where: eq(schema.petCollections.id, id),
  });
  if (!collection || collection.ownerId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (collection.featured) {
    return NextResponse.json(
      { error: "featured_not_editable" },
      { status: 403 },
    );
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
      title: body.title === undefined ? collection.title : body.title,
      description:
        body.description === undefined
          ? collection.description
          : body.description,
      petSlugs: body.petSlugs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: collectionInputErrorCode(error) },
      { status: 400 },
    );
  }

  const patch: Partial<typeof schema.petCollections.$inferInsert> = {};

  if (body.title !== undefined) {
    patch.title = input.title;
  }

  if (body.description !== undefined) {
    patch.description = input.description;
  }

  if (body.externalUrl !== undefined) {
    const u = normalizeCollectionExternalUrl(body.externalUrl);
    if (u === false) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    patch.externalUrl = u;
  }

  const requestedCover = normalizeCollectionCover(body.coverPetSlug);
  if (requestedCover === false) {
    return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
  }

  let petSlugs: string[] | undefined;
  if (body.petSlugs !== undefined) {
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
    // The cap bounds growth, not the stored row. A collection created before
    // the cap existed can hold more than MAX_COLLECTION_PETS, and rejecting
    // that list would leave the row uneditable — not even a title fix — until
    // its owner deleted members. Over-cap is allowed while it adds nothing.
    const storedItems = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, id));
    if (
      collectionPetLimitExceeded(
        input.petSlugs,
        storedItems.map((item) => item.slug),
      )
    ) {
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
    // An empty list is never a legitimate intent — the editor disables save
    // with nothing selected — and it is destructive rather than a no-op:
    // deleteCollectionItemsQuery with an empty list emits a DELETE with no
    // pet_slug filter, so it removes every member. Refuse it instead of
    // reading it as "clear the collection".
    if (input.petSlugs.length === 0) {
      return NextResponse.json({ error: "empty_pet_slugs" }, { status: 400 });
    }
    petSlugs = input.petSlugs;
    if (requestedCover !== null && !petSlugs.includes(requestedCover)) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }
    patch.coverPetSlug = resolveCollectionCover(
      requestedCover,
      petSlugs,
      collection.coverPetSlug,
      body.coverPetSlug === undefined,
    );
  } else if (body.coverPetSlug !== undefined) {
    // Cover-only update — verify the slug is currently in the collection.
    const items = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, id));
    const set = new Set(items.map((r) => r.slug));
    if (requestedCover !== null && !set.has(requestedCover)) {
      return NextResponse.json(
        { error: "cover_not_in_collection" },
        { status: 400 },
      );
    }
    patch.coverPetSlug = requestedCover;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  patch.updatedAt = new Date();
  const updatePatch = {
    ...patch,
    ...(body.petSlugs !== undefined && body.coverPetSlug === undefined
      ? {
          coverPetSlug: collectionCoverForPetSlugsQuery(petSlugs ?? []),
        }
      : {}),
  };
  const coverValidationRequired =
    body.petSlugs === undefined &&
    body.coverPetSlug !== undefined &&
    requestedCover !== null;
  const mutationPetSlugs =
    body.petSlugs !== undefined
      ? (petSlugs ?? [])
      : coverValidationRequired
        ? [requestedCover as string]
        : undefined;
  const updateBaseWhere = and(
    eq(schema.petCollections.id, id),
    eq(schema.petCollections.ownerId, userId),
    eq(schema.petCollections.featured, false),
  );
  const petAuthorization = mutationPetSlugs
    ? collectionApprovedPetsCondition(userId, mutationPetSlugs)
    : sql`TRUE`;
  const updateWhere = coverValidationRequired
    ? and(
        updateBaseWhere,
        petAuthorization,
        sql`EXISTS (
          SELECT 1
          FROM "pet_collection_items"
          WHERE "collection_id" = ${id}
            AND "pet_slug" = ${requestedCover}
        )`,
      )
    : and(updateBaseWhere, petAuthorization);
  const mutationStatusCheck =
    mutationPetSlugs || coverValidationRequired
      ? collectionMutationStatusQuery({
          collectionId: id,
          ownerId: userId,
          petAuthorization,
          ...(coverValidationRequired
            ? { coverPetSlug: requestedCover as string }
            : {}),
        })
      : null;
  const deletedItems =
    body.petSlugs !== undefined
      ? deleteCollectionItemsQuery(id, userId, petSlugs ?? [], {
          requireSuccessfulParentUpdate: true,
        })
      : null;
  const insertedItems =
    body.petSlugs !== undefined
      ? insertCollectionItemsQuery(id, petSlugs ?? [], userId, {
          requireSuccessfulParentUpdate: true,
        })
      : null;
  // update(0) then the optional deletes/inserts, then the optional status
  // select last. Keep this expression next to the buildBatch that matches it.
  const statusResultIndex =
    1 + (deletedItems ? 1 : 0) + (insertedItems ? 1 : 0);
  const mutation = await runCollectionMutation({
    collectionId: id,
    petMutation: mutationPetSlugs
      ? { ownerId: userId, petSlugs: mutationPetSlugs }
      : undefined,
    buildBatch: (client) => [
      client
        .update(schema.petCollections)
        .set(updatePatch)
        .where(updateWhere)
        .returning({ id: schema.petCollections.id }),
      ...(deletedItems ? [client.execute(deletedItems)] : []),
      ...(insertedItems ? [client.execute(insertedItems)] : []),
      ...(mutationStatusCheck ? [client.execute(mutationStatusCheck)] : []),
    ],
    runTransaction: async (tx) => {
      const updatedRows = await tx
        .update(schema.petCollections)
        .set(updatePatch)
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
      // Derived from the same conditions that built the array above, so
      // appending a statement to buildBatch cannot silently move the status
      // row out from under this lookup.
      const status = parseCollectionMutationStatus(results[statusResultIndex]);
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

export async function DELETE(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const collection = await db.query.petCollections.findFirst({
    where: eq(schema.petCollections.id, id),
  });
  if (!collection || collection.ownerId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (collection.featured) {
    return NextResponse.json(
      { error: "featured_not_deletable" },
      { status: 403 },
    );
  }

  const deleted = await runCollectionMutation({
    collectionId: id,
    lockExistingPetSlugs: true,
    buildBatch: (client) => [
      client
        .delete(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, id),
            eq(schema.petCollections.ownerId, userId),
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
            eq(schema.petCollections.id, id),
            eq(schema.petCollections.ownerId, userId),
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
