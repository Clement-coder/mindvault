/**
 * Tests for progress notifications on long-running tools (#554).
 *
 * Verifies that `createProgressEmitter` correctly emits or suppresses
 * notifications based on whether a progress token is supplied.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class MockServer {
    setRequestHandler = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    constructor() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolRequestSchema: {},
  ListToolsRequestSchema: {},
  ListPromptsRequestSchema: {},
  GetPromptRequestSchema: {},
  ListResourcesRequestSchema: {},
  ReadResourceRequestSchema: {},
}));

vi.mock("@x402/stellar", () => ({ createEd25519Signer: vi.fn() }));
vi.mock("@x402/stellar/exact/client", () => ({ ExactStellarScheme: vi.fn() }));
vi.mock("@x402/fetch", () => ({
  wrapFetchWithPayment: vi.fn(),
  x402Client: vi.fn(function () {
    return { register: vi.fn() };
  }),
}));

vi.mock("@mindvault/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    networks: {
      ...actual.networks,
      testnet: {
        ...actual.networks.testnet,
        contractId: "test",
        networkPassphrase: "test",
      },
    },
  };
});

import { createProgressEmitter, scopeProgressToRequest, type ProgressContext } from "./progress.js";

// ── createProgressEmitter unit tests ────────────────────────────────────────

describe("createProgressEmitter", () => {
  it("returns a no-op function when no token is supplied", async () => {
    const emit = createProgressEmitter({ token: undefined, send: vi.fn() as any });
    await emit(1, 4, "step");
  });

  it("calls sendNotification with the correct progress payload", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const emit = createProgressEmitter({ token: "abc-123", send });

    await emit(2, 4, "Processing");

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: "abc-123",
        progress: 2,
        total: 4,
        message: "Processing",
      },
    });
  });

  it("omits total and message when not provided", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const emit = createProgressEmitter({ token: 42, send });

    await emit(1);

    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: 42,
        progress: 1,
      },
    });
  });

  it("supports numeric progress tokens", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const emit = createProgressEmitter({ token: 999, send });

    await emit(3, 5, "step");

    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: 999,
        progress: 3,
        total: 5,
        message: "step",
      },
    });
  });

  it("supports string progress tokens", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const emit = createProgressEmitter({ token: "tok-xyz", send });

    await emit(1, 2, "init");

    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: "tok-xyz",
        progress: 1,
        total: 2,
        message: "init",
      },
    });
  });

  it("calls send for every invocation", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const emit = createProgressEmitter({ token: "multi", send });

    await emit(1, 4, "a");
    await emit(2, 4, "b");
    await emit(3, 4, "c");
    await emit(4, 4, "d");

    expect(send).toHaveBeenCalledTimes(4);
  });
});

// ── scopeProgressToRequest (#841) ───────────────────────────────────────────

/** A send that stays pending until the test resolves or rejects it. */
function deferredSend() {
  const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  const send = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { send, pending };
}

describe("scopeProgressToRequest", () => {
  it("forwards every update while the call is running", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const progress = scopeProgressToRequest(createProgressEmitter({ token: "t", send }));

    await progress.emit(1, 2, "a");
    await progress.emit(2, 2, "b");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ params: { progress: 2, message: "b" } });
  });

  it("settle waits for a send that is still in flight", async () => {
    const { send, pending } = deferredSend();
    const progress = scopeProgressToRequest(send);
    void progress.emit(1, 1, "slow");

    let settled = false;
    const settling = progress.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    pending[0].resolve();
    await settling;
    expect(settled).toBe(true);
  });

  it("drops updates emitted after settle instead of sending them", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const progress = scopeProgressToRequest(send);

    await progress.emit(1, 2, "before");
    await progress.settle();
    await progress.emit(2, 2, "after");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(1, 2, "before");
  });

  it("still rejects the awaited emit on a failed send, but settle does not throw", async () => {
    const { send, pending } = deferredSend();
    const progress = scopeProgressToRequest(send);

    const emitted = progress.emit(1, 1, "x");
    pending[0].reject(new Error("transport closed"));

    await expect(emitted).rejects.toThrow("transport closed");
    await expect(progress.settle()).resolves.toBeUndefined();
  });

  it("does not leave an unhandled rejection for an update nobody awaited", async () => {
    const progress = scopeProgressToRequest(() => {
      throw new Error("sync failure");
    });

    void progress.emit(1, 1, "x");

    await expect(progress.settle()).resolves.toBeUndefined();
  });
});
