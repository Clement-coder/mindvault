/**
 * Structured error mapping for the MindVault MCP server.
 *
 * Failures reach an agent from four very different places — the MindVault API,
 * the x402 payment layer, Horizon, and the Soroban registry client — and each
 * one has its own failure vocabulary. Raw, they surface as opaque text like
 * `Browse failed: {"error":"..."}` or an unqualified `fetch failed`, which tells
 * an agent nothing about whether to retry, re-fund, fix its arguments, or stop.
 *
 * This module normalizes all of them into one shape: a category, the source that
 * failed, and a one-line action telling the agent what to do next. The mapping
 * is a pure function of (source, status, payload) — the same failure always
 * produces the same text, so agent behavior is reproducible and testable.
 *
 * `index.ts` owns the wiring; nothing here performs I/O.
 */

import { CLOCK_SKEW_WINDOW_MS, isClockSkewRejection } from "./requestSignature.js";

/** Which subsystem produced the failure. */
export type ErrorSource = "api" | "x402" | "horizon" | "soroban" | "registry" | "sponsored";

/** Normalized failure kind, chosen so each maps to exactly one recovery action. */
export type ErrorCategory =
  | "network"
  | "timeout"
  | "payment"
  | "validation"
  | "auth"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "server"
  | "contract"
  | "unknown";

export interface MappedError {
  source: ErrorSource;
  category: ErrorCategory;
  /** HTTP status, when the failure came from an HTTP response. */
  status?: number;
  /** `<operation>: <detail>` — what failed, in the caller's vocabulary. */
  summary: string;
  /** Just the detail half of the summary, so a caller can re-compose it under
   * its own operation label without string-surgery on `summary`. */
  detail?: string;
  /** One-line, imperative next step for the agent. */
  action: string;
}

/**
 * Stable payload returned in MCP tool-error `structuredContent`.
 *
 * The text rendering remains useful for humans and older clients, while this
 * object lets agents branch on an error category without parsing prose.
 */
export interface TroubleshootingHint {
  schema: "mindvault.troubleshooting/v1";
  source: ErrorSource;
  category: ErrorCategory;
  status: number | null;
  summary: string;
  detail: string | null;
  action: string;
}

/** Convert a mapped failure into the stable, machine-readable MCP payload. */
export function troubleshootingHint(error: MappedError): TroubleshootingHint {
  return {
    schema: "mindvault.troubleshooting/v1",
    source: error.source,
    category: error.category,
    status: error.status ?? null,
    summary: error.summary,
    detail: error.detail ?? null,
    action: error.action,
  };
}

/** Human label for a source, used in the summary. */
const SOURCE_LABEL: Record<ErrorSource, string> = {
  api: "MindVault API",
  x402: "x402 payment",
  horizon: "Horizon",
  soroban: "Soroban RPC",
  registry: "vault-registry contract",
  sponsored: "sponsored-account service",
};

/** The deterministic recovery step for each category. */
const ACTION: Record<ErrorCategory, string> = {
  network:
    "Check network connectivity to the service and retry; idempotent reads retry automatically.",
  timeout:
    "The request exceeded its configured timeout. Retry, or raise MINDVAULT_HTTP_TIMEOUT_MS for a slow endpoint.",
  payment:
    "Payment was required or rejected. Check the wallet with mindvault_wallet_info, fund it with USDC, and retry.",
  validation: "Correct the invalid arguments and call the tool again.",
  auth: "Credentials are missing or not accepted. Run mindvault_register, or switch to the profile that owns this resource.",
  not_found: "Confirm the id with mindvault_browse or mindvault_search before retrying.",
  conflict: "The resource is already in the requested state — no action needed.",
  rate_limit: "Rate limited. Wait for the window to pass before retrying.",
  server: "The upstream service is failing. Retry shortly; if it persists the service is down.",
  contract: "Verify the registry contract ID and network with mindvault_registry_info, then retry.",
  unknown: "Retry once; if it persists, report the summary above with the tool name.",
};

/** Map an HTTP status onto a category. */
export function categorizeStatus(status: number): ErrorCategory {
  if (status === 402) return "payment";
  if (status === 400 || status === 422) return "validation";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "validation";
  return "unknown";
}

/**
 * Pull the most useful message out of a JSON error body, falling back to a
 * compact JSON dump so no server detail is silently dropped.
 */
export function extractDetail(data: unknown): string {
  if (data == null) return "no response body";
  if (typeof data === "string") return data.trim() || "empty response body";
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["error", "message", "detail", "reason"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    try {
      return JSON.stringify(data);
    } catch {
      return "unserializable response body";
    }
  }
  return String(data);
}

/** True for the transport-level failures fetch raises instead of a Response. */
export function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  if (name === "TimeoutError") return true;
  if (name === "AbortError") return true;
  return typeof message === "string" && /timed? ?out/i.test(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * The credential a request carried, when it carried one.
 *
 * A 401 means something different depending on this: with no credential the
 * agent simply has not registered yet, while with a stored publisher key it
 * means the key it has been using is no longer accepted — revoked, rotated from
 * another session, or attached to a publisher that no longer exists. Those need
 * opposite recovery steps, so the mapper needs to know which one happened.
 */
export interface CredentialContext {
  kind: "publisher_api_key";
  /** Profile the credential was read from, so the fix names the right profile. */
  profile: string;
}

/**
 * True when a rejected request carried a stored publisher API key that the
 * server refused to recognise (401), rather than accepting the key and denying
 * the operation (403).
 */
export function isRevokedApiKey(
  status: number,
  credential: CredentialContext | undefined,
): boolean {
  return status === 401 && credential?.kind === "publisher_api_key";
}

/** Recovery step for a publisher key the server no longer recognises. */
function revokedKeyAction(profile: string): string {
  return (
    `The publisher API key stored in profile "${profile}" is no longer accepted — ` +
    "it was revoked, rotated from another session, or its publisher record was removed. " +
    "The stored key cannot be revived: run mindvault_register to obtain a new one, " +
    "mindvault_use_profile to switch to a profile whose key still works, or " +
    "mindvault_restore_state to restore a backup that holds a valid key."
  );
}

/** Recovery step for a request signature rejected purely for clock skew. */
function clockSkewAction(): string {
  const minutes = Math.round(CLOCK_SKEW_WINDOW_MS / 60_000);
  return (
    `The request signature was rejected because its timestamp fell outside the accepted ` +
    `${minutes}-minute window — the local clock is probably skewed, not the key. Sync the ` +
    `system clock (e.g. enable NTP), then retry; the message disappears once the clocks agree.`
  );
}

/** Recovery step for a key the server accepted but that lacks access here. */
function forbiddenKeyAction(profile: string): string {
  return (
    `The publisher API key in profile "${profile}" is valid but not authorized for this ` +
    "resource — it belongs to a different publisher. Switch to the owning profile with " +
    "mindvault_use_profile, or act on a resource this publisher owns."
  );
}

/**
 * Map a non-ok HTTP response into a structured error.
 *
 * `operation` is the caller-facing verb ("Browse failed", "Publish failed") and
 * is preserved verbatim at the head of the summary so existing tool contracts
 * and their assertions keep working.
 *
 * Pass `credential` on requests that carried a stored publisher API key: a 401
 * then reports the key as revoked (naming the profile and the way back) instead
 * of the generic "credentials are missing or not accepted".
 */
export function mapHttpError(input: {
  operation: string;
  source: ErrorSource;
  status: number;
  data: unknown;
  credential?: CredentialContext;
}): MappedError {
  const category = categorizeStatus(input.status);
  const detail = extractDetail(input.data);
  const credential = input.credential;

  // A 401 naming the signature timestamp window is a system-clock problem, not
  // a credential problem. It nests inside the 401-with-credential case (a
  // signed request always carries the publisher key), so it must be checked
  // before the revoked-key branch or every skew rejection would be reported as
  // a revoked key and an agent would replace a credential that never went bad.
  if (isClockSkewRejection(input.status, detail)) {
    return {
      source: input.source,
      category,
      status: input.status,
      detail,
      summary:
        `${input.operation}: ${detail} ` +
        "(request signature timestamp rejected as outside the allowed window)",
      action: clockSkewAction(),
    };
  }

  if (credential && isRevokedApiKey(input.status, credential)) {
    return {
      source: input.source,
      category,
      status: input.status,
      detail,
      summary:
        `${input.operation}: ${detail} ` +
        `(publisher API key for profile "${credential.profile}" was rejected as unknown)`,
      action: revokedKeyAction(credential.profile),
    };
  }

  if (credential && input.status === 403) {
    return {
      source: input.source,
      category,
      status: input.status,
      detail,
      summary: `${input.operation}: ${detail}`,
      action: forbiddenKeyAction(credential.profile),
    };
  }

  return {
    source: input.source,
    category,
    status: input.status,
    detail,
    summary: `${input.operation}: ${detail}`,
    action: ACTION[category],
  };
}

/**
 * Map a thrown transport error (DNS failure, connection refused, abort/timeout)
 * into a structured error. The original message is kept in the summary so the
 * underlying cause is never hidden from the operator.
 */
export function mapTransportError(input: {
  operation: string;
  source: ErrorSource;
  error: unknown;
}): MappedError {
  const timedOut = isTimeoutError(input.error);
  const category: ErrorCategory = timedOut ? "timeout" : "network";
  const detail = errorMessage(input.error);
  return {
    source: input.source,
    category,
    detail,
    summary: `${input.operation}: ${detail}`,
    action: ACTION[category],
  };
}

/**
 * Map a vault-registry contract failure. The registry client reports a missing
 * resource as a contract error rather than a 404, so `notFound` gets its own
 * actionable message instead of the generic contract advice.
 */
export function mapRegistryError(input: {
  operation: string;
  message: string;
  notFound?: boolean;
  /** Defaults to the contract itself; pass "soroban" for JSON-RPC level errors. */
  source?: Extract<ErrorSource, "registry" | "soroban">;
}): MappedError {
  const source = input.source ?? "registry";
  if (input.notFound) {
    return {
      source,
      category: "not_found",
      summary: `${input.operation}: ${input.message}`,
      action:
        "The resource is not registered on-chain. Publish it, or run mindvault_register_onchain to register an already-verified resource.",
    };
  }
  return {
    source,
    category: "contract",
    summary: `${input.operation}: ${input.message}`,
    action: ACTION.contract,
  };
}

/**
 * Render a mapped error as the three-line text agents see:
 *   <operation>: <detail>
 *   Source: <service> · Category: <category>[ · HTTP <status>]
 *   Next: <action>
 *
 * The middle line is what makes the error machine-classifiable: an agent can
 * branch on the category without parsing prose.
 */
export function formatMappedError(error: MappedError): string {
  const classification = [
    `Source: ${SOURCE_LABEL[error.source]}`,
    `Category: ${error.category}`,
    error.status !== undefined ? `HTTP ${error.status}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${error.summary}\n${classification}\nNext: ${error.action}`;
}

/**
 * An Error carrying the structured mapping it was rendered from, so a caller
 * further up can refine the classification instead of re-parsing the message.
 */
export interface MappedErrorException extends Error {
  mapped: MappedError;
}

/** A mapped error as a throwable, for the tool handlers' existing error path. */
export function mcpError(error: MappedError): MappedErrorException {
  const err = new Error(formatMappedError(error)) as MappedErrorException;
  // Non-enumerable so the mapping never shows up in a JSON dump of the error.
  Object.defineProperty(err, "mapped", { value: error, enumerable: false });
  return err;
}

/**
 * Recover the structured mapping from an error thrown by `mcpError`, or
 * `undefined` for anything else. Lets a handler that knows more about the call
 * than `jsonFetch` did enrich an already-classified failure.
 */
export function mappedErrorOf(error: unknown): MappedError | undefined {
  if (!error || typeof error !== "object") return undefined;
  const mapped = (error as { mapped?: unknown }).mapped;
  return mapped && typeof mapped === "object" ? (mapped as MappedError) : undefined;
}

/** Convenience: map a non-ok HTTP response and throw it. */
export function throwHttpError(input: {
  operation: string;
  source: ErrorSource;
  status: number;
  data: unknown;
  credential?: CredentialContext;
}): never {
  throw mcpError(mapHttpError(input));
}
