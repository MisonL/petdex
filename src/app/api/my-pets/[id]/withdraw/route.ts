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
  // The pet delete repeats the owner condition the read above checked: a
  // concurrent claim can move ownerId between that read and this write.
  await executeAtomicReturning([
    sql`DELETE FROM "submission_reviews" WHERE "submitted_pet_id" = ${id}`,
    sql`DELETE FROM "submitted_pets" WHERE "id" = ${id} AND "owner_id" = ${userId}`,
  ]);

  // The row is gone, so nothing will ever reference these uploads again — but
  // the objects still sit in R2 and the submit-shaped keys (pets/<slug>-<id>/)
  // were not part of the pending-asset GC's net. Delete them best-effort: a
  // failed cleanup is a cost problem, not a correctness one, so it must not
  // turn a successful withdraw into an error.
  void (async () => {
    try {
      const [{ deleteR2Objects }, { keyFromR2PublicUrl }] = await Promise.all([
        import("@/lib/r2"),
        import("@/lib/r2-public-url"),
      ]);
      const keys = [row.spritesheetUrl, row.petJsonUrl, row.zipUrl]
        .map((url) => keyFromR2PublicUrl(url))
        .filter((key): key is string => Boolean(key));
      await deleteR2Objects(keys);
    } catch (error) {
      console.error("[withdraw] asset cleanup failed", { id, error });
    }
  })();

  return NextResponse.json({ ok: true });
}
