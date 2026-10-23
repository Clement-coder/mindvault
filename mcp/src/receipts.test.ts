/**
 * Tests for the structured receipt export.
 *
 * The export is a document other systems read, so the properties that matter
 * are its schema stability (declared version, fixed column order, explicit
 * nulls), the exactness of its total, and deterministic rejection of bad
 * filters — not the prose around it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildReceiptExport,
  defaultReceiptFields,
  exportReceiptsTool,
  normalizeReceiptExportOptions,
  receiptsToCsv,
  receiptsToNdjson,
  selectReceiptFields,
  sumAmounts,
  toExportedReceipt,
  ReceiptExportError,
  RECEIPT_CSV_COLUMNS,
  RECEIPT_EXPORT_MAX_LIMIT,
  RECEIPT_EXPORT_OUTPUT_SCHEMA,
  RECEIPT_EXPORT_SCHEMA,
  RECEIPT_ROW_FIELDS,
  RECEIPT_SENSITIVE_FIELDS,
  type ExportedReceipt,
} from "./receipts.js";
import {
  _clearPurchases,
  _setPurchasesFilePath,
  recordPurchase,
  type PurchaseReceipt,
} from "./purchaseHistory.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function storedReceipt(overrides: Partial<PurchaseReceipt> = {}): PurchaseReceipt {
  return {
    resourceId: "res-001",
    amount: "1.50",
    network: "stellar:testnet",
    txHash: "abc123",
    timestamp: "2026-08-20T10:00:00.000Z",
    receiptRef: "pay-1",
    title: "Intro to Stellar",
    ...overrides,
  };
}

function exportedRow(overrides: Partial<ExportedReceipt> = {}): ExportedReceipt {
  return { ...toExportedReceipt(storedReceipt(), "testnet"), ...overrides };
}

describe("normalizeReceiptExportOptions", () => {
  it("defaults to the json format with no filters", () => {
    expect(normalizeReceiptExportOptions(undefined)).toEqual({ format: "json" });
    expect(normalizeReceiptExportOptions({})).toEqual({ format: "json" });
  });

  it("accepts the csv format and trims string filters", () => {
    expect(
      normalizeReceiptExportOptions({ format: "csv", resourceId: " res-001 ", network: " x " }),
    ).toEqual({ format: "csv", resourceId: "res-001", network: "x" });
  });

  it("accepts the ndjson format", () => {
    expect(normalizeReceiptExportOptions({ format: "ndjson" })).toEqual({ format: "ndjson" });
  });

  it("reads a bare date as midnight UTC", () => {
    const options = normalizeReceiptExportOptions({ since: "2026-08-01" });
    expect(options.since).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects an unknown format", () => {
    expect(() => normalizeReceiptExportOptions({ format: "xml" })).toThrow(ReceiptExportError);
    expect(() => normalizeReceiptExportOptions({ format: "xml" })).toThrow(
      /must be "json", "csv", or "ndjson"/,
    );
  });

  it("rejects an unparseable date", () => {
    expect(() => normalizeReceiptExportOptions({ since: "last tuesday" })).toThrow(/ISO-8601/);
  });

  it("rejects an inverted date range", () => {
    expect(() =>
      normalizeReceiptExportOptions({ since: "2026-08-31", until: "2026-08-01" }),
    ).toThrow(/since cannot be later than until/);
  });

  it("rejects a limit outside the supported range", () => {
    expect(() => normalizeReceiptExportOptions({ limit: 0 })).toThrow(/between 1 and/);
    expect(() => normalizeReceiptExportOptions({ limit: RECEIPT_EXPORT_MAX_LIMIT + 1 })).toThrow(
      /between 1 and/,
    );
    expect(() => normalizeReceiptExportOptions({ limit: 2.5 })).toThrow(/between 1 and/);
  });

  it("rejects a non-string filter instead of coercing it", () => {
    expect(() => normalizeReceiptExportOptions({ resourceId: 7 })).toThrow(/expected a string/);
  });
});

describe("toExportedReceipt", () => {
  it("normalizes a stored receipt and resolves the explorer link", () => {
    expect(toExportedReceipt(storedReceipt(), "testnet")).toEqual({
      resourceId: "res-001",
      title: "Intro to Stellar",
      amount: "1.50",
      currency: "USDC",
      network: "stellar:testnet",
      purchasedAt: "2026-08-20T10:00:00.000Z",
      txHash: "abc123",
      receiptRef: "pay-1",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/abc123",
      profile: "(unscoped)",
    });
  });

  it("uses explicit nulls for missing fields rather than dropping them", () => {
    const row = toExportedReceipt(
      storedReceipt({ txHash: null, receiptRef: null, title: undefined }),
      "testnet",
    );
    expect(row.title).toBeNull();
    expect(row.txHash).toBeNull();
    expect(row.explorerUrl).toBeNull();
  });
});

describe("sumAmounts", () => {
  it("adds decimal amounts exactly", () => {
    // 0.1 + 0.2 is the classic float trap; an export people reconcile must not hit it.
    expect(sumAmounts([exportedRow({ amount: "0.1" }), exportedRow({ amount: "0.2" })])).toBe(
      "0.3",
    );
  });

  it("keeps stroop precision and trims trailing zeros", () => {
    expect(sumAmounts([exportedRow({ amount: "0.0000001" })])).toBe("0.0000001");
    expect(sumAmounts([exportedRow({ amount: "1.5000000" })])).toBe("1.5");
  });

  it("returns 0 for an empty export", () => {
    expect(sumAmounts([])).toBe("0");
  });

  it("skips amounts that are not numbers", () => {
    expect(sumAmounts([exportedRow({ amount: "" }), exportedRow({ amount: "2" })])).toBe("2");
  });
});

describe("receiptsToCsv", () => {
  it("emits the header even with no rows", () => {
    expect(receiptsToCsv([])).toBe(RECEIPT_CSV_COLUMNS.join(","));
  });

  it("writes one line per receipt in the declared column order", () => {
    const [header, row] = receiptsToCsv([exportedRow()]).split("\r\n");
    expect(header).toBe(
      "resourceId,title,amount,currency,network,purchasedAt,txHash,receiptRef,explorerUrl",
    );
    expect(row.split(",")[0]).toBe("res-001");
    expect(row.split(",")[3]).toBe('"USDC"');
  });

  it("quotes fields containing commas, quotes, or newlines (RFC 4180)", () => {
    const csv = receiptsToCsv([exportedRow({ title: 'Data, "clean", 2026' })]);
    expect(csv).toContain('"Data, ""clean"", 2026"');
  });

  it("renders a null field as empty rather than the text null", () => {
    const csv = receiptsToCsv([exportedRow({ txHash: null, explorerUrl: null })]);
    expect(csv).not.toContain("null");
  });

  it.each(["=SUM(A1:A2)", "+cmd", "-2+3", "@IMPORTXML(x)", "  =1+1"])(
    "neutralizes spreadsheet formula value %s",
    (title) => {
      const csv = receiptsToCsv([exportedRow({ title })]);
      expect(csv.split("\r\n")[1]).toContain(`'${title}`);
    },
  );

  it("preserves Unicode while escaping physical line breaks", () => {
    const csv = receiptsToCsv([exportedRow({ title: 'Résumé 東京\r\n"quoted"\nnext' })]);
    expect(csv).toContain("Résumé 東京\\r\\n");
    expect(csv).toContain("\\nnext");
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});

describe("receiptsToNdjson", () => {
  it("returns an empty string for an empty export", () => {
    expect(receiptsToNdjson([])).toBe("");
  });

  it("produces one JSON object per line", () => {
    const rows = [exportedRow({ resourceId: "res-001" }), exportedRow({ resourceId: "res-002" })];
    const result = receiptsToNdjson(rows);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).resourceId).toBe("res-001");
    expect(JSON.parse(lines[1]).resourceId).toBe("res-002");
  });

  it("each line is a valid JSON object with the expected fields", () => {
    const row = exportedRow();
    const line = receiptsToNdjson([row]);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual(row);
  });

  it("preserves null fields in the JSON output", () => {
    const row = exportedRow({ txHash: null, explorerUrl: null, title: null });
    const line = receiptsToNdjson([row]);
    const parsed = JSON.parse(line);
    expect(parsed.txHash).toBeNull();
    expect(parsed.explorerUrl).toBeNull();
    expect(parsed.title).toBeNull();
  });

  it("preserves Unicode and JSON-escapes CRLF so records cannot inject lines", () => {
    const title = 'Résumé 東京\r\n"quoted"';
    const result = receiptsToNdjson([exportedRow({ title }), exportedRow({ title: "next" })]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).title).toBe(title);
  });
});

describe("buildReceiptExport", () => {
  it("returns a versioned envelope that echoes its filters", () => {
    const result = buildReceiptExport([storedReceipt()], { format: "json" }, NOW, "testnet");

    expect(result.schema).toBe(RECEIPT_EXPORT_SCHEMA);
    expect(result.generatedAt).toBe("2026-08-25T12:00:00.000Z");
    expect(result.format).toBe("json");
    expect(result.currency).toBe("USDC");
    expect(result.count).toBe(1);
    expect(result.totalMatching).toBe(1);
    expect(result.nextOffset).toBeNull();
    expect(result.totalAmount).toBe("1.5");
    expect(result.fields).toEqual([
      "resourceId",
      "title",
      "amount",
      "currency",
      "network",
      "purchasedAt",
      "txHash",
      "receiptRef",
      "explorerUrl",
    ]);
    expect(result.filters).toEqual({
      resourceId: null,
      network: null,
      since: null,
      until: null,
      limit: null,
      offset: null,
      groupBy: null,
    });
    expect(result.csv).toBeUndefined();
  });

  it("includes exact per-month totals newest-first when requested", () => {
    const receipts = [
      storedReceipt({ amount: "0.1", timestamp: "2026-07-31T23:00:00.000Z" }),
      storedReceipt({ amount: "0.2", timestamp: "2026-08-01T00:00:00.000Z" }),
      storedReceipt({ amount: "1.3", timestamp: "2026-08-20T00:00:00.000Z" }),
    ];
    const result = buildReceiptExport(
      receipts,
      { format: "json", groupBy: "month" },
      NOW,
      "testnet",
    );
    expect(result.monthlySummaries).toEqual([
      { month: "2026-08", count: 2, totalAmount: "1.5", currency: "USDC" },
      { month: "2026-07", count: 1, totalAmount: "0.1", currency: "USDC" },
    ]);
    expect(result.filters.groupBy).toBe("month");
  });

  it("includes the csv document only for the csv format", () => {
    const result = buildReceiptExport([storedReceipt()], { format: "csv" }, NOW, "testnet");
    expect(result.csv).toContain("res-001");
    // Both views describe the same rows.
    expect(result.csv?.split("\r\n").length).toBe(result.count + 1);
  });

  it("includes the ndjson document only for the ndjson format", () => {
    const result = buildReceiptExport([storedReceipt()], { format: "ndjson" }, NOW, "testnet");
    expect(result.ndjson).toBeDefined();
    expect(result.csv).toBeUndefined();
    // One line per receipt.
    expect(result.ndjson?.split("\n").length).toBe(result.count);
    const parsed = JSON.parse(result.ndjson!.split("\n")[0]);
    expect(parsed.resourceId).toBe("res-001");
  });

  it("ndjson is absent for json format", () => {
    const result = buildReceiptExport([storedReceipt()], { format: "json" }, NOW, "testnet");
    expect(result.ndjson).toBeUndefined();
  });

  it("ndjson is an empty string for an empty ndjson export", () => {
    const result = buildReceiptExport([], { format: "ndjson" }, NOW, "testnet");
    expect(result.ndjson).toBe("");
    expect(result.count).toBe(0);
  });

  it("applies an inclusive date range", () => {
    const receipts = [
      storedReceipt({ resourceId: "old", timestamp: "2026-07-31T23:59:59.000Z" }),
      storedReceipt({ resourceId: "edge", timestamp: "2026-08-01T00:00:00.000Z" }),
      storedReceipt({ resourceId: "new", timestamp: "2026-08-15T00:00:00.000Z" }),
    ];
    const result = buildReceiptExport(
      receipts,
      { format: "json", since: "2026-08-01T00:00:00.000Z", until: "2026-08-15T00:00:00.000Z" },
      NOW,
      "testnet",
    );
    expect(result.receipts.map((r) => r.resourceId)).toEqual(["edge", "new"]);
    expect(result.filters.since).toBe("2026-08-01T00:00:00.000Z");
  });

  it("caps the export at the requested limit", () => {
    const receipts = Array.from({ length: 5 }, (_, i) =>
      storedReceipt({ resourceId: `res-${i}`, amount: "1" }),
    );
    const result = buildReceiptExport(receipts, { format: "json", limit: 2 }, NOW, "testnet");
    expect(result.count).toBe(2);
    expect(result.totalAmount).toBe("2");
  });

  it("returns an empty, still-valid document when nothing matches", () => {
    const result = buildReceiptExport([], { format: "csv" }, NOW, "testnet");
    expect(result.count).toBe(0);
    expect(result.totalAmount).toBe("0");
    expect(result.receipts).toEqual([]);
    expect(result.csv).toBe(RECEIPT_CSV_COLUMNS.join(","));
  });
});

describe("exportReceiptsTool", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mindvault-receipts-"));
    _setPurchasesFilePath(join(home, "purchases.json"));
    _clearPurchases();
  });

  afterEach(() => {
    _setPurchasesFilePath(null);
    rmSync(home, { recursive: true, force: true });
  });

  it("exports the receipts mindvault_buy recorded", () => {
    recordPurchase({
      resourceId: "res-001",
      amount: "1.50",
      network: "stellar:testnet",
      txHash: "abc",
      receiptRef: "pay-1",
      title: "Intro to Stellar",
    });
    recordPurchase({
      resourceId: "res-002",
      amount: "0.50",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: null,
    });

    const result = JSON.parse(exportReceiptsTool({}));
    expect(result.schema).toBe(RECEIPT_EXPORT_SCHEMA);
    expect(result.count).toBe(2);
    expect(result.totalAmount).toBe("2");
    expect(result.receipts.map((r: ExportedReceipt) => r.resourceId).sort()).toEqual([
      "res-001",
      "res-002",
    ]);
  });

  it("filters by resource id", () => {
    recordPurchase({ resourceId: "a", amount: "1", network: "stellar:testnet", txHash: null });
    recordPurchase({ resourceId: "b", amount: "2", network: "stellar:testnet", txHash: null });

    const result = JSON.parse(exportReceiptsTool({ resourceId: "b" }));
    expect(result.count).toBe(1);
    expect(result.filters.resourceId).toBe("b");
    expect(result.totalAmount).toBe("2");
  });

  it("filters by network", () => {
    recordPurchase({ resourceId: "a", amount: "1", network: "stellar:testnet", txHash: null });
    recordPurchase({ resourceId: "b", amount: "2", network: "stellar:pubnet", txHash: null });

    const result = JSON.parse(exportReceiptsTool({ network: "stellar:pubnet" }));
    expect(result.count).toBe(1);
    expect(result.receipts[0].resourceId).toBe("b");
  });

  it("exports an empty document when nothing has been purchased", () => {
    const result = JSON.parse(exportReceiptsTool({ format: "csv" }));
    expect(result.count).toBe(0);
    expect(result.csv).toBe(RECEIPT_CSV_COLUMNS.join(","));
  });

  it("exports an ndjson document when format is ndjson", () => {
    recordPurchase({
      resourceId: "res-001",
      amount: "1.50",
      network: "stellar:testnet",
      txHash: "abc",
      receiptRef: "pay-1",
      title: "Intro to Stellar",
    });

    const result = JSON.parse(exportReceiptsTool({ format: "ndjson" }));
    expect(result.format).toBe("ndjson");
    expect(result.ndjson).toBeDefined();
    expect(typeof result.ndjson).toBe("string");
    const parsed = JSON.parse(result.ndjson);
    expect(parsed.resourceId).toBe("res-001");
  });

  it("surfaces a bad filter as a deterministic error", () => {
    expect(() => exportReceiptsTool({ limit: -1 })).toThrow(ReceiptExportError);
  });

  it("carries the offset through the tool so a client can walk the export", () => {
    for (let i = 0; i < 5; i++) {
      recordPurchase({
        resourceId: `res-${i}`,
        amount: "1",
        network: "stellar:testnet",
        txHash: null,
      });
    }
    const first = JSON.parse(exportReceiptsTool({ limit: 2 }));
    expect(first.nextOffset).toBe(2);
    const second = JSON.parse(exportReceiptsTool({ limit: 2, offset: first.nextOffset }));
    expect(second.count).toBe(2);
    expect(second.filters.offset).toBe(2);
  });

  it("carries fields and includeSensitive through the tool", () => {
    recordPurchase({
      resourceId: "res-001",
      amount: "1",
      network: "stellar:testnet",
      txHash: null,
      profile: "buyer.alice",
    });
    const selected = JSON.parse(exportReceiptsTool({ fields: "resourceId,amount" }));
    expect(selected.receipts[0]).toEqual({ resourceId: "res-001", amount: "1" });

    const sensitive = JSON.parse(exportReceiptsTool({ includeSensitive: true }));
    expect(sensitive.receipts[0].profile).toBe("buyer.alice");
  });
});

describe("advertised output schema", () => {
  it("declares the envelope fields a client can rely on", () => {
    const required = RECEIPT_EXPORT_OUTPUT_SCHEMA.required as readonly string[];
    for (const field of ["schema", "generatedAt", "format", "count", "totalAmount", "receipts"]) {
      expect(required).toContain(field);
    }
  });

  it("matches the shape the tool actually returns", () => {
    const produced = buildReceiptExport([storedReceipt()], { format: "json" }, NOW, "testnet");
    const advertised = Object.keys(RECEIPT_EXPORT_OUTPUT_SCHEMA.properties);
    for (const key of Object.keys(produced)) {
      expect(advertised, `${key} is returned but not advertised`).toContain(key);
    }
  });

  it("advertises every column the csv renders", () => {
    const rowProperties = Object.keys(
      RECEIPT_EXPORT_OUTPUT_SCHEMA.properties.receipts.items.properties,
    );
    for (const column of RECEIPT_CSV_COLUMNS) {
      expect(rowProperties).toContain(column);
    }
  });

  it("advertises ndjson as a valid format", () => {
    const formats = RECEIPT_EXPORT_OUTPUT_SCHEMA.properties.format.enum as readonly string[];
    expect(formats).toContain("ndjson");
  });

  it("advertises the ndjson field in the output schema", () => {
    expect(Object.keys(RECEIPT_EXPORT_OUTPUT_SCHEMA.properties)).toContain("ndjson");
  });

  it("advertises ndjson in the schema for ndjson export", () => {
    const produced = buildReceiptExport([storedReceipt()], { format: "ndjson" }, NOW, "testnet");
    const advertised = Object.keys(RECEIPT_EXPORT_OUTPUT_SCHEMA.properties);
    for (const key of Object.keys(produced)) {
      expect(advertised, `${key} is returned but not advertised`).toContain(key);
    }
  });

  it("advertises the resumable-pagination and field-selection envelope fields", () => {
    const advertised = Object.keys(RECEIPT_EXPORT_OUTPUT_SCHEMA.properties);
    for (const field of ["fields", "totalMatching", "nextOffset"]) {
      expect(advertised, `${field} is not advertised`).toContain(field);
    }
    const filterProps = Object.keys(RECEIPT_EXPORT_OUTPUT_SCHEMA.properties.filters.properties);
    expect(filterProps).toContain("offset");
  });

  it("advertises every selectable row field, including the sensitive one", () => {
    const rowProperties = Object.keys(
      RECEIPT_EXPORT_OUTPUT_SCHEMA.properties.receipts.items.properties,
    );
    for (const field of RECEIPT_ROW_FIELDS) {
      expect(rowProperties, `${field} is selectable but not advertised`).toContain(field);
    }
    expect(rowProperties).toContain("profile");
  });
});

describe("field selection (#1079)", () => {
  it("includes every non-sensitive row field by default", () => {
    expect(defaultReceiptFields(false)).toEqual([
      "resourceId",
      "title",
      "amount",
      "currency",
      "network",
      "purchasedAt",
      "txHash",
      "receiptRef",
      "explorerUrl",
    ]);
  });

  it("excludes sensitive fields by default", () => {
    const fields = defaultReceiptFields(false);
    for (const sensitive of RECEIPT_SENSITIVE_FIELDS) {
      expect(fields).not.toContain(sensitive);
    }
  });

  it("includeSensitive widens the default set to every field", () => {
    expect(defaultReceiptFields(true)).toEqual([...RECEIPT_ROW_FIELDS]);
  });

  it("keeps only the selected fields, in selection order", () => {
    const row = toExportedReceipt(storedReceipt(), "testnet");
    const projected = selectReceiptFields(row, ["amount", "resourceId"]);
    expect(Object.keys(projected)).toEqual(["amount", "resourceId"]);
    expect(projected).toEqual({ amount: "1.50", resourceId: "res-001" });
  });

  it("projects an absent selected field as an explicit null, not a dropped key", () => {
    const row = toExportedReceipt(storedReceipt({ txHash: null }), "testnet");
    const projected = selectReceiptFields(row, ["txHash"]);
    expect(projected).toEqual({ txHash: null });
    expect("txHash" in projected).toBe(true);
  });

  it("parses a comma-separated fields string, trimming and de-duplicating", () => {
    const options = normalizeReceiptExportOptions({
      fields: " resourceId , amount ,resourceId",
    });
    expect(options.fields).toEqual(["resourceId", "amount"]);
  });

  it("accepts fields as an array", () => {
    const options = normalizeReceiptExportOptions({ fields: ["amount", "purchasedAt"] });
    expect(options.fields).toEqual(["amount", "purchasedAt"]);
  });

  it("lets a caller name a sensitive field explicitly to opt in", () => {
    const options = normalizeReceiptExportOptions({ fields: "resourceId,profile" });
    expect(options.fields).toEqual(["resourceId", "profile"]);
  });

  it("rejects an unknown field name deterministically, listing the known fields", () => {
    expect(() => normalizeReceiptExportOptions({ fields: "resourceId,nope" })).toThrow(
      /unknown field "nope"/,
    );
    expect(() => normalizeReceiptExportOptions({ fields: "resourceId,nope" })).toThrow(
      /resourceId/,
    );
  });

  it("rejects an empty selection after trimming", () => {
    expect(() => normalizeReceiptExportOptions({ fields: " , " })).toThrow(/at least one field/);
  });

  it("rejects a non-string field array", () => {
    expect(() => normalizeReceiptExportOptions({ fields: [42] })).toThrow(/array of field-name/);
  });

  it("strips sensitive fields from the rows by default", () => {
    const result = buildReceiptExport(
      [storedReceipt({ profile: "buyer.alice" })],
      { format: "json" },
      NOW,
      "testnet",
    );
    expect(result.fields).not.toContain("profile");
    expect(result.receipts[0]).not.toHaveProperty("profile");
  });

  it("includeSensitive carries the profile field into the rows", () => {
    const result = buildReceiptExport(
      [storedReceipt({ profile: "buyer.alice" })],
      { format: "json", includeSensitive: true },
      NOW,
      "testnet",
    );
    expect(result.fields).toContain("profile");
    expect(result.receipts[0].profile).toBe("buyer.alice");
  });

  it("renders only the selected columns in the csv header and rows", () => {
    const result = buildReceiptExport(
      [storedReceipt({ profile: "buyer.alice" })],
      { format: "csv", fields: ["resourceId", "amount"] },
      NOW,
      "testnet",
    );
    const [header, row] = result.csv!.split("\r\n");
    expect(header).toBe("resourceId,amount");
    expect(row).toBe("res-001,1.50");
    expect(result.csv).not.toContain("profile");
    expect(result.csv).not.toContain("buyer.alice");
  });

  it("renders only the selected keys as ndjson", () => {
    const result = buildReceiptExport(
      [storedReceipt()],
      { format: "ndjson", fields: ["resourceId", "amount"] },
      NOW,
      "testnet",
    );
    expect(JSON.parse(result.ndjson!)).toEqual({ resourceId: "res-001", amount: "1.50" });
  });

  it("exports the profile value in csv only when it is selected", () => {
    const result = buildReceiptExport(
      [storedReceipt({ profile: "buyer.alice" })],
      { format: "csv", fields: ["resourceId", "profile"] },
      NOW,
      "testnet",
    );
    const [header, row] = result.csv!.split("\r\n");
    expect(header).toBe("resourceId,profile");
    expect(row).toBe("res-001,buyer.alice");
  });
});

describe("resumable pagination (#1079)", () => {
  function receipts(count: number): PurchaseReceipt[] {
    return Array.from({ length: count }, (_, i) =>
      storedReceipt({ resourceId: `res-${i}`, amount: "1" }),
    );
  }

  it("reports every matching row count and a null nextOffset on the last page", () => {
    const result = buildReceiptExport(receipts(3), { format: "json", limit: 5 }, NOW, "testnet");
    expect(result.count).toBe(3);
    expect(result.totalMatching).toBe(3);
    expect(result.nextOffset).toBeNull();
  });

  it("reports totalMatching larger than count on a partial page", () => {
    const result = buildReceiptExport(receipts(5), { format: "json", limit: 2 }, NOW, "testnet");
    expect(result.count).toBe(2);
    expect(result.totalMatching).toBe(5);
  });

  it("returns the offset that resumes the export without gaps or repeats", () => {
    const all = receipts(5);
    const first = buildReceiptExport(all, { format: "json", limit: 2 }, NOW, "testnet");
    expect(first.nextOffset).toBe(2);

    const second = buildReceiptExport(
      all,
      { format: "json", limit: 2, offset: first.nextOffset! },
      NOW,
      "testnet",
    );
    expect(second.nextOffset).toBe(4);
    expect(second.filters.offset).toBe(2);

    const third = buildReceiptExport(
      all,
      { format: "json", limit: 2, offset: second.nextOffset! },
      NOW,
      "testnet",
    );
    expect(third.count).toBe(1);
    expect(third.nextOffset).toBeNull();

    const ids = [
      ...first.receipts.map((r) => r.resourceId),
      ...second.receipts.map((r) => r.resourceId),
      ...third.receipts.map((r) => r.resourceId),
    ];
    expect(ids).toEqual(["res-0", "res-1", "res-2", "res-3", "res-4"]);
  });

  it("echoes the offset filter", () => {
    const result = buildReceiptExport(receipts(5), { format: "json", offset: 3 }, NOW, "testnet");
    expect(result.filters.offset).toBe(3);
    expect(result.receipts.map((r) => r.resourceId)).toEqual(["res-3", "res-4"]);
  });

  it("treats an offset past the end as an empty, still-resumable document", () => {
    const result = buildReceiptExport(receipts(2), { format: "json", offset: 10 }, NOW, "testnet");
    expect(result.count).toBe(0);
    expect(result.totalMatching).toBe(2);
    expect(result.nextOffset).toBeNull();
  });

  it("sums only the rows on the page", () => {
    const all = receipts(4).map((r) => ({ ...r, amount: "2" }));
    const page = buildReceiptExport(all, { format: "json", limit: 3 }, NOW, "testnet");
    expect(page.totalAmount).toBe("6");
  });

  it("rejects a negative offset", () => {
    expect(() => normalizeReceiptExportOptions({ offset: -1 })).toThrow(/offset/);
  });

  it("rejects a non-integer offset", () => {
    expect(() => normalizeReceiptExportOptions({ offset: 1.5 })).toThrow(/offset/);
  });
});
