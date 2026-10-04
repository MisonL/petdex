import { NextResponse } from "next/server";

import { SITE_URL } from "@/lib/locale-routing";
import { getRandomPetPool } from "@/lib/random-pet-pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANDOM_CACHE_CONTROL =
  "public, max-age=30, s-maxage=60, stale-while-revalidate=300";
const RANDOM_VARY = "Accept";

// Hosts a developer reaches the app on, allowed to redirect to themselves so
// `bun run dev:docker` shuffles locally. Every other host resolves to the
// canonical origin.
// `new URL(...).hostname` brackets an IPv6 literal, so the loopback address
// arrives as `[::1]` and a bare `"::1"` entry would never match. Listed in the
// form the parser actually produces.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin a redirect may point at.
 *
 * `new URL(path, req.url)` builds `Location` from the request's own host, so a
 * request carrying a forged `Host` gets a redirect to that host — an open
 * redirect for anyone who can reach the route with a header of their choosing.
 * `PETDEX_URL` is the app's configured public origin and is what the proxy
 * already resolves its own canonical redirects from; the loopback carve-out
 * keeps local development on the machine rather than bouncing to production.
 */
function redirectOrigin(req: Request): string {
  const configured = process.env.PETDEX_URL?.trim();
  if (configured) {
    try {
      // `.origin` is the string `"null"` — not a URL — for any scheme without
      // a host (data:, file:, javascript:), so accept it only when it is a
      // real origin. Otherwise `new URL("/pets/x", "null")` throws below and
      // every shuffle answers 500: a misconfigured value should degrade to the
      // canonical origin, not take the route down.
      const origin = new URL(configured).origin;
      if (origin !== "null") return origin;
    } catch {
      // A malformed value falls through to the checks below rather than
      // throwing on every shuffle.
    }
  }
  const { hostname, origin } = new URL(req.url);
  return LOOPBACK_HOSTS.has(hostname) ? origin : SITE_URL;
}

// GET /api/pets/random?exclude=current-slug
//
// Picks a random approved pet (excluding the optional `exclude` slug).
// Behaviour depends on the Accept header:
//   - Accept: application/json -> JSON `{ slug }` payload (used by the
//     keyboard shortcut so the client can router.push without an
//     opaque 302 redirect).
//   - default                  -> 302 to /pets/<slug> (used by the
//     plain <a href> shuffle pill so a click without JS still works).
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const exclude = url.searchParams.get("exclude") ?? "";
  const wantsJson = (req.headers.get("accept") ?? "").includes(
    "application/json",
  );

  const pool = await getRandomPetPool();
  const candidates = exclude
    ? pool.filter((pet) => pet.slug !== exclude)
    : pool;
  const next = candidates[Math.floor(Math.random() * candidates.length)];

  if (wantsJson) {
    if (!next) {
      // Same headers as the hit branch: the caller negotiated JSON, and the
      // `Vary: Accept` is what keeps a cache from answering a later 302
      // request with this empty-pool 404 (or the reverse) — the two branches
      // are the same URL with different content. An unlabelled 404 is also
      // the shape the CDN caches hardest.
      return NextResponse.json(
        { error: "no pets available" },
        {
          status: 404,
          headers: {
            "Cache-Control": RANDOM_CACHE_CONTROL,
            Vary: RANDOM_VARY,
          },
        },
      );
    }
    return NextResponse.json(
      {
        slug: next.slug,
        displayName: next.displayName,
        description: next.description,
        spritesheetPath: next.spritesheetPath,
        href: `/pets/${next.slug}`,
        installHref: `/install/${next.slug}`,
      },
      {
        headers: {
          "Cache-Control": RANDOM_CACHE_CONTROL,
          Vary: RANDOM_VARY,
        },
      },
    );
  }

  const origin = redirectOrigin(req);

  if (!next) {
    return NextResponse.redirect(new URL("/", origin), {
      status: 302,
      headers: { "Cache-Control": "private, no-store", Vary: RANDOM_VARY },
    });
  }
  return NextResponse.redirect(new URL(`/pets/${next.slug}`, origin), {
    status: 302,
    headers: { "Cache-Control": RANDOM_CACHE_CONTROL, Vary: RANDOM_VARY },
  });
}
