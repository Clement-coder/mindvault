/**
 * Unit tests for outbound request correlation (#849).
 *
 * These tests verify that:
 * - Every outbound request gets an x-request-id header
 * - The id is bound to the tool call scope (AsyncLocalStorage)
 * - A process-wide fallback id is used outside any scope
 * - The MINDVAULT_CORRELATION_ID env var overrides the process-wide id
 * - The fetch wrapper stamps headers correctly
 * - An explicit header is not overwritten
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CORRELATION_HEADER,
  CORRELATION_ENV_VAR,
  newCorrelationId,
  resolveProcessCorrelationId,
  currentCorrelationId,
  runWithCorrelationId,
  withNewCorrelationId,
  correlationHeaders,
  stampCorrelation,
  withCorrelation,
} from "./correlation.js";

describe("correlation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env[CORRELATION_ENV_VAR];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("newCorrelationId", () => {
    it("returns a UUID v4 string", () => {
      const id = newCorrelationId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("generates unique ids", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(newCorrelationId());
      expect(ids.size).toBe(100);
    });
  });

  describe("resolveProcessCorrelationId", () => {
    it("returns a lazily created process-wide id when env var is unset", () => {
      const id1 = resolveProcessCorrelationId();
      const id2 = resolveProcessCorrelationId();
      expect(id1).toBe(id2); // Same id on repeated calls
      expect(id1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("returns the configured env var value when set", () => {
      process.env[CORRELATION_ENV_VAR] = "my-custom-correlation-id";
      expect(resolveProcessCorrelationId()).toBe("my-custom-correlation-id");
    });

    it("trims whitespace from the env var", () => {
      process.env[CORRELATION_ENV_VAR] = "  trimmed-id  ";
      expect(resolveProcessCorrelationId()).toBe("trimmed-id");
    });

    it("ignores empty env var and falls back to generated id", () => {
      process.env[CORRELATION_ENV_VAR] = "   ";
      const id = resolveProcessCorrelationId();
      expect(id).not.toBe("");
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("currentCorrelationId", () => {
    it("returns the process-wide fallback outside any scope", () => {
      const id = currentCorrelationId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("returns the scope id inside runWithCorrelationId", () => {
      const scopeId = "test-scope-id";
      const result = runWithCorrelationId(scopeId, () => currentCorrelationId());
      expect(result).toBe(scopeId);
    });

    it("returns the scope id inside withNewCorrelationId", () => {
      const result = withNewCorrelationId(() => currentCorrelationId());
      expect(result).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("nested scopes: inner scope wins", () => {
      const outer = "outer-id";
      const inner = "inner-id";
      const result = runWithCorrelationId(outer, () =>
        runWithCorrelationId(inner, () => currentCorrelationId()),
      );
      expect(result).toBe(inner);
    });

    it("scope is async-local: concurrent calls don't leak", async () => {
      const results = await Promise.all([
        withNewCorrelationId(() =>
          Promise.resolve().then(() => currentCorrelationId()),
        ),
        withNewCorrelationId(() =>
          Promise.resolve().then(() => currentCorrelationId()),
        ),
      ]);
      expect(results[0]).not.toBe(results[1]);
    });
  });

  describe("correlationHeaders", () => {
    it("adds x-request-id to an empty header bag", () => {
      const headers = correlationHeaders();
      expect(headers[CORRELATION_HEADER]).toBeDefined();
      expect(Object.keys(headers)).toHaveLength(1);
    });

    it("merges extra headers and adds x-request-id last", () => {
      const headers = correlationHeaders({ "x-custom": "value" });
      expect(headers["x-custom"]).toBe("value");
      expect(headers[CORRELATION_HEADER]).toBeDefined();
      // x-request-id should be last (ownership semantics)
      const keys = Object.keys(headers);
      expect(keys[keys.length - 1]).toBe(CORRELATION_HEADER);
    });

    it("does not mutate the input object", () => {
      const extra = { "x-custom": "value" };
      correlationHeaders(extra);
      expect(extra).toEqual({ "x-custom": "value" });
    });
  });

  describe("stampCorrelation", () => {
    it("adds x-request-id to RequestInit when missing", () => {
      const init = stampCorrelation({ method: "GET" });
      expect(init.headers).toBeDefined();
      expect((init.headers as Record<string, string>)[CORRELATION_HEADER]).toBeDefined();
    });

    it("does not overwrite an existing x-request-id (any case)", () => {
      const explicitId = "explicit-correlation-id";
      const init = stampCorrelation({
        method: "GET",
        headers: { "X-Request-Id": explicitId },
      });
      expect((init.headers as Record<string, string>)[CORRELATION_HEADER]).toBe(explicitId);
    });

    it("preserves other headers", () => {
      const init = stampCorrelation({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect((init.headers as Record<string, string>)[CORRELATION_HEADER]).toBeDefined();
    });

    it("returns the same object when header already present", () => {
      const originalHeaders = { "x-request-id": "existing" };
      const init = { headers: originalHeaders };
      const result = stampCorrelation(init);
      expect(result.headers).toBe(originalHeaders);
    });

    it("handles undefined init", () => {
      const init = stampCorrelation(undefined);
      expect((init.headers as Record<string, string>)[CORRELATION_HEADER]).toBeDefined();
    });
  });

  describe("withCorrelation", () => {
    it("wraps fetch and stamps correlation header on every call", async () => {
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_input, init) => {
        capturedInit = init;
        return new Response("ok", { status: 200 });
      });
      const wrapped = withCorrelation(mockFetch);

      await wrapped("https://example.com/api", { method: "GET" });

      expect(capturedInit).toBeDefined();
      expect((capturedInit!.headers as Record<string, string>)[CORRELATION_HEADER]).toBeDefined();
    });

    it("does not overwrite explicit header in the call", async () => {
      const explicitId = "call-specific-id";
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_input, init) => {
        capturedInit = init;
        return new Response("ok", { status: 200 });
      });
      const wrapped = withCorrelation(mockFetch);

      await wrapped("https://example.com/api", {
        method: "GET",
        headers: { "x-request-id": explicitId },
      });

      expect((capturedInit!.headers as Record<string, string>)[CORRELATION_HEADER]).toBe(explicitId);
    });

    it("uses the ambient scope id", async () => {
      const scopeId = "ambient-scope-id";
      let capturedInit: RequestInit | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_input, init) => {
        capturedInit = init;
        return new Response("ok", { status: 200 });
      });
      const wrapped = withCorrelation(mockFetch);

      await runWithCorrelationId(scopeId, () =>
        wrapped("https://example.com/api", { method: "GET" }),
      );

      expect((capturedInit!.headers as Record<string, string>)[CORRELATION_HEADER]).toBe(scopeId);
    });
  });

  describe("constants", () => {
    it("CORRELATION_HEADER is x-request-id", () => {
      expect(CORRELATION_HEADER).toBe("x-request-id");
    });

    it("CORRELATION_ENV_VAR is MINDVAULT_CORRELATION_ID", () => {
      expect(CORRELATION_ENV_VAR).toBe("MINDVAULT_CORRELATION_ID");
    });
  });
});