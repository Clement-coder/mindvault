/** Coalesce concurrent work by key without caching settled results. */
export function createSingleFlight<T>() {
  const pending = new Map<string, Promise<T>>();
  return {
    run(key: string, load: () => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing;
      // Defer the loader so the pending entry is installed even if it throws.
      const request = Promise.resolve().then(load);
      pending.set(key, request);
      void request.then(
        () => {
          if (pending.get(key) === request) pending.delete(key);
        },
        () => {
          if (pending.get(key) === request) pending.delete(key);
        },
      );
      return request;
    },
    get pendingCount(): number {
      return pending.size;
    },
  };
}
