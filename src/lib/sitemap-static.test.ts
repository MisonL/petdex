import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `/sitemap.xml` is a prerendered route (`○` with `revalidate = 86400`). The
// build only keeps it static while everything it reaches is static too, and
// the sitemap filters its facet entries on the approved-pet counts.
//
// Reaching those counts through `loadFacets` — which reads Upstash before
// falling back to the `unstable_cache`d computation — made Next render the
// whole route dynamically. The build then reported `/sitemap.xml` as `ƒ`, and
// every request recomputed `lastModified: new Date()`, so `<lastmod>` in the
// XML changed on each fetch. That is the opposite of what the element means:
// it is supposed to be the page's last content change, and a value that moves
// on every request is one crawlers learn to ignore.
//
// `loadFacetsForSitemap` is the same computation without the Redis hop. This
// asserts the sitemap uses it, because the regression is invisible in every
// unit test — it only shows up in the build's route table.

const SITEMAP = join(import.meta.dir, "..", "app", "sitemap.ts");
const PET_SEARCH = join(import.meta.dir, "pet-search.ts");

describe("the sitemap stays statically renderable", () => {
  const sitemap = readFileSync(SITEMAP, "utf8");

  test("it does not call the Redis-backed loadFacets", () => {
    expect(
      sitemap,
      "loadFacets reads Upstash, which makes /sitemap.xml render dynamically " +
        "and moves <lastmod> to request time. Use loadFacetsForSitemap.",
    ).not.toMatch(/\bloadFacets\s*\(/);
  });

  test("it uses the Redis-free facet accessor", () => {
    expect(sitemap).toContain("loadFacetsForSitemap");
  });

  test("the two accessors are genuinely different", () => {
    const source = readFileSync(PET_SEARCH, "utf8");
    const forSitemap = source.match(
      /export const loadFacetsForSitemap = \(\): Promise<SearchFacets> =>\s*([^\n]+)/,
    );
    const regular = source.match(
      /const loadFacets = \(\): Promise<SearchFacets> =>\s*([^\n]+)/,
    );
    expect(forSitemap?.[1]).toContain("computeFacets()");
    expect(regular?.[1]).toContain("cachedAggregate(");
  });

  test("facet entries are filtered on the approved-pet counts", () => {
    // A vibe or kind with no approved pets calls `notFound()`. Eight of the
    // twelve vibes are in that state today, so listing them would advertise
    // eight 404s to crawlers. The filter is what keeps a facet entry and a
    // reachable page the same set, and it is invisible to every other test —
    // the sitemap route is only driven against a populated database.
    //
    // Asserted structurally: the map is applied through `.filter(...)` with
    // the `populated` predicate, so a change back to a bare `.map` (which is
    // what shipped the 404s) fails here.
    for (const facet of ["vibes", "kinds"]) {
      expect(
        sitemap,
        `PET_${facet.toUpperCase()} entries must be filtered on ` +
          `\`facets.${facet}\` having approved pets, or the sitemap lists ` +
          "facets whose pages call notFound().",
      ).toMatch(
        new RegExp(
          `PET_${facet.toUpperCase()}\\.filter\\(\\s*\\([^)]*\\)\\s*=>\\s*` +
            `populated\\(facets\\.${facet}`,
        ),
      );
    }
    // The predicate has to test > 0, not merely presence — a zero count is a
    // key that exists and is still not indexable.
    expect(sitemap).toMatch(/counts\[slug\] \?\? 0\) > 0/);
  });
});
