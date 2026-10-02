/**
 * Tests for per-tool timeout overrides (#590).
 *
 * The behaviour that matters: an override applies only to the tool it names,
 * every other tool keeps its service budget, and a malformed entry is reported
 * and skipped rather than crashing the server or silently applying to nothing.
 */
import { describe, it, expect } from "vitest";

import { DEFAULT_TIMEOUTS } from "./httpTimeout.js";
import {
  TOOL_TIMEOUTS_ENV_VAR,
  describeToolTimeouts,
  hasOverride,
  normalizeToolName,
  parseToolTimeouts,
  resolveToolTimeouts,
  timeoutForTool,
  unknownToolNames,
} from "./toolTimeoutOverrides.js";

describe("normalizeToolName", () => {
  it("adds the mindvault_ prefix when it is missing", () => {
    expect(normalizeToolName("publish")).toBe("mindvault_publish");
  });

  it("leaves an already-qualified name alone", () => {
    expect(normalizeToolName("mindvault_publish")).toBe("mindvault_publish");
  });

  it("trims padding", () => {
    expect(normalizeToolName("  browse  ")).toBe("mindvault_browse");
  });
});

describe("parseToolTimeouts", () => {
  it("returns nothing when unset", () => {
    expect(parseToolTimeouts(undefined)).toEqual({ overrides: {}, problems: [] });
    expect(parseToolTimeouts("   ")).toEqual({ overrides: {}, problems: [] });
  });

  it("parses a single entry", () => {
    const { overrides } = parseToolTimeouts("mindvault_publish=120000");

    expect(overrides).toEqual({ mindvault_publish: 120000 });
  });

  it("parses a comma-separated list", () => {
    const { overrides } = parseToolTimeouts("mindvault_publish=120000,mindvault_browse=5000");

    expect(overrides).toEqual({ mindvault_publish: 120000, mindvault_browse: 5000 });
  });

  it("accepts whitespace separation", () => {
    const { overrides } = parseToolTimeouts("publish=1000\n  browse=2000");

    expect(overrides).toEqual({ mindvault_publish: 1000, mindvault_browse: 2000 });
  });

  it("accepts unprefixed tool names", () => {
    const { overrides } = parseToolTimeouts("publish=120000");

    expect(overrides).toEqual({ mindvault_publish: 120000 });
  });

  it("keeps zero, meaning no deadline", () => {
    const { overrides } = parseToolTimeouts("publish=0");

    // Matches what a service budget of 0 means, rather than being treated as
    // "unset".
    expect(overrides.mindvault_publish).toBe(0);
  });

  it("truncates a fractional value", () => {
    const { overrides } = parseToolTimeouts("publish=1500.9");

    expect(overrides.mindvault_publish).toBe(1500);
  });

  it("lets a later entry win", () => {
    const { overrides } = parseToolTimeouts("publish=1000,publish=2000");

    expect(overrides.mindvault_publish).toBe(2000);
  });

  it("reports an entry with no equals sign", () => {
    const { overrides, problems } = parseToolTimeouts("publish");

    expect(overrides).toEqual({});
    expect(problems).toEqual(['"publish" is not a tool=milliseconds pair']);
  });

  it("reports an entry with no tool name", () => {
    const { problems } = parseToolTimeouts("=5000");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("has no tool name");
  });

  it("reports a non-numeric timeout", () => {
    const { overrides, problems } = parseToolTimeouts("publish=soon");

    expect(overrides).toEqual({});
    expect(problems[0]).toContain("non-numeric or negative");
  });

  it("reports a negative timeout", () => {
    const { problems } = parseToolTimeouts("publish=-1");

    expect(problems).toHaveLength(1);
  });

  it("keeps the good entries alongside a bad one", () => {
    // An MCP server that refuses to start over a typo in an optional tuning
    // variable is worse than one that runs with a default.
    const { overrides, problems } = parseToolTimeouts("publish=oops,browse=5000");

    expect(overrides).toEqual({ mindvault_browse: 5000 });
    expect(problems).toHaveLength(1);
  });

  it("never throws on hostile input", () => {
    for (const input of ["=", "==", "a=b=c", ",,,", "publish=", "=1"]) {
      expect(() => parseToolTimeouts(input), input).not.toThrow();
    }
  });
});

describe("resolveToolTimeouts", () => {
  it("reads the documented variable", () => {
    const { overrides } = resolveToolTimeouts({ [TOOL_TIMEOUTS_ENV_VAR]: "publish=9000" });

    expect(overrides.mindvault_publish).toBe(9000);
  });

  it("is empty when the variable is absent", () => {
    expect(resolveToolTimeouts({}).overrides).toEqual({});
  });
});

describe("timeoutForTool", () => {
  const budgets = DEFAULT_TIMEOUTS;

  it("uses the service budget when there is no override", () => {
    expect(timeoutForTool("mindvault_browse", "http", budgets, {})).toBe(budgets.http);
  });

  it("uses the override when the tool names one", () => {
    const overrides = { mindvault_publish: 120000 };

    expect(timeoutForTool("mindvault_publish", "http", budgets, overrides)).toBe(120000);
  });

  it("leaves every other tool on the service budget", () => {
    const overrides = { mindvault_publish: 120000 };

    // The reason this exists: raising the service budget to fit one slow tool
    // makes every quick call wait too.
    expect(timeoutForTool("mindvault_browse", "http", budgets, overrides)).toBe(budgets.http);
  });

  it("overrides regardless of which service the call belongs to", () => {
    const overrides = { mindvault_tx_status: 90000 };

    expect(timeoutForTool("mindvault_tx_status", "soroban", budgets, overrides)).toBe(90000);
  });

  it("accepts an unprefixed tool name at the call site", () => {
    expect(timeoutForTool("publish", "http", budgets, { mindvault_publish: 7000 })).toBe(7000);
  });

  it("honours an override of zero as no deadline", () => {
    expect(timeoutForTool("publish", "http", budgets, { mindvault_publish: 0 })).toBe(0);
  });

  it("falls back to the service budget with no tool name", () => {
    expect(timeoutForTool(undefined, "payment", budgets, { mindvault_buy: 1 })).toBe(
      budgets.payment,
    );
  });

  it("covers every service", () => {
    for (const service of ["http", "horizon", "soroban", "payment"] as const) {
      expect(timeoutForTool("mindvault_browse", service, budgets, {})).toBe(budgets[service]);
    }
  });
});

describe("hasOverride", () => {
  it("is true only for an overridden tool", () => {
    const overrides = { mindvault_publish: 1 };

    expect(hasOverride("mindvault_publish", overrides)).toBe(true);
    expect(hasOverride("mindvault_browse", overrides)).toBe(false);
    expect(hasOverride(undefined, overrides)).toBe(false);
  });
});

describe("unknownToolNames", () => {
  const known = ["mindvault_browse", "mindvault_publish"];

  it("finds nothing when every override names a real tool", () => {
    expect(unknownToolNames({ mindvault_publish: 1 }, known)).toEqual([]);
  });

  it("reports a misspelled tool", () => {
    // "mindvault_publsh=120000" parses perfectly and applies to nothing —
    // exactly the failure a tuning variable must not have.
    expect(unknownToolNames({ mindvault_publsh: 1 }, known)).toEqual(["mindvault_publsh"]);
  });

  it("returns them sorted, for a stable message", () => {
    expect(unknownToolNames({ zzz: 1, aaa: 2 }, known)).toEqual(["aaa", "zzz"]);
  });
});

describe("describeToolTimeouts", () => {
  it("says so when nothing is overridden", () => {
    expect(describeToolTimeouts({})).toContain("service budget");
  });

  it("renders each override", () => {
    expect(describeToolTimeouts({ mindvault_publish: 120000 })).toBe("mindvault_publish=120000ms");
  });

  it("renders zero as disabled", () => {
    expect(describeToolTimeouts({ mindvault_publish: 0 })).toBe("mindvault_publish=disabled");
  });

  it("is deterministic regardless of insertion order", () => {
    const a = describeToolTimeouts({ mindvault_publish: 1, mindvault_browse: 2 });
    const b = describeToolTimeouts({ mindvault_browse: 2, mindvault_publish: 1 });

    expect(a).toBe(b);
  });
});
