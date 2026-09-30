/**
 * A minimal single-process async mutex (#550).
 *
 * MCP tool handlers are async and can overlap. State-mutating tools perform
 * read-modify-write on module-level wallet/profile state and persist it to
 * `~/.mindvault/state.json`, so two overlapping calls (for example
 * `mindvault_setup_wallet` and `mindvault_register`) can interleave and lose an
 * update. `Mutex.runExclusive` serializes those critical sections: only one
 * caller holds the lock at a time, so reads and writes cannot interleave.
 */

export class Mutex {
  // Resolves when the most recently-enqueued critical section has finished.
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `fn` while holding the mutex exclusively.
   *
   * Each call first awaits the previous critical section, so only one `fn`
   * runs at a time. `fn` may be async or sync; its resolved value (or a
   * rejection, which is still released back to the caller) is passed through
   * once the section ends.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
