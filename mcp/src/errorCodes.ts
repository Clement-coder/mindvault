/**
 * Explicit tool error codes — issue #580.
 *
 * `errorMapping.ts` already gives a failure a *category* — eleven broad buckets
 * chosen so each maps to one recovery action. That is the right shape for
 * "what should the agent do next" and the wrong shape for everything else.
 * `payment` covers a 402 challenge, a rejected signature, an exceeded auto-pay
 * ceiling and an underfunded wallet; `validation` covers a malformed resource
 * id and a tool that does not exist. An agent branching on `category` cannot
 * tell those apart, a support request cannot name one, and a dashboard cannot
 * count them.
 *
 * This module adds a stable **code** alongside the category: a short screaming
 * identifier that names one specific failure and never changes meaning. Codes
 * are additive — new failures get new codes, existing codes keep their
 * semantics — so anything keyed on them keeps working across releases.
 *
 * Every code carries its own metadata in {@link ERROR_CODES}: the category it
 * belongs to, whether retrying is safe, and what to do instead. That catalog is
 * the single source of truth, which is what lets the documentation be checked
 * against the code rather than drifting from it.
 */

import type { ErrorCategory, ErrorSource, MappedError } from "./errorMapping.js";

/**
 * Every failure the server can report.
 *
 * Prefixed `MV_` so a code is recognisable out of context — in a log line, a
 * bug report, or a client's error handler.
 */
export type ErrorCode =
  // Transport and infrastructure
  | "MV_NETWORK_UNREACHABLE"
  | "MV_TIMEOUT"
  | "MV_RATE_LIMITED"
  | "MV_UPSTREAM_ERROR"
  // Request and arguments
  | "MV_ARGUMENT_INVALID"
  | "MV_TOOL_UNKNOWN"
  | "MV_NOT_FOUND"
  | "MV_CONFLICT"
  // Identity and authorisation
  | "MV_AUTH_REQUIRED"
  | "MV_AUTH_REJECTED"
  | "MV_API_KEY_REVOKED"
  | "MV_CLOCK_SKEW"
  // Wallet and payment
  | "MV_WALLET_MISSING"
  | "MV_PAYMENT_REQUIRED"
  | "MV_PAYMENT_REJECTED"
  | "MV_PAYMENT_CEILING_EXCEEDED"
  | "MV_INSUFFICIENT_FUNDS"
  // Network safety
  | "MV_MAINNET_UNCONFIRMED"
  // On-chain
  | "MV_CONTRACT_ERROR"
  // Local state
  | "MV_STATE_CORRUPT"
  | "MV_STATE_LOCKED"
  // Fallback
  | "MV_UNKNOWN";

/**
 * Whether repeating the call is safe.
 *
 * `conditional` is not hedging: it marks the failures where the answer depends
 * on state the server cannot see from the error alone — chiefly a payment that
 * may or may not have settled. Collapsing it into `safe` risks a double spend;
 * collapsing it into `unsafe` strands a purchase the user already paid for.
 */
export type RetrySafety = "safe" | "unsafe" | "conditional";

export interface ErrorCodeSpec {
  code: ErrorCode;
  /** The `errorMapping.ts` category this code refines. */
  category: ErrorCategory;
  /** One sentence: what this code means. */
  description: string;
  retry: RetrySafety;
  /** What to do about it, imperative. */
  action: string;
}

function spec(
  code: ErrorCode,
  category: ErrorCategory,
  retry: RetrySafety,
  description: string,
  action: string,
): ErrorCodeSpec {
  return { code, category, retry, description, action };
}

/**
 * The catalog. Single source of truth for codes, their meaning and their retry
 * safety; the documentation is validated against it.
 */
export const ERROR_CODES: Record<ErrorCode, ErrorCodeSpec> = {
  MV_NETWORK_UNREACHABLE: spec(
    "MV_NETWORK_UNREACHABLE",
    "network",
    "safe",
    "The service could not be reached — DNS failure, refused connection, or a dropped socket.",
    "Check connectivity and retry. Idempotent reads already retry automatically.",
  ),
  MV_TIMEOUT: spec(
    "MV_TIMEOUT",
    "timeout",
    "safe",
    "The request exceeded its configured deadline.",
    "Retry, or raise the relevant MINDVAULT_*_TIMEOUT_MS for a legitimately slow endpoint.",
  ),
  MV_RATE_LIMITED: spec(
    "MV_RATE_LIMITED",
    "rate_limit",
    "safe",
    "The upstream service is throttling this client.",
    "Wait for the window to pass before retrying. Retrying immediately extends the throttle.",
  ),
  MV_UPSTREAM_ERROR: spec(
    "MV_UPSTREAM_ERROR",
    "server",
    "safe",
    "The upstream service returned a 5xx.",
    "Retry shortly. If it persists, the service is down and no client change will help.",
  ),
  MV_ARGUMENT_INVALID: spec(
    "MV_ARGUMENT_INVALID",
    "validation",
    "unsafe",
    "The arguments failed validation, locally or at the server.",
    "Fix the arguments and call again. An identical retry fails identically.",
  ),
  MV_TOOL_UNKNOWN: spec(
    "MV_TOOL_UNKNOWN",
    "validation",
    "unsafe",
    "No tool by that name is exposed by this server.",
    "List the available tools and call one of them.",
  ),
  MV_NOT_FOUND: spec(
    "MV_NOT_FOUND",
    "not_found",
    "unsafe",
    "The referenced resource does not exist.",
    "Confirm the id with mindvault_browse or mindvault_search before retrying.",
  ),
  MV_CONFLICT: spec(
    "MV_CONFLICT",
    "conflict",
    "unsafe",
    "The resource is already in the requested state.",
    "No action needed — the desired outcome already holds.",
  ),
  MV_AUTH_REQUIRED: spec(
    "MV_AUTH_REQUIRED",
    "auth",
    "unsafe",
    "The call needs a credential and none was presented.",
    "Run mindvault_register, or switch to a profile that holds a credential.",
  ),
  MV_AUTH_REJECTED: spec(
    "MV_AUTH_REJECTED",
    "auth",
    "unsafe",
    "A credential was presented and the operation was denied.",
    "Switch to the profile that owns this resource.",
  ),
  MV_API_KEY_REVOKED: spec(
    "MV_API_KEY_REVOKED",
    "auth",
    "unsafe",
    "The stored publisher API key is no longer accepted — revoked, rotated elsewhere, or its publisher record was removed.",
    "The stored key cannot be revived: run mindvault_register for a new one, or restore a backup that holds a valid key.",
  ),
  MV_CLOCK_SKEW: spec(
    "MV_CLOCK_SKEW",
    "auth",
    "safe",
    "A request signature was rejected because this machine's clock is outside the accepted window.",
    "Correct the system clock, then retry. Retrying without fixing it fails the same way.",
  ),
  MV_WALLET_MISSING: spec(
    "MV_WALLET_MISSING",
    "payment",
    "unsafe",
    "The active profile has no wallet configured.",
    "Run mindvault_setup_wallet or mindvault_import_wallet, then retry.",
  ),
  MV_PAYMENT_REQUIRED: spec(
    "MV_PAYMENT_REQUIRED",
    "payment",
    "safe",
    "The resource returned an x402 challenge and no payment has been attempted yet.",
    "No funds moved. Retry with payment enabled, or raise the auto-pay ceiling.",
  ),
  MV_PAYMENT_REJECTED: spec(
    "MV_PAYMENT_REJECTED",
    "payment",
    "conditional",
    "A payment was attempted and did not complete successfully.",
    "Do NOT blindly retry — check mindvault_purchase_history and mindvault_tx_status first; the payment may have settled.",
  ),
  MV_PAYMENT_CEILING_EXCEEDED: spec(
    "MV_PAYMENT_CEILING_EXCEEDED",
    "payment",
    "safe",
    "The price exceeds the configured auto-pay ceiling, so no payment was attempted.",
    "No funds moved. Pass maxAutoPayUsdc at least as large as the price, or raise MINDVAULT_MAX_AUTO_PAY_USDC.",
  ),
  MV_INSUFFICIENT_FUNDS: spec(
    "MV_INSUFFICIENT_FUNDS",
    "payment",
    "safe",
    "The wallet lacks the USDC or the native XLM reserve needed to pay.",
    "No funds moved. Fund the wallet and retry.",
  ),
  MV_MAINNET_UNCONFIRMED: spec(
    "MV_MAINNET_UNCONFIRMED",
    "validation",
    "unsafe",
    "A mainnet mutation or payment was attempted without explicit confirmation.",
    "Pass confirmMainnet: true, or set MINDVAULT_ALLOW_MAINNET=1 for the session.",
  ),
  MV_CONTRACT_ERROR: spec(
    "MV_CONTRACT_ERROR",
    "contract",
    "unsafe",
    "The vault-registry contract rejected the call or is not the expected contract.",
    "Verify the contract id and network with mindvault_registry_info, then retry.",
  ),
  MV_STATE_CORRUPT: spec(
    "MV_STATE_CORRUPT",
    "unknown",
    "unsafe",
    "The local state file could not be read as valid state.",
    "The corrupt file is quarantined. Restore with mindvault_restore_state, or set up the wallet again.",
  ),
  MV_STATE_LOCKED: spec(
    "MV_STATE_LOCKED",
    "conflict",
    "safe",
    "Another state-mutating tool call holds the state lock.",
    "Retry once the in-flight call completes; concurrent mutations are serialised deliberately.",
  ),
  MV_UNKNOWN: spec(
    "MV_UNKNOWN",
    "unknown",
    "conditional",
    "The failure did not match any known classification.",
    "Retry once. If it persists, report the summary and correlation id with the tool name.",
  ),
};

/** Every code, sorted — for docs, dashboards and exhaustiveness checks. */
export const ALL_ERROR_CODES: ErrorCode[] = Object.keys(ERROR_CODES).sort() as ErrorCode[];

/** Whether a value is a code this build knows. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && value in ERROR_CODES;
}

/** Look up a code's metadata, falling back to `MV_UNKNOWN`. */
export function specFor(code: ErrorCode): ErrorCodeSpec {
  return ERROR_CODES[code] ?? ERROR_CODES.MV_UNKNOWN;
}

/** Whether retrying a failure with this code is safe without further checks. */
export function isRetrySafe(code: ErrorCode): boolean {
  return specFor(code).retry === "safe";
}

/**
 * Errors this server raises locally, keyed by the marker each one carries.
 *
 * Matched before the HTTP mapping, because a local failure never reached the
 * network and misclassifying it as a server problem sends the agent to retry
 * something that will never succeed.
 */
const LOCAL_PATTERNS: { code: ErrorCode; test: (name: string, message: string) => boolean }[] = [
  {
    code: "MV_PAYMENT_CEILING_EXCEEDED",
    test: (_n, m) => /auto-?pay ceiling|maxAutoPayUsdc|MAX_AUTO_PAY/i.test(m),
  },
  {
    code: "MV_MAINNET_UNCONFIRMED",
    test: (_n, m) => /confirmMainnet|ALLOW_MAINNET/i.test(m),
  },
  {
    code: "MV_WALLET_MISSING",
    test: (_n, m) => /no wallet|wallet is not configured|setup_wallet first/i.test(m),
  },
  {
    code: "MV_INSUFFICIENT_FUNDS",
    test: (_n, m) => /insufficient (usdc|xlm|funds|balance)|underfunded/i.test(m),
  },
  {
    code: "MV_TOOL_UNKNOWN",
    test: (_n, m) => /^unknown tool:/i.test(m),
  },
  {
    code: "MV_STATE_CORRUPT",
    test: (_n, m) => /state file (is )?(corrupt|unreadable)|quarantin/i.test(m),
  },
  {
    code: "MV_TIMEOUT",
    test: (name, m) => name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(m),
  },
  {
    code: "MV_ARGUMENT_INVALID",
    test: (name, m) =>
      name === "ValidationError" || /^invalid |expected a (string|number|non-empty)/i.test(m),
  },
];

/** Classify a locally raised error, or null when none of the patterns match. */
export function localErrorCode(error: unknown): ErrorCode | null {
  if (error == null) return null;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  for (const { code, test } of LOCAL_PATTERNS) {
    if (test(name, message)) return code;
  }
  return null;
}

/** Refine a mapped HTTP failure into a specific code. */
export function codeForMappedError(mapped: MappedError): ErrorCode {
  switch (mapped.category) {
    case "network":
      return "MV_NETWORK_UNREACHABLE";
    case "timeout":
      return "MV_TIMEOUT";
    case "rate_limit":
      return "MV_RATE_LIMITED";
    case "server":
      return "MV_UPSTREAM_ERROR";
    case "not_found":
      return "MV_NOT_FOUND";
    case "conflict":
      return "MV_CONFLICT";
    case "contract":
      return "MV_CONTRACT_ERROR";
    case "validation":
      return "MV_ARGUMENT_INVALID";
    case "auth":
      return authCode(mapped);
    case "payment":
      return paymentCode(mapped);
    default:
      return "MV_UNKNOWN";
  }
}

function authCode(mapped: MappedError): ErrorCode {
  // The action text is where errorMapping.ts records that a stored key was
  // refused rather than merely absent; the distinction needs opposite fixes.
  if (/no longer accepted|revoked/i.test(mapped.action)) return "MV_API_KEY_REVOKED";
  if (/clock/i.test(mapped.action) || /skew/i.test(mapped.summary)) return "MV_CLOCK_SKEW";
  return mapped.status === 403 ? "MV_AUTH_REJECTED" : "MV_AUTH_REQUIRED";
}

function paymentCode(mapped: MappedError): ErrorCode {
  // A bare 402 is the challenge itself: the resource is telling the client what
  // it costs, and nothing has been signed or spent yet. Anything else in the
  // payment category means an attempt was made.
  if (mapped.status === 402 && mapped.source !== "x402") return "MV_PAYMENT_REQUIRED";
  if (/insufficient|balance/i.test(mapped.detail ?? mapped.summary)) {
    return "MV_INSUFFICIENT_FUNDS";
  }
  return mapped.status === 402 ? "MV_PAYMENT_REQUIRED" : "MV_PAYMENT_REJECTED";
}

/**
 * The code for any failure.
 *
 * Local classification wins over the HTTP mapping: a ceiling breach or a
 * missing wallet never reached the network, and reporting it as a server
 * problem sends the agent to retry something that cannot succeed.
 */
export function errorCodeFor(error: unknown, mapped?: MappedError | null): ErrorCode {
  return localErrorCode(error) ?? (mapped ? codeForMappedError(mapped) : "MV_UNKNOWN");
}

/**
 * Stable payload attached to every tool failure.
 *
 * Versioned schema, so a client can tell which fields to expect. Extends the
 * existing troubleshooting hint rather than replacing it — the category and
 * action stay where clients already look for them.
 */
export interface ToolErrorPayload {
  schema: "mindvault.error/v1";
  code: ErrorCode;
  category: ErrorCategory;
  source: ErrorSource | null;
  status: number | null;
  retry: RetrySafety;
  summary: string;
  detail: string | null;
  action: string;
  /** The tool call this failure belongs to (#572), when one is in flight. */
  correlationId?: string;
}

/** Build the failure payload for a tool result. */
export function toolErrorPayload(input: {
  error: unknown;
  mapped?: MappedError | null;
  summary: string;
  correlationId?: string;
}): ToolErrorPayload {
  const code = errorCodeFor(input.error, input.mapped);
  const meta = specFor(code);

  return {
    schema: "mindvault.error/v1",
    code,
    category: meta.category,
    source: input.mapped?.source ?? null,
    status: input.mapped?.status ?? null,
    retry: meta.retry,
    summary: input.summary,
    detail: input.mapped?.detail ?? null,
    // The mapper's action is more specific when it has one (it can name a
    // profile or a contract id); the catalog's is the generic fallback.
    action: input.mapped?.action ?? meta.action,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

/** Render a code for a human-readable error line: `Error: … [MV_TIMEOUT]`. */
export function formatCodeSuffix(code: ErrorCode): string {
  return ` [${code}]`;
}
