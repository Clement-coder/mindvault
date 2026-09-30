import { createHash, createHmac } from "node:crypto";

export const EMPTY_BODY_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

/**
 * Server-side tolerance for signature timestamps. This mirrors the
 * `SIGNATURE_MAX_SKEW_MS` default on the server (5 minutes); a signed request
 * timestamp further from the server clock is rejected with a 401. Exposed here
 * so client-side skew diagnostics quote the same window.
 */
export const CLOCK_SKEW_WINDOW_MS = 300_000;

/**
 * Whether a 401 names the clock-skew rejection the request-signature
 * middleware emits. Everything else on a signed request (missing header, bad
 * HMAC) is a signing bug, not a system-clock problem, so it must not be
 * misdiagnosed as skew.
 */
export function isClockSkewRejection(status: number, detail: string): boolean {
  return status === 401 && /timestamp outside allowed window/i.test(detail);
}

export function hashRequestBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function buildCanonicalString(params: {
  method: string;
  path: string;
  timestamp: string;
  bodyHash: string;
  idempotencyKey?: string;
}): string {
  const parts = [params.method.toUpperCase(), params.path, params.timestamp, params.bodyHash];
  if (params.idempotencyKey) {
    parts.push(params.idempotencyKey);
  }
  return parts.join("\n");
}

export function signPublisherRequestHeaders(params: {
  apiKey: string;
  method: string;
  path: string;
  body?: string;
  idempotencyKey?: string;
  /** Injectable clock (ms epoch) so signatures are deterministic in tests. */
  nowMs?: number;
}): Record<string, string> {
  const timestamp = Math.floor((params.nowMs ?? Date.now()) / 1000).toString();
  const bodyHash = params.body ? hashRequestBody(params.body) : EMPTY_BODY_HASH;
  const canonical = buildCanonicalString({
    method: params.method,
    path: params.path,
    timestamp,
    bodyHash,
    idempotencyKey: params.idempotencyKey,
  });
  const signature = createHmac("sha256", params.apiKey).update(canonical, "utf8").digest("hex");
  return {
    "X-Timestamp": timestamp,
    "X-Signature": signature,
  };
}

export function signMutatingHeaders(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  nowMs?: number,
): Record<string, string> {
  const apiKey = headers["x-api-key"];
  if (!apiKey) {
    return headers;
  }

  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  if (!mutating) {
    return headers;
  }

  const parsed = new URL(url);
  const path = parsed.pathname + parsed.search;
  const signatureHeaders = signPublisherRequestHeaders({
    apiKey,
    method,
    path,
    body,
    idempotencyKey: headers["Idempotency-Key"],
    nowMs,
  });

  return { ...headers, ...signatureHeaders };
}
