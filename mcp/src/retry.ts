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
 * Whether a thrown error is worth another attempt.
 *
 * Transport failures and timeouts are transient. A caller-initiated abort is
 * not — the caller asked to stop, so retrying would ignore that.
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return false;
  if (name === "TimeoutError") return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timed? ?out/i.test(
    message,
  );
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
 * A server-supplied Retry-After (seconds, or an HTTP date) in milliseconds, or
 * null when absent/unparseable. Honouring it is politer than guessing, but it is
 * still clamped to maxDelayMs so a hostile or mistaken header cannot stall a
 * tool call.
 */
export function retryAfterDelay(
  headerValue: string | null | undefined,
  policy: RetryPolicy,
  now: number = Date.now(),
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.floor(seconds * 1000), policy.maxDelayMs);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - now), policy.maxDelayMs);
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
