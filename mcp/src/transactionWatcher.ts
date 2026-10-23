/**
 * Bounded watcher for a pending Stellar transaction.
 *
 * The watcher deliberately accepts the lookup, sleep, and subscription
 * functions so callers can use Soroban RPC, Horizon, or a test double without
 * coupling this lifecycle logic to a transport.
 */

export interface PendingTransactionSnapshot {
  status: string;
  [key: string]: unknown;
}
export interface TransactionWatcherProgress<T extends PendingTransactionSnapshot> {
  kind: "progress" | "terminal";
  progress: number;
  total: number;
  snapshot: T;
  timedOut: boolean;
}

export interface TransactionWatcherOptions<T extends PendingTransactionSnapshot> {
  fetch: () => Promise<T>;
  isTerminal: (snapshot: T) => boolean;
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** Optional push subscription. It is always released in the finally block. */
  subscribe?: (onUpdate: (snapshot: T) => void) => void | (() => void);
  onProgress?: (event: TransactionWatcherProgress<T>) => void | Promise<void>;
}

export interface TransactionWatcherResult<T extends PendingTransactionSnapshot> {
  snapshot: T;
  attempts: number;
  timedOut: boolean;
  cancelled: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Watch until a terminal status, cancellation, or the bounded deadline. */
export async function watchPendingTransaction<T extends PendingTransactionSnapshot>(
  options: TransactionWatcherOptions<T>,
): Promise<TransactionWatcherResult<T>> {
  if (options.timeoutMs < 0 || options.intervalMs < 0) {
    throw new Error("timeoutMs and intervalMs must be non-negative.");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutMs;
  const total = Math.max(1, Math.ceil(options.timeoutMs / Math.max(1, options.intervalMs)) + 1);
  let progress = 0;
  let attempts = 0;
  let snapshot = await options.fetch();
  let terminalEmitted = false;
  let unsubscribe: (() => void) | undefined;

  const emit = async (kind: "progress" | "terminal", value: T, timedOut: boolean) => {
    if (kind === "terminal") {
      if (terminalEmitted) return;
      terminalEmitted = true;
    }
    progress = Math.max(progress + 1, 1);
    await options.onProgress?.({
      kind,
      progress,
      total: Math.max(total, progress),
      snapshot: value,
      timedOut,
    });
  };

  try {
    const stop = options.subscribe?.((next) => {
      snapshot = next;
    });
    unsubscribe = typeof stop === "function" ? stop : undefined;
    attempts = 1;
    await emit(options.isTerminal(snapshot) ? "terminal" : "progress", snapshot, false);
    while (!options.isTerminal(snapshot)) {
      if (options.signal?.aborted) {
        return { snapshot, attempts, timedOut: false, cancelled: true };
      }
      if (now() >= deadline) {
        await emit("terminal", snapshot, true);
        return { snapshot, attempts, timedOut: true, cancelled: false };
      }
      await sleep(Math.min(options.intervalMs, Math.max(0, deadline - now())));
      if (options.signal?.aborted) {
        return { snapshot, attempts, timedOut: false, cancelled: true };
      }
      snapshot = await options.fetch();
      attempts += 1;
      const terminal = options.isTerminal(snapshot);
      await emit(terminal ? "terminal" : "progress", snapshot, false);
      if (terminal) break;
    }
    return { snapshot, attempts, timedOut: false, cancelled: false };
  } finally {
    if (unsubscribe) unsubscribe();
  }
}
