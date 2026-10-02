/**
 * Bounded polling helper for agents waiting on a resource subscription.
 * Time and sleep are injectable so consumers can test polling without waiting.
 */

export interface ResourceSubscriptionPollOptions<T> {
  fetch: () => Promise<T>;
  isSettled: (snapshot: T) => boolean;
  intervalMs: number;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ResourceSubscriptionPollResult<T> {
  snapshot: T;
  attempts: number;
  settled: boolean;
  timedOut: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll immediately, then at interval until settled or the timeout elapses. */
export async function pollResourceSubscription<T>(
  options: ResourceSubscriptionPollOptions<T>,
): Promise<ResourceSubscriptionPollResult<T>> {
  if (options.intervalMs < 0 || options.timeoutMs < 0) {
    throw new Error("intervalMs and timeoutMs must be non-negative.");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let attempts = 0;

  for (;;) {
    const snapshot = await options.fetch();
    attempts += 1;
    if (options.isSettled(snapshot)) {
      return { snapshot, attempts, settled: true, timedOut: false };
    }

    const remainingMs = options.timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      return { snapshot, attempts, settled: false, timedOut: true };
    }
    await sleep(Math.min(options.intervalMs, remainingMs));
  }
}
