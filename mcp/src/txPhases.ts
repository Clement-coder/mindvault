/**
 * Transaction phase constants for on-chain mutation results (#1056).
 *
 * A Soroban transaction passes through four phases:
 *
 *   1. **Simulated** — `simulateTransaction` succeeded (preflight). The
 *      transaction *would* succeed if submitted, but nothing was broadcast.
 *   2. **Submitted** — `sendTransaction` accepted the signed envelope. The
 *      transaction is in the network's hands but not yet in a ledger.
 *   3. **Included** — `getTransaction` returned a non-NOT_FOUND status. The
 *      transaction is in a ledger but not yet final.
 *   4. **Settled** — `getTransaction` returned `SUCCESS` or `FAILED`. The
 *      transaction is permanent.
 *
 * Before #1056, every mutation tool returned `status: "success"` after
 * `signAndSend` completed, without distinguishing which phase the transaction
 * reached. An agent that read "success" could not tell whether the transaction
 * was confirmed or merely simulated/submitted.
 *
 * `txPhase` makes the distinction explicit. The happy path (all four phases
 * complete with SUCCESS) sets `txPhase: "settled"`. The submitted-but-
 * unconfirmed path sets `txPhase: "submitted"`. Dry runs (simulation only)
 * use `mode: "dry-run"` and do not carry `txPhase` because no transaction was
 * broadcast.
 */

/** The four phases a Soroban transaction passes through. */
export const TX_PHASES = ["simulated", "submitted", "included", "settled"] as const;

export type TxPhase = (typeof TX_PHASES)[number];

/** Human-readable label for each phase, for display in tool results. */
export const TX_PHASE_LABELS: Record<TxPhase, string> = {
  simulated: "Transaction simulated (preflight). Not yet submitted to the network.",
  submitted: "Transaction submitted to the network. Not yet confirmed on-chain.",
  included: "Transaction included in a ledger. Awaiting final settlement.",
  settled: "Transaction settled on-chain (confirmed).",
};

/** Happy-path phase: all four phases complete with SUCCESS. */
export const SETTLED_TX_PHASE: TxPhase = "settled";

/** Submitted but outcome could not be read (poll timeout or RPC outage). */
export const SUBMITTED_TX_PHASE: TxPhase = "submitted";

/** Simulation only (dry run / preflight). */
export const SIMULATED_TX_PHASE: TxPhase = "simulated";

/** Included in a ledger but not yet terminal. */
export const INCLUDED_TX_PHASE: TxPhase = "included";

/**
 * Build the standard transaction-phase fields for a mutation result.
 * Returns `{ txPhase, confirmed }` so every mutation tool can spread them
 * into the result object without repeating the constants.
 */
export function txPhaseFields(phase: TxPhase = SETTLED_TX_PHASE): {
  txPhase: TxPhase;
  confirmed: boolean;
} {
  return {
    txPhase: phase,
    confirmed: phase === "settled",
  };
}
