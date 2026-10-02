/**
 * Regression test for mindvault_publish_status under HTTP retry (#840).
 *
 * Drives the tool against a stubbed `fetch`, so every poll goes through the
 * real `jsonFetch` and its bounded retry. The scenario from the issue: a
 * `wait: true` call whose second poll finds the resource `rejected` on
 * `/meta` while `/verification` keeps answering 503. The poll must stop at
 * the terminal state it was given — not poll again, not report the resource
 * as still verifying, and not turn a known rejection into an error.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

process.env.MINDVAULT_RETRY_ATTEMPTS = "3";

const { publishStatus } = await import("./tools/wallet.js");

type Reply = { status: number; body: unknown };

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}

function meta(status: string): Reply {
  return {
    status: 200,
    body: { id: "res-1", title: "Dataset", verificationStatus: status, onchainStatus: "none" },
  };
}

function verification(status: string): Reply {
  return {
    status: 200,
    body: { resourceId: "res-1", status, listed: status === "verified", verification: null },
  };
}

const UNAVAILABLE: Reply = { status: 503, body: { error: "unavailable" } };

/**
 * Serve scripted replies per endpoint, in order. A request past the end of its
 * script fails the test: it means the tool polled after it should have stopped.
 */
function stubBackend(script: { meta: Reply[]; verification: Reply[] }) {
  const queues = { meta: [...script.meta], verification: [...script.verification] };
  const calls: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const endpoint = url.endsWith("/meta") ? "meta" : "verification";
    calls.push(endpoint);
    const next = queues[endpoint].shift();
    if (!next) throw new Error(`unexpected extra ${endpoint} request: ${url}`);
    return reply(next.status, next.body);
  });
  return { fetchMock, calls };
}

async function waitForStatus() {
  const updates: string[] = [];
  const out = await publishStatus(
    { resourceId: "res-1", wait: true, timeoutMs: 5_000, intervalMs: 200 },
    async (_progress, _total, message) => {
      updates.push(message ?? "");
    },
  );
  return { snapshot: JSON.parse(out), updates };
}

describe("mindvault_publish_status wait: true under retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops at a rejection reported while the companion request keeps failing", async () => {
    const { calls } = stubBackend({
      meta: [meta("pending"), meta("rejected")],
      verification: [verification("pending"), UNAVAILABLE, UNAVAILABLE, UNAVAILABLE],
    });

    const { snapshot, updates } = await waitForStatus();

    expect(snapshot.verificationStatus).toBe("rejected");
    expect(snapshot.settled).toBe(true);
    expect(snapshot.timedOut).toBe(false);
    expect(snapshot.attempts).toBe(2);
    // Two polls: the second retried /verification to the attempt cap, and
    // nothing was requested after the terminal state.
    expect(calls).toEqual([
      "meta",
      "verification",
      "meta",
      "verification",
      "verification",
      "verification",
    ]);
    expect(updates).toEqual([
      "Verification pending — poll 1, still waiting.",
      "Verification rejected after 2 polls.",
    ]);
  });

  it("stops at a rejection that a retried request recovers", async () => {
    const { calls } = stubBackend({
      meta: [meta("pending"), meta("rejected")],
      verification: [verification("pending"), UNAVAILABLE, verification("rejected")],
    });

    const { snapshot, updates } = await waitForStatus();

    expect(snapshot.verificationStatus).toBe("rejected");
    expect(snapshot.attempts).toBe(2);
    expect(calls).toHaveLength(5);
    expect(updates.at(-1)).toBe("Verification rejected after 2 polls.");
    expect(updates.filter((u) => u.includes("still waiting"))).toHaveLength(1);
  });

  it("still fails the call when the failing request leaves the status unknown", async () => {
    stubBackend({
      meta: [meta("pending"), meta("pending")],
      verification: [verification("pending"), UNAVAILABLE, UNAVAILABLE, UNAVAILABLE],
    });

    await expect(waitForStatus()).rejects.toThrow(/Publish status verification failed \[503\]/);
  });
});
