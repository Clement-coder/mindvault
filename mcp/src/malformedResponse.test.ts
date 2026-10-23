/**
 * Tests for non-JSON upstream responses — issue #1019.
 *
 * A proxy, gateway or WAF that answers with HTML or plain text used to put
 * its markup straight into the error an agent reads, including anything it
 * echoed back. These tests pin down that the body becomes a typed marker
 * instead: the status and the upstream's request id survive, the raw body
 * does not, and secrets inside it are redacted before they can travel.
 */
import { describe, it, expect } from "vitest";

import {
  MALFORMED_RESPONSE_EXCERPT_LIMIT,
  MALFORMED_RESPONSE_MARKER,
  describeMalformedResponse,
  isMalformedResponseBody,
  malformedResponseBody,
  malformedResponseExcerpt,
  parseUpstreamErrorBody,
  responseHeaderBag,
  responseRequestId,
} from "./malformedResponse.js";
import { extractDetail, mapHttpError, troubleshootingHint } from "./errorMapping.js";
import { codeForMappedError } from "./errorCodes.js";

const HTML_BODY = `<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>`;

describe("malformedResponse", () => {
  it("describes a non-JSON body with its status, request id and size", () => {
    const body = malformedResponseBody({
      status: 502,
      headers: { "content-type": "text/html", "x-request-id": "req-42" },
      body: HTML_BODY,
    });

    expect(body.marker).toBe(MALFORMED_RESPONSE_MARKER);
    expect(body.status).toBe(502);
    expect(body.requestId).toBe("req-42");
    expect(body.contentType).toBe("text/html");
    expect(body.bodyBytes).toBe(Buffer.byteLength(HTML_BODY, "utf8"));
    expect(isMalformedResponseBody(body)).toBe(true);
  });

  it("keeps the upstream's request id out of the excerpt and in the marker", () => {
    const body = malformedResponseBody({
      status: 503,
      headers: { "x-request-id": "req-7" },
      body: HTML_BODY,
    });
    expect(body.requestId).toBe("req-7");
    expect(body.excerpt).not.toContain("req-7");
  });

  it("reports no request id when the upstream did not send one", () => {
    expect(responseRequestId({})).toBeNull();
    expect(responseRequestId({ "x-request-id": "   " })).toBeNull();
    expect(responseRequestId({ "x-request-id": "abc" })).toBe("abc");
  });

  it("redacts a secret the upstream echoed back", () => {
    const secret = "SB7XQ7ZQ3F5H4GJ2WHT7Y6KQPJM6Q5W6K4ZQXK5XW5ZR5M4K2X7V5T5R5P5A5D5";
    const excerpt = malformedResponseExcerpt(`<p>key was ${secret}</p>`);
    expect(excerpt).not.toContain(secret);
    expect(excerpt).toContain("[REDACTED]");
  });

  it("redacts an authorization header echoed back", () => {
    const excerpt = malformedResponseExcerpt(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(excerpt).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("truncates a long body to the excerpt limit", () => {
    const excerpt = malformedResponseExcerpt("lorem ipsum ".repeat(400));
    expect(excerpt.length).toBe(MALFORMED_RESPONSE_EXCERPT_LIMIT + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("collapses a page of markup into one line", () => {
    expect(malformedResponseExcerpt("a\n\n  b\tc")).toBe("a b c");
  });

  it("parses a JSON body unchanged so structured error details survive", () => {
    const parsed = parseUpstreamErrorBody({
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "bad request" }),
    });
    expect(parsed).toEqual({ error: "bad request" });
    expect(isMalformedResponseBody(parsed)).toBe(false);
  });

  it("turns a non-JSON body into the marker", () => {
    const parsed = parseUpstreamErrorBody({
      status: 502,
      headers: { "content-type": "text/html" },
      body: HTML_BODY,
    });
    expect(isMalformedResponseBody(parsed)).toBe(true);
  });

  it("turns an empty body into the marker rather than a null body", () => {
    const parsed = parseUpstreamErrorBody({ status: 500, headers: {}, body: "" });
    expect(isMalformedResponseBody(parsed)).toBe(true);
    expect((parsed as { bodyBytes: number }).bodyBytes).toBe(0);
  });

  it("lowercases response header names", () => {
    const response = new Response("nope", { status: 502, headers: { "X-Request-Id": "req-9" } });
    expect(responseHeaderBag(response)["x-request-id"]).toBe("req-9");
  });

  it("describes the marker in one line", () => {
    const body = malformedResponseBody({
      status: 502,
      headers: { "content-type": "text/html", "x-request-id": "req-42" },
      body: "upstream refused",
    });
    const described = describeMalformedResponse(body);
    expect(described).toContain("non-JSON body");
    expect(described).toContain("text/html");
    expect(described).toContain("HTTP 502");
    expect(described).toContain("req-42");
  });
});

describe("error mapping with a malformed body", () => {
  const malformed = malformedResponseBody({
    status: 502,
    headers: { "content-type": "text/html", "x-request-id": "req-42" },
    body: HTML_BODY,
  });

  it("describes the body instead of quoting it whole", () => {
    const detail = extractDetail(malformed);
    expect(detail).toContain("non-JSON body");
    // The excerpt stays — an operator needs to recognise what the gateway
    // said — but it is bounded and redacted, never the raw page.
    expect(detail.length).toBeLessThan(MALFORMED_RESPONSE_EXCERPT_LIMIT + 300);
  });

  it("keeps the status and reports the request id in the summary", () => {
    const mapped = mapHttpError({
      operation: "Browse failed",
      source: "api",
      status: 502,
      data: malformed,
    });
    expect(mapped.status).toBe(502);
    expect(mapped.summary).toContain("Browse failed");
    expect(mapped.summary).toContain("req-42");
    expect(mapped.malformed?.requestId).toBe("req-42");
  });

  it("does not blame the credential when the body never reached the service", () => {
    const mapped = mapHttpError({
      operation: "Browse failed",
      source: "api",
      status: 401,
      data: malformed,
      credential: { kind: "publisher_api_key", profile: "default" },
    });
    expect(mapped.action).not.toContain("no longer accepted");
    expect(mapped.action).toContain("non-JSON");
  });

  it("carries the request id into the troubleshooting hint", () => {
    const mapped = mapHttpError({
      operation: "Browse failed",
      source: "api",
      status: 502,
      data: malformed,
    });
    expect(troubleshootingHint(mapped).requestId).toBe("req-42");
  });

  it("classifies as a malformed response rather than a plain server error", () => {
    const mapped = mapHttpError({
      operation: "Browse failed",
      source: "api",
      status: 502,
      data: malformed,
    });
    expect(codeForMappedError(mapped)).toBe("MV_MALFORMED_RESPONSE");
  });
});
