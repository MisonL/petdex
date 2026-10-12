// Strip invisible characters that carry no reading but split a token so a
// literal or word-boundary match no longer sees it: format characters
// (`\p{Cf}` — ZWSP, ZWNJ, ZWJ, word joiner, soft hyphen, BOM, bidi marks) and
// variation selectors (`\p{Variation_Selector}` — VS15/VS16, which are `\p{Mn}`
// and otherwise survive a diacritic strip).
//
// Measured evasions this closes, in the moderation paths that consume it:
//   "i\u200bkun" (ZWSP) and "iku\ufe0fn" (VS16) slipped past the keyword
//   blocklist; "https\u200b://evil.example" slipped past the URL detector's
//   protocol pattern. The plain and full-width spellings were caught in every
//   case — the escape was the easy path, not the hard one.

const INVISIBLE_RE = /[\p{Cf}\p{Variation_Selector}]/gu;

export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_RE, "");
}
