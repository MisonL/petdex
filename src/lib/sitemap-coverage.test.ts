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

// The scan above skips every dynamic segment (`!name.startsWith("[")`), so a
// dynamic route family is invisible to it: `/stickers/[collection]` answered 200
// with `index, follow` from the header nav and appeared in no sitemap, and the
// gap was structural rather than an oversight.
//
// A family is listed when the sitemap builds a pathname under it, excused when
// its page is not indexable at all, or deliberately absent with a reason. The
// reachability half of the pairing is covered per-family (`sitemap-static.test.ts`
// pins the stickers eligibility and the Redis-free accessor, `locale-prefixed-path`
// the rendering), so this only answers "does the sitemap mention this family,
// and if not, why not".
const DYNAMIC_FAMILIES = [
  { family: "collections/[slug]", reason: "listed" },
  { family: "kind/[kind]", reason: "listed" },
  { family: "pets/[slug]", reason: "listed" },
  { family: "stickers/[collection]", reason: "listed" },
  { family: "vibe/[vibe]", reason: "listed" },
  // Account-scoped: `robots: { index: false, follow: false }`.
  { family: "my-feedback/[id]", reason: "noindex" },
  // Indexable, and not listed. A profile page is a legitimate sitemap entry,
  // but which profiles qualify is a product decision — every handle, or only
  // those with approved pets — and it needs its own accessor. Recorded here so
  // the omission is a decision rather than something the scan cannot see.
  { family: "u/[handle]", reason: "deliberately unlisted" },
] as const;

describe("every indexable dynamic route family is accounted for", () => {
  const sitemap = readFileSync(SITEMAP, "utf8");

  test("the family list still matches the route tree", () => {
    // A guard over a hardcoded list fails silently when a family is added, so
    // the list is checked against the directories on disk. Only families with
    // a `page.tsx` are considered: `/install/[slug]` is a route handler that
    // serves a shell script, has no page, and is correctly not a sitemap entry.
    // `[...rest]` is the 404 catch-all.
    const withPage = (dir: string, prefix = "") =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("["))
        .filter((entry) =>
          readdirSync(join(dir, entry.name)).includes("page.tsx"),
        )
        .map((entry) => `${prefix}${entry.name}/`);
    const onDisk = [
      ...withPage(LOCALE_DIR),
      ...readdirSync(LOCALE_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("["))
        .flatMap((entry) =>
          withPage(join(LOCALE_DIR, entry.name), `${entry.name}/`),
        ),
    ].filter((name) => !name.includes("[...rest]"));
    for (const name of onDisk) {
      expect(
        DYNAMIC_FAMILIES.some((entry) => `${entry.family}/` === name),
        `${name} is a dynamic route family that no sitemap assertion covers. ` +
          "Add it to DYNAMIC_FAMILIES with its reason, so a new family is not " +
          "silently unchecked.",
      ).toBe(true);
    }
  });

  for (const { family, reason } of DYNAMIC_FAMILIES) {
    if (reason !== "listed") continue;
    test(`/${family} is listed`, () => {
      const segment = `/${family.split("/")[0]}/`;
      expect(
        sitemap.includes(segment),
        `/${family} answers 200 with index, follow but builds no sitemap ` +
          "entry, so the only way a crawler finds it is by following a link.",
      ).toBe(true);
    });
  }

  test("a noindex family really is noindex", () => {
    // The excuse has to be true at the page, or "excused" is just "forgotten".
    const page = readFileSync(
      join(LOCALE_DIR, "my-feedback", "[id]", "page.tsx"),
      "utf8",
    );
    expect(page).toMatch(/index:\s*false/);
  });
});
