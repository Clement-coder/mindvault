/**
 * Unit tests for the mindvault_reset confirmation guard (#406).
 *
 * Covers the pure decision/formatting layer. The wiring — that an unconfirmed
 * call leaves credentials intact and a confirmed one clears them — is asserted
 * against the live `resetState` export in index.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  formatResetPreview,
  isResetConfirmed,
  RESET_CONFIRM_LITERALS,
  RESET_CONFIRM_STRINGS,
  type ResetScope,
} from "./resetGuard.js";
import { isTruthyConfirm } from "./mainnetGuardrails.js";
import { mockEnabledFromEnv } from "./mock.js";

function scope(overrides: Partial<ResetScope> = {}): ResetScope {
  return {
    all: false,
    activeProfile: "default",
    profileNames: ["default"],
    hasWallet: true,
    hasApiKey: true,
    stateFile: "/home/agent/.mindvault/state.json",
    ...overrides,
  };
}

describe("isResetConfirmed", () => {
  it("accepts the documented truthy confirmations", () => {
    expect(isResetConfirmed(true)).toBe(true);
    expect(isResetConfirmed(1)).toBe(true);
    expect(isResetConfirmed("true")).toBe(true);
    expect(isResetConfirmed("TRUE")).toBe(true);
    expect(isResetConfirmed("yes")).toBe(true);
    expect(isResetConfirmed("1")).toBe(true);
  });

  it("treats a missing or false-ish argument as not confirmed", () => {
    expect(isResetConfirmed(undefined)).toBe(false);
    expect(isResetConfirmed(null)).toBe(false);
    expect(isResetConfirmed(false)).toBe(false);
    expect(isResetConfirmed("")).toBe(false);
    expect(isResetConfirmed("no")).toBe(false);
    expect(isResetConfirmed(0)).toBe(false);
    expect(isResetConfirmed({})).toBe(false);
  });
});

/**
 * Reset is the one confirmation whose false positive cannot be undone, so its
 * vocabulary is pinned here (#836). These tests fail if the accepted set is
 * widened — which is the point: widening it must be a deliberate, reviewed edit
 * rather than a side effect of relaxing some other notion of "truthy".
 */
describe("reset confirmation vocabulary (#836)", () => {
  it("accepts exactly the codified spellings", () => {
    expect([...RESET_CONFIRM_STRINGS]).toEqual(["true", "1", "yes"]);
    expect([...RESET_CONFIRM_LITERALS]).toEqual([true, 1]);
    expect(Object.isFrozen(RESET_CONFIRM_STRINGS)).toBe(true);
    expect(Object.isFrozen(RESET_CONFIRM_LITERALS)).toBe(true);
  });

  it("accepts every codified spelling, normalizing case and surrounding space", () => {
    for (const value of RESET_CONFIRM_STRINGS) {
      expect(isResetConfirmed(value), value).toBe(true);
      expect(isResetConfirmed(value.toUpperCase()), value.toUpperCase()).toBe(true);
      expect(isResetConfirmed(`  ${value}  `), `padded ${value}`).toBe(true);
    }
    for (const value of RESET_CONFIRM_LITERALS) {
      expect(isResetConfirmed(value), String(value)).toBe(true);
    }
  });

  it("rejects spellings other parts of the server treat as truthy", () => {
    // mock.ts accepts "on"; a flag argument may arrive as "y" or "ok" from a
    // client that normalizes differently. None of them may wipe a keystore.
    for (const value of ["on", "y", "ok", "sure", "enable", "enabled", "confirm", "affirmative"]) {
      expect(isResetConfirmed(value), value).toBe(false);
    }
    expect(isResetConfirmed(2)).toBe(false);
    expect(isResetConfirmed(-1)).toBe(false);
    expect(isResetConfirmed([true])).toBe(false);
    expect(isResetConfirmed({ confirm: true })).toBe(false);
    expect(isResetConfirmed(() => true)).toBe(false);
  });

  it("does not inherit another vocabulary's widening", () => {
    // mock mode's "on" is truthy there and must not be truthy here. This is the
    // regression the issue describes: one shared helper, two blast radii.
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "on" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isResetConfirmed("on")).toBe(false);
  });

  it("stays no wider than the mainnet confirmation it used to delegate to", () => {
    // Identical today. If someone widens isTruthyConfirm, reset must not follow;
    // this asserts the direction of the relationship, not that they are equal.
    for (const value of ["true", "1", "yes", "TRUE", " yes "]) {
      if (isResetConfirmed(value)) expect(isTruthyConfirm(value), value).toBe(true);
    }
  });
});

describe("formatResetPreview", () => {
  it("warns without claiming anything was cleared", () => {
    const preview = formatResetPreview(scope());
    expect(preview).toContain("Reset NOT performed");
    expect(preview).toContain("confirmation required");
    expect(preview).toContain("confirm: true");
  });

  it("names the active profile and the credentials at risk", () => {
    const preview = formatResetPreview(scope({ activeProfile: "publisher" }));
    expect(preview).toContain('the active profile "publisher"');
    expect(preview).toContain("wallet secret key");
    expect(preview).toContain("publisher API key");
  });

  it("reports when the active profile holds nothing", () => {
    const preview = formatResetPreview(scope({ hasWallet: false, hasApiKey: false }));
    expect(preview).toContain("no stored credentials");
  });

  it("describes an all=true reset as every profile plus the state file", () => {
    const preview = formatResetPreview(
      scope({ all: true, profileNames: ["publisher", "buyer", "default"] }),
    );
    expect(preview).toContain("ALL 3 profile(s)");
    expect(preview).toContain("buyer, default, publisher"); // sorted, deterministic
    expect(preview).toContain("the state file itself");
    expect(preview).toContain("confirm: true and all: true");
  });

  it("includes the state file path and the backup escape hatch", () => {
    const preview = formatResetPreview(scope());
    expect(preview).toContain("/home/agent/.mindvault/state.json");
    expect(preview).toContain("mindvault_backup_state");
  });

  it("is deterministic for a given scope", () => {
    expect(formatResetPreview(scope())).toBe(formatResetPreview(scope()));
  });
});
