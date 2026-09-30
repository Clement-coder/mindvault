/**
 * Settlement confirmation for x402 purchases (#888).
 *
 * `mindvault_buy` submits a payment and returns as soon as the payment
 * response comes back. The payment transaction still has to settle on-chain
 * before the receipt is final, and an agent that moves straight on can end up
 * reasoning from a transaction Soroban has not committed yet. These helpers
 * poll `getTransaction` over Soroban RPC until the payment transaction reaches
 * a terminal status (`SUCCESS` or `FAILED`), or the caller's deadline passes,
 * so `mindvault_buy` can confirm settlement before handing the summary back.
 *
 * The module is pure: polling, clamping, and message formatting never touch
 * I/O or server state, so the surprising parts (timeouts, intervals, terminal
 * statuses, and the exact wording agents read) stay unit-testable.
 */

/** Terminal transaction statuses — polling stops when one of these is reached. */
export const SETTLED_TRANSACTION_STATUSES = new Set<string>(["SUCCESS", "FAILED"]);

export const DEFAULT_SETTLEMENT_INTERVAL_MS = 2_000;
export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 60_000;
export const MAX_SETTLEMENT_TIMEOUT_MS = 300_000;
export const MIN_SETTLEMENT_INTERVAL_MS = 200;

/**
 * What Soroban RPC's getTransaction told us about one hash. The payment paths
 * in this server only need `status` and `found`; the rest is surfaced so an
 * agent can verify by hash and ledger without a second RPC round trip.
 */
export interface TransactionLookup {
  hash: string;
  /** False when getTransaction returned NOT_FOUND (unknown / not yet seen). */
  found: boolean;
  status: string;
  ledger?: number | null;
  ledgerCloseTime?: string | null;
}

/** A transaction has settled when it reached a terminal status. */
export function isTransactionSettled(status: string | null | undefined): boolean {
  if (!status) return false;
  return SETTLED_TRANSACTION_STATUSES.has(status);
}

export function normalizeSettlementWaitFlag(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  throw new Error(
    `wait must be a boolean. Got: ${JSON.stringify(raw)}. Pass wait: true to poll until the payment settles.`,
  );
}

export function normalizeSettlementTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SETTLEMENT_TIMEOUT_MS;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `timeoutMs must be a non-negative number (ms). Got: ${JSON.stringify(raw)}. Default is ${DEFAULT_SETTLEMENT_TIMEOUT_MS}.`,
    );
  }
  return Math.min(Math.floor(n), MAX_SETTLEMENT_TIMEOUT_MS);
}

export function normalizeSettlementIntervalMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SETTLEMENT_INTERVAL_MS;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < MIN_SETTLEMENT_INTERVAL_MS) {
    throw new Error(
      `intervalMs must be a number ≥ ${MIN_SETTLEMENT_INTERVAL_MS} (ms). Got: ${JSON.stringify(raw)}. Default is ${DEFAULT_SETTLEMENT_INTERVAL_MS}.`,
    );
  }
  return Math.floor(n);
}

/**
 * The `settlement` block a `mindvault_buy` summary carries. `polled` is true
 * whenever the buy actually waited on the transaction; `skipped` is true only
 * when the caller asked to wait but no transaction hash was available to poll.
 */
export interface SettlementSnapshot {
  polled: boolean;
  txHash: string | null;
  status: string | null;
  settled: boolean;
  success: boolean;
  timedOut: boolean;
  attempts: number;
  skipped: boolean;
  message: string;
}

/** Message explaining a settlement that could not be confirmed the way asked. */
export function skippedSettlementMessage(reason: "no-tx-hash" | "no-wait"): string {
  if (reason === "no-tx-hash") {
    return "The payment response included no transaction hash, so on-chain settlement could not be polled. Re-check with mindvault_tx_status once a hash is available.";
  }
  return "Settlement not checked. Pass wait: true to poll until the payment transaction settles.";
}

export function buildSettlementSnapshot(input: {
  txHash: string | null;
  wait: boolean;
  skipped: boolean;
  result: { tx: TransactionLookup; attempts: number; timedOut: boolean } | null;
}): SettlementSnapshot {
  const { txHash, wait, skipped } = input;
  const polled = wait && !skipped && input.result !== null;

  if (!polled) {
    return {
      polled,
      txHash: txHash ?? null,
      status: null,
      settled: false,
      success: false,
      timedOut: false,
      attempts: 0,
      skipped: wait && skipped,
      message:
        wait && skipped
          ? skippedSettlementMessage("no-tx-hash")
          : skippedSettlementMessage("no-wait"),
    };
  }

  const { tx, attempts, timedOut } = input.result!;
  const settled = isTransactionSettled(tx.status);
  const success = tx.status === "SUCCESS";

  let message: string;
  if (timedOut && !settled) {
    message = `Reached the settlement deadline without a terminal status (last status: ${tx.status}). Re-check with mindvault_tx_status on ${tx.hash}.`;
  } else if (success) {
    message = `Payment settled on-chain (status: SUCCESS) after ${attempts} check${
      attempts === 1 ? "" : "s"
    }.`;
  } else if (settled) {
    message = `Payment transaction finished with status ${tx.status} after ${attempts} check${
      attempts === 1 ? "" : "s"
    }.`;
  } else {
    message = `Transaction status ${tx.status} after ${attempts} check${
      attempts === 1 ? "" : "s"
    }.`;
  }

  return {
    polled,
    txHash: tx.hash ?? txHash ?? null,
    status: tx.status,
    settled,
    success,
    timedOut,
    attempts,
    skipped,
    message,
  };
}

// ── Streaming progress while waiting for settlement ─────────────────────────

/** Emits an MCP `notifications/progress` update; a no-op without a progress token. */
export type SettlementProgressReporter = (
  progress: number,
  total?: number,
  message?: string,
) => Promise<void>;

/**
 * Best-effort estimate of how many polls a wait window allows, used as the
 * `total` of the emitted progress notifications so clients can render a bar.
 */
export function estimateSettlementSteps(
  wait: boolean,
  timeoutMs: number,
  intervalMs: number,
): number {
  if (!wait) return 1;
  const interval = Math.max(intervalMs, MIN_SETTLEMENT_INTERVAL_MS);
  return Math.max(1, Math.ceil(timeoutMs / interval) + 1);
}

/** Human-readable text attached to a settlement progress notification. */
export function settlementProgressMessage(input: {
  attempt: number;
  status: string;
  settled: boolean;
  timedOut: boolean;
  wait: boolean;
}): string {
  const polls = `${input.attempt} poll${input.attempt === 1 ? "" : "s"}`;
  if (input.timedOut) {
    return `Timed out after ${polls} — transaction still ${input.status}.`;
  }
  if (input.settled) {
    return `Transaction ${input.status} (settled) after ${polls}.`;
  }
  if (!input.wait) {
    return `Transaction ${input.status} — single check, pass wait: true to poll.`;
  }
  return `Transaction ${input.status} — poll ${input.attempt}, still settling.`;
}

export type PollSettlementOptions = {
  txHash: string;
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
  /** One getTransaction round trip; throws for RPC/transport failures. */
  fetchTransaction: (txHash: string) => Promise<TransactionLookup>;
  onProgress?: SettlementProgressReporter;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PollSettlementResult = {
  tx: TransactionLookup;
  attempts: number;
  timedOut: boolean;
};

/**
 * Fetch a transaction's status once, or poll until it settles when `wait` is
 * set, streaming a progress notification after every poll.
 *
 * The emitted `progress` value increments once per notification — never
 * repeating or decreasing, as MCP requires — and `total` grows if the poll
 * outlasts the initial estimate.
 */
export async function pollSettlement(opts: PollSettlementOptions): Promise<PollSettlementResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.wait ? opts.timeoutMs : 0);

  let total = estimateSettlementSteps(opts.wait, opts.timeoutMs, opts.intervalMs);
  let step = 0;
  let attempts = 0;
  let timedOut = false;

  const report = async (status: string, settled: boolean): Promise<void> => {
    step += 1;
    if (step > total) total = step;
    await opts.onProgress?.(
      step,
      total,
      settlementProgressMessage({ attempt: attempts, status, settled, timedOut, wait: opts.wait }),
    );
  };

  // Always fetch at least once, even when not waiting.
  let tx = await opts.fetchTransaction(opts.txHash);
  attempts += 1;
  await report(tx.status, isTransactionSettled(tx.status));

  while (opts.wait) {
    if (isTransactionSettled(tx.status)) break;
    if (now() >= deadline) {
      timedOut = true;
      await report(tx.status, false);
      break;
    }
    await sleepUntilNextPoll(opts.sleep, opts.intervalMs, deadline - now());
    tx = await opts.fetchTransaction(opts.txHash);
    attempts += 1;
    const settled = isTransactionSettled(tx.status);
    if (!settled && now() >= deadline) timedOut = true;
    await report(tx.status, settled);
    if (settled || timedOut) break;
  }

  return { tx, attempts, timedOut };
}

function sleepUntilNextPoll(
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  remainingMs: number,
): Promise<void> {
  return sleep(Math.min(intervalMs, Math.max(0, remainingMs)));
}
