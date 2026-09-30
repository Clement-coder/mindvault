/**
 * Tests for tool result correlation IDs (#572).
 *
 * The property that matters most is isolation: two tool calls running at once
 * must not see each other's ID. A shared "current ID" would produce a log that
 * looks correct and attributes one call's network requests to another, which
 * is worse than having no IDs at all.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import {
  CORRELATION_META_KEY,
  attachCorrelationId,
  correlationIdOf,
  correlationSuffix,
  currentCorrelationId,
  isCorrelationId,
  newCorrelationId,
  runWithCorrelationId,
  withNewCorrelationId,
} from "./correlation.js";
import { logNetworkRequest, logToolStart, logToolSuccess, setAuditLogEnabled } from "./auditLog.js";

afterEach(() => {
  setAuditLogEnabled(false);
  vi.restoreAllMocks();
});

/** Capture the JSON objects written to stderr by the audit logger. */
function captureAuditEntries(): { entries: any[] } {
  const captured: { entries: any[] } = { entries: [] };
  vi.spyOn(console, "error").mockImplementation((line: any) => {
    try {
      captured.entries.push(JSON.parse(String(line)));
    } catch {
      // Not an audit entry; ignore.
    }
  });
  return captured;
}

describe("newCorrelationId", () => {
  it("has the documented shape", () => {
    expect(newCorrelationId()).toMatch(/^mv-[0-9a-z]+-[0-9a-z]{4}$/);
  });

  it("is deterministic given a clock and a source of randomness", () => {
    const id = newCorrelationId(
      () => 1_700_000_000_000,
      () => 0.5,
    );

    expect(id).toBe(
      newCorrelationId(
        () => 1_700_000_000_000,
        () => 0.5,
      ),
    );
  });

  it("differs when the clock advances", () => {
    const a = newCorrelationId(
      () => 1_700_000_000_000,
      () => 0.5,
    );
    const b = newCorrelationId(
      () => 1_700_000_000_001,
      () => 0.5,
    );

    expect(a).not.toBe(b);
  });

  it("differs when only the random part differs", () => {
    const a = newCorrelationId(
      () => 1,
      () => 0.1,
    );
    const b = newCorrelationId(
      () => 1,
      () => 0.9,
    );

    expect(a).not.toBe(b);
  });

  it("sorts chronologically as a string", () => {
    // The time component is base36, so a plain sort of a log groups a session.
    const earlier = newCorrelationId(
      () => 1_700_000_000_000,
      () => 0,
    );
    const later = newCorrelationId(
      () => 1_800_000_000_000,
      () => 0,
    );

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it("pads the random component to a fixed width", () => {
    const id = newCorrelationId(
      () => 1,
      () => 0,
    );

    expect(id.split("-")[2]).toHaveLength(4);
  });

  it("produces distinct ids across advancing milliseconds", () => {
    let clock = 1_700_000_000_000;
    const ids = new Set(
      Array.from({ length: 500 }, () =>
        newCorrelationId(
          () => clock++,
          () => 0.5,
        ),
      ),
    );

    expect(ids.size).toBe(500);
  });

  it("maps distinct randomness within one millisecond to distinct ids", () => {
    // Within a millisecond the suffix is all that varies, so what this module
    // owes is an injective mapping from randomness to suffix — no two distinct
    // draws may collapse onto one id.
    //
    // This replaces an assertion that 500 ids from the *real* clock and
    // Math.random were all distinct. That is not a property this design can
    // have: `newCorrelationId` is deliberately deterministic in (clock,
    // random) — the test above this one pins that — so it cannot also carry a
    // uniqueness counter. A 500-call burst lands in one millisecond, drawing
    // 500 times from 36**4 = 1,679,616 values, which by the birthday bound
    // collides about 7% of the time. The old test failed roughly one run in
    // fourteen, and the failure was correct: the assertion was wrong.
    const draws = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1 - Number.EPSILON];
    const ids = new Set(
      draws.map((r) =>
        newCorrelationId(
          () => 1,
          () => r,
        ),
      ),
    );

    expect(ids.size).toBe(draws.length);
  });

  it("keeps the suffix at the full four base36 digits", () => {
    // Narrowing the suffix would raise the same-millisecond collision rate,
    // and a collision merges two concurrent calls' audit trails — the exact
    // failure this module exists to prevent.
    const highest = newCorrelationId(
      () => 1,
      () => 1 - Number.EPSILON,
    );

    expect(highest.split("-")[2]).toBe("zzzz");
  });
});

describe("isCorrelationId", () => {
  it("accepts a minted id", () => {
    expect(isCorrelationId(newCorrelationId())).toBe(true);
  });

  it.each(["", "mv-", "mv-abc", "nope", "mv-abc-toolong", null, undefined, 42])(
    "rejects %s",
    (value) => {
      expect(isCorrelationId(value)).toBe(false);
    },
  );
});

describe("ambient context", () => {
  it("is undefined outside a tool call", () => {
    // Honest about not belonging to a call, rather than inventing a value.
    expect(currentCorrelationId()).toBeUndefined();
  });

  it("is readable inside the call", () => {
    runWithCorrelationId("mv-test-0001", () => {
      expect(currentCorrelationId()).toBe("mv-test-0001");
    });
  });

  it("does not leak after the call returns", () => {
    runWithCorrelationId("mv-test-0001", () => undefined);

    expect(currentCorrelationId()).toBeUndefined();
  });

  it("survives an await boundary", async () => {
    await runWithCorrelationId("mv-test-0002", async () => {
      await Promise.resolve();
      expect(currentCorrelationId()).toBe("mv-test-0002");
    });
  });

  it("survives a nested async helper", async () => {
    async function deep(): Promise<string | undefined> {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentCorrelationId();
    }

    await runWithCorrelationId("mv-test-0003", async () => {
      expect(await deep()).toBe("mv-test-0003");
    });
  });

  it("keeps concurrent calls isolated", async () => {
    const seen: string[] = [];

    async function call(id: string, delayMs: number): Promise<void> {
      await runWithCorrelationId(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(currentCorrelationId()!);
      });
    }

    // Interleaved on purpose: the slower call finishes second and must still
    // see its own id.
    await Promise.all([call("mv-a-0001", 20), call("mv-b-0002", 1)]);

    expect(seen.sort()).toEqual(["mv-a-0001", "mv-b-0002"]);
  });

  it("nests, with the inner id winning", () => {
    runWithCorrelationId("outer", () => {
      runWithCorrelationId("inner", () => {
        expect(currentCorrelationId()).toBe("inner");
      });
      expect(currentCorrelationId()).toBe("outer");
    });
  });

  it("restores the context when the body throws", () => {
    expect(() =>
      runWithCorrelationId("mv-test-0004", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(currentCorrelationId()).toBeUndefined();
  });
});

describe("withNewCorrelationId", () => {
  it("hands the id to the callback and sets the context", () => {
    withNewCorrelationId((id) => {
      expect(isCorrelationId(id)).toBe(true);
      expect(currentCorrelationId()).toBe(id);
    });
  });

  it("returns the callback's value", () => {
    expect(withNewCorrelationId(() => "result")).toBe("result");
  });

  it("accepts an explicit id, for deterministic tests", () => {
    withNewCorrelationId((id) => expect(id).toBe("mv-fixed-0001"), "mv-fixed-0001");
  });

  it("gives each call a distinct id", () => {
    const first = withNewCorrelationId((id) => id);
    const second = withNewCorrelationId((id) => id);

    expect(first).not.toBe(second);
  });
});

describe("attaching to a result", () => {
  it("puts the id in _meta", () => {
    const result = attachCorrelationId({ content: [] }, "mv-test-0005");

    expect(result._meta?.[CORRELATION_META_KEY]).toBe("mv-test-0005");
  });

  it("leaves the agent-facing content untouched", () => {
    const result = attachCorrelationId({ content: [{ type: "text", text: "hello" }] }, "mv-x-0001");

    // An opaque token in front of the model on every call would be a cost with
    // no benefit; _meta is what MCP reserves for this.
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("preserves existing _meta", () => {
    const result = attachCorrelationId({ _meta: { other: 1 } }, "mv-test-0006");

    expect(result._meta).toEqual({ other: 1, [CORRELATION_META_KEY]: "mv-test-0006" });
  });

  it("does not mutate the input", () => {
    const original = { content: [] };
    attachCorrelationId(original, "mv-test-0007");

    expect(original).not.toHaveProperty("_meta");
  });

  it("uses the ambient id when none is passed", () => {
    runWithCorrelationId("mv-ambient-0001", () => {
      expect(correlationIdOf(attachCorrelationId({}))).toBe("mv-ambient-0001");
    });
  });

  it("is a no-op with no id available", () => {
    const result = attachCorrelationId({ content: [] });

    expect(result).not.toHaveProperty("_meta");
  });

  it("round-trips through correlationIdOf", () => {
    expect(correlationIdOf(attachCorrelationId({}, "mv-test-0008"))).toBe("mv-test-0008");
  });

  it("reads nothing off a result without one", () => {
    expect(correlationIdOf({})).toBeUndefined();
    expect(correlationIdOf(null)).toBeUndefined();
    expect(correlationIdOf({ _meta: { [CORRELATION_META_KEY]: 42 } })).toBeUndefined();
  });
});

describe("correlationSuffix", () => {
  it("renders a quotable suffix", () => {
    expect(correlationSuffix("mv-test-0009")).toBe(" [correlation: mv-test-0009]");
  });

  it("is empty with no id", () => {
    expect(correlationSuffix(undefined)).toBe("");
  });

  it("uses the ambient id", () => {
    runWithCorrelationId("mv-amb-0002", () => {
      expect(correlationSuffix()).toContain("mv-amb-0002");
    });
  });
});

describe("audit log integration", () => {
  it("stamps a tool entry with the ambient id", () => {
    const captured = captureAuditEntries();
    setAuditLogEnabled(true);

    runWithCorrelationId("mv-audit-0001", () => logToolStart("mindvault_browse"));

    expect(captured.entries[0].correlationId).toBe("mv-audit-0001");
  });

  it("stamps network requests with the same id as the tool call", () => {
    const captured = captureAuditEntries();
    setAuditLogEnabled(true);

    runWithCorrelationId("mv-audit-0002", () => {
      logToolStart("mindvault_buy");
      logNetworkRequest("GET", "https://example/resource", "api", 200, 12);
      logToolSuccess("mindvault_buy", 34);
    });

    // The whole point: one grep finds every line belonging to the call.
    const ids = captured.entries.map((entry) => entry.correlationId);
    expect(ids).toEqual(["mv-audit-0002", "mv-audit-0002", "mv-audit-0002"]);
  });

  it("omits the field outside a tool call", () => {
    const captured = captureAuditEntries();
    setAuditLogEnabled(true);

    logToolStart("mindvault_browse");

    expect(captured.entries[0]).not.toHaveProperty("correlationId");
  });

  it("keeps two concurrent calls apart in the log", async () => {
    const captured = captureAuditEntries();
    setAuditLogEnabled(true);

    async function call(id: string, tool: string, delayMs: number): Promise<void> {
      await runWithCorrelationId(id, async () => {
        logToolStart(tool);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        logToolSuccess(tool, delayMs);
      });
    }

    await Promise.all([
      call("mv-p-0001", "mindvault_browse", 20),
      call("mv-q-0002", "mindvault_search", 1),
    ]);

    for (const entry of captured.entries) {
      const expected = entry.toolName === "mindvault_browse" ? "mv-p-0001" : "mv-q-0002";
      expect(entry.correlationId).toBe(expected);
    }
  });

  it("does not disturb the rest of the entry", () => {
    const captured = captureAuditEntries();
    setAuditLogEnabled(true);

    runWithCorrelationId("mv-audit-0003", () =>
      logToolSuccess("mindvault_browse", 7, { network: "testnet" }),
    );

    expect(captured.entries[0]).toMatchObject({
      toolName: "mindvault_browse",
      status: "success",
      duration: 7,
      network: "testnet",
    });
  });
});
