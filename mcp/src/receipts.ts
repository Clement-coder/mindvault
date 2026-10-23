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
import { listPurchases, profileOf, type PurchaseReceipt } from "./purchaseHistory.js";
import { sumUsdc, trimUsdc } from "./usdcAmount.js";

/** Schema identifier carried by every export, so consumers can version-check. */
export const RECEIPT_EXPORT_SCHEMA = "mindvault.receipt-export/v1";

/** The only currency the vault settles in today; stated explicitly in exports. */
export const RECEIPT_CURRENCY = "USDC";

/** Upper bound on rows per export, mirroring the catalog's bounded pages. */
export const RECEIPT_EXPORT_MAX_LIMIT = 500;

/**
 * Every field a receipt row can carry, in a stable order.
 *
 * This is the set `fields` selects from, the set CSV renders (in this order),
 * and the set the advertised row schema describes. Kept separate from
 * {@link RECEIPT_CSV_COLUMNS} only historically; they are the same list.
 */
export const RECEIPT_ROW_FIELDS = [
  "resourceId",
  "title",
  "amount",
  "currency",
  "network",
  "purchasedAt",
  "txHash",
  "receiptRef",
  "explorerUrl",
  "profile",
] as const;

export type ReceiptRowField = (typeof RECEIPT_ROW_FIELDS)[number];

/**
 * Fields excluded from an export unless the caller opts in.
 *
 * A receipt is a document that leaves the session — pasted into a ticket,
 * committed to a repo, handed to a reconciler. `profile` names the local
 * wallet the purchase was made under, which is a stable identifier for the
 * buyer across imports; exporting it by default would leak that identity into
 * every reconciliation artifact. It is present only when requested through
 * `fields` (or `includeSensitive: true`).
 */
export const RECEIPT_SENSITIVE_FIELDS: readonly ReceiptRowField[] = ["profile"];

/** Default column order for CSV output. Stable — consumers may index by position. */
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

/** Grouping dimension for receipt summaries. */
export type ReceiptExportGrouping = "month";

/** Per-month receipt summary used when groupBy is "month". */
export interface MonthlyReceiptSummary {
  /** UTC month in YYYY-MM format. */
  month: string;
  count: number;
  totalAmount: string;
  currency: typeof RECEIPT_CURRENCY;
}

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
  /**
   * Local wallet profile the purchase was made under (#584), or the
   * {@link UNSCOPED_PROFILE} sentinel. Sensitive: present only when the caller
   * selects it (see {@link RECEIPT_SENSITIVE_FIELDS}).
   */
  profile?: string | null;
}

/** One row of an export after field selection; only the chosen keys are present. */
export type SelectedReceiptRow = Partial<Record<ReceiptRowField, string | null>>;

/** Filters echoed back in the envelope so an export is self-describing. */
export interface ReceiptExportFilters {
  resourceId: string | null;
  network: string | null;
  since: string | null;
  until: string | null;
  limit: number | null;
  offset: number | null;
  groupBy: ReceiptExportGrouping | null;
}

export interface ReceiptExport {
  schema: typeof RECEIPT_EXPORT_SCHEMA;
  /** ISO-8601 instant the export was produced. */
  generatedAt: string;
  format: ReceiptExportFormat;
  filters: ReceiptExportFilters;
  /** Row fields this export carries, in the order they were selected. */
  fields: ReceiptRowField[];
  count: number;
  /** Number of matching rows before pagination — larger than `count` when a page is partial. */
  totalMatching: number;
  /**
   * Offset to pass as `offset` on the next call to resume after this page, or
   * null when this page is the last. Lets a caller walk an export larger than
   * {@link RECEIPT_EXPORT_MAX_LIMIT} safely across calls.
   */
  nextOffset: number | null;
  /** Sum of `amount` across the exported rows, as a decimal string. */
  totalAmount: string;
  currency: typeof RECEIPT_CURRENCY;
  receipts: SelectedReceiptRow[];
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
  /** Rows to skip from the newest-first result, for resumable paging. */
  offset?: number;
  groupBy?: ReceiptExportGrouping;
  /** Row fields to include, in order. Defaults to every non-sensitive field. */
  fields?: ReceiptRowField[];
  /** Include sensitive fields (e.g. `profile`) even when `fields` omits them. */
  includeSensitive?: boolean;
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

  let offset: number | undefined;
  if (raw.offset !== undefined && raw.offset !== null && raw.offset !== "") {
    const n = typeof raw.offset === "number" ? raw.offset : Number(String(raw.offset).trim());
    if (!Number.isInteger(n) || n < 0) {
      throw new ReceiptExportError(
        "Invalid offset: must be an integer >= 0 (a row count to skip, from the newest receipt).",
      );
    }
    offset = n;
  }

  const includeSensitive = parseBooleanArg(raw, "includeSensitive");
  const fields = parseFieldSelection(raw);

  return {
    format,
    ...(resourceId ? { resourceId } : {}),
    ...(network ? { network } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(fields ? { fields } : {}),
    ...(includeSensitive ? { includeSensitive } : {}),
  };
}

/** Parse a permissive boolean flag, rejecting anything else deterministically. */
function parseBooleanArg(args: Record<string, unknown>, field: string): boolean {
  const value = args[field];
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) return true;
    if (FALSE_STRINGS.has(normalized)) return false;
  }
  throw new ReceiptExportError(`Invalid ${field}: expected a boolean (true/false).`);
}

const TRUE_STRINGS = new Set(["true", "1", "yes", "on"]);
const FALSE_STRINGS = new Set(["false", "0", "no", "off"]);

/**
 * Parse the `fields` selection into a stable, de-duplicated field list.
 *
 * Accepts a comma-separated string or an array. Naming a sensitive field is
 * itself an explicit opt-in, so it is honoured here; `includeSensitive` is for
 * keeping sensitive fields when no `fields` list is given at all.
 */
function parseFieldSelection(args: Record<string, unknown>): ReceiptRowField[] | undefined {
  const value = args.fields;
  if (value === undefined || value === null || value === "") return undefined;

  let raw: string[];
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      throw new ReceiptExportError("Invalid fields: expected an array of field-name strings.");
    }
    raw = value as string[];
  } else if (typeof value === "string") {
    raw = value.split(",");
  } else {
    throw new ReceiptExportError(
      "Invalid fields: expected a comma-separated string or an array of field names.",
    );
  }

  const known = new Set<string>(RECEIPT_ROW_FIELDS);
  const selected: ReceiptRowField[] = [];
  for (const entry of raw) {
    const name = entry.trim();
    if (!name) continue;
    if (!known.has(name)) {
      throw new ReceiptExportError(
        `Invalid fields: unknown field "${name}". Known fields: ${RECEIPT_ROW_FIELDS.join(", ")}.`,
      );
    }
    const field = name as ReceiptRowField;
    if (!selected.includes(field)) selected.push(field);
  }

  if (selected.length === 0) {
    throw new ReceiptExportError("Invalid fields: expected at least one field name.");
  }

  return selected;
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
    profile: profileOf(receipt),
  };
}

/**
 * Keep only the selected fields of a row, in the selection's order.
 *
 * Rows are built with every field and projected here, so `fields` selection and
 * the sensitive-field default are one code path: a field that was never
 * selected — including `profile` unless asked for — is absent from the output,
 * not null.
 */
export function selectReceiptFields(
  row: ExportedReceipt,
  fields: readonly ReceiptRowField[],
): SelectedReceiptRow {
  const projected: SelectedReceiptRow = {};
  for (const field of fields) projected[field] = row[field] ?? null;
  return projected;
}

/**
 * The fields an export carries when the caller does not select any.
 *
 * Every row field except the sensitive ones, in {@link RECEIPT_ROW_FIELDS}
 * order. `includeSensitive` widens this to the full set.
 */
export function defaultReceiptFields(includeSensitive: boolean): ReceiptRowField[] {
  return RECEIPT_ROW_FIELDS.filter(
    (field) => includeSensitive || !RECEIPT_SENSITIVE_FIELDS.includes(field),
  );
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
  const raw = value ?? "";
  const lineSafe = raw.replace(/\r\n/g, "\\r\\n").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const text = /^\s*[=+\-@]/.test(lineSafe) ? `'${lineSafe}` : lineSafe;
  return forceQuote || /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render export rows as an RFC 4180 CSV document with a header row. */
export function receiptsToCsv(
  receipts: SelectedReceiptRow[],
  columns: readonly ReceiptRowField[] = RECEIPT_CSV_COLUMNS,
): string {
  const lines = [columns.join(",")];
  for (const receipt of receipts) {
    lines.push(
      columns.map((column) => csvField(receipt[column] ?? null, column === "currency")).join(","),
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
export function receiptsToNdjson(receipts: SelectedReceiptRow[]): string {
  return receipts.map((receipt) => JSON.stringify(receipt)).join("\n");
}

/**
 * The rows a set of filters matches, newest-first, before pagination.
 *
 * Date bounds are inclusive; a missing bound is no bound. Split out from
 * {@link buildReceiptExport} so the page window and the "rows remaining" count
 * are computed from the same list.
 */
function matchingRows(
  receipts: ExportedReceipt[],
  options: ReceiptExportOptions,
): ExportedReceipt[] {
  let rows = receipts;
  if (options.since) rows = rows.filter((r) => r.purchasedAt >= options.since!);
  if (options.until) rows = rows.filter((r) => r.purchasedAt <= options.until!);
  return rows;
}

/** Group exported receipts by UTC calendar month, newest month first. */
export function groupReceiptsByMonth(receipts: ExportedReceipt[]): MonthlyReceiptSummary[] {
  const byMonth = new Map<string, ExportedReceipt[]>();
  for (const r of receipts) {
    const month = r.purchasedAt.slice(0, 7); // "YYYY-MM"
    const bucket = byMonth.get(month) ?? [];
    bucket.push(r);
    byMonth.set(month, bucket);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([month, rows]) => ({
      month,
      count: rows.length,
      totalAmount: sumAmounts(rows),
      currency: RECEIPT_CURRENCY,
    }));
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
  const all = matchingRows(
    receipts.map((receipt) => toExportedReceipt(receipt, explorerNetwork)),
    options,
  );

  const offset = options.offset ?? 0;
  const afterOffset = all.slice(offset);
  const page = options.limit !== undefined ? afterOffset.slice(0, options.limit) : afterOffset;
  const nextOffset = offset + page.length < all.length ? offset + page.length : null;

  const fields = options.fields
    ? [...options.fields]
    : defaultReceiptFields(options.includeSensitive ?? false);

  const projected = page.map((row) => selectReceiptFields(row, fields));

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
      offset: options.offset ?? null,
      groupBy: options.groupBy ?? null,
    },
    fields,
    count: page.length,
    totalMatching: all.length,
    nextOffset,
    totalAmount: sumAmounts(page),
    currency: RECEIPT_CURRENCY,
    receipts: projected,
    ...(options.groupBy === "month" ? { monthlySummaries: groupReceiptsByMonth(page) } : {}),
    ...(options.format === "csv" ? { csv: receiptsToCsv(projected, fields) } : {}),
    ...(options.format === "ndjson" ? { ndjson: receiptsToNdjson(projected) } : {}),
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
    throw new Error(
      `Request timed out after ${timeoutMs}ms (http). Configure mindvault_export_receipts in MINDVAULT_TOOL_TIMEOUTS.`,
    );
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
        offset: { type: ["integer", "null"] },
        groupBy: { type: ["string", "null"], enum: ["month", null] },
      },
      required: ["resourceId", "network", "since", "until", "limit", "offset", "groupBy"],
    },
    fields: {
      type: "array",
      description: "Row fields carried by this export, in selection order.",
      items: { type: "string", enum: [...RECEIPT_ROW_FIELDS] },
    },
    count: { type: "integer", description: "Number of receipts on this page." },
    totalMatching: {
      type: "integer",
      description:
        "Rows matching the filters before pagination; larger than count on a partial page.",
    },
    nextOffset: {
      type: ["integer", "null"],
      description: "Offset to pass on the next call to resume, or null when this is the last page.",
    },
    totalAmount: {
      type: "string",
      description: "Sum of the exported amounts as a decimal string.",
    },
    currency: { type: "string", const: RECEIPT_CURRENCY },
    receipts: {
      type: "array",
      description:
        "One object per receipt, carrying only the selected fields (every field except sensitive ones by default).",
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
          profile: {
            type: ["string", "null"],
            description:
              "Local wallet profile the purchase was made under. Sensitive — present only when selected.",
          },
        },
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
    "fields",
    "count",
    "totalMatching",
    "nextOffset",
    "totalAmount",
    "currency",
    "receipts",
  ],
} as const;
