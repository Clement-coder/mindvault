/**
 * Tests for the mindvault_batch_catalog_lookup tool (#608).
 *
 * Bootstrap follows index.test.ts rather than the MINDVAULT_MOCK harness:
 * catalog reads go through `globalThis.fetch`, which is replaced per test, so
 * the real transport path — argument validation, dedup, per-id misses, and
 * the offline snapshot fallback (#556 semantics) — is exercised without a
 * network.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate state persistence from the developer machine and pin the network
// preset before index.js loads (same as the other tool tests).
process.env.STELLAR_NETWORK = "testnet";
const harnessHome = mkdtempSync(join(tmpdir(), "mindvault-mcp-batch-"));
process.env.HOME = harnessHome;
process.env.USERPROFILE = harnessHome;

const { server } = await import("./index.js");
const { _clearCatalogCache, recordPreviewSnapshot } = await import("./catalogCache.js");
const { startIntegrationHarness, type IntegrationHarness } = await import(
  "./integrationHarness.js"
);

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

interface BatchItem {
  id: string;
  found: boolean;
  title: string | null;
  price: string | number | null;
  verificationStatus: string | null;
  resourceType: string | null;
  accessUrl: string | null;
}

interface BatchStructured {
  items: BatchItem[];
  requested: number;
  foundCount: number;
  missing: string[];
  notice: string | null;
  truncated: boolean;
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
}

async function callBatchStructured(
  harness: IntegrationHarness,
  resourceIds: string[] | string,
  refetch = false,
): Promise<BatchStructured> {
  const args: Record<string, unknown> = { resourceIds };
  if (refetch) args.refetch = true;
  const result = await harness.callTool("mindvault_batch_catalog_lookup", args);
  expect(result.isError).toBeUndefined();
  const structured = result.structuredContent as BatchStructured | undefined;
  expect(structured).toBeDefined();
  return structured as BatchStructured;
}

const CATALOG_ITEM = {
  id: "res-001",
  title: "Introduction to Stellar",
  description: "A beginner's guide to Stellar blockchain",
  price: "5.00",
  resourceType: "link",
  verificationStatus: "verified",
  accessUrl: "https://example.com/res-001",
};

describe("mindvault_batch_catalog_lookup", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    await harness?.close();
    rmSync(harnessHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    _clearCatalogCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _clearCatalogCache();
  });

  it("is advertised with a read-only annotation and an output schema", async () => {
    const { tools } = await harness.listTools();
    const tool = tools.find((t) => t.name === "mindvault_batch_catalog_lookup") as {
      annotations?: { readOnlyHint?: boolean };
      outputSchema?: unknown;
    };
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  });

  describe("happy path", () => {
    beforeEach(() => {
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = String(input);
        const id = url.split("/resources/")[1]?.split("/")[0];
        return Promise.resolve(mockResponse({ ...CATALOG_ITEM, id }));
      });
    });

    it("resolves every id in one call", async () => {
      const out = await callBatchStructured(harness, ["res-001", "res-002"]);
      expect(out.requested).toBe(2);
      expect(out.foundCount).toBe(2);
      expect(out.missing).toEqual([]);
      expect(out.items.map((i) => i.id)).toEqual(["res-001", "res-002"]);
      for (const item of out.items) {
        expect(item.found).toBe(true);
        expect(item.title).toBeTruthy();
        expect(item.accessUrl).toBeTruthy();
      }
      expect(out.notice).toBeNull();
      expect(out.truncated).toBe(false);
    });

    it("deduplicates ids and counts them once", async () => {
      const out = await callBatchStructured(harness, ["res-001", "res-001", "res-002"]);
      expect(out.requested).toBe(2);
      expect(out.items.map((i) => i.id)).toEqual(["res-001", "res-002"]);
    });

    it("accepts a comma-separated resourceIds string through validation", async () => {
      const out = await callBatchStructured(harness, "res-001, res-002");
      expect(out.requested).toBe(2);
      expect(out.foundCount).toBe(2);
    });

    it("returns a readable text block alongside the structured payload", async () => {
      const result = await harness.callTool("mindvault_batch_catalog_lookup", {
        resourceIds: ["res-001"],
      });
      expect(result.isError).toBeUndefined();
      const text = resultText(result);
      expect(text).toContain("[res-001]");
      expect(text).toContain("USDC");
    });
  });

  describe("misses", () => {
    beforeEach(() => {
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = String(input);
        const id = url.split("/resources/")[1]?.split("/")[0];
        if (id === "res-001") return Promise.resolve(mockResponse({ ...CATALOG_ITEM, id }));
        return Promise.resolve(mockResponse({ error: "not found" }, false, 404));
      });
    });

    it("reports an unknown id as a miss, not an error", async () => {
      const out = await callBatchStructured(harness, ["res-001", "missing-id"]);
      expect(out.foundCount).toBe(1);
      expect(out.missing).toEqual(["missing-id"]);
      const miss = out.items.find((i) => i.id === "missing-id");
      expect(miss?.found).toBe(false);
      expect(miss?.title).toBeNull();
      const hit = out.items.find((i) => i.id === "res-001");
      expect(hit?.found).toBe(true);
      // A live-answered batch carries no staleness notice even with a miss.
      expect(out.notice).toBeNull();
    });

    it("serves an id's last snapshot when its read fails while the API is up", async () => {
      recordPreviewSnapshot("stale-id", { ...CATALOG_ITEM, id: "stale-id", title: "Cached One" });
      const out = await callBatchStructured(harness, ["res-001", "stale-id"]);
      expect(out.foundCount).toBe(2);
      const cached = out.items.find((i) => i.id === "stale-id");
      expect(cached?.found).toBe(true);
      expect(cached?.title).toBe("Cached One");
      // The notice names exactly the ids served from cache, not the batch.
      expect(out.notice).toContain("Offline catalog snapshot served");
      expect(out.notice).toContain("stale-id");
    });
  });

  it("rejects more than the advertised batch ceiling", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(mockResponse(CATALOG_ITEM)),
    );
    const ids = Array.from({ length: 26 }, (_, i) => `res-${i}`);
    const result = await harness.callTool("mindvault_batch_catalog_lookup", { resourceIds: ids });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/at most 25/);
  });

  it("rejects an empty id list", async () => {
    const result = await harness.callTool("mindvault_batch_catalog_lookup", { resourceIds: [] });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/at least 1/);
  });

  it("rejects entries that are not resource ids", async () => {
    const result = await harness.callTool("mindvault_batch_catalog_lookup", {
      resourceIds: ["res-001", "not ok!"],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/resourceIds\[2\]/);
  });

  describe("offline fallback", () => {
    const cachedItem = {
      id: "cached-1",
      title: "Cached Resource",
      price: "2.00",
      description: "From the last snapshot",
      resourceType: "link",
      verificationStatus: "verified",
      accessUrl: "https://example.com/cached-1",
    };

    beforeEach(() => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    });

    it("serves labelled cached snapshots when the API is unreachable", async () => {
      recordPreviewSnapshot("cached-1", cachedItem);
      const out = await callBatchStructured(harness, ["cached-1"]);
      expect(out.foundCount).toBe(1);
      expect(out.items[0].title).toBe("Cached Resource");
      expect(out.notice).toContain("Offline catalog snapshot served");
    });

    it("mixes misses with cached hits instead of failing the batch", async () => {
      recordPreviewSnapshot("cached-1", cachedItem);
      const out = await callBatchStructured(harness, ["cached-1", "never-cached-id"]);
      expect(out.foundCount).toBe(1);
      expect(out.missing).toEqual(["never-cached-id"]);
      expect(out.notice).toContain("Offline catalog snapshot served");
    });

    it("fails with a classified error when offline with no snapshot at all", async () => {
      const result = await harness.callTool("mindvault_batch_catalog_lookup", {
        resourceIds: ["never-cached-id"],
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/Batch lookup failed/i);
    });

    it("refetch: true refuses to serve cache when the API is down", async () => {
      recordPreviewSnapshot("cached-1", cachedItem);
      const result = await harness.callTool("mindvault_batch_catalog_lookup", {
        resourceIds: ["cached-1"],
        refetch: true,
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/MindVault API request failed/i);
    });
  });
});
