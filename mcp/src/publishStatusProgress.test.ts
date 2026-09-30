/**
 * Tool-level test for streaming publish-verification progress (#571).
 *
 * Drives mindvault_publish_status's implementation against a stubbed backend
 * and asserts a progress notification is emitted for every poll, ending with a
 * terminal message once verification settles.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const jsonFetch = vi.fn();

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, jsonFetch };
});

const { publishStatus } = await import("./tools/wallet.js");

/** Backend responses for one poll: meta first, then verification. */
function pollResponses(status: string) {
  return [
    {
      ok: true,
      status: 200,
      data: { id: "res-1", title: "Dataset", verificationStatus: status, onchainStatus: "none" },
      headers: {},
    },
    {
      ok: true,
      status: 200,
      data: { resourceId: "res-1", status, listed: status === "verified" },
      headers: {},
    },
  ];
}

function queueStatuses(statuses: string[]) {
  for (const status of statuses) {
    for (const res of pollResponses(status)) jsonFetch.mockResolvedValueOnce(res);
  }
  // Any extra poll repeats the last status.
  const last = statuses[statuses.length - 1];
  jsonFetch.mockImplementation(async (url: string) =>
    url.endsWith("/meta") ? pollResponses(last)[0] : pollResponses(last)[1],
  );
}

describe("mindvault_publish_status progress notifications", () => {
  beforeEach(() => {
    jsonFetch.mockReset();
  });

  it("streams one update per poll and a terminal update when verification settles", async () => {
    queueStatuses(["pending", "pending", "verified"]);
    const updates: Array<[number, number | undefined, string | undefined]> = [];

    const out = await publishStatus(
      { resourceId: "res-1", wait: true, timeoutMs: 5_000, intervalMs: 200 },
      async (progress, total, message) => {
        updates.push([progress, total, message]);
      },
    );

    const snapshot = JSON.parse(out);
    expect(snapshot.verificationStatus).toBe("verified");
    expect(snapshot.attempts).toBe(3);
    expect(snapshot.timedOut).toBe(false);

    expect(updates.map(([progress]) => progress)).toEqual([1, 2, 3]);
    expect(updates[0][2]).toBe("Verification pending — poll 1, still waiting.");
    expect(updates[2][2]).toBe("Verification verified after 3 polls.");
  });

  it("emits a single update for a non-waiting check", async () => {
    queueStatuses(["pending"]);
    const updates: string[] = [];

    const out = await publishStatus({ resourceId: "res-1" }, async (_p, _t, message) => {
      updates.push(message ?? "");
    });

    expect(JSON.parse(out).attempts).toBe(1);
    expect(updates).toEqual(["Verification pending — single check, pass wait: true to poll."]);
  });

  it("polls unchanged when the client supplies no progress reporter", async () => {
    queueStatuses(["verified"]);

    const snapshot = JSON.parse(await publishStatus({ resourceId: "res-1", wait: true }));

    expect(snapshot.verificationStatus).toBe("verified");
    expect(snapshot.attempts).toBe(1);
  });
});
