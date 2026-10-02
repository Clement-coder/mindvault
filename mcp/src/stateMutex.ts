/**
 * Serialization for state-touching tool calls (#855).
 *
 * The MCP server keeps its profiles, wallet, and publisher API key in
 * module-level state and persists them to `~/.mindvault/state.json`. Two tools
 * that both read the active profile and then write it can interleave across an
 * `await`, because nothing in the dispatch path holds a lock:
 *
 *   1. `mindvault_buy` reads the active wallet (`requireWallet`), then awaits
 *      the x402 payment.
 *   2. `mindvault_reset` clears the profile and persists it.
 *   3. `mindvault_buy` resumes and its receipt/response reports state that no
 *      longer exists.
 *
 * The fix is a FIFO async mutex held for the whole of a state-touching tool
 * call. Waiting is strictly ordered so calls cannot starve each other, and a
 * rejected call never wedges the queue — the next caller still runs.
 *
 * Only tools that read-then-write the profile store are serialized. Read-only
 * tools stay fully parallel; holding a lock across a network round trip for a
 * tool that cannot conflict would be a latency cost with no correctness gain.
 */

/**
 * Tools serialized against each other.
 *
 * The first group mutates the profile store. The second group spends against
 * the API using credentials read from that store, so a concurrent reset or
 * profile switch can invalidate them mid-flight.
 */
export const STATE_SERIALIZED_TOOLS: ReadonlySet<string> = new Set([
  // Mutate the profile store.
  "mindvault_reset",
  "mindvault_restore_state",
  "mindvault_setup_wallet",
  "mindvault_import_wallet",
  "mindvault_use_profile",
  "mindvault_register",
  "mindvault_rotate_publisher_key",
  // Spend credentials read from the profile store.
  "mindvault_publish",
  "mindvault_buy",
]);

/** True when `name` must hold the state mutex for its whole dispatch. */
export function serializesStateTool(name: string): boolean {
  return STATE_SERIALIZED_TOOLS.has(name);
}

export interface StateMutex {
  /**
   * Run `fn` with exclusive access, resolving with its result.
   *
   * Callers run in the order they arrive. A throwing or rejecting `fn` is
   * reported to its own caller and does not affect later ones.
   */
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Queued-or-running call count. Exposed for tests and diagnostics. */
  readonly pending: number;
}

/** Create a fresh FIFO mutex. */
export function createStateMutex(): StateMutex {
  // Tail of the queue. Kept non-rejecting forever so one failure cannot
  // poison every call that follows it.
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;

  function runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    depth += 1;
    // `then(fn, fn)` — not `then(() => fn())` — so a call is not skipped just
    // because the one ahead of it threw.
    const result = tail.then(fn, fn);
    tail = result.then(noop, noop);
    return result.finally(() => {
      depth -= 1;
    });
  }

  return {
    runExclusive,
    get pending() {
      return depth;
    },
  };
}

function noop(): void {
  // Deliberately empty: used to settle the queue tail.
}
