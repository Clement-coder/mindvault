/**
 * Tests for the paid-operation confirmation policy (#594).
 *
 * The policy answers a question neither existing guardrail asks. The mainnet
 * guardrail asks *where* the spend happens and lets everything through on
 * testnet; the auto-pay ceiling asks *how much* and lets a hundred cheap
 * purchases through. This one asks whether the caller meant to spend at all,
 * on any network, at any price.
 *
 * Three things have to hold, and the third is the one most easily lost:
 *
 *   1. The policy classifies and decides correctly (pure functions).
 *   2. The dispatcher consults it (wiring).
 *   3. It *composes* with the other two guardrails rather than replacing them —
 *      satisfying this one must not quietly unlock a mainnet spend, and the
 *      default must leave every existing deployment behaving exactly as before.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_PAID_CONFIRMATION_POLICY,
  FEE_SPENDING_TOOLS,
  PAID_CONFIRMATION_ARG,
  PAID_CONFIRMATION_ENV_VAR,
  USDC_SPENDING_TOOLS,
  assertPaidOperationConfirmed,
  formatPaidConfirmationDiagnostics,
  paidConfirmationRequiredError,
  paidOperationClass,
  paidOperationToolNames,
  requiresPaidConfirmation,
  resolvePaidConfirmationPolicy,
} from "./paidOperations.js";
import {
  harnessIsToolError,
  harnessResultText,
  startIntegrationHarness,
} from "./integrationHarness.js";
import type { IntegrationHarness } from "./integrationHarness.js";

process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const home = mkdtempSync(join(tmpdir(), "mindvault-mcp-paid-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { server, dispatchTool } = await import("./index.js");

const envWith = (policy: string) => ({ [PAID_CONFIRMATION_ENV_VAR]: policy });

/**
 * The message a dispatch failed with, or `null` when it succeeded.
 *
 * Used where the assertion is about *which* error came back rather than
 * whether one did: several gated tools fail downstream in mock mode (no
 * wallet, no live RPC), and a test that asserted "rejects" would break if one
 * of them ever started succeeding — for a reason unrelated to what it checks.
 */
async function dispatchFailure(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  try {
    await dispatchTool(name, args);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// ── Policy resolution ────────────────────────────────────────────────────────

describe("resolvePaidConfirmationPolicy", () => {
  it("defaults to off so an upgrade changes no existing deployment", () => {
    expect(resolvePaidConfirmationPolicy({})).toBe(DEFAULT_PAID_CONFIRMATION_POLICY);
    expect(DEFAULT_PAID_CONFIRMATION_POLICY).toBe("off");
  });

  it.each(["off", "usdc", "all"])("accepts %j", (policy) => {
    expect(resolvePaidConfirmationPolicy(envWith(policy))).toBe(policy);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolvePaidConfirmationPolicy(envWith("  USDC  "))).toBe("usdc");
  });

  it("reads an empty value as unset", () => {
    // What a shell leaves behind for `export MINDVAULT_CONFIRM_PAID_OPERATIONS=`.
    expect(resolvePaidConfirmationPolicy(envWith(""))).toBe("off");
    expect(resolvePaidConfirmationPolicy(envWith("   "))).toBe("off");
  });

  it("throws on an unrecognized value instead of falling back to off", () => {
    // The important one. A typo in a safety setting that silently disables it
    // is worse than one that stops the server: the operator believes they are
    // protected. `true` is the likeliest typo, so it is named explicitly.
    expect(() => resolvePaidConfirmationPolicy(envWith("true"))).toThrow(
      /must be one of: off, usdc, all/,
    );
    expect(() => resolvePaidConfirmationPolicy(envWith("1"))).toThrow(/must be one of/);
    expect(() => resolvePaidConfirmationPolicy(envWith("yes"))).toThrow(/must be one of/);
  });

  it("quotes the offending value in the error", () => {
    expect(() => resolvePaidConfirmationPolicy(envWith("usdcc"))).toThrow(/"usdcc"/);
  });
});

// ── Classification ───────────────────────────────────────────────────────────

describe("paidOperationClass", () => {
  it("classifies the USDC spenders", () => {
    for (const name of USDC_SPENDING_TOOLS) {
      expect(paidOperationClass(name), name).toBe("usdc");
    }
    expect(USDC_SPENDING_TOOLS).toEqual([
      "mindvault_publish",
      "mindvault_publish_batch",
      "mindvault_buy",
    ]);
  });

  it("classifies the network-fee spenders", () => {
    for (const name of FEE_SPENDING_TOOLS) {
      expect(paidOperationClass(name), name).toBe("fee");
    }
  });

  it("classifies tools that cost nothing as null", () => {
    for (const name of [
      "mindvault_browse",
      "mindvault_search",
      "mindvault_preview",
      "mindvault_wallet_info",
      "mindvault_reset",
      "mindvault_registry_lookup",
    ]) {
      expect(paidOperationClass(name), name).toBeNull();
    }
  });

  it("does not gate wallet setup, which the sponsor pays for", () => {
    // Account creation goes through the sponsored-account service; the agent's
    // own wallet funds nothing, so requiring a spend confirmation would be a
    // lie about what the call costs.
    expect(paidOperationClass("mindvault_setup_wallet")).toBeNull();
  });

  it("treats an unknown name as costing nothing", () => {
    // Failing open is right here: this classifier must not become a second,
    // accidental allowlist for tool names. The dispatcher rejects unknown tools.
    expect(paidOperationClass("mindvault_not_a_tool")).toBeNull();
  });

  it("lists every gated tool once, sorted", () => {
    const names = paidOperationToolNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(USDC_SPENDING_TOOLS.length + FEE_SPENDING_TOOLS.length);
  });
});

// ── The decision ─────────────────────────────────────────────────────────────

describe("requiresPaidConfirmation", () => {
  it("requires nothing under off", () => {
    for (const name of paidOperationToolNames()) {
      expect(requiresPaidConfirmation(name, "off"), name).toBe(false);
    }
  });

  it("requires confirmation for USDC spends under usdc", () => {
    for (const name of USDC_SPENDING_TOOLS) {
      expect(requiresPaidConfirmation(name, "usdc"), name).toBe(true);
    }
  });

  it("leaves fee-only spends alone under usdc", () => {
    // The whole reason `all` is a separate step: an operator may care about
    // USDC leaving the wallet without wanting every on-chain edit gated.
    for (const name of FEE_SPENDING_TOOLS) {
      expect(requiresPaidConfirmation(name, "usdc"), name).toBe(false);
    }
  });

  it("requires confirmation for every spend under all", () => {
    for (const name of paidOperationToolNames()) {
      expect(requiresPaidConfirmation(name, "all"), name).toBe(true);
    }
  });

  it("never requires confirmation for a tool that costs nothing", () => {
    for (const policy of ["off", "usdc", "all"] as const) {
      expect(requiresPaidConfirmation("mindvault_browse", policy), policy).toBe(false);
    }
  });
});

describe("assertPaidOperationConfirmed", () => {
  it("allows everything under the default policy", () => {
    for (const name of paidOperationToolNames()) {
      expect(() =>
        assertPaidOperationConfirmed({ toolName: name, args: {}, env: {} }),
      ).not.toThrow();
    }
  });

  it("blocks an unconfirmed spend under usdc", () => {
    expect(() =>
      assertPaidOperationConfirmed({ toolName: "mindvault_buy", args: {}, env: envWith("usdc") }),
    ).toThrow(/Paid-operation guardrail/);
  });

  it("allows a confirmed spend", () => {
    expect(() =>
      assertPaidOperationConfirmed({
        toolName: "mindvault_buy",
        args: { [PAID_CONFIRMATION_ARG]: true },
        env: envWith("usdc"),
      }),
    ).not.toThrow();
  });

  it.each([true, 1, "true", "1", "yes"])("accepts %j as confirmation", (value) => {
    // The same truthy forms as confirmMainnet, so agents learn one convention
    // rather than one per guardrail.
    expect(() =>
      assertPaidOperationConfirmed({
        toolName: "mindvault_buy",
        args: { [PAID_CONFIRMATION_ARG]: value },
        env: envWith("usdc"),
      }),
    ).not.toThrow();
  });

  it.each([false, 0, "false", "no", "", null, undefined])(
    "does not accept %j as confirmation",
    (value) => {
      expect(() =>
        assertPaidOperationConfirmed({
          toolName: "mindvault_buy",
          args: { [PAID_CONFIRMATION_ARG]: value },
          env: envWith("usdc"),
        }),
      ).toThrow(/Paid-operation guardrail/);
    },
  );

  it("exempts a dry run", () => {
    // A dry run submits no payment. Gating it would mean confirming a spend in
    // order to find out what the spend would be.
    expect(() =>
      assertPaidOperationConfirmed({
        toolName: "mindvault_buy",
        args: {},
        dryRun: true,
        env: envWith("all"),
      }),
    ).not.toThrow();
  });

  it("tolerates missing arguments", () => {
    expect(() =>
      assertPaidOperationConfirmed({
        toolName: "mindvault_buy",
        args: undefined,
        env: envWith("usdc"),
      }),
    ).toThrow(/Paid-operation guardrail/);
  });

  it("surfaces a misconfigured policy rather than skipping the check", () => {
    expect(() =>
      assertPaidOperationConfirmed({ toolName: "mindvault_buy", args: {}, env: envWith("on") }),
    ).toThrow(/must be one of/);
  });
});

describe("paidConfirmationRequiredError", () => {
  const message = paidConfirmationRequiredError("mindvault_buy", "usdc").message;

  it("names the tool, the policy, and the argument that satisfies it", () => {
    expect(message).toContain("mindvault_buy");
    expect(message).toContain(PAID_CONFIRMATION_ENV_VAR);
    expect(message).toContain(PAID_CONFIRMATION_ARG);
  });

  it("says what the call would cost", () => {
    expect(message).toMatch(/spends USDC/);
    expect(paidConfirmationRequiredError("mindvault_set_price", "all").message).toMatch(
      /network fees/,
    );
  });

  it("is deterministic and leaks nothing", () => {
    expect(paidConfirmationRequiredError("mindvault_buy", "usdc").message).toBe(message);
    expect(message).not.toMatch(/\/(home|Users|tmp)\//);
    expect(message).not.toContain("at ");
  });
});

describe("formatPaidConfirmationDiagnostics", () => {
  it("reports the policy as off and how to enable it", () => {
    expect(formatPaidConfirmationDiagnostics({})).toMatch(/off/);
    expect(formatPaidConfirmationDiagnostics({})).toContain(PAID_CONFIRMATION_ENV_VAR);
  });

  it("names the gated tools under each active policy", () => {
    expect(formatPaidConfirmationDiagnostics(envWith("usdc"))).toContain("mindvault_buy");
    expect(formatPaidConfirmationDiagnostics(envWith("all"))).toContain("mindvault_set_price");
  });

  it("reports a misconfiguration instead of throwing", () => {
    // Diagnostics run in status output; they have to describe a broken setting
    // rather than take the status tool down with them.
    expect(formatPaidConfirmationDiagnostics(envWith("nope"))).toMatch(/misconfigured/);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe("the paid-operation policy through the MCP server", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    // Also clear it here, not only in afterEach: vitest may place another file
    // in this worker, and a suite that died mid-run would otherwise leak the
    // variable into it.
    delete process.env[PAID_CONFIRMATION_ENV_VAR];
    await harness?.close();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env[PAID_CONFIRMATION_ENV_VAR];
  });

  it("blocks an unconfirmed buy under usdc", async () => {
    process.env[PAID_CONFIRMATION_ENV_VAR] = "usdc";
    const result = await harness.callTool("mindvault_buy", { resourceId: "mock-1" });

    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toContain("Paid-operation guardrail");
  });

  it("lets a confirmed buy past the guardrail", async () => {
    process.env[PAID_CONFIRMATION_ENV_VAR] = "usdc";
    // The call still fails — there is no wallet in this profile — but it fails
    // *inside the tool*, which is what proves the guardrail let it through.
    await expect(
      dispatchTool("mindvault_buy", { resourceId: "mock-1", confirmPaid: true }),
    ).rejects.toThrow(/No wallet in profile/);
  });

  it("lets a dry run past without confirmation", async () => {
    process.env[PAID_CONFIRMATION_ENV_VAR] = "all";
    const result = await harness.callTool("mindvault_buy", {
      resourceId: "mock-1",
      dryRun: true,
    });

    expect(harnessIsToolError(result)).toBe(false);
    expect(harnessResultText(result)).toContain("dry-run");
  });

  it("leaves fee-only tools alone under usdc but gates them under all", async () => {
    const args = { resourceId: "mock-1", price: "1.00" };

    process.env[PAID_CONFIRMATION_ENV_VAR] = "usdc";
    expect(await dispatchFailure("mindvault_set_price", args)).not.toMatch(
      /Paid-operation guardrail/,
    );

    process.env[PAID_CONFIRMATION_ENV_VAR] = "all";
    expect(await dispatchFailure("mindvault_set_price", args)).toMatch(/Paid-operation guardrail/);
  });

  it("does not gate read-only tools under any policy", async () => {
    for (const policy of ["usdc", "all"]) {
      process.env[PAID_CONFIRMATION_ENV_VAR] = policy;
      const result = await harness.callTool("mindvault_browse", {});
      expect(harnessIsToolError(result), policy).toBe(false);
    }
  });

  it("changes nothing when the policy is off", async () => {
    // The upgrade-safety property: an existing deployment that never sets the
    // variable must behave exactly as it did before this guardrail existed.
    await expect(dispatchTool("mindvault_buy", { resourceId: "mock-1" })).rejects.toThrow(
      /No wallet in profile/,
    );
  });

  it("accepts confirmPaid as a validated argument on every gated tool", async () => {
    // A guardrail whose own argument the validator rejects is unusable — the
    // shape of the mindvault_reset.confirm bug in #596.
    process.env[PAID_CONFIRMATION_ENV_VAR] = "all";
    for (const name of paidOperationToolNames()) {
      const failure = await dispatchFailure(name, { confirmPaid: true });
      expect(failure, `${name} rejected its own confirmation argument`).not.toMatch(
        /not a recognized argument/,
      );
      expect(failure, `${name} was still gated after confirming`).not.toMatch(
        /Paid-operation guardrail/,
      );
    }
  });

  it("reports a misconfigured policy as a tool error, not a crash", async () => {
    process.env[PAID_CONFIRMATION_ENV_VAR] = "loud";
    const result = await harness.callTool("mindvault_buy", { resourceId: "mock-1" });

    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toContain("must be one of");
  });
});

describe("composition with the other guardrails", () => {
  afterEach(() => {
    delete process.env[PAID_CONFIRMATION_ENV_VAR];
  });

  it("does not let confirmPaid stand in for confirmMainnet", async () => {
    // Each guardrail answers its own question. Satisfying the spend policy must
    // not imply consent to spend on the *public* network — that is a separate
    // decision with a separate flag.
    const { assertMainnetMutationAllowed } = await import("./mainnetGuardrails.js");
    expect(() =>
      assertMainnetMutationAllowed("mainnet", "mindvault_buy", { confirmPaid: true }, {}),
    ).toThrow(/Mainnet guardrail/);
  });

  it("does not let confirmMainnet stand in for confirmPaid", () => {
    expect(() =>
      assertPaidOperationConfirmed({
        toolName: "mindvault_buy",
        args: { confirmMainnet: true },
        env: envWith("usdc"),
      }),
    ).toThrow(/Paid-operation guardrail/);
  });

  it("requires both when both apply", async () => {
    const { assertMainnetMutationAllowed } = await import("./mainnetGuardrails.js");
    const args = { confirmMainnet: true, confirmPaid: true };

    expect(() => assertMainnetMutationAllowed("mainnet", "mindvault_buy", args, {})).not.toThrow();
    expect(() =>
      assertPaidOperationConfirmed({ toolName: "mindvault_buy", args, env: envWith("usdc") }),
    ).not.toThrow();
  });
});
