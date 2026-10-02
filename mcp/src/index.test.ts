import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAttestationHashMock = vi.hoisted(() => vi.fn());

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
    getAttestationHash: getAttestationHashMock,
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
  dispatchTool,
  search,
  preview,
  publishStatus,
  txStatus,
  verifyAttestation,
  buy,
  registerOnchain,
  walletInfo,
  useProfile,
  switchNetworkProfile,
  listProfiles,
  networkProfile,
  updateMetadata,
  setPrice,
  transferOwnership,
  acceptTransfer,
  cancelTransfer,
  pendingTransfer,
  setListed,
  setTags,
  normalizeMetadataPointer,
  _setAgentWallet,
  _setAgentApiKey,
  _resetProfiles,
  _setMockMode,
} from "./index.js";
import {
  recordCatalogSnapshot,
  recordPreviewSnapshot,
  _clearCatalogCache,
} from "./catalogCache.js";
import { Keypair } from "@stellar/stellar-sdk";

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

const sampleResources = [
  {
    id: "res-001",
    title: "Introduction to Stellar",
    description: "A beginner's guide to Stellar blockchain",
    price: "5.00",
    accessUrl: "https://example.com/stellar-intro",
    resourceType: "link",
    verificationStatus: "verified",
  },
  {
    id: "res-002",
    title: "Advanced Soroban",
    description: "Deep dive into Soroban smart contracts",
    price: "15.00",
    accessUrl: "https://example.com/soroban-advanced",
    resourceType: "link",
    verificationStatus: "pending",
  },
];

const singleResourceMeta = {
  id: "res-001",
  title: "Introduction to Stellar",
  description: "A beginner's guide to Stellar blockchain",
  price: "5.00",
  resourceType: "link",
  verificationStatus: "verified",
  accessUrl: "https://example.com/stellar-intro",
};

describe("browse", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(mockResponse(sampleResources)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns formatted resource list on success", async () => {
    const result = await browse();
    expect(result).toContain("res-001");
    expect(result).toContain("Introduction to Stellar");
    expect(result).toContain("$5.00 USDC");
    expect(result).toContain("https://example.com/stellar-intro");
    expect(result).toContain("res-002");
    expect(result).toContain("Advanced Soroban");
    expect(result).toContain("$15.00 USDC");
  });

  it("returns empty message when catalog is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse([]));
    const result = await browse();
    expect(result).toBe("No resources listed yet.");
  });

  it("throws on server error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ error: "Internal server error" }, false, 500));
    await expect(browse()).rejects.toThrow("Browse failed");
    await expect(browse()).rejects.toThrow("Internal server error");
  });

  it("throws on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    await expect(browse()).rejects.toThrow("Network error");
  });

  it("calls the correct URL", async () => {
    await browse();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/resources"),
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });
});

describe("prewarmCatalogCache", () => {
  beforeEach(() => {
    _clearCatalogCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _clearCatalogCache();
  });

  it("reports the resource count and populates the catalog cache", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(mockResponse(sampleResources)),
    );
    const result = await prewarmCatalogCache();
    expect(result).toContain("Catalog pre-warmed");
    expect(result).toContain("2 resource(s)");

    // The offline fallback cache should now be warm — a subsequent transport
    // failure falls back to it rather than throwing outright.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    const fallback = await browse();
    expect(fallback).toContain("res-001");
    expect(fallback).toMatch(/Offline catalog snapshot served/);
  });

  it("never throws on a server error — reports it in the return value instead", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(mockResponse({ error: "Internal server error" }, false, 503)),
    );
    const result = await prewarmCatalogCache();
    expect(result).toContain("Catalog pre-warm failed");
  });

  it("never throws on a network failure — reports it in the return value instead", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    const result = await prewarmCatalogCache();
    expect(result).toContain("Catalog pre-warm failed");
  });
});

describe("clientConfig", () => {
  it("defaults to a placeholder path and testnet under the test harness", () => {
    const result = clientConfig("cursor");
    expect(result).toContain("/absolute/path/to/mindvault/mcp/dist/index.js");
    expect(result).toContain('"STELLAR_NETWORK": "testnet"');
  });

  it("uses the servers key (not mcpServers) for vscode", () => {
    const result = clientConfig("vscode");
    const parsed = JSON.parse(result.replace(/^## .*\n\n```json\n/, "").replace(/\n```$/, ""));
    expect(parsed.servers).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.servers.mindvault.type).toBe("stdio");
  });

  it("emits TOML for codex", () => {
    const result = clientConfig("codex");
    expect(result).toContain("[mcp_servers.mindvault]");
    expect(result).toContain('command = "node"');
    expect(result).not.toContain("{");
  });

  it("rejects an unknown client name", () => {
    expect(() => clientConfig("not-a-real-client")).toThrow(/Unknown client/);
  });

  it("returns every client's section when none is specified", () => {
    const result = clientConfig();
    for (const heading of [
      "## Claude Code",
      "## Claude Desktop",
      "## Codex",
      "## Cursor",
      "## VS Code",
      "## Windsurf",
    ]) {
      expect(result).toContain(heading);
    }
  });
});

describe("mainnetBanner", () => {
  it("reflects testnet by default and mentions the paid-confirmation policy", () => {
    const result = mainnetBanner();
    expect(result).toContain("testnet");
    expect(result).toContain("not real funds");
    expect(result).toContain("Paid-operation confirmation:");
  });
});

describe("search", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(mockResponse(sampleResources)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns matching resources by title", async () => {
    const result = await search("Stellar");
    expect(result).toContain("res-001");
    expect(result).not.toContain("res-002");
  });

  it("returns matching resources by description", async () => {
    const result = await search("Soroban");
    expect(result).toContain("res-002");
    expect(result).not.toContain("res-001");
  });

  it("is case-insensitive", async () => {
    const result = await search("stellar");
    expect(result).toContain("Introduction to Stellar");
  });

  it("returns message for empty query", async () => {
    const result = await search("");
    expect(result).toBe("Provide a search query or at least one catalog filter.");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns message for whitespace-only query", async () => {
    const result = await search("   ");
    expect(result).toBe("Provide a search query or at least one catalog filter.");
  });

  it("returns message when no resources match", async () => {
    const result = await search("NonExistentTerm");
    expect(result).toBe('No resources match "NonExistentTerm".');
  });

  it("returns message when catalog is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse([]));
    const result = await search("anything");
    expect(result).toBe('No resources match "anything".');
  });

  it("preserves the original query in the no-match message", async () => {
    const result = await search("Stellar Soroban");
    expect(result).toBe('No resources match "Stellar Soroban".');
  });

  it("throws on server error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ error: "Server error" }, false, 500));
    await expect(search("test")).rejects.toThrow("Search failed");
  });

  it("throws on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    await expect(search("test")).rejects.toThrow("Network error");
  });

  it("calls the correct URL", async () => {
    await search("test");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/resources"),
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("forwards price, type, and verification filters in the query string", async () => {
    await search({
      query: "Stellar",
      minPrice: "1.00",
      maxPrice: "10.00",
      verificationStatus: "verified",
      resourceType: "link",
    });
    const url = String((globalThis.fetch as any).mock.calls[0][0]);
    expect(url).toContain("search=Stellar");
    expect(url).toContain("minPrice=1.00");
    expect(url).toContain("maxPrice=10.00");
    expect(url).toContain("verificationStatus=verified");
    expect(url).toContain("resourceType=link");
  });

  it("forwards owner, sort, and pagination filters", async () => {
    await search({
      query: "x",
      owner: "Alice",
      sort: "price_asc",
      limit: 10,
      offset: 5,
    });
    const url = String((globalThis.fetch as any).mock.calls[0][0]);
    expect(url).toContain("owner=Alice");
    expect(url).toContain("sort=price_asc");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
  });

  it("filters by tags and listed client-side", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse([
        {
          ...sampleResources[0],
          tags: ["stellar", "guide"],
          listed: true,
        },
        {
          ...sampleResources[1],
          tags: ["soroban"],
          listed: true,
        },
      ]),
    );
    const result = await search({ query: "a", tags: ["stellar"], listed: true });
    expect(result).toContain("res-001");
    expect(result).not.toContain("res-002");
  });

  it("allows filter-only search without a keyword", async () => {
    const result = await search({ resourceType: "link", verificationStatus: "verified" });
    const url = String((globalThis.fetch as any).mock.calls[0][0]);
    expect(url).toContain("resourceType=link");
    expect(url).toContain("verificationStatus=verified");
    expect(url).not.toContain("search=");
    expect(result).toContain("res-001");
  });
});

describe("browse with filters", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(mockResponse(sampleResources)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies the same catalog filters as search", async () => {
    await browse({
      query: "Stellar",
      minPrice: "1.00",
      maxPrice: "10.00",
      verificationStatus: "verified",
      resourceType: "link",
      owner: "Alice",
      sort: "newest",
      limit: 20,
      offset: 0,
      tags: ["guide"],
      listed: true,
    });
    const url = String((globalThis.fetch as any).mock.calls[0][0]);
    expect(url).toContain("search=Stellar");
    expect(url).toContain("minPrice=1.00");
    expect(url).toContain("owner=Alice");
    expect(url).not.toContain("tags=");
    expect(url).not.toContain("listed=");
  });

  it("returns a no-match message when filters exclude everything", async () => {
    const result = await browse({ query: "zzzz-no-match" });
    expect(result).toContain("No resources match");
  });
});

describe("preview", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(mockResponse(singleResourceMeta)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON with expected top-level keys", async () => {
    const result = await preview("res-001");
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      id: "res-001",
      title: "Introduction to Stellar",
      description: "A beginner's guide to Stellar blockchain",
      price: "$5.00 USDC",
      type: "link",
      verificationStatus: "verified",
      accessUrl: "https://example.com/stellar-intro",
    });
  });

  it("includes all critical fields and no extras", async () => {
    const result = await preview("res-001");
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("title");
    expect(parsed).toHaveProperty("description");
    expect(parsed).toHaveProperty("price");
    expect(parsed).toHaveProperty("type");
    expect(parsed).toHaveProperty("verificationStatus");
    expect(parsed).toHaveProperty("accessUrl");
    expect(Object.keys(parsed)).toHaveLength(7);
  });

  it("formats price with USDC suffix", async () => {
    const result = await preview("res-001");
    const parsed = JSON.parse(result);
    expect(parsed.price).toMatch(/^\$\d+\.\d+ USDC$/);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ error: "Not found" }, false, 404));
    await expect(preview("missing")).rejects.toThrow("Preview failed");
  });

  it("throws on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    await expect(preview("res-001")).rejects.toThrow("Network error");
  });

  it("calls the correct URL for the resource", async () => {
    await preview("res-001");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/resources/res-001/meta"),
      expect.anything(),
    );
  });

  it("includes owner fields when active wallet matches publisherWallet", async () => {
    const wallet = { publicKey: "GOWNER...", secretKey: "SOWNER..." };
    _setAgentWallet(wallet);
    _setAgentApiKey("test-api-key");

    const metaWithOwner = {
      ...singleResourceMeta,
      publisherWallet: "GOWNER...",
    };
    const verWithListed = {
      resourceId: "res-001",
      title: "Introduction to Stellar",
      status: "verified",
      listed: true,
      onchainStatus: "registered",
      verification: { isOriginal: true, confidence: 0.95, flags: [], checkedAt: new Date().toISOString() },
    };

    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      callCount++;
      if (url.includes("/meta")) {
        return mockResponse(metaWithOwner);
      }
      if (url.includes("/verification")) {
        return mockResponse(verWithListed);
      }
      return mockResponse({ error: "not found" }, false, 404);
    });

    try {
      const result = await preview("res-001");
      const parsed = JSON.parse(result);

      expect(parsed.isOwner).toBe(true);
      expect(parsed.listed).toBe(true);
      expect(parsed.onchainStatus).toBe("registered");
      expect(parsed.delistNote).toBeUndefined();

      // Two calls: /meta and /verification
      expect(callCount).toBe(2);
    } finally {
      _setAgentWallet(null);
      _setAgentApiKey(null);
      vi.restoreAllMocks();
    }
  });

  it("includes delistNote when resource is delisted", async () => {
    const wallet = { publicKey: "GOWNER...", secretKey: "SOWNER..." };
    _setAgentWallet(wallet);
    _setAgentApiKey("test-api-key");

    const metaWithOwner = {
      ...singleResourceMeta,
      publisherWallet: "GOWNER...",
    };
    const verDelisted = {
      resourceId: "res-001",
      title: "Introduction to Stellar",
      status: "verified",
      listed: false,
      onchainStatus: "registered",
      verification: { isOriginal: true, confidence: 0.95, flags: [], checkedAt: new Date().toISOString() },
    };

    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      callCount++;
      if (url.includes("/meta")) {
        return mockResponse(metaWithOwner);
      }
      if (url.includes("/verification")) {
        return mockResponse(verDelisted);
      }
      return mockResponse({ error: "not found" }, false, 404);
    });

    try {
      const result = await preview("res-001");
      const parsed = JSON.parse(result);

      expect(parsed.isOwner).toBe(true);
      expect(parsed.listed).toBe(false);
      expect(parsed.delistNote).toBe("This resource is delisted and not discoverable in the public catalog.");
    } finally {
      _setAgentWallet(null);
      _setAgentApiKey(null);
      vi.restoreAllMocks();
    }
  });

  it("does not include owner fields when not the owner", async () => {
    const wallet = { publicKey: "GNOTOWNER...", secretKey: "SNOTOWNER..." };
    _setAgentWallet(wallet);
    _setAgentApiKey("test-api-key");

    const metaNotOwner = {
      ...singleResourceMeta,
      publisherWallet: "GOWNER...",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(metaNotOwner));

    try {
      const result = await preview("res-001");
      const parsed = JSON.parse(result);

      expect(parsed.isOwner).toBeUndefined();
      expect(parsed.listed).toBeUndefined();
      expect(parsed.onchainStatus).toBeUndefined();
      expect(parsed.delistNote).toBeUndefined();

      // Only one call: /meta (no /verification for non-owners)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      _setAgentWallet(null);
      _setAgentApiKey(null);
      vi.restoreAllMocks();
    }
  });

  it("does not include owner fields when no wallet configured", async () => {
    _setAgentWallet(null);
    _setAgentApiKey("test-api-key");

    const metaNotOwner = {
      ...singleResourceMeta,
      publisherWallet: "GOWNER...",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(metaNotOwner));

    try {
      const result = await preview("res-001");
      const parsed = JSON.parse(result);

      expect(parsed.isOwner).toBeUndefined();
      expect(parsed.listed).toBeUndefined();
    } finally {
      _setAgentWallet(null);
      _setAgentApiKey(null);
      vi.restoreAllMocks();
    }
  });

  it("sends x-api-key header when api key is configured", async () => {
    const wallet = { publicKey: "GOWNER...", secretKey: "SOWNER..." };
    _setAgentWallet(wallet);
    _setAgentApiKey("test-api-key");

    const metaWithOwner = {
      ...singleResourceMeta,
      publisherWallet: "GOWNER...",
    };
    const verWithListed = {
      resourceId: "res-001",
      title: "Introduction to Stellar",
      status: "verified",
      listed: true,
      onchainStatus: "registered",
      verification: { isOriginal: true, confidence: 0.95, flags: [], checkedAt: new Date().toISOString() },
    };

    let lastInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      lastInit = init;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/meta")) return mockResponse(metaWithOwner);
      if (url.includes("/verification")) return mockResponse(verWithListed);
      return mockResponse({ error: "not found" }, false, 404);
    });

    try {
      await preview("res-001");
      // Check that the /verification call also got the x-api-key
      expect(lastInit?.headers).toEqual(
        expect.objectContaining({ "x-api-key": "test-api-key" }),
      );
    } finally {
      _setAgentWallet(null);
      _setAgentApiKey(null);
      vi.restoreAllMocks();
    }
  });
});

describe("publishStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mockMetaAndVerification(opts: {
    verificationStatus: string;
    onchainStatus?: string;
    onchainTxHash?: string | null;
    listed?: boolean;
  }) {
    const meta = {
      id: "res-001",
      title: "Introduction to Stellar",
      verificationStatus: opts.verificationStatus,
      onchainStatus: opts.onchainStatus ?? "none",
      onchainTxHash: opts.onchainTxHash ?? null,
      contentHash: "abc123",
      accessUrl: "https://example.com/stellar-intro",
      listed: opts.listed ?? opts.verificationStatus === "verified",
    };
    const verification = {
      resourceId: "res-001",
      title: "Introduction to Stellar",
      status: opts.verificationStatus,
      listed: opts.listed ?? opts.verificationStatus === "verified",
      verification:
        opts.verificationStatus === "verified"
          ? {
              isOriginal: true,
              confidence: 0.95,
              flags: [],
              checkedAt: "2026-01-01T00:00:00.000Z",
            }
          : null,
    };
    return vi.spyOn(globalThis, "fetch").mockImplementation((input: any) => {
      const url = String(input);
      if (url.includes("/verification")) return Promise.resolve(mockResponse(verification));
      if (url.includes("/meta")) return Promise.resolve(mockResponse(meta));
      return Promise.resolve(mockResponse({ error: "unexpected" }, false, 500));
    });
  }

  it("reports verified status with on-chain sync fields", async () => {
    mockMetaAndVerification({
      verificationStatus: "verified",
      onchainStatus: "registered",
      onchainTxHash: "txhash1",
    });
    const parsed = JSON.parse(await publishStatus({ resourceId: "res-001" }));
    expect(parsed.verificationStatus).toBe("verified");
    expect(parsed.onchainStatus).toBe("registered");
    expect(parsed.onchainTxHash).toBe("txhash1");
    expect(parsed.listed).toBe(true);
    expect(parsed.settled).toBe(true);
    expect(parsed.polled).toBe(false);
    expect(parsed.attempts).toBe(1);
  });

  it("reports pending, rejected, and skipped statuses", async () => {
    for (const status of ["pending", "rejected", "skipped"] as const) {
      mockMetaAndVerification({ verificationStatus: status, onchainStatus: "none" });
      const parsed = JSON.parse(await publishStatus({ resourceId: "res-001" }));
      expect(parsed.verificationStatus).toBe(status);
      expect(parsed.settled).toBe(status !== "pending");
      expect(parsed.onchainStatus).toBe("none");
    }
  });

  it("throws a deterministic error when resourceId is missing", async () => {
    await expect(publishStatus({})).rejects.toThrow(/resourceId is required/);
    await expect(publishStatus({ resourceId: "   " })).rejects.toThrow(/resourceId is required/);
  });

  it("throws a deterministic 404 error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "Resource not found" }, false, 404),
    );
    await expect(publishStatus({ resourceId: "missing" })).rejects.toThrow(/not found/i);
  });

  it("polls until verification settles when wait is true", async () => {
    vi.useFakeTimers();
    let round = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input: any) => {
      const url = String(input);
      // Advance the poll round only on meta requests so meta+verification stay
      // consistent within a single Promise.all pair.
      if (url.includes("/meta")) round += 1;
      const status = round < 2 ? "pending" : "verified";
      if (url.includes("/verification")) {
        return Promise.resolve(
          mockResponse({
            resourceId: "res-001",
            status,
            listed: status === "verified",
            verification: null,
          }),
        );
      }
      if (url.includes("/meta")) {
        return Promise.resolve(
          mockResponse({
            id: "res-001",
            verificationStatus: status,
            onchainStatus: status === "verified" ? "pending" : "none",
            onchainTxHash: null,
          }),
        );
      }
      return Promise.resolve(mockResponse({ error: "unexpected" }, false, 500));
    });

    const pending = publishStatus({
      resourceId: "res-001",
      wait: true,
      timeoutMs: 10_000,
      intervalMs: 500,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const parsed = JSON.parse(await pending);
    expect(parsed.verificationStatus).toBe("verified");
    expect(parsed.settled).toBe(true);
    expect(parsed.polled).toBe(true);
    expect(parsed.attempts).toBeGreaterThan(1);
    expect(parsed.onchainStatus).toBe("pending");
  });

  it("returns timedOut when wait expires while still pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((input: any) => {
      const url = String(input);
      const body = url.includes("/verification")
        ? { resourceId: "res-001", status: "pending", listed: false, verification: null }
        : {
            id: "res-001",
            verificationStatus: "pending",
            onchainStatus: "none",
            onchainTxHash: null,
          };
      return Promise.resolve(mockResponse(body));
    });

    const pending = publishStatus({
      resourceId: "res-001",
      wait: true,
      timeoutMs: 1_000,
      intervalMs: 200,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const parsed = JSON.parse(await pending);
    expect(parsed.verificationStatus).toBe("pending");
    expect(parsed.timedOut).toBe(true);
    expect(parsed.settled).toBe(false);
    expect(parsed.message).toMatch(/Timed out/);
  });
});

describe("txStatus", () => {
  const successEnvelope = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      status: "SUCCESS",
      ledger: 123456,
      createdAt: 1700000000,
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: "AAAA...env",
      resultXdr: "AAAA...res",
      resultMetaXdr: "AAAA...meta",
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a readable SUCCESS response with ledger and close time", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(successEnvelope));
    const result = await txStatus("abc123");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.hash).toBe("abc123");
    expect(parsed.ledger).toBe(123456);
    expect(parsed.ledgerCloseTime).toBe(new Date(1700000000 * 1000).toISOString());
    expect(parsed.resultXdr).toBe("AAAA...res");
  });

  it("returns a readable FAILED response carrying the result XDR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ result: { ...successEnvelope.result, status: "FAILED" } }),
    );
    const result = await txStatus("def456");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("FAILED");
    expect(parsed.resultXdr).toBe("AAAA...res");
  });

  it("returns an explicit NOT_FOUND message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ result: { status: "NOT_FOUND", oldestLedger: 1, latestLedger: 999 } }),
    );
    const result = await txStatus("missing");
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("NOT_FOUND");
    expect(parsed.message).toContain("not found");
  });

  it("returns a message for an empty hash without calling the RPC", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await txStatus("   ");
    expect(result).toBe("Provide a transaction hash to look up.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws on a JSON-RPC error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: { code: -32602, message: "invalid hash" } }),
    );
    await expect(txStatus("bad")).rejects.toThrow("RPC error");
  });

  it("throws on a non-ok HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 503));
    await expect(txStatus("abc123")).rejects.toThrow("Soroban RPC error: 503");
  });

  it("posts a getTransaction request to the Soroban RPC", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(successEnvelope));
    await txStatus("abc123");
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("getTransaction"),
      }),
    );
  });
});

// ── mindvault_buy (#313) ────────────────────────────────────────────────────

const testWallet = { publicKey: "GPUB...TEST", secretKey: "SECRET...KEY" };

describe("buy – happy path (402 → sign → retry → success)", () => {
  beforeEach(() => {
    _setAgentWallet(testWallet);
    _setAgentApiKey(null);
  });

  afterEach(() => {
    _setAgentWallet(null);
    _setAgentApiKey(null);
    vi.restoreAllMocks();
  });

  it("returns parsed resource JSON on a successful paid fetch", async () => {
    const resourceData = {
      id: "res-001",
      title: "Introduction to Stellar",
      price: "5.00",
      accessUrl: "https://example.com/stellar-intro",
    };

    // mock: meta fetch (balance check) → balance covers price
    // mock: Horizon balance check → sufficient balance
    // mock: paid fetch → success
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        // Horizon balance: enough USDC
        return Promise.resolve(
          mockResponse({
            balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "100.00" }],
          }),
        );
      }
      if (u.includes("/meta")) {
        return Promise.resolve(
          mockResponse({ ...resourceData, price: "5.00", title: "Introduction to Stellar" }),
        );
      }
      // The paid fetch to access the resource
      return Promise.resolve(mockResponse(resourceData));
    });

    // wrapFetchWithPayment should return a fetch that eventually succeeds
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => {
      return (_url: any, _init?: any) => Promise.resolve(mockResponse(resourceData));
    });

    const result = await buy("res-001");
    const parsed = JSON.parse(result);
    expect(parsed.after).toHaveProperty("id", "res-001");
    expect(parsed.after).toHaveProperty("title", "Introduction to Stellar");
    expect(parsed.after).toHaveProperty("purchased", true);
    expect(parsed.changedFields).toContain("purchased");
    expect(parsed).toHaveProperty("after");
    expect(parsed.after).toHaveProperty("id", "res-001");
    expect(parsed.after).toHaveProperty("title", "Introduction to Stellar");
    expect(parsed.after).toHaveProperty("purchased", true);
  });

  it("returns an insufficient-funds message when wallet balance is too low", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        // Horizon: insufficient balance
        return Promise.resolve(
          mockResponse({
            balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "1.00" }],
          }),
        );
      }
      if (u.includes("/meta")) {
        return Promise.resolve(
          mockResponse({ id: "res-001", title: "Intro to Stellar", price: "50.00" }),
        );
      }
      return Promise.resolve(mockResponse({}, false, 402));
    });

    // Authorize the $50 price explicitly so the ceiling guard passes and the
    // funds check (the behavior under test) is what reports the shortfall.
    const result = await buy("res-001", false, undefined, undefined, "50.00");
    expect(result).toContain("Insufficient USDC");
    expect(result).toContain("50 USDC");
    expect(result).toContain("1 USDC");
    expect(result.toLowerCase()).toContain("shortfall");
  });

  it("throws when the paid fetch fails (non-ok response)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "999.00" }],
          }),
        );
      }
      if (u.includes("/meta")) {
        return Promise.resolve(mockResponse({ id: "res-001", title: "Doc", price: "5.00" }));
      }
      return Promise.resolve(mockResponse({ error: "payment rejected" }, false, 402));
    });

    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => {
      return (_url: any, _init?: any) =>
        Promise.resolve(mockResponse({ error: "payment rejected" }, false, 402));
    });

    await expect(buy("res-001")).rejects.toThrow("Buy failed");
  });

  it("throws when no wallet is configured", async () => {
    _setAgentWallet(null);
    await expect(buy("res-001")).rejects.toThrow("No wallet");
  });
});

describe("buy – output shape for agent consumption", () => {
  beforeEach(() => {
    _setAgentWallet(testWallet);
  });

  afterEach(() => {
    _setAgentWallet(null);
    vi.restoreAllMocks();
  });

  it("output is valid JSON with the resource fields", async () => {
    const resourcePayload = {
      id: "res-007",
      title: "Zero-knowledge Proofs",
      price: "20.00",
      accessUrl: "https://example.com/zkp",
      contentUrl: "https://paywall.example.com/content/res-007",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "100.00" }],
          }),
        );
      }
      return Promise.resolve(mockResponse(resourcePayload));
    });

    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => {
      return () => Promise.resolve(mockResponse(resourcePayload));
    });

    const result = await buy("res-007", false, undefined, undefined, "20.00");
    // Output must be parseable JSON – agents rely on this.
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty("after");
    expect(parsed.after).toHaveProperty("id");
    expect(parsed.after).toHaveProperty("accessUrl");
    expect(parsed.after).toHaveProperty("purchased", true);
  });
});

// ── buy – purchase receipt persistence (#415) ──────────────────────────────

describe("buy – purchase receipt persistence", () => {
  let purchaseDir: string;

  beforeEach(async () => {
    _setAgentWallet(testWallet);
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    purchaseDir = mkdtempSync(join(tmpdir(), "mv-purchase-"));

    const { _setPurchasesFilePath } = await import("./purchaseHistory.js");
    _setPurchasesFilePath(join(purchaseDir, "purchases.json"));
  });

  afterEach(async () => {
    _setAgentWallet(null);
    const { rmSync } = await import("fs");
    rmSync(purchaseDir, { recursive: true, force: true });

    const { _setPurchasesFilePath } = await import("./purchaseHistory.js");
    _setPurchasesFilePath(null);
    vi.restoreAllMocks();
  });

  it("records purchase with resourceId, amount, network, txHash, and timestamp", async () => {
    const resourcePayload = {
      id: "res-purchase-001",
      title: "Test Dataset",
      price: "10.50",
      accessUrl: "https://example.com/res-001",
      txHash: "abc123txhash",
      receipt: { amount: "10.50", paymentId: "pay-12345" },
    };

    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "100.00" }],
          }),
        );
      }
      return Promise.resolve(mockResponse(resourcePayload));
    });

    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => {
      return () => Promise.resolve(mockResponse(resourcePayload));
    });

    await buy("res-purchase-001", false, undefined, undefined, "10.50");

    const { listPurchases } = await import("./purchaseHistory.js");
    const purchases = listPurchases();
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      resourceId: "res-purchase-001",
      amount: "10.50",
      network: expect.stringContaining("stellar"),
      txHash: "abc123txhash",
      receiptRef: "pay-12345",
      title: "Test Dataset",
    });
    expect(purchases[0].timestamp).toBeDefined();
  });

  it("persists receipt to ~/.mindvault/purchases.json with deterministic structure", async () => {
    const resourcePayload = {
      id: "res-002",
      title: "Tutorial",
      price: "5.00",
      accessUrl: "https://example.com/tut",
      txHash: null,
      receipt: { amount: "5.00", paymentId: null },
    };

    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "100.00" }],
          }),
        );
      }
      return Promise.resolve(mockResponse(resourcePayload));
    });

    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => {
      return () => Promise.resolve(mockResponse(resourcePayload));
    });

    await buy("res-002");

    const { readFileSync } = await import("fs");
    const fileContent = JSON.parse(readFileSync(purchaseDir + "/purchases.json", "utf-8"));
    expect(fileContent).toHaveProperty("version", 1);
    expect(fileContent).toHaveProperty("purchases");
    expect(fileContent.purchases).toHaveLength(1);
    expect(fileContent.purchases[0]).toHaveProperty("resourceId");
    expect(fileContent.purchases[0]).toHaveProperty("amount");
    expect(fileContent.purchases[0]).toHaveProperty("network");
    expect(fileContent.purchases[0]).toHaveProperty("timestamp");
  });

  it("handles missing txHash and receiptRef gracefully", async () => {
    const resourcePayload = {
      id: "res-003",
      title: "Guide",
      price: "2.50",
      accessUrl: "https://example.com/guide",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/accounts/")) {
        return Promise.resolve(
          mockResponse({
            balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "100.00" }],
          }),
        );
      }
      return Promise.resolve(mockResponse(resourcePayload));
    });

    const { wrapFetchWithPayment } = await import("@x402/fetch");
    vi.mocked(wrapFetchWithPayment).mockImplementation(() => {
      return () => Promise.resolve(mockResponse(resourcePayload));
    });

    await buy("res-003");

    const { listPurchases } = await import("./purchaseHistory.js");
    const purchases = listPurchases();
    expect(purchases[0]).toMatchObject({
      resourceId: "res-003",
      txHash: null,
      receiptRef: null,
    });
  });
});

// ── dry-run mode (#411) ─────────────────────────────────────────────────────

describe("dry-run – publish validation", () => {
  beforeEach(() => {
    _setAgentWallet(testWallet);
    _setAgentApiKey("test-api-key");
    _setMockMode(true);
  });

  afterEach(() => {
    _setAgentWallet(null);
    _setAgentApiKey(null);
    _setMockMode(false);
    vi.restoreAllMocks();
  });

  it("returns dry-run result without submitting payment", async () => {
    const result = await dispatchTool("mindvault_publish", {
      title: "Test Resource",
      price: "5.00",
      externalUrl: "https://example.com/data",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.operation).toBe("publish");
    expect(parsed.validation).toBeDefined();
    expect(parsed.intentions).toBeDefined();
    expect(parsed.steps).toBeDefined();
  });

  it("validates title in dry-run", async () => {
    const result = await dispatchTool("mindvault_publish", {
      title: "",
      price: "5.00",
      externalUrl: "https://example.com/data",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.title.valid).toBe(false);
    expect(parsed.validation.title.error).toBeDefined();
  });

  it("validates price in dry-run", async () => {
    const result = await dispatchTool("mindvault_publish", {
      title: "Test",
      price: "invalid",
      externalUrl: "https://example.com/data",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.price.valid).toBe(false);
  });

  it("validates URL in dry-run", async () => {
    const result = await dispatchTool("mindvault_publish", {
      title: "Test",
      price: "5.00",
      externalUrl: "not-a-url",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.externalUrl.valid).toBe(false);
  });

  it("shows required wallet state in intentions", async () => {
    const result = await dispatchTool("mindvault_publish", {
      title: "Test",
      price: "5.00",
      externalUrl: "https://example.com/data",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.intentions.requiredWalletState.wallet).toBe(true);
    expect(parsed.intentions.requiredWalletState.publisherApiKey).toBe(true);
  });

  it("shows network and endpoint in intentions", async () => {
    const result = await dispatchTool("mindvault_publish", {
      title: "Test",
      price: "5.00",
      externalUrl: "https://example.com/data",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.intentions.network).toBeDefined();
    expect(parsed.intentions.endpoint).toContain("POST");
    expect(parsed.intentions.endpoint).toContain("/resources");
  });
});

describe("dry-run – buy validation", () => {
  beforeEach(() => {
    _setAgentWallet(testWallet);
    vi.stubEnv("MINDVAULT_MAX_AUTO_PAY_USDC", undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ price: "5.00" }));
  });

  afterEach(() => {
    _setAgentWallet(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the live payment ceiling and per-call override for the quoted price", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ price: "10.01" }));

    const result = await dispatchTool("mindvault_buy", {
      resourceId: "res-001",
      dryRun: true,
      maxAutoPayUsdc: "10.01",
    });

    expect(JSON.parse(result).intentions.estimatedPrice).toBe("10.01");
  });

  it("rejects a quoted price above the default ceiling without an override", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ price: "10.01" }));

    await expect(
      dispatchTool("mindvault_buy", { resourceId: "res-001", dryRun: true }),
    ).rejects.toThrow(/exceeds the automatic payment ceiling/);
  });

  it("returns dry-run result without submitting payment", async () => {
    const result = await dispatchTool("mindvault_buy", {
      resourceId: "res-001",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.operation).toBe("buy");
    expect(parsed.resourceId).toBe("res-001");
    expect(parsed.validation).toBeDefined();
    expect(parsed.intentions).toBeDefined();
    expect(parsed.steps).toBeDefined();
  });

  it("validates resource ID in dry-run", async () => {
    const result = await dispatchTool("mindvault_buy", {
      resourceId: "res@invalid",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.resourceId.valid).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows required wallet state in intentions", async () => {
    const result = await dispatchTool("mindvault_buy", {
      resourceId: "res-001",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.intentions.requiredWalletState.wallet).toBe(true);
  });

  it("shows network and endpoint in intentions", async () => {
    const result = await dispatchTool("mindvault_buy", {
      resourceId: "res-001",
      dryRun: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.intentions.network).toBeDefined();
    expect(parsed.intentions.endpoint).toContain("GET");
    expect(parsed.intentions.endpoint).toContain("/resources/res-001");
  });
});

// ── mindvault_register_onchain (#313) ───────────────────────────────────────

describe("registerOnchain – happy path", () => {
  beforeEach(() => {
    _setAgentWallet(testWallet);
    _setAgentApiKey("test-api-key");
  });

  afterEach(() => {
    _setAgentWallet(null);
    _setAgentApiKey(null);
    vi.restoreAllMocks();
  });

  it("returns a success message with on-chain tx hash", async () => {
    const unsignedXdr = "AAAAAQAAAAD...unsigned";
    const txHash = "abc123txhash";

    vi.spyOn(globalThis, "fetch").mockImplementation((url, _init) => {
      const u = String(url);
      if (u.includes("/register/prepare")) {
        return Promise.resolve(
          mockResponse({
            unsignedXdr,
            networkPassphrase: "Test SDF Network ; September 2015",
          }),
        );
      }
      if (u.includes("/register")) {
        return Promise.resolve(mockResponse({ onchainStatus: "registered", txHash }));
      }
      return Promise.resolve(mockResponse({}));
    });

    // Mock stellar-sdk Transaction + Keypair signing
    vi.doMock("@stellar/stellar-sdk", () => ({
      Keypair: {
        fromSecret: vi.fn().mockReturnValue({ sign: vi.fn() }),
      },
      Transaction: vi.fn(function () {
        return {
          sign: vi.fn(),
          toXDR: vi.fn().mockReturnValue("AAAAAQAAAAD...signed"),
        };
      }),
    }));

    const result = await registerOnchain("res-001");
    expect(result).toContain("registered");
    expect(result).toContain("res-001");
  });

  it("throws when no wallet is configured", async () => {
    _setAgentWallet(null);
    await expect(registerOnchain("res-001")).rejects.toThrow("No wallet");
  });

  it("throws when no API key is configured", async () => {
    _setAgentApiKey(null);
    await expect(registerOnchain("res-001")).rejects.toThrow("Not registered");
  });

  it("throws when resourceId is empty", async () => {
    await expect(registerOnchain("")).rejects.toThrow("resourceId is required");
  });
});

describe("registerOnchain – error and retry messaging", () => {
  beforeEach(() => {
    _setAgentWallet(testWallet);
    _setAgentApiKey("test-api-key");
  });

  afterEach(() => {
    _setAgentWallet(null);
    _setAgentApiKey(null);
    vi.restoreAllMocks();
  });

  it("throws with actionable message when resource is not verified (400)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/register/prepare")) {
        return Promise.resolve(
          mockResponse({ error: "Resource must be verified first" }, false, 400),
        );
      }
      return Promise.resolve(mockResponse({}));
    });

    const err = await registerOnchain("res-unverified").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("400");
    expect(err.message).toContain("verified");
  });

  it("throws with actionable message when resource is already registered (409)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/register/prepare")) {
        return Promise.resolve(mockResponse({ error: "Already registered" }, false, 409));
      }
      return Promise.resolve(mockResponse({}));
    });

    const err = await registerOnchain("res-already").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("already registered");
  });

  it("throws with actionable message when prepare lacks unsignedXdr", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/register/prepare")) {
        return Promise.resolve(mockResponse({ networkPassphrase: "Test" }));
      }
      return Promise.resolve(mockResponse({}));
    });

    const err = await registerOnchain("res-001").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("unsigned transaction");
  });

  it("throws with tx hash hint when submission fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/register/prepare")) {
        return Promise.resolve(
          mockResponse({
            unsignedXdr: "AAAAAQ...xdr",
            networkPassphrase: "Test SDF Network ; September 2015",
          }),
        );
      }
      if (u.includes("/register")) {
        return Promise.resolve(
          mockResponse({ detail: "node timeout", txHash: "failhash123" }, false, 504),
        );
      }
      return Promise.resolve(mockResponse({}));
    });

    vi.doMock("@stellar/stellar-sdk", () => ({
      Keypair: {
        fromSecret: vi.fn().mockReturnValue({ sign: vi.fn() }),
      },
      Transaction: vi.fn(function () {
        return {
          sign: vi.fn(),
          toXDR: vi.fn().mockReturnValue("AAAAAQ...signed"),
        };
      }),
    }));

    const err = await registerOnchain("res-timeout").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("504");
    expect(err.message).toContain("remains listed");
  });

  it("throws with ownership error message (403)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/register/prepare")) {
        return Promise.resolve(mockResponse({ error: "Not the owner" }, false, 403));
      }
      return Promise.resolve(mockResponse({}));
    });

    const err = await registerOnchain("res-other").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("different publisher");
  });

  it("output shape is valid for agent consumption on success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/register/prepare")) {
        return Promise.resolve(
          mockResponse({
            unsignedXdr: "AAAAAQ...xdr",
            networkPassphrase: "Test SDF Network ; September 2015",
          }),
        );
      }
      if (u.includes("/register")) {
        return Promise.resolve(
          mockResponse({ onchainStatus: "registered", txHash: "goodhash456" }),
        );
      }
      return Promise.resolve(mockResponse({}));
    });

    vi.doMock("@stellar/stellar-sdk", () => ({
      Keypair: { fromSecret: vi.fn().mockReturnValue({ sign: vi.fn() }) },
      Transaction: vi.fn(function () {
        return {
          sign: vi.fn(),
          toXDR: vi.fn().mockReturnValue("AAAAAQ...signed"),
        };
      }),
    }));

    const result = await registerOnchain("res-success");
    // Output is a multi-line human-readable string (not JSON) that the agent
    // can parse to determine next steps.
    expect(typeof result).toBe("string");
    expect(result).toContain("registered");
    expect(result).toContain("res-success");
  });
});

// ── setupWallet – failure diagnostics (#414) ─────────────────────────────────

describe("setupWallet – sponsored account failure diagnostics", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("returns actionable error when service returns 503 (unavailable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "service temporarily unavailable" }, false, 503),
    );

    await expect(dispatchTool("mindvault_setup_wallet", {})).rejects.toThrow();
    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("failed to create wallet");
      expect(msg).toContain("unavailable");
      expect(msg).toMatch(/restarting|wait/i);
    }
  });

  it("returns actionable error when service returns 429 (rate limited)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "too many requests" }, false, 429),
    );

    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Rate limit");
      expect(msg).toMatch(/wait.*retry/i);
    }
  });

  it("includes service status and issue category in error output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "account creation failed" }, false, 500),
    );

    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Service:");
      expect(msg).toContain("Status:");
      expect(msg).toContain("Issue:");
    }
  });

  it("does not leak internal service details in error message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse(
        {
          internalErrorCode: "SPONSOR_DB_FAILED",
          debugStackTrace: "at Function.doSomething...",
        },
        false,
        500,
      ),
    );

    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).not.toContain("SPONSOR_DB_FAILED");
      expect(msg).not.toContain("stackTrace");
      expect(msg).not.toContain("at Function");
    }
  });

  it("provides next steps without leaking internals", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ reason: "sponsorship quota exceeded" }, false, 400),
    );

    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Next:");
      expect(msg).toMatch(/malformed|client|issue/i);
    }
  });

  it("handles network errors deterministically", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));

    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Next:");
      expect(msg).toMatch(/network|connect/i);
    }
  });

  // An outage usually means the service never answers at all. That throws at the
  // transport layer, so these assert the diagnostics survive that path too.
  it("reports full diagnostics when the service is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));

    expect.assertions(5);
    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      const msg = err.message;
      expect(msg).toContain("Service:");
      expect(msg).toContain("Issue: unreachable");
      expect(msg).toContain("Reachable: no");
      expect(msg).toContain("Retryable: yes");
      expect(msg).not.toContain("Status:");
    }
  });

  it("marks a rejected request as not worth retrying unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "bad request" }, false, 400),
    );

    expect.assertions(2);
    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      expect(err.message).toContain("Retryable: no");
      expect(err.message).toContain("Issue: rejected");
    }
  });

  it("passes the service's Retry-After through to the agent", async () => {
    const res = mockResponse({ error: "too many requests" }, false, 429);
    res.headers = new Headers({ "retry-after": "20" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(res);

    expect.assertions(2);
    try {
      await dispatchTool("mindvault_setup_wallet", {});
    } catch (err: any) {
      expect(err.message).toContain("Retry-After: 20s");
      expect(err.message).toContain("20s wait");
    }
  });
});

describe("repairSponsoredAccount", () => {
  const secretKey = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const publicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    _resetProfiles();
    vi.doMock("@stellar/stellar-sdk", () => ({
      Keypair: {
        fromSecret: vi.fn().mockReturnValue({ publicKey: () => publicKey }),
      },
    }));
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("re-fetches Horizon state before restoring a half-created wallet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "2.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "0.0000000" },
        ],
      }),
    );

    const result = JSON.parse(
      await dispatchTool("mindvault_repair_sponsored_account", {
        secretKey,
        profile: "recovered",
      }),
    );
    expect(result).toMatchObject({
      status: "repaired",
      profile: "recovered",
      address: publicKey,
      accountStatus: "zero",
      persisted: true,
    });
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });

  it("does not restore a key when Horizon says the account is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 404));

    await expect(dispatchTool("mindvault_repair_sponsored_account", { secretKey })).rejects.toThrow(
      /does not exist.*no local key was changed/i,
    );
  });
});

describe("multi-wallet profiles", () => {
  beforeEach(() => {
    _resetProfiles();
  });
  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  const walletA = { publicKey: "GAAA", secretKey: "SAAA" };
  const walletB = { publicKey: "GBBB", secretKey: "SBBB" };

  it("use_profile creates a new empty profile and switches to it", () => {
    const result = useProfile("publisher");
    expect(result).toContain("Active profile: publisher");
    expect(result).toContain("No wallet in this profile yet");
    expect(listProfiles()).toContain("publisher");
  });

  it("use_profile reports the wallet when the profile already has one", () => {
    useProfile("publisher");
    _setAgentWallet(walletA);
    _setAgentApiKey("key-a");

    const result = useProfile("publisher");
    expect(result).toContain("Active profile: publisher");
    expect(result).toContain("GAAA");
    expect(result).toContain("Publisher registered: yes");
  });

  it("use_profile rejects invalid names with a deterministic message", () => {
    expect(() => useProfile("has space")).toThrow("Invalid profile name");
    expect(() => useProfile("")).toThrow("Invalid profile name");
  });

  it("switches the active profile and re-verifies the selected network", () => {
    try {
      const result = JSON.parse(switchNetworkProfile("mainnet", "mainnet"));
      expect(result.profile).toBe("mainnet");
      expect(result.network).toBe("mainnet");
      expect(result.verification.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "STELLAR_NETWORK", ok: true })]),
      );
      expect(listProfiles()).toContain("mainnet");
    } finally {
      switchNetworkProfile("testnet", "testnet");
    }
  });

  it("keeps wallets isolated per profile", () => {
    useProfile("buyer");
    _setAgentWallet(walletA);
    useProfile("publisher");
    _setAgentWallet(walletB);

    const list = listProfiles();
    expect(list).toContain("buyer — GAAA");
    expect(list).toContain("publisher — GBBB");
    // The active profile is marked and its wallet is the one just set.
    expect(list).toMatch(/\*\s*publisher — GBBB/);
  });

  it("list_profiles reports an empty state before any profile exists", () => {
    expect(listProfiles()).toContain("No profiles yet");
  });

  it("list_profiles never exposes secret keys", () => {
    useProfile("publisher");
    _setAgentWallet(walletA);
    expect(listProfiles()).not.toContain("SAAA");
  });

  it("wallet_info shows the active profile and registration state", async () => {
    useProfile("mainnet");
    _setAgentWallet(walletA);
    _setAgentApiKey("key-a");
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        mockResponse({
          subentry_count: 2,
          balances: [
            { asset_type: "native", balance: "100.0000000" },
            { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "12.5" },
          ],
        }),
      ),
    );

    const result = await walletInfo();
    expect(result).toContain("Profile: mainnet");
    expect(result).toContain("Address: GAAA");
    expect(result).toContain("XLM Balance: 100.0000000");
    expect(result).toContain("XLM Reserved: 1.5"); // 0.5 base + 2 * 0.5
    expect(result).toContain("XLM Available: 98.5000000");
    expect(result).toContain("USDC Balance: 12.5");
    expect(result).toContain("USDC Status: funded");
    expect(result).toContain("Publisher registered: yes");
  });
});

describe("wallet_info balance details", () => {
  beforeEach(() => {
    _resetProfiles();
    _setAgentWallet(testWallet);
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("distinguishes missing account (404 from Horizon)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}, false, 404));

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 0");
    expect(result).toContain("USDC Balance: 0");
    expect(result).toContain("USDC Status: missing");
    expect(result).toContain("Note: Account");
    expect(result).toContain("does not exist");
  });

  it("distinguishes missing USDC trustline (account exists, no USDC)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: "10.0000000" }],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 10.0000000");
    expect(result).toContain("XLM Reserved: 0.5");
    expect(result).toContain("XLM Available: 9.5000000");
    expect(result).toContain("USDC Balance: 0");
    expect(result).toContain("USDC Status: no-trustline");
    expect(result).toContain("Note: USDC trustline not found");
  });

  it("distinguishes zero USDC balance (trustline exists with 0 balance)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "5.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "0.0000000" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 5.0000000");
    expect(result).toContain("XLM Reserved: 1.0"); // 0.5 base + 1 * 0.5
    expect(result).toContain("XLM Available: 4.0000000");
    expect(result).toContain("USDC Balance: 0.0000000");
    expect(result).toContain("USDC Status: zero");
    expect(result).toContain("Note: USDC balance is zero");
  });

  it("reports funded status when USDC balance is positive", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "50.1234567" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "99.9999999" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Balance: 50.1234567");
    expect(result).toContain("XLM Reserved: 1.0");
    expect(result).toContain("XLM Available: 49.1234567");
    expect(result).toContain("USDC Balance: 99.9999999");
    expect(result).toContain("USDC Status: funded");
    expect(result).not.toContain("Note:");
  });

  it("calculates XLM reserve with multiple subentries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 5, // 5 trustlines/offers/signers
        balances: [
          { asset_type: "native", balance: "20.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "10.0" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Reserved: 3.0"); // 0.5 base + 5 * 0.5
    expect(result).toContain("XLM Available: 17.0000000"); // 20 - 3
  });

  it("reports zero XLM available when balance equals reserve", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "1.0000000" }, // exactly the reserve
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "5.0" },
        ],
      }),
    );

    const result = await walletInfo();
    expect(result).toContain("XLM Reserved: 1.0");
    expect(result).toContain("XLM Available: 0.0000000");
  });

  it("throws on Horizon error (non-404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ error: "bad" }, false, 500));

    await expect(walletInfo()).rejects.toThrow("Horizon error 500");
  });
});

// ── networkProfile (#412) ───────────────────────────────────────────────────

describe("networkProfile", () => {
  it("returns all expected fields in deterministic JSON format", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty("stellarNetwork");
    expect(parsed).toHaveProperty("x402Network");
    expect(parsed).toHaveProperty("sorobanRpcUrl");
    expect(parsed).toHaveProperty("horizonUrl");
    expect(parsed).toHaveProperty("registryContractId");
    expect(parsed).toHaveProperty("usdcContractId");
    expect(parsed).toHaveProperty("warnings");
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it("reports testnet as stellarNetwork in test environment", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    expect(parsed.stellarNetwork).toBe("testnet");
  });

  it("includes expected testnet preset values", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    // Test environment uses testnet presets (from mocked registry-client)
    expect(parsed.sorobanRpcUrl).toBeTruthy();
    expect(parsed.horizonUrl).toBeTruthy();
    expect(parsed.registryContractId).toBeTruthy();
    expect(parsed.usdcContractId).toBeTruthy();
  });

  it("returns empty warnings array when no env overrides present", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    // In default test environment with no custom env vars
    expect(parsed.warnings).toEqual([]);
  });

  it("produces valid JSON that can be parsed", () => {
    const result = networkProfile();
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("formats output with indentation for readability", () => {
    const result = networkProfile();
    // JSON.stringify with null, 2 produces indented output
    expect(result).toContain("\n");
    expect(result).toMatch(/{\s+"stellarNetwork":/);
  });

  it("includes x402Network field with valid network identifier", () => {
    const result = networkProfile();
    const parsed = JSON.parse(result);

    expect(parsed.x402Network).toBeTruthy();
    expect(typeof parsed.x402Network).toBe("string");
  });
});

// ── Tool dispatch argument validation ───────────────────────────────────────

describe("dispatchTool argument validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an unknown tool without touching the network", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(dispatchTool("mindvault_nope", {})).rejects.toThrow(
      "Unknown tool: mindvault_nope",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments before any request is made", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(
      dispatchTool("mindvault_preview", { resourceId: "../etc/passwd" }),
    ).rejects.toThrow("Invalid arguments for mindvault_preview");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an unknown argument name instead of ignoring it", async () => {
    await expect(
      dispatchTool("mindvault_search", { query: "stellar", resourceTyp: "link" }),
    ).rejects.toThrow("resourceTyp is not a recognized argument");
  });

  it("reports a missing required argument by name", async () => {
    await expect(dispatchTool("mindvault_buy", {})).rejects.toThrow("resourceId is required");
  });

  it("passes normalized arguments through to the handler", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(singleResourceMeta));
    await dispatchTool("mindvault_preview", { resourceId: "  res-001  " });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("/resources/res-001/meta"),
      expect.anything(),
    );
  });

  it("rejects limit above the contract cap via dispatchTool", async () => {
    await expect(dispatchTool("mindvault_registry_list", { limit: 50 })).rejects.toThrow(
      "Invalid arguments for mindvault_registry_list",
    );
  });

  it("produces the same error message for the same invalid call", async () => {
    const first = await dispatchTool("mindvault_tx_status", { txHash: "nope" }).catch((e) => e);
    const second = await dispatchTool("mindvault_tx_status", { txHash: "nope" }).catch((e) => e);
    expect(first.message).toBe(second.message);
    expect(first.message).toContain("hexadecimal");
  });
});

describe("verifyAttestation", () => {
  afterEach(() => {
    delete process.env.MINDVAULT_MOCK;
    getAttestationHashMock.mockReset();
  });

  it("reads the registered hash through the registry client", async () => {
    getAttestationHashMock.mockResolvedValue("mock-attestation-1");
    const parsed = JSON.parse(await verifyAttestation("mock1", "mock-attestation-1"));
    expect(parsed.matches).toBe(true);
    expect(getAttestationHashMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "mock1" }),
    );
  });

  it("maps a deployed contract without the getter to a contract error", async () => {
    getAttestationHashMock.mockRejectedValue(
      new Error("The deployed vault-registry contract does not expose get_attestation_hash."),
    );
    const error = await verifyAttestation("mock1", "mock-attestation-1").catch((err) => err);
    expect(error.message).toContain("Category: contract");
    expect(error.message).toContain("mindvault_check_bindings");
  });

  it("reports a matching mock attestation", async () => {
    process.env.MINDVAULT_MOCK = "1";
    const parsed = JSON.parse(await verifyAttestation("mock1", "mock-attestation-1"));
    expect(parsed.matches).toBe(true);
    expect(parsed.verified).toBe(true);
    expect(parsed.registeredAttestationHash).toBe("mock-attestation-1");
  });

  it("reports a mismatch without treating it as a transport failure", async () => {
    process.env.MINDVAULT_MOCK = "1";
    const parsed = JSON.parse(await verifyAttestation("mock1", "different"));
    expect(parsed.matches).toBe(false);
    expect(parsed.verified).toBe(false);
    expect(parsed.summary).toContain("does not match");
  });

  it("reports when no attestation is registered", async () => {
    process.env.MINDVAULT_MOCK = "1";
    const parsed = JSON.parse(await verifyAttestation("mock2", "different"));
    expect(parsed.registeredAttestationHash).toBeNull();
    expect(parsed.matches).toBe(false);
    expect(parsed.summary).toContain("No attestation hash");
  });

  it("dispatches through the MCP tool name", async () => {
    process.env.MINDVAULT_MOCK = "1";
    const result = await dispatchTool("mindvault_verify_attestation", {
      resourceId: "mock1",
      attestationHash: "mock-attestation-1",
    });
    expect(result).toContain('"verified": true');
  });

  it("rejects an attestation hash longer than the contract limit", async () => {
    process.env.MINDVAULT_MOCK = "1";
    await expect(verifyAttestation("mock1", "a".repeat(65))).rejects.toThrow(
      "at most 64 characters",
    );
  });
});

// ── updateMetadata (#398) ───────────────────────────────────────────────────

describe("updateMetadata", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(updateMetadata("res-001", "ipfs://Qm123")).rejects.toThrow("No wallet");
  });

  it("succeeds in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await updateMetadata("res-001", "ipfs://Qm123");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.metadata).toBe("ipfs://Qm123");
      expect(parsed.txHash).toBeTruthy();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("normalizes the metadata pointer (strips trailing slash) in mock mode", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await updateMetadata("res-001", "https://example.com/meta.json/");
      const parsed = JSON.parse(res);
      // Trailing slash must be stripped before the on-chain call.
      expect(parsed.metadata).toBe("https://example.com/meta.json");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

// ── normalizeMetadataPointer (#842) ────────────────────────────────────────

describe("normalizeMetadataPointer", () => {
  it("strips a trailing slash from an HTTP URL path", () => {
    expect(normalizeMetadataPointer("https://example.com/path/")).toBe("https://example.com/path");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeMetadataPointer("https://example.com/path///")).toBe(
      "https://example.com/path",
    );
  });

  it("preserves the root path slash", () => {
    expect(normalizeMetadataPointer("https://example.com/")).toBe("https://example.com/");
  });

  it("lowercases scheme and host", () => {
    expect(normalizeMetadataPointer("HTTPS://Example.COM/path")).toBe("https://example.com/path");
  });

  it("sorts query parameters alphabetically", () => {
    expect(normalizeMetadataPointer("https://example.com/meta?z=1&a=2")).toBe(
      "https://example.com/meta?a=2&z=1",
    );
  });

  it("passes ipfs:// pointers through unchanged", () => {
    const ipfs = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    expect(normalizeMetadataPointer(ipfs)).toBe(ipfs);
  });

  it("passes ar:// pointers through unchanged", () => {
    const ar = "ar://abc123";
    expect(normalizeMetadataPointer(ar)).toBe(ar);
  });

  it("passes sha256: pointers through unchanged", () => {
    const sha = "sha256:abc123def456";
    expect(normalizeMetadataPointer(sha)).toBe(sha);
  });

  it("passes 0x pointers through unchanged", () => {
    const hex = "0xdeadbeef";
    expect(normalizeMetadataPointer(hex)).toBe(hex);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeMetadataPointer("  https://example.com/path/  ")).toBe(
      "https://example.com/path",
    );
  });

  it("returns malformed URLs unchanged (no throw)", () => {
    const bad = "https://not a valid url";
    // URL constructor throws; we return the trimmed input
    expect(() => normalizeMetadataPointer(bad)).not.toThrow();
  });

  it("a URL without a trailing slash is unchanged", () => {
    const clean = "https://example.com/metadata.json";
    expect(normalizeMetadataPointer(clean)).toBe(clean);
  });
});

// ── setPrice (#397) ─────────────────────────────────────────────────────────

describe("setPrice", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(setPrice("res-001", "10.00")).rejects.toThrow("No wallet");
  });

  it("succeeds in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await setPrice("res-001", "10.00");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.price).toBe("10.00");
      expect(parsed.txHash).toBeTruthy();
      // Successful mutations surface a network-correct explorer link (#462).
      expect(parsed.explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${parsed.txHash}`,
      );
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("formats the explorer link for the public network on mainnet (#462)", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    process.env.STELLAR_NETWORK = "mainnet";
    try {
      const parsed = JSON.parse(await setPrice("res-001", "10.00"));
      expect(parsed.explorerUrl).toBe(`https://stellar.expert/explorer/public/tx/${parsed.txHash}`);
    } finally {
      delete process.env.MINDVAULT_MOCK;
      delete process.env.STELLAR_NETWORK;
    }
  });

  it("dispatches through dispatchTool with valid arguments", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_set_price", {
        resourceId: "res-001",
        price: "10.00",
      });
      expect(res).toContain("success");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

// ── transferOwnership (#396) ────────────────────────────────────────────────

describe("transferOwnership", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(
      transferOwnership("res-001", "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH"),
    ).rejects.toThrow("No wallet");
  });

  it("succeeds in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await transferOwnership(
        "res-001",
        "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      );
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.newCreator).toBe("GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH");
      expect(parsed.txHash).toBeTruthy();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("dispatches through dispatchTool with valid arguments", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      });
      expect(res).toContain("success");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

// ── acceptTransfer ──────────────────────────────────────────────────────────

describe("acceptTransfer", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(acceptTransfer("res-001")).rejects.toThrow("No wallet");
  });

  it("succeeds in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await acceptTransfer("res-001");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.txHash).toBeTruthy();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("dispatches through dispatchTool with valid arguments", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_accept_transfer", { resourceId: "res-001" });
      expect(res).toContain("success");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

// ── cancelTransfer ──────────────────────────────────────────────────────────

describe("cancelTransfer", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(cancelTransfer("res-001")).rejects.toThrow("No wallet");
  });

  it("succeeds in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await cancelTransfer("res-001");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.txHash).toBeTruthy();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("dispatches through dispatchTool with valid arguments", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_cancel_transfer", { resourceId: "res-001" });
      expect(res).toContain("success");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

// ── pendingTransfer ─────────────────────────────────────────────────────────

describe("pendingTransfer", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("succeeds in mock mode and returns a found pending transfer", async () => {
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await pendingTransfer("res-001");
      const parsed = JSON.parse(res);
      expect(parsed.source).toBe("on-chain (mock)");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.found).toBe(true);
      expect(typeof parsed.proposedNewOwner).toBe("string");
      expect(parsed.proposedNewOwner).toMatch(/^G[A-Z2-7]{55}$/);
      expect(parsed.message).toContain("res-001");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("dispatches through dispatchTool with valid arguments in mock mode", async () => {
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_pending_transfer", { resourceId: "res-001" });
      const parsed = JSON.parse(res);
      expect(parsed.found).toBe(true);
      expect(parsed.resourceId).toBe("res-001");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("returns consistent output shape with required schema fields", async () => {
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await pendingTransfer("res-001");
      const parsed = JSON.parse(res);
      // Required fields from PENDING_TRANSFER_OUTPUT_SCHEMA
      expect(parsed).toHaveProperty("source");
      expect(parsed).toHaveProperty("resourceId");
      expect(parsed).toHaveProperty("found");
      expect(parsed).toHaveProperty("message");
      expect(parsed).toHaveProperty("contract");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

// ── setListed (#400) ────────────────────────────────────────────────────────

describe("setListed", () => {
  beforeEach(() => {
    _resetProfiles();  });

  it("throws when no wallet is set up", async () => {
    await expect(setListed("res-001", false)).rejects.toThrow("No wallet");
  });

  it("succeeds in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await setListed("res-001", false);
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.listed).toBe(false);
      expect(parsed.txHash).toBeTruthy();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("dispatches through dispatchTool with valid arguments", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_set_listed", {
        resourceId: "res-001",
        listed: true,
      });
      expect(res).toContain("success");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

describe("setTags (#832)", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(setTags("res-001", ["dataset"])).rejects.toThrow("No wallet");
  });

  it("succeeds in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await setTags("res-001", ["dataset", "research"]);
      expect(res).toContain('Tags updated for resource "res-001".');
      expect(res).toContain("Tags: dataset, research");
      expect(res).toContain("MOCK_TX_SET_TAGS_res-001");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("normalizes and deduplicates tags through dispatchTool", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_set_tags", {
        resourceId: "res-001",
        tags: [" Dataset ", "DATASET", "research"],
      });
      expect(res).toContain("Tags: dataset, research");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("allows an empty list to clear tags", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_set_tags", { resourceId: "res-001", tags: [] });
      expect(res).toContain("Tags: (none)");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

describe("API health preflight before mutation tools (#603)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _setAgentWallet(null);
    _setAgentApiKey(null);
    _resetProfiles();
  });

  it("refuses register before touching the network when the API is unreachable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => mockResponse({ error: "down" }, false, 401));

    await expect(
      dispatchTool("mindvault_register", { name: "n", email: "e@example.com" }),
    ).rejects.toThrow("not reachable");

    // Only the preflight GET happened — no POST /publishers.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/resources");
  });

  it("refuses publish when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({ error: "down" }, false, 401),
    );

    await expect(
      dispatchTool("mindvault_publish", {
        title: "t",
        price: "5.00",
        externalUrl: "https://example.com/x",
      }),
    ).rejects.toThrow("mindvault_publish was not attempted");
  });

  it("refuses rotate_key when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({ error: "down" }, false, 401),
    );

    await expect(dispatchTool("mindvault_rotate_publisher_key", {})).rejects.toThrow(
      "not reachable",
    );
  });

  it("lets register proceed past the preflight when the API is healthy", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => mockResponse(sampleResources));

    // Preflight passes; the handler then fails on the missing wallet before
    // issuing any POST — proving the gate is passed, not that the tool ran.
    await expect(
      dispatchTool("mindvault_register", { name: "n", email: "e@example.com" }),
    ).rejects.toThrow("No wallet in profile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the preflight entirely for dry-run publish", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => mockResponse(sampleResources));

    const result = await dispatchTool("mindvault_publish", {
      title: "t",
      price: "5.00",
      externalUrl: "https://example.com/x",
      dryRun: true,
    });
    expect(JSON.parse(result).mode).toBe("dry-run");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── half-completed sponsored-account creation (#839) ────────────────────────

describe("setupWallet – half-completed sponsored creation", () => {
  const sponsored = Keypair.random();
  const other = Keypair.random();

  beforeEach(() => {
    // Earlier suites stub @stellar/stellar-sdk with vi.doMock, which
    // restoreAllMocks does not undo. Key derivation must be the real thing here.
    vi.doUnmock("@stellar/stellar-sdk");
    _resetProfiles();
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("persists a wallet whose secret derives the address it was given", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: sponsored.secret() }),
    );

    const out = await dispatchTool("mindvault_setup_wallet", {});
    expect(out).toContain("Wallet created.");
    expect(out).toContain(`Address: ${sponsored.publicKey()}`);
    expect(out).toContain("persisted");
  });

  it("refuses a funded address that arrives without its secret key", async () => {
    // The shape a creation that funds the account and then times out leaves:
    // the agent would otherwise hold an address it can never sign for.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey() }),
    );

    await expect(dispatchTool("mindvault_setup_wallet", {})).rejects.toThrow(
      /no secret key|cannot sign/i,
    );
  });

  it("refuses a secret key belonging to a different account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: other.secret() }),
    );

    await expect(dispatchTool("mindvault_setup_wallet", {})).rejects.toThrow(/belongs to/i);
  });

  it("explains that nothing was persisted and a funded account may be orphaned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: "" }),
    );

    try {
      await dispatchTool("mindvault_setup_wallet", {});
      throw new Error("expected setup_wallet to reject");
    } catch (err: any) {
      expect(err.message).toContain("Nothing was persisted");
      expect(err.message).toContain("orphaned");
    }
  });

  it("leaves no wallet behind when the response is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: sponsored.publicKey(), secretKey: other.secret() }),
    );

    await expect(dispatchTool("mindvault_setup_wallet", {})).rejects.toThrow();
    // No wallet was stored, so the next tool must report the wallet as missing
    // rather than reporting a balance for an address this agent cannot use.
    await expect(walletInfo()).rejects.toThrow(/mindvault_setup_wallet/);
  });

  it("warns in wallet_info when the stored secret does not own the address", async () => {
    _setAgentWallet({ publicKey: sponsored.publicKey(), secretKey: other.secret() });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        mockResponse({
          subentry_count: 1,
          balances: [
            { asset_type: "native", balance: "10.0000000" },
            { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "25.0" },
          ],
        }),
      ),
    );

    const out = await walletInfo();
    expect(out).toContain("USDC Balance: 25.0");
    expect(out).toContain("Keystore:");
    expect(out).toContain("NOT spendable");
  });

  it("does not warn when the stored keypair is consistent", async () => {
    _setAgentWallet({ publicKey: sponsored.publicKey(), secretKey: sponsored.secret() });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        mockResponse({
          subentry_count: 1,
          balances: [{ asset_type: "native", balance: "10.0000000" }],
        }),
      ),
    );

    expect(await walletInfo()).not.toContain("NOT spendable");
  });
});

// ── state-mutating calls are serialized (#550) ──────────────────────────────

describe("state-mutating calls are serialized (#550)", () => {
  // setupWallet verifies that the secret the service returns derives the
  // address it returns (#839), so these fixtures are real keypairs rather than
  // placeholder strings.
  const sponsored = Keypair.random();
  const SPONSORED_PUBLIC = sponsored.publicKey();
  const SPONSORED_SECRET = sponsored.secret();

  beforeEach(() => {
    vi.doUnmock("@stellar/stellar-sdk");
    _resetProfiles();
  });

  afterEach(() => {
    _resetProfiles();
    vi.restoreAllMocks();
  });

  it("persists the results of two concurrent mutating calls", async () => {
    // Each setupWallet call read-modify-writes the module-level profile state
    // across an `await` boundary (the sponsored-account POST). Serialized under
    // the state mutex, neither may clobber the other's saveState(), so both
    // profiles must survive.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: SPONSORED_PUBLIC, secretKey: SPONSORED_SECRET }),
    );

    const [alice, bob] = await Promise.all([
      dispatchTool("mindvault_setup_wallet", { profile: "alice" }),
      dispatchTool("mindvault_setup_wallet", { profile: "bob" }),
    ]);

    expect(alice).toContain("Wallet created.");
    expect(bob).toContain("Wallet created.");
    expect(alice).toContain(`Address: ${SPONSORED_PUBLIC}`);
    expect(bob).toContain(`Address: ${SPONSORED_PUBLIC}`);

    const list = listProfiles();
    expect(list).toContain(`alice — ${SPONSORED_PUBLIC}`);
    expect(list).toContain(`bob — ${SPONSORED_PUBLIC}`);
  });

  it("keeps a serialized mutating call from losing an earlier profile", async () => {
    // Interleave a quick synchronous mutating call with a slow async one. Both
    // go through the same lock, so the slow wallet setup cannot run its
    // read-modify-write while use_profile is mid-flight and drop its profile.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ publicKey: SPONSORED_PUBLIC, secretKey: SPONSORED_SECRET }),
    );

    const [profile, wallet] = await Promise.all([
      dispatchTool("mindvault_use_profile", { name: "buyer" }),
      dispatchTool("mindvault_setup_wallet", { profile: "bob" }),
    ]);

    expect(profile).toContain("Active profile: buyer");
    expect(wallet).toContain(`Address: ${SPONSORED_PUBLIC}`);

    const list = listProfiles();
    expect(list).toContain("buyer");
    expect(list).toContain(`bob — ${SPONSORED_PUBLIC}`);
  });
});

// ── offline catalog cache fallback (#556) ────────────────────────────────────

describe("offline catalog cache fallback (#556)", () => {
  beforeEach(() => {
    _clearCatalogCache();
    _resetProfiles();
  });

  afterEach(() => {
    _clearCatalogCache();
    _resetProfiles();
    vi.restoreAllMocks();
  });

  const catalogItem = {
    id: "c1",
    title: "Cached One",
    price: "3",
    description: "A cached resource",
    accessUrl: "https://example.com/c1",
  };

  it("browse serves the cached snapshot with an age label when the API is unreachable", async () => {
    recordCatalogSnapshot([catalogItem]);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));

    const out = await browse();
    expect(out).toContain("[c1] Cached One");
    expect(out).toContain("Offline catalog snapshot served");
    expect(out).toContain("cached");
  });

  it("search applies filters to the cached snapshot and labels it when offline", async () => {
    recordCatalogSnapshot([catalogItem]);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const out = await search("Cached");
    expect(out).toContain("[c1] Cached One");
    expect(out).toContain("Offline catalog snapshot served");

    const empty = await search("no-match-whatsoever");
    expect(empty).toContain("No resources match");
  });

  it("preview serves the cached meta with an age label when unreachable", async () => {
    recordPreviewSnapshot("res-9", {
      id: "res-9",
      title: "Cached Preview",
      price: "4",
      description: "D",
      resourceType: "article",
      verificationStatus: "verified",
      accessUrl: "https://example.com/9",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const parsed = JSON.parse(await preview("res-9"));
    expect(parsed.title).toBe("Cached Preview");
    expect(parsed.offlineCache).toContain("Offline catalog snapshot served");
  });

  it("serves the snapshot for a gateway error the retry layer could not ride out", async () => {
    // 502/503/504 mean the catalog could not answer — exactly what the offline
    // snapshot is for. The label names the status rather than claiming the API
    // was unreachable (#837).
    recordCatalogSnapshot([catalogItem]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "bad gateway" }, false, 502),
    );

    const out = await browse();
    expect(out).toContain("[c1] Cached One");
    expect(out).toContain("Offline catalog snapshot served");
    expect(out).toContain("HTTP 502");
    expect(out).not.toContain("unreachable");
  });

  it("serves the snapshot when the catalog is rate limited", async () => {
    recordCatalogSnapshot([catalogItem]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "slow down" }, false, 429),
    );

    const out = await browse();
    expect(out).toContain("[c1] Cached One");
    expect(out).toContain("HTTP 429");
  });

  it("surfaces a client error instead of hiding it behind the cache", async () => {
    // A 400 is the catalog answering about this request. Serving a snapshot
    // would tell the agent the API is unreachable and leave it repeating an
    // invalid call against data that can never reflect it (#837).
    recordCatalogSnapshot([catalogItem]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "minPrice must be numeric" }, false, 400),
    );

    await expect(browse()).rejects.toThrow(/minPrice must be numeric/);
  });

  it("surfaces an auth error rather than serving the cache", async () => {
    recordCatalogSnapshot([catalogItem]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "forbidden" }, false, 403),
    );

    await expect(search("Cached")).rejects.toThrow(/forbidden/);
  });

  it("surfaces a 404 on preview instead of returning another resource's snapshot", async () => {
    recordPreviewSnapshot("res-9", { id: "res-9", title: "Cached Preview", price: "4" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "not found" }, false, 404),
    );

    await expect(preview("res-9")).rejects.toThrow(/not found/);
  });

  it("serves the cached preview when the catalog answers 503", async () => {
    recordPreviewSnapshot("res-9", {
      id: "res-9",
      title: "Cached Preview",
      price: "4",
      description: "D",
      resourceType: "article",
      verificationStatus: "verified",
      accessUrl: "https://example.com/9",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "unavailable" }, false, 503),
    );

    const parsed = JSON.parse(await preview("res-9"));
    expect(parsed.title).toBe("Cached Preview");
    expect(parsed.offlineCache).toContain("HTTP 503");
  });

  it("rethrows the deterministic reachability error when there is no cache", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));
    await expect(browse()).rejects.toThrow();
    await expect(preview("res-9")).rejects.toThrow();
  });

  it("a mutating tool never falls back to the cached catalog", async () => {
    // Prime the cache as if a successful read had happened earlier.
    recordCatalogSnapshot([catalogItem]);
    _setAgentWallet(testWallet);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    // register must surface the network failure — not silently serve stale data.
    await expect(
      dispatchTool("mindvault_register", { name: "N", email: "e@example.com" }),
    ).rejects.toThrow();
  });
});

// ── disputeResource (#869) ──────────────────────────────────────────────────

describe("disputeResource", () => {
  beforeEach(() => {
    _resetProfiles();
  });

  it("throws when no wallet is set up", async () => {
    await expect(disputeResource("res-001", "flag", "Spam")).rejects.toThrow("No wallet");
  });

  it("succeeds (flag) in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await disputeResource("res-001", "flag", "Duplicate listing");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.resourceId).toBe("res-001");
      expect(parsed.action).toBe("flag");
      expect(parsed.reason).toBe("Duplicate listing");
      expect(parsed.txHash).toMatch(/MOCK_TX_DISPUTE_FLAG/);
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("succeeds (unflag) in mock mode when wallet is present", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await disputeResource("res-001", "unflag", "Issue resolved");
      const parsed = JSON.parse(res);
      expect(parsed.status).toBe("success");
      expect(parsed.action).toBe("unflag");
      expect(parsed.txHash).toMatch(/MOCK_TX_DISPUTE_UNFLAG/);
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("dispatches through dispatchTool with valid arguments", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      const res = await dispatchTool("mindvault_dispute", {
        resourceId: "res-001",
        action: "flag",
        reason: "Test flag",
      });
      expect(res).toContain("success");
      expect(res).toContain("flag");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("rejects an invalid action value", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      await expect(
        dispatchTool("mindvault_dispute", {
          resourceId: "res-001",
          action: "delete",
          reason: "bad",
        }),
      ).rejects.toThrow();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("rejects a missing reason", async () => {
    _setAgentWallet({
      publicKey: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      secretKey: "SD1234567890123456789012345678901234567890123456789012345",
    });
    process.env.MINDVAULT_MOCK = "1";
    try {
      await expect(
        dispatchTool("mindvault_dispute", { resourceId: "res-001", action: "flag" }),
      ).rejects.toThrow();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});
