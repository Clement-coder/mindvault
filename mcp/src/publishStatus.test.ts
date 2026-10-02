import { describe, it, expect, vi } from "vitest";
import {
  buildPublishStatusSnapshot,
  estimatePollSteps,
  isVerificationSettled,
  normalizeIntervalMs,
  normalizeTimeoutMs,
  normalizeWaitFlag,
  currentVerificationStatus,
  pollPublishStatus,
  publishProgressMessage,
  publishStatusFromResponses,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  MAX_POLL_TIMEOUT_MS,
  type PublishStatusFetch,
  type PublishStatusResponse,
} from "./publishStatus.js";

describe("publishStatus helpers", () => {
  it("treats verified, rejected, and skipped as settled", () => {
    expect(isVerificationSettled("pending")).toBe(false);
    expect(isVerificationSettled("verified")).toBe(true);
    expect(isVerificationSettled("rejected")).toBe(true);
    expect(isVerificationSettled("skipped")).toBe(true);
    expect(isVerificationSettled(undefined)).toBe(false);
  });

  it("normalizes wait flag deterministically", () => {
    expect(normalizeWaitFlag(undefined)).toBe(false);
    expect(normalizeWaitFlag(true)).toBe(true);
    expect(normalizeWaitFlag("yes")).toBe(true);
    expect(normalizeWaitFlag("0")).toBe(false);
    expect(() => normalizeWaitFlag("maybe")).toThrow(/wait must be a boolean/);
  });

  it("normalizes timeout and interval with defaults and caps", () => {
    expect(normalizeTimeoutMs(undefined)).toBe(DEFAULT_POLL_TIMEOUT_MS);
    expect(normalizeTimeoutMs(999_999)).toBe(MAX_POLL_TIMEOUT_MS);
    expect(normalizeIntervalMs(undefined)).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(() => normalizeTimeoutMs(-1)).toThrow(/timeoutMs/);
    expect(() => normalizeIntervalMs(50)).toThrow(/intervalMs/);
  });

  it("builds snapshots for pending, verified, rejected, skipped, and on-chain fields", () => {
    const pending = buildPublishStatusSnapshot(
      "res-1",
      {
        meta: {
          title: "T",
          verificationStatus: "pending",
          onchainStatus: "none",
          onchainTxHash: null,
          accessUrl: "https://example.com/r",
        },
        verification: { status: "pending", listed: false, title: "T" },
      },
      { polled: false, attempts: 1, timedOut: false },
    );
    expect(pending.verificationStatus).toBe("pending");
    expect(pending.onchainStatus).toBe("none");
    expect(pending.settled).toBe(false);
    expect(pending.message).toMatch(/pending/i);

    const verified = buildPublishStatusSnapshot(
      "res-1",
      {
        meta: {
          verificationStatus: "verified",
          onchainStatus: "registered",
          onchainTxHash: "abc",
          contentHash: "hash",
        },
        verification: {
          status: "verified",
          listed: true,
          verification: {
            isOriginal: true,
            confidence: 0.9,
            flags: [],
            checkedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      { polled: true, attempts: 3, timedOut: false },
    );
    expect(verified.verificationStatus).toBe("verified");
    expect(verified.listed).toBe(true);
    expect(verified.onchainStatus).toBe("registered");
    expect(verified.onchainTxHash).toBe("abc");
    expect(verified.settled).toBe(true);
    expect(verified.message).toMatch(/registered on-chain/i);

    const rejected = buildPublishStatusSnapshot(
      "res-1",
      {
        meta: { verificationStatus: "rejected", onchainStatus: "none" },
        verification: { status: "rejected", listed: false },
      },
      { polled: false, attempts: 1, timedOut: false },
    );
    expect(rejected.verificationStatus).toBe("rejected");
    expect(rejected.message).toMatch(/rejected/i);

    const skipped = buildPublishStatusSnapshot(
      "res-1",
      {
        meta: { verificationStatus: "skipped", onchainStatus: "none" },
        verification: { status: "skipped", listed: false },
      },
      { polled: false, attempts: 1, timedOut: false },
    );
    expect(skipped.verificationStatus).toBe("skipped");
    expect(skipped.message).toMatch(/skipped/i);

    const timedOut = buildPublishStatusSnapshot(
      "res-1",
      {
        meta: { verificationStatus: "pending", onchainStatus: "pending" },
        verification: { status: "pending", listed: false },
      },
      { polled: true, attempts: 5, timedOut: true },
    );
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.message).toMatch(/Timed out/);
  });
});

// ── Streaming progress while polling verification (#571) ────────────────────

function snapshotFor(status: string): PublishStatusFetch {
  return {
    meta: { verificationStatus: status, onchainStatus: "none" },
    verification: { status, listed: status === "verified" },
  };
}

type ProgressUpdate = { progress: number; total?: number; message?: string };

/**
 * Drive pollPublishStatus over a scripted sequence of statuses with a virtual
 * clock, so the wait window elapses without any real delay.
 */
async function runPoll(
  statuses: string[],
  opts: { wait: boolean; timeoutMs: number; intervalMs: number; withToken?: boolean },
) {
  let clock = 0;
  let index = 0;
  const updates: ProgressUpdate[] = [];
  const fetchStatus = vi.fn(async () =>
    snapshotFor(statuses[Math.min(index++, statuses.length - 1)]),
  );

  const result = await pollPublishStatus({
    resourceId: "res-1",
    wait: opts.wait,
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs,
    fetchStatus,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    onProgress:
      opts.withToken === false
        ? undefined
        : async (progress, total, message) => {
            updates.push({ progress, total, message });
          },
  });

  return { result, updates, fetchStatus };
}

describe("pollPublishStatus progress streaming", () => {
  it("emits a single terminal update for a non-waiting check", async () => {
    const { result, updates, fetchStatus } = await runPoll(["pending"], {
      wait: false,
      timeoutMs: DEFAULT_POLL_TIMEOUT_MS,
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
    });

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(updates).toEqual([
      {
        progress: 1,
        total: 1,
        message: "Verification pending — single check, pass wait: true to poll.",
      },
    ]);
  });

  it("emits one update per poll until verification settles", async () => {
    const { result, updates, fetchStatus } = await runPoll(["pending", "pending", "verified"], {
      wait: true,
      timeoutMs: 60_000,
      intervalMs: 2_000,
    });

    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(updates.map((u) => u.progress)).toEqual([1, 2, 3]);
    expect(updates.every((u) => u.total === 31)).toBe(true);
    expect(updates[0].message).toBe("Verification pending — poll 1, still waiting.");
    expect(updates[2].message).toBe("Verification verified after 3 polls.");
  });

  it("streams a final timed-out update when the wait window elapses", async () => {
    const { result, updates } = await runPoll(["pending"], {
      wait: true,
      timeoutMs: 1_000,
      intervalMs: 500,
    });

    expect(result.attempts).toBe(3);
    expect(result.timedOut).toBe(true);
    expect(updates.map((u) => u.progress)).toEqual([1, 2, 3]);
    expect(updates[2]).toEqual({
      progress: 3,
      total: 3,
      message: "Timed out after 3 polls — verification still pending.",
    });
  });

  it("keeps progress strictly increasing and grows total past the estimate", async () => {
    const { result, updates } = await runPoll(["pending"], {
      wait: true,
      timeoutMs: 0,
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
    });

    // The estimate is a single poll, but the timeout update needs a second step.
    expect(result.timedOut).toBe(true);
    expect(updates).toEqual([
      { progress: 1, total: 1, message: "Verification pending — poll 1, still waiting." },
      { progress: 2, total: 2, message: "Timed out after 1 poll — verification still pending." },
    ]);
  });

  it("reports terminal statuses reached on the first poll", async () => {
    const { result, updates, fetchStatus } = await runPoll(["rejected"], {
      wait: true,
      timeoutMs: 60_000,
      intervalMs: 2_000,
    });

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(updates).toEqual([
      { progress: 1, total: 31, message: "Verification rejected after 1 poll." },
    ]);
  });

  it("polls normally when the client supplies no progress token", async () => {
    const { result, updates, fetchStatus } = await runPoll(["pending", "verified"], {
      wait: true,
      timeoutMs: 10_000,
      intervalMs: 1_000,
      withToken: false,
    });

    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(updates).toEqual([]);
  });

  it("surfaces fetch failures instead of swallowing them mid-poll", async () => {
    await expect(
      pollPublishStatus({
        resourceId: "missing",
        wait: true,
        timeoutMs: 10_000,
        intervalMs: 1_000,
        fetchStatus: async () => {
          throw new Error('Resource "missing" not found.');
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("progress helpers", () => {
  it("estimates the poll count from the wait window", () => {
    expect(estimatePollSteps(false, 60_000, 2_000)).toBe(1);
    expect(estimatePollSteps(true, 60_000, 2_000)).toBe(31);
    expect(estimatePollSteps(true, 1_000, 500)).toBe(3);
    // Sub-minimum intervals are clamped so the estimate stays finite.
    expect(estimatePollSteps(true, 1_000, 0)).toBe(6);
  });

  it("describes each poll outcome", () => {
    const base = { attempt: 2, status: "pending", settled: false, timedOut: false, wait: true };
    expect(publishProgressMessage(base)).toBe("Verification pending — poll 2, still waiting.");
    expect(publishProgressMessage({ ...base, timedOut: true })).toBe(
      "Timed out after 2 polls — verification still pending.",
    );
    expect(publishProgressMessage({ ...base, status: "verified", settled: true, attempt: 1 })).toBe(
      "Verification verified after 1 poll.",
    );
    expect(publishProgressMessage({ ...base, wait: false, attempt: 1 })).toBe(
      "Verification pending — single check, pass wait: true to poll.",
    );
  });
});

// ── Combining /meta and /verification when one of them fails (#840) ─────────

function ok(data: unknown): PublishStatusResponse {
  return { ok: true, status: 200, data };
}

function failed(status: number): PublishStatusResponse {
  return { ok: false, status, data: { error: "unavailable" } };
}

const metaWith = (status: string) => ok({ id: "res-1", verificationStatus: status });
const verificationWith = (status: string) => ok({ resourceId: "res-1", status });

describe("publishStatusFromResponses", () => {
  it("keeps both bodies when both requests succeed", () => {
    const data = publishStatusFromResponses(
      "res-1",
      metaWith("pending"),
      verificationWith("verified"),
    );
    expect(data.meta).toEqual({ id: "res-1", verificationStatus: "pending" });
    expect(data.verification).toEqual({ resourceId: "res-1", status: "verified" });
    expect(currentVerificationStatus(data)).toBe("verified");
  });

  it("returns a terminal status from /meta when /verification fails", () => {
    for (const status of ["verified", "rejected", "skipped"]) {
      const data = publishStatusFromResponses("res-1", metaWith(status), failed(503));
      expect(data.verification).toBeNull();
      expect(currentVerificationStatus(data)).toBe(status);
    }
  });

  it("returns a terminal status from /verification when /meta fails", () => {
    const data = publishStatusFromResponses("res-1", failed(502), verificationWith("rejected"));
    expect(data.meta).toBeNull();
    expect(currentVerificationStatus(data)).toBe("rejected");
  });

  it("fails the poll when the answering endpoint is not terminal", () => {
    expect(() => publishStatusFromResponses("res-1", metaWith("pending"), failed(503))).toThrow(
      /Publish status verification failed \[503\]/,
    );
    expect(() =>
      publishStatusFromResponses("res-1", failed(500), verificationWith("pending")),
    ).toThrow(/Publish status meta failed \[500\]/);
  });

  it("reports a missing resource and ignores a single 404", () => {
    expect(() => publishStatusFromResponses("res-1", failed(404), failed(404))).toThrow(
      /Resource "res-1" not found/,
    );
    expect(() => publishStatusFromResponses("res-1", failed(404), failed(503))).toThrow(
      /verification failed \[503\]/,
    );
    const data = publishStatusFromResponses("res-1", failed(404), verificationWith("pending"));
    expect(currentVerificationStatus(data)).toBe("pending");
  });
});

describe("pollPublishStatus stops at a terminal status under retry (#840)", () => {
  it("does not poll again once a rejection arrives beside a failed request", async () => {
    const polls: Array<[PublishStatusResponse, PublishStatusResponse]> = [
      [metaWith("pending"), verificationWith("pending")],
      [metaWith("rejected"), failed(503)],
    ];
    let clock = 0;
    const fetchStatus = vi.fn(async (resourceId: string) => {
      const next = polls.shift();
      if (!next) throw new Error("polled past the terminal state");
      return publishStatusFromResponses(resourceId, ...next);
    });
    const messages: string[] = [];

    const result = await pollPublishStatus({
      resourceId: "res-1",
      wait: true,
      timeoutMs: 60_000,
      intervalMs: 2_000,
      fetchStatus,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      onProgress: async (_progress, _total, message) => {
        messages.push(message ?? "");
      },
    });

    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(currentVerificationStatus(result.data)).toBe("rejected");
    expect(messages).toEqual([
      "Verification pending — poll 1, still waiting.",
      "Verification rejected after 2 polls.",
    ]);
  });
});
