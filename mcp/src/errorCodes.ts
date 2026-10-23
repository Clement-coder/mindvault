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
import { Errors as RegistryErrors } from "@mindvault/registry-client";

/**
 * The name of a vault-registry contract error, derived from the installed
 * bindings' `Errors` table. Defined locally because the installed package
 * version may not export `RegistryErrorName` directly.
 */
export type RegistryErrorName = (typeof RegistryErrors)[keyof typeof RegistryErrors]["message"];

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
  | "MV_MALFORMED_RESPONSE"
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
  MV_MALFORMED_RESPONSE: spec(
    "MV_MALFORMED_RESPONSE",
    "server",
    "safe",
    "The upstream answered with a body that was not JSON — a proxy, gateway or load balancer usually does this, and the request may never have reached the service.",
    "Retry once. If it persists, quote the request id from the error when reporting the failure.",
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
  // A non-JSON body says the request never reached the service, whatever the
  // status was: a 502 from a proxy is a gateway problem, not an API outage,
  // and the two need different next steps.
  if (mapped.malformed) return "MV_MALFORMED_RESPONSE";
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
  /**
   * The upstream's own request id, when the failure carries one (#1019).
   *
   * Present for a failure whose response was not JSON — the id is how the
   * request is found in the server's logs.
   */
  requestId?: string;
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
    ...(input.mapped?.malformed?.requestId ? { requestId: input.mapped.malformed.requestId } : {}),
  };
}

/** Render a code for a human-readable error line: `Error: … [MV_TIMEOUT]`. */
export function formatCodeSuffix(code: ErrorCode): string {
  return ` [${code}]`;
}

// ── Registry contract error mapping ──────────────────────────────────────────

/**
 * A single entry in the versioned registry-error map.
 *
 * `code` is the MV_ code an SDK or agent should branch on. `message` is the
 * stable, human-readable explanation that SDKs can surface verbatim — it will
 * not change between contract upgrades unless the error's meaning genuinely
 * changes (which would require a new `RegistryErrorName` anyway).
 */
export interface RegistryErrorMapEntry {
  /** The on-chain discriminant (numeric). Stable across upgrades. */
  discriminant: number;
  /** The Rust enum variant name, mirrored from `packages/registry-client/src/errors.ts`. */
  name: RegistryErrorName;
  /** The MV_ code clients should branch on. */
  code: ErrorCode;
  /** Stable, SDK-safe explanation for the error. */
  message: string;
}

/**
 * Schema version for the registry error map.
 *
 * Increment this when entries are removed or their `code`/`message` changes in
 * a semantically breaking way. Adding new entries is non-breaking and does not
 * require a bump.
 */
export const REGISTRY_ERROR_MAP_VERSION = 1;

/**
 * Versioned mapping from every vault-registry contract error name to its
 * MV_ code and a stable human-readable message.
 *
 * This is the single source of truth for how on-chain discriminants become
 * SDK-presentable errors. Keys are `RegistryErrorName` values (variant names
 * from the Rust `Error` enum). Discriminants are included for reference and
 * are checked against `packages/registry-client/src/errors.ts` by tests.
 *
 * Rules:
 *  - Every entry in the TypeScript `Errors` table must have a row here.
 *  - Entries are never removed; when a contract upgrade retires an error the
 *    entry is kept so older on-chain data stays classifiable.
 *  - `code` and `message` are stable: adding new entries never changes existing
 *    ones. Changing either requires a `REGISTRY_ERROR_MAP_VERSION` bump.
 */
export const REGISTRY_ERROR_MAP: Record<RegistryErrorName, RegistryErrorMapEntry> = {
  AlreadyRegistered: {
    discriminant: 1,
    name: "AlreadyRegistered",
    code: "MV_CONFLICT",
    message: "A resource with this id is already registered on-chain.",
  },
  NotFound: {
    discriminant: 2,
    name: "NotFound",
    code: "MV_NOT_FOUND",
    message: "No resource, receipt, or key matches the given id.",
  },
  InvalidPrice: {
    discriminant: 3,
    name: "InvalidPrice",
    code: "MV_ARGUMENT_INVALID",
    message: "Price is zero, exceeds the maximum, or violates the creator-share invariant.",
  },
  MetadataTooLong: {
    discriminant: 4,
    name: "MetadataTooLong",
    code: "MV_ARGUMENT_INVALID",
    message: "Metadata pointer exceeds the 512-byte limit.",
  },
  InvalidTag: {
    discriminant: 5,
    name: "InvalidTag",
    code: "MV_ARGUMENT_INVALID",
    message: "Tag validation failed: too many tags, empty tag, tag too long, or duplicate.",
  },
  Unauthorized: {
    discriminant: 6,
    name: "Unauthorized",
    code: "MV_AUTH_REJECTED",
    message: "Caller is not authorized to perform this operation on this resource.",
  },
  PendingAdminNotSet: {
    discriminant: 7,
    name: "PendingAdminNotSet",
    code: "MV_CONTRACT_ERROR",
    message: "No pending admin nomination exists, or caller does not match the pending admin.",
  },
  PendingAdminAlreadySet: {
    discriminant: 8,
    name: "PendingAdminAlreadySet",
    code: "MV_CONFLICT",
    message: "A pending admin nomination is already active.",
  },
  SameAdmin: {
    discriminant: 9,
    name: "SameAdmin",
    code: "MV_CONFLICT",
    message: "Nominated new admin is already the current contract admin.",
  },
  TermsHashTooLong: {
    discriminant: 10,
    name: "TermsHashTooLong",
    code: "MV_ARGUMENT_INVALID",
    message: "Terms hash exceeds the 64-byte limit.",
  },
  InvalidResourceId: {
    discriminant: 11,
    name: "InvalidResourceId",
    code: "MV_ARGUMENT_INVALID",
    message:
      "Resource id is empty, exceeds 24 bytes, or contains non-lowercase-alphanumeric characters.",
  },
  InvalidMetadataPointer: {
    discriminant: 12,
    name: "InvalidMetadataPointer",
    code: "MV_ARGUMENT_INVALID",
    message: "Metadata pointer does not start with a supported prefix.",
  },
  EmptyMetadata: {
    discriminant: 13,
    name: "EmptyMetadata",
    code: "MV_ARGUMENT_INVALID",
    message: "Metadata pointer must not be empty.",
  },
  AlreadyOwner: {
    discriminant: 14,
    name: "AlreadyOwner",
    code: "MV_CONFLICT",
    message: "Proposed new owner is already the current owner.",
  },
  NoPendingTransfer: {
    discriminant: 15,
    name: "NoPendingTransfer",
    code: "MV_NOT_FOUND",
    message: "No pending ownership transfer exists for this resource.",
  },
  ReservedId: {
    discriminant: 16,
    name: "ReservedId",
    code: "MV_ARGUMENT_INVALID",
    message: "Resource id collides with a reserved word (e.g. 'admin', 'registry').",
  },
  PriceExceedsMax: {
    discriminant: 17,
    name: "PriceExceedsMax",
    code: "MV_ARGUMENT_INVALID",
    message: "Price exceeds the contract maximum.",
  },
  AdminNotSet: {
    discriminant: 18,
    name: "AdminNotSet",
    code: "MV_CONTRACT_ERROR",
    message: "Operation requires an admin but none has been bootstrapped yet.",
  },
  NotVerifier: {
    discriminant: 19,
    name: "NotVerifier",
    code: "MV_AUTH_REJECTED",
    message: "Caller does not hold the verifier role.",
  },
  InvalidVerificationTransition: {
    discriminant: 20,
    name: "InvalidVerificationTransition",
    code: "MV_CONFLICT",
    message: "The requested verification status transition is not allowed.",
  },
  AlreadyFrozen: {
    discriminant: 21,
    name: "AlreadyFrozen",
    code: "MV_CONFLICT",
    message: "Resource metadata is already frozen.",
  },
  MetadataFrozen: {
    discriminant: 22,
    name: "MetadataFrozen",
    code: "MV_CONFLICT",
    message: "Metadata cannot be updated because it has been frozen.",
  },
  DuplicateInRepair: {
    discriminant: 23,
    name: "DuplicateInRepair",
    code: "MV_ARGUMENT_INVALID",
    message: "Index repair received a list with duplicate resource ids.",
  },
  InvalidTxHash: {
    discriminant: 24,
    name: "InvalidTxHash",
    code: "MV_ARGUMENT_INVALID",
    message: "Transaction hash is empty or exceeds the 128-byte limit.",
  },
  InvalidPaymentAmount: {
    discriminant: 25,
    name: "InvalidPaymentAmount",
    code: "MV_ARGUMENT_INVALID",
    message: "Payment or refund amount is zero or negative, or refund window is invalid.",
  },
  NotModerator: {
    discriminant: 26,
    name: "NotModerator",
    code: "MV_AUTH_REJECTED",
    message: "Caller does not hold the moderator role.",
  },
  AlreadyFlagged: {
    discriminant: 27,
    name: "AlreadyFlagged",
    code: "MV_CONFLICT",
    message: "Resource is already flagged as disputed.",
  },
  NotFlagged: {
    discriminant: 28,
    name: "NotFlagged",
    code: "MV_CONFLICT",
    message: "Resource is not currently flagged as disputed.",
  },
  InvalidLifecycleTransition: {
    discriminant: 29,
    name: "InvalidLifecycleTransition",
    code: "MV_CONFLICT",
    message: "The requested lifecycle state transition is not allowed from the current state.",
  },
  ResourceNotMutable: {
    discriminant: 30,
    name: "ResourceNotMutable",
    code: "MV_CONFLICT",
    message:
      "Resource is frozen, disputed, or tombstoned and cannot be changed; or is not Listed and cannot accept a payment or lease.",
  },
  NetworkAlreadyInitialized: {
    discriminant: 31,
    name: "NetworkAlreadyInitialized",
    code: "MV_CONFLICT",
    message: "Network identifier has already been initialized for this contract instance.",
  },
  NetworkIdMismatch: {
    discriminant: 32,
    name: "NetworkIdMismatch",
    code: "MV_CONTRACT_ERROR",
    message:
      "Invocation network identifier does not match the configured network. Check SOROBAN_RPC_URL and STELLAR_NETWORK.",
  },
  NetworkNotInitialized: {
    discriminant: 33,
    name: "NetworkNotInitialized",
    code: "MV_CONTRACT_ERROR",
    message: "Network identifier has not been initialized. The contract needs setup.",
  },
  FeeBpsTooHigh: {
    discriminant: 34,
    name: "FeeBpsTooHigh",
    code: "MV_ARGUMENT_INVALID",
    message: "A fee basis-point value exceeds the configured ceiling.",
  },
  TotalFeeTooHigh: {
    discriminant: 35,
    name: "TotalFeeTooHigh",
    code: "MV_ARGUMENT_INVALID",
    message: "The combined fee policy or fee-destination split is invalid.",
  },
  CountOverflow: {
    discriminant: 36,
    name: "CountOverflow",
    code: "MV_CONTRACT_ERROR",
    message: "The global resource count would overflow; the contract is at capacity.",
  },
  BatchTooLarge: {
    discriminant: 37,
    name: "BatchTooLarge",
    code: "MV_ARGUMENT_INVALID",
    message: "Batch exceeds the maximum supported number of items.",
  },
  DuplicateReceipt: {
    discriminant: 38,
    name: "DuplicateReceipt",
    code: "MV_CONFLICT",
    message: "A purchase receipt already exists for this resource and buyer.",
  },
  FlagReasonHashTooLong: {
    discriminant: 39,
    name: "FlagReasonHashTooLong",
    code: "MV_ARGUMENT_INVALID",
    message: "Flag reason hash exceeds the 64-byte limit.",
  },
  ContractPaused: {
    discriminant: 40,
    name: "ContractPaused",
    code: "MV_CONTRACT_ERROR",
    message: "The registry contract is paused. State-changing operations are temporarily blocked.",
  },
  NotSettler: {
    discriminant: 41,
    name: "NotSettler",
    code: "MV_AUTH_REJECTED",
    message: "Caller does not hold the settler role.",
  },
  ReceiptAlreadyExists: {
    discriminant: 42,
    name: "ReceiptAlreadyExists",
    code: "MV_CONFLICT",
    message: "A payment or refund receipt already exists for the supplied id.",
  },
  InvalidPaymentTransition: {
    discriminant: 43,
    name: "InvalidPaymentTransition",
    code: "MV_CONFLICT",
    message:
      "Payment is not settled, its refund deadline has expired, or the state transition is not allowed.",
  },
  InvalidReceiptId: {
    discriminant: 44,
    name: "InvalidReceiptId",
    code: "MV_ARGUMENT_INVALID",
    message: "Receipt id is empty or exceeds the 64-byte limit.",
  },
  ContentHashTooLong: {
    discriminant: 45,
    name: "ContentHashTooLong",
    code: "MV_ARGUMENT_INVALID",
    message: "Content hash exceeds the 128-byte limit.",
  },
  AttestationHashTooLong: {
    discriminant: 46,
    name: "AttestationHashTooLong",
    code: "MV_ARGUMENT_INVALID",
    message: "Attestation hash exceeds the 64-byte limit.",
  },
  PaymentAmountMismatch: {
    discriminant: 47,
    name: "PaymentAmountMismatch",
    code: "MV_ARGUMENT_INVALID",
    message:
      "Payment amount differs from the resource price, or cumulative refunds exceed the original payment.",
  },
  DuplicateTxHash: {
    discriminant: 48,
    name: "DuplicateTxHash",
    code: "MV_CONFLICT",
    message: "A receipt already uses this transaction hash.",
  },
  FeeConfigNotSet: {
    discriminant: 49,
    name: "FeeConfigNotSet",
    code: "MV_CONTRACT_ERROR",
    message: "Fee recipient or destination was set before any fee config was configured.",
  },
  AdminNominationExpired: {
    discriminant: 50,
    name: "AdminNominationExpired",
    code: "MV_CONTRACT_ERROR",
    message: "The pending admin nomination is missing or has expired.",
  },
  InvalidMetadataPointers: {
    discriminant: 51,
    name: "InvalidMetadataPointers",
    code: "MV_ARGUMENT_INVALID",
    message:
      "set_metadata_pointers received zero, too many, or duplicate pointers, or an out-of-range primary index.",
  },
  AdminAlreadySet: {
    discriminant: 52,
    name: "AdminAlreadySet",
    code: "MV_CONFLICT",
    message: "bootstrap_dual_admin was called after an admin was already set.",
  },
  RecoveryAdminNotSet: {
    discriminant: 53,
    name: "RecoveryAdminNotSet",
    code: "MV_CONTRACT_ERROR",
    message: "recover_admin was called but no recovery admin is configured.",
  },
  UnsupportedResourceSchema: {
    discriminant: 54,
    name: "UnsupportedResourceSchema",
    code: "MV_CONTRACT_ERROR",
    message:
      "Resource uses a schema version this contract deployment cannot read or migrate. Update the contract or the registry-client bindings.",
  },
  RevisionOverflow: {
    discriminant: 55,
    name: "RevisionOverflow",
    code: "MV_CONTRACT_ERROR",
    message: "Listing revision counter would overflow; the resource cannot be mutated further.",
  },
};

/**
 * Look up the MV_ code for a vault-registry contract error name.
 *
 * Returns `MV_CONTRACT_ERROR` for any name not in the map (e.g. a future
 * discriminant from a newer contract version) so clients always get a valid
 * code even when the map is stale.
 */
export function registryErrorCodeFor(name: RegistryErrorName): ErrorCode {
  return REGISTRY_ERROR_MAP[name]?.code ?? "MV_CONTRACT_ERROR";
}

/**
 * Look up the stable SDK message for a vault-registry contract error name.
 *
 * Returns `undefined` for unknown names; callers should fall back to the
 * raw error message in that case.
 */
export function registryErrorMessageFor(name: RegistryErrorName): string | undefined {
  return REGISTRY_ERROR_MAP[name]?.message;
}

/** All registry error names defined in the map, sorted. */
export const ALL_REGISTRY_ERROR_NAMES: RegistryErrorName[] = Object.keys(
  REGISTRY_ERROR_MAP,
).sort() as RegistryErrorName[];
