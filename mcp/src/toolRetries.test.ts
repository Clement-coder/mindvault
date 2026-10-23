/**
 * Wiring tests for retry behaviour on real MCP tools (#409).
 *
 * retry.test.ts covers the primitive. These assert the policy that actually
 * matters at the call sites: idempotent reads recover from transient failures,
 * and non-idempotent work — above all x402 payments — is issued exactly once.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

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
  SubscribeRequestSchema: {},
  UnsubscribeRequestSchema: {},
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
      testnet: { ...actual.networks.testnet, contractId: "test", networkPassphrase: "test" },
    },
  };
});

// Retry counts are read once at module load. VITEST already forces a zero base
// delay, so these run without real sleeping.
process.env.MINDVAULT_RETRY_ATTEMPTS = "3";

const { browse, buy, walletInfo, txStatus, networkProfile, _setAgentWallet } =
  await import("./index.js");

function mockResponse(data: unknown, ok = true, status = 200, headers?: Record<string, string>) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(data),
    // jsonFetch reads bodies through readBoundedResponse, which needs bytes.
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
    headers: new Headers({ "content-type": "application/json", ...headers }),
  } as Response;
}

const testWallet = {
  publicKey: "GTESTPUBLICKEY000000000000000000000000000000000000000000",
  secretKey: "STESTSECRETKEY000000000000000000000000000000000000000000",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("idempotent reads retry", () => {
  it("browse recovers from a transient network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(mockResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(browse()).resolves.toBe("No resources listed yet.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("browse recovers from a transient 503", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ error: "unavailable" }, false, 503))
      .mockResolvedValueOnce(mockResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(browse()).resolves.toBe("No resources listed yet.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded attempt count and reports the failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(browse()).rejects.toThrow(/Category: network/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a client error that retrying cannot fix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ error: "bad request" }, false, 400));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(browse()).rejects.toThrow(/Category: validation/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries Horizon balance reads", async () => {
    _setAgentWallet(testWallet);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(
        mockResponse({
          subentry_count: 1,
          balances: [
            { asset_type: "native", balance: "5.0" },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              balance: "10.0",
            },
          ],
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(walletInfo()).resolves.toContain("USDC Balance: 10.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries Soroban getTransaction, which is a read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({}, false, 502))
      .mockResolvedValueOnce(mockResponse({ result: { status: "SUCCESS", ledger: 1 } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const parsed = JSON.parse(await txStatus("abc123"));
    expect(parsed.status).toBe("SUCCESS");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Deterministic failures stop at the first attempt; transient ones use the
// whole bounded budget (#1072). One row per status, through a real tool.
const STATUS_TABLE: { status: number; category: RegExp; attempts: number }[] = [
  { status: 400, category: /Category: validation/, attempts: 1 },
  { status: 401, category: /Category: auth/, attempts: 1 },
  { status: 403, category: /Category: auth/, attempts: 1 },
  { status: 404, category: /Category: not_found/, attempts: 1 },
  { status: 422, category: /Category: validation/, attempts: 1 },
  { status: 429, category: /Category: rate_limit/, attempts: 3 },
  { status: 500, category: /Category: server/, attempts: 3 },
  { status: 503, category: /Category: server/, attempts: 3 },
];

describe("deterministic failures are not retried as transient (#1072)", () => {
  it.each(STATUS_TABLE)(
    "browse on HTTP $status makes $attempts attempt(s)",
    async ({ status, category, attempts }) => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ error: "nope" }, false, status));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(browse()).rejects.toThrow(category);
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
    },
  );

  it.each([401, 403])("Soroban getTransaction on HTTP %i is issued once", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({}, false, status));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(txStatus("abc123")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a thrown contract validation error is not replayed", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("HostError: Error(Contract, #32) NetworkIdMismatch"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(txStatus("abc123")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("non-idempotent calls are issued exactly once", () => {
  it("never replays an x402 payment, even on a transient failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [
              { asset_type: "native", balance: "10.0" },
              {
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                balance: "999.00",
              },
            ],
          }),
        );
      }
      return Promise.resolve(mockResponse({ id: "res-001", title: "Doc", price: "5.00" }));
    });

    // A paid fetch that fails with a status retry would normally replay (503).
    const paid = vi.fn().mockResolvedValue(mockResponse({ error: "unavailable" }, false, 503));
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => paid as any);

    _setAgentWallet(testWallet);
    await expect(buy("res-001")).rejects.toThrow(/Buy failed \[503\]/);

    // Exactly one payment attempt — a second could sign and settle twice.
    expect(paid).toHaveBeenCalledTimes(1);
  });

  it("does not replay a payment that fails at the transport level", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [
              { asset_type: "native", balance: "10.0" },
              {
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                balance: "999.00",
              },
            ],
          }),
        );
      }
      return Promise.resolve(mockResponse({ id: "res-001", title: "Doc", price: "5.00" }));
    });

    const paid = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => paid as any);

    _setAgentWallet(testWallet);
    await expect(buy("res-001")).rejects.toThrow(/Buy failed/);
    expect(paid).toHaveBeenCalledTimes(1);
  });
});

describe("network profile reports the retry policy", () => {
  it("surfaces the active policy for operators", () => {
    const parsed = JSON.parse(networkProfile());
    expect(parsed.retries).toContain("attempts=3");
    expect(parsed.retries).toContain("jitter=full");
  });
});
