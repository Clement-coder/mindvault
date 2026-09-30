/**
 * x402 payment retry classification — issue #583.
 *
 * `retry.ts` says payments are never retried automatically, and gives one
 * reason: a retry can sign and settle a second USDC transfer. That is correct
 * and insufficient. It tells an agent that the *server* will not retry, and
 * nothing about whether the *agent* may — which is the question an agent
 * actually faces when a buy fails.
 *
 * The answer depends entirely on **how far the payment got**, and the failures
 * look similar from outside:
 *
 *   - A 402 challenge means the resource quoted a price. Nothing was signed.
 *   - An exceeded auto-pay ceiling means the client refused before signing.
 *   - A rejected signature means the payment was built but not accepted.
 *   - A broadcast transaction that timed out may have settled anyway.
 *
 * The first two are free to retry. The last is the dangerous one: retrying it
 * can pay twice for the same resource, and *not* retrying can strand a purchase
 * the user has already paid for. Neither "always retry" nor "never retry" is
 * right, so this module classifies the stage the payment reached and says what
 * to check.
 *
 * Pure functions over an explicit description of the failure — no I/O, no
 * guessing from prose where a caller can supply the facts.
 */

import type { ErrorCode, RetrySafety } from "./errorCodes.js";

/**
 * How far a payment attempt got before it failed.
 *
 * Ordered from "nothing happened" to "money may have moved". The boundary that
 * matters is `signed`: before it, no value could have left the wallet.
 */
export type PaymentStage =
  /** The price was quoted; no payment was constructed. */
  | "quoted"
  /** The client declined before constructing a payment (ceiling, funds, no wallet). */
  | "declined"
  /** A payment was constructed and signed, but not submitted. */
  | "signed"
  /** The signed payment was submitted; the outcome is unknown. */
  | "submitted"
  /** The payment settled on-chain and the failure came afterwards. */
  | "settled";

/** Stages at or past which value may have left the wallet. */
const VALUE_AT_RISK: PaymentStage[] = ["signed", "submitted", "settled"];

export interface PaymentRetryClassification {
  stage: PaymentStage;
  safety: RetrySafety;
  /** Why this stage has this safety. */
  reason: string;
  /** What to do — including what to check first, when checking is required. */
  action: string;
  /** True when a retry could result in paying twice. */
  doubleSpendRisk: boolean;
}

function classification(
  stage: PaymentStage,
  safety: RetrySafety,
  doubleSpendRisk: boolean,
  reason: string,
  action: string,
): PaymentRetryClassification {
  return { stage, safety, reason, action, doubleSpendRisk };
}

/**
 * The classification for each stage. Single source of truth — the
 * documentation is validated against it.
 */
export const PAYMENT_STAGE_CLASSIFICATION: Record<PaymentStage, PaymentRetryClassification> = {
  quoted: classification(
    "quoted",
    "safe",
    false,
    "The resource returned an x402 challenge quoting a price. No payment was constructed, nothing was signed, and no value left the wallet.",
    "Retry freely. To let it proceed, raise the auto-pay ceiling or pass maxAutoPayUsdc at least as large as the quoted price.",
  ),
  declined: classification(
    "declined",
    "safe",
    false,
    "The client refused to pay before constructing a payment — the price exceeded the auto-pay ceiling, the wallet was underfunded, or no wallet was configured.",
    "Retry after fixing the cause. No funds moved, so an immediate retry costs nothing but time.",
  ),
  signed: classification(
    "signed",
    "conditional",
    true,
    "A payment was constructed and signed but not confirmed as submitted. A signed Stellar transaction can still be submitted by anyone holding it, so it may settle after the failure was reported.",
    "Check mindvault_purchase_history and, if a tx hash is known, mindvault_tx_status before retrying. Retry only once the original is confirmed not to have settled.",
  ),
  submitted: classification(
    "submitted",
    "conditional",
    true,
    "The signed payment was submitted and the response was lost — a timeout, a dropped connection, or a 5xx after submission. The network may have accepted it.",
    "Do not retry blind. Confirm with mindvault_tx_status; a timeout is not evidence of failure. Retry only if the transaction is definitively absent.",
  ),
  settled: classification(
    "settled",
    "unsafe",
    true,
    "The payment settled on-chain; the failure happened afterwards, in delivery or bookkeeping.",
    "Never retry the payment — it succeeded. Re-fetch the resource, and use mindvault_purchase_history to confirm the receipt was recorded.",
  ),
};

/** Whether a stage means value may have left the wallet. */
export function isValueAtRisk(stage: PaymentStage): boolean {
  return VALUE_AT_RISK.includes(stage);
}

/** Classify by stage. */
export function classifyStage(stage: PaymentStage): PaymentRetryClassification {
  return PAYMENT_STAGE_CLASSIFICATION[stage] ?? PAYMENT_STAGE_CLASSIFICATION.submitted;
}

/**
 * Map an error code onto the payment stage it implies.
 *
 * Only the payment-relevant codes have a stage. Everything else returns null —
 * a timeout fetching a catalog page is not a payment event, and pretending it
 * is would send an agent to check a transaction that was never made.
 */
export function stageForErrorCode(code: ErrorCode): PaymentStage | null {
  switch (code) {
    case "MV_PAYMENT_REQUIRED":
      return "quoted";
    case "MV_PAYMENT_CEILING_EXCEEDED":
    case "MV_INSUFFICIENT_FUNDS":
    case "MV_WALLET_MISSING":
      return "declined";
    case "MV_PAYMENT_REJECTED":
      // The pessimistic reading on purpose: a rejection reported by the payment
      // layer may or may not have been submitted, and assuming it was not is
      // the assumption that can pay twice.
      return "submitted";
    default:
      return null;
  }
}

export interface PaymentFailureFacts {
  /** The classified error code, when one is known. */
  code?: ErrorCode;
  /** An explicit stage, when the caller knows it. Wins over `code`. */
  stage?: PaymentStage;
  /** A transaction hash, if one was produced. Its presence implies submission. */
  txHash?: string | null;
  /** Whether a receipt for this resource already exists locally. */
  hasReceipt?: boolean;
}

/**
 * Classify a payment failure from what the caller knows about it.
 *
 * A known tx hash or an existing receipt is decisive: both are evidence the
 * payment got further than the error text suggests. They are checked before the
 * error code, because an error is only ever a report of a failure, whereas a
 * hash is evidence of an attempt.
 */
export function classifyPaymentFailure(
  facts: PaymentFailureFacts,
): PaymentRetryClassification | null {
  if (facts.stage) return classifyStage(facts.stage);
  if (facts.hasReceipt) return classifyStage("settled");
  if (facts.txHash) return classifyStage("submitted");
  if (!facts.code) return null;

  const stage = stageForErrorCode(facts.code);
  return stage ? classifyStage(stage) : null;
}

/** Compact, agent-facing guidance line for a payment failure. */
export function describePaymentRetry(classification: PaymentRetryClassification): string {
  const verdict =
    classification.safety === "safe"
      ? "Safe to retry"
      : classification.safety === "unsafe"
        ? "Do not retry"
        : "Check before retrying";
  return `${verdict} (payment stage: ${classification.stage}). ${classification.action}`;
}

/** Every stage, in escalating order of risk — for docs and exhaustive checks. */
export const PAYMENT_STAGES: PaymentStage[] = [
  "quoted",
  "declined",
  "signed",
  "submitted",
  "settled",
];
