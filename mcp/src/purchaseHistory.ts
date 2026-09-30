/**
 * Local purchase receipt store for the MindVault MCP server.
 *
 * Successful buys can append receipts under ~/.mindvault/purchases.json.
 * The mindvault_purchase_history tool reads this store with optional filters
 * by resource id and network. Errors are deterministic and agent-safe.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export const PURCHASE_HISTORY_VERSION = 1 as const;

/**
 * Identity of the state file the receipts belong to. `mindvault_reset` rewrites
 * the state file, so a backup restored over it would otherwise merge a different
 * wallet's receipts into this one (#846).
 */
export const PURCHASE_HISTORY_EPOCH = process.env.MINDVAULT_PURCHASES_EPOCH ?? "";

/** One locally persisted purchase receipt. */
export interface PurchaseReceipt {
  /** Resource that was purchased. */
  resourceId: string;
  /** USDC amount paid (decimal string). */
  amount: string;
  /** x402 / Stellar network id (e.g. stellar:testnet). */
  network: string;
  /** On-chain payment tx hash when known. */
  txHash: string | null;
  /** ISO-8601 timestamp when the receipt was recorded. */
  timestamp: string;
  /** Server payment id / receipt reference when present. */
  receiptRef: string | null;
  /** Optional resource title for agent-friendly listing. */
  title?: string;
  /**
   * Wallet profile the purchase was made under (#584).
   *
   * Optional because receipts written before this field existed do not have
   * one. Those are reported as {@link UNSCOPED_PROFILE} rather than being
   * attributed to whichever profile happens to be active now — the wallet that
   * paid is not recoverable after the fact, and guessing would put a purchase
   * in the wrong account's history.
   */
  profile?: string;
}

/**
 * Stands in for the profile of a receipt written before profiles were
 * recorded. Also accepted as a filter value, so those receipts remain findable.
 */
export const UNSCOPED_PROFILE = "(unscoped)";

export interface PurchaseHistoryFilter {
  resourceId?: string;
  network?: string;
  /** Case-insensitive free-text match against resource id or title. */
  query?: string;
  /**
   * Wallet profile to scope to (#584). Pass {@link UNSCOPED_PROFILE} to find
   * receipts recorded before profiles were tracked.
   */
  profile?: string;
}

export interface PurchaseHistoryFile {
  version: typeof PURCHASE_HISTORY_VERSION;
  /** State-file epoch the receipts were recorded under; a mismatch is dropped (#846). */
  epoch?: string;
  purchases: PurchaseReceipt[];
}

export class PurchaseHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseHistoryError";
  }
}

const DEFAULT_FILE = join(homedir(), ".mindvault", "purchases.json");

/** Override path for tests; null restores the default. */
let purchasesFileOverride: string | null = null;

/** Test helper: point the store at a temp file (or reset with null). */
export function _setPurchasesFilePath(path: string | null): void {
  purchasesFileOverride = path;
}

export function purchasesFilePath(): string {
  return purchasesFileOverride ?? process.env.MINDVAULT_PURCHASES_FILE ?? DEFAULT_FILE;
}

function emptyStore(): PurchaseHistoryFile {
  return { version: PURCHASE_HISTORY_VERSION, epoch: PURCHASE_HISTORY_EPOCH, purchases: [] };
}

function isReceipt(value: unknown): value is PurchaseReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.resourceId === "string" &&
    typeof r.amount === "string" &&
    typeof r.network === "string" &&
    typeof r.timestamp === "string" &&
    (r.txHash === null || typeof r.txHash === "string") &&
    (r.receiptRef === null || typeof r.receiptRef === "string") &&
    (r.profile === undefined || typeof r.profile === "string")
  );
}

/** Load the purchase store. Corrupted / missing files yield an empty history. */
export function loadPurchaseHistory(): PurchaseHistoryFile {
  const file = purchasesFilePath();
  if (!existsSync(file)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.purchases)) {
      return emptyStore();
    }
    // Receipts from a previous state file (pre-reset or a restored backup) are
    // a different wallet's history; never merge them into the active one (#846).
    if ((raw.epoch ?? "") !== PURCHASE_HISTORY_EPOCH) {
      return emptyStore();
    }
    const purchases = raw.purchases.filter(isReceipt);
    return { version: PURCHASE_HISTORY_VERSION, purchases };
  } catch {
    return emptyStore();
  }
}

function persist(store: PurchaseHistoryFile): void {
  const file = purchasesFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * Append a purchase receipt. Does not throw on I/O failure — callers that need
 * hard failures should wrap persist themselves; buy paths must stay resilient.
 */
export function recordPurchase(
  input: Omit<PurchaseReceipt, "timestamp"> & { timestamp?: string },
): PurchaseReceipt {
  if (!input.resourceId || typeof input.resourceId !== "string") {
    throw new PurchaseHistoryError("resourceId is required to record a purchase receipt.");
  }
  if (typeof input.amount !== "string") {
    throw new PurchaseHistoryError("amount must be a string (USDC decimal).");
  }
  if (!input.network || typeof input.network !== "string") {
    throw new PurchaseHistoryError("network is required to record a purchase receipt.");
  }

  const receipt: PurchaseReceipt = {
    resourceId: input.resourceId,
    amount: input.amount,
    network: input.network,
    txHash: input.txHash ?? null,
    timestamp: input.timestamp ?? new Date().toISOString(),
    receiptRef: input.receiptRef ?? null,
    ...(input.title ? { title: input.title } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
  };

  const store = loadPurchaseHistory();
  store.purchases.push(receipt);
  persist(store);
  return receipt;
}

/** Normalize optional filter args; reject non-string values deterministically. */
export function normalizePurchaseHistoryFilter(
  args: Record<string, unknown> | undefined,
): PurchaseHistoryFilter {
  if (!args) return {};
  const filter: PurchaseHistoryFilter = {};

  if (args.resourceId !== undefined && args.resourceId !== null && args.resourceId !== "") {
    if (typeof args.resourceId !== "string") {
      throw new PurchaseHistoryError("Invalid resourceId filter: expected a string resource id.");
    }
    filter.resourceId = args.resourceId.trim();
    if (!filter.resourceId) {
      throw new PurchaseHistoryError("Invalid resourceId filter: expected a non-empty string.");
    }
  }

  if (args.profile !== undefined && args.profile !== null && args.profile !== "") {
    if (typeof args.profile !== "string") {
      throw new PurchaseHistoryError(
        "Invalid profile filter: expected a string profile name (e.g. buyer.alice).",
      );
    }
    filter.profile = args.profile.trim();
    if (!filter.profile) {
      throw new PurchaseHistoryError("Invalid profile filter: expected a non-empty string.");
    }
  }

  if (args.network !== undefined && args.network !== null && args.network !== "") {
    if (typeof args.network !== "string") {
      throw new PurchaseHistoryError(
        "Invalid network filter: expected a string (e.g. stellar:testnet).",
      );
    }
    filter.network = args.network.trim();
    if (!filter.network) {
      throw new PurchaseHistoryError(
        "Invalid network filter: expected a non-empty string (e.g. stellar:testnet).",
      );
    }
  }

  if (args.query !== undefined && args.query !== null && args.query !== "") {
    if (typeof args.query !== "string") {
      throw new PurchaseHistoryError("Invalid query filter: expected a string.");
    }
    filter.query = args.query.trim();
    if (!filter.query) {
      throw new PurchaseHistoryError("Invalid query filter: expected a non-empty string.");
    }
  }

  return filter;
}

/**
 * List receipts newest-first, optionally filtered by resourceId and/or network
 * (exact, case-sensitive match).
 */
export function listPurchases(filter: PurchaseHistoryFilter = {}): PurchaseReceipt[] {
  const { purchases } = loadPurchaseHistory();
  const filtered = purchases.filter((p) => {
    if (filter.resourceId && p.resourceId !== filter.resourceId) return false;
    if (filter.network && p.network !== filter.network) return false;
    if (filter.profile && profileOf(p) !== filter.profile) return false;
    if (filter.query) {
      const query = filter.query.toLocaleLowerCase();
      if (
        !p.resourceId.toLocaleLowerCase().includes(query) &&
        !(p.title ?? "").toLocaleLowerCase().includes(query)
      ) {
        return false;
      }
    }
    return true;
  });
  return filtered.sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
}

/**
 * The profile a receipt belongs to, or {@link UNSCOPED_PROFILE} for one
 * written before the field existed.
 */
export function profileOf(receipt: PurchaseReceipt): string {
  return receipt.profile ?? UNSCOPED_PROFILE;
}

/** Every profile present in the store, sorted — for agent-facing summaries. */
export function purchaseProfiles(): string[] {
  const { purchases } = loadPurchaseHistory();
  return [...new Set(purchases.map(profileOf))].sort();
}

/** Agent-facing formatting for the purchase history tool. */
export function formatPurchaseHistory(
  receipts: PurchaseReceipt[],
  filter: PurchaseHistoryFilter = {},
): string {
  if (receipts.length === 0) {
    // Naming the profile that was searched turns "no results" into something
    // actionable: the usual cause is looking in the wrong profile.
    const scope = filter.profile ? ` in profile "${filter.profile}"` : "";
    return JSON.stringify(
      {
        count: 0,
        purchases: [],
        ...(filter.profile ? { profile: filter.profile } : {}),
        message: `No purchase receipts match the given filters${scope} (or none have been recorded yet).`,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      count: receipts.length,
      ...(filter.profile ? { profile: filter.profile } : {}),
      purchases: receipts,
    },
    null,
    2,
  );
}

/** Read-only tool entrypoint used by the MCP server. */
export function purchaseHistoryTool(args?: Record<string, unknown>): string {
  const filter = normalizePurchaseHistoryFilter(args);
  return formatPurchaseHistory(listPurchases(filter), filter);
}

/** Test helper: wipe the configured purchases file content. */
export function _clearPurchases(): void {
  persist(emptyStore());
}
