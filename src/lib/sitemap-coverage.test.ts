import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A page can be prerendered, linked from the header, and still be missing from
// the sitemap — and nothing catches it, because the sitemap is a hand-written
// list. `/download`, `/built-with`, and `/legal/telemetry` were each in that
// state: all three answer 200, all three declare `index, follow`, and none
// appeared in `sitemap.xml`. The first two are linked from the header nav, so
// crawlers found them anyway; `/legal/telemetry` is reached only from the CLI's
// telemetry notice, which is the case a sitemap exists to cover.
//
// The check below walks the locale route tree and asserts that every static
// page which is indexable is either listed in the sitemap or explicitly
// excused with a reason. Dynamic segments are skipped — those entries are
// generated from data, not written by hand.

const APP = join(import.meta.dir, "..", "app");
const LOCALE_DIR = join(APP, "[locale]");
const SITEMAP = join(APP, "sitemap.ts");

// Pages that are indexable but deliberately not advertised. Each needs a
// reason, so that adding one is a decision rather than an omission.
const EXCUSED = new Set<string>([
  // Account-scoped or auth-gated shells: reachable, but nothing to index.
  "my-pets",
  "my-feedback",
  "unsubscribe",
  "u",
]);

// Routes whose `index: false` is a conditional branch rather than a permanent
// declaration: each calls `notFound()` when its env var is unset, so it is
// indexable in the deployment that sets it and absent in the one that does
// not — one page, two states, and the sitemap has to follow the same switch.
//
// A plain scan for `index: false` cannot see the difference and reads these as
// never-indexable, which is how `/community` stayed out of `sitemap.xml` while
// production served it 200 with `index, follow`. Listed here instead of
// tolerated by a looser regex, so the gate is reviewable and paired with the
// assertion below.
const CONDITIONALLY_INDEXABLE: Record<string, string> = {
  community: "NEXT_PUBLIC_DISCORD_INVITE_URL",
};

/** Top-level locale routes with a `page.tsx`, excluding dynamic segments. */
function staticPageRoutes(): string[] {
  return readdirSync(LOCALE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("["))
    .map((entry) => entry.name)
    .filter((name) =>
      readdirSync(join(LOCALE_DIR, name), { withFileTypes: true }).some(
        (child) => child.isFile() && child.name === "page.tsx",
      ),
    );
}

/** True when the page does not opt out of indexing. */
function isIndexable(route: string): boolean {
  if (route in CONDITIONALLY_INDEXABLE) return true;
  const source = readFileSync(join(LOCALE_DIR, route, "page.tsx"), "utf8");
  return !/robots:\s*\{[^}]*index:\s*false/.test(source);
}

/** Routes nested one level deeper (legal/*, kind/*, …). */
function nestedStaticRoutes(): string[] {
  return readdirSync(LOCALE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("["))
    .flatMap((entry) =>
      readdirSync(join(LOCALE_DIR, entry.name), { withFileTypes: true })
        .filter((child) => child.isDirectory() && !child.name.startsWith("["))
        .filter((child) =>
          readdirSync(join(LOCALE_DIR, entry.name, child.name)).includes(
            "page.tsx",
          ),
        )
        .map((child) => `${entry.name}/${child.name}`),
    );
}

describe("every indexable static page is in the sitemap", () => {
  const sitemap = readFileSync(SITEMAP, "utf8");

  const routes = [...staticPageRoutes(), ...nestedStaticRoutes()].filter(
    (route) => !EXCUSED.has(route),
  );

  test("the route scan found pages", () => {
    expect(routes.length).toBeGreaterThan(8);
  });

  for (const route of routes) {
    if (!isIndexable(route)) continue;
    test(`/${route} is listed or excused`, () => {
      expect(
        sitemap.includes(`pathname: "/${route}"`),
        `/${route} is prerendered and declares index, follow but is not in ` +
          "sitemap.ts, so the only way a crawler finds it is by following a " +
          "link. Add it to `staticEntries`, or add it to the guard's " +
          "EXCUSED set with a reason.",
      ).toBe(true);
    });
  }

  // The sitemap and the page have to switch on the same variable, or the
  // deployment that makes the page indexable is the deployment that keeps it
  // unlisted — which is the state `/community` was in.
  for (const [route, envVar] of Object.entries(CONDITIONALLY_INDEXABLE)) {
    test(`/${route} is listed on the same condition the page gates on`, () => {
      expect(
        readFileSync(join(LOCALE_DIR, route, "page.tsx"), "utf8"),
        `/${route} is listed as conditionally indexable on ${envVar}, so its ` +
          "page has to read that variable; otherwise the pairing is a note " +
          "about a value nothing checks.",
      ).toContain(envVar);
      expect(
        sitemap,
        `${route}'s sitemap entry must be gated on ${envVar}, the same ` +
          "condition its page uses to decide between 200 and notFound().",
      ).toContain(`if (process.env.${envVar})`);
    });
  }
});
