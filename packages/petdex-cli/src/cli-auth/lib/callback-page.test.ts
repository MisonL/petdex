import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CallbackFailureReason,
  callbackStringsByLocale,
  clampDetail,
  defaultAppUrl,
  escapeHtml,
  LOCALES_FOR_TEST,
  renderCallbackPage,
} from "./callback-page";

const REASONS: CallbackFailureReason[] = [
  "authorization_denied",
  "state_mismatch",
  "missing_code",
  "token_exchange_failed",
  "userinfo_failed",
  "storage_failed",
  "timeout",
  "closed",
];

const APP_URL = "https://petdex.dev";

function successPage(): string {
  return renderCallbackPage({ kind: "success" }, APP_URL);
}

function errorPage(reason: CallbackFailureReason): string {
  return renderCallbackPage({ kind: "error", reason }, APP_URL);
}

describe("callback page strings", () => {
  test("every locale carries the same keys", () => {
    const strings = callbackStringsByLocale();
    const reference = Object.keys(strings.en).sort();
    for (const locale of LOCALES_FOR_TEST) {
      expect(Object.keys(strings[locale]).sort()).toEqual(reference);
      expect(Object.keys(strings[locale].reason).sort()).toEqual(
        [...REASONS].sort(),
      );
    }
  });

  test("no translation is left empty", () => {
    const strings = callbackStringsByLocale();
    for (const locale of LOCALES_FOR_TEST) {
      const entry = strings[locale];
      expect(entry.eyebrow.length).toBeGreaterThan(0);
      expect(entry.successTitle.length).toBeGreaterThan(0);
      for (const reason of REASONS) {
        expect(entry.reason[reason].length).toBeGreaterThan(0);
      }
    }
  });

  test("each failure reason reads differently", () => {
    const { reason } = callbackStringsByLocale().en;
    const seen = new Set<string>();
    for (const key of REASONS) seen.add(reason[key]);
    expect(seen.size).toBe(REASONS.length);
  });
});

describe("callback page document", () => {
  test("declares a viewport so the card is readable on a phone", () => {
    const html = successPage();
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  test("carries a lang attribute for the script to correct", () => {
    expect(successPage()).toContain('<html lang="en">');
  });

  test("inlines the brand mark", () => {
    const html = successPage();
    expect(html).toContain("<svg");
    expect(html).toContain('id="petdex-body"');
  });

  test("never assigns innerHTML", () => {
    expect(successPage()).not.toContain("innerHTML");
    expect(errorPage("timeout")).not.toContain("innerHTML");
  });

  test("requests nothing from the network", () => {
    const html = successPage();
    // The listening socket is closed the moment the page is written, so any
    // subresource would fail. The SVG namespace is a URI we never fetch, so
    // the check targets the things a browser actually resolves.
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("favicon");
    expect(html).not.toContain("@import");
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([`${APP_URL}/my-pets`]);
  });

  test("escapes the string table so it cannot break out of the JSON block", () => {
    const html = successPage();
    const match = html.match(
      /<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const payload = (match as RegExpMatchArray)[1];
    expect(payload).not.toContain("<");
    const parsed = JSON.parse(payload) as {
      strings: Record<string, { title: string }>;
    };
    expect(parsed.strings.en.title).toBe(
      callbackStringsByLocale().en.successTitle,
    );
    expect(parsed.strings.zh.title).toBe(
      callbackStringsByLocale().zh.successTitle,
    );
  });
});

describe("callback page success state", () => {
  test("points the button at the profile route on the app origin", () => {
    const html = successPage();
    expect(html).toContain(`href="${APP_URL}/my-pets"`);
  });

  test("keeps the button instead of a relative link", () => {
    // A relative href would resolve against the loopback origin.
    expect(successPage()).not.toContain('href="/my-pets"');
  });

  test("trails a slash in the configured app URL without doubling it", () => {
    const html = renderCallbackPage(
      { kind: "success" },
      "https://staging.test/",
    );
    expect(html).toContain('href="https://staging.test/my-pets"');
  });

  test("tries to close the tab after five seconds", () => {
    const html = successPage();
    expect(html).toContain("setTimeout(function () { window.close(); }, 5000)");
  });

  test("cancels that close once the reader touches anything", () => {
    const html = successPage();
    expect(html).toContain("clearTimeout(timer)");
    expect(html).toContain('"mousemove"');
    expect(html).toContain('"keydown"');
  });
});

describe("callback page error state", () => {
  test("never auto-closes, so the reason can be read", () => {
    for (const reason of REASONS) {
      expect(errorPage(reason)).not.toContain("window.close()");
    }
  });

  test("omits the profile button", () => {
    expect(errorPage("state_mismatch")).not.toContain('class="cta"');
  });

  test("gives every reason its own page", () => {
    const pages = new Set(REASONS.map((reason) => errorPage(reason)));
    expect(pages.size).toBe(REASONS.length);
  });
});

describe("callback page detail line", () => {
  test("escapes provider text", () => {
    const html = renderCallbackPage(
      { kind: "error", reason: "token_exchange_failed" },
      APP_URL,
      '<img src=x onerror="alert(1)">',
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("clamps a long detail", () => {
    expect(clampDetail("x".repeat(400))).toHaveLength(301);
  });

  test("leaves the line out when there is nothing to say", () => {
    expect(errorPage("timeout")).not.toContain('class="detail"');
  });
});

describe("callback page helpers", () => {
  test("escapes the five markup-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    );
  });

  test("defaults the app URL the same way bin/petdex.ts does", () => {
    // The CLI resolves PETDEX_URL in its entrypoint; this module carries its
    // own copy because the package ships standalone. A silent divergence would
    // send staging logins to production. Resolved from this file rather than
    // the working directory, because the root suite runs from the repo root.
    const entrypoint = readFileSync(
      join(import.meta.dir, "..", "..", "..", "bin", "petdex.ts"),
      "utf8",
    );
    expect(entrypoint).toContain('"https://petdex.dev"');
    expect(defaultAppUrl({} as NodeJS.ProcessEnv)).toBe("https://petdex.dev");
    expect(
      defaultAppUrl({
        PETDEX_URL: "https://staging.test",
      } as NodeJS.ProcessEnv),
    ).toBe("https://staging.test");
  });
});
