/**
 * Regression tests for stdout contamination (#607).
 *
 * The MindVault MCP server communicates with its host over stdio (JSON-RPC).
 * Any stray bytes written to stdout by tool handlers — console.log, bare
 * process.stdout.write, or debug helpers — would corrupt the transport framing
 * and crash the client. These tests spy on both stdout.write and console.log
 * for every tool exercised through `dispatchTool` and assert that no bytes
 * leaked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import {
  browse,
  search,
  preview,
  publishStatus,
  txStatus,
  walletInfo,
  useProfile,
  listProfiles,
  networkProfile,
  _setAgentWallet,
  _resetProfiles,
} from "./index.js";

function mockResponse(data: unknown, ok = true, status = 200): Response {
  const body = JSON.stringify(data);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(data),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response;
}

const testWallet = { publicKey: "GPUB...TEST", secretKey: "SECRET...KEY" };

describe("stdout contamination regression", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    _resetProfiles();
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    consoleLogSpy.mockRestore();
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("browse does not write to stdout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse([
        {
          id: "res-001",
          title: "Test",
          price: "5.00",
          accessUrl: "https://example.com",
        },
      ]),
    );
    await browse();
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("search does not write to stdout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse([
        {
          id: "res-001",
          title: "Stellar Guide",
          price: "5.00",
          accessUrl: "https://example.com",
        },
      ]),
    );
    await search("Stellar");
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("preview does not write to stdout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        id: "res-001",
        title: "Test",
        price: "5.00",
        resourceType: "link",
        verificationStatus: "verified",
        accessUrl: "https://example.com",
      }),
    );
    await preview("res-001");
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("txStatus does not write to stdout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        result: {
          status: "SUCCESS",
          ledger: 123,
          createdAt: 1700000000,
          applicationOrder: 1,
          feeBump: false,
          envelopeXdr: "env",
          resultXdr: "res",
          resultMetaXdr: "meta",
        },
      }),
    );
    await txStatus("abc123");
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("walletInfo does not write to stdout", async () => {
    _setAgentWallet(testWallet);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 0,
        balances: [
          { asset_type: "native", balance: "10.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "5.00" },
        ],
      }),
    );
    await walletInfo();
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("useProfile does not write to stdout", () => {
    useProfile("test-profile");
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("listProfiles does not write to stdout", () => {
    listProfiles();
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("networkProfile does not write to stdout", () => {
    networkProfile();
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("publishStatus does not write to stdout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input: any) => {
      const url = String(input);
      if (url.includes("/verification")) {
        return Promise.resolve(
          mockResponse({
            resourceId: "res-001",
            status: "verified",
            listed: true,
            verification: null,
          }),
        );
      }
      if (url.includes("/meta")) {
        return Promise.resolve(
          mockResponse({
            id: "res-001",
            verificationStatus: "verified",
            onchainStatus: "registered",
            onchainTxHash: "abc123",
          }),
        );
      }
      return Promise.resolve(mockResponse({ error: "unexpected" }, false, 500));
    });
    await publishStatus({ resourceId: "res-001" });
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("no tool writes to stdout even when the fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    await browse().catch(() => {});
    await search("test").catch(() => {});
    await preview("res-001").catch(() => {});
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
