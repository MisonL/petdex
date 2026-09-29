import { afterEach, describe, expect, test } from "bun:test";

import { ClerkCliAuthError } from "../types";
import { exchangeCodeForTokens, fetchUserInfo } from "./token-exchange";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type FetchArgs = Parameters<typeof fetch>;

function stubFetch(
  impl: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response>,
) {
  globalThis.fetch = impl as typeof fetch;
}

const params = {
  issuer: "https://clerk.test",
  clientId: "client-id",
  code: "auth-code",
  codeVerifier: "verifier",
  redirectUri: "http://127.0.0.1:1/callback",
};

/**
 * Both network calls must carry a deadline.
 *
 * Without one a stalled connection leaves `login()` waiting forever: the
 * callback server's own timeout answers the browser, but nothing breaks the
 * request the CLI is sitting on.
 *
 * The assertions are on the signal rather than on a real expiry. Waiting out
 * the 15s deadline would cost the suite half a minute to re-prove that
 * `AbortSignal.timeout` aborts, which is Node's guarantee and not this
 * module's; what belongs to this module is remembering to pass it at all.
 */
describe("token exchange request bounds", () => {
  test("puts a deadline on the token request", async () => {
    let signal: AbortSignal | undefined;
    stubFetch(async (_input, init) => {
      signal = init?.signal ?? undefined;
      throw new Error("stopped before the request went out");
    });

    await exchangeCodeForTokens(params).catch(() => {});

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  test("puts a deadline on the userinfo request", async () => {
    let signal: AbortSignal | undefined;
    stubFetch(async (_input, init) => {
      signal = init?.signal ?? undefined;
      throw new Error("stopped before the request went out");
    });

    await fetchUserInfo({
      issuer: "https://clerk.test",
      accessToken: "token",
    }).catch(() => {});

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  test("reports a request that failed as a token_exchange error", async () => {
    stubFetch(async () => {
      throw new Error("socket hang up");
    });

    const error = (await exchangeCodeForTokens(params).catch(
      (err: Error) => err,
    )) as ClerkCliAuthError;
    expect(error).toBeInstanceOf(ClerkCliAuthError);
    expect(error.code).toBe("token_exchange");
    expect(error.message).toContain("Token request failed");
  });

  test("reports an HTTP failure from the token endpoint", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = (await exchangeCodeForTokens(params).catch(
      (err: Error) => err,
    )) as ClerkCliAuthError;
    expect(error.code).toBe("token_exchange");
    expect(error.message).toBe("invalid_grant");
  });

  test("refuses a token response with no access_token", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = (await exchangeCodeForTokens(params).catch(
      (err: Error) => err,
    )) as ClerkCliAuthError;
    expect(error.code).toBe("token_exchange");
    expect(error.message).toContain("access_token");
  });
});
