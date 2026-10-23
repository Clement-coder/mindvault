/**
 * Keep a submitted transaction's hash when confirming it fails (#1060).
 *
 * The registry client's `signAndSend` does two things: `sendTransaction`,
 * which puts the transaction in front of the network and returns its hash, and
 * then a `getTransaction` poll until it lands. If the poll times out or the RPC
 * goes away in between, `signAndSend` throws — and the hash it already had went
 * with it. The tool reported a plain failure, so an agent that retried built
 * and sent a *second* transaction for a change that may well have applied.
 *
 * `signAndSendTracked` captures the hash through the SDK's `onSubmitted`
 * watcher. A failure after that point is not a failed submission, it is an
 * unconfirmed one: the caller gets a `SubmittedTransactionUnconfirmed` carrying
 * the hash and turns it into a `submitted` result with a status lookup the
 * agent can repeat safely (`mindvault_tx_status`). A failure before the
 * transaction was accepted still throws exactly as before.
 */

/** The `onSubmitted` hook `AssembledTransaction.signAndSend` accepts. */
export interface SubmissionWatcher {
  onSubmitted?: (response?: { hash?: string | null } | null) => void;
}

/** Why a submitted transaction could not be confirmed. */
export type UnconfirmedReason = "confirmation_timeout" | "rpc_unavailable";

/** Thrown when a transaction was submitted but its outcome could not be read. */
export class SubmittedTransactionUnconfirmed extends Error {
  readonly txHash: string;
  readonly reason: UnconfirmedReason;

  constructor(txHash: string, cause: unknown) {
    const reason = unconfirmedReason(cause);
    super(
      reason === "confirmation_timeout"
        ? `Transaction ${txHash} was submitted but did not confirm before the wait ended.`
        : `Transaction ${txHash} was submitted but its status could not be read from the RPC.`,
    );
    this.name = "SubmittedTransactionUnconfirmed";
    this.txHash = txHash;
    this.reason = reason;
    this.cause = cause;
  }
}

/** The SDK's poll-deadline error, by name (its classes are not exported). */
function unconfirmedReason(cause: unknown): UnconfirmedReason {
  const name = (cause as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
  const message = cause instanceof Error ? cause.message : String(cause);
  return name === "TransactionStillPendingError" ||
    /did not|timed? ?out|still pending/i.test(message)
    ? "confirmation_timeout"
    : "rpc_unavailable";
}

/**
 * Run `send` (normally `tx.signAndSend({ signTransaction, watcher })`) and
 * return the result together with the transaction hash.
 *
 * Throws `SubmittedTransactionUnconfirmed` when `send` fails after the network
 * accepted the transaction; rethrows the original error when it fails before.
 */
export async function signAndSendTracked<
  T extends { sendTransactionResponse?: { hash?: string | null } | null } | null | undefined,
>(send: (watcher: SubmissionWatcher) => Promise<T>): Promise<{ sent: T; txHash: string | null }> {
  let submittedHash: string | null = null;
  const watcher: SubmissionWatcher = {
    onSubmitted: (response) => {
      submittedHash = response?.hash ?? null;
    },
  };
  let sent: T;
  try {
    sent = await send(watcher);
  } catch (err) {
    if (submittedHash) throw new SubmittedTransactionUnconfirmed(submittedHash, err);
    throw err;
  }
  return { sent, txHash: sent?.sendTransactionResponse?.hash ?? submittedHash };
}

/** The repeatable lookup an agent uses to learn a submitted transaction's outcome. */
export function txStatusLookup(txHash: string) {
  return { tool: "mindvault_tx_status", arguments: { txHash }, retryable: true } as const;
}

/**
 * The result a registry mutation returns when its transaction was submitted
 * but not confirmed: `status: "submitted"`, `txPhase: "submitted"`, the hash,
 * and how to check it. Fits the same `status`/`resourceId`/`txHash` shape as a
 * confirmed result.
 */
export function submittedUnconfirmedResult(
  operation: string,
  resourceId: string,
  unconfirmed: SubmittedTransactionUnconfirmed,
  fields: Record<string, unknown> = {},
) {
  return {
    status: "submitted" as const,
    txPhase: "submitted" as const,
    resourceId,
    ...fields,
    txHash: unconfirmed.txHash,
    confirmed: false,
    reason: unconfirmed.reason,
    statusLookup: txStatusLookup(unconfirmed.txHash),
    message: `${operation}: ${unconfirmed.message} Do not resubmit — call mindvault_tx_status with this txHash (safe to repeat) until it reports SUCCESS or FAILED.`,
  };
}
