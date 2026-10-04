import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `generateMetadata` runs outside the render tree, so a page can be fully
// translated in its body while its `<title>`, description, and social card
// stay English — which is what `/download` did: the visible page was localized
// and the metadata under it was not, so a /es or /zh visitor got an English
// tab title and an English unfurl.
//
// This is a source scan rather than a render: the pages are server components
// that need the Next request context, and what matters is the shape — a
// metadata field assigned an English literal instead of `t(...)`.

const LOCALE_DIR = join(import.meta.dir, "..", "app", "[locale]");

/** Every `page.tsx` under `[locale]`, at any depth. */
async function pageFiles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === "page.tsx") found.push(path);
    }
  }
  await walk(LOCALE_DIR);
  return found;
}

/** The body of `generateMetadata`, or null when the page has none. */
function metadataBody(source: string): string | null {
  const start = source.indexOf("export async function generateMetadata");
  if (start === -1) return null;
  const end = source.indexOf("\n}", start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe("page metadata is localized", () => {
  test("no generateMetadata assigns an English literal to a metadata field", async () => {
    // A `title:`/`description:`/`ogTitle:` set to a double-quoted string is
    // the shape the hardcoded metadata took. `t("…")` and template strings
    // built from translated values do not match.
    const offenders: string[] = [];
    for (const file of await pageFiles()) {
      const source = readFileSync(file, "utf8");
      const body = metadataBody(source);
      if (!body) continue;
      body.split("\n").forEach((line) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const match = line.match(
          /\b(title|description|ogTitle|ogDescription|twitterTitle):\s*"([^"]{4,})"/,
        );
        if (match) {
          const rel = file.slice(LOCALE_DIR.length + 1);
          offenders.push(`${rel} ${match[1]}="${match[2]}"`);
        }
      });
    }
    expect(
      offenders,
      "Metadata is rendered per locale, so a hardcoded English string here " +
        "shows on /es and /zh too. Move it into the messages and read it " +
        "with `getTranslations`. Offenders: " +
        offenders.join("; "),
    ).toEqual([]);
  });

  test("the download page reads its metadata from messages", () => {
    // The specific regression this file was written for.
    const source = readFileSync(
      join(LOCALE_DIR, "download", "page.tsx"),
      "utf8",
    );
    expect(source).toContain(
      'getTranslations({ locale, namespace: "download.metadata" })',
    );
    expect(source).not.toContain('title: "Download Petdex Desktop"');
  });
});
