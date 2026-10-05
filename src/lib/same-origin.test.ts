import { afterEach, describe, expect, test } from "bun:test";

import { isSameOrigin } from "./same-origin";

// The Origin check is the CSRF boundary for every state-changing endpoint
// (`requireSameOrigin` guards likes, submissions, collections, gallery order,
// and more). A cross-site POST carries the visitor's Clerk cookie, so the
// check has to refuse any origin the app does not actually serve from.
//
// It used to accept `host.endsWith(".vercel.app")`. `vercel.app` is a public
// suffix — anyone can deploy there — so `https://evil.vercel.app` passed and
// could write to the DB as the victim. The deployment's real host is in
// `VERCEL_URL` (and its siblings), so an exact match is enough.

const VERCEL_VARS = [
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

afterEach(() => {
  for (const name of VERCEL_VARS) delete process.env[name];
  delete process.env.PETDEX_URL;
});

function post(origin: string): Request {
  return new Request("https://petdex.dev/api/pets/boba/like", {
    method: "POST",
    headers: { origin },
  });
}

describe("isSameOrigin", () => {
  test("accepts the canonical site", () => {
    expect(isSameOrigin(post("https://petdex.dev"))).toBe(true);
  });

  test("accepts the deployment's own vercel host", () => {
    process.env.VERCEL_URL = "petdex-git-main-acme.vercel.app";
    expect(isSameOrigin(post("https://petdex-git-main-acme.vercel.app"))).toBe(
      true,
    );
  });

  test("accepts a branch and production vercel host", () => {
    process.env.VERCEL_BRANCH_URL = "petdex-git-feature.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "petdex.vercel.app";
    expect(isSameOrigin(post("https://petdex-git-feature.vercel.app"))).toBe(
      true,
    );
    expect(isSameOrigin(post("https://petdex.vercel.app"))).toBe(true);
  });

  test("rejects an attacker's vercel.app deployment", () => {
    // The regression: a bare suffix match trusted any *.vercel.app origin.
    process.env.VERCEL_URL = "petdex-git-main-acme.vercel.app";
    expect(isSameOrigin(post("https://evil.vercel.app"))).toBe(false);
    expect(isSameOrigin(post("https://petdex.vercel.app.attacker.com"))).toBe(
      false,
    );
  });

  test("rejects an unrelated origin", () => {
    expect(isSameOrigin(post("https://attacker.example.com"))).toBe(false);
  });

  test("rejects a malformed Origin", () => {
    expect(isSameOrigin(post("not a url"))).toBe(false);
  });

  test("accepts localhost for local development", () => {
    expect(isSameOrigin(post("http://localhost:3000"))).toBe(true);
    expect(isSameOrigin(post("http://localhost"))).toBe(true);
  });

  test("accepts the origin this deployment is configured to serve", () => {
    // Self-hosted deployments do not answer on petdex.dev or a *.vercel.app
    // host, so without this the app rejects its own browser origin: a
    // same-origin `fetch()` POST carries `Origin: <the deploy origin>` and
    // `requireSameOrigin` 403s it. `PETDEX_URL` is already the configured
    // public origin the proxy and `/api/pets/random` read.
    process.env.PETDEX_URL = "http://127.0.0.1:3100";
    expect(isSameOrigin(post("http://127.0.0.1:3100"))).toBe(true);
  });

  test("a malformed PETDEX_URL does not widen the allowlist", () => {
    process.env.PETDEX_URL = "not a url";
    expect(isSameOrigin(post("https://attacker.example.com"))).toBe(false);
    // The hardcoded hosts still work.
    expect(isSameOrigin(post("https://petdex.dev"))).toBe(true);
  });

  test("PETDEX_URL does not admit a different origin", () => {
    process.env.PETDEX_URL = "https://petdex.dev";
    expect(isSameOrigin(post("https://evil.vercel.app"))).toBe(false);
    expect(isSameOrigin(post("http://127.0.0.1:3100"))).toBe(false);
  });

  test("falls back to Sec-Fetch-Site when Origin is absent", () => {
    const sameSite = new Request("https://petdex.dev/api/pets/boba/like", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(isSameOrigin(sameSite)).toBe(true);

    const crossSite = new Request("https://petdex.dev/api/pets/boba/like", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(isSameOrigin(crossSite)).toBe(false);
  });
});
