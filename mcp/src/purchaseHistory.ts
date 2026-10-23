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
import { explorerTxUrl, resolveExplorerNetwork } from "./stellarExplorer.js";
import type { ExplorerNetwork } from "@mindvault/registry-client";

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
   * Client-generated idempotency key for this purchase attempt (#1027).
   *
   * The buy path derives it once per logical purchase and reuses it across
   * transport reconnects and retries, so a lost response can be resolved to
   * the original receipt instead of paying twice. Optional because receipts
   * written before this field existed do not have one.
   */
  clientIdempotencyKey?: string;
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
  /**
   * Exact match on the client idempotency key of a purchase attempt (#1028).
   * An agent that lost a buy response before a receipt arrived can send the
   * key it already used and see whether that attempt produced a receipt.
   */
  idempotencyKey?: string;
}

/**
 * Lifecycle of a purchase attempt as seen from a locally persisted receipt
 * (#1028). A receipt only exists once the buy response arrived, so the store
 * can distinguish an unknown attempt (no receipt), a settled one (receipt with
 * a tx hash), and a submitted-but-unconfirmed one (receipt without a hash).
 * "failed" is reported when the receipt was recorded for a resource whose
 * settlement is known to have failed.
 */
export type PurchaseStatus = "unknown" | "pending" | "settled" | "failed";

/**
 * Classify a persisted receipt into a purchase status (#1028).
 *
 * The local store is the client's own record: it cannot see an in-flight
 * server payment, so "pending" means "a receipt exists but no on-chain hash
 * was captured" — the honest state for a response that arrived before
 * settlement, or before the hash was available.
 */
export function purchaseStatusOf(receipt: PurchaseReceipt): PurchaseStatus {
  if (receipt.txHash) return "settled";
  return "pending";
}

/** A lookup result for one client idempotency key (#1028). */
export interface PurchaseStatusLookup {
  idempotencyKey: string;
  status: PurchaseStatus;
  /** The matching receipt, or null when no attempt with this key is known. */
  receipt: PurchaseReceipt | null;
  message: string;
}

/**
 * Resolve a purchase attempt by its client idempotency key (#1028).
 *
 * Lookup is scoped to the active profile: a receipt recorded under another
 * profile is never returned, so one buyer cannot read another's purchase. An
 * unknown key yields an explicit "unknown" result rather than an empty list,
 * so an agent that lost a response learns whether the attempt is recoverable.
 */
export function lookupPurchaseByIdempotencyKey(
  idempotencyKey: string,
  options: { profile?: string; now?: () => PurchaseReceipt[] } = {},
): PurchaseStatusLookup {
  const key = (idempotencyKey ?? "").trim();
  if (!key) {
    throw new PurchaseHistoryError(
      "idempotencyKey is required to look up a purchase attempt. Pass the key you sent with mindvault_buy.",
    );
  }
  const receipts = (options.now ?? listPurchases)().filter((r) => r.clientIdempotencyKey === key);
  const scoped = options.profile
    ? receipts.filter((r) => profileOf(r) === options.profile)
    : receipts;
  const match = scoped[0] ?? null;

  if (!match) {
    return {
      idempotencyKey: key,
      status: "unknown",
      receipt: null,
      message:
        "No purchase attempt with this idempotency key is recorded for this profile. " +
        "If the original response was lost, the payment may still be in flight; check mindvault_tx_status, or retry mindvault_buy with the same key.",
    };
  }

  const status = purchaseStatusOf(match);
  return {
    idempotencyKey: key,
    status,
    receipt: match,
    message:
      status === "settled"
        ? `Resolved to the original receipt (tx ${match.txHash}). Do not pay again.`
        : "A receipt exists but no settlement hash was recorded. Check mindvault_tx_status before retrying.",
  };
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

/** `null`, a string, or absent — the stored forms of a nullable receipt field. */
function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isReceipt(value: unknown): value is PurchaseReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.resourceId === "string" &&
    typeof r.amount === "string" &&
    typeof r.network === "string" &&
    typeof r.timestamp === "string" &&
    isNullableString(r.txHash) &&
    isNullableString(r.receiptRef) &&
    (r.profile === undefined || typeof r.profile === "string")
  );
}

/**
 * `txHash` and `receiptRef` are nullable, never optional, in the published
 * schemas (#1065). A receipt written without one (hand-edited, or by an older
 * build that serialized `undefined`) used to be dropped from the history
 * entirely; it is kept, with the missing value read back as `null`.
 */
function normalizeStoredReceipt(r: PurchaseReceipt): PurchaseReceipt {
  return { ...r, txHash: r.txHash ?? null, receiptRef: r.receiptRef ?? null };
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
    const purchases = raw.purchases.filter(isReceipt).map(normalizeStoredReceipt);
    // Keep the epoch: `recordPurchase` persists what this returns, and a store
    // written back without it reads as a different epoch next time, which
    // would discard every receipt recorded so far.
    return { version: PURCHASE_HISTORY_VERSION, epoch: PURCHASE_HISTORY_EPOCH, purchases };
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
    ...(input.clientIdempotencyKey ? { clientIdempotencyKey: input.clientIdempotencyKey } : {}),
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

  if (
    args.idempotencyKey !== undefined &&
    args.idempotencyKey !== null &&
    args.idempotencyKey !== ""
  ) {
    if (typeof args.idempotencyKey !== "string") {
      throw new PurchaseHistoryError(
        "Invalid idempotencyKey filter: expected a string idempotency key.",
      );
    }
    filter.idempotencyKey = args.idempotencyKey.trim();
    if (!filter.idempotencyKey) {
      throw new PurchaseHistoryError("Invalid idempotencyKey filter: expected a non-empty string.");
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
    if (filter.idempotencyKey && p.clientIdempotencyKey !== filter.idempotencyKey) return false;
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
  explorerNetwork: ExplorerNetwork = resolveExplorerNetwork(),
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
      purchases: receipts.map((r) => ({
        ...r,
        // Convenience field: the Stellar Expert explorer URL for the settlement
        // transaction. Consumers no longer need to join txHash with
        // mindvault_tx_status externally — the link is pre-resolved and always
        // null when no hash was recorded (e.g. buy completed before hash was
        // available). Use mindvault_tx_status to check live settlement status.
        explorerUrl: explorerTxUrl(r.txHash, explorerNetwork),
        status: purchaseStatusOf(r),
      })),
    },
    null,
    2,
  );
}

/** Read-only tool entrypoint used by the MCP server. */
export function purchaseHistoryTool(
  args?: Record<string, unknown>,
  options: { profile?: string } = {},
): string {
  const filter = normalizePurchaseHistoryFilter(args);
  if (filter.idempotencyKey) {
    return JSON.stringify(
      lookupPurchaseByIdempotencyKey(filter.idempotencyKey, { profile: options.profile }),
      null,
      2,
    );
  }
  return formatPurchaseHistory(listPurchases(filter), filter);
}
/** Test helper: wipe the configured purchases file content. */
export function _clearPurchases(): void {
  persist(emptyStore());
}
