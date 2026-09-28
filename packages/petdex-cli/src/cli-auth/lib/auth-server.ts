import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { authMessages } from "../../i18n/auth-messages.js";
import { ClerkCliAuthError } from "../types.js";
import {
  type CallbackFailureReason,
  type CallbackOutcome,
  renderCallbackPage,
} from "./callback-page.js";

export interface AuthServerOptions {
  expectedState: string;
  port?: number;
  timeoutMs?: number;
  successHtml?: string;
  errorHtml?: string;
  /** Origin the success page's button points at. Defaults to the CLI's. */
  appUrl?: string;
}

export interface AuthServerHandle {
  port: number;
  redirectUri: string;
  /**
   * The redirect arrived and carried a usable authorization code. Resolves as
   * soon as the code is validated — the browser is still waiting for its page
   * at this point, and stays waiting until `respond` is called.
   */
  waitForCallback(): Promise<{ code: string; state: string }>;
  /**
   * Write the page the browser has been waiting for.
   *
   * Deferred on purpose: the code exchange, the userinfo call and the keychain
   * write all happen between `waitForCallback` and this call, and the page has
   * to report their outcome rather than the redirect's. Idempotent, never
   * throws, never blocks — a second call (or a timeout that already answered)
   * is a no-op returning false.
   */
  respond(outcome: CallbackOutcome): boolean;
  close(): void;
}

function headers(html: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(html)),
    // The full app CSP is deliberately not reused: it carries
    // `upgrade-insecure-requests`, which would rewrite this page's own
    // http://127.0.0.1 origin to https and break it.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
  };
}

function oauthCallbackError(code: string, message: string): ClerkCliAuthError {
  return new ClerkCliAuthError(code, message);
}

export function startAuthServer(
  options: AuthServerOptions,
): Promise<AuthServerHandle> {
  const {
    expectedState,
    port = 0,
    timeoutMs = 120_000,
    successHtml,
    errorHtml,
    appUrl,
  } = options;

  const pageFor = (outcome: CallbackOutcome, detail?: string): string => {
    if (outcome.kind === "success" && successHtml !== undefined)
      return successHtml;
    // An injected errorHtml is a single string and so cannot distinguish
    // reasons. That is the documented behaviour: the terminal is the source
    // of truth for why a login failed.
    if (outcome.kind === "error" && errorHtml !== undefined) return errorHtml;
    return renderCallbackPage(outcome, appUrl, detail);
  };

  let timeout: NodeJS.Timeout | undefined;
  let closed = false;
  /** The callback has been consumed: accepted, refused, timed out or torn down. */
  let callbackSettled = false;
  /** The browser has been answered. */
  let responseSent = false;
  /** The held-open response, while we wait on the exchange. */
  let pendingResponse: ServerResponse | null = null;
  let resolveCallback!: (value: { code: string; state: string }) => void;
  let rejectCallback!: (reason: ClerkCliAuthError) => void;

  const callbackPromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    },
  );
  // `login()` may never await this promise: if the browser opener throws
  // first, nothing consumes the rejection that `close()` then produces.
  // Attaching a no-op handler marks it observed; awaiting it later still
  // rejects with the same error.
  void callbackPromise.catch(() => {});

  const closeListening = (server: Server) => {
    if (closed) return;
    closed = true;
    server.close();
  };

  const isAlive = (res: ServerResponse | null): res is ServerResponse =>
    res !== null &&
    !res.writableEnded &&
    !res.destroyed &&
    res.socket !== null &&
    !res.socket.destroyed;

  /** A response we no longer need — the client is gone, or a newer one replaced it. */
  const endQuietly = (res: ServerResponse, status: number, body: string) => {
    if (!isAlive(res)) return;
    try {
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    } catch {
      // The socket died between the check and the write. Nothing to do.
    }
  };

  function sendOutcome(
    server: Server,
    outcome: CallbackOutcome,
    detail?: string,
  ): boolean {
    if (responseSent) return false;
    responseSent = true;
    if (timeout) clearTimeout(timeout);
    const target = pendingResponse;
    pendingResponse = null;
    if (!isAlive(target)) {
      closeListening(server);
      return false;
    }
    try {
      const html = pageFor(outcome, detail);
      target.writeHead(outcome.kind === "success" ? 200 : 500, headers(html));
      // Closing the listener here rather than after `end` returns is
      // measured behaviour, not style: a keep-alive connection that has just
      // been written to stays in the server's handle set until
      // `keepAliveTimeout`, which holds the event loop open and keeps
      // `petdex login` from exiting for up to five seconds.
      target.end(html, () => closeListening(server));
    } catch {
      closeListening(server);
      return false;
    }
    return true;
  }

  const server = createServer((req, res) => {
    // Requests are surfaced to the caller as events only — an unhandled
    // 'error' on a response stream (a client that vanished mid-write) would
    // otherwise become an uncaught exception and take the CLI down.
    res.on("error", () => {});

    // Method and path are checked before whether the callback was consumed,
    // so that a favicon or a stray path requested while we hold the response
    // open still gets an ordinary 404 rather than "already handled".
    if (req.method !== "GET" || !req.url) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Clerk CLI auth server is waiting for /callback.");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") ?? error;

    /**
     * Answer this request and nothing else.
     *
     * Used for every request that has not proven it carries the state this
     * server generated. Anything on the machine — and any web page the reader
     * has open, which can reach loopback without reading the response — can
     * send `/callback?error=x` or `/callback` and would otherwise be able to
     * decide the outcome of a login it knows nothing about. Such a request
     * must not set a flag, move a deadline, or settle the promise.
     */
    const answerOnly = (reason: CallbackFailureReason, statusCode: number) => {
      const html = pageFor({ kind: "error", reason });
      if (!isAlive(res)) return;
      try {
        res.writeHead(statusCode, headers(html));
        res.end(html);
      } catch {
        // Client already gone.
      }
    };

    /**
     * Refuse the login itself. Only reachable once the request has proven it
     * carries the expected state, so a stranger cannot end the attempt.
     */
    const refuseLogin = (
      reason: CallbackFailureReason,
      statusCode: number,
      err: ClerkCliAuthError,
    ) => {
      // A bogus request must not be able to disturb the legitimate response we
      // are holding: it answers only itself and leaves every piece of state
      // alone.
      if (callbackSettled) {
        answerOnly(reason, statusCode);
        return;
      }
      callbackSettled = true;
      responseSent = true;
      if (timeout) clearTimeout(timeout);
      const html = pageFor({ kind: "error", reason }, err.message);
      try {
        res.writeHead(statusCode, headers(html));
        res.end(html, () => closeListening(server));
      } catch {
        closeListening(server);
      }
      rejectCallback(err);
    };

    // State is checked first, so that a request which cannot prove it belongs
    // to this login is only ever answered for itself. Checking `error` first
    // would let any caller cancel the attempt by asking for a refusal.
    if (state !== expectedState) {
      answerOnly("state_mismatch", 400);
      return;
    }

    if (error) {
      refuseLogin(
        "authorization_denied",
        400,
        oauthCallbackError(
          "token_exchange",
          `OAuth authorization failed: ${errorDescription ?? "unknown error"}`,
        ),
      );
      return;
    }

    if (!code) {
      refuseLogin(
        "missing_code",
        400,
        oauthCallbackError(
          "token_exchange",
          "OAuth callback did not include an authorization code.",
        ),
      );
      return;
    }

    // A valid code, and the one case that does not answer immediately.
    if (callbackSettled && pendingResponse !== null) {
      // The reader reloaded or reopened the callback. The superseded response
      // has to be ended, not just dropped: `server.close()` deliberately keeps
      // connections that are still waiting for their response, so an abandoned
      // one would pin the event loop.
      endQuietly(pendingResponse, 409, "Superseded by a newer callback.");
      pendingResponse = null;
    }
    const firstCallback = !callbackSettled;
    callbackSettled = true;
    pendingResponse = res;
    res.on("close", () => {
      if (pendingResponse === res) pendingResponse = null;
    });

    // Restart the clock rather than sharing phase one's budget. A reader who
    // spent 115 seconds on the consent screen would otherwise leave five
    // seconds for the exchange.
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      sendOutcome(
        server,
        { kind: "error", reason: "timeout" },
        authMessages().callbackTimeout(timeoutMs),
      );
    }, timeoutMs);

    if (firstCallback) resolveCallback({ code, state });
  });

  return new Promise<AuthServerHandle>((resolve, reject) => {
    server.once("error", (error) => {
      reject(
        new ClerkCliAuthError(
          "config",
          `Failed to start local auth callback server: ${(error as Error).message}`,
        ),
      );
    });

    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const actualPort = address.port;
      const redirectUri = `http://127.0.0.1:${actualPort}/callback`;

      timeout = setTimeout(() => {
        if (callbackSettled) return;
        callbackSettled = true;
        // The listener deliberately stays up. The reader this deadline just
        // expired for is being redirected to this port right now, and closing
        // would hand them the browser's own network-error page instead of the
        // timeout page meant for them. A callback that arrives afterwards is
        // answered with that page and closes the listener on its way out; if
        // none ever arrives, `close()` in the caller's `finally` does it.
        rejectCallback(
          new ClerkCliAuthError(
            "timeout",
            authMessages().callbackTimeout(timeoutMs),
          ),
        );
      }, timeoutMs);

      resolve({
        port: actualPort,
        redirectUri,
        waitForCallback: () => callbackPromise,
        respond: (outcome) => sendOutcome(server, outcome),
        close: () => {
          if (timeout) clearTimeout(timeout);
          if (!callbackSettled) {
            callbackSettled = true;
            rejectCallback(
              new ClerkCliAuthError("timeout", authMessages().callbackClosed),
            );
          }
          // Safety net. A sign-in that got as far as the redirect and then
          // failed without anyone calling `respond` — an injected opener
          // rejecting after the browser already finished — would otherwise
          // leave the tab spinning forever, with its connection pinning the
          // event loop and keeping `petdex login` alive. The reason stays
          // generic on purpose: the specifics belong to whoever knew them,
          // and a wrong reason is worse than a vague one.
          if (
            !responseSent &&
            !sendOutcome(server, { kind: "error", reason: "closed" })
          )
            closeListening(server);
        },
      });
    });
  });
}
