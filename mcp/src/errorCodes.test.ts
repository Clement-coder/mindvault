/**
 * Tests for explicit tool error codes (#580).
 *
 * Codes are a contract: anything keyed on them — an agent's branching, a
 * dashboard, a support runbook — breaks silently if a code changes meaning. So
 * the catalog itself is asserted, alongside the classification of each failure
 * into it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_ERROR_CODES,
  ERROR_CODES,
  codeForMappedError,
  errorCodeFor,
  formatCodeSuffix,
  isErrorCode,
  isRetrySafe,
  localErrorCode,
  specFor,
  toolErrorPayload,
  type ErrorCode,
} from "./errorCodes.js";
import type { MappedError } from "./errorMapping.js";

function mapped(overrides: Partial<MappedError> = {}): MappedError {
  return {
    source: "api",
    category: "unknown",
    summary: "Operation failed: something",
    action: "Retry once.",
    ...overrides,
  };
}

describe("the catalog", () => {
  it("is not empty", () => {
    expect(ALL_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it("is sorted, so docs and dashboards get a stable order", () => {
    expect([...ALL_ERROR_CODES].sort()).toEqual(ALL_ERROR_CODES);
  });

  it("keys every entry by its own code", () => {
    // A mismatch here means a lookup returns a spec describing a different
    // failure — the worst possible outcome for something clients branch on.
    for (const [key, spec] of Object.entries(ERROR_CODES)) {
      expect(spec.code).toBe(key);
    }
  });

  it("names every code MV_-prefixed and screaming", () => {
    for (const code of ALL_ERROR_CODES) {
      expect(code).toMatch(/^MV_[A-Z0-9_]+$/);
    }
  });

  it("gives every code a description and an action", () => {
    for (const code of ALL_ERROR_CODES) {
      const spec = ERROR_CODES[code];
      expect(spec.description.length, `${code} has no description`).toBeGreaterThan(0);
      expect(spec.action.length, `${code} has no action`).toBeGreaterThan(0);
    }
  });

  it("gives every code a retry safety", () => {
    for (const code of ALL_ERROR_CODES) {
      expect(["safe", "unsafe", "conditional"]).toContain(ERROR_CODES[code].retry);
    }
  });

  it("describes each code distinctly", () => {
    const descriptions = ALL_ERROR_CODES.map((code) => ERROR_CODES[code].description);

    // Two codes with the same description are two codes that should be one.
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("marks nothing that moves money as blindly retry-safe", () => {
    // The single most consequential property in the catalog.
    expect(ERROR_CODES.MV_PAYMENT_REJECTED.retry).not.toBe("safe");
    expect(ERROR_CODES.MV_UNKNOWN.retry).not.toBe("safe");
  });

  it("marks the pre-payment refusals safe", () => {
    // No funds moved, so an immediate retry costs nothing.
    expect(ERROR_CODES.MV_PAYMENT_CEILING_EXCEEDED.retry).toBe("safe");
    expect(ERROR_CODES.MV_INSUFFICIENT_FUNDS.retry).toBe("safe");
    expect(ERROR_CODES.MV_PAYMENT_REQUIRED.retry).toBe("safe");
  });

  it("does not tell an agent to retry an argument error", () => {
    // An identical retry fails identically; saying "retry" wastes a call.
    expect(ERROR_CODES.MV_ARGUMENT_INVALID.retry).toBe("unsafe");
    expect(ERROR_CODES.MV_NOT_FOUND.retry).toBe("unsafe");
  });
});

describe("isErrorCode", () => {
  it("accepts a known code", () => {
    expect(isErrorCode("MV_TIMEOUT")).toBe(true);
  });

  it.each(["", "TIMEOUT", "mv_timeout", "MV_MADE_UP", null, 42])("rejects %s", (value) => {
    expect(isErrorCode(value)).toBe(false);
  });
});

describe("specFor and isRetrySafe", () => {
  it("looks a code up", () => {
    expect(specFor("MV_TIMEOUT").category).toBe("timeout");
  });

  it("falls back to unknown for an unrecognised code", () => {
    expect(specFor("MV_NOPE" as ErrorCode).code).toBe("MV_UNKNOWN");
  });

  it("reports retry safety", () => {
    expect(isRetrySafe("MV_TIMEOUT")).toBe(true);
    expect(isRetrySafe("MV_PAYMENT_REJECTED")).toBe(false);
    expect(isRetrySafe("MV_UNKNOWN")).toBe(false);
  });
});

describe("classifying HTTP failures", () => {
  it.each([
    ["network", "MV_NETWORK_UNREACHABLE"],
    ["timeout", "MV_TIMEOUT"],
    ["rate_limit", "MV_RATE_LIMITED"],
    ["server", "MV_UPSTREAM_ERROR"],
    ["not_found", "MV_NOT_FOUND"],
    ["conflict", "MV_CONFLICT"],
    ["contract", "MV_CONTRACT_ERROR"],
    ["validation", "MV_ARGUMENT_INVALID"],
  ] as const)("maps category %s to %s", (category, code) => {
    expect(codeForMappedError(mapped({ category }))).toBe(code);
  });

  it("distinguishes missing credentials from denied ones", () => {
    expect(codeForMappedError(mapped({ category: "auth", status: 401 }))).toBe("MV_AUTH_REQUIRED");
    expect(codeForMappedError(mapped({ category: "auth", status: 403 }))).toBe("MV_AUTH_REJECTED");
  });

  it("recognises a revoked publisher key", () => {
    // Absent and refused credentials need opposite fixes.
    const error = mapped({
      category: "auth",
      status: 401,
      action: 'The publisher API key stored in profile "x" is no longer accepted — it was revoked.',
    });

    expect(codeForMappedError(error)).toBe("MV_API_KEY_REVOKED");
  });

  it("recognises a clock-skew rejection", () => {
    const error = mapped({
      category: "auth",
      status: 401,
      action: "Correct this machine's clock; the signature was outside the accepted window.",
    });

    expect(codeForMappedError(error)).toBe("MV_CLOCK_SKEW");
  });

  it("treats a bare 402 as a price quote, not a failed payment", () => {
    // Nothing was signed — the resource is stating what it costs.
    expect(codeForMappedError(mapped({ category: "payment", status: 402, source: "api" }))).toBe(
      "MV_PAYMENT_REQUIRED",
    );
  });

  it("treats a non-402 payment failure as a rejected attempt", () => {
    expect(codeForMappedError(mapped({ category: "payment", status: 500, source: "x402" }))).toBe(
      "MV_PAYMENT_REJECTED",
    );
  });

  it("recognises an underfunded wallet from the detail", () => {
    const error = mapped({
      category: "payment",
      status: 500,
      source: "x402",
      detail: "insufficient USDC balance",
    });

    expect(codeForMappedError(error)).toBe("MV_INSUFFICIENT_FUNDS");
  });

  it("falls back to unknown for an unmapped category", () => {
    expect(codeForMappedError(mapped({ category: "unknown" }))).toBe("MV_UNKNOWN");
  });
});

describe("classifying local failures", () => {
  it.each([
    ["Payment 25 USDC exceeds the auto-pay ceiling of 10", "MV_PAYMENT_CEILING_EXCEEDED"],
    ["Pass confirmMainnet: true to proceed", "MV_MAINNET_UNCONFIRMED"],
    ["No wallet configured; run mindvault_setup_wallet first", "MV_WALLET_MISSING"],
    ["Insufficient USDC balance for this purchase", "MV_INSUFFICIENT_FUNDS"],
    ["Unknown tool: mindvault_nope", "MV_TOOL_UNKNOWN"],
    ["The state file is corrupt and has been quarantined", "MV_STATE_CORRUPT"],
  ])("classifies %s", (message, expected) => {
    expect(localErrorCode(new Error(message))).toBe(expected);
  });

  it("classifies a timeout by error name", () => {
    const error = new Error("aborted");
    error.name = "TimeoutError";

    expect(localErrorCode(error)).toBe("MV_TIMEOUT");
  });

  it("classifies a validation error by name", () => {
    const error = new Error("bad input");
    error.name = "ValidationError";

    expect(localErrorCode(error)).toBe("MV_ARGUMENT_INVALID");
  });

  it("returns null for an unrecognised local error", () => {
    expect(localErrorCode(new Error("something else entirely"))).toBeNull();
  });

  it("returns null for nullish input", () => {
    expect(localErrorCode(null)).toBeNull();
    expect(localErrorCode(undefined)).toBeNull();
  });

  it("handles a thrown non-Error", () => {
    expect(localErrorCode("Unknown tool: x")).toBe("MV_TOOL_UNKNOWN");
  });
});

describe("errorCodeFor", () => {
  it("prefers the local classification over the HTTP mapping", () => {
    // A ceiling breach never reached the network; reporting it as a server
    // problem sends the agent to retry something that cannot succeed.
    const code = errorCodeFor(
      new Error("exceeds the auto-pay ceiling"),
      mapped({ category: "server" }),
    );

    expect(code).toBe("MV_PAYMENT_CEILING_EXCEEDED");
  });

  it("falls back to the mapping when nothing local matches", () => {
    expect(errorCodeFor(new Error("weird"), mapped({ category: "timeout" }))).toBe("MV_TIMEOUT");
  });

  it("returns unknown with neither", () => {
    expect(errorCodeFor(new Error("weird"))).toBe("MV_UNKNOWN");
    expect(errorCodeFor(new Error("weird"), null)).toBe("MV_UNKNOWN");
  });
});

describe("toolErrorPayload", () => {
  it("carries a versioned schema", () => {
    const payload = toolErrorPayload({ error: new Error("x"), summary: "Failed" });

    expect(payload.schema).toBe("mindvault.error/v1");
  });

  it("carries the code, category and retry safety together", () => {
    const payload = toolErrorPayload({
      error: new Error("x"),
      mapped: mapped({ category: "timeout", source: "horizon", status: 504 }),
      summary: "Balance read failed",
    });

    expect(payload).toMatchObject({
      code: "MV_TIMEOUT",
      category: "timeout",
      source: "horizon",
      status: 504,
      retry: "safe",
    });
  });

  it("prefers the mapper's action, which can be more specific", () => {
    const payload = toolErrorPayload({
      error: new Error("x"),
      mapped: mapped({ category: "auth", action: 'Switch to profile "publisher".' }),
      summary: "Denied",
    });

    // The mapper can name a profile or contract id; the catalog's action is
    // the generic fallback.
    expect(payload.action).toBe('Switch to profile "publisher".');
  });

  it("falls back to the catalog action with no mapping", () => {
    const payload = toolErrorPayload({ error: new Error("Unknown tool: x"), summary: "Failed" });

    expect(payload.action).toBe(ERROR_CODES.MV_TOOL_UNKNOWN.action);
  });

  it("includes the correlation id when one is supplied", () => {
    const payload = toolErrorPayload({
      error: new Error("x"),
      summary: "Failed",
      correlationId: "mv-abc-0001",
    });

    expect(payload.correlationId).toBe("mv-abc-0001");
  });

  it("omits the correlation id when there is none", () => {
    const payload = toolErrorPayload({ error: new Error("x"), summary: "Failed" });

    expect(payload).not.toHaveProperty("correlationId");
  });

  it("nulls the source and status for a local failure", () => {
    const payload = toolErrorPayload({ error: new Error("Unknown tool: x"), summary: "Failed" });

    expect(payload.source).toBeNull();
    expect(payload.status).toBeNull();
  });

  it("always produces a valid code", () => {
    for (const error of [new Error("anything"), "a string", null, 42, {}]) {
      const payload = toolErrorPayload({ error, summary: "Failed" });
      expect(isErrorCode(payload.code), `no code for ${String(error)}`).toBe(true);
    }
  });
});

describe("formatCodeSuffix", () => {
  it("renders a bracketed suffix", () => {
    expect(formatCodeSuffix("MV_TIMEOUT")).toBe(" [MV_TIMEOUT]");
  });
});

describe("docs/mcp-error-codes.md — staleness guard", () => {
  const doc = readFileSync(
    join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "docs", "mcp-error-codes.md"),
    "utf-8",
  );

  /** Codes appearing in the catalog table. Padding-tolerant: prettier aligns
   * markdown table columns, so the pipes are not flush against the cell. */
  const documented = [...doc.matchAll(/^\|\s*`(MV_[A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);

  const docLines = doc.split("\n");

  /** The table row for one code, tolerating prettier's column padding. */
  const rowFor = (code: string): string | undefined =>
    docLines.find((line) => new RegExp(`^\\|\\s*\`${code}\`\\s*\\|`).test(line));

  it("documents every code", () => {
    // A code an agent can receive but cannot look up is a code that will be
    // guessed at.
    for (const code of ALL_ERROR_CODES) {
      expect(documented, `${code} is not in the catalog table`).toContain(code);
    }
  });

  it("documents no code the build does not define", () => {
    expect(documented.length).toBeGreaterThan(0);
    for (const code of documented) {
      expect(isErrorCode(code), `${code} is documented but not defined`).toBe(true);
    }
  });

  it("states the category the code actually assigns", () => {
    for (const code of ALL_ERROR_CODES) {
      const row = rowFor(code);
      expect(row, `${code} has no table row`).toBeDefined();
      expect(row, `${code} documents the wrong category`).toContain(
        `\`${ERROR_CODES[code].category}\``,
      );
    }
  });

  it("states the retry safety the code actually assigns", () => {
    const marks: Record<string, string> = {
      safe: "✅ safe",
      unsafe: "❌ unsafe",
      conditional: "⚠️ check first",
    };
    for (const code of ALL_ERROR_CODES) {
      const row = rowFor(code);
      expect(row, `${code} has no table row`).toBeDefined();
      expect(row, `${code} documents the wrong retry safety`).toContain(
        marks[ERROR_CODES[code].retry],
      );
    }
  });
});
