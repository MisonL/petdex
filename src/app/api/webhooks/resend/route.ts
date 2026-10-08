import { NextResponse } from "next/server";

import { and, eq, sql } from "drizzle-orm";
import { Webhook } from "svix";

import { db, schema } from "@/lib/db/client";
import {
  contentLengthExceeds,
  PayloadTooLargeError,
  readBodyCapped,
} from "@/lib/request-body";

export const runtime = "nodejs";

// Delivery progresses queued → sent → delivered → opened; the terminal
// states sit above all of them so nothing regresses out of one either.
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  bounced: 4,
  complained: 4,
  failed: 4,
};

// Resend event payloads are a few KB; the signature is verified against the
// raw body, so the body has to be read before the caller is authenticated.
// Without a ceiling, an anonymous POST decides how much the process buffers.
const MAX_BODY_BYTES = 256 * 1024;

type ResendEventType =
  | "email.sent"
  | "email.delivered"
  | "email.opened"
  | "email.clicked"
  | "email.bounced"
  | "email.complained"
  | "email.delivery_delayed"
  | "email.failed";

type ResendWebhookPayload = {
  type: ResendEventType;
  created_at: string;
  data: {
    email_id?: string;
    [key: string]: unknown;
  };
};

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "resend_webhook_secret_missing" },
      { status: 500 },
    );
  }

  if (contentLengthExceeds(req, MAX_BODY_BYTES)) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "signature_missing" }, { status: 400 });
  }

  let body: string;
  try {
    body = await readBodyCapped(req.body, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    throw err;
  }
  let payload: ResendWebhookPayload;
  try {
    const wh = new Webhook(secret);
    payload = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ResendWebhookPayload;
  } catch {
    return NextResponse.json({ error: "signature_invalid" }, { status: 400 });
  }

  const resendId = payload.data?.email_id;
  if (!resendId) {
    return NextResponse.json({ ok: true });
  }

  const now = new Date();
  const updates: Partial<typeof schema.emailSends.$inferInsert> = {};

  switch (payload.type) {
    case "email.sent":
      updates.status = "sent";
      updates.sentAt = now;
      break;
    case "email.delivered":
      updates.status = "delivered";
      updates.deliveredAt = now;
      break;
    case "email.opened":
      updates.status = "opened";
      updates.openedAt = now;
      break;
    case "email.bounced":
      updates.status = "bounced";
      updates.bouncedAt = now;
      break;
    case "email.complained":
      updates.status = "complained";
      updates.complainedAt = now;
      break;
    case "email.failed":
      updates.status = "failed";
      updates.error =
        typeof payload.data.reason === "string" ? payload.data.reason : null;
      break;
    default:
      return NextResponse.json({ ok: true });
  }

  const target = updates.status;
  if (!target) {
    return NextResponse.json({ ok: true });
  }

  // Resend retries, and its events can arrive out of order — an `email.sent`
  // landing after `email.opened` used to overwrite the status and blank the
  // openedAt the earlier event had set. Only move the row forward: the CASE
  // ranks what is stored, and `< ` admits every real transition while
  // rejecting a repeat of the same event (so retries are idempotent without a
  // processed-ids table) and any walk backwards.
  await db
    .update(schema.emailSends)
    .set(updates)
    .where(
      and(
        eq(schema.emailSends.resendId, resendId),
        sql`case ${schema.emailSends.status}
              when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2
              when 'opened' then 3 else 4 end < ${STATUS_RANK[target]}`,
      ),
    );

  return NextResponse.json({ ok: true });
}
