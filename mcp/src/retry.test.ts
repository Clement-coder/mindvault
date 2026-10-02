/**
 * Unit tests for bounded, jittered retry (#409).
 *
 * Sleep and randomness are injected, so backoff is asserted exactly without any
 * real waiting.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  RETRY_ENV_VARS,
  computeBackoffDelay,
  describeRetryPolicy,
  formatRetryLog,
  isIdempotentMethod,
  isRetryableError,
  isRetryableStatus,
  retryAfterDelay,
  retryPolicyForTool,
  retryPolicyFromEnv,
  withRetry,
  type RetryAttemptInfo,
  type RetryPolicy,
} from "./retry.js";

const policy: RetryPolicy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

/** Records requested delays instead of waiting. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("isRetryableStatus", () => {
  it("retries transient server and throttling statuses", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("does not retry statuses caused by the request itself", () => {
    for (const status of [200, 400, 401, 402, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it("never retries a 402 — replaying a payment could pay twice", () => {
    expect(isRetryableStatus(402)).toBe(false);
  });
});

describe("isIdempotentMethod", () => {
  it("treats reads as safe to replay", () => {
    expect(isIdempotentMethod("GET")).toBe(true);
    expect(isIdempotentMethod("get")).toBe(true);
    expect(isIdempotentMethod("HEAD")).toBe(true);
    expect(isIdempotentMethod(undefined)).toBe(true); // fetch defaults to GET
  });

  it("treats writes as unsafe to replay", () => {
    expect(isIdempotentMethod("POST")).toBe(false);
    expect(isIdempotentMethod("PUT")).toBe(false);
    expect(isIdempotentMethod("PATCH")).toBe(false);
    expect(isIdempotentMethod("DELETE")).toBe(false);
  });
});

describe("isRetryableError", () => {
  it("retries transport failures and timeouts", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("connect ECONNREFUSED 127.0.0.1:4021"))).toBe(true);
    expect(isRetryableError(new Error("getaddrinfo ENOTFOUND api.example"))).toBe(true);

    const timeout = new Error("Request timed out after 15000ms");
    timeout.name = "TimeoutError";
    expect(isRetryableError(timeout)).toBe(true);
  });

  it("does not retry a caller-initiated abort", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isRetryableError(abort)).toBe(false);
  });

  it("does not retry ordinary programming errors", () => {
    expect(isRetryableError(new TypeError("x is not a function"))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe("retryPolicyFromEnv", () => {
  it("uses the documented defaults", () => {
    const resolved = retryPolicyFromEnv({});
    expect(resolved.attempts).toBe(DEFAULT_RETRY_POLICY.attempts);
    expect(resolved.maxDelayMs).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
    expect(DEFAULT_RETRY_POLICY.attempts).toBe(3);
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(250);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(4_000);
  });

  it("honours environment overrides", () => {
    expect(
      retryPolicyFromEnv({
        [RETRY_ENV_VARS.attempts]: "5",
        [RETRY_ENV_VARS.baseDelayMs]: "50",
        [RETRY_ENV_VARS.maxDelayMs]: "500",
      }),
    ).toEqual({ attempts: 5, baseDelayMs: 50, maxDelayMs: 500 });
  });

  it("allows retrying to be turned off with attempts=1", () => {
    expect(retryPolicyFromEnv({ [RETRY_ENV_VARS.attempts]: "1" }).attempts).toBe(1);
    expect(describeRetryPolicy({ ...policy, attempts: 1 })).toBe("disabled");
  });

  it("falls back to defaults on garbage rather than failing startup", () => {
    expect(retryPolicyFromEnv({ [RETRY_ENV_VARS.attempts]: "abc" }).attempts).toBe(3);
    expect(retryPolicyFromEnv({ [RETRY_ENV_VARS.attempts]: "0" }).attempts).toBe(3);
  });

  it("uses a zero base delay under Vitest so suites do not really sleep", () => {
    expect(retryPolicyFromEnv({ VITEST: "true" }).baseDelayMs).toBe(0);
    expect(retryPolicyFromEnv({ VITEST: "true" }).attempts).toBe(3);
  });
});

describe("retryPolicyForTool", () => {
  it("applies an override only to the named tool", () => {
    const env = {
      [RETRY_ENV_VARS.attempts]: "3",
      MINDVAULT_RETRY_ATTEMPTS_MINDVAULT_BROWSE: "5",
      MINDVAULT_RETRY_BASE_DELAY_MS_MINDVAULT_BROWSE: "10",
    };
    expect(retryPolicyForTool("mindvault_browse", env)).toEqual({
      attempts: 5,
      baseDelayMs: 10,
      maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
    });
    expect(retryPolicyForTool("mindvault_search", env).attempts).toBe(3);
  });

  it("falls back to the global policy for invalid tool overrides", () => {
    expect(
      retryPolicyForTool("mindvault_browse", {
        [RETRY_ENV_VARS.attempts]: "4",
        MINDVAULT_RETRY_ATTEMPTS_MINDVAULT_BROWSE: "0",
      }),
    ).toMatchObject({ attempts: 4 });
  });
});

describe("computeBackoffDelay", () => {
  it("grows exponentially from the base delay", () => {
    const noJitter = () => 1;
    expect(computeBackoffDelay(1, policy, noJitter)).toBe(100);
    expect(computeBackoffDelay(2, policy, noJitter)).toBe(200);
    expect(computeBackoffDelay(3, policy, noJitter)).toBe(400);
  });

  it("caps the delay at maxDelayMs", () => {
    const noJitter = () => 1;
    expect(computeBackoffDelay(10, policy, noJitter)).toBe(policy.maxDelayMs);
  });

  it("applies full jitter across [0, capped]", () => {
    expect(computeBackoffDelay(2, policy, () => 0)).toBe(0);
    expect(computeBackoffDelay(2, policy, () => 0.5)).toBe(100);
    expect(computeBackoffDelay(2, policy, () => 0.999)).toBeLessThan(200);
  });

  it("stays at zero when the base delay is zero", () => {
    expect(computeBackoffDelay(3, { ...policy, baseDelayMs: 0 }, () => 1)).toBe(0);
  });
});

describe("retryAfterDelay", () => {
  it("honours a delay-seconds header", () => {
    expect(retryAfterDelay("2", { ...policy, maxDelayMs: 10_000 })).toBe(2_000);
  });

  it("honours an HTTP-date header", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterDelay("Thu, 01 Jan 2026 00:00:00 GMT", policy, now)).toBe(0);
  });

  it("clamps to maxDelayMs so a hostile header cannot stall the call", () => {
    expect(retryAfterDelay("99999", policy)).toBe(policy.maxDelayMs);
  });

  it("ignores a missing or unparseable header", () => {
    expect(retryAfterDelay(null, policy)).toBeNull();
    expect(retryAfterDelay(undefined, policy)).toBeNull();
    expect(retryAfterDelay("soon", policy)).toBeNull();
  });
});

describe("withRetry — thrown errors", () => {
  it("returns the first successful result without sleeping", async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withRetry(fn, { policy, label: "GET /x", sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("recovers when a transient failure is followed by success", async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce("ok");

    await expect(withRetry(fn, { policy, label: "GET /x", sleep, random: () => 1 })).resolves.toBe(
      "ok",
    );
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100]);
  });

  it("is bounded — it gives up after the configured attempts", async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

    await expect(
      withRetry(fn, { policy, label: "GET /x", sleep, random: () => 1 }),
    ).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]); // no sleep after the final attempt
  });

  it("rethrows a non-retryable error immediately", async () => {
    const { sleep, delays } = recordingSleep();
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const fn = vi.fn().mockRejectedValue(abort);

    await expect(withRetry(fn, { policy, label: "GET /x", sleep })).rejects.toThrow(abort);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("does not retry at all when attempts is 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(
      withRetry(fn, { policy: { ...policy, attempts: 1 }, label: "GET /x" }),
    ).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withRetry — retryable results", () => {
  const retryOn503 = {
    shouldRetryResult: (r: { status: number }) => isRetryableStatus(r.status),
    describeResult: (r: { status: number }) => `HTTP ${r.status}`,
  };

  it("retries a retryable status and returns the eventual success", async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });

    const result = await withRetry(fn, {
      policy,
      label: "GET /resources",
      sleep,
      random: () => 1,
      ...retryOn503,
    });

    expect(result).toEqual({ status: 200 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100]);
  });

  it("returns the last response rather than throwing when retries run out", async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn().mockResolvedValue({ status: 503 });

    const result = await withRetry(fn, {
      policy,
      label: "GET /resources",
      sleep,
      ...retryOn503,
    });

    expect(result).toEqual({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("prefers a Retry-After delay over computed backoff", async () => {
    const { sleep, delays } = recordingSleep();
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 200 });

    await withRetry(fn, {
      policy,
      label: "GET /resources",
      sleep,
      random: () => 1,
      ...retryOn503,
      delayFromResult: () => 750,
    });

    expect(delays).toEqual([750]);
  });

  it("does not retry a non-retryable status", async () => {
    const fn = vi.fn().mockResolvedValue({ status: 402 });
    const result = await withRetry(fn, { policy, label: "buy", ...retryOn503 });
    expect(result).toEqual({ status: 402 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("observability", () => {
  it("reports every retry with attempt, delay, and reason", async () => {
    const { sleep } = recordingSleep();
    const seen: RetryAttemptInfo[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

    await withRetry(fn, {
      policy,
      label: "GET /resources",
      sleep,
      random: () => 1,
      onRetry: (info) => seen.push(info),
    }).catch(() => undefined);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      label: "GET /resources",
      attempt: 1,
      attempts: 3,
      delayMs: 100,
      reason: "fetch failed",
    });
    expect(seen[1].attempt).toBe(2);
  });

  it("formats a single-line, greppable log entry", () => {
    expect(
      formatRetryLog({
        label: "GET /resources",
        attempt: 2,
        attempts: 3,
        delayMs: 312,
        reason: "HTTP 503",
      }),
    ).toBe("retrying GET /resources — attempt 2/3 failed (HTTP 503); next attempt in 312ms");
  });

  it("describes the policy for operator output", () => {
    expect(describeRetryPolicy(policy)).toBe(
      "attempts=3, baseDelay=100ms, maxDelay=1000ms, jitter=full",
    );
  });
});
