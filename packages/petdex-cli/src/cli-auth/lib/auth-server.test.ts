import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { ClerkCliAuthError } from "../types";
import { type AuthServerHandle, startAuthServer } from "./auth-server";

const STATE = "expected-state";

let handle: AuthServerHandle | undefined;
const aborters: AbortController[] = [];

afterEach(() => {
  // A held response leaves a connection that is still waiting to be answered,
  // and `server.close()` deliberately keeps those alive. Not aborting here
  // would leave the test process unable to exit.
  for (const controller of aborters.splice(0)) controller.abort();
  handle?.close();
  handle = undefined;
});

async function start(
  overrides: Partial<Parameters<typeof startAuthServer>[0]> = {},
): Promise<AuthServerHandle> {
  handle = await startAuthServer({
    expectedState: STATE,
    port: 0,
    timeoutMs: 150,
    ...overrides,
  });
  return handle;
}

function callbackUrl(
  handle: AuthServerHandle,
  query: Record<string, string> = {},
): string {
  const url = new URL(handle.redirectUri);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A request whose promise is kept, so the test can inspect it before it settles. */
function beginFetch(url: string) {
  const controller = new AbortController();
  aborters.push(controller);
  // A rejected request is normal here (the reader closing the tab), so the
  // outcome is a result rather than a throw. Tests that need the response
  // check the status first.
  const response: Promise<Response | null> = fetch(url).then(
    (res) => res,
    () => null,
  );
  return { controller, response };
}

/** Status of a finished request, failing the test if it never arrived. */
async function statusOf(page: Promise<Response | null>): Promise<number> {
  const res = await page;
  expect(res).not.toBeNull();
  return (res as Response).status;
}

/** True while `promise` has not settled. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return (
    (await Promise.race([promise, Bun.sleep(20).then(() => marker)])) === marker
  );
}

describe("auth server deferred response", () => {
  test("holds the page until respond is called, then answers with the success page", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );

    expect(await server.waitForCallback()).toEqual({
      code: "abc",
      state: STATE,
    });
    expect(await stillPending(response)).toBe(true);

    expect(server.respond({ kind: "success" })).toBe(true);

    const res = await response;
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(await res?.text()).toContain('href="https://petdex.dev/my-pets"');
  });

  test("answers with a failure page when the server is closed without a respond", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    expect(await stillPending(response)).toBe(true);

    server.close();

    const res = await response;
    expect(res?.status).toBe(500);
    expect(await res?.text()).toContain('class="chip chip-danger"');
  });

  test("reports false when the reader closed the tab first", async () => {
    const server = await start();
    const { controller, response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();

    controller.abort();
    await response;
    // The socket teardown is asynchronous, so wait for the connection to
    // actually go away rather than guessing at a delay. `respond` reporting
    // false is what tells us the held response was dropped.
    expect(server.respond({ kind: "success" })).toBe(false);
  });

  test("is idempotent across two respond calls", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(server.respond({ kind: "error", reason: "timeout" })).toBe(false);
    const page = await response;
    expect(await page?.text()).toContain('class="chip chip-success"');
  });

  test("reports false when responding after close", async () => {
    const server = await start();
    server.close();
    expect(server.respond({ kind: "success" })).toBe(false);
  });

  test("survives being closed twice", async () => {
    const server = await start();
    expect(() => {
      server.close();
      server.close();
    }).not.toThrow();
  });
});

describe("auth server rejected callbacks", () => {
  test("answers a declined authorization with the injected error page", async () => {
    const server = await start({ errorHtml: "<p>custom failure</p>" });
    const pending = server.waitForCallback().catch((error: Error) => error);

    const res = await fetch(
      callbackUrl(server, {
        error: "access_denied",
        error_description: "user said no",
        state: STATE,
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("<p>custom failure</p>");
    const error = (await pending) as ClerkCliAuthError;
    expect(error.code).toBe("token_exchange");
  });

  test("rejects a mismatched state", async () => {
    const server = await start();
    const pending = server.waitForCallback().catch((error: Error) => error);

    const res = await fetch(
      callbackUrl(server, { code: "abc", state: "someone-else" }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("state");
    expect(((await pending) as ClerkCliAuthError).code).toBe("state_mismatch");
  });

  test("rejects a callback with no code", async () => {
    const server = await start();
    const pending = server.waitForCallback().catch((error: Error) => error);

    const res = await fetch(callbackUrl(server, { state: STATE }));

    expect(res.status).toBe(400);
    expect(((await pending) as ClerkCliAuthError).code).toBe("token_exchange");
  });
});

describe("auth server while a response is held", () => {
  test("hands over to a second valid callback and ends the first", async () => {
    const server = await start();
    const first = beginFetch(
      callbackUrl(server, { code: "one", state: STATE }),
    );
    expect(await server.waitForCallback()).toEqual({
      code: "one",
      state: STATE,
    });

    const second = beginFetch(
      callbackUrl(server, { code: "two", state: STATE }),
    );
    // The superseded response is answered so its connection stops waiting.
    expect(await statusOf(first.response)).toBe(409);

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(second.response)).toBe(200);
  });

  test("answers a bogus callback without disturbing the held one", async () => {
    const server = await start();
    const held = beginFetch(callbackUrl(server, { code: "abc", state: STATE }));
    await server.waitForCallback();

    const bogus = await fetch(
      callbackUrl(server, { code: "x", state: "not-the-state" }),
    );
    expect(bogus.status).toBe(400);

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(held.response)).toBe(200);
  });

  test("still serves an ordinary 404 for a favicon while holding", async () => {
    const server = await start();
    const held = beginFetch(callbackUrl(server, { code: "abc", state: STATE }));
    await server.waitForCallback();

    const favicon = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
    expect(favicon.status).toBe(404);

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(held.response)).toBe(200);
  });
});

describe("auth server timeouts", () => {
  test("rejects when no callback arrives in time", async () => {
    const server = await start({ timeoutMs: 120 });
    const error = (await server
      .waitForCallback()
      .catch((err: Error) => err)) as ClerkCliAuthError;
    expect(error.code).toBe("timeout");
  });

  test("answers the held page when the exchange window expires", async () => {
    const server = await start({ timeoutMs: 120 });
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();

    const res = await response;
    expect(res?.status).toBe(500);
    expect(await res?.text()).toContain('class="chip chip-danger"');
  });
});

describe("auth server page rendering", () => {
  test("escapes provider text that reaches the page", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, {
        error: "access_denied",
        error_description: "<img src=x onerror=alert(1)>",
        state: STATE,
      }),
    );
    await server.waitForCallback().catch(() => {});

    const html = await (await response)?.text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("uses an injected success page verbatim", async () => {
    const server = await start({ successHtml: "<p>done</p>" });
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    server.respond({ kind: "success" });

    expect(await (await response)?.text()).toBe("<p>done</p>");
  });

  test("sets the hardening headers", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    server.respond({ kind: "success" });

    const headers = (await response)?.headers;
    expect(headers?.get("x-content-type-options")).toBe("nosniff");
    expect(headers?.get("referrer-policy")).toBe("no-referrer");
    expect(headers?.get("cache-control")).toBe("no-store");
    expect(headers?.get("x-frame-options")).toBe("DENY");
  });
});

describe("auth server startup", () => {
  test("reports a port already in use as a config error", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve()),
    );
    const taken = (blocker.address() as AddressInfo).port;

    try {
      const error = (await startAuthServer({
        expectedState: STATE,
        port: taken,
      }).catch((err: Error) => err)) as ClerkCliAuthError;
      expect(error).toBeInstanceOf(ClerkCliAuthError);
      expect(error.code).toBe("config");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
