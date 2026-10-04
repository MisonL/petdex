// CSRF defense: every state-changing endpoint should accept requests only
// from our own origin. Without this, a malicious page on attacker.com can
// fire a POST with the visitor's Clerk cookie attached and write to our
// DB on their behalf (likes, withdrawals, claims, feedback).
//
// Strategy: check the Origin header (modern browsers always set it on
// cross-origin POST/PUT/DELETE). If Origin is present and not on our
// allowlist, reject. If Origin is missing (some same-origin clients
// like server-to-server fetch don't send it), we fall back to checking
// Sec-Fetch-Site, which is set by all modern browsers.
//
// Allow same-origin, the canonical site URL, the Vercel URL of the running
// deployment (preview or production), and localhost for local dev.

const SITE_HOSTS = new Set<string>([
  "petdex.dev",
  "localhost:3000",
  "localhost",
]);

/**
 * The `*.vercel.app` hosts this deployment answers on, as exact hosts.
 *
 * A bare `host.endsWith(".vercel.app")` check was here, and it defeated the
 * point of the module: `vercel.app` is a public suffix anyone can deploy
 * under, so `https://evil.vercel.app` passed the origin check and could POST
 * to every `requireSameOrigin` endpoint with the visitor's Clerk cookie —
 * the exact cross-site write this file exists to stop. Vercel sets these
 * three env vars on the deployment itself, so the real hosts are known and
 * a suffix match is not needed.
 */
function vercelHosts(): string[] {
  return [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.split("/")[0]);
}

export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (SITE_HOSTS.has(host)) return true;
    return vercelHosts().includes(host);
  }
  // No Origin header. Use Sec-Fetch-Site as a fallback.
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs === "same-origin" || sfs === "same-site" || sfs === "none") {
    return true;
  }
  // No Origin and no Sec-Fetch-Site: this is most likely a non-browser
  // client (curl, server fetch). We let it through here — those callers
  // authenticate by other means (bearer token for CLI) and the auth
  // gate elsewhere already covers them.
  if (!sfs) return true;
  return false;
}

export function requireSameOrigin(req: Request): Response | null {
  if (!isSameOrigin(req)) {
    return new Response(JSON.stringify({ error: "csrf_blocked" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
