/**
 * Read-only wallet allowance and spend summary (#1052).
 *
 * Combines three things an agent needs before it spends:
 *
 *   - the active wallet's current USDC balance from Horizon;
 *   - spend it has already initiated but not seen settle, estimated from local
 *     purchase receipts that carry no transaction hash;
 *   - the automatic payment ceiling the x402 guardrail enforces.
 *
 * Every monetary value carries the asset (`USDC`, issuer, SAC contract) and the
 * x402 network it belongs to, so a balance can never be read as if it were in
 * another asset or on another network. The pending and remaining values are
 * estimates and say so: a local receipt without a hash proves only that a buy
 * response arrived, not that the payment settled or how it was reflected in the
 * Horizon balance.
 *
 * Pure: no I/O, no signing, no transfer. The handler supplies the balance,
 * receipts, and ceiling; formatting is deterministic.
 */

import type { PaymentCeilingReading } from "./paymentCeiling.js";
import { purchaseStatusOf, type PurchaseReceipt } from "./purchaseHistory.js";
import {
  USDC_DECIMALS,
  stroopsToUsdc,
  sumUsdc,
  trimUsdc,
  usdcToStroops,
} from "./usdcAmount.js";

/** Identity of the USDC asset on the active network. */
export interface UsdcAssetIdentity {
  code: "USDC";
  /** Classic issuer used by the Horizon trustline. */
  issuer: string;
  /** Soroban Stellar Asset Contract used by x402. */
  contractId: string;
  decimals: number;
}

/**
 * A monetary value with the identity needed to interpret it. Every amount in
 * the summary uses this shape, including the derived estimates.
 */
export interface TaggedUsdcAmount {
  amount: string;
  asset: UsdcAssetIdentity;
  network: string;
  /** True when the amount is derived rather than read from Horizon or config. */
  estimate: boolean;
  label: string;
}

export interface PendingPurchaseEstimate {
  resourceId: string;
  amount: string;
  asset: UsdcAssetIdentity;
  network: string;
  timestamp: string;
  receiptRef: string | null;
  estimate: true;
  status: "pending";
}

export interface PendingSpendEstimate extends TaggedUsdcAmount {
  /** Number of pending local receipts included in the estimate. */
  count: number;
  purchases: PendingPurchaseEstimate[];
}

export interface PaymentCeilingSummary extends TaggedUsdcAmount {
  source: PaymentCeilingReading["source"];
  configured: boolean;
}

export interface RemainingAllowanceEstimate extends TaggedUsdcAmount {
  /** How the estimate is derived, stated with the value. */
  basis: string;
}

export interface WalletAllowanceSummary {
  profile: string;
  address: string;
  network: string;
  networkPassphrase: string;
  asset: UsdcAssetIdentity;
  balance: TaggedUsdcAmount & {
    /** Horizon account status: missing, no-trustline, zero, or funded. */
    status: string;
    source: "horizon";
  };
  estimatedPendingSpend: PendingSpendEstimate;
  paymentCeiling: PaymentCeilingSummary;
  estimatedRemainingAllowance: RemainingAllowanceEstimate;
  notes: string[];
  /** This summary never signs, transfers, or pays. */
  readOnly: true;
  message: string;
}

export interface WalletAllowanceInput {
  profile: string;
  address: string;
  /** x402 network id, e.g. `stellar:testnet`. */
  network: string;
  /** Stellar network passphrase the balance was read from. */
  networkPassphrase: string;
  asset: UsdcAssetIdentity;
  balance: {
    amount: string;
    status: string;
    source: "horizon";
    note?: string | null;
  };
  /** Local receipts; only pending ones for `network` are included. */
  pendingReceipts: readonly PurchaseReceipt[];
  ceiling: PaymentCeilingReading;
}

const maxStroops = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minStroops = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Build the summary from already-read inputs.
 *
 * Pending receipts are filtered again here so a caller cannot accidentally
 * attribute another network's or another profile's spend to this wallet.
 */
export function buildWalletAllowanceSummary(input: WalletAllowanceInput): WalletAllowanceSummary {
  const pending = input.pendingReceipts.filter(
    (receipt) => receipt.network === input.network && purchaseStatusOf(receipt) === "pending",
  );
  const readablePending = pending.filter((receipt) => usdcToStroops(receipt.amount) !== null);
  const unreadableCount = pending.length - readablePending.length;

  const pendingAmount = sumUsdc(readablePending.map((receipt) => receipt.amount));
  const pendingStroops = usdcToStroops(pendingAmount) ?? 0n;

  const balanceStroops = usdcToStroops(input.balance.amount);
  const balanceAmount = balanceStroops === null ? "0.0000000" : stroopsToUsdc(balanceStroops);

  // Both derived values are estimates. The ceiling is a per-payment guardrail,
  // so the remaining allowance is the largest automatic payment the configured
  // ceiling and the estimated available balance would permit next.
  const availableStroops = maxStroops(0n, (balanceStroops ?? 0n) - pendingStroops);
  const allowanceStroops = minStroops(availableStroops, input.ceiling.stroops);

  const notes: string[] = [];
  if (balanceStroops === null) {
    notes.push(
      `Horizon reported a USDC balance that could not be read as a decimal ("${String(input.balance.amount).slice(0, 32)}"); it is treated as zero rather than guessed at.`,
    );
  }
  if (input.balance.note) notes.push(input.balance.note);
  if (unreadableCount > 0) {
    notes.push(
      `${unreadableCount} pending receipt(s) had an amount that could not be read and are excluded from the pending-spend estimate.`,
    );
  }
  notes.push(
    "Pending spend is estimated from local receipts without a recorded on-chain transaction hash. Those payments may already be reflected in the on-chain balance, so the estimate can double-count until they settle.",
  );
  notes.push(
    "The remaining allowance is an estimate of the largest automatic payment currently permitted: min(configured ceiling, balance minus estimated pending spend). It is not a promise that a resource will cost that amount.",
  );

  const network = input.network;
  const asset = input.asset;

  return {
    profile: input.profile,
    address: input.address,
    network,
    networkPassphrase: input.networkPassphrase,
    asset,
    balance: {
      amount: balanceAmount,
      asset,
      network,
      estimate: false,
      label: "current USDC balance",
      status: input.balance.status,
      source: "horizon",
    },
    estimatedPendingSpend: {
      amount: pendingAmount,
      asset,
      network,
      estimate: true,
      label: "estimated pending spend",
      count: pending.length,
      purchases: pending.map((receipt) => ({
        resourceId: receipt.resourceId,
        amount: receipt.amount,
        asset,
        network,
        timestamp: receipt.timestamp,
        receiptRef: receipt.receiptRef,
        estimate: true,
        status: "pending",
      })),
    },
    paymentCeiling: {
      amount: trimUsdc(input.ceiling.amount),
      asset,
      network,
      estimate: false,
      label: "configured automatic payment ceiling",
      source: input.ceiling.source,
      configured: input.ceiling.configured,
    },
    estimatedRemainingAllowance: {
      amount: stroopsToUsdc(allowanceStroops),
      asset,
      network,
      estimate: true,
      label: "estimated remaining automatic payment allowance",
      basis: "min(configured payment ceiling, balance minus estimated pending spend)",
    },
    notes,
    readOnly: true,
    message:
      pending.length > 0
        ? `USDC balance ${trimUsdc(balanceAmount)} on ${network}, with an estimated ${trimUsdc(pendingAmount)} USDC pending across ${pending.length} local receipt(s). The automatic payment ceiling is ${trimUsdc(input.ceiling.amount)} USDC.`
        : `USDC balance ${trimUsdc(balanceAmount)} on ${network}; no pending local purchase receipts. The automatic payment ceiling is ${trimUsdc(input.ceiling.amount)} USDC.`,
  };
}

/** Human-readable rendering of the same summary; never hides the estimates. */
export function formatWalletAllowanceSummary(summary: WalletAllowanceSummary): string {
  const tag = `${summary.asset.code} · ${summary.network}`;
  const lines = [
    "Wallet allowance (read-only)",
    `Profile: ${summary.profile}`,
    `Address: ${summary.address}`,
    `Network: ${summary.network}`,
    `Network passphrase: ${summary.networkPassphrase}`,
    `Asset: ${summary.asset.code} (issuer ${summary.asset.issuer}, SAC ${summary.asset.contractId}, ${summary.asset.decimals} decimals)`,
    "",
    `USDC balance: ${trimUsdc(summary.balance.amount)} ${tag} (Horizon; not an estimate)`,
    `Estimated pending spend: ${trimUsdc(summary.estimatedPendingSpend.amount)} ${tag} (estimate; ${summary.estimatedPendingSpend.count} receipt(s))`,
    `Configured payment ceiling: ${summary.paymentCeiling.amount} ${tag} (${summary.paymentCeiling.source}; not an estimate)`,
    `Estimated remaining allowance: ${trimUsdc(summary.estimatedRemainingAllowance.amount)} ${tag} (estimate; ${summary.estimatedRemainingAllowance.basis})`,
  ];

  if (summary.estimatedPendingSpend.purchases.length > 0) {
    lines.push("Pending receipts:");
    for (const purchase of summary.estimatedPendingSpend.purchases) {
      lines.push(
        `  - ${purchase.resourceId}: ${trimUsdc(purchase.amount)} ${tag} at ${purchase.timestamp} (estimate; no transaction hash)`,
      );
    }
  }

  for (const note of summary.notes) {
    lines.push(`Note: ${note}`);
  }
  lines.push("No signing, transfer, or payment was performed by this tool.");

  return lines.join("\n");
}
