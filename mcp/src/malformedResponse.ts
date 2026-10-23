/**
 * Typed handling for upstream responses that are not JSON — issue #1019.
 *
 * The MindVault API speaks JSON. The things in front of it do not always: a
 * reverse proxy that is misconfigured answers `502` with an HTML page, a WAF
 * answers `403` with a captcha form, a load balancer answers `503` with
 * plain text, and a corporate gateway answers `407` with an HTML login
 * prompt. None of those bodies carry the `error` / `message` field the error
 * mapper looks for, so the raw HTML used to flow straight into the error
 * message an agent reads.
 *
 * That is bad in two ways at once:
 *
 *  - the agent gets a wall of markup instead of a classification, so it
 *    cannot tell "the request was malformed" from "the service is down";
 *  - an HTML error page can echo back whatever it was sent — an
 *    `Authorization` header, a publisher API key, a signed transaction — and
 *    that echo used to end up verbatim in the tool result.
 *
 * This module turns such a body into a small, typed, redacted marker: the
 * status, the upstream's own request id, the content type, the byte count and
 * a short excerpt. The excerpt goes through the shared secret redaction, and
 * the raw body never travels any further than this function.
 *
 * The marker is what the error mapper receives as a response body, so the
 * failure keeps its structured shape — category, status, action, request id —
 * instead of degrading into a quoted HTML page.
 */

import { CORRELATION_HEADER } from "./correlation.js";
import { redactSecrets } from "./redaction.js";

/**
 * Marker that identifies a body the upstream did not return as JSON.
 *
 * It is a stable string rather than a class so it survives `JSON.stringify`
 * and can be recognised in a log line, a stored audit entry, or a bug report.
 */
export const MALFORMED_RESPONSE_MARKER = "MV_MALFORMED_RESPONSE";

/**
 * How much of the offending body is kept.
 *
 * Enough to recognise what the gateway said ("no healthy upstream",
 * "authorization required"); short enough that a page full of markup cannot
 * crowd out the status and the request id.
 */
export const MALFORMED_RESPONSE_EXCERPT_LIMIT = 200;

/** The typed description of a body that was not JSON. */
export interface MalformedResponseBody {
  /** Always {@link MALFORMED_RESPONSE_MARKER}. */
  marker: typeof MALFORMED_RESPONSE_MARKER;
  /** HTTP status the upstream answered with. */
  status: number;
  /** The upstream's own request id, when it reported one. */
  requestId: string | null;
  /** The declared content type, when the upstream declared one. */
  contentType: string | null;
  /** Size of the body in bytes. */
  bodyBytes: number;
  /** A short, redacted excerpt of the body. */
  excerpt: string;
}

/** Whether a value is a malformed-response marker. */
export function isMalformedResponseBody(value: unknown): value is MalformedResponseBody {
  if (!value || typeof value !== "object") return false;
  const marker = (value as { marker?: unknown }).marker;
  return marker === MALFORMED_RESPONSE_MARKER;
}

/**
 * The request id an upstream reported, or `null`.
 *
 * The MindVault server echoes the incoming `x-request-id` back, so the value
 * is usually the MCP's own correlation id — which is exactly what an operator
 * needs to find the matching server log line.
 */
export function responseRequestId(headers: Record<string, string>): string | null {
  const raw = headers[CORRELATION_HEADER] ?? headers["x-correlation-id"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Shorten and redact a body for safe inclusion in an error.
 *
 * Whitespace is collapsed so a page of markup reads as one line, and the
 * result is cut to {@link MALFORMED_RESPONSE_EXCERPT_LIMIT}. The redaction
 * runs first, so a secret that is present is removed before it can be cut in
 * half and become unrecognisable to the patterns that would have caught it.
 */
export function malformedResponseExcerpt(body: string): string {
  const redacted = redactSecrets(body);
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MALFORMED_RESPONSE_EXCERPT_LIMIT) return collapsed;
  return `${collapsed.slice(0, MALFORMED_RESPONSE_EXCERPT_LIMIT)}…`;
}

/**
 * Lowercase a response's headers into a plain bag.
 *
 * `Headers.forEach` yields lowercased names already, but the bag is built
 * here so every caller reads them the same way and looks them up with the
 * same casing.
 */
export function responseHeaderBag(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Describe a body that was not JSON.
 *
 * The excerpt is redacted and truncated; the raw body is not retained.
 */
export function malformedResponseBody(input: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): MalformedResponseBody {
  return {
    marker: MALFORMED_RESPONSE_MARKER,
    status: input.status,
    requestId: responseRequestId(input.headers),
    contentType: input.headers["content-type"] ?? null,
    bodyBytes: Buffer.byteLength(input.body, "utf8"),
    excerpt: malformedResponseExcerpt(input.body),
  };
}

/**
 * Parse an upstream error body.
 *
 * A body that is JSON is returned as parsed — the structured error details
 * the upstream sent are preserved, which is the whole point of the change.
 * A body that is not JSON (or an empty one) becomes a
 * {@link MalformedResponseBody} marker.
 */
export function parseUpstreamErrorBody(input: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): unknown {
  const trimmed = input.body.trim();
  if (trimmed.length > 0) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not JSON — handled below.
    }
  }
  return malformedResponseBody(input);
}

/**
 * One-line description of a malformed body, for an error summary.
 *
 * The status and the request id lead, because they are what identifies the
 * failed request; the excerpt follows, and is omitted when there was nothing
 * to show.
 */
export function describeMalformedResponse(body: MalformedResponseBody): string {
  const parts = [`the upstream returned a non-JSON body`];
  if (body.contentType) parts.push(`(${body.contentType})`);
  parts.push(`[HTTP ${body.status}, ${body.bodyBytes} bytes`);
  if (body.requestId) parts.push(`, request id ${body.requestId}`);
  parts.push("]");
  if (body.excerpt) parts.push(`: ${body.excerpt}`);
  return parts.join(" ");
}
