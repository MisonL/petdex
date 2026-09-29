type HeaderBag =
  | Pick<Headers, "get">
  | Record<string, string | null | undefined>;

const BLOCKED_IPS = new Set(["133.106.50.116"]);
const BLOCKED_USER_AGENTS = ["petoverlaycompose-pixelartclassifier"];

export type PublicTrafficGuardRule = "catalog" | "metadata" | "state";

export function publicTrafficGuardRule(input: {
  method: string;
  pathname: string;
}): PublicTrafficGuardRule | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const pathname = input.pathname;
  // The sticker routes are redirects to R2 objects (thumb 308, sticker 307)
  // and wastickers is a constant 410, so none of them does work worth a Redis
  // round trip. They were the single largest share of guarded traffic, which
  // means the limiter spent most of its command budget guarding redirects.
  // Abuse of the underlying objects is bounded by R2 and the CDN, not here.
  // /api/manifest is a static 307 to the R2 object with a 300s CDN cache and
  // no database read, so rate limiting it spends a Redis round trip to guard
  // a redirect. It is also the single most requested path, which made it the
  // largest contributor to the command volume that got the Upstash database
  // blocked. Leave it out of the guard.
  if (pathname === "/api/pets/random") return "catalog";
  if (pathname === "/api/pets/search") return "catalog";
  if (pathname === "/api/me/header-state") return "state";
  if (pathname === "/api/og") return "metadata";
  if (pathname === "/api/wechat-qr") return "metadata";
  if (
    /^\/(?:en\/|es\/|zh\/)?(?:pets|collections|u)\/[^/]+\/opengraph-image\/?$/.test(
      pathname,
    )
  ) {
    return "metadata";
  }
  if (
    /^\/(?:en\/|es\/|zh\/)?(?:collections|download)\/opengraph-image\/?$/.test(
      pathname,
    )
  ) {
    return "metadata";
  }
  if (/^\/api\/pets\/[^/]+\/codex-theme\/?$/.test(pathname)) {
    return "catalog";
  }
  if (/^\/api\/pets\/[^/]+\/metrics\/?$/.test(pathname)) return "catalog";
  if (/^\/api\/pets\/[^/]+\/variants\/?$/.test(pathname)) return "catalog";
  if (/^\/api\/install-pet\/[^/]+\/?$/.test(pathname)) return "catalog";
  if (/^\/(?:en\/|es\/|zh\/)?install\/[^/]+\/?$/.test(pathname)) {
    return "catalog";
  }
  return null;
}

export function shouldBlockKnownAbusiveClient(
  headers: HeaderBag | undefined,
): boolean {
  const ip = publicTrafficGuardKey(headers);
  if (BLOCKED_IPS.has(ip)) return true;
  const userAgent = readHeader(headers, "user-agent").toLowerCase();
  return BLOCKED_USER_AGENTS.some((blocked) => userAgent.includes(blocked));
}

/**
 * Rate-limit key for a request.
 *
 * Both headers are trustworthy where this runs, and neither is elsewhere.
 * Vercel overwrites `x-forwarded-for` on every request and does not forward a
 * client-supplied value — "This restriction is in place to prevent IP
 * spoofing" — and `x-real-ip` is documented as carrying the same value. So on
 * the deployment this app targets, a caller cannot pick their own bucket.
 *
 * Off Vercel they can: behind no proxy, both headers arrive as sent, and
 * rotating them hands each request a fresh quota. That is a property of
 * running the app directly (`bun run dev`, the docker stack), not a defect to
 * paper over here — a limiter that ignored the headers would have no client
 * identity to key on at all. Anything that puts this app behind a different
 * proxy has to make that proxy set them the way Vercel does.
 */
export function publicTrafficGuardKey(headers: HeaderBag | undefined): string {
  const ip =
    readHeader(headers, "x-real-ip") ||
    readHeader(headers, "x-forwarded-for").split(",")[0]?.trim() ||
    "anon";
  return ip;
}

function readHeader(headers: HeaderBag | undefined, name: string): string {
  if (!headers) return "";
  if (typeof (headers as Pick<Headers, "get">).get === "function") {
    return (headers as Pick<Headers, "get">).get(name) ?? "";
  }
  const bag = headers as Record<string, string | null | undefined>;
  return bag[name] ?? bag[name.toLowerCase()] ?? bag[name.toUpperCase()] ?? "";
}
