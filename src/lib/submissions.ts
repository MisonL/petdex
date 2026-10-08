// Shared core for all submission paths (web /api/submit, CLI /api/cli/submit).
//
// Inputs that determine identity (userId, ownerEmail, creditName/Url/Image)
// MUST come from a verified caller (Clerk session for web, OAuth bearer for
// CLI) — never from request body — so this module accepts them as `principal`.

import "server-only";

import { eq } from "drizzle-orm";
import { Resend } from "resend";

import { db, schema } from "@/lib/db/client";
import type { SubmissionReview, SubmittedPet } from "@/lib/db/schema";
import { renderNewSubmissionEmail } from "@/lib/email-templates/new-submission";
import { fallbackHandle, handleForUser } from "@/lib/handles";
import { normalizeSpriteVersionNumber } from "@/lib/sprite-version";
import {
  deriveSlug,
  type SubmissionInput,
  slugify as slugifySubmission,
} from "@/lib/submissions-validation";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

export type {
  PetLicenseChoice,
  SubmissionInput,
} from "@/lib/submissions-validation";
export {
  COMMERCIAL_PET_LICENSES,
  deriveSlug,
  isPetLicenseChoice,
  MIN_SPRITE_DIM,
  PET_LICENSE_CHOICES,
  REQUIRED_FIELDS,
  validateSubmission,
} from "@/lib/submissions-validation";

const SUBMISSION_REVIEW_TIMEOUT_MS = 30_000;

export const slugify = slugifySubmission;

export type SubmissionPrincipal = {
  userId: string;
  email: string | null;
  username: string | null;
  imageUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Pre-computed external profile URL (X or GitHub) when available. */
  url?: string | null;
};

export type SubmissionReviewOutcome = {
  decision: "approved" | "rejected" | "hold";
  applied: boolean;
  reasonCode: string | null;
  summary: string | null;
};

export type SubmissionResult =
  | {
      ok: true;
      id: string;
      slug: string;
      status: SubmittedPet["status"];
      profileHandle: string;
      profileUrl: string;
      review: SubmissionReviewOutcome;
    }
  | {
      ok: false;
      status: number;
      error: string;
      message?: string;
      field?: string;
      got?: unknown;
    };

/** Persist a submission. Caller is responsible for authn/ratelimit.
 *  Slug collisions get suffixed (boba -> boba-2) by resolveUniqueSlug.
 *  Re-claiming pets from a deleted account uses an opt-in flow at
 *  /my-pets, not silent transfer at submit time. */
export async function persistSubmission(
  body: SubmissionInput,
  principal: SubmissionPrincipal,
): Promise<SubmissionResult> {
  const requestedSlug = deriveSlug(body.petId, body.displayName);
  if (!requestedSlug) {
    return { ok: false, status: 400, error: "invalid_slug" };
  }

  const profileHandlePromise = handleForUser(principal.userId).catch(() =>
    fallbackHandle(principal.userId),
  );

  const id = `pet_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const credit = creditFromPrincipal(principal);
  const spriteVersion = normalizeSpriteVersionNumber(body.spriteVersionNumber);

  const slug = await insertSubmissionWithUniqueSlug({
    id,
    requestedSlug,
    values: {
      displayName: body.displayName.trim().slice(0, 60),
      description: body.description.trim().slice(0, 280),
      spritesheetUrl: body.spritesheetUrl,
      petJsonUrl: body.petJsonUrl,
      zipUrl: body.zipUrl,
      spriteVersionNumber: spriteVersion.ok ? spriteVersion.version : 1,
      kind: "creature",
      vibes: [],
      tags: [],
      status: "pending",
      ownerId: principal.userId,
      ownerEmail: principal.email,
      creditName: credit.name,
      creditUrl: credit.url,
      creditImage: credit.imageUrl,
      license: body.license ?? "unspecified",
      licenseDeclaredAt: body.license ? new Date() : null,
    },
  });

  // Fire-and-forget admin notification.
  const resendKey = process.env.RESEND_API_KEY;
  const ownerNotify = process.env.PETDEX_OWNER_EMAIL;
  if (resendKey && ownerNotify) {
    void (async () => {
      try {
        const resend = new Resend(resendKey);
        const locale = await getPreferredLocaleForUser(null);
        const email = renderNewSubmissionEmail(locale, {
          displayName: body.displayName,
          slug,
          from: principal.email ?? principal.userId,
          description: body.description,
          spritesheetUrl: body.spritesheetUrl,
          zipUrl: body.zipUrl,
        });
        // The subject is header-safe by construction: the template runs
        // `sanitizeSubject` over the interpolated name. The previous defense
        // here — `subject.replace(displayName, safeName)` — was bypassable,
        // because a replacement string expands `$&` and a name containing it
        // re-inserted the matched CRLF.
        await resend.emails.send({
          from: "Petdex <petdex@notifications.crafter.run>",
          to: ownerNotify,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } catch {
        /* silent */
      }
    })();
  }

  const review = await reviewNewSubmission(id);
  const current = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, id),
  });
  const status = current?.status ?? "pending";
  const profileHandle = await profileHandlePromise;

  return {
    ok: true,
    id,
    slug,
    status,
    profileHandle,
    profileUrl: `/u/${encodeURIComponent(profileHandle)}`,
    review: alignReviewWithStatus(review, status),
  };
}

export function creditFromPrincipal(p: SubmissionPrincipal): {
  name: string | null;
  url: string | null;
  imageUrl: string | null;
} {
  const username = p.username?.trim() || null;
  const first = p.firstName?.trim() || null;
  const last = p.lastName?.trim() || null;
  const emailPrefix = p.email?.includes("@") ? p.email.split("@")[0] : null;
  const name =
    username ??
    (first ? `${first}${last ? ` ${last[0]}.` : ""}` : null) ??
    emailPrefix ??
    "anonymous";

  return {
    name,
    url: p.url ?? null,
    imageUrl: p.imageUrl ?? null,
  };
}

export async function resolveUniqueSlug(base: string): Promise<string> {
  const isTaken = async (candidate: string): Promise<boolean> => {
    const row = await db.query.submittedPets.findFirst({
      where: eq(schema.submittedPets.slug, candidate),
    });
    return Boolean(row);
  };

  if (!(await isTaken(base))) return base;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`.slice(0, 40);
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base.slice(0, 32)}-${crypto.randomUUID().slice(0, 6)}`;
}

/**
 * Whether an insert error is the slug unique-constraint violation.
 *
 * The check-then-insert in `resolveUniqueSlug` is a TOCTOU: two concurrent
 * submissions can derive the same slug and both pass `isTaken`, and the
 * later INSERT then died as an uncaught 23505 — a 500 for the user, after the
 * request had already consumed a rate-limit slot. `submitted_pets_slug_unique`
 * is the only unique index the insert can hit, so any 23505 here is the slug.
 */
function isSlugUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "23505";
}

/**
 * Insert the row, re-resolving the slug on a concurrent collision. Bounded:
 * after a few losses to other submissions the random-suffix fallback in
 * `resolveUniqueSlug` makes another collision vanishingly unlikely.
 */
async function insertSubmissionWithUniqueSlug(input: {
  id: string;
  requestedSlug: string;
  values: Omit<typeof schema.submittedPets.$inferInsert, "id" | "slug">;
}): Promise<string> {
  let slug = await resolveUniqueSlug(input.requestedSlug);
  for (let attempt = 0; ; attempt++) {
    try {
      await db.insert(schema.submittedPets).values({
        ...input.values,
        id: input.id,
        slug,
      });
      return slug;
    } catch (error) {
      if (!isSlugUniqueViolation(error) || attempt >= 4) throw error;
      slug = await resolveUniqueSlug(input.requestedSlug);
    }
  }
}

async function reviewNewSubmission(
  id: string,
): Promise<SubmissionReviewOutcome> {
  const reviewModule = await import("@/lib/submission-review");

  const reviewPromise = reviewModule.reviewSubmission(id).catch((error) => {
    console.warn(
      "[submission] automated review failed:",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  });

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), SUBMISSION_REVIEW_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([reviewPromise, timeout]);
    if (result === "timeout") {
      void reviewPromise.catch(() => {});
      const hold = await reviewModule.recordSubmissionReviewHold(id, {
        reasonCode: "review_timeout",
        summary: "Automated review timed out and needs manual review.",
        error: `Timed out after ${SUBMISSION_REVIEW_TIMEOUT_MS}ms`,
      });
      return normalizeReviewOutcome(hold.review, hold.applied);
    }
    return normalizeReviewOutcome(result.review, result.applied);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hold = await reviewModule.recordSubmissionReviewHold(id, {
      reasonCode: "review_error",
      summary: "Automated review failed and needs manual review.",
      error: message,
    });
    return normalizeReviewOutcome(hold.review, hold.applied);
  }
}

function normalizeReviewOutcome(
  review: SubmissionReview,
  applied: boolean,
): SubmissionReviewOutcome {
  const decision =
    review.decision === "auto_approve" && applied
      ? "approved"
      : review.decision === "auto_reject" && applied
        ? "rejected"
        : "hold";
  return {
    decision,
    applied,
    reasonCode: review.reasonCode,
    summary: review.summary,
  };
}

function alignReviewWithStatus(
  review: SubmissionReviewOutcome,
  status: SubmittedPet["status"],
): SubmissionReviewOutcome {
  if (status === "approved") {
    return { ...review, decision: "approved", applied: true };
  }
  if (status === "rejected") {
    return { ...review, decision: "rejected", applied: true };
  }
  return review;
}
