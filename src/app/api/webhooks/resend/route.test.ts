// The resend webhook is public and unauthenticated by definition — the svix
// signature is verified against the raw body, so the body must be read before
// the caller is trusted. It used to `req.text()` whatever arrived, letting an
// anonymous POST pick the process's buffer size. These tests pin the ceiling
// and the signature paths around it.
import { afterAll, describe, expect, it, mock } from "bun:test";

mock.module("@/lib/db/client", () => ({
  db: {},
  schema: {},
  // Named because mock.module is process-wide and first-registration-wins:
  // src/lib/db-client-mock-shape.test.ts asserts every factory provides them.
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { POST } = await import("@/app/api/webhooks/resend/route");

// A structurally valid svix secret, so `new Webhook(secret)` succeeds and the
// tests below exercise real verification rather than the constructor throw.
const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
const originalSecret = process.env.RESEND_WEBHOOK_SECRET;

afterAll(() => {
  if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = originalSecret;
});

function post(
  body: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

describe("POST /api/webhooks/resend", () => {
  it("fails closed when the webhook secret is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await post("{}", {
      "svix-id": "msg_1",
      "svix-timestamp": "1700000000",
      "svix-signature": "v1,abc",
    });
    expect(res.status).toBe(500);
  });

  it("refuses an oversized body with 413", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    // A concrete body sets content-length, so the route can refuse from the
    // declared size alone — no buffering, no signature work.
    const res = await post(new Uint8Array(300 * 1024), {
      "svix-id": "msg_1",
      "svix-timestamp": "1700000000",
      "svix-signature": "v1,abc",
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe(
      "payload_too_large",
    );
  });

  it("still rejects a signed-but-wrong small body with 400", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const res = await post('{"type":"email.sent"}', {
      "svix-id": "msg_1",
      "svix-timestamp": "1700000000",
      "svix-signature": "v1,AAAA",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "signature_invalid",
    );
  });

  it("requires the svix headers before anything else", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const res = await post("{}");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "signature_missing",
    );
  });
});
