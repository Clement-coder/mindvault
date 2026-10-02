/**
 * Soroban RPC failover configuration — issue #588.
 *
 * `SOROBAN_RPC_URL` names exactly one endpoint. When that endpoint is down,
 * rate-limiting, or simply slow enough to blow the request budget, every
 * on-chain tool in the server fails — registry lookups, transaction status,
 * consistency checks — even though other public RPC providers are serving the
 * same network perfectly well. Retrying, which the server already does, does
 * not help: it retries the same dead host.
 *
 * This module lets an operator configure a list of endpoints and tries them in
 * order. Three things make that safe rather than merely hopeful:
 *
 * **Only transport failures fail over.** A connection error, a 5xx, a 429 or a
 * timeout means "this host cannot answer" and is worth asking someone else. A
 * 400 means the *request* is wrong; asking a second host produces the same 400
 * more slowly, so it is returned immediately.
 *
 * **A failed endpoint is parked, not blacklisted.** After a failure an endpoint
 * is skipped for a cooldown window and then quietly tried again, so a provider
 * that recovers is used again without a restart, and one that is flapping is
 * not hammered.
 *
 * **The order is stable.** Endpoints are tried in the order configured, and the
 * first healthy one is preferred rather than a random or round-robin pick, so
 * the primary stays the primary and reproducing a problem does not depend on
 * which host a request happened to land on.
 *
 * Pure and injectable (clock, request function) so the behaviour is testable
 * without real endpoints or real waiting.
 */

/** Environment variables controlling failover. */
export const RPC_FAILOVER_ENV_VARS = {
  /** Comma-separated endpoint list, highest priority first. */
  endpoints: "MINDVAULT_SOROBAN_RPC_URLS",
  /** How long a failed endpoint is skipped, in milliseconds. */
  cooldownMs: "MINDVAULT_RPC_FAILOVER_COOLDOWN_MS",
  /** Cap on endpoints tried for a single call. */
  maxAttempts: "MINDVAULT_RPC_FAILOVER_MAX_ATTEMPTS",
} as const;

/** 30s: long enough to ride out a deploy, short enough to recover promptly. */
export const DEFAULT_COOLDOWN_MS = 30_000;

/** 0 means "try every configured endpoint". */
export const DEFAULT_MAX_ATTEMPTS = 0;

export interface FailoverConfig {
  /** Endpoints in priority order. Always at least one entry. */
  endpoints: string[];
  cooldownMs: number;
  /** 0 = unlimited (bounded by the endpoint count regardless). */
  maxAttempts: number;
}

/** HTTP statuses that mean "this host cannot answer right now". */
const FAILOVER_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isFailoverStatus(status: number): boolean {
  return FAILOVER_STATUSES.has(status);
}

/**
 * Whether a thrown error justifies trying the next endpoint.
 *
 * Network-level failures and timeouts do; anything else is assumed to be the
 * caller's problem and is surfaced as-is.
 */
export function isFailoverError(error: unknown): boolean {
  if (error instanceof Error) {
    // RequestTimeoutError from httpTimeout.ts reports name "TimeoutError".
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE"
    ) {
      return true;
    }
    // node-fetch and undici wrap transport failures in a generic TypeError.
    if (error.name === "FetchError" || error.name === "TypeError") return true;
    if (error.cause !== undefined && error.cause !== null) return isFailoverError(error.cause);
  }
  return false;
}

/**
 * Split a configured endpoint list.
 *
 * Comma- or whitespace-separated, blanks dropped, duplicates removed while
 * keeping first position — a list that names the same host twice should not
 * make it two independent attempts.
 */
export function parseEndpointList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const url = part.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    endpoints.push(url);
  }
  return endpoints;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Resolve the failover configuration.
 *
 * `MINDVAULT_SOROBAN_RPC_URLS` wins when set; otherwise the single
 * `SOROBAN_RPC_URL` (or the network preset behind it) is used as a
 * one-endpoint list, so an operator who has configured nothing gets exactly
 * today's behaviour.
 *
 * When both are set, the single URL is promoted to the front of the list if it
 * is not already present — an operator who pinned a primary and then added
 * alternates should not silently lose the pin.
 */
export function resolveFailoverConfig(
  env: NodeJS.ProcessEnv,
  fallbackEndpoint: string,
): FailoverConfig {
  const listed = parseEndpointList(env[RPC_FAILOVER_ENV_VARS.endpoints]);
  const single = env.SOROBAN_RPC_URL?.trim();

  let endpoints: string[];
  if (listed.length === 0) {
    endpoints = [single || fallbackEndpoint];
  } else if (single && !listed.includes(single)) {
    endpoints = [single, ...listed];
  } else {
    endpoints = listed;
  }

  return {
    endpoints,
    cooldownMs: parseNonNegativeInt(env[RPC_FAILOVER_ENV_VARS.cooldownMs], DEFAULT_COOLDOWN_MS),
    maxAttempts: parseNonNegativeInt(env[RPC_FAILOVER_ENV_VARS.maxAttempts], DEFAULT_MAX_ATTEMPTS),
  };
}

/** One endpoint attempt, for logging and diagnostics. */
export interface FailoverAttempt {
  endpoint: string;
  outcome: "success" | "status" | "error" | "skipped";
  status?: number;
  error?: unknown;
}

/** Raised when every endpoint has been tried and none could answer. */
export class AllEndpointsFailedError extends Error {
  readonly attempts: FailoverAttempt[];

  constructor(attempts: FailoverAttempt[], lastError?: unknown) {
    const tried = attempts.map((a) => a.endpoint).join(", ");
    super(
      `All ${attempts.length} Soroban RPC endpoint(s) failed (${tried}). ` +
        `Check connectivity or configure alternates with ${RPC_FAILOVER_ENV_VARS.endpoints}.`,
    );
    this.name = "AllEndpointsFailedError";
    this.attempts = attempts;
    if (lastError !== undefined) this.cause = lastError;
  }
}

/**
 * Tracks endpoint health and runs a request against the first healthy one.
 *
 * State is per-instance and in-memory: one server process shares its view of
 * which providers are struggling across every tool call it makes.
 */
export class RpcFailover {
  readonly config: FailoverConfig;

  private readonly now: () => number;
  /** endpoint -> epoch ms before which it is skipped. */
  private readonly parkedUntil = new Map<string, number>();

  constructor(config: FailoverConfig, now: () => number = Date.now) {
    if (config.endpoints.length === 0) {
      throw new Error("RpcFailover requires at least one endpoint");
    }
    this.config = config;
    this.now = now;
  }

  /** Endpoints in priority order. */
  get endpoints(): string[] {
    return [...this.config.endpoints];
  }

  /** Whether an endpoint is currently inside its cooldown window. */
  isParked(endpoint: string): boolean {
    const until = this.parkedUntil.get(endpoint);
    return until !== undefined && this.now() < until;
  }

  /** Park an endpoint for the configured cooldown. */
  park(endpoint: string): void {
    if (this.config.cooldownMs > 0) {
      this.parkedUntil.set(endpoint, this.now() + this.config.cooldownMs);
    }
  }

  /** Clear an endpoint's cooldown — it answered. */
  private revive(endpoint: string): void {
    this.parkedUntil.delete(endpoint);
  }

  /**
   * The endpoint a new request should prefer: the first that is not parked.
   *
   * When every endpoint is parked the primary is returned anyway. Refusing to
   * make a call because the whole world was recently unhealthy would turn a
   * transient outage into a self-inflicted one.
   */
  preferredEndpoint(): string {
    return this.config.endpoints.find((e) => !this.isParked(e)) ?? this.config.endpoints[0];
  }

  /** The order this call will try, healthy endpoints first. */
  attemptOrder(): string[] {
    const healthy = this.config.endpoints.filter((e) => !this.isParked(e));
    const parked = this.config.endpoints.filter((e) => this.isParked(e));
    // Parked endpoints stay on the end rather than being dropped: if every
    // healthy host fails mid-call, a parked one is still better than nothing.
    const order = [...healthy, ...parked];
    const limit = this.config.maxAttempts > 0 ? this.config.maxAttempts : order.length;
    return order.slice(0, limit);
  }

  /**
   * Run `send` against each endpoint until one answers.
   *
   * `send` receives the endpoint URL and returns whatever the caller needs; a
   * `Response`-shaped result is inspected for a failover-worthy status, so an
   * HTTP 503 advances to the next host rather than being handed back as a
   * successful call.
   */
  async run<T extends { status?: number }>(
    send: (endpoint: string) => Promise<T>,
    onAttempt?: (attempt: FailoverAttempt) => void,
  ): Promise<T> {
    const order = this.attemptOrder();
    const attempts: FailoverAttempt[] = [];
    let lastError: unknown;

    for (const endpoint of order) {
      try {
        const result = await send(endpoint);
        const status = typeof result?.status === "number" ? result.status : undefined;

        if (status !== undefined && isFailoverStatus(status)) {
          this.park(endpoint);
          const attempt: FailoverAttempt = { endpoint, outcome: "status", status };
          attempts.push(attempt);
          onAttempt?.(attempt);
          lastError = new Error(`${endpoint} returned HTTP ${status}`);
          continue;
        }

        this.revive(endpoint);
        const attempt: FailoverAttempt = { endpoint, outcome: "success", status };
        attempts.push(attempt);
        onAttempt?.(attempt);
        return result;
      } catch (error) {
        if (!isFailoverError(error)) {
          // A malformed request fails the same way everywhere; retrying it
          // against three hosts only makes the error slower.
          throw error;
        }
        this.park(endpoint);
        const attempt: FailoverAttempt = { endpoint, outcome: "error", error };
        attempts.push(attempt);
        onAttempt?.(attempt);
        lastError = error;
      }
    }

    throw new AllEndpointsFailedError(attempts, lastError);
  }
}

/** Compact, operator-facing summary for the network-profile tool. */
export function describeFailover(failover: RpcFailover): string {
  const { endpoints, cooldownMs, maxAttempts } = failover.config;
  if (endpoints.length === 1) return `${endpoints[0]} (no failover configured)`;
  const rendered = endpoints
    .map((endpoint) => (failover.isParked(endpoint) ? `${endpoint} [cooling down]` : endpoint))
    .join(" → ");
  return (
    `${rendered} (cooldown=${cooldownMs}ms, ` +
    `maxAttempts=${maxAttempts > 0 ? maxAttempts : "all"})`
  );
}
