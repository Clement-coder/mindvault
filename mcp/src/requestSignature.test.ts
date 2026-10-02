/**
 * Unit tests for publisher request signing and clock-skew diagnostics (#602).
 *
 * A signing timestamp is `nowMs / 1000` floored, so every header is a
 * deterministic function of (api key, verb, path, body, idempotency key,
 * now). Tests pin the exact wire bytes an operator can reproduce with the curl
 * recipe in docs/request-signature.md, and assert that a server clock-skew
 * rejection is recognisable separately from a bad HMAC or missing header.
 */
import { createHash, createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  EMPTY_BODY_HASH,
  CLOCK_SKEW_WINDOW_MS,
  buildCanonicalString,
  hashRequestBody,
  isClockSkewRejection,
  signMutatingHeaders,
  signPublisherRequestHeaders,
} from "./requestSignature.js";

const API_KEY = "mv_test_secret";
const NOW_MS = 1_700_000_000_123; // a fixed epoch, in ms
const NOW_SECONDS = String(Math.floor(NOW_MS / 1000)); // "1700000000"

function expectedSignature(params: {
  method: string;
  path: string;
  bodyHash: string;
  idemKey?: string;
}): string {
  const canonical = buildCanonicalString({
    method: params.method,
    path: params.path,
    timestamp: NOW_SECONDS,
    bodyHash: params.bodyHash,
    idempotencyKey: params.idemKey,
  });
  return createHmac("sha256", API_KEY).update(canonical, "utf8").digest("hex");
}

describe("hashRequestBody / EMPTY_BODY_HASH", () => {
  it("EMPTY_BODY_HASH is the documented SHA-256 of the empty string", () => {
    // docs/request-signature.md pins this exact value for empty bodies.
    expect(EMPTY_BODY_HASH).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes the exact bytes of the body", () => {
    expect(hashRequestBody("{}")).toHaveLength(64);
    expect(hashRequestBody("{}")).toBe(createHash("sha256").update("{}", "utf8").digest("hex"));
  });
});

describe("buildCanonicalString", () => {
  it("joins method, path, timestamp, and body hash with newlines", () => {
    expect(
      buildCanonicalString({
        method: "POST",
        path: "/resources/abc/register",
        timestamp: NOW_SECONDS,
        bodyHash: EMPTY_BODY_HASH,
      }),
    ).toBe(`POST\n/resources/abc/register\n${NOW_SECONDS}\n${EMPTY_BODY_HASH}`);
  });

  it("appends the idempotency key only when it is present", () => {
    const base = {
      method: "DELETE",
      path: "/resources/abc",
      timestamp: NOW_SECONDS,
      bodyHash: EMPTY_BODY_HASH,
    };
    expect(buildCanonicalString(base)).toBe(
      `DELETE\n/resources/abc\n${NOW_SECONDS}\n${EMPTY_BODY_HASH}`,
    );
    expect(buildCanonicalString({ ...base, idempotencyKey: "idem-1" })).toBe(
      `DELETE\n/resources/abc\n${NOW_SECONDS}\n${EMPTY_BODY_HASH}\nidem-1`,
    );
  });
});

describe("signPublisherRequestHeaders", () => {
  const body = JSON.stringify({ title: "hello", price: "5.00" });

  it("signs deterministically from an injected clock", () => {
    const headers = signPublisherRequestHeaders({
      apiKey: API_KEY,
      method: "POST",
      path: "/resources",
      body,
      nowMs: NOW_MS,
    });
    expect(headers["X-Timestamp"]).toBe(NOW_SECONDS);
    expect(headers["X-Signature"]).toBe(
      expectedSignature({ method: "POST", path: "/resources", bodyHash: hashRequestBody(body) }),
    );
  });

  it("signs an empty body with the documented empty-body hash", () => {
    const headers = signPublisherRequestHeaders({
      apiKey: API_KEY,
      method: "DELETE",
      path: "/resources/abc",
      nowMs: NOW_MS,
    });
    expect(headers["X-Signature"]).toBe(
      expectedSignature({ method: "DELETE", path: "/resources/abc", bodyHash: EMPTY_BODY_HASH }),
    );
  });

  it("includes the idempotency key in the signed canonical string", () => {
    const headers = signPublisherRequestHeaders({
      apiKey: API_KEY,
      method: "POST",
      path: "/resources",
      nowMs: NOW_MS,
      idempotencyKey: "idem-xyz",
    });
    expect(headers["X-Signature"]).toBe(
      expectedSignature({
        method: "POST",
        path: "/resources",
        bodyHash: EMPTY_BODY_HASH,
        idemKey: "idem-xyz",
      }),
    );
  });

  it("changes the signature when the clock skews", () => {
    const atStart = signPublisherRequestHeaders({
      apiKey: API_KEY,
      method: "POST",
      path: "/resources",
      body,
      nowMs: NOW_MS,
    });
    // 10 minutes later — beyond the 5-minute server window.
    const skewed = signPublisherRequestHeaders({
      apiKey: API_KEY,
      method: "POST",
      path: "/resources",
      body,
      nowMs: NOW_MS + CLOCK_SKEW_WINDOW_MS * 2,
    });
    expect(skewed["X-Timestamp"]).not.toBe(atStart["X-Timestamp"]);
    expect(skewed["X-Signature"]).not.toBe(atStart["X-Signature"]);
  });

  it("changes the signature when the body changes", () => {
    const a = signPublisherRequestHeaders({
      apiKey: API_KEY,
      method: "POST",
      path: "/resources",
      body: '{"price":"1.00"}',
      nowMs: NOW_MS,
    });
    const b = signPublisherRequestHeaders({
      apiKey: API_KEY,
      method: "POST",
      path: "/resources",
      body: '{"price":"2.00"}',
      nowMs: NOW_MS,
    });
    expect(b["X-Signature"]).not.toBe(a["X-Signature"]);
  });
});

describe("signMutatingHeaders", () => {
  const url = "https://api.example.com/resources/abc/register";

  it("signs mutating verbs when an api key is present", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const headers = signMutatingHeaders(url, method, { "x-api-key": API_KEY }, undefined, NOW_MS);
      expect(headers["X-Timestamp"]).toBe(NOW_SECONDS);
      expect(headers["X-Signature"]).toBeTruthy();
    }
  });

  it("leaves read-only verbs unsigned", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const headers = signMutatingHeaders(url, method, { "x-api-key": API_KEY }, undefined, NOW_MS);
      expect(headers["X-Signature"]).toBeUndefined();
      expect(headers["X-Timestamp"]).toBeUndefined();
    }
  });

  it("does not sign when there is no api key", () => {
    const headers = signMutatingHeaders(url, "POST", {}, "{}", NOW_MS);
    expect(headers).toEqual({});
  });

  it("carries the idempotency key into the signature when present", () => {
    const headers = signMutatingHeaders(
      url,
      "POST",
      { "x-api-key": API_KEY, "Idempotency-Key": "idem-1" },
      undefined,
      NOW_MS,
    );
    expect(headers["X-Signature"]).toBe(
      expectedSignature({
        method: "POST",
        path: "/resources/abc/register",
        bodyHash: EMPTY_BODY_HASH,
        idemKey: "idem-1",
      }),
    );
  });
});

describe("isClockSkewRejection", () => {
  it("recognises the exact server message for a timestamp outside the window", () => {
    expect(isClockSkewRejection(401, "Request timestamp outside allowed window")).toBe(true);
  });

  it("is case-insensitive and matches body variants", () => {
    expect(isClockSkewRejection(401, `{"error": "request timestamp OUTSIDE allowed window"}`)).toBe(
      true,
    );
  });

  it("does not misread other signing 401s as clock skew", () => {
    for (const detail of [
      "Invalid request signature",
      "Missing X-Timestamp header",
      "Missing X-Signature header",
      "Invalid API key",
    ]) {
      expect(isClockSkewRejection(401, detail)).toBe(false);
    }
  });

  it("requires both a 401 status and the window wording", () => {
    expect(isClockSkewRejection(403, "Request timestamp outside allowed window")).toBe(false);
    expect(isClockSkewRejection(500, "Request timestamp outside allowed window")).toBe(false);
  });
});
