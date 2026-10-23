/**
 * Every structured tool's results against its advertised output schema (#1062).
 *
 * The SDK client validates `structuredContent` — on errors as well as
 * successes — against the `outputSchema` a tool advertises, and throws when it
 * does not match. These tests exercise both halves of every advertised schema
 * with the same validator the client uses:
 *
 *  - success: one payload per tool, produced by the real handler wherever it
 *    can run offline (mock-mode handlers, dry runs, local-state tools) and
 *    otherwise a payload in the shape the handler builds;
 *  - error: the troubleshooting hint a mapped failure carries.
 *
 * They also check how the server reports a handler that breaks its contract:
 * logged by tool name and schema path without the payload, and sent as an
 * `isError` result that still validates.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { debugBundleTool } from "./debugBundle.js";
import {
  DEFAULT_DEPLOYMENT_MANIFESTS,
  buildDeploymentVerificationReport,
} from "./deploymentVerification.js";
import { onchainPreflightTool } from "./onchainPreflight.js";
import { migrationPreviewTool } from "./stateMigrationPreview.js";
import { supportBundleTool } from "./supportBundle.js";
import { dryRunBuy, dryRunOnchain, dryRunPublish } from "./dryRun.js";
import { mapTransportError, troubleshootingHint } from "./errorMapping.js";
import { createMetricsRecorder } from "./metrics.js";
import {
  mockAcceptTransfer,
  mockBuyLease,
  mockCancelTransfer,
  mockLeaseStatus,
  mockPendingTransfer,
  mockPublishBatch,
  mockRegistryCount,
  mockRegistryCreatorPage,
  mockRegistryList,
  mockRegistryLookup,
  mockRegistryTagSearch,
  mockSetListed,
  mockSetPrice,
  mockTransferOwnership,
  mockUpdateMetadata,
  mockVerifyAttestation,
} from "./mock.js";
import {
  TOOL_ERROR_OUTPUT_SCHEMA,
  checkOutput,
  enforceOutputContract,
  outputContractViolation,
  successSchemaOf,
  withToolErrorVariant,
} from "./outputValidation.js";
import { buildPublishStatusSnapshot } from "./publishStatus.js";
import {
  _clearPurchases,
  _setPurchasesFilePath,
  purchaseHistoryTool,
  recordPurchase,
} from "./purchaseHistory.js";
import { exportReceiptsTool } from "./receipts.js";
import { createMindVaultServer } from "./serverFactory.js";
import { normalizeToolResult, type ToolOutcome } from "./toolResult.js";
import { hasOutputSchema } from "./toolSurface.js";
import { TOOL_DEFINITIONS } from "./tools.js";

const CONTRACT = "CMOCKCONTRACT";
const ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TX = "a".repeat(64);
const NETWORK = "stellar:testnet";
const BASE = "http://localhost:3001";

let stateDir: string;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mv-output-contract-"));
  _setPurchasesFilePath(join(stateDir, "purchases.json"));
  _clearPurchases();
  recordPurchase({
    resourceId: "mock-1",
    amount: "1.5",
    network: NETWORK,
    txHash: TX,
    receiptRef: "x402:mock",
  });
});

afterAll(() => {
  _setPurchasesFilePath(null);
  rmSync(stateDir, { recursive: true, force: true });
});

const json = (value: unknown) => JSON.stringify(value);

/**
 * One success outcome per structured tool, as its handler returns it. Each
 * goes through `normalizeToolResult`, exactly as the CallTool handler does.
 */
const SUCCESS_OUTCOMES: Record<string, () => ToolOutcome> = {
  // ── Real handler output ────────────────────────────────────────────────
  mindvault_update_metadata: () => mockUpdateMetadata("mock-1", "ipfs://meta"),
  mindvault_set_price: () => mockSetPrice("mock-1", "2.5"),
  mindvault_transfer_ownership: () => mockTransferOwnership("mock-1", ADDRESS),
  mindvault_accept_transfer: () => mockAcceptTransfer("mock-1"),
  mindvault_cancel_transfer: () => mockCancelTransfer("mock-1"),
  mindvault_pending_transfer: () => mockPendingTransfer("mock-1"),
  mindvault_set_listed: () => mockSetListed("mock-1", false),
  mindvault_publish_batch: () =>
    mockPublishBatch([{ title: "One", price: "1", externalUrl: "https://example.com/1" }]),
  mindvault_registry_lookup: () => mockRegistryLookup("mock-1", CONTRACT, ADDRESS),
  mindvault_registry_list: () => mockRegistryList(0, 10, CONTRACT, ADDRESS),
  mindvault_registry_count: () => mockRegistryCount(undefined, CONTRACT),
  mindvault_registry_creator_page: () =>
    mockRegistryCreatorPage(ADDRESS, undefined, 20, undefined, undefined, CONTRACT),
  mindvault_registry_tag_search: () => mockRegistryTagSearch("dat", 0, 20, CONTRACT),
  mindvault_verify_attestation: () =>
    mockVerifyAttestation("mock1", "mock-attestation-1", CONTRACT),
  mindvault_buy_lease: () => mockBuyLease("mock-1", "day", false),
  mindvault_lease_status: () => mockLeaseStatus("mock-1", ADDRESS),
  mindvault_publish: () =>
    json(
      dryRunPublish(
        { title: "T", price: "1", type: "link", externalUrl: "https://example.com" } as any,
        NETWORK,
        BASE,
        true,
        true,
      ),
    ),
  mindvault_buy: () => json(dryRunBuy("mock-1", NETWORK, BASE, true, "1.5")),
  mindvault_register_onchain: () =>
    json(dryRunOnchain("register_onchain" as any, "mock-1", NETWORK, BASE, true, true)),
  mindvault_purchase_history: () => purchaseHistoryTool({}),
  mindvault_export_receipts: () => exportReceiptsTool({}),
  mindvault_publish_status: () =>
    json(
      buildPublishStatusSnapshot(
        "mock-1",
        {
          meta: { id: "mock-1", title: "T", verificationStatus: "verified", onchainStatus: "none" },
          verification: { status: "verified", verification: { isOriginal: true, confidence: 0.9 } },
        },
        { polled: false, attempts: 1, timedOut: false },
      ),
    ),
  mindvault_metrics: () => json(createMetricsRecorder(true, 1000).snapshot()),
  mindvault_debug_bundle: () => debugBundleTool({}, new Date(0)),
  mindvault_onchain_preflight: () => onchainPreflightTool({}),
  mindvault_verify_deployment: () => {
    const manifest = DEFAULT_DEPLOYMENT_MANIFESTS.testnet!;
    const passphrase = "Test SDF Network ; September 2015";
    return json(
      buildDeploymentVerificationReport({
        configured: {
          network: manifest.network,
          contractId: manifest.contractId,
          rpcUrl: "https://soroban-testnet.stellar.org",
          networkPassphrase: passphrase,
        },
        expected: manifest,
        observed: {
          contractId: manifest.contractId,
          networkPassphrase: passphrase,
          networkId: createHash("sha256").update(passphrase).digest("hex"),
          registryName: "mindvault-vault-registry",
          crateVersion: manifest.crateVersion,
          resourceSchemaVersion: manifest.resourceSchemaVersion,
          wasmHash: manifest.wasmHash,
        },
        mode: "mock",
      }),
    );
  },
  mindvault_migration_preview: () => migrationPreviewTool({}),
  mindvault_support_bundle: () =>
    supportBundleTool({ incidentId: "mv-01hq7x9k2m4p6r8t0v2w4y6a8c", auditLines: 25 }),

  // ── Payloads in the shape the network-backed handlers build ────────────
  mindvault_setup_wallet: () => json({ profile: "default", address: ADDRESS, persisted: true }),
  mindvault_import_wallet: () => json({ profile: "default", address: ADDRESS, persisted: true }),
  mindvault_wallet_info: () =>
    json({
      profile: "default",
      address: ADDRESS,
      xlmBalance: "10.0000000",
      xlmReserve: "1.5000000",
      xlmAvailable: "8.5000000",
      usdcBalance: "5.0000000",
      usdcStatus: "trustline",
      publisherRegistered: false,
      note: null,
    }),
  mindvault_wallet_allowance: () =>
    json({
      profile: "default",
      address: ADDRESS,
      network: NETWORK,
      networkPassphrase: "Test SDF Network ; September 2015",
      asset: {
        code: "USDC",
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        decimals: 7,
      },
      balance: {
        amount: "5.0000000",
        asset: {
          code: "USDC",
          issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          decimals: 7,
        },
        network: NETWORK,
        estimate: false,
        label: "current USDC balance",
        status: "funded",
        source: "horizon",
      },
      estimatedPendingSpend: {
        amount: "1.5000000",
        asset: {
          code: "USDC",
          issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          decimals: 7,
        },
        network: NETWORK,
        estimate: true,
        label: "estimated pending spend",
        count: 1,
        purchases: [
          {
            resourceId: "mock-1",
            amount: "1.5",
            asset: {
              code: "USDC",
              issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
              decimals: 7,
            },
            network: NETWORK,
            timestamp: "1970-01-01T00:00:00.000Z",
            receiptRef: null,
            estimate: true,
            status: "pending",
          },
        ],
      },
      paymentCeiling: {
        amount: "10",
        asset: {
          code: "USDC",
          issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          decimals: 7,
        },
        network: NETWORK,
        estimate: false,
        label: "configured automatic payment ceiling",
        source: "default",
        configured: false,
      },
      estimatedRemainingAllowance: {
        amount: "3.5000000",
        asset: {
          code: "USDC",
          issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          decimals: 7,
        },
        network: NETWORK,
        estimate: true,
        label: "estimated remaining automatic payment allowance",
        basis: "min(configured payment ceiling, balance minus estimated pending spend)",
      },
      notes: ["Pending spend is estimated from local receipts."],
      readOnly: true,
      message: "USDC balance 5 on stellar:testnet.",
    }),
  mindvault_wallet_balances: () =>
    json({
      source: "horizon",
      requestedAt: "1970-01-01T00:00:00.000Z",
      platform: null,
      agents: [
        {
          profile: "default",
          address: ADDRESS,
          active: true,
          publisherRegistered: false,
          xlmBalance: "10.0000000",
          xlmReserve: "1.5000000",
          xlmAvailable: "8.5000000",
          usdcBalance: "5.0000000",
          usdcStatus: "trustline",
          note: null,
        },
      ],
      count: 1,
      statistics: { totalUsdc: "5.0000000", totalXlm: "10.0000000" },
      message: "1 agent wallet checked.",
    }),
  mindvault_server_endpoints: () =>
    json({
      source: "openapi",
      baseUrl: "https://example.com",
      openapi: "3.1.0",
      server: { title: "MindVault API", version: "1.0.0" },
      endpointCount: 1,
      operations: [
        {
          method: "GET",
          path: "/health",
          operationId: "health",
          tags: ["ops"],
          summary: "Liveness probe",
        },
      ],
      paths: ["/health"],
      message: "1 endpoint discovered.",
    }),
  mindvault_use_profile: () =>
    json({ profile: "buyer", address: ADDRESS, publisherRegistered: null }),
  mindvault_list_profiles: () =>
    json({
      active: "default",
      profiles: [{ name: "default", address: ADDRESS, publisherRegistered: false, active: true }],
    }),
  mindvault_export_profiles: () =>
    json({
      schema: "mindvault.profile-export",
      version: 1,
      activeProfile: "default",
      profiles: [{ name: "default", network: "testnet", preferences: {} }],
    }),
  mindvault_import_profiles: () => json({ imported: ["default"] }),
  mindvault_browse: () =>
    json({
      items: [
        {
          id: "mock-1",
          title: "Intro",
          price: "1.5",
          description: null,
          accessUrl: null,
          tags: [],
        },
      ],
      notice: null,
      truncated: false,
    }),
  mindvault_search: () => json({ items: [], notice: null, truncated: false }),
  mindvault_preview: () =>
    json({
      id: "mock-1",
      title: "Intro",
      description: "d",
      price: "1.5 USDC",
      type: "link",
      verificationStatus: "verified",
      accessUrl: null,
    }),
  mindvault_agent_status: () => json({ status: "ok" }),
  mindvault_registry_info: () =>
    json({
      contractId: CONTRACT,
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      network: "testnet",
      x402Network: NETWORK,
      resourceFields: ["id", "creator", "price", "metadata", "listed"],
      mainnetDiagnostics: "not on mainnet",
    }),
  mindvault_network_profile: () =>
    json({
      stellarNetwork: "testnet",
      x402Network: NETWORK,
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      registryContractId: CONTRACT,
      usdcContractId: null,
      warnings: [],
    }),
  mindvault_check_consistency: () =>
    json({
      resourceId: "mock-1",
      apiFound: true,
      onchainFound: true,
      onchainError: null,
      matches: { price: true },
      mismatches: {},
      missingInApi: [],
      missingInOnchain: [],
      summary: "consistent",
    }),
  mindvault_metadata_diff: () =>
    json({
      resourceId: "mock-1",
      apiFound: true,
      onchainFound: true,
      onchainError: null,
      fields: [
        { field: "price", status: "match", api: "5.0000000 USDC", onchain: "5.0000000 USDC" },
      ],
      discrepancyCount: 0,
      summary: "All compared fields match between the API catalog and the on-chain registry.",
      apiSource: "https://mindvault.example.com",
      onchainSource: CONTRACT,
      network: "Test SDF Network ; September 2015",
      x402Network: "stellar:testnet",
      rpc: "https://soroban-testnet.stellar.org",
    }),
  mindvault_tx_status: () =>
    json({ status: "SUCCESS", hash: TX, ledger: 12, ledgerCloseTime: null }),
  mindvault_freeze: () => json({ status: "success", resourceId: "mock-1", txHash: TX }),
  mindvault_royalty: () => json({ status: "success", resourceId: "mock-1", txHash: TX }),
  mindvault_fee_config: () => json({ source: "onchain", configured: false, contract: CONTRACT }),
  mindvault_recover_catalog_cache: () =>
    json({ source: "cache", action: "cleared", message: "Catalog cache cleared." }),
};

const STRUCTURED_TOOLS = TOOL_DEFINITIONS.filter((tool) => tool.outputSchema);

describe("every structured tool's advertised schema", () => {
  it("covers success and error results", () => {
    for (const tool of STRUCTURED_TOOLS) {
      expect((tool.outputSchema!.anyOf as unknown[])[1], tool.name).toBe(TOOL_ERROR_OUTPUT_SCHEMA);
    }
  });

  it("has a success sample in this table", () => {
    const missing = STRUCTURED_TOOLS.map((t) => t.name).filter((n) => !(n in SUCCESS_OUTCOMES));
    expect(missing).toEqual([]);
  });

  it.each(STRUCTURED_TOOLS.map((t) => [t.name, t] as const))(
    "%s: a success result validates",
    (name, tool) => {
      const outcome = SUCCESS_OUTCOMES[name]?.();
      if (outcome === undefined) return; // reported by the coverage test above
      const result = normalizeToolResult(name, outcome, hasOutputSchema);
      expect(outputContractViolation(result, tool.outputSchema)).toBeUndefined();
      // And against the success half alone, so a payload cannot pass by
      // accidentally looking like an error hint.
      expect(checkOutput(successSchemaOf(tool.outputSchema)!, result.structuredContent)).toEqual({
        valid: true,
      });
    },
  );

  it.each(STRUCTURED_TOOLS.map((t) => [t.name, t] as const))(
    "%s: an error result validates",
    (name, tool) => {
      const hint = troubleshootingHint(
        mapTransportError({ operation: `${name} failed`, source: "api", error: new Error("boom") }),
      );
      const result = {
        content: [{ type: "text" as const, text: "Error: boom" }],
        isError: true,
        structuredContent: { troubleshooting: hint },
      };
      expect(outputContractViolation(result, tool.outputSchema)).toBeUndefined();
      // A text-only failure is fine too.
      expect(
        outputContractViolation({ content: result.content, isError: true }, tool.outputSchema),
      ).toBeUndefined();
    },
  );
});

describe("a prose success from a JSON-only tool", () => {
  it("is reported as a contract mismatch rather than sent to fail on the client", () => {
    // mindvault_browse returns a filter-parse error as plain success text,
    // which becomes `{ status: "text" }` — not a catalog list.
    const browse = TOOL_DEFINITIONS.find((t) => t.name === "mindvault_browse")!;
    const result = normalizeToolResult(
      "mindvault_browse",
      "Invalid filter: minPrice",
      hasOutputSchema,
    );
    const out = enforceOutputContract("mindvault_browse", result, browse.outputSchema, () => {});

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("Invalid filter: minPrice");
    expect(outputContractViolation(out, browse.outputSchema)).toBeUndefined();
  });
});

describe("enforceOutputContract", () => {
  const SCHEMA = withToolErrorVariant({
    type: "object",
    properties: { price: { type: "string" } },
    required: ["price"],
  });
  const SECRET = "SBXQ3UJ7MQGM4WJ7NNQV4C6WXZLFZKE4PRXH6XGHHOKCLXDNPPMS4HZK";

  it("returns a conforming result unchanged", () => {
    const result = {
      content: [{ type: "text" as const, text: "{}" }],
      structuredContent: { price: "1" },
    };
    expect(enforceOutputContract("t", result, SCHEMA, () => {})).toBe(result);
  });

  it("leaves tools without a schema alone", () => {
    const result = { content: [{ type: "text" as const, text: "x" }] };
    expect(enforceOutputContract("t", result, undefined, () => {})).toBe(result);
  });

  it("logs a mismatch by tool and schema path, never the payload", () => {
    const logged: string[] = [];
    enforceOutputContract(
      "mindvault_x",
      {
        content: [{ type: "text", text: "x" }],
        structuredContent: { price: 1, secretKey: SECRET, address: ADDRESS },
      },
      SCHEMA,
      (m) => logged.push(m),
    );

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("mindvault_x");
    expect(logged[0]).toContain("/price");
    expect(logged[0]).not.toContain(SECRET);
    expect(logged[0]).not.toContain(ADDRESS);
  });

  it("sends a conforming isError result that keeps the handler text", () => {
    const out = enforceOutputContract(
      "mindvault_x",
      { content: [{ type: "text", text: "Tx hash: abc" }], structuredContent: { price: 1 } },
      SCHEMA,
      () => {},
    );

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("Tx hash: abc");
    expect(out.content[1].text).toMatch(/internal contract mismatch/);
    expect(outputContractViolation(out, SCHEMA)).toBeUndefined();
    expect((out.structuredContent as any).troubleshooting.category).toBe("server");
  });

  it("treats a success with no structuredContent as a mismatch", () => {
    const logged: string[] = [];
    const out = enforceOutputContract(
      "t",
      { content: [{ type: "text", text: "x" }] },
      SCHEMA,
      (m) => logged.push(m),
    );
    expect(out.isError).toBe(true);
    expect(logged[0]).toContain("structuredContent is missing");
  });

  it("checks error results too", () => {
    const out = enforceOutputContract(
      "t",
      { content: [{ type: "text", text: "Error" }], isError: true, structuredContent: { nope: 1 } },
      SCHEMA,
      () => {},
    );
    expect(outputContractViolation(out, SCHEMA)).toBeUndefined();
  });
});

describe("a contract mismatch through a real MCP session", () => {
  const TOOL = {
    name: "mindvault_price",
    description: "Return a price.",
    inputSchema: { type: "object" as const, properties: {} },
    outputSchema: withToolErrorVariant({
      type: "object",
      properties: { price: { type: "string" } },
      required: ["price"],
    }),
  };

  async function call(dispatch: () => Promise<string>, errorContent?: Record<string, unknown>) {
    const server = createMindVaultServer({
      listTools: () => [TOOL],
      dispatchTool: dispatch,
      structuredResult: (_name, text) => JSON.parse(text),
      ...(errorContent ? { errorContent: () => errorContent } : {}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools(); // the client caches output validators from here
    return client.callTool({ name: TOOL.name, arguments: {} }) as Promise<any>;
  }

  it("delivers a conforming success unchanged", async () => {
    const result = await call(async () => JSON.stringify({ price: "1" }));
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ price: "1" });
  });

  it("turns an invalid success into a readable error instead of a client exception", async () => {
    const result = await call(async () => JSON.stringify({ price: 1 }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.troubleshooting.summary).toMatch(/contract mismatch/);
  });

  it("lets a mapped failure's troubleshooting hint through to the client", async () => {
    const hint = troubleshootingHint(
      mapTransportError({ operation: "Price failed", source: "api", error: new Error("down") }),
    );
    const result = await call(
      async () => {
        throw new Error("down");
      },
      { troubleshooting: hint },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ troubleshooting: hint });
  });
});
