import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchWithTimeout,
  withTimeout,
  RequestTimeoutError,
  isTimeoutDisabled,
  resolveTimeouts,
  TIMEOUT_ENV_VARS,
  DEFAULT_TIMEOUTS,
} from "./httpTimeout.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function okResponse(): Response {
  return { ok: true, status: 200, headers: new Headers() } as Response;
}

function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
}

describe("HTTP transport smoke", () => {
  it("fetchWithTimeout returns response when fast enough", async () => {
    const spy = vi.fn().mockResolvedValue(okResponse());
    const res = await fetchWithTimeout(
      spy as unknown as typeof fetch,
      "https://example.test",
      {},
      "http",
      5000,
    );
    expect(res.ok).toBe(true);
  });

  it("fetchWithTimeout aborts on timeout", async () => {
    vi.useFakeTimers();
    const promise = fetchWithTimeout(hangingFetch(), "https://example.test", {}, "http", 100);
    const assertion = expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("fetchWithTimeout preserves caller init options", async () => {
    const spy = vi.fn().mockResolvedValue(okResponse());
    await fetchWithTimeout(
      spy as unknown as typeof fetch,
      "https://example.test",
      { method: "POST", body: "{}", headers: { "x-test": "1" } },
      "http",
      5000,
    );
    const init = spy.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("fetchWithTimeout skips controller when budget is disabled", async () => {
    const spy = vi.fn().mockResolvedValue(okResponse());
    await fetchWithTimeout(spy as unknown as typeof fetch, "https://example.test", {}, "http", 0);
    expect(spy.mock.calls[0][1]?.signal).toBeUndefined();
  });

  it("withTimeout wraps fetch with a budget", async () => {
    vi.useFakeTimers();
    const wrapped = withTimeout(hangingFetch(), "payment", 200);
    const promise = wrapped("https://example.test");
    const assertion = expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it("isTimeoutDisabled returns true for 0 or negative", () => {
    expect(isTimeoutDisabled(0)).toBe(true);
    expect(isTimeoutDisabled(-1)).toBe(true);
    expect(isTimeoutDisabled(5000)).toBe(false);
  });

  it("resolveTimeouts uses defaults when env is empty", () => {
    const budgets = resolveTimeouts({});
    expect(budgets).toEqual(DEFAULT_TIMEOUTS);
  });

  it("resolveTimeouts honours env overrides", () => {
    const budgets = resolveTimeouts({
      [TIMEOUT_ENV_VARS.http]: "1000",
      [TIMEOUT_ENV_VARS.horizon]: "2000",
    });
    expect(budgets.http).toBe(1000);
    expect(budgets.horizon).toBe(2000);
    expect(budgets.soroban).toBe(DEFAULT_TIMEOUTS.soroban);
  });

  it("RequestTimeoutError carries service and timeoutMs", () => {
    const err = new RequestTimeoutError("horizon", 5000);
    expect(err.name).toBe("TimeoutError");
    expect(err.service).toBe("horizon");
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toContain("5000ms");
    expect(err.message).toContain("horizon");
  });

  it("fetchWithTimeout does not mask non-timeout failures", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      fetchWithTimeout(failing as unknown as typeof fetch, "https://x.test", {}, "http", 5000),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
