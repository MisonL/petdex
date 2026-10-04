import type { MetadataRoute } from "next";

import { getCollectionSitemapEntries } from "@/lib/collections";
import {
  buildAbsoluteLocaleAlternates,
  buildAbsoluteUrl,
} from "@/lib/locale-routing";
import { loadFacetsForSitemap } from "@/lib/pet-search";
import { getPetSitemapEntries } from "@/lib/pets";
import { PET_KINDS, PET_VIBES } from "@/lib/types";

export const revalidate = 86400;

type EntryInput = {
  pathname: string;
  lastModified: Date;
  changeFrequency: NonNullable<
    MetadataRoute.Sitemap[number]["changeFrequency"]
  >;
  priority: number;
};

function expandLocalizedEntry(entry: EntryInput): MetadataRoute.Sitemap {
  return [
    {
      url: buildAbsoluteUrl(entry.pathname, "en"),
      lastModified: entry.lastModified,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: buildAbsoluteLocaleAlternates(entry.pathname),
    },
    {
      url: buildAbsoluteUrl(entry.pathname, "es"),
      lastModified: entry.lastModified,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: buildAbsoluteLocaleAlternates(entry.pathname),
    },
    {
      url: buildAbsoluteUrl(entry.pathname, "zh"),
      lastModified: entry.lastModified,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: buildAbsoluteLocaleAlternates(entry.pathname),
    },
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [pets, collections] = await Promise.all([
    getPetSitemapEntries(),
    getCollectionSitemapEntries(),
  ]);
  const now = new Date();

  const staticEntries: EntryInput[] = [
    {
      pathname: "/",
      lastModified: now,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      pathname: "/about",
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      pathname: "/docs",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      pathname: "/brand",
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      pathname: "/leaderboard",
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      pathname: "/collections",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      pathname: "/requests",
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    },
    // `/create` is deliberately absent: robots.txt disallows it, and a sitemap
    // entry for a disallowed URL is a Search Console error, not a hint.
    {
      pathname: "/legal/takedown",
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    // These three are indexable and prerendered but were missing here, so the
    // only way a crawler found them was by following a link. `/download` and
    // `/built-with` are linked from the header nav; `/legal/telemetry` is
    // reached from the CLI's telemetry notice rather than any page, which is
    // exactly the case a sitemap exists to cover.
    {
      pathname: "/download",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      pathname: "/built-with",
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.5,
    },
    {
      pathname: "/legal/telemetry",
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ];

  // `/community` is indexable exactly when the page is live: with no Discord
  // invite it calls `notFound()` and its metadata says `noindex`, and in
  // production the invite is set, so it answers 200 with `index, follow` while
  // being absent here — the one state a sitemap exists to prevent.
  //
  // Keyed on the Discord invite alone, not on either signal the page accepts.
  // The zh WeChat card makes only `/zh/community` live, and every entry below
  // expands to all three locales, so admitting that case would advertise two
  // 404s to cover one page; it is left unlisted rather than half-listed.
  if (process.env.NEXT_PUBLIC_DISCORD_INVITE_URL) {
    staticEntries.push({
      pathname: "/community",
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    });
  }

  // A facet with no approved pets calls `notFound()`, so listing it advertises
  // a 404 (eight of the twelve vibes are in that state today). The counts come
  // from the same `unstable_cache`d aggregate the facet pages read.
  //
  // `loadFacetsForSitemap`, not `loadFacets`: the latter also reads Upstash,
  // and any Redis call from this route makes Next render it dynamically —
  // `/sitemap.xml` went from a static `○` to a dynamic `ƒ`, and its `lastmod`
  // from build time to request time.
  const facets = await loadFacetsForSitemap();
  const populated = (counts: Record<string, number>, slug: string) =>
    (counts[slug] ?? 0) > 0;

  const vibeEntries: EntryInput[] = PET_VIBES.filter((vibe) =>
    populated(facets.vibes, vibe),
  ).map((vibe) => ({
    pathname: `/vibe/${vibe}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const kindEntries: EntryInput[] = PET_KINDS.filter((kind) =>
    populated(facets.kinds, kind),
  ).map((kind) => ({
    pathname: `/kind/${kind}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const petEntries: EntryInput[] = pets.map((pet) => ({
    pathname: `/pets/${pet.slug}`,
    lastModified: pet.importedAt ? new Date(pet.importedAt) : now,
    changeFrequency: "weekly",
    priority: pet.featured ? 0.9 : 0.6,
  }));

  const collectionEntries: EntryInput[] = collections.map((collection) => ({
    pathname: `/collections/${collection.slug}`,
    lastModified: collection.updatedAt ?? now,
    changeFrequency: "weekly",
    priority: collection.featured ? 0.8 : 0.5,
  }));

  return [
    ...staticEntries,
    ...vibeEntries,
    ...kindEntries,
    ...petEntries,
    ...collectionEntries,
  ].flatMap(expandLocalizedEntry);
}
