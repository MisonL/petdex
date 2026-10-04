import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// `mock.module` is process-wide and first-registration-wins, so whichever
// suite stubs `@/lib/db/client` first supplies that module to every later
// suite in the same `bun test` process. A factory that returns a partial
// shape therefore does not fail in its own file — it fails in some *other*
// file, with a `SyntaxError` about a missing export rather than a failing
// assertion, and only when the files run in one particular order.
//
// That is what happened when `executeAtomicReturning` and `rowsOf` were added
// to the real module: six factories were updated and one
// (`collection-transaction.test.ts`) was missed. `bun run test` was green
// because that file happened to load after the suites that need the exports;
//
//   bun run test ./src/lib/collection-transaction.test.ts \
//                ./src/app/api/pet-requests/route.test.ts
//
// reproduced it as `Export named 'executeAtomicReturning' not found`.
//
// This asserts the property directly, so the next export added to
// `src/lib/db/client.ts` cannot repeat it silently.

const CLIENT = "src/lib/db/client.ts";

/** Every named export of `src/lib/db/client.ts`. */
async function clientExports(): Promise<string[]> {
  const source = await Bun.file(CLIENT).text();
  const names = new Set<string>();

  // `export { a, b } from "..."` and `export { a, b }`.
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  // `export const x` / `export async function x` / `export function x`.
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:const|let|function)\s+(\w+)/g,
  )) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/** The factory body, from its opening brace to the matching close. */
function factoryBody(source: string, start: number): string {
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** `mock.module("@/lib/db/client", …)` factories, with the file that declares each. */
async function factories(): Promise<Array<{ file: string; body: string }>> {
  const glob = new Glob("src/**/*.{ts,tsx}");
  const out: Array<{ file: string; body: string }> = [];
  for await (const file of glob.scan({ cwd: process.cwd() })) {
    if (!/\.(test|integration)\.tsx?$/.test(file)) continue;
    // This file names the marker in its own source; scanning it would report
    // the guard as an offending factory.
    if (file === "src/lib/db-client-mock-shape.test.ts") continue;
    const source = await Bun.file(file).text();
    const marker = 'mock.module("@/lib/db/client"';
    let from = source.indexOf(marker);
    while (from !== -1) {
      // Only the factory's own braces. Reading to the next `mock.module(`
      // instead would run past the factory into unrelated code — a spread
      // further down the file would then look like the factory spreading the
      // real module, and the check would skip it.
      out.push({ file, body: factoryBody(source, from) });
      from = source.indexOf(marker, from + marker.length);
    }
  }
  return out;
}

describe("every @/lib/db/client mock provides the module's exports", () => {
  test("the export scan finds the module's surface", async () => {
    const names = await clientExports();
    expect(names).toContain("db");
    expect(names).toContain("schema");
    // The two that were added later and broke a stale factory.
    expect(names).toContain("executeAtomicReturning");
    expect(names).toContain("rowsOf");
  });

  test("the factory scan finds the stubbing suites", async () => {
    // A scan that silently matched nothing would pass for the wrong reason.
    const found = await factories();
    expect(found.length).toBeGreaterThan(5);
  });

  test("no factory omits an export the module provides", async () => {
    const names = await clientExports();
    const incomplete: string[] = [];

    for (const { file, body } of await factories()) {
      // A factory may spread the real module (`...actual`) and override part
      // of it, which supplies every export it does not name.
      if (/\.\.\.\s*\w/.test(body)) continue;
      // Comments are stripped first: a factory that explains *why* it exports
      // `rowsOf` would otherwise read as exporting it. That is not
      // hypothetical — the fix for the stale factory carries a comment naming
      // both exports, and without this the check reported only the one the
      // comment happened to omit.
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const missing = names.filter(
        (name) => !new RegExp(`\\b${name}\\b`).test(code),
      );
      if (missing.length > 0) {
        incomplete.push(`${file} is missing ${missing.join(", ")}`);
      }
    }

    expect(
      incomplete,
      "A `mock.module` factory for @/lib/db/client that omits an export " +
        "breaks whichever suite loads next and links it — as a SyntaxError, " +
        "not a failed assertion, and only in some file orders. Add the " +
        "missing exports (or spread the real module): " +
        incomplete.join("; "),
    ).toEqual([]);
  });
});
