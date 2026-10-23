/**
 * Null vs omitted semantics in serialized MCP results (#1065).
 *
 * `JSON.stringify` drops a property whose value is `undefined`. A handler that
 * copies an optional upstream value straight into its result therefore omits
 * the field when the value is missing. Where the published `outputSchema`
 * lists that field as required (nullable fields are `type: [..., "null"]` and
 * listed in `required`), the omission is a schema violation: the server's
 * output contract (#1062) turns the whole result into an error, and a client
 * validating `structuredContent` rejects it.
 *
 * For each affected tool these tables run the real handler against a
 * populated value, an explicit `null`, and an absent value, and check:
 *
 *  - the result conforms to the tool's advertised schema, and
 *  - every required nullable field is present, `null` when the input had no
 *    value, never omitted.
 *
 * Covered: catalog previews (`mindvault_preview`), receipt fields
 * (`mindvault_purchase_history`, `mindvault_export_receipts`), the settlement
 * block of `mindvault_buy`, and diagnostic fields (`mindvault_tx_status`,
 * `mindvault_debug_bundle`).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

delete process.env.MINDVAULT_MOCK;

const {
  preview: dispatchedPreview,
  txStatus,
  normalizeToolResultForTest,
} = await import("./index.js");
const { preview: catalogPreview } = await import("./tools/catalog.js");
const { checkOutput, successSchemaOf } = await import("./outputValidation.js");
const { TOOL_DEFINITIONS } = await import("./tools.js");
const { SETTLEMENT_SCHEMA } = await import("./outputSchemas.js");
const { buildSettlementSnapshot } = await import("./settlement.js");
const { _setPurchasesFilePath, purchaseHistoryTool } = await import("./purchaseHistory.js");
const { exportReceiptsTool } = await import("./receipts.js");
const { debugBundleTool } = await import("./debugBundle.js");

type Json = Record<string, unknown>;

function schemaFor(tool: string): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS.find((t) => t.name === tool);
  const schema = successSchemaOf(definition?.outputSchema);
  if (!schema) throw new Error(`${tool} advertises no output schema`);
  return schema;
}

/** structuredContent exactly as the CallTool handler would send it. */
function structured(tool: string, text: string): Json {
  const result = normalizeToolResultForTest(tool, text);
  return result.structuredContent as Json;
}

function expectConforms(tool: string, value: unknown, schema = schemaFor(tool)): void {
  const check = checkOutput(schema, value);
  expect(check, `${tool} result conforms to its advertised schema`).toEqual({ valid: true });
}

/** Assert each listed field is present, and null when `expectNull`. */
function expectPresent(value: Json, fields: readonly string[], expectNull: boolean): void {
  for (const field of fields) {
    expect(Object.hasOwn(value, field), `${field} is present, not omitted`).toBe(true);
    if (expectNull) expect(value[field], `${field} is null`).toBeNull();
    else expect(value[field], `${field} is populated`).not.toBeNull();
  }
}

type Variant = "populated" | "null" | "absent";
const VARIANTS: Variant[] = ["populated", "null", "absent"];

function withVariant(variant: Variant, populated: Json, fields: readonly string[]): Json {
  const out: Json = { ...populated };
  for (const field of fields) {
    if (variant === "null") out[field] = null;
    if (variant === "absent") delete out[field];
  }
  return out;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ── Catalog preview ─────────────────────────────────────────────────────────

const PREVIEW_META: Json = {
  id: "res001",
  title: "Stellar Payments Dataset",
  description: "Ledger-level payment records.",
  price: "1.5",
  resourceType: "dataset",
  verificationStatus: "verified",
  accessUrl: "https://example.com/res001",
};
/** Upstream fields that can be missing from `/resources/:id/meta`. */
const PREVIEW_OPTIONAL = [
  "title",
  "description",
  "price",
  "resourceType",
  "verificationStatus",
  "accessUrl",
] as const;
/** The required preview fields they surface as. */
const PREVIEW_FIELDS = [
  "title",
  "description",
  "price",
  "type",
  "verificationStatus",
  "accessUrl",
] as const;

describe.each([
  ["dispatch handler (index.ts)", dispatchedPreview],
  ["catalog module (tools/catalog.ts)", catalogPreview],
])("mindvault_preview — %s", (_label, preview) => {
  it.each(VARIANTS)("%s optional fields", async (variant) => {
    const meta = withVariant(variant, PREVIEW_META, PREVIEW_OPTIONAL);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(meta)) as unknown as typeof fetch;

    const value = structured("mindvault_preview", await preview("res001"));
    expectConforms("mindvault_preview", value);
    expectPresent(value, PREVIEW_FIELDS, variant !== "populated");
    expect(value.id).toBe("res001");
    if (variant === "populated") expect(value.price).toBe("$1.5 USDC");
  });
});

// ── Receipt fields ──────────────────────────────────────────────────────────

const RECEIPT_NULLABLE = ["txHash", "receiptRef"] as const;
const STORED_RECEIPT: Json = {
  resourceId: "res001",
  amount: "1.5",
  network: "stellar:testnet",
  txHash: "a".repeat(64),
  timestamp: "2026-10-01T12:00:00.000Z",
  receiptRef: "x402:pay-1",
  title: "Stellar Payments Dataset",
};

describe("receipt fields", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mv-nullable-"));
    file = join(dir, "purchases.json");
    _setPurchasesFilePath(file);
  });

  afterAll(() => {
    _setPurchasesFilePath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function storeReceipt(receipt: Json): void {
    writeFileSync(file, JSON.stringify({ version: 1, epoch: "", purchases: [receipt] }));
  }

  it.each(VARIANTS)("mindvault_purchase_history with %s txHash/receiptRef", (variant) => {
    storeReceipt(withVariant(variant, STORED_RECEIPT, RECEIPT_NULLABLE));

    const value = structured("mindvault_purchase_history", purchaseHistoryTool({}));
    expectConforms("mindvault_purchase_history", value);
    // An absent value used to drop the whole receipt from the history.
    expect(value.count).toBe(1);
    const [row] = value.purchases as Json[];
    expectPresent(row, [...RECEIPT_NULLABLE, "explorerUrl"], variant !== "populated");
  });

  it.each(VARIANTS)("mindvault_export_receipts with %s txHash/receiptRef/title", (variant) => {
    storeReceipt(withVariant(variant, STORED_RECEIPT, [...RECEIPT_NULLABLE, "title"]));

    const value = structured("mindvault_export_receipts", exportReceiptsTool({}));
    expectConforms("mindvault_export_receipts", value);
    expect(value.count).toBe(1);
    const [row] = value.receipts as Json[];
    expectPresent(row, [...RECEIPT_NULLABLE, "title", "explorerUrl"], variant !== "populated");
    // Unset filters are reported as null, not omitted.
    expectPresent(
      value.filters as Json,
      ["resourceId", "network", "since", "until", "limit", "groupBy"],
      true,
    );
  });
});

// ── Settlement block of mindvault_buy ───────────────────────────────────────

describe("mindvault_buy settlement block", () => {
  const TX = "b".repeat(64);

  it.each([
    ["populated: polled to SUCCESS", TX, true, { status: "SUCCESS" }],
    ["null txHash, wait requested", null, true, null],
    ["null txHash, no wait", null, false, null],
    ["txHash known, no wait", TX, false, null],
  ] as const)("%s", (_label, txHash, wait, lookup) => {
    const snapshot = buildSettlementSnapshot({
      txHash,
      wait,
      skipped: wait && !txHash,
      result: lookup
        ? {
            tx: { hash: TX, found: true, status: lookup.status },
            attempts: 1,
            timedOut: false,
          }
        : null,
    });
    // Round-trip through JSON exactly as the buy summary is serialized.
    const value = JSON.parse(JSON.stringify(snapshot)) as Json;
    expectConforms("mindvault_buy", value, SETTLEMENT_SCHEMA as unknown as Json);
    expect(Object.hasOwn(value, "txHash")).toBe(true);
    expect(Object.hasOwn(value, "status")).toBe(true);
    expect(value.txHash).toBe(txHash);
    expect(value.status).toBe(lookup ? lookup.status : null);
  });
});

// ── Diagnostic fields ───────────────────────────────────────────────────────

describe("mindvault_tx_status diagnostics", () => {
  it.each([
    ["populated", { createdAt: 1_760_000_000 }, false],
    ["null", { createdAt: null }, true],
    ["absent", {}, true],
  ] as const)("%s ledger close time", async (_label, extra, expectNull) => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ result: { status: "SUCCESS", ledger: 42, ...extra } }),
      ) as unknown as typeof fetch;

    const value = structured("mindvault_tx_status", await txStatus("c".repeat(64)));
    expectConforms("mindvault_tx_status", value);
    expectPresent(value, ["ledgerCloseTime"], expectNull);
  });
});

describe("mindvault_debug_bundle diagnostics", () => {
  it.each([
    ["populated", true, false],
    ["withheld", false, true],
  ] as const)("%s environment", (_label, includeEnvironment, expectNull) => {
    const value = structured("mindvault_debug_bundle", debugBundleTool({ includeEnvironment }));
    expectConforms("mindvault_debug_bundle", value);
    expectPresent(value, ["environment"], expectNull);
  });
});

describe("purchase history store keeps its epoch", () => {
  it("does not lose receipts across writes when MINDVAULT_PURCHASES_EPOCH is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-epoch-"));
    process.env.MINDVAULT_PURCHASES_EPOCH = "epoch-1065";
    vi.resetModules();
    try {
      const store = await import("./purchaseHistory.js");
      store._setPurchasesFilePath(join(dir, "purchases.json"));
      for (const id of ["res1", "res2", "res3"]) {
        store.recordPurchase({
          resourceId: id,
          amount: "1",
          network: "stellar:testnet",
          txHash: null,
          receiptRef: null,
        });
      }
      // Each write used to persist the loaded store without its epoch, so the
      // next read saw a different epoch and discarded the earlier receipts.
      expect(
        store
          .listPurchases()
          .map((r) => r.resourceId)
          .sort(),
      ).toEqual(["res1", "res2", "res3"]);
      expect(store.loadPurchaseHistory().epoch).toBe("epoch-1065");
      store._setPurchasesFilePath(null);
    } finally {
      delete process.env.MINDVAULT_PURCHASES_EPOCH;
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
