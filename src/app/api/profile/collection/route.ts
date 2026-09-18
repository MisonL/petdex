import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  canManageCreatorCollections,
  collectionApprovedPetsCondition,
  collectionMutationRows,
  collectionMutationStatusQuery,
  createOrReuseOwnerCollection,
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
  resolveCollectionCover,
} from "@/lib/collection-input";
import {
  collectionSlugBase,
  collectionSlugCandidates,
} from "@/lib/collection-slug";
import { collectionCoverForPetSlugsQuery } from "@/lib/collection-sql";
import { revalidateCollectionTags } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CollectionRow = typeof schema.petCollections.$inferSelect;

async function findCollectionAfterMutationLock(
  collectionId: string,
  ownerId: string,
): Promise<CollectionRow | null> {
  return runCollectionMutation<CollectionRow | null>({
    collectionId,
    buildBatch: (client) => [
      client
        .select()
        .from(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, collectionId),
            eq(schema.petCollections.ownerId, ownerId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .limit(1),
    ],
    runTransaction: async (tx) => {
      const rows = await tx
        .select()
        .from(schema.petCollections)
        .where(
          and(
            eq(schema.petCollections.id, collectionId),
            eq(schema.petCollections.ownerId, ownerId),
            eq(schema.petCollections.featured, false),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    parseBatch: (results) => {
      const rows = collectionMutationRows(results[0]);
      return (rows[0] as CollectionRow | undefined) ?? null;
    },
  });
}

export async function PATCH(req: Request): Promise<Response> {
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

  let [collection] = await db
    .select()
    .from(schema.petCollections)
    .where(
      and(
        eq(schema.petCollections.ownerId, userId),
        eq(schema.petCollections.featured, false),
      ),
    )
    .orderBy(
      asc(schema.petCollections.createdAt),
      asc(schema.petCollections.id),
    )
    .limit(1);

  let input: ReturnType<typeof normalizeCollectionInput>;
  try {
    input = normalizeCollectionInput({
      title: body.title === undefined ? (collection?.title ?? "") : body.title,
      description:
        body.description === undefined
          ? collection?.description
          : body.description,
      petSlugs: body.petSlugs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }

  let externalUrl = collection?.externalUrl ?? null;
  if (body.externalUrl !== undefined) {
    const normalizedExternalUrl = normalizeCollectionExternalUrl(
      body.externalUrl,
    );
    if (normalizedExternalUrl === false) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    externalUrl = normalizedExternalUrl;
  }

  const requestedCover = normalizeCollectionCover(body.coverPetSlug);
  if (requestedCover === false) {
    return NextResponse.json({ error: "invalid_cover_pet" }, { status: 400 });
  }
  if (
    body.title === undefined &&
    body.description === undefined &&
    body.externalUrl === undefined &&
    body.coverPetSlug === undefined &&
    body.petSlugs === undefined
  ) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  let petSlugs: string[];
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
    const allowedSlugs = new Set(approvedPets.map((pet) => pet.slug));
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
    petSlugs = input.petSlugs;
  } else if (collection) {
    const existingItems = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, collection.id))
      .orderBy(asc(schema.petCollectionItems.position));
    petSlugs = existingItems.map((item) => item.slug);
  } else {
    petSlugs = [];
  }
  if (requestedCover !== null && !petSlugs.includes(requestedCover)) {
    return NextResponse.json(
      { error: "cover_not_in_collection" },
      { status: 400 },
    );
  }
  let coverPetSlug: string | null =
    body.coverPetSlug === undefined
      ? (collection?.coverPetSlug ?? petSlugs[0] ?? null)
      : requestedCover;

  let collectionWasCreated = false;

  if (!collection) {
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, userId),
    });
    const requestedSlug = await collectionSlugForOwner(
      profile?.handle ?? input.title,
    );
    const id = `col_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = await createOrReuseOwnerCollection({
      id,
      slug: requestedSlug,
      title: input.title,
      description: input.description,
      ownerId: userId,
      externalUrl,
      coverPetSlug,
      petSlugs,
    });
    if (created.status === "slug_conflict") {
      return NextResponse.json(
        { error: "collection_slug_conflict" },
        { status: 409 },
      );
    }
    if (created.status === "pets_not_owned_or_approved") {
      return NextResponse.json(
        { error: "pet_not_owned_or_approved" },
        { status: 422 },
      );
    }
    if (created.status === "existing") {
      const existingCollection = await findCollectionAfterMutationLock(
        created.id,
        userId,
      );
      if (!existingCollection) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      collection = existingCollection;
      input = {
        title:
          body.title === undefined ? existingCollection.title : input.title,
        description:
          body.description === undefined
            ? existingCollection.description
            : input.description,
        petSlugs: input.petSlugs,
      };
      if (body.externalUrl === undefined) {
        externalUrl = existingCollection.externalUrl;
      }
      if (body.petSlugs === undefined) {
        const existingItems = await db
          .select({ slug: schema.petCollectionItems.petSlug })
          .from(schema.petCollectionItems)
          .where(eq(schema.petCollectionItems.collectionId, collection.id))
          .orderBy(asc(schema.petCollectionItems.position));
        petSlugs = existingItems.map((item) => item.slug);
        if (requestedCover !== null && !petSlugs.includes(requestedCover)) {
          return NextResponse.json(
            { error: "cover_not_in_collection" },
            { status: 400 },
          );
        }
        coverPetSlug =
          body.coverPetSlug === undefined
            ? collection.coverPetSlug
            : requestedCover;
      }
    } else {
      collection = {
        id,
        slug: created.slug,
        title: input.title,
        description: input.description,
        ownerId: userId,
        externalUrl,
        coverPetSlug,
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      collectionWasCreated = true;
    }
  }

  if (!collection) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!collectionWasCreated) {
    const petsChanged = body.petSlugs !== undefined;
    if (petsChanged && body.coverPetSlug === undefined) {
      coverPetSlug = resolveCollectionCover(
        null,
        petSlugs,
        collection.coverPetSlug,
        true,
      );
    } else if (!petsChanged && body.coverPetSlug === undefined) {
      coverPetSlug = collection.coverPetSlug;
    }
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
                ? collectionCoverForPetSlugsQuery(petSlugs)
                : coverPetSlug,
          }
        : {}),
      updatedAt: new Date(),
    };
    const coverValidationRequired =
      !petsChanged &&
      body.coverPetSlug !== undefined &&
      requestedCover !== null;
    const mutationPetSlugs = petsChanged
      ? petSlugs
      : coverValidationRequired
        ? [requestedCover as string]
        : undefined;
    const deletedItems = petsChanged
      ? deleteCollectionItemsQuery(collection.id, userId, petSlugs, {
          requireSuccessfulParentUpdate: true,
        })
      : null;
    const insertedItems = petsChanged
      ? insertCollectionItemsQuery(collection.id, petSlugs, userId, {
          requireSuccessfulParentUpdate: true,
        })
      : null;
    const updateWhere = and(
      eq(schema.petCollections.id, collection.id),
      eq(schema.petCollections.ownerId, userId),
      eq(schema.petCollections.featured, false),
    );
    const petAuthorization = mutationPetSlugs
      ? collectionApprovedPetsCondition(userId, mutationPetSlugs)
      : sql`TRUE`;
    const guardedUpdateWhere = coverValidationRequired
      ? and(
          updateWhere,
          petAuthorization,
          sql`EXISTS (
            SELECT 1
            FROM "pet_collection_items"
            WHERE "collection_id" = ${collection.id}
              AND "pet_slug" = ${requestedCover}
          )`,
        )
      : and(updateWhere, petAuthorization);
    const mutationStatusCheck =
      mutationPetSlugs || coverValidationRequired
        ? collectionMutationStatusQuery({
            collectionId: collection.id,
            ownerId: userId,
            petAuthorization,
            ...(coverValidationRequired
              ? { coverPetSlug: requestedCover as string }
              : {}),
          })
        : null;
    const mutation = await runCollectionMutation({
      collectionId: collection.id,
      petMutation: mutationPetSlugs
        ? { ownerId: userId, petSlugs: mutationPetSlugs }
        : undefined,
      buildBatch: (client) => [
        client
          .update(schema.petCollections)
          .set(updateSet)
          .where(guardedUpdateWhere)
          .returning({ id: schema.petCollections.id }),
        ...(deletedItems ? [client.execute(deletedItems)] : []),
        ...(insertedItems ? [client.execute(insertedItems)] : []),
        ...(mutationStatusCheck ? [client.execute(mutationStatusCheck)] : []),
      ],
      runTransaction: async (tx) => {
        const updatedRows = await tx
          .update(schema.petCollections)
          .set(updateSet)
          .where(guardedUpdateWhere)
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
        const updated = hasCollectionMutationRow(results[0]);
        if (!mutationStatusCheck) {
          return {
            updated,
            collectionExists: updated,
            petsValid: true,
            coverExists: true,
          };
        }
        const status = parseCollectionMutationStatus(
          results[results.length - 1],
        );
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
  }

  await revalidateCollectionTags(collection.slug);

  return NextResponse.json({
    ok: true,
    collection: {
      id: collection.id,
      slug: collection.slug,
      title: input.title,
      description: input.description,
      externalUrl,
      coverPetSlug,
      petSlugs,
    },
  });
}

async function collectionSlugForOwner(seed: string): Promise<string> {
  const base = collectionSlugBase(seed);
  for (const candidate of collectionSlugCandidates(base)) {
    const existing = await db.query.petCollections.findFirst({
      where: eq(schema.petCollections.slug, candidate),
    });
    if (!existing) return candidate;
  }
  return `collection-${crypto.randomUUID().replace(/-/g, "")}`;
}
