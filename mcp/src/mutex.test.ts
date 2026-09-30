import { describe, it, expect } from "vitest";
import { Mutex } from "./mutex.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Mutex (#550)", () => {
  it("never runs two exclusive sections at once", async () => {
    const mutex = new Mutex();
    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 20 }, () =>
      mutex.runExclusive(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(5);
        concurrent--;
      }),
    );

    await Promise.all(tasks);
    // With a working lock, at most one section runs at a time; without one,
    // several would overlap and maxConcurrent would be > 1.
    expect(maxConcurrent).toBe(1);
  });

  it("passes through the resolved value", async () => {
    const mutex = new Mutex();
    const value = await mutex.runExclusive(() => 42);
    expect(value).toBe(42);
  });

  it("passes through async resolved values", async () => {
    const mutex = new Mutex();
    const value = await mutex.runExclusive(async () => 7);
    expect(value).toBe(7);
  });

  it("releases the lock when the section throws", async () => {
    const mutex = new Mutex();
    await expect(
      mutex.runExclusive(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The lock must be free for the next caller.
    const after = await mutex.runExclusive(() => "ok");
    expect(after).toBe("ok");
  });

  it("serializes interleaved async critical sections in FIFO order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    await Promise.all([
      mutex.runExclusive(async () => {
        await sleep(10);
        order.push(1);
      }),
      mutex.runExclusive(async () => {
        await sleep(5);
        order.push(2);
      }),
    ]);

    // runExclusive is FIFO: the first enqueued section finishes first.
    expect(order).toEqual([1, 2]);
  });
});
