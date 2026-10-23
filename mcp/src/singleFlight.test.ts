import { describe, expect, it } from "vitest";
import { createSingleFlight } from "./singleFlight.js";

describe("single-flight requests (#1040)", () => {
  it("shares one in-flight request for the same key", async () => {
    const flight = createSingleFlight<number>();
    let calls = 0;
    let release!: (value: number) => void;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const load = () => {
      calls++;
      return gate;
    };
    const first = flight.run("catalog", load);
    const second = flight.run("catalog", load);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(first).toBe(second);
    release(42);
    expect(await Promise.all([first, second])).toEqual([42, 42]);
    await Promise.resolve();
    expect(flight.pendingCount).toBe(0);
    expect(await flight.run("catalog", async () => ++calls)).toBe(2);
  });

  it("keeps independent keys separate", async () => {
    const flight = createSingleFlight<string>();
    const result = await Promise.all([
      flight.run("a", async () => "A"),
      flight.run("b", async () => "B"),
    ]);
    expect(result).toEqual(["A", "B"]);
  });

  it("clears rejected requests and allows retries", async () => {
    const flight = createSingleFlight<number>();
    let calls = 0;
    const fail = () => {
      calls++;
      return Promise.reject(new Error("offline"));
    };
    const a = flight.run("a", fail);
    const b = flight.run("a", fail);
    await expect(a).rejects.toThrow("offline");
    await expect(b).rejects.toThrow("offline");
    expect(calls).toBe(1);
    await Promise.resolve();
    expect(flight.pendingCount).toBe(0);
    expect(await flight.run("a", async () => ++calls)).toBe(2);
  });
});
