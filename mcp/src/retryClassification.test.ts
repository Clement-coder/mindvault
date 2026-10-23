/**
 * Retry classification: deterministic vs transient failures (#1072).
 *
 * A 401/403, a malformed argument, or a contract validation error fails the
 * same way on every attempt. Retrying one only delays the error by the whole
 * backoff schedule, and for auth failures it repeats a rejected credential
 * against the API. These tables pin, for each kind of failure, how many
 * attempts `withRetry` makes and which backoff delays it sleeps for.
 *
 * Randomness is pinned to 0.5 and sleep is recorded, so the backoff schedule
 * for a transient failure is exact: attempts=3, base=100ms → delays [50, 100].
 */
import { describe, expect, it } from "vitest";

import { mapHttpError, mapRegistryError, mapTransportError, mcpError } from "./errorMapping.js";
import { RequestTimeoutError } from "./httpTimeout.js";
import { isRetryableError, isRetryableStatus, withRetry, type RetryPolicy } from "./retry.js";
import { ResponseSizeLimitError } from "./responseSize.js";
import { ToolValidationError, UnknownToolError } from "./validation.js";

const policy: RetryPolicy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

/** Backoff `withRetry` sleeps for when every attempt fails transiently. */
const TRANSIENT_DELAYS = [50, 100];

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function withStatus(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function httpMapped(status: number): Error {
  return mcpError(
    mapHttpError({ operation: "Browse failed", source: "api", status, data: { error: "x" } }),
  );
}

interface ThrownCase {
  name: string;
  error: () => unknown;
  retryable: boolean;
}

const THROWN_CASES: ThrownCase[] = [
  // ── Transient: the connection or the service, not the request ────────────
  { name: "undici fetch failed", error: () => new TypeError("fetch failed"), retryable: true },
  {
    name: "fetch failed caused by ECONNREFUSED",
    error: () =>
      Object.assign(new TypeError("request failed"), {
        cause: withCode("connect ECONNREFUSED 127.0.0.1:4021", "ECONNREFUSED"),
      }),
    retryable: true,
  },
  {
    name: "ECONNRESET errno",
    error: () => withCode("socket closed", "ECONNRESET"),
    retryable: true,
  },
  { name: "socket hang up", error: () => new Error("socket hang up"), retryable: true },
  { name: "Network error", error: () => new Error("Network error"), retryable: true },
  {
    name: "request deadline",
    error: () => new RequestTimeoutError("http", 15_000),
    retryable: true,
  },
  { name: "error carrying HTTP 503", error: () => withStatus("unavailable", 503), retryable: true },
  { name: "error carrying HTTP 429", error: () => withStatus("slow down", 429), retryable: true },
  { name: "mapped HTTP 502", error: () => httpMapped(502), retryable: true },
  {
    name: "mapped transport timeout",
    error: () =>
      mcpError(
        mapTransportError({
          operation: "x",
          source: "api",
          error: new RequestTimeoutError("http", 1),
        }),
      ),
    retryable: true,
  },

  // ── Deterministic: authentication and authorization ─────────────────────
  {
    name: "error carrying HTTP 401",
    error: () => withStatus("unauthorized", 401),
    retryable: false,
  },
  { name: "error carrying HTTP 403", error: () => withStatus("forbidden", 403), retryable: false },
  {
    name: "error carrying response.status 401",
    error: () => Object.assign(new Error("rejected"), { response: { status: 401 } }),
    retryable: false,
  },
  {
    name: "error carrying statusCode 403",
    error: () => Object.assign(new Error("rejected"), { statusCode: 403 }),
    retryable: false,
  },
  { name: "mapped HTTP 401", error: () => httpMapped(401), retryable: false },
  { name: "mapped HTTP 403", error: () => httpMapped(403), retryable: false },
  {
    // The mapped text says "network" in its guidance; the category decides.
    name: "mapped auth failure whose text mentions the network",
    error: () =>
      mcpError({
        source: "api",
        category: "auth",
        summary: "Publish failed: API key rejected on this network",
        action: "Check the network profile's API key.",
      }),
    retryable: false,
  },

  // ── Deterministic: malformed arguments and unusable responses ───────────
  {
    name: "ToolValidationError",
    error: () =>
      new ToolValidationError("mindvault_buy", [
        { field: "timeoutMs", code: "wrong_type", message: "timeoutMs must be a number." },
      ]),
    retryable: false,
  },
  {
    name: "UnknownToolError",
    error: () => new UnknownToolError("mindvault_nope"),
    retryable: false,
  },
  {
    name: "argument error mentioning a timeout and the network",
    error: () => new Error("Invalid timeout: network must be testnet or mainnet"),
    retryable: false,
  },
  {
    name: "error carrying HTTP 400",
    error: () => withStatus("bad request", 400),
    retryable: false,
  },
  {
    name: "error carrying HTTP 422",
    error: () => withStatus("unprocessable", 422),
    retryable: false,
  },
  { name: "mapped HTTP 400", error: () => httpMapped(400), retryable: false },
  { name: "mapped HTTP 404", error: () => httpMapped(404), retryable: false },
  { name: "mapped HTTP 409", error: () => httpMapped(409), retryable: false },
  {
    name: "oversized response",
    error: () => new ResponseSizeLimitError(10_000_000, 1_000),
    retryable: false,
  },
  {
    name: "unparseable JSON",
    error: () => new SyntaxError("Unexpected token <"),
    retryable: false,
  },

  // ── Deterministic: contract validation ──────────────────────────────────
  {
    name: "contract error NetworkIdMismatch",
    error: () => new Error("HostError: Error(Contract, #32) NetworkIdMismatch"),
    retryable: false,
  },
  {
    name: "contract error with a network word and no HostError prefix",
    error: () => new Error("simulation failed: Error(Contract, #11) network InvalidResourceId"),
    retryable: false,
  },
  {
    name: "host auth error",
    error: () => new Error("Error(Auth, InvalidAction): network request rejected"),
    retryable: false,
  },
  {
    name: "mapped contract error",
    error: () =>
      mcpError(mapRegistryError({ operation: "Set price", message: "Error(Contract, #3)" })),
    retryable: false,
  },

  // ── Never retried for other reasons ─────────────────────────────────────
  {
    name: "caller abort",
    error: () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    retryable: false,
  },
  {
    name: "programming error",
    error: () => new TypeError("x is not a function"),
    retryable: false,
  },
];

describe("isRetryableError classification table (#1072)", () => {
  it.each(THROWN_CASES)("$name → retryable=$retryable", ({ error, retryable }) => {
    expect(isRetryableError(error())).toBe(retryable);
  });
});

describe("withRetry attempts and backoff for thrown errors (#1072)", () => {
  it.each(THROWN_CASES)(
    "$name: attempts and delays match the classification",
    async ({ error, retryable }) => {
      const delays: number[] = [];
      let calls = 0;
      const thrown = error();
      await expect(
        withRetry(
          async () => {
            calls += 1;
            throw thrown;
          },
          {
            policy,
            label: "GET /resources",
            random: () => 0.5,
            sleep: async (ms) => {
              delays.push(ms);
            },
          },
        ),
      ).rejects.toBe(thrown);

      if (retryable) {
        expect(calls).toBe(policy.attempts);
        expect(delays).toEqual(TRANSIENT_DELAYS);
      } else {
        // Deterministic: one attempt, no backoff at all.
        expect(calls).toBe(1);
        expect(delays).toEqual([]);
      }
    },
  );
});

interface StatusCase {
  status: number;
  retryable: boolean;
}

const STATUS_CASES: StatusCase[] = [
  { status: 400, retryable: false },
  { status: 401, retryable: false },
  { status: 402, retryable: false },
  { status: 403, retryable: false },
  { status: 404, retryable: false },
  { status: 409, retryable: false },
  { status: 422, retryable: false },
  { status: 408, retryable: true },
  { status: 425, retryable: true },
  { status: 429, retryable: true },
  { status: 500, retryable: true },
  { status: 502, retryable: true },
  { status: 503, retryable: true },
  { status: 504, retryable: true },
];

describe("withRetry attempts and backoff for HTTP results (#1072)", () => {
  it.each(STATUS_CASES)("HTTP $status → retryable=$retryable", async ({ status, retryable }) => {
    const delays: number[] = [];
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "x" }), { status });
      },
      {
        policy,
        label: "GET /resources",
        shouldRetryResult: (r: Response) => isRetryableStatus(r.status),
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    // The last response is returned unchanged either way, for the caller to map.
    expect(res.status).toBe(status);
    expect(calls).toBe(retryable ? policy.attempts : 1);
    expect(delays).toEqual(retryable ? TRANSIENT_DELAYS : []);
  });

  it("stops at a deterministic status even after a transient one", async () => {
    const statuses = [503, 401, 200];
    const delays: number[] = [];
    let calls = 0;
    const res = await withRetry(async () => new Response(null, { status: statuses[calls++] }), {
      policy,
      label: "GET /resources",
      shouldRetryResult: (r: Response) => isRetryableStatus(r.status),
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(2);
    expect(delays).toEqual([50]);
  });
});
