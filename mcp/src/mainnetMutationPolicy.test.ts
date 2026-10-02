/**
 * Safer defaults for the mainnet mutation env override (#606).
 *
 * `MINDVAULT_ALLOW_MAINNET` is the one knob that turns off per-call
 * confirmation for every gated tool at once, so the way its value is parsed is
 * itself a safety property. These tests pin the fail-safe policy table: only
 * the documented opt-in spellings widen the policy, everything else — explicit
 * denials, whitespace, unrecognized values, an unexpanded shell-template
 * placeholder — keeps the safe default, and startup diagnostics flag the
 * set-but-ineffective values that almost always mean a deployment mistake.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAINNET_MUTATION_POLICY,
  isExplicitMainnetDenial,
  mainnetAllowedFromEnv,
  mainnetMutationPolicyFromEnv,
  unsafeMainnetAllow,
} from "./mainnetGuardrails.js";
import { collectStartupDiagnostics } from "./diagnostics.js";

describe("mainnet mutation policy (#606)", () => {
  it("defaults to per-call confirmation", () => {
    expect(DEFAULT_MAINNET_MUTATION_POLICY).toBe("per-call-confirm");
  });

  it("keeps per-call confirmation for every unset-like value", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(mainnetMutationPolicyFromEnv({ MINDVAULT_ALLOW_MAINNET: raw as string })).toBe(
        "per-call-confirm",
      );
    }
    expect(mainnetMutationPolicyFromEnv({})).toBe("per-call-confirm");
  });

  it("keeps per-call confirmation for explicit denials", () => {
    for (const raw of ["0", "false", "no", "off", "FALSE", "Off", " no "]) {
      expect(mainnetMutationPolicyFromEnv({ MINDVAULT_ALLOW_MAINNET: raw })).toBe(
        "per-call-confirm",
      );
    }
  });

  it("keeps per-call confirmation for unrecognized and typo'd values", () => {
    // Each of these used to be a silent no-op under the truthiness check; they
    // must never become an unlock by accident. Note that whitespace-padded
    // spellings ("true ") are NOT here: isTruthyConfirm has always trimmed,
    // and #606 preserves every value it accepted before.
    for (const raw of [
      "on",
      "enabled",
      "allow",
      "2",
      "confirm",
      "$MINDVAULT_ALLOW_MAINNET",
      "1;",
      "Y",
    ]) {
      expect(mainnetMutationPolicyFromEnv({ MINDVAULT_ALLOW_MAINNET: raw }), raw).toBe(
        "per-call-confirm",
      );
    }
  });

  it("widens the policy only for the documented opt-in spellings", () => {
    // Padded spellings trim to a documented value — isTruthyConfirm has
    // trimmed since before #606, and preserving that is part of the
    // behaviour-compatibility contract.
    for (const raw of ["1", "true", "yes", "TRUE", "Yes", "true ", "yes\n"]) {
      expect(mainnetMutationPolicyFromEnv({ MINDVAULT_ALLOW_MAINNET: raw }), raw).toBe("allow-all");
    }
  });

  it("keeps mainnetAllowedFromEnv behaviour for the values it accepted before", () => {
    expect(mainnetAllowedFromEnv({ MINDVAULT_ALLOW_MAINNET: "1" })).toBe(true);
    expect(mainnetAllowedFromEnv({ MINDVAULT_ALLOW_MAINNET: "true" })).toBe(true);
    expect(mainnetAllowedFromEnv({ MINDVAULT_ALLOW_MAINNET: "yes" })).toBe(true);
    expect(mainnetAllowedFromEnv({ MINDVAULT_ALLOW_MAINNET: "0" })).toBe(false);
    expect(mainnetAllowedFromEnv({})).toBe(false);
  });

  it("reports a set-but-ineffective value as an ineffective unlock", () => {
    expect(unsafeMainnetAllow("0")).toBe(false);
    expect(unsafeMainnetAllow("$MINDVAULT_ALLOW_MAINNET")).toBe(false);
    expect(unsafeMainnetAllow(1)).toBe(true);
  });

  it("recognizes explicit denials so diagnostics can stay quiet about them", () => {
    // Padded spellings trim (consistent with isTruthyConfirm): a stray space
    // in an env file is not a different intent.
    for (const raw of ["0", "false", "no", "off", "OFF", "0 "]) {
      expect(isExplicitMainnetDenial(raw), raw).toBe(true);
    }
    for (const raw of [undefined, null, 0, false, "", "   ", "nope", "$VAR"]) {
      expect(isExplicitMainnetDenial(raw as unknown), String(raw)).toBe(false);
    }
  });
});

describe("startup diagnostics for MINDVAULT_ALLOW_MAINNET (#606)", () => {
  const envWith = (value: string | undefined): NodeJS.ProcessEnv =>
    value === undefined ? {} : { MINDVAULT_ALLOW_MAINNET: value };

  const allowMainnetDiagnostics = (env: NodeJS.ProcessEnv) =>
    collectStartupDiagnostics(env, true).filter((d) => d.variable === "MINDVAULT_ALLOW_MAINNET");

  it("stays quiet when the variable is unset", () => {
    expect(allowMainnetDiagnostics(envWith(undefined))).toEqual([]);
  });

  it("stays quiet for the documented opt-in spellings", () => {
    for (const raw of ["1", "true", "yes"]) {
      expect(allowMainnetDiagnostics(envWith(raw)), raw).toEqual([]);
    }
  });

  it("stays quiet for explicit denials — the operator stated intent", () => {
    for (const raw of ["0", "false", "no", "off"]) {
      expect(allowMainnetDiagnostics(envWith(raw)), raw).toEqual([]);
    }
  });

  it("warns on a set value that unlocks nothing", () => {
    for (const raw of ["on", "enabled", "$MINDVAULT_ALLOW_MAINNET", "maybe"]) {
      const issues = allowMainnetDiagnostics(envWith(raw));
      expect(issues, raw).toHaveLength(1);
      expect(issues[0].severity).toBe("warning");
      expect(issues[0].message).toMatch(/does not unlock mainnet mutations/);
      expect(issues[0].expected).toMatch(/per-call confirmation/);
    }
  });

  it("never blocks startup for an ineffective value — the fallback is the safe default", () => {
    const diagnostics = collectStartupDiagnostics(
      { MINDVAULT_ALLOW_MAINNET: "$MINDVAULT_ALLOW_MAINNET" },
      true,
    );
    expect(diagnostics.find((d) => d.variable === "MINDVAULT_ALLOW_MAINNET")?.severity).toBe(
      "warning",
    );
  });
});
