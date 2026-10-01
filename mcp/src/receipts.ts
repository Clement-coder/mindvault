/**
 * Structured receipt export for purchased resources.
 *
 * `mindvault_buy` already records a local receipt per purchase (see
 * purchaseHistory.ts) and `mindvault_purchase_history` lists them. That listing
 * is a browsing aid: it emits whatever fields happen to be stored, with no
 * stable schema, no totals, and no way to hand the result to anything but
 * another agent turn.
 *
 * An export is a different artifact. An agent reconciling spend, or a human
 * filing what an agent bought, needs a document with a declared schema, a fixed
 * column order, an explicit currency and total, and a date range it can state.
 * This module builds exactly that from the stored receipts:
 *
 *   - one versioned envelope (`RECEIPT_EXPORT_SCHEMA`) whose shape is also
 *     advertised as the tool's `outputSchema`, so clients can validate it and
 *     the server can return it as `structuredContent` (MCP 2025-06-18);
 *   - a normalized receipt row per purchase, with the explorer link resolved;
 *   - RFC 4180 CSV of those same rows, for spreadsheets and ledgers.
 *
 * The module is pure apart from reading the receipt store: no network, no
 * writes, no process state. Every failure is a deterministic, agent-safe
 * message naming the offending argument.
 */

import { type ExplorerNetwork } from "@mindvault/registry-client";
import { explorerTxUrl, resolveExplorerNetwork } from "./stellarExplorer.js";
import { listPurchases, type PurchaseReceipt } from "./purchaseHistory.js";
import { sumUsdc, trimUsdc } from "./usdcAmount.js";

/** Schema identifier carried by every export, so consumers can version-check. */
export const RECEIPT_EXPORT_SCHEMA = "mindvault.receipt-export/v1";

/** The only currency the vault settles in today; stated explicitly in exports. */
export const RECEIPT_CURRENCY = "USDC";

/** Upper bound on rows per export, mirroring the catalog's bounded pages. */
export const RECEIPT_EXPORT_MAX_LIMIT = 500;

/** Column order for CSV output. Stable — consumers may index by position. */
export const RECEIPT_CSV_COLUMNS = [
  "resourceId",
  "title",
  "amount",
  "currency",
  "network",
  "purchasedAt",
  "txHash",
  "receiptRef",
  "explorerUrl",
] as const;

export type ReceiptExportFormat = "json" | "csv" | "ndjson";

/** One purchase, normalized for export. Absent values are explicit nulls. */
export interface ExportedReceipt {
  resourceId: string;
  title: string | null;
  amount: string;
  currency: typeof RECEIPT_CURRENCY;
  network: string;
  /** ISO-8601 instant the receipt was recorded. */
  purchasedAt: string;
  txHash: string | null;
  /** Server-side payment id, when the delivery response carried one. */
  receiptRef: string | null;
  /** Stellar Expert link for `txHash`, or null when there is no hash. */
  explorerUrl: string | null;
}

/** Filters echoed back in the envelope so an export is self-describing. */
export interface ReceiptExportFilters {
  resourceId: string | null;
  network: string | null;
  since: string | null;
  until: string | null;
  limit: number | null;
  groupBy: ReceiptExportGrouping | null;
}

export interface ReceiptExport {
  schema: typeof RECEIPT_EXPORT_SCHEMA;
  /** ISO-8601 instant the export was produced. */
  generatedAt: string;
  format: ReceiptExportFormat;
  filters: ReceiptExportFilters;
  count: number;
  /** Sum of `amount` across the exported rows, as a decimal string. */
  totalAmount: string;
  currency: typeof RECEIPT_CURRENCY;
  receipts: ExportedReceipt[];
  /** Per-month totals, newest month first, when groupBy is "month". */
  monthlySummaries?: MonthlyReceiptSummary[];
  /** RFC 4180 document of the same rows — present only when format is "csv". */
  csv?: string;
  /** Newline-Delimited JSON document of the same rows — present only when format is "ndjson". */
  ndjson?: string;
}

export class ReceiptExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptExportError";
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export interface ReceiptExportOptions {
  format: ReceiptExportFormat;
  resourceId?: string;
  network?: string;
  /** Inclusive lower bound on `purchasedAt`. */
  since?: string;
  /** Inclusive upper bound on `purchasedAt`. */
  until?: string;
  limit?: number;
  groupBy?: ReceiptExportGrouping;
}

function optionalTrimmed(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ReceiptExportError(`Invalid ${field}: expected a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new ReceiptExportError(`Invalid ${field}: expected a non-empty string.`);
  return trimmed;
}

/**
 * Parse an ISO-8601 date or date-time bound.
 *
 * A bare date (`2026-08-01`) is accepted and read as midnight UTC, because that
 * is what an agent asked for a month of receipts will send.
 */
function parseBound(args: Record<string, unknown>, field: string): string | undefined {
  const raw = optionalTrimmed(args, field);
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new ReceiptExportError(
      `Invalid ${field}: expected an ISO-8601 date or timestamp, e.g. "2026-08-01" or "2026-08-01T12:00:00Z".`,
    );
  }
  return new Date(ms).toISOString();
}

/** Normalize the tool's arguments, rejecting bad values deterministically. */
export function normalizeReceiptExportOptions(
  args: Record<string, unknown> | undefined,
): ReceiptExportOptions {
  const raw = args ?? {};

  let format: ReceiptExportFormat = "json";
  if (raw.format !== undefined && raw.format !== null && raw.format !== "") {
    if (raw.format !== "json" && raw.format !== "csv" && raw.format !== "ndjson") {
      throw new ReceiptExportError('Invalid format: must be "json", "csv", or "ndjson".');
    }
    format = raw.format;
  }

  const since = parseBound(raw, "since");
  const until = parseBound(raw, "until");
  if (since && until && since > until) {
    throw new ReceiptExportError("Invalid date range: since cannot be later than until.");
  }

  let limit: number | undefined;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== "") {
    const n = typeof raw.limit === "number" ? raw.limit : Number(String(raw.limit).trim());
    if (!Number.isInteger(n) || n < 1 || n > RECEIPT_EXPORT_MAX_LIMIT) {
      throw new ReceiptExportError(
        `Invalid limit: must be an integer between 1 and ${RECEIPT_EXPORT_MAX_LIMIT}.`,
      );
    }
    limit = n;
  }

  const resourceId = optionalTrimmed(raw, "resourceId");
  const network = optionalTrimmed(raw, "network");
  let groupBy: ReceiptExportGrouping | undefined;
  if (raw.groupBy !== undefined && raw.groupBy !== null && raw.groupBy !== "") {
    if (raw.groupBy !== "month") {
      throw new ReceiptExportError('Invalid groupBy: must be "month".');
    }
    groupBy = raw.groupBy;
  }

  return {
    format,
    ...(resourceId ? { resourceId } : {}),
    ...(network ? { network } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(groupBy ? { groupBy } : {}),
  };
}

// ── Export building ───────────────────────────────────────────────────────────

/** Normalize one stored receipt into an export row. */
export function toExportedReceipt(
  receipt: PurchaseReceipt,
  network: ExplorerNetwork,
): ExportedReceipt {
  return {
    resourceId: receipt.resourceId,
    title: receipt.title ?? null,
    amount: receipt.amount,
    currency: RECEIPT_CURRENCY,
    network: receipt.network,
    purchasedAt: receipt.timestamp,
    txHash: receipt.txHash,
    receiptRef: receipt.receiptRef,
    explorerUrl: explorerTxUrl(receipt.txHash, network),
  };
}

/**
 * Sum amounts as a decimal string.
 *
 * Amounts are USDC with at most 7 decimals, so the sum is accumulated in
 * integer stroops and only then rendered — floating-point addition of decimal
 * strings would produce totals like `0.30000000000000004` in an export people
 * reconcile against a bank. Rows whose amount is not a number (an older receipt
 * recorded before the price was known) contribute nothing.
 */
export function sumAmounts(receipts: ExportedReceipt[]): string {
  const total = sumUsdc(receipts.map((r) => r.amount));
  return trimUsdc(total) || "0";
}

/** Quote one CSV field per RFC 4180 (double the quotes, wrap when needed). */
function csvField(value: string | null, forceQuote = false): string {
  const text = value ?? "";
  return forceQuote || /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render export rows as an RFC 4180 CSV document with a header row. */
export function receiptsToCsv(receipts: ExportedReceipt[]): string {
  const lines = [RECEIPT_CSV_COLUMNS.join(",")];
  for (const receipt of receipts) {
    lines.push(
      RECEIPT_CSV_COLUMNS.map((column) => csvField(receipt[column], column === "currency")).join(","),
    );
  }
  return lines.join("\r\n");
}

/**
 * Render export rows as an NDJSON document (Newline-Delimited JSON).
 *
 * Each row is a self-contained JSON object on its own line, making the format
 * easy to stream, grep, or feed line-by-line into another process. An empty
 * export produces an empty string (no newline), consistent with how tools like
 * `jq --raw-input` handle an empty NDJSON file.
 */
export function receiptsToNdjson(receipts: ExportedReceipt[]): string {
  return receipts.map((receipt) => JSON.stringify(receipt)).join("\n");
}

/** Apply the date range and row cap to receipts already sorted newest-first. */
function applyBounds(
  receipts: ExportedReceipt[],
  options: ReceiptExportOptions,
): ExportedReceipt[] {
  let rows = receipts;
  if (options.since) rows = rows.filter((r) => r.purchasedAt >= options.since!);
  if (options.until) rows = rows.filter((r) => r.purchasedAt <= options.until!);
  return options.limit !== undefined ? rows.slice(0, options.limit) : rows;
}

/**
 * Build the export envelope from stored receipts.
 *
 * `now` and `explorerNetwork` are injected so the output is fully deterministic
 * under test.
 */
export function buildReceiptExport(
  receipts: PurchaseReceipt[],
  options: ReceiptExportOptions,
  now: Date = new Date(),
  explorerNetwork: ExplorerNetwork = resolveExplorerNetwork(),
): ReceiptExport {
  const rows = applyBounds(
    receipts.map((receipt) => toExportedReceipt(receipt, explorerNetwork)),
    options,
  );

  return {
    schema: RECEIPT_EXPORT_SCHEMA,
    generatedAt: now.toISOString(),
    format: options.format,
    filters: {
      resourceId: options.resourceId ?? null,
      network: options.network ?? null,
      since: options.since ?? null,
      until: options.until ?? null,
      limit: options.limit ?? null,
      groupBy: options.groupBy ?? null,
    },
    count: rows.length,
    totalAmount: sumAmounts(rows),
    currency: RECEIPT_CURRENCY,
    receipts: rows,
    ...(options.groupBy === "month" ? { monthlySummaries: groupReceiptsByMonth(rows) } : {}),
    ...(options.format === "csv" ? { csv: receiptsToCsv(rows) } : {}),
    ...(options.format === "ndjson" ? { ndjson: receiptsToNdjson(rows) } : {}),
  };
}

/**
 * Tool entrypoint: read the local receipt store, apply the filters, and return
 * the export envelope as JSON text.
 *
 * The envelope is returned for both formats — a CSV export carries the document
 * in its `csv` field — so one advertised `outputSchema` describes every result
 * and the server can hand the same object back as `structuredContent`.
 */
export function exportReceiptsTool(args?: Record<string, unknown>): string {
  const options = normalizeReceiptExportOptions(args);
  const stored = listPurchases({
    ...(options.resourceId ? { resourceId: options.resourceId } : {}),
    ...(options.network ? { network: options.network } : {}),
  });
  return JSON.stringify(buildReceiptExport(stored, options), null, 2);
}

export function exportReceiptsToolWithTimeout(
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
): string {
  if (timeoutMs <= 0) return exportReceiptsTool(args);
  const started = Date.now();
  const result = exportReceiptsTool(args);
  if (Date.now() - started > timeoutMs) {
    throw new Error(`Request timed out after ${timeoutMs}ms (http). Configure mindvault_export_receipts in MINDVAULT_TOOL_TIMEOUTS.`);
  }
  return result;
}

/**
 * JSON Schema for the export envelope, advertised as the tool's `outputSchema`.
 *
 * Per the MCP tools specification, a tool that declares an output schema MUST
 * return structured results conforming to it — which is why the CSV document is
 * a field of the envelope rather than a second, differently-shaped result.
 */
export const RECEIPT_EXPORT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: RECEIPT_EXPORT_SCHEMA },
    generatedAt: { type: "string", description: "ISO-8601 instant the export was produced." },
    format: { type: "string", enum: ["json", "csv", "ndjson"] },
    filters: {
      type: "object",
      description: "The filters this export was produced with; null where unset.",
      properties: {
        resourceId: { type: ["string", "null"] },
        network: { type: ["string", "null"] },
        since: { type: ["string", "null"] },
        until: { type: ["string", "null"] },
        limit: { type: ["integer", "null"] },
        groupBy: { type: ["string", "null"], enum: ["month", null] },
      },
      required: ["resourceId", "network", "since", "until", "limit", "groupBy"],
    },
    count: { type: "integer", description: "Number of exported receipts." },
    totalAmount: {
      type: "string",
      description: "Sum of the exported amounts as a decimal string.",
    },
    currency: { type: "string", const: RECEIPT_CURRENCY },
    receipts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resourceId: { type: "string" },
          title: { type: ["string", "null"] },
          amount: { type: "string" },
          currency: { type: "string", const: RECEIPT_CURRENCY },
          network: { type: "string" },
          purchasedAt: { type: "string" },
          txHash: { type: ["string", "null"] },
          receiptRef: { type: ["string", "null"] },
          explorerUrl: { type: ["string", "null"] },
        },
        required: [
          "resourceId",
          "title",
          "amount",
          "currency",
          "network",
          "purchasedAt",
          "txHash",
          "receiptRef",
          "explorerUrl",
        ],
      },
    },
    monthlySummaries: {
      type: "array",
      description: 'UTC monthly totals, present only when groupBy is "month".',
      items: {
        type: "object",
        properties: {
          month: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}$" },
          count: { type: "integer" },
          totalAmount: { type: "string" },
          currency: { type: "string", const: RECEIPT_CURRENCY },
        },
        required: ["month", "count", "totalAmount", "currency"],
      },
    },
    csv: {
      type: "string",
      description: 'RFC 4180 document of the same rows. Present only when format is "csv".',
    },
    ndjson: {
      type: "string",
      description:
        'Newline-Delimited JSON document of the same rows. Present only when format is "ndjson".',
    },
  },
  required: [
    "schema",
    "generatedAt",
    "format",
    "filters",
    "count",
    "totalAmount",
    "currency",
    "receipts",
  ],
} as const;
