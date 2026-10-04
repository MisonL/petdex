import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";

import { db, rowsOf, schema } from "@/lib/db/client";
import { setLikeCount } from "@/lib/db/metrics";
import { likeRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

type Params = { slug: string };
type PostBody = { liked?: boolean };

export async function POST(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }

  const lim = await likeRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: PRIVATE_HEADERS },
    );
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json(
      { error: "invalid_slug" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
    columns: { slug: true, status: true },
  });
  if (!pet || pet.status !== "approved") {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }

  // An absent `liked` is the toggle default, but a body that does not parse is
  // a client error rather than an instruction to flip the user's state — the
  // old code folded both into `null`, so `{` and `{"liked":"yes"}` silently
  // toggled a like instead of being refused.
  let desiredLiked: boolean | null = null;
  const rawBody = await req.text();
  if (rawBody.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "invalid_json" },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return NextResponse.json(
        { error: "invalid_json" },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    const liked = (parsed as PostBody).liked;
    if (liked !== undefined && typeof liked !== "boolean") {
      return NextResponse.json(
        { error: "invalid_liked", message: "`liked` must be a boolean." },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    desiredLiked = typeof liked === "boolean" ? liked : null;
  }

  // Every branch answers from what the write did, never from a read taken
  // before it. The previous version read `existing` once and then echoed
  // `desiredLiked` back for an explicit request, so two requests that arrived
  // together — a double-click, a retry, two tabs — could both see the row
  // missing, one would insert it, and the other would still be told `liked:
  // false` while the row sat in the table. Both explicit writes are
  // idempotent, so running them unconditionally makes the answer true by
  // construction: insert-then-report-true and delete-then-report-false are
  // each correct no matter what the other request did.
  let liked: boolean;
  if (desiredLiked === false) {
    await db
      .delete(schema.petLikes)
      .where(
        and(
          eq(schema.petLikes.userId, userId),
          eq(schema.petLikes.petSlug, slug),
        ),
      );
    liked = false;
  } else if (desiredLiked === true) {
    await db
      .insert(schema.petLikes)
      .values({ userId, petSlug: slug })
      .onConflictDoNothing({
        target: [schema.petLikes.userId, schema.petLikes.petSlug],
      });
    liked = true;
  } else {
    // No explicit target: flip whatever is there, in one statement — a read
    // followed by a write cannot be atomic here, and the delete's own result
    // is what decides whether the insert runs.
    //
    // `liked` is the delete's *outcome*, not the insert's: a row existed and
    // was removed means unliked, and no row existed means liked. Reading the
    // insert's RETURNING instead gets that backwards under concurrency. Two
    // requests can arrive together with the row absent; the second one's
    // DELETE cannot see the first's uncommitted INSERT, so `removed` is empty,
    // it inserts, and ON CONFLICT DO NOTHING swallows the duplicate — leaving
    // no RETURNING row, which the old shape reported as "unliked" while the
    // row was in fact present. Measured on Postgres, every concurrent round
    // had a caller report the wrong final state.
    const flipped = await db.execute(sql`
      WITH removed AS (
        DELETE FROM "pet_likes"
        WHERE "user_id" = ${userId} AND "pet_slug" = ${slug}
        RETURNING 1
      ),
      ins AS (
        INSERT INTO "pet_likes" ("user_id", "pet_slug")
        SELECT ${userId}, ${slug}
        WHERE NOT EXISTS (SELECT 1 FROM removed)
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*)::int FROM removed) = 0 AS "liked"
    `);
    liked =
      (rowsOf(flipped)[0] as { liked?: boolean } | undefined)?.liked === true;
  }

  // Recompute count to avoid drift
  const countRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.petLikes)
    .where(eq(schema.petLikes.petSlug, slug));
  const count = Number(countRow[0]?.c ?? 0);
  await setLikeCount(slug, count);

  return NextResponse.json(
    { ok: true, liked, count },
    { headers: PRIVATE_HEADERS },
  );
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { userId } = await auth();
  const { slug } = await ctx.params;

  const countRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.petLikes)
    .where(eq(schema.petLikes.petSlug, slug));
  const count = Number(countRow[0]?.c ?? 0);

  let liked = false;
  if (userId) {
    const row = await db.query.petLikes.findFirst({
      where: and(
        eq(schema.petLikes.userId, userId),
        eq(schema.petLikes.petSlug, slug),
      ),
    });
    liked = Boolean(row);
  }

  return NextResponse.json({ count, liked }, { headers: PRIVATE_HEADERS });
}
