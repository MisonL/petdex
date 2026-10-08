import type { CreateEmailOptions, Resend } from "resend";

/**
 * Send a transactional email and record a failure instead of dropping it.
 *
 * Resend's SDK **resolves** on HTTP 4xx/5xx — it answers with
 * `{ data: null, error }` rather than rejecting (`node_modules/resend/dist`).
 * Every call site here wrapped `await resend.emails.send(...)` in
 * `try { … } catch { /* silent *\/ }`, so a rejected From domain, an exhausted
 * quota, or a rate limit discarded the mail with no log line at all and the
 * caller still believed it had sent. The return value is the only place the
 * failure is visible, so it is checked here.
 *
 * Email stays best-effort — a send failure must not fail the request that
 * triggered it — but it is no longer invisible.
 */
export async function sendEmail(
  resend: Resend,
  payload: CreateEmailOptions,
  label: string,
): Promise<void> {
  try {
    const { error } = await resend.emails.send(payload);
    if (error) {
      console.error(`[email] ${label} was rejected:`, error);
    }
  } catch (thrown) {
    // Defensive: the SDK should not throw, but a network stack or a bad
    // payload could, and that path used to be swallowed too.
    console.error(
      `[email] ${label} threw:`,
      thrown instanceof Error ? thrown.message : String(thrown),
    );
  }
}
