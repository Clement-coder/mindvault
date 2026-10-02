import { describe, expect, it, vi } from "vitest";
import { pollResourceSubscription } from "./resourceSubscription.js";

describe("pollResourceSubscription", () => {
  it("returns the settled subscription after polling", async () => {
    let clock = 0;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ active: false })
      .mockResolvedValueOnce({ active: true });
    const result = await pollResourceSubscription({
      fetch,
      isSettled: (subscription) => subscription.active,
      intervalMs: 100,
      timeoutMs: 1_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result).toEqual({
      snapshot: { active: true },
      attempts: 2,
      settled: true,
      timedOut: false,
    });
  });

  it("returns the latest snapshot when the subscription does not settle in time", async () => {
    let clock = 0;
    const result = await pollResourceSubscription({
      fetch: async () => ({ active: false }),
      isSettled: (subscription) => subscription.active,
      intervalMs: 100,
      timeoutMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result).toEqual({
      snapshot: { active: false },
      attempts: 2,
      settled: false,
      timedOut: true,
    });
  });

  it("rejects invalid timing inputs", async () => {
    await expect(
      pollResourceSubscription({
        fetch: async () => ({ active: false }),
        isSettled: () => false,
        intervalMs: -1,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("non-negative");
  });
});
