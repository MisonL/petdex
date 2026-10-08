import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sendEmail } from "./email-send";

// Resend's SDK does NOT reject on HTTP 4xx/5xx — it resolves with
// `{ data: null, error }`. Every caller used to write
// `try { await resend.emails.send(…) } catch { /* silent */ }`, so a rejected
// From domain or an exhausted quota dropped the mail with no log at all. These
// tests pin both halves: the helper surfaces the resolved error, and no app
// sender goes back to calling `emails.send` directly.

type Sent = { error?: unknown } | { data: unknown };

function fakeResend(result: Sent | (() => Promise<Sent>)) {
  return {
    emails: {
      send: async () =>
        typeof result === "function" ? await result() : result,
    },
  } as never;
}

const PAYLOAD = {
  from: "Petdex <petdex@updates.railly.dev>",
  to: "user@example.com",
  subject: "hi",
  html: "<p>hi</p>",
  text: "hi",
};

describe("sendEmail", () => {
  let logged: unknown[][];
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    errorSpy?.mockRestore();
  });

  function capture() {
    logged = [];
    errorSpy = spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });
  }

  it("logs a resolved error that the old try/catch never saw", async () => {
    capture();
    await sendEmail(
      fakeResend({ error: { name: "validation_error", message: "bad from" } }),
      PAYLOAD,
      "test notice",
    );
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain("test notice");
    expect(String(logged[0][0])).toContain("rejected");
  });

  it("logs a thrown send instead of swallowing it", async () => {
    capture();
    await sendEmail(
      fakeResend(() => Promise.reject(new Error("socket hang up"))),
      PAYLOAD,
      "test notice",
    );
    expect(logged).toHaveLength(1);
    expect(logged[0].map(String).join(" ")).toContain("socket hang up");
  });

  it("stays quiet on success", async () => {
    capture();
    await sendEmail(fakeResend({ data: { id: "abc" } }), PAYLOAD, "test");
    expect(logged).toHaveLength(0);
  });
});

describe("app senders go through sendEmail", () => {
  // The four request-path senders. A direct `resend.emails.send(` in any of
  // them reintroduces the silent-drop bug this helper exists to close.
  const SENDERS = ["submissions.ts", "submission-decisions.ts", "takedown.ts"];
  const REPLIES = join(
    import.meta.dir,
    "..",
    "app",
    "api",
    "feedback",
    "[id]",
    "replies",
    "route.ts",
  );

  it("no lib sender calls emails.send directly", () => {
    for (const file of SENDERS) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source, file).not.toContain("emails.send(");
      expect(source, file).toContain("sendEmail(");
    }
  });

  it("the feedback replies route calls emails.send only via sendEmail", () => {
    const source = readFileSync(REPLIES, "utf8");
    expect(source).not.toContain("emails.send(");
    expect(source).toContain("sendEmail(");
  });
});
