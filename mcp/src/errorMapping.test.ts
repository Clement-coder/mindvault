/**
 * Unit tests for structured MCP error mapping (#407).
 *
 * Covers the four failure classes called out in the issue — network failure,
 * 402 payment, contract NotFound, and validation — plus the guarantee that the
 * mapping is deterministic and always carries a next step.
 */
import { describe, it, expect } from "vitest";
import {
  isRevokedApiKey,
  categorizeStatus,
  extractDetail,
  formatMappedError,
  isTimeoutError,
  mapHttpError,
  mapRegistryError,
  mapTransportError,
  mcpError,
  troubleshootingHint,
  throwHttpError,
  type ErrorCategory,
} from "./errorMapping.js";

describe("categorizeStatus", () => {
  it("maps the statuses the MindVault surface actually returns", () => {
    expect(categorizeStatus(400)).toBe("validation");
    expect(categorizeStatus(401)).toBe("auth");
    expect(categorizeStatus(402)).toBe("payment");
    expect(categorizeStatus(403)).toBe("auth");
    expect(categorizeStatus(404)).toBe("not_found");
    expect(categorizeStatus(408)).toBe("timeout");
    expect(categorizeStatus(409)).toBe("conflict");
    expect(categorizeStatus(422)).toBe("validation");
    expect(categorizeStatus(429)).toBe("rate_limit");
    expect(categorizeStatus(500)).toBe("server");
    expect(categorizeStatus(503)).toBe("server");
    expect(categorizeStatus(504)).toBe("timeout");
  });

  it("falls back deterministically outside the known ranges", () => {
    expect(categorizeStatus(418)).toBe("validation");
    expect(categorizeStatus(200)).toBe("unknown");
  });
});

describe("extractDetail", () => {
  it("prefers the conventional error fields in order", () => {
    expect(extractDetail({ error: "boom" })).toBe("boom");
    expect(extractDetail({ message: "nope" })).toBe("nope");
    expect(extractDetail({ detail: "why" })).toBe("why");
    expect(extractDetail({ reason: "because" })).toBe("because");
    expect(extractDetail({ error: "first", message: "second" })).toBe("first");
  });

  it("falls back to the raw payload rather than dropping server detail", () => {
    expect(extractDetail({ unexpected: 1 })).toBe('{"unexpected":1}');
    expect(extractDetail("plain text")).toBe("plain text");
  });

  it("describes empty and missing bodies explicitly", () => {
    expect(extractDetail(null)).toBe("no response body");
    expect(extractDetail(undefined)).toBe("no response body");
    expect(extractDetail("   ")).toBe("empty response body");
  });
});

describe("isTimeoutError", () => {
  it("recognises aborts and timeouts", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeout = new Error("slow");
    timeout.name = "TimeoutError";

    expect(isTimeoutError(abort)).toBe(true);
    expect(isTimeoutError(timeout)).toBe(true);
    expect(isTimeoutError(new Error("request timed out after 15000ms"))).toBe(true);
  });

  it("does not treat ordinary network errors as timeouts", () => {
    expect(isTimeoutError(new Error("fetch failed"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError("string")).toBe(false);
  });
});

describe("mapTransportError — network failure", () => {
  it("keeps a Horizon HTTP 500 as an upstream server outage", () => {
    const mapped = mapHttpError({
      operation: "Horizon request failed",
      source: "horizon",
      status: 500,
      data: { error: "Horizon unavailable" },
    });
    expect(mapped.category).toBe("server");
    expect(formatMappedError(mapped)).toContain("Source: Horizon · Category: server · HTTP 500");
  });

  it("keeps a Soroban timeout as a timeout, not a network outage", () => {
    const error = new Error("request timed out");
    error.name = "TimeoutError";
    const mapped = mapTransportError({ operation: "RPC failed", source: "soroban", error });
    expect(mapped.category).toBe("timeout");
    expect(formatMappedError(mapped)).toContain("Source: Soroban RPC · Category: timeout");
  });

  it("classifies an unreachable service as a network error", () => {
    const mapped = mapTransportError({
      operation: "MindVault API request failed",
      source: "api",
      error: new Error("fetch failed"),
    });

    expect(mapped.category).toBe("network");
    expect(mapped.source).toBe("api");
    expect(mapped.status).toBeUndefined();
    expect(mapped.summary).toContain("fetch failed");
    expect(mapped.action).toContain("connectivity");
  });

  it("separates a timeout from a plain network failure", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";

    const mapped = mapTransportError({
      operation: "Horizon request failed",
      source: "horizon",
      error: abort,
    });

    expect(mapped.category).toBe("timeout");
    expect(mapped.action).toContain("MINDVAULT_HTTP_TIMEOUT_MS");
  });

  it("preserves the underlying cause in the summary", () => {
    const mapped = mapTransportError({
      operation: "Browse failed",
      source: "api",
      error: new Error("ECONNREFUSED 127.0.0.1:4021"),
    });
    expect(mapped.summary).toBe("Browse failed: ECONNREFUSED 127.0.0.1:4021");
  });
});

describe("mapHttpError — 402 payment", () => {
  it("classifies a 402 as payment and points at the wallet", () => {
    const mapped = mapHttpError({
      operation: "Buy failed [402]",
      source: "x402",
      status: 402,
      data: { error: "payment rejected" },
    });

    expect(mapped.category).toBe("payment");
    expect(mapped.source).toBe("x402");
    expect(mapped.status).toBe(402);
    expect(mapped.summary).toBe("Buy failed [402]: payment rejected");
    expect(mapped.action).toContain("mindvault_wallet_info");
    expect(mapped.action).toContain("USDC");
  });
});

describe("mapHttpError — validation", () => {
  it("classifies a 400 as validation and tells the agent to fix arguments", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 400,
      data: { error: "price must be a positive decimal string" },
    });

    expect(mapped.category).toBe("validation");
    expect(mapped.summary).toContain("price must be a positive decimal string");
    expect(mapped.action).toContain("Correct the invalid arguments");
  });

  it("classifies a 422 the same way", () => {
    expect(
      mapHttpError({ operation: "Publish failed", source: "api", status: 422, data: {} }).category,
    ).toBe("validation");
  });
});

describe("mapRegistryError — contract NotFound", () => {
  it("classifies a missing registry entry as not_found with a registration path", () => {
    const mapped = mapRegistryError({
      operation: "Registry lookup",
      message: "Resource not found",
      notFound: true,
    });

    expect(mapped.category).toBe("not_found");
    expect(mapped.source).toBe("registry");
    expect(mapped.action).toContain("mindvault_register_onchain");
    expect(mapped.action).toContain("not registered on-chain");
  });

  it("classifies any other contract failure as a contract error", () => {
    const mapped = mapRegistryError({
      operation: 'Contract error for resource "res-1"',
      message: "Unauthorized",
    });

    expect(mapped.category).toBe("contract");
    expect(mapped.action).toContain("mindvault_registry_info");
  });

  it("can attribute JSON-RPC level failures to Soroban instead of the contract", () => {
    const mapped = mapRegistryError({
      operation: "RPC error",
      message: '{"code":-32602}',
      source: "soroban",
    });
    expect(mapped.source).toBe("soroban");
    expect(formatMappedError(mapped)).toContain("Source: Soroban RPC");
  });
});

describe("formatMappedError", () => {
  it("renders summary, machine-readable classification, and next step", () => {
    const text = formatMappedError(
      mapHttpError({
        operation: "Browse failed",
        source: "api",
        status: 500,
        data: { error: "Internal server error" },
      }),
    );

    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("Browse failed: Internal server error");
    expect(text).toContain("Source: MindVault API · Category: server · HTTP 500");
    expect(text).toMatch(/^Next: /m);
  });

  it("omits the HTTP segment when there is no status", () => {
    const text = formatMappedError(
      mapTransportError({ operation: "Browse failed", source: "api", error: new Error("boom") }),
    );
    expect(text).toContain("Source: MindVault API · Category: network");
    expect(text).not.toContain("HTTP");
  });

  it("is deterministic for the same input", () => {
    const build = () =>
      formatMappedError(
        mapHttpError({ operation: "Preview failed", source: "api", status: 404, data: {} }),
      );
    expect(build()).toBe(build());
  });

  it("always supplies a non-empty next step for every category", () => {
    const categories: ErrorCategory[] = [
      "network",
      "timeout",
      "payment",
      "validation",
      "auth",
      "not_found",
      "conflict",
      "rate_limit",
      "server",
      "contract",
      "unknown",
    ];
    const statuses = [0, 408, 402, 400, 401, 404, 409, 429, 500];
    for (const status of statuses) {
      const mapped = mapHttpError({ operation: "op", source: "api", status, data: {} });
      expect(categories).toContain(mapped.category);
      expect(mapped.action.length).toBeGreaterThan(0);
    }
  });
});

describe("troubleshootingHint", () => {
  it("returns a stable machine-readable payload without requiring text parsing", () => {
    expect(
      troubleshootingHint(
        mapHttpError({
          operation: "Browse failed",
          source: "api",
          status: 429,
          data: { error: "too many requests" },
        }),
      ),
    ).toEqual({
      schema: "mindvault.troubleshooting/v1",
      source: "api",
      category: "rate_limit",
      status: 429,
      summary: "Browse failed: too many requests",
      detail: "too many requests",
      action: "Rate limited. Wait for the window to pass before retrying.",
    });
  });

  it("uses null for fields that do not apply to transport errors", () => {
    const hint = troubleshootingHint(
      mapTransportError({ operation: "Browse failed", source: "api", error: new Error("offline") }),
    );
    expect(hint.status).toBeNull();
    expect(hint.detail).toBe("offline");
  });
});

describe("mcpError / throwHttpError", () => {
  it("produces a throwable carrying the formatted text", () => {
    const err = mcpError(
      mapHttpError({ operation: "Search failed", source: "api", status: 503, data: {} }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Search failed");
    expect(err.message).toContain("Category: server");
  });

  it("throwHttpError throws rather than returning", () => {
    expect(() =>
      throwHttpError({ operation: "Register failed", source: "api", status: 401, data: {} }),
    ).toThrow("Category: auth");
  });
});

describe("publisher API key rejection", () => {
  const credential = { kind: "publisher_api_key", profile: "publisher" } as const;

  it("flags a 401 that carried a stored publisher key as revoked", () => {
    expect(isRevokedApiKey(401, credential)).toBe(true);
  });

  it("does not flag a 401 from a request that carried no credential", () => {
    expect(isRevokedApiKey(401, undefined)).toBe(false);
  });

  it("does not flag a 403 — the key was recognised, the operation was not allowed", () => {
    expect(isRevokedApiKey(403, credential)).toBe(false);
  });

  it("names the profile and the way back when the stored key is rejected", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 401,
      data: { error: "Invalid API key" },
      credential,
    });

    expect(mapped.category).toBe("auth");
    expect(mapped.summary).toContain("Publish failed: Invalid API key");
    expect(mapped.summary).toContain('publisher API key for profile "publisher" was rejected');
    expect(mapped.action).toContain("revoked");
    expect(mapped.action).toContain("mindvault_register");
    expect(mapped.action).toContain("mindvault_use_profile");
    expect(mapped.action).toContain("mindvault_restore_state");
  });

  it("keeps the generic advice when no credential was sent", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 401,
      data: { error: "Missing x-api-key header" },
    });

    expect(mapped.action).toContain("Credentials are missing or not accepted");
    expect(mapped.summary).not.toContain("was rejected as unknown");
  });

  it("distinguishes a valid-but-unauthorized key from a revoked one", () => {
    const mapped = mapHttpError({
      operation: "On-chain registration failed",
      source: "api",
      status: 403,
      data: { error: "Not the owner" },
      credential,
    });

    expect(mapped.category).toBe("auth");
    expect(mapped.action).toContain("valid but not authorized");
    expect(mapped.action).toContain("different publisher");
    expect(mapped.action).not.toContain("revoked");
  });

  it("leaves non-auth statuses untouched when a credential is present", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 500,
      data: { error: "boom" },
      credential,
    });

    expect(mapped.category).toBe("server");
    expect(mapped.action).toContain("The upstream service is failing");
  });

  it("renders the revoked case as the standard three-line agent error", () => {
    expect(() =>
      throwHttpError({
        operation: "Publish failed",
        source: "api",
        status: 401,
        data: { error: "Invalid API key" },
        credential,
      }),
    ).toThrow(/Source: MindVault API · Category: auth · HTTP 401/);
  });
});

describe("request signature clock-skew rejection (#602)", () => {
  const credential = { kind: "publisher_api_key", profile: "publisher" } as const;
  const skewBody = { error: "Request timestamp outside allowed window" };

  it("is diagnosed as clock skew rather than a revoked key", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 401,
      data: skewBody,
      credential,
    });

    expect(mapped.category).toBe("auth");
    expect(mapped.status).toBe(401);
    expect(mapped.summary).toContain("Request timestamp outside allowed window");
    expect(mapped.summary).toContain("outside the allowed window");
    expect(mapped.summary).not.toContain("was rejected as unknown");
    expect(mapped.action).toContain("clock");
  });

  it("tells the agent to sync the system clock within the documented window", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 401,
      data: skewBody,
      credential,
    });

    expect(mapped.action).toContain("5-minute");
    expect(mapped.action).toContain("Sync the system clock");
    expect(mapped.action).toContain("NTP");
    expect(mapped.action).not.toContain("revoked");
    expect(mapped.action).not.toContain("mindvault_register");
  });

  it("does not misdiagnose a plain invalid-key 401 as skew", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 401,
      data: { error: "Invalid API key" },
      credential,
    });

    expect(mapped.summary).toContain("was rejected as unknown");
    expect(mapped.action).not.toContain("NTP");
  });

  it("keeps the skew classification even when no credential was sent", () => {
    const mapped = mapHttpError({
      operation: "Publish failed",
      source: "api",
      status: 401,
      data: skewBody,
    });

    expect(mapped.summary).toContain("outside the allowed window");
    expect(mapped.action).toContain("NTP");
  });
});
