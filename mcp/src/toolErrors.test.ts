/**
 * Wiring tests for structured MCP error mapping (#407).
 *
 * errorMapping.test.ts covers the pure mapper; these assert that the real tool
 * functions actually emit the mapped shape — summary, machine-readable
 * classification line, and a next step — for each failure class named in the
 * issue: network failure, 402 payment, contract NotFound, and validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({ registryGet: null as any }));

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
      testnet: { ...actual.networks.testnet, contractId: "test", networkPassphrase: "test" },
    },
    createRegistryClient: () => ({ get: async () => hoisted.registryGet }),
  };
});

import { Errors as RegistryErrors } from "@mindvault/registry-client";
import {
  browse,
  buy,
  preview,
  registryLookup,
  txStatus,
  walletInfo,
  _setAgentWallet,
} from "./index.js";

function mockResponse(data: unknown, ok = true, status = 200): Response {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(data),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}

const testWallet = {
  publicKey: "GTESTPUBLICKEY000000000000000000000000000000000000000000",
  secretKey: "STESTSECRETKEY000000000000000000000000000000000000000000",
};

/** Every mapped error carries the three-line contract. */
function expectMappedShape(message: string): void {
  expect(message).toMatch(/Source: .+ · Category: [a-z_]+/);
  expect(message).toMatch(/Next: \S/);
}

afterEach(() => {
  vi.restoreAllMocks();
  hoisted.registryGet = null;
});

describe("network failure", () => {
  it("browse reports an unreachable API as a network error with the cause intact", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed"));

    await expect(browse()).rejects.toThrow(/Category: network/);
    await expect(browse()).rejects.toThrow(/fetch failed/);

    const message = await browse().catch((e) => e.message);
    expectMappedShape(message);
    expect(message).toContain("Source: MindVault API");
    expect(message).toContain("MindVault API request failed");
  });

  it("attributes a Horizon outage to Horizon, not the API", async () => {
    _setAgentWallet(testWallet);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND horizon"));

    const message = await walletInfo().catch((e) => e.message);
    expect(message).toContain("Source: Horizon");
    expect(message).toContain("Category: network");
  });

  it("classifies an aborted request as a timeout rather than a network error", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    globalThis.fetch = vi.fn().mockRejectedValue(abort);

    const message = await browse().catch((e) => e.message);
    expect(message).toContain("Category: timeout");
    expect(message).toContain("MINDVAULT_HTTP_TIMEOUT_MS");
  });
});

describe("HTTP failures from the API", () => {
  it("maps a 500 to a server error while preserving the legacy prefix", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ error: "Internal server error" }, false, 500));

    const message = await browse().catch((e) => e.message);
    expect(message).toContain("Browse failed: Internal server error");
    expect(message).toContain("Category: server");
    expect(message).toContain("HTTP 500");
    expectMappedShape(message);
  });

  it("maps a 400 to a validation error telling the agent to fix its arguments", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ error: "invalid resource id" }, false, 400));

    const message = await preview("bad id").catch((e) => e.message);
    expect(message).toContain("Preview failed: invalid resource id");
    expect(message).toContain("Category: validation");
    expect(message).toContain("Correct the invalid arguments");
  });

  it("maps a 404 to not_found pointing back at discovery tools", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ error: "not found" }, false, 404));

    const message = await preview("missing").catch((e) => e.message);
    expect(message).toContain("Category: not_found");
    expect(message).toContain("mindvault_search");
  });
});

describe("402 payment failure", () => {
  beforeEach(() => {
    _setAgentWallet(testWallet);
  });

  it("maps a rejected x402 payment to the payment category", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [
              { asset_type: "native", balance: "10.0" },
              { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "999.00" },
            ],
          }),
        );
      }
      if (u.includes("/meta")) {
        return Promise.resolve(mockResponse({ id: "res-001", title: "Doc", price: "5.00" }));
      }
      return Promise.resolve(mockResponse({ error: "payment rejected" }, false, 402));
    });

    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(
      () => () => Promise.resolve(mockResponse({ error: "payment rejected" }, false, 402)) as any,
    );

    const message = await buy("res-001").catch((e) => e.message);
    expect(message).toContain("Buy failed [402]");
    expect(message).toContain("Source: x402 payment");
    expect(message).toContain("Category: payment");
    expect(message).toContain("HTTP 402");
    expect(message).toContain("mindvault_wallet_info");
    expectMappedShape(message);
  });
});

describe("Soroban RPC failures", () => {
  it("maps a non-ok RPC response while keeping the documented prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 503));

    const message = await txStatus("abc123").catch((e) => e.message);
    expect(message).toContain("Soroban RPC error: 503");
    expect(message).toContain("Source: Soroban RPC");
    expect(message).toContain("Category: server");
  });

  it("maps a JSON-RPC error body to a contract error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: { code: -32602, message: "invalid hash" } }),
    );

    const message = await txStatus("bad").catch((e) => e.message);
    expect(message).toContain("RPC error");
    expect(message).toContain("Source: Soroban RPC");
    expect(message).toContain("Category: contract");
  });
});

describe("contract NotFound", () => {
  it("returns a soft result carrying the same recovery action", async () => {
    hoisted.registryGet = {
      result: {
        isErr: () => true,
        unwrapErr: () => ({ message: RegistryErrors[2].message }),
      },
    };

    const parsed = JSON.parse(await registryLookup("res-missing"));

    expect(parsed.found).toBe(false);
    expect(parsed.next).toContain("not registered on-chain");
    expect(parsed.next).toContain("mindvault_register_onchain");
  });

  it("maps any other contract rejection to a thrown contract error", async () => {
    hoisted.registryGet = {
      result: {
        isErr: () => true,
        unwrapErr: () => ({ message: "Unauthorized" }),
      },
    };

    const message = await registryLookup("res-1").catch((e) => e.message);
    expect(message).toContain("Unauthorized");
    expect(message).toContain("Source: vault-registry contract");
    expect(message).toContain("Category: contract");
    expectMappedShape(message);
  });

  it("maps an unreachable RPC to a network error against Soroban", async () => {
    hoisted.registryGet = Promise.reject(new Error("connect ECONNREFUSED"));
    // The mocked client rejects when awaited.
    const message = await registryLookup("res-1").catch((e) => e.message);
    expect(message).toContain("Source: Soroban RPC");
    expect(message).toContain("Category: network");
    expect(message).toContain("On-chain lookup failed");
  });
});
