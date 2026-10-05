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
  const rest = source.slice(start);
  // Close on a `}` that is alone on its line. The previous `indexOf("\n}")`
  // matched the `}) {` that ends a multi-line parameter destructure, so every
  // page written that way was scanned only down to its own signature — 19 of
  // the 25 pages, leaving their metadata unchecked.
  const close = rest.match(/^}$/m);
  return close?.index === undefined ? rest : rest.slice(0, close.index + 1);
}

describe("page metadata is localized", () => {
  test("no generateMetadata assigns an English literal to a metadata field", async () => {
    // The shape the hardcoded metadata took: a `title:`/`description:`/
    // `ogTitle:` set to a string, either inline (`title: "…"`) or hoisted to a
    // local first (`const title = \`…\``). Both are matched. A value read from
    // `t("…")` does not match, and a template string made only of
    // interpolations (`\`${pet.displayName}\``) is skipped — that is a
    // translated or content value being placed, not an English sentence.
    const FIELDS = "title|description|ogTitle|ogDescription|twitterTitle";
    // `\x60` is the backtick; spelled this way so the pattern itself needs no
    // string concatenation to embed a quote character.
    const assignment = new RegExp(
      `\\b(?:const\\s+)?(${FIELDS})\\s*[:=]\\s*(["\\x60])(.*)\\2\\s*[;,]?\\s*$`,
    );
    const offenders: string[] = [];
    for (const file of await pageFiles()) {
      const source = readFileSync(file, "utf8");
      const body = metadataBody(source);
      if (!body) continue;
      body.split("\n").forEach((line) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const match = line.match(assignment);
        if (!match) return;
        const [, field, quote, raw] = match;
        // A template literal's `${…}` parts are values, not prose; only what
        // is left between them can be a hardcoded English sentence.
        const literal =
          quote === "\x60" ? raw.replace(/\$\{[^}]*\}/g, "") : raw;
        if (literal.length < 4) return;
        if (!/[A-Za-z]{2,}/.test(literal)) return;
        const rel = file.slice(LOCALE_DIR.length + 1);
        offenders.push(`${rel} ${field}=${quote}${raw}${quote}`);
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

  test("the pages whose metadata was hardcoded read it from messages", () => {
    // The three regressions this guard was widened for. `/pets/[slug]` built
    // `title` from a template literal, and `/u/[handle]` and
    // `/collections/[slug]` did the same inline — all English on /es and /zh.
    const expectations: Array<[string, string]> = [
      [join(LOCALE_DIR, "pets", "[slug]", "page.tsx"), "pet.metadata"],
      [join(LOCALE_DIR, "u", "[handle]", "page.tsx"), "profile.metadata"],
      [
        join(LOCALE_DIR, "collections", "[slug]", "page.tsx"),
        "collectionDetail.metadata",
      ],
    ];
    for (const [file, namespace] of expectations) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain(`namespace: "${namespace}"`);
    }
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
