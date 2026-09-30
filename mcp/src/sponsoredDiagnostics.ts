/**
 * Structured diagnostics for sponsored-account service outages.
 *
 * `mindvault_setup_wallet` is the first tool an agent calls, and it depends on a
 * single external service — the sponsored-account service that mints and funds
 * the Stellar account. When that service is down the agent is stuck at step one,
 * so the failure has to explain itself: which service was called, whether it
 * answered at all, what kind of outage this is, whether retrying can help, and
 * how long to wait.
 *
 * The diagnostics used to be assembled inline in `setupWallet` and had three
 * gaps this module closes:
 *
 *  1. They only ran when the service returned a non-ok *response*. The most
 *     common outage — unreachable host, refused connection, timeout — throws at
 *     the transport layer before that code runs, so exactly the case that needed
 *     diagnostics produced none.
 *  2. Several answered statuses (502, 504, 404, 401) fell through to empty
 *     guidance, leaving the agent with no next step.
 *  3. An error body with no recognized message field was dumped verbatim into
 *     the agent-visible error, leaking the service's internal error codes and
 *     stack traces.
 *
 * Everything here is a pure function of (service URL, status, body, headers), so
 * the same outage always renders the same text and can be asserted in tests. No
 * I/O; `index.ts` owns the wiring.
 */

import { redactSecrets } from "./diagnostics.js";
import { categorizeStatus, type ErrorCategory, type MappedError } from "./errorMapping.js";

/** What kind of outage the sponsored-account service is having. */
export type SponsoredOutageKind =
  | "unreachable"
  | "timeout"
  | "unavailable"
  | "rate_limited"
  | "server_error"
  | "rejected"
  | "unknown";

/** A sponsored-account failure, classified into machine-readable fields. */
export interface SponsoredOutage {
  /** The service that was called, with any embedded credentials stripped. */
  service: string;
  /** The path that was requested, e.g. `POST /create`. */
  endpoint: string;
  /** False when the service never produced a response (DNS, refused, timeout). */
  reachable: boolean;
  kind: SponsoredOutageKind;
  /** HTTP status, when the service answered. */
  status?: number;
  /** Whether repeating the identical call has a realistic chance of succeeding. */
  retryable: boolean;
  /** Seconds to wait before retrying, when the service asked for a delay. */
  retryAfterSeconds?: number;
  /** Imperative next steps, most specific first. */
  guidance: string[];
}

/** The endpoint `setupWallet` calls. */
export const SPONSORED_CREATE_PATH = "/create";

/** Longest `Retry-After` we echo back; anything larger is service misconfig. */
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** Cap on the service-supplied message we quote, so one reply cannot flood the agent. */
const MAX_DETAIL_LEN = 200;

/** Body fields whose value is a message meant for the caller, so safe to quote. */
const SAFE_DETAIL_FIELDS = ["error", "message", "detail", "reason"] as const;

/**
 * Render a service URL safe to show: drop `user:password@`, the query string,
 * and any fragment, since an operator may point SPONSORED_ACCOUNT_URL at a
 * private deployment whose URL carries a token.
 */
export function sanitizeServiceUrl(serviceUrl: string): string {
  try {
    const url = new URL(serviceUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "(invalid SPONSORED_ACCOUNT_URL)";
  }
}

/**
 * Extract the part of an error body that is safe to show an agent.
 *
 * Only the conventional message fields are quoted. Anything else — internal
 * error codes, stack traces, database detail — is summarized by shape rather
 * than value, so a chatty upstream cannot leak its internals through a tool
 * error the agent may log or echo back to a user.
 */
export function sponsoredFailureDetail(data: unknown): string {
  if (data == null) return "no response body";

  if (typeof data === "string") {
    const text = data.trim();
    if (!text) return "empty response body";
    // A non-JSON body is often an HTML error page from a proxy in front of the
    // service; quote it, but bounded and redacted.
    return truncate(redactSecrets(text));
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const field of SAFE_DETAIL_FIELDS) {
      const value = obj[field];
      if (typeof value === "string" && value.trim()) {
        return truncate(redactSecrets(value.trim()));
      }
    }
    const fields = Object.keys(obj).length;
    return `the service returned an error body with no message field (${fields} field${
      fields === 1 ? "" : "s"
    } withheld)`;
  }

  return truncate(redactSecrets(String(data)));
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_LEN ? text : `${text.slice(0, MAX_DETAIL_LEN)}…`;
}

/**
 * Parse a `Retry-After` header into whole seconds. Accepts both forms the spec
 * allows — a delay in seconds and an HTTP date — and rejects anything negative,
 * unparseable, or implausibly far in the future.
 */
export function parseRetryAfter(
  headers: Record<string, string> | undefined,
  now: number = Date.now(),
): number | undefined {
  const raw = headers?.["retry-after"];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds < 0 || seconds > MAX_RETRY_AFTER_SECONDS) return undefined;
  return seconds;
}

/** Classify a sponsored failure from the category and status already mapped. */
function classify(category: ErrorCategory, status: number | undefined): SponsoredOutageKind {
  if (category === "timeout" && status === undefined) return "timeout";
  if (category === "network") return "unreachable";
  if (category === "rate_limit") return "rate_limited";
  if (status === undefined) return "unknown";
  // 502/503/504 all mean "the service itself is not answering right now",
  // whether the hop in front of it timed out or the process is restarting.
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  if (status >= 500) return "server_error";
  if (status >= 400) return "rejected";
  return "unknown";
}

/**
 * Whether repeating the identical request can plausibly succeed. A 4xx other
 * than 429 is a decision about *this* request, so retrying it unchanged will
 * fail the same way.
 */
function isRetryable(kind: SponsoredOutageKind): boolean {
  return kind !== "rejected";
}

/** The next steps for a rejected (4xx) request, which vary by status. */
function rejectionGuidance(service: string, status: number | undefined): string {
  if (status === 401 || status === 403) {
    return `The sponsored-account service rejected this client. Check whether ${service} points at a deployment that requires credentials.`;
  }
  if (status === 404) {
    return `No account-creation endpoint at ${service}${SPONSORED_CREATE_PATH}. Check that SPONSORED_ACCOUNT_URL points at the sponsored-account service.`;
  }
  return "The request was malformed; this may indicate a client-side issue.";
}

/**
 * Outage kinds where the request may already have been processed.
 *
 * The distinction matters because account creation is not idempotent and is not
 * replayed by the retry layer. `unreachable` means the connection never opened,
 * so nothing ran. A `timeout` means the opposite of nothing: the service took
 * the request and stopped answering, which is exactly the half-completed
 * creation in #839 — the account can be minted and funded while the reply
 * carrying its secret key is lost. A 5xx can come from the app after it acted
 * or from a proxy before it did, and the agent cannot tell which.
 */
const MAY_HAVE_BEEN_PROCESSED = new Set<SponsoredOutageKind>([
  "timeout",
  "unavailable",
  "server_error",
  "unknown",
]);

/**
 * What a retry does and does not recover.
 *
 * The previous wording asserted "no wallet was created, so retrying is safe" on
 * the 5xx paths. Safe is right; "no wallet was created" is not something this
 * server can know — it never got an answer. Retrying is safe because it mints a
 * *new* account, not because the last attempt did nothing, and any account the
 * service already funded is orphaned: without its secret key nobody can spend
 * from it. Saying so keeps an operator from hunting for a wallet that was never
 * handed over.
 */
function retrySafetyNote(kind: SponsoredOutageKind): string {
  if (kind === "rejected") {
    return "No wallet was created or persisted; the local keystore is unchanged.";
  }
  if (!MAY_HAVE_BEEN_PROCESSED.has(kind)) {
    return "The request never reached the service, so no wallet was created and the local keystore is unchanged.";
  }
  return (
    "No wallet was persisted locally, so retrying is safe — but it creates a NEW account: " +
    "if the service already funded one before failing, that account is orphaned (its secret key was never delivered) " +
    "and cannot be recovered or spent."
  );
}

/**
 * The next steps for each kind of outage, ordered most-specific first so the
 * leading sentence is the one an agent should act on.
 */
function guidanceFor(outage: Omit<SponsoredOutage, "guidance">): string[] {
  const steps: string[] = [];

  switch (outage.kind) {
    case "unreachable":
      steps.push(
        "Network connectivity issue; the sponsored-account service could not be reached at all.",
        `Check your connection and that ${outage.service} is correct and reachable, then retry.`,
      );
      break;
    case "timeout":
      steps.push(
        "The sponsored-account service accepted the connection but did not answer in time.",
        "Retry, or raise MINDVAULT_HTTP_TIMEOUT_MS if the service is known to be slow.",
      );
      break;
    case "unavailable":
      steps.push(
        "The account sponsorship service is unavailable; it may be restarting.",
        "Wait for it to come back and retry.",
      );
      break;
    case "rate_limited":
      steps.push("Rate limit reached on account creation; wait a moment and retry.");
      break;
    case "server_error":
      steps.push(
        "The service encountered an internal error; contact support if it persists.",
        "Retry once.",
      );
      break;
    case "rejected":
      steps.push(
        rejectionGuidance(outage.service, outage.status),
        "Retrying the identical request will fail the same way — fix the configuration first.",
      );
      break;
    case "unknown":
      steps.push(
        "The sponsored-account service failed in an unrecognized way.",
        "Retry once; if it persists, report the summary above along with the service URL.",
      );
      break;
  }

  steps.push(retrySafetyNote(outage.kind));

  if (outage.retryAfterSeconds !== undefined) {
    steps.push(`The service asked for a ${outage.retryAfterSeconds}s wait before retrying.`);
  }
  return steps;
}

/**
 * Classify a sponsored-account failure into a structured outage.
 *
 * Covers both failure paths: pass `status`/`headers` when the service answered,
 * and omit them when the request never got a response — the category is then
 * `network` or `timeout`.
 */
export function diagnoseSponsoredOutage(input: {
  serviceUrl: string;
  category: ErrorCategory;
  status?: number;
  headers?: Record<string, string>;
  endpoint?: string;
  now?: number;
}): SponsoredOutage {
  const service = sanitizeServiceUrl(input.serviceUrl);
  const kind = classify(input.category, input.status);
  const base: Omit<SponsoredOutage, "guidance"> = {
    service,
    endpoint: `POST ${input.endpoint ?? SPONSORED_CREATE_PATH}`,
    reachable: input.status !== undefined,
    kind,
    status: input.status,
    retryable: isRetryable(kind),
    retryAfterSeconds: parseRetryAfter(input.headers, input.now),
  };
  return { ...base, guidance: guidanceFor(base) };
}

/**
 * Render the diagnostics line that sits under the error summary.
 *
 * The `Service:` / `Status:` / `Issue:` labels are the ones the tool contract
 * already keys on and are kept verbatim; `Reachable` and `Retryable` are the
 * additions that let an agent decide whether to back off or give up without
 * parsing prose.
 */
export function formatSponsoredOutage(outage: SponsoredOutage): string {
  return [
    `Service: ${outage.service}`,
    `Endpoint: ${outage.endpoint}`,
    outage.status !== undefined ? `Status: ${outage.status}` : null,
    `Issue: ${outage.kind}`,
    `Reachable: ${outage.reachable ? "yes" : "no"}`,
    `Retryable: ${outage.retryable ? "yes" : "no"}`,
    outage.retryAfterSeconds !== undefined ? `Retry-After: ${outage.retryAfterSeconds}s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Attach sponsored-account diagnostics to an already-mapped error: the mapped
 * summary stays on the first line, the diagnostics line goes beneath it, and the
 * outage guidance replaces the generic per-category action.
 */
export function withSponsoredDiagnostics(
  mapped: MappedError,
  input: { serviceUrl: string; headers?: Record<string, string>; endpoint?: string; now?: number },
): MappedError {
  const outage = diagnoseSponsoredOutage({
    serviceUrl: input.serviceUrl,
    category: mapped.category,
    status: mapped.status,
    headers: input.headers,
    endpoint: input.endpoint,
    now: input.now,
  });
  return {
    ...mapped,
    summary: `${mapped.summary}\n${formatSponsoredOutage(outage)}`,
    action: outage.guidance.join(" ") || mapped.action,
  };
}

/**
 * Map a non-ok response from the sponsored-account service into a fully
 * diagnosed error. Unlike the generic `mapHttpError`, the detail is drawn only
 * from the body's recognized message fields, so an unrecognized body cannot leak
 * the service's internals.
 */
export function mapSponsoredHttpFailure(input: {
  operation: string;
  serviceUrl: string;
  status: number;
  data: unknown;
  headers?: Record<string, string>;
  endpoint?: string;
  now?: number;
}): MappedError {
  const mapped: MappedError = {
    source: "sponsored",
    category: categorizeStatus(input.status),
    status: input.status,
    summary: `${input.operation}: ${sponsoredFailureDetail(input.data)}`,
    action: "",
  };
  return withSponsoredDiagnostics(mapped, input);
}

/**
 * Map a transport-level sponsored-account failure — the outage case the old
 * inline diagnostics never reached, because nothing ever answered.
 *
 * `jsonFetch` has already classified the throw as `network` or `timeout`; this
 * re-labels it under the caller's operation and adds the outage diagnostics.
 */
export function mapSponsoredTransportFailure(input: {
  operation: string;
  serviceUrl: string;
  mapped: MappedError;
  endpoint?: string;
}): MappedError {
  const detail = redactSecrets(input.mapped.detail ?? input.mapped.summary);
  return withSponsoredDiagnostics(
    {
      ...input.mapped,
      source: "sponsored",
      detail,
      summary: `${input.operation}: ${detail}`,
    },
    { serviceUrl: input.serviceUrl, endpoint: input.endpoint },
  );
}
