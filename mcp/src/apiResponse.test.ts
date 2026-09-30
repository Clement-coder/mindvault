/**
 * Unit tests for the typed API response wrapper (#587).
 *
 * Covers the discriminated union type, type-guard helper, unwrap helper,
 * and error-mapping convenience function.
 */
import { describe, it, expect } from "vitest";
import {
  type ApiResponse,
  type ApiOk,
  type ApiErr,
  isApiOk,
  unwrapOk,
  mapApiError,
} from "./apiResponse.js";

function okResponse<T>(data: T, status = 200): ApiOk<T> {
  return { ok: true, status, data, headers: {} };
}

function errResponse(status: number, data: unknown = {}): ApiErr {
  return { ok: false, status, data, headers: {} };
}

describe("isApiOk", () => {
  it("returns true for ok responses", () => {
    expect(isApiOk(okResponse({ id: 1 }))).toBe(true);
  });

  it("returns false for error responses", () => {
    expect(isApiOk(errResponse(404))).toBe(false);
  });

  it("narrows the type so data properties are accessible", () => {
    const res: ApiResponse<{ name: string }> = okResponse({ name: "test" });
    if (isApiOk(res)) {
      // TypeScript should allow res.data.name here
      expect(res.data.name).toBe("test");
    }
  });
});

describe("unwrapOk", () => {
  it("returns data for ok responses", () => {
    const data = { apiKey: "abc-123" };
    expect(unwrapOk(okResponse(data))).toEqual(data);
  });

  it("throws for error responses", () => {
    expect(() => unwrapOk(errResponse(500))).toThrow("API request failed with status 500");
  });

  it("throws with the correct status code", () => {
    expect(() => unwrapOk(errResponse(404))).toThrow("404");
  });
});

describe("mapApiError", () => {
  it("maps an error response into the throwHttpError shape", () => {
    const res = errResponse(402, { error: "payment rejected" });
    const mapped = mapApiError(res, "Buy failed", "x402");

    expect(mapped.operation).toBe("Buy failed");
    expect(mapped.source).toBe("x402");
    expect(mapped.status).toBe(402);
    expect(mapped.data).toEqual({ error: "payment rejected" });
  });

  it("accepts all valid error sources", () => {
    const sources = ["api", "x402", "horizon", "soroban", "registry", "sponsored"] as const;
    for (const source of sources) {
      const mapped = mapApiError(errResponse(500), "op", source);
      expect(mapped.source).toBe(source);
    }
  });

  it("preserves raw data for downstream extractDetail", () => {
    const res = errResponse(400, { detail: "price must be positive" });
    const mapped = mapApiError(res, "Publish failed", "api");
    expect(mapped.data).toEqual({ detail: "price must be positive" });
  });
});

describe("ApiResponse type contract", () => {
  it("ok and err are mutually exclusive", () => {
    const ok: ApiResponse<{ id: number }> = okResponse({ id: 1 });
    const err: ApiResponse<{ id: number }> = errResponse(500);

    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
  });

  it("status is always present", () => {
    const ok = okResponse("data", 201);
    const err = errResponse(422);
    expect(ok.status).toBe(201);
    expect(err.status).toBe(422);
  });

  it("headers is always present", () => {
    const ok = okResponse("data");
    const err = errResponse(500);
    expect(typeof ok.headers).toBe("object");
    expect(typeof err.headers).toBe("object");
  });
});
