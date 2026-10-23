/**
 * Bounded retry with jittered exponential backoff for transient MCP failures.
 *
 * A single dropped connection or a 503 from a cold-starting backend used to fail
 * a whole tool call, leaving the agent to decide whether retrying was safe. It
 * usually is — for reads. So idempotent calls (catalog GETs, Horizon balance
 * reads, Soroban `getTransaction`) retry automatically.
 *
 * Three properties keep that safe:
 *
 *  - **Bounded.** A fixed attempt cap and a delay ceiling, so a failing
 *    dependency degrades into a slightly slower error, never an unbounded stall.
 *  - **Jittered.** Randomised delays stop concurrent agents from retrying in
 *    lockstep and hammering a service that is already struggling.
 *  - **Never applied to payments.** x402 paid fetches are not idempotent — a
 *    retry can sign and settle a second USDC transfer. They are excluded by
 *    construction: retries are opt-in per call site, and the payment path never
 *    opts in.
 *
 * The module is pure and injectable (sleep, random, clock) so backoff is
 * unit-testable without real waiting.
 */

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  attempts: number;
  /** Base delay for the first retry, doubled each subsequent attempt. */
  baseDelayMs: number;
  /** Ceiling applied to the exponential delay before jitter. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

export const RETRY_ENV_VARS = {
  attempts: "MINDVAULT_RETRY_ATTEMPTS",
  baseDelayMs: "MINDVAULT_RETRY_BASE_DELAY_MS",
  maxDelayMs: "MINDVAULT_RETRY_MAX_DELAY_MS",
} as const;

/** HTTP statuses worth retrying: transient server and throttling conditions. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Methods safe to replay. Anything else is treated as non-idempotent. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export function isIdempotentMethod(method: string | undefined): boolean {
  return IDEMPOTENT_METHODS.has((method ?? "GET").toUpperCase());
}

/**
 * Categories from `errorMapping.ts` that describe the request itself, not the
 * service's ability to answer it. Replaying the same call reproduces them.
 */
const DETERMINISTIC_CATEGORIES: ReadonlySet<string> = new Set([
  "auth",
  "validation",
  "payment",
  "not_found",
  "conflict",
  "contract",
]);

/** Categories from `errorMapping.ts` that a later attempt can clear. */
const TRANSIENT_CATEGORIES: ReadonlySet<string> = new Set([
  "network",
  "timeout",
  "rate_limit",
  "server",
]);

/**
 * Error classes raised for malformed input or an unusable response. They fail
 * the same way on every attempt: `ToolValidationError` / `UnknownToolError`
 * (bad tool arguments, `validation.ts`), `ResponseSizeLimitError` (an
 * oversized body), and `SyntaxError` (a body that is not the expected JSON).
 */
const DETERMINISTIC_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ToolValidationError",
  "UnknownToolError",
  "ResponseSizeLimitError",
  "SyntaxError",
  "ZodError",
]);

/** Socket-level `errno` codes that mean the connection, not the request, failed. */
const TRANSIENT_ERRNO_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * A Soroban host or contract error (`Error(Contract, #11)`, `Error(Auth, …)`,
 * a `HostError` from simulation). The contract rejected the arguments, so the
 * same call is rejected again.
 */
const CONTRACT_ERROR_PATTERN = /\bError\((?:Contract|Auth|Value),|\bHostError\b/;

/**
 * Transport failures recognised from the message alone, for errors that carry
 * no code. Deliberately narrow: a bare "network" or "timeout" substring used
 * to match a contract's `NetworkIdMismatch` or an argument error about a
 * timeout value, and those were retried as if the connection had dropped.
 */
const TRANSIENT_MESSAGE_PATTERN =
  /fetch failed|network ?error|network request failed|socket hang up|\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE)\b|\btimed out\b|\brequest timeout\b/i;

function numericStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** An HTTP status carried by a thrown error, when it has one. */
function statusOf(error: object): number | undefined {
  const e = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown } | null;
  };
  return (
    numericStatus(e.status) ?? numericStatus(e.statusCode) ?? numericStatus(e.response?.status)
  );
}

/**
 * Whether a thrown error is worth another attempt.
 *
 * Only transient failures are: a dropped or refused connection, a timeout, or
 * an HTTP status from {@link isRetryableStatus}. Everything that describes the
 * request itself stops at the first attempt, because a replay cannot change
 * the answer and only delays it:
 *
 *  - an HTTP status outside the retryable set (400, 401, 403, 404, 409, 422 …),
 *    whether on the error or on its `errorMapping.ts` mapping;
 *  - a mapped `auth`, `validation`, `payment`, `not_found`, `conflict`, or
 *    `contract` failure;
 *  - malformed tool arguments and unusable responses
 *    ({@link DETERMINISTIC_ERROR_NAMES});
 *  - a Soroban contract or host error.
 *
 * A caller-initiated abort is not retried either — the caller asked to stop.
 * Unrecognised errors are not retried: retrying is the exception, so an error
 * has to look transient to earn a second attempt.
 */
export function isRetryableError(error: unknown): boolean {
  return classifyRetryable(error, 0);
}

function classifyRetryable(error: unknown, depth: number): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return false;
  if (name === "TimeoutError") return true;
  if (typeof name === "string" && DETERMINISTIC_ERROR_NAMES.has(name)) return false;

  const mapped = (error as { mapped?: unknown }).mapped;
  if (mapped && typeof mapped === "object") {
    const mappedStatus = numericStatus((mapped as { status?: unknown }).status);
    if (mappedStatus !== undefined) return isRetryableStatus(mappedStatus);
    const category = (mapped as { category?: unknown }).category;
    if (typeof category === "string") {
      if (DETERMINISTIC_CATEGORIES.has(category)) return false;
      if (TRANSIENT_CATEGORIES.has(category)) return true;
    }
  }

  const status = statusOf(error);
  if (status !== undefined) return isRetryableStatus(status);

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && CONTRACT_ERROR_PATTERN.test(message)) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_ERRNO_CODES.has(code)) return true;

  if (typeof message === "string" && TRANSIENT_MESSAGE_PATTERN.test(message)) return true;

  // undici reports a refused connection as TypeError("fetch failed") with the
  // socket error as its cause; follow a short cause chain.
  const cause = (error as { cause?: unknown }).cause;
  return depth < 3 && cause !== undefined && classifyRetryable(cause, depth + 1);
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

/**
 * Resolve the policy from the environment.
 *
 * Under Vitest the base delay defaults to 0 so suites do not spend real time
 * sleeping between attempts; the attempt count is unchanged, so retry behaviour
 * is still exercised.
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const baseFallback = env.VITEST ? 0 : DEFAULT_RETRY_POLICY.baseDelayMs;
  return {
    attempts: parsePositiveInt(env[RETRY_ENV_VARS.attempts], DEFAULT_RETRY_POLICY.attempts, 1),
    baseDelayMs: parsePositiveInt(env[RETRY_ENV_VARS.baseDelayMs], baseFallback, 0),
    maxDelayMs: parsePositiveInt(
      env[RETRY_ENV_VARS.maxDelayMs],
      DEFAULT_RETRY_POLICY.maxDelayMs,
      0,
    ),
  };
}

/**
 * Resolve a retry policy for one MCP tool. Tool overrides use the global
 * variable name plus a normalized tool suffix, e.g.
 * MINDVAULT_RETRY_ATTEMPTS_MINDVAULT_BROWSE=5.
 */
export function retryPolicyForTool(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): RetryPolicy {
  const globalPolicy = retryPolicyFromEnv(env);
  const suffix = toolName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const read = (name: string, fallback: number, min: number) =>
    parsePositiveInt(env[`${name}_${suffix}`], fallback, min);

  return {
    attempts: read(RETRY_ENV_VARS.attempts, globalPolicy.attempts, 1),
    baseDelayMs: read(RETRY_ENV_VARS.baseDelayMs, globalPolicy.baseDelayMs, 0),
    maxDelayMs: read(RETRY_ENV_VARS.maxDelayMs, globalPolicy.maxDelayMs, 0),
  };
}

/**
 * Delay before the given retry (1 = first retry): exponential backoff capped at
 * maxDelayMs, then full jitter across [0, capped]. Full jitter spreads
 * concurrent retriers far better than a fixed fraction.
 */
export function computeBackoffDelay(
  retryNumber: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  if (policy.baseDelayMs <= 0) return 0;
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, retryNumber - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.floor(random() * capped);
}

/**
 * Parse a Retry-After header value into an **uncapped** wait in milliseconds,
 * or null when the header is absent, empty, or unparseable.
 *
 * RFC 7231 §7.1.3 allows two forms and this accepts both:
 *
 *   - `delay-seconds` — a non-negative integer count of seconds.
 *   - `HTTP-date` — an absolute timestamp (IMF-fixdate, RFC 850, or asctime).
 *
 * A date already in the past yields `0`: the retry may proceed immediately.
 * Nothing here bounds the result — a hostile `Retry-After: 999999` or a date
 * years in the future parses to a huge number. Callers must clamp
 * ({@link retryAfterDelay} does).
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (headerValue == null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * A server-supplied Retry-After (seconds, or an HTTP date) in milliseconds, or
 * null when absent/unparseable.
 *
 * Honouring the header is politer than guessing at backoff, but it is never
 * allowed to stall a tool call: the result is clamped to the retry policy's
 * `maxDelayMs` and, when a tool deadline is supplied, to that too — so an
 * extreme value, a far-future date, or a hostile header degrades to the cap
 * rather than an unbounded sleep. A past date clamps to `0`.
 */
export function retryAfterDelay(
  headerValue: string | null | undefined,
  policy: RetryPolicy,
  now: number = Date.now(),
  deadlineMs: number = Infinity,
): number | null {
  const parsed = parseRetryAfterMs(headerValue, now);
  if (parsed === null) return null;
  const cap = Math.max(0, Math.min(policy.maxDelayMs, deadlineMs));
  return Math.min(parsed, cap);
}

/** What happened on one failed attempt, for logging. */
export interface RetryAttemptInfo {
  /** Short label of the call being retried, e.g. "GET /resources". */
  label: string;
  /** Which attempt just failed (1-based). */
  attempt: number;
  /** Total attempts allowed. */
  attempts: number;
  /** Delay before the next attempt, in milliseconds. */
  delayMs: number;
  /** Why the attempt failed — an HTTP status or an error message. */
  reason: string;
}

/** Single-line, greppable retry log entry. */
export function formatRetryLog(info: RetryAttemptInfo): string {
  return (
    `retrying ${info.label} — attempt ${info.attempt}/${info.attempts} failed ` +
    `(${info.reason}); next attempt in ${info.delayMs}ms`
  );
}

export interface RetryOptions<T> {
  policy: RetryPolicy;
  /** Label used in retry logs. */
  label: string;
  /** True when the result should be retried (e.g. a retryable HTTP status). */
  shouldRetryResult?: (result: T) => boolean;
  /** Why a retryable result failed, for the log line. */
  describeResult?: (result: T) => string;
  /** Delay override taken from the result (e.g. Retry-After). */
  delayFromResult?: (result: T) => number | null;
  /** Called after each failed attempt that will be retried. */
  onRetry?: (info: RetryAttemptInfo) => void;
  /**
   * Awaited before every attempt, including the first.
   *
   * The hook exists for cross-call coordination: a per-origin rate-limit
   * coordinator uses it to hold a call back until the shared backoff for its
   * origin has elapsed, so concurrent calls do not each retry into the same
   * server window. It may reject (e.g. on cancellation) to abort the retry.
   */
  beforeAttempt?: (attempt: number) => Promise<void>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Run `fn` with bounded, jittered retries.
 *
 * Retries on a thrown transient error, or on a result the caller flags as
 * retryable. The final attempt's outcome is returned or thrown unchanged, so
 * callers keep their existing error handling.
 *
 * Only call this for idempotent work — it makes no attempt to detect whether
 * replaying `fn` is safe.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions<T>): Promise<T> {
  const { policy, label } = options;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const attempts = Math.max(1, policy.attempts);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const isLast = attempt === attempts;
    try {
      await options.beforeAttempt?.(attempt);
      const result = await fn();
      if (!isLast && options.shouldRetryResult?.(result)) {
        const override = options.delayFromResult?.(result) ?? null;
        const delayMs = override ?? computeBackoffDelay(attempt, policy, random);
        options.onRetry?.({
          label,
          attempt,
          attempts,
          delayMs,
          reason: options.describeResult?.(result) ?? "retryable result",
        });
        if (delayMs > 0) await sleep(delayMs);
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      if (isLast || !isRetryableError(err)) throw err;
      const delayMs = computeBackoffDelay(attempt, policy, random);
      options.onRetry?.({
        label,
        attempt,
        attempts,
        delayMs,
        reason: err instanceof Error ? err.message : String(err),
      });
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  // Unreachable: the final attempt either returns or throws above.
  throw lastError;
}

/** Compact, operator-facing summary of the active policy. */
export function describeRetryPolicy(policy: RetryPolicy): string {
  if (policy.attempts <= 1) return "disabled";
  return `attempts=${policy.attempts}, baseDelay=${policy.baseDelayMs}ms, maxDelay=${policy.maxDelayMs}ms, jitter=full`;
}
