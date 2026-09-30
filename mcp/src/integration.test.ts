/**
 * Integration tests for the MindVault MCP server surface.
 *
 * These go through the SDK Client request interface (listTools / callTool) via
 * the in-memory harness — not the exported helper functions exercised by
 * index.test.ts. Mock mode supplies deterministic fetch + registry fixtures.
 *
 * See docs/mcp-integration-harness.md for the error-handling contract.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  harnessIsToolError,
  harnessResultText,
  harnessStructuredContent,
  startIntegrationHarness,
  type IntegrationHarness,
} from "./integrationHarness.js";

// Activate mock fixtures and isolate state before the server module loads.
process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const harnessHome = mkdtempSync(join(tmpdir(), "mindvault-mcp-integration-"));
process.env.HOME = harnessHome;
process.env.USERPROFILE = harnessHome;

const { server, _resetProfiles } = await import("./index.js");

describe("MCP integration harness", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    await harness?.close();
    rmSync(harnessHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetProfiles();
  });

  it("lists tools through the SDK request interface", async () => {
    const { tools } = await harness.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toContain("mindvault_browse");
    expect(names).toContain("mindvault_search");
    expect(names).toContain("mindvault_preview");
    expect(names).toContain("mindvault_registry_info");
    expect(names).toContain("mindvault_registry_lookup");
    expect(names).toContain("mindvault_registry_list");
    expect(names).toContain("mindvault_registry_count");
    expect(names).toContain("mindvault_setup_wallet");
    expect(names).toContain("mindvault_set_tags");

    expect(names.length).toBeGreaterThanOrEqual(15);

    for (const tool of tools) {
      expect(tool.name).toMatch(/^mindvault_/);
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
    }
  });

  it("advertises MCP annotations for every tool (#552)", async () => {
    const { tools } = await harness.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const annotations = (tool as { annotations?: Record<string, unknown> }).annotations;
      expect(annotations, `tool ${tool.name} advertises annotations`).toBeDefined();
      expect(typeof annotations?.title, `tool ${tool.name} has an annotations title`).toBe(
        "string",
      );
      expect(typeof annotations?.readOnlyHint).toBe("boolean");
      expect(typeof annotations?.destructiveHint).toBe("boolean");
      expect(typeof annotations?.idempotentHint).toBe("boolean");
    }
    const readOnly = (tools as Array<{ annotations: { readOnlyHint: boolean } }>).filter(
      (t) => t.annotations.readOnlyHint === true,
    );
    expect(readOnly.length).toBeGreaterThan(0);
    for (const tool of readOnly) {
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it("advertises the resources capability and lists catalog entries with stable URIs (#545)", async () => {
    const capabilities = harness.client.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();

    const { resources } = await harness.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("mindvault://resource/mock-1");
    expect(uris).toContain("mindvault://resource/mock-2");

    const mock1 = resources.find((r) => r.uri === "mindvault://resource/mock-1");
    expect(mock1?.name).toContain("Stellar");
    expect(mock1?.mimeType).toBe("application/json");
  });

  it("reads public metadata for a known resource URI (#545)", async () => {
    const { contents } = await harness.readResource("mindvault://resource/mock-1");
    expect(contents).toHaveLength(1);
    const parsed = JSON.parse(contents[0].text ?? "");
    expect(parsed.id).toBe("mock-1");
    expect(parsed.title).toContain("Stellar");
    expect(parsed.price).toMatch(/USDC/);
    // Only public metadata — on-chain sync fields from the meta endpoint are
    // never exposed through resources/read.
    expect(contents[0].text).not.toContain("onchainStatus");
    expect(contents[0].text).not.toContain("contentHash");
  });

  it("returns deterministic errors for unknown resource URIs (#545)", async () => {
    // Wrong scheme/host is rejected before any network call.
    await expect(harness.readResource("https://example.com/not-a-resource")).rejects.toThrow(
      /resource URI/i,
    );
    // A well-formed URI for an id the catalog does not know is a not-found error.
    await expect(harness.readResource("mindvault://resource/does-not-exist")).rejects.toThrow(
      /not found/i,
    );
  });

  it("calls mindvault_browse with mocked catalog fixtures", async () => {
    const result = await harness.callTool("mindvault_browse");
    expect(harnessIsToolError(result)).toBe(false);
    const text = harnessResultText(result);
    expect(text).toContain("mock-1");
    expect(text).toContain("Intro to Stellar");
    expect(text).toContain("mock-2");
  });

  it("calls mindvault_search and mindvault_preview with mocked fetch", async () => {
    const search = await harness.callTool("mindvault_search", { query: "Stellar" });
    expect(harnessIsToolError(search)).toBe(false);
    expect(harnessResultText(search)).toContain("mock-1");

    const preview = await harness.callTool("mindvault_preview", { resourceId: "mock-1" });
    expect(harnessIsToolError(preview)).toBe(false);
    const previewText = harnessResultText(preview);
    expect(previewText).toContain("mock-1");
    expect(previewText).toMatch(/1\.5|1\.50/);
  });

  it("calls mindvault_registry_lookup with mocked registry dependency", async () => {
    const hit = await harness.callTool("mindvault_registry_lookup", { resourceId: "mock-1" });
    expect(harnessIsToolError(hit)).toBe(false);
    const hitText = harnessResultText(hit);
    expect(hitText).toContain('"found": true');
    expect(hitText).toContain("on-chain (mock)");

    const miss = await harness.callTool("mindvault_registry_lookup", {
      resourceId: "does-not-exist",
    });
    expect(harnessIsToolError(miss)).toBe(false);
    expect(harnessResultText(miss)).toContain('"found": false');
  });

  it("calls mindvault_registry_list with mocked on-chain pagination", async () => {
    const page = await harness.callTool("mindvault_registry_list", { start: 0, limit: 20 });
    expect(harnessIsToolError(page)).toBe(false);
    const text = harnessResultText(page);
    expect(text).toContain("mock-1");
    expect(text).toContain("mock-2");
    expect(text).toContain('"count": 2');

    const empty = await harness.callTool("mindvault_registry_list", { start: 99, limit: 20 });
    expect(harnessIsToolError(empty)).toBe(false);
    expect(harnessResultText(empty)).toContain('"count": 0');
    expect(harnessResultText(empty)).toMatch(/No on-chain resources in range/);
  });

  it("calls mindvault_registry_count and returns global counts", async () => {
    const result = await harness.callTool("mindvault_registry_count", {});
    expect(harnessIsToolError(result)).toBe(false);
    const text = harnessResultText(result);
    const data = JSON.parse(text);
    expect(data.source).toBe("on-chain (mock)");
    // MOCK_REGISTRY_RESOURCES has 2 entries, both listed
    expect(data.count).toBe(2);
    expect(data.listedCount).toBe(2);
    expect(data.creatorCount).toBeUndefined();
    expect(data.creator).toBeUndefined();
  });

  it("calls mindvault_registry_count with a creator and returns creatorCount", async () => {
    const result = await harness.callTool("mindvault_registry_count", {
      creator: "GMOCKCREATOR1",
    });
    expect(harnessIsToolError(result)).toBe(false);
    const data = JSON.parse(harnessResultText(result));
    expect(data.creator).toBe("GMOCKCREATOR1");
    expect(typeof data.creatorCount).toBe("number");
  });

  it("calls mindvault_recover_catalog_cache and returns guidance", async () => {
    const result = await harness.callTool("mindvault_recover_catalog_cache");
    expect(harnessIsToolError(result)).toBe(false);
    const text = harnessResultText(result);
    expect(text.toLowerCase()).toContain("catalog");
    expect(text.toLowerCase()).toContain("recover");
  });

  it("browses the catalog sorted by price through callTool", async () => {
    const sorted = await harness.callTool("mindvault_browse", { sort: "price_asc", limit: 10 });
    expect(harnessIsToolError(sorted)).toBe(false);
    const text = harnessResultText(sorted);
    // mock-2 is $0.5 and mock-1 is $1.5, so ascending price puts mock-2 first.
    expect(text.indexOf("mock-2")).toBeLessThan(text.indexOf("mock-1"));

    const descending = await harness.callTool("mindvault_browse", { sort: "price_desc" });
    const descendingText = harnessResultText(descending);
    expect(descendingText.indexOf("mock-1")).toBeLessThan(descendingText.indexOf("mock-2"));
  });

  it("rejects a sort value the catalog does not support", async () => {
    const result = await harness.callTool("mindvault_browse", { sort: "cheapest" });
    expect(harnessResultText(result)).toContain("newest, price_asc, price_desc, title");
  });

  it("exports receipts as a structured document with an advertised schema", async () => {
    const { tools } = await harness.listTools();
    const exportTool = tools.find((t) => t.name === "mindvault_export_receipts");
    expect(exportTool).toBeDefined();
    expect((exportTool as { outputSchema?: unknown }).outputSchema).toBeDefined();

    const result = await harness.callTool("mindvault_export_receipts", { format: "csv" });
    expect(harnessIsToolError(result)).toBe(false);
    const parsed = JSON.parse(harnessResultText(result));
    expect(parsed.schema).toBe("mindvault.receipt-export/v1");
    expect(parsed.currency).toBe("USDC");
    expect(typeof parsed.csv).toBe("string");
    expect(parsed.csv.split("\r\n")[0]).toContain("resourceId,title,amount");
    expect(harnessStructuredContent(result)).toEqual(parsed);
  });

  it("exports a sanitized debug bundle with an advertised schema (#675)", async () => {
    const { tools } = await harness.listTools();
    const bundleTool = tools.find((t) => t.name === "mindvault_debug_bundle");
    expect(bundleTool).toBeDefined();
    expect((bundleTool as { outputSchema?: unknown }).outputSchema).toBeDefined();

    const result = await harness.callTool("mindvault_debug_bundle", { auditLogLines: 5 });
    expect(harnessIsToolError(result)).toBe(false);
    const text = harnessResultText(result);
    const parsed = JSON.parse(text);
    expect(parsed.schema).toBe("mindvault.debug-bundle/v1");
    expect(parsed.runtime.mockMode).toBe(true);
    expect(parsed.config.stellarNetwork).toBe("testnet");
    expect(parsed.auditLog.requested).toBe(5);
    expect(Array.isArray(parsed.sanitized.rules)).toBe(true);
    // Nothing shaped like a Stellar secret key, whatever the server had loaded.
    expect(text).not.toMatch(/S[A-Z2-7]{55}/);
    expect(harnessStructuredContent(result)).toEqual(parsed);
  });

  it("returns structuredContent alongside preview and registry lookup text (#553)", async () => {
    const preview = await harness.callTool("mindvault_preview", { resourceId: "mock-1" });
    expect(harnessIsToolError(preview)).toBe(false);
    const previewText = harnessResultText(preview);
    expect(previewText).toContain("mock-1");
    const previewData = harnessStructuredContent(preview);
    expect(previewData?.id).toBe("mock-1");
    expect(previewData).toHaveProperty("price");
    expect(JSON.parse(previewText)).toEqual(previewData);

    const hit = await harness.callTool("mindvault_registry_lookup", { resourceId: "mock-1" });
    expect(harnessIsToolError(hit)).toBe(false);
    const hitData = harnessStructuredContent(hit);
    expect(hitData?.found).toBe(true);
    expect(hitData).toHaveProperty("id");
  });

  it("keeps browse and wallet text unchanged while attaching a sidecar (#553)", async () => {
    const browse = await harness.callTool("mindvault_browse");
    expect(harnessIsToolError(browse)).toBe(false);
    const browseText = harnessResultText(browse);
    expect(browseText).toContain("mock-1");
    expect(browseText).toMatch(/\[mock-1]/);
    const browseData = harnessStructuredContent(browse);
    expect(Array.isArray(browseData?.items)).toBe(true);
    const first = (browseData?.items as Array<{ id?: string; price?: unknown }>)[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("price");

    const setup = await harness.callTool("mindvault_setup_wallet");
    expect(harnessIsToolError(setup)).toBe(false);
    const setupText = harnessResultText(setup);
    expect(setupText).toContain("Address:");
    expect(setupText).toMatch(/G[A-Z0-9]{55}/);
    const setupData = harnessStructuredContent(setup);
    expect(typeof setupData?.address).toBe("string");
    expect(setupData?.address).toMatch(/G[A-Z0-9]{55}/);
  });

  it("leaves text-only tools without structuredContent or outputSchema (#553)", async () => {
    const { tools } = await harness.listTools();
    const verify = tools.find((t) => t.name === "mindvault_verify_install");
    expect(verify).toBeDefined();
    expect((verify as { outputSchema?: unknown }).outputSchema).toBeUndefined();

    const result = await harness.callTool("mindvault_verify_install");
    expect(harnessIsToolError(result)).toBe(false);
    expect(harnessStructuredContent(result)).toBeUndefined();
    expect(harnessResultText(result).length).toBeGreaterThan(0);
  });

  it("returns deterministic Error: results for unknown tools and missing wallet", async () => {
    const unknown = await harness.callTool("mindvault_not_a_real_tool");
    expect(unknown.isError).toBe(true);
    // The message continues with the list of available tools, so anchor on the
    // name rather than the end of the line.
    expect(harnessResultText(unknown)).toMatch(/^Error: Unknown tool: mindvault_not_a_real_tool\b/);

    const walletInfo = await harness.callTool("mindvault_wallet_info");
    expect(walletInfo.isError).toBe(true);
    const walletText = harnessResultText(walletInfo);
    expect(walletText).toMatch(/^Error:/);
    expect(walletText).toContain("mindvault_setup_wallet");
    expect(walletText).not.toMatch(/S[A-Z0-9]{50,}/); // no secret keys
    expect(unknown).not.toHaveProperty("structuredContent");
    expect(walletInfo).not.toHaveProperty("structuredContent");
  });

  it("sets up a wallet through callTool using the mock sponsored-account route", async () => {
    const setup = await harness.callTool("mindvault_setup_wallet");
    expect(harnessIsToolError(setup)).toBe(false);
    const text = harnessResultText(setup);
    expect(text).toContain("Address:");
    expect(text).toMatch(/G[A-Z0-9]{55}/);
  });
});
