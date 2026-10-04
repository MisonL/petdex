import { IntlMessageFormat } from "intl-messageformat";

// The comparison logic behind `scripts/i18n-check.ts`, split out so it can be
// tested. The script itself runs at import time — it reads the real message
// files and exits — so nothing in it was reachable from a test, and the two
// checks that carry the most subtle rules (cross-locale placeholders, shape
// mismatches) had no coverage at all.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isPlainObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A short name for a value's JSON kind, for the shape-mismatch message.
 *
 * `isPlainObject` collapses every non-object (string, number, boolean, null,
 * array) to "leaf", but a translation that turns a message into an array or a
 * number is just as unusable as one that turns it into an object — the call
 * site reads a string and gets something else. Comparing the kinds rather than
 * the object/leaf bit catches all of them.
 */
function valueKind(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * Keys `target` is missing, including where the two disagree on shape.
 *
 * The recursion only descends where both sides are objects, so a key whose
 * `en` value is a string and whose translation is an object (or an array, or a
 * number) used to fall through silently: `key in target` is true, and the
 * `isPlainObject(value)` branch is not taken. That is a real defect, not a
 * formatting one — the call site reads a string and gets something else, which
 * renders as `[object Object]` or throws on `.split`. Both directions are
 * reported, since either one is a message the runtime cannot use.
 */
export function findMissingKeys(
  source: JsonObject,
  target: JsonObject,
  path = "",
): string[] {
  const missing: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (!(key in target)) {
      missing.push(nextPath);
      continue;
    }

    const targetValue = target[key];
    const sourceIsObject = isPlainObject(value);
    const targetIsObject = isPlainObject(targetValue);
    // Containers have to recurse; leaves have to agree on their JSON kind. A
    // difference in either is a subtree the runtime cannot read.
    if (sourceIsObject && targetIsObject) {
      missing.push(...findMissingKeys(value, targetValue, nextPath));
      continue;
    }
    if (valueKind(value) !== valueKind(targetValue)) {
      missing.push(
        `${nextPath} (shape: en is ${valueKind(value)}, ` +
          `translation is ${valueKind(targetValue)})`,
      );
    }
  }

  return missing;
}

/**
 * Messages a plain `t("key")` call cannot format.
 *
 * ICU reads an angle-bracketed name as a rich-text tag. A message that means
 * `<slug>` as a literal placeholder and passes it to `t()` therefore raises
 * `UNCLOSED_TAG`, and use-intl answers a thrown message by rendering the key
 * itself — so /about showed `about.faq.items.install.a` where a sentence
 * belonged. Only some messages are affected, and it depends on the call site
 * rather than the text:
 *
 * - A `t.rich` message (`<code>x</code>`, `<strong>y</strong>`) is valid: the
 *   caller supplies the tag renderers, so its tags are well-formed pairs.
 * - A message a call site reads with `t.raw()` is never parsed at all, so a
 *   bare `<slug>` there is fine — that is exactly what `t.raw` is for.
 *
 * Parsing every message would flag both of those, so the caller passes the set
 * of paths no call site has opted out of.
 */
export function findUnformattableMessages(
  messages: JsonObject,
  locale: string,
  exempt: ReadonlySet<string>,
  path = "",
): string[] {
  const failures: string[] = [];

  for (const [key, value] of Object.entries(messages)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (isPlainObject(value)) {
      failures.push(
        ...findUnformattableMessages(value, locale, exempt, nextPath),
      );
      continue;
    }
    if (typeof value !== "string") continue;
    // A call site that reads this key with `t.raw` never hands it to ICU.
    if (exempt.has(nextPath)) continue;

    try {
      // Constructing parses; formatting would additionally demand a value for
      // every `{placeholder}` and every tag, which `t.rich` call sites supply
      // at runtime and this check cannot know.
      new IntlMessageFormat(value, locale);
    } catch (error) {
      // The parser's SyntaxError carries its code as the message
      // ("UNCLOSED_TAG"), not as a `.code` property.
      const detail = (error as Error).message.split("\n")[0];
      failures.push(`${locale}: ${nextPath} — ${detail}`);
    }
  }

  return failures;
}

/**
 * Argument names in a message, split into every name and the subset that drives
 * a `plural`/`select` branch.
 */
export function argumentNames(
  value: string,
  locale: string,
): { all: Set<string>; selectors: Set<string> } {
  // `getAst()`, not the `.ast` field: same value, but the field is typed
  // private and only the accessor is part of the public surface.
  const ast = new IntlMessageFormat(value, locale).getAst() as unknown[];
  const all = new Set<string>();
  const selectors = new Set<string>();
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as Array<Record<string, unknown>>) {
      if (!node || typeof node !== "object") continue;
      if (node.type === 1 && typeof node.value === "string")
        all.add(node.value);
      // 6 is `plural`/`select`; its branches are walked for nested arguments.
      if (node.type === 6 && typeof node.value === "string") {
        all.add(node.value);
        selectors.add(node.value);
        for (const option of Object.values(
          (node.options ?? {}) as Record<string, { value: unknown }>,
        )) {
          walk(option.value);
        }
      }
      if (node.type === 5) walk(node.value); // tag
      if (
        node.type === 2 ||
        node.type === 3 ||
        node.type === 4 ||
        node.type === 8
      ) {
        walk(node.value);
      }
    }
  };
  walk(ast);
  return { all, selectors };
}

/**
 * Placeholder names compared across locales.
 *
 * Parsing a message in isolation proves it is well-formed; it says nothing
 * about whether the locales agree on what to pass it. A translator who renames
 * `{name}` to `{nombre}` produces a message that parses cleanly and then throws
 * `MissingValueError` at render time — use-intl answers that by printing the
 * key, so /es shows `facetPages.cardByAuthor` where a name belonged. Nothing
 * else catches it, because each locale was only ever checked against itself.
 *
 * Two directions, both defects:
 * - the locale names an argument `en` does not — a guaranteed throw.
 * - the locale drops an argument `en` supplies and it is not a `plural`/`select`
 *   selector — content the sentence needed is gone (`by {name}` → `por`).
 *
 * A selector is exempt from the second: zh legitimately drops `{count}` from
 * the install-count plural, because a language without plural agreement does
 * not need the number to choose a branch. Only messages that parse in both
 * locales are compared, so the `t.raw` messages — which are not ICU at all —
 * are skipped by the same throw that exempts them elsewhere.
 */
export function findPlaceholderMismatches(
  source: JsonObject,
  target: JsonObject,
  locale: string,
  path = "",
): string[] {
  const failures: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    const nextPath = path ? `${path}.${key}` : key;
    const targetValue = target[key];
    if (isPlainObject(value)) {
      if (isPlainObject(targetValue)) {
        failures.push(
          ...findPlaceholderMismatches(value, targetValue, locale, nextPath),
        );
      }
      continue;
    }
    if (typeof value !== "string" || typeof targetValue !== "string") continue;

    let sourceArgs: { all: Set<string>; selectors: Set<string> };
    let targetArgs: { all: Set<string>; selectors: Set<string> };
    try {
      sourceArgs = argumentNames(value, "en");
      targetArgs = argumentNames(targetValue, locale);
    } catch {
      // Unparseable in one of the two — already reported as a parse failure,
      // or exempt because a `t.raw` call site reads it.
      continue;
    }

    const added = [...targetArgs.all].filter((a) => !sourceArgs.all.has(a));
    if (added.length > 0) {
      failures.push(
        `${locale}: ${nextPath} — names ${added.map((a) => `{${a}}`).join(", ")} ` +
          `which en does not pass (en: ${[...sourceArgs.all].map((a) => `{${a}}`).join(", ") || "none"})`,
      );
    }

    const dropped = [...sourceArgs.all].filter(
      (a) => !targetArgs.all.has(a) && !sourceArgs.selectors.has(a),
    );
    if (dropped.length > 0) {
      failures.push(
        `${locale}: ${nextPath} — drops ${dropped.map((a) => `{${a}}`).join(", ")} ` +
          "which en passes, so the rendered sentence loses it",
      );
    }
  }

  return failures;
}
