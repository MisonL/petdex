import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";

import { db, executeAtomicReturning, schema } from "@/lib/db/client";
import { withdrawRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await withdrawRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  const { id } = await ctx.params;

  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.id, id),
      eq(schema.submittedPets.ownerId, userId),
    ),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "only_pending_can_be_withdrawn" },
      { status: 400 },
    );
  }

  // Two statements, kept separate on purpose (executeAtomicReturning):
  // reviews used to vanish via an ON DELETE cascade that `drizzle-kit push`
  // has since dropped from the live database, so the delete has to take them
  // itself — a plain DELETE left review rows pointing at a pet that no longer
  // existed. Written as its own statement, not a CTE, because a CTE's DELETE
  // cannot see its sibling's snapshot anyway; see executeAtomicReturning.
  await executeAtomicReturning([
    sql`DELETE FROM "submission_reviews" WHERE "submitted_pet_id" = ${id}`,
    sql`DELETE FROM "submitted_pets" WHERE "id" = ${id}`,
  ]);

  return NextResponse.json({ ok: true });
}
