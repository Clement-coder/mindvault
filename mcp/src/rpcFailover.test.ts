/**
 * Tests for Soroban RPC failover configuration (#588).
 *
 * The load-bearing distinction is which failures are worth asking a second
 * host about. Failing over on a 400 turns one fast error into three slow
 * identical ones; not failing over on a 503 leaves the server dead while
 * healthy providers sit unused.
 */
import { describe, it, expect, vi } from "vitest";

import {
  AllEndpointsFailedError,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
  RPC_FAILOVER_ENV_VARS,
  RpcFailover,
  describeFailover,
  isFailoverError,
  isFailoverStatus,
  parseEndpointList,
  resolveFailoverConfig,
} from "./rpcFailover.js";

const PRIMARY = "https://rpc-a.example";
const SECONDARY = "https://rpc-b.example";
const TERTIARY = "https://rpc-c.example";

/** A controllable clock so cooldowns are testable without waiting. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function failover(
  endpoints: string[],
  overrides: Partial<{ cooldownMs: number; maxAttempts: number }> = {},
) {
  const time = clock();
  const instance = new RpcFailover(
    {
      endpoints,
      cooldownMs: overrides.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      maxAttempts: overrides.maxAttempts ?? 0,
    },
    time.now,
  );
  return { instance, time };
}

describe("parseEndpointList", () => {
  it("splits on commas", () => {
    expect(parseEndpointList(`${PRIMARY},${SECONDARY}`)).toEqual([PRIMARY, SECONDARY]);
  });

  it("splits on whitespace and tolerates padding", () => {
    expect(parseEndpointList(` ${PRIMARY} \n ${SECONDARY} `)).toEqual([PRIMARY, SECONDARY]);
  });

  it("drops blanks", () => {
    expect(parseEndpointList(`${PRIMARY},,${SECONDARY},`)).toEqual([PRIMARY, SECONDARY]);
  });

  it("removes duplicates but keeps first position", () => {
    // Naming a host twice should not buy it two attempts.
    expect(parseEndpointList(`${PRIMARY},${SECONDARY},${PRIMARY}`)).toEqual([PRIMARY, SECONDARY]);
  });

  it("returns nothing for an empty value", () => {
    expect(parseEndpointList(undefined)).toEqual([]);
    expect(parseEndpointList("  ")).toEqual([]);
  });
});

describe("resolveFailoverConfig", () => {
  it("falls back to the preset when nothing is configured", () => {
    const config = resolveFailoverConfig({}, PRIMARY);

    // An operator who configured nothing gets exactly today's behaviour.
    expect(config.endpoints).toEqual([PRIMARY]);
  });

  it("uses SOROBAN_RPC_URL as a one-endpoint list", () => {
    const config = resolveFailoverConfig({ SOROBAN_RPC_URL: SECONDARY }, PRIMARY);

    expect(config.endpoints).toEqual([SECONDARY]);
  });

  it("reads the endpoint list", () => {
    const config = resolveFailoverConfig(
      { [RPC_FAILOVER_ENV_VARS.endpoints]: `${PRIMARY},${SECONDARY}` },
      "unused",
    );

    expect(config.endpoints).toEqual([PRIMARY, SECONDARY]);
  });

  it("promotes a pinned single URL to the front of the list", () => {
    const config = resolveFailoverConfig(
      {
        SOROBAN_RPC_URL: TERTIARY,
        [RPC_FAILOVER_ENV_VARS.endpoints]: `${PRIMARY},${SECONDARY}`,
      },
      "unused",
    );

    // An operator who pinned a primary and then added alternates should not
    // silently lose the pin.
    expect(config.endpoints).toEqual([TERTIARY, PRIMARY, SECONDARY]);
  });

  it("does not duplicate a pinned URL already in the list", () => {
    const config = resolveFailoverConfig(
      {
        SOROBAN_RPC_URL: SECONDARY,
        [RPC_FAILOVER_ENV_VARS.endpoints]: `${PRIMARY},${SECONDARY}`,
      },
      "unused",
    );

    expect(config.endpoints).toEqual([PRIMARY, SECONDARY]);
  });

  it("uses the documented defaults", () => {
    const config = resolveFailoverConfig({}, PRIMARY);

    expect(config.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
    expect(config.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it("reads tuning overrides", () => {
    const config = resolveFailoverConfig(
      {
        [RPC_FAILOVER_ENV_VARS.cooldownMs]: "5000",
        [RPC_FAILOVER_ENV_VARS.maxAttempts]: "2",
      },
      PRIMARY,
    );

    expect(config.cooldownMs).toBe(5000);
    expect(config.maxAttempts).toBe(2);
  });

  it("falls back to defaults on malformed numbers", () => {
    const config = resolveFailoverConfig({ [RPC_FAILOVER_ENV_VARS.cooldownMs]: "soon" }, PRIMARY);

    expect(config.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
  });
});

describe("failure classification", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])("fails over on HTTP %i", (status) => {
    expect(isFailoverStatus(status)).toBe(true);
  });

  it.each([200, 201, 400, 401, 403, 404, 409, 422])("does not fail over on HTTP %i", (status) => {
    // A 400 means the request is wrong; a second host produces the same 400.
    expect(isFailoverStatus(status)).toBe(false);
  });

  it("fails over on a connection refusal", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

    expect(isFailoverError(error)).toBe(true);
  });

  it.each(["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE"])(
    "fails over on %s",
    (code) => {
      expect(isFailoverError(Object.assign(new Error(code), { code }))).toBe(true);
    },
  );

  it("fails over on a request timeout", () => {
    const error = new Error("Request timed out after 20000ms (soroban).");
    error.name = "TimeoutError";

    expect(isFailoverError(error)).toBe(true);
  });

  it("fails over on a wrapped transport failure", () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const outer = new Error("fetch failed");
    outer.name = "Error";
    (outer as any).cause = inner;

    expect(isFailoverError(outer)).toBe(true);
  });

  it("does not fail over on a programming error", () => {
    expect(isFailoverError(new SyntaxError("Unexpected token"))).toBe(false);
    expect(isFailoverError(new RangeError("out of range"))).toBe(false);
  });

  it("does not fail over on a non-error value", () => {
    expect(isFailoverError("nope")).toBe(false);
    expect(isFailoverError(null)).toBe(false);
  });
});

describe("RpcFailover – ordering", () => {
  it("requires at least one endpoint", () => {
    expect(() => new RpcFailover({ endpoints: [], cooldownMs: 0, maxAttempts: 0 })).toThrow(
      /at least one endpoint/,
    );
  });

  it("prefers the primary while it is healthy", () => {
    const { instance } = failover([PRIMARY, SECONDARY]);

    // Stable order, not round-robin: the primary stays the primary.
    expect(instance.preferredEndpoint()).toBe(PRIMARY);
    expect(instance.preferredEndpoint()).toBe(PRIMARY);
  });

  it("prefers the next endpoint once the primary is parked", () => {
    const { instance } = failover([PRIMARY, SECONDARY]);

    instance.park(PRIMARY);

    expect(instance.preferredEndpoint()).toBe(SECONDARY);
  });

  it("returns to the primary after the cooldown expires", () => {
    const { instance, time } = failover([PRIMARY, SECONDARY], { cooldownMs: 1000 });
    instance.park(PRIMARY);

    time.advance(1001);

    // A provider that recovers is used again without a restart.
    expect(instance.preferredEndpoint()).toBe(PRIMARY);
  });

  it("falls back to the primary when everything is parked", () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    instance.park(PRIMARY);
    instance.park(SECONDARY);

    // Refusing to call because the whole world was recently unhealthy would
    // turn a transient outage into a self-inflicted one.
    expect(instance.preferredEndpoint()).toBe(PRIMARY);
  });

  it("puts parked endpoints last rather than dropping them", () => {
    const { instance } = failover([PRIMARY, SECONDARY, TERTIARY]);
    instance.park(PRIMARY);

    expect(instance.attemptOrder()).toEqual([SECONDARY, TERTIARY, PRIMARY]);
  });

  it("caps the attempt order at maxAttempts", () => {
    const { instance } = failover([PRIMARY, SECONDARY, TERTIARY], { maxAttempts: 2 });

    expect(instance.attemptOrder()).toEqual([PRIMARY, SECONDARY]);
  });

  it("does not park anything when the cooldown is zero", () => {
    const { instance } = failover([PRIMARY, SECONDARY], { cooldownMs: 0 });

    instance.park(PRIMARY);

    expect(instance.isParked(PRIMARY)).toBe(false);
  });
});

describe("RpcFailover – running requests", () => {
  it("returns the primary's answer without touching the alternates", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const send = vi.fn().mockResolvedValue({ status: 200, body: "ok" });

    const result = await instance.run(send);

    expect(result.body).toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(PRIMARY);
  });

  it("advances to the next endpoint on a 503", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200, body: "ok" });

    const result = await instance.run(send);

    expect(result.body).toBe("ok");
    expect(send).toHaveBeenNthCalledWith(2, SECONDARY);
  });

  it("advances on a connection failure", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))
      .mockResolvedValueOnce({ status: 200, body: "ok" });

    await expect(instance.run(send)).resolves.toMatchObject({ body: "ok" });
  });

  it("returns a 400 immediately instead of asking every host", async () => {
    const { instance } = failover([PRIMARY, SECONDARY, TERTIARY]);
    const send = vi.fn().mockResolvedValue({ status: 400 });

    const result = await instance.run(send);

    expect(result.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rethrows a non-transport error without failing over", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const send = vi.fn().mockRejectedValue(new SyntaxError("bad JSON"));

    await expect(instance.run(send)).rejects.toThrow(SyntaxError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("throws once every endpoint has failed", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const send = vi.fn().mockResolvedValue({ status: 503 });

    await expect(instance.run(send)).rejects.toBeInstanceOf(AllEndpointsFailedError);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("names every endpoint it tried in the failure", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const send = vi.fn().mockResolvedValue({ status: 503 });

    await expect(instance.run(send)).rejects.toThrow(new RegExp(`${PRIMARY}.*${SECONDARY}`));
  });

  it("points at the configuration variable in the failure", async () => {
    const { instance } = failover([PRIMARY]);
    const send = vi.fn().mockResolvedValue({ status: 503 });

    await expect(instance.run(send)).rejects.toThrow(new RegExp(RPC_FAILOVER_ENV_VARS.endpoints));
  });

  it("parks an endpoint that failed", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });

    await instance.run(send);

    expect(instance.isParked(PRIMARY)).toBe(true);
    expect(instance.isParked(SECONDARY)).toBe(false);
  });

  it("skips a parked endpoint on the next call", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    await instance.run(
      vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValueOnce({ status: 200 }),
    );

    const send = vi.fn().mockResolvedValue({ status: 200 });
    await instance.run(send);

    // The whole point: a second call does not re-pay the cost of the dead host.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(SECONDARY);
  });

  it("un-parks an endpoint that answers again", async () => {
    const { instance, time } = failover([PRIMARY, SECONDARY], { cooldownMs: 1000 });
    await instance.run(
      vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValueOnce({ status: 200 }),
    );
    time.advance(1001);

    await instance.run(vi.fn().mockResolvedValue({ status: 200 }));

    expect(instance.isParked(PRIMARY)).toBe(false);
  });

  it("reports each attempt to the observer", async () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    const attempts: string[] = [];

    await instance.run(
      vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValueOnce({ status: 200 }),
      (attempt) => attempts.push(`${attempt.endpoint}:${attempt.outcome}`),
    );

    expect(attempts).toEqual([`${PRIMARY}:status`, `${SECONDARY}:success`]);
  });

  it("handles a result with no status field", async () => {
    const { instance } = failover([PRIMARY]);

    await expect(instance.run(vi.fn().mockResolvedValue({ data: 1 } as any))).resolves.toEqual({
      data: 1,
    });
  });

  it("tries every endpoint before giving up when they all fail", async () => {
    const { instance } = failover([PRIMARY, SECONDARY, TERTIARY]);
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "ENOTFOUND" }));

    await expect(instance.run(send)).rejects.toBeInstanceOf(AllEndpointsFailedError);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("honours maxAttempts when giving up", async () => {
    const { instance } = failover([PRIMARY, SECONDARY, TERTIARY], { maxAttempts: 2 });
    const send = vi.fn().mockResolvedValue({ status: 503 });

    await expect(instance.run(send)).rejects.toBeInstanceOf(AllEndpointsFailedError);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("describeFailover", () => {
  it("says so when nothing is configured", () => {
    const { instance } = failover([PRIMARY]);

    expect(describeFailover(instance)).toContain("no failover configured");
  });

  it("renders the endpoint chain in priority order", () => {
    const { instance } = failover([PRIMARY, SECONDARY]);

    expect(describeFailover(instance)).toContain(`${PRIMARY} → ${SECONDARY}`);
  });

  it("marks a cooling-down endpoint", () => {
    const { instance } = failover([PRIMARY, SECONDARY]);
    instance.park(PRIMARY);

    expect(describeFailover(instance)).toContain("[cooling down]");
  });

  it("reports the tuning values", () => {
    const { instance } = failover([PRIMARY, SECONDARY], { cooldownMs: 5000, maxAttempts: 2 });

    expect(describeFailover(instance)).toContain("cooldown=5000ms");
    expect(describeFailover(instance)).toContain("maxAttempts=2");
  });
});
