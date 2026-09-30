import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  catalogResourceUri,
  catalogResourceContents,
  parseCatalogResourceUri,
  toCatalogResource,
  listCatalogResources,
  readCatalogResource,
} from "./catalogResources.js";

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
  // Gated/private fields that must never surface through resources/read:
  content: "PAID CONTENT — secret payload",
  contentUrl: "https://paywall.example.com/secret",
  ownerWallet: "GPRIVATEWALLET",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("catalogResourceUri / parseCatalogResourceUri", () => {
  it("builds a stable mindvault://resource/<id> URI", () => {
    expect(catalogResourceUri("res-001")).toBe("mindvault://resource/res-001");
    expect(catalogResourceUri("cm7x8y9z")).toBe("mindvault://resource/cm7x8y9z");
  });

  it("round-trips a valid URI back to its resource id", () => {
    const parsed = parseCatalogResourceUri("mindvault://resource/res-001");
    expect(parsed).toEqual({ ok: true, resourceId: "res-001" });
  });

  it("rejects a non-string URI deterministically", () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const parsed = parseCatalogResourceUri(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/non-empty string/);
    }
  });

  it("rejects an empty or whitespace-only URI", () => {
    for (const bad of ["", "   "]) {
      const parsed = parseCatalogResourceUri(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/non-empty string/);
    }
  });

  it("rejects URIs with the wrong scheme or host", () => {
    for (const bad of [
      "https://example.com/resource/res-001",
      "mindvault://other/res-001",
      "mindvault://resource",
      "not-a-uri",
      "mindvault://resource/",
    ]) {
      const parsed = parseCatalogResourceUri(bad);
      expect(parsed.ok).toBe(false, `expected ${JSON.stringify(bad)} to be rejected`);
      if (!parsed.ok) {
        expect(parsed.reason).toMatch(/resource URI/i);
      }
    }
  });

  it("mentions the expected URI shape in the rejection reason", () => {
    const parsed = parseCatalogResourceUri("https://example.com/x");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("mindvault://resource/");
  });
});

describe("toCatalogResource", () => {
  it("maps a catalog entry to a resource with a stable URI and title", () => {
    const resource = toCatalogResource(sampleResources[0]);
    expect(resource.uri).toBe("mindvault://resource/res-001");
    expect(resource.name).toBe("Introduction to Stellar");
    expect(resource.description).toBe("A beginner's guide to Stellar blockchain");
    expect(resource.mimeType).toBe("application/json");
  });

  it("falls back to the id when the title is missing", () => {
    const resource = toCatalogResource({ id: "res-003" });
    expect(resource.name).toBe("res-003");
    expect(resource.description).toBeUndefined();
  });

  it("handles entries without any string fields", () => {
    const resource = toCatalogResource({ id: 7, title: 42 });
    expect(resource.uri).toBe("mindvault://resource/7");
    expect(resource.name).toBe("7");
  });
});

describe("catalogResourceContents", () => {
  it("exposes only public metadata — never gated content", () => {
    const contents = catalogResourceContents(singleResourceMeta, catalogResourceUri("res-001"));
    expect(contents.uri).toBe("mindvault://resource/res-001");
    expect(contents.mimeType).toBe("application/json");

    const parsed = JSON.parse(contents.text);
    expect(parsed).toEqual({
      id: "res-001",
      title: "Introduction to Stellar",
      description: "A beginner's guide to Stellar blockchain",
      price: "$5.00 USDC",
      resourceType: "link",
      verificationStatus: "verified",
      accessUrl: "https://example.com/stellar-intro",
    });
    // Gated/private fields must never appear in the read payload.
    expect(contents.text).not.toContain("PAID CONTENT");
    expect(contents.text).not.toContain("contentUrl");
    expect(contents.text).not.toContain("ownerWallet");
    expect(Object.keys(parsed)).toHaveLength(7);
  });
});

describe("listCatalogResources", () => {
  it("returns every catalog entry mapped to a stable URI", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(sampleResources));
    const resources = await listCatalogResources();
    expect(resources).toHaveLength(2);
    expect(resources[0].uri).toBe("mindvault://resource/res-001");
    expect(resources[0].name).toBe("Introduction to Stellar");
    expect(resources[1].uri).toBe("mindvault://resource/res-002");
    expect(resources[1].name).toBe("Advanced Soroban");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/resources"),
      expect.anything(),
    );
  });

  it("returns an empty list for an empty catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse([]));
    await expect(listCatalogResources()).resolves.toEqual([]);
  });

  it("throws a mapped error on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "Internal server error" }, false, 500),
    );
    await expect(listCatalogResources()).rejects.toThrow("List catalog resources failed");
  });

  it("throws deterministically on a transport failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));
    await expect(listCatalogResources()).rejects.toThrow();
  });
});

describe("readCatalogResource", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(singleResourceMeta));
  });

  it("returns public metadata for a valid URI", async () => {
    const contents = await readCatalogResource("mindvault://resource/res-001");
    expect(contents.uri).toBe("mindvault://resource/res-001");
    const parsed = JSON.parse(contents.text);
    expect(parsed.id).toBe("res-001");
    expect(parsed.title).toBe("Introduction to Stellar");
    expect(parsed.price).toBe("$5.00 USDC");
    expect(parsed).not.toHaveProperty("content");
  });

  it("fetches the public meta endpoint, never the paid access endpoint", async () => {
    await readCatalogResource("mindvault://resource/res-001");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/resources/res-001/meta"),
      expect.anything(),
    );
  });

  it("throws a deterministic invalid-params error for an unknown URI", async () => {
    for (const bad of ["https://example.com/resource/x", "mindvault://other/x", 42]) {
      await expect(readCatalogResource(bad)).rejects.toThrow(McpError);
    }
    try {
      await readCatalogResource("https://example.com/resource/x");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain("mindvault://resource/");
    }
  });

  it("throws a deterministic not-found error for a missing resource", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "not found" }, false, 404),
    );
    try {
      await readCatalogResource("mindvault://resource/missing");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain('Resource "missing" not found');
    }
  });

  it("throws a mapped error on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ error: "Internal server error" }, false, 500),
    );
    await expect(readCatalogResource("mindvault://resource/res-001")).rejects.toThrow(
      "Read catalog resource failed",
    );
  });

  it("throws deterministically on a transport failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED: Connection refused"));
    await expect(readCatalogResource("mindvault://resource/res-001")).rejects.toThrow();
  });
});
