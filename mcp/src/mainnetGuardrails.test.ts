import { describe, it, expect } from "vitest";
import {
  MAINNET_GATED_TOOLS,
  isMainnetNetwork,
  isTruthyConfirm,
  mainnetAllowedFromEnv,
  isMainnetGatedTool,
  assertMainnetMutationAllowed,
  mainnetConfirmationRequiredError,
  formatMainnetDiagnostics,
  formatMainnetBanner,
} from "./mainnetGuardrails.js";

describe("isMainnetNetwork", () => {
  it("detects mainnet aliases", () => {
    for (const v of [
      "mainnet",
      "MAINNET",
      "pubnet",
      "public",
      "stellar:pubnet",
      "stellar:mainnet",
    ]) {
      expect(isMainnetNetwork(v)).toBe(true);
    }
  });

  it("rejects testnet and empty", () => {
    for (const v of ["testnet", "stellar:testnet", "", undefined, "dev"]) {
      expect(isMainnetNetwork(v as string | undefined)).toBe(false);
    }
  });
});

describe("isTruthyConfirm", () => {
  it("accepts true-ish values", () => {
    expect(isTruthyConfirm(true)).toBe(true);
    expect(isTruthyConfirm(1)).toBe(true);
    expect(isTruthyConfirm("true")).toBe(true);
    expect(isTruthyConfirm("TRUE")).toBe(true);
    expect(isTruthyConfirm("1")).toBe(true);
    expect(isTruthyConfirm("yes")).toBe(true);
  });

  it("rejects false-ish values", () => {
    expect(isTruthyConfirm(false)).toBe(false);
    expect(isTruthyConfirm(0)).toBe(false);
    expect(isTruthyConfirm("false")).toBe(false);
    expect(isTruthyConfirm("no")).toBe(false);
    expect(isTruthyConfirm(undefined)).toBe(false);
    expect(isTruthyConfirm(null)).toBe(false);
  });
});

describe("mainnetAllowedFromEnv", () => {
  it("reads MINDVAULT_ALLOW_MAINNET", () => {
    expect(mainnetAllowedFromEnv({ MINDVAULT_ALLOW_MAINNET: "1" })).toBe(true);
    expect(mainnetAllowedFromEnv({ MINDVAULT_ALLOW_MAINNET: "true" })).toBe(true);
    expect(mainnetAllowedFromEnv({ MINDVAULT_ALLOW_MAINNET: "0" })).toBe(false);
    expect(mainnetAllowedFromEnv({})).toBe(false);
  });
});

describe("isMainnetGatedTool", () => {
  it("gates mutations and buys", () => {
    for (const t of MAINNET_GATED_TOOLS) {
      expect(isMainnetGatedTool(t)).toBe(true);
    }
  });

  it("leaves read-only tools free", () => {
    for (const t of [
      "mindvault_browse",
      "mindvault_search",
      "mindvault_preview",
      "mindvault_wallet_info",
      "mindvault_list_profiles",
      "mindvault_registry_info",
      "mindvault_registry_lookup",
      "mindvault_tx_status",
      "mindvault_publish_status",
      "mindvault_check_bindings",
      "mindvault_agent_status",
      "mindvault_metrics",
      "mindvault_purchase_history",
    ]) {
      expect(isMainnetGatedTool(t)).toBe(false);
    }
  });
});

describe("assertMainnetMutationAllowed", () => {
  it("no-ops on testnet even without confirm", () => {
    expect(() => assertMainnetMutationAllowed("testnet", "mindvault_buy", {}, {})).not.toThrow();
  });

  it("no-ops for read-only tools on mainnet", () => {
    expect(() => assertMainnetMutationAllowed("mainnet", "mindvault_browse", {}, {})).not.toThrow();
  });

  it("blocks gated tools on mainnet without confirm", () => {
    expect(() => assertMainnetMutationAllowed("mainnet", "mindvault_buy", {}, {})).toThrow(
      /Mainnet guardrail/,
    );
    expect(() => assertMainnetMutationAllowed("mainnet", "mindvault_publish", {}, {})).toThrow(
      /confirmMainnet/,
    );
    expect(() => assertMainnetMutationAllowed("mainnet", "mindvault_set_tags", {}, {})).toThrow(
      /confirmMainnet/,
    );
  });

  it("allows gated tools when confirmMainnet is true", () => {
    expect(() =>
      assertMainnetMutationAllowed("mainnet", "mindvault_buy", { confirmMainnet: true }, {}),
    ).not.toThrow();
  });

  it("allows gated tools when MINDVAULT_ALLOW_MAINNET is set", () => {
    expect(() =>
      assertMainnetMutationAllowed(
        "mainnet",
        "mindvault_register",
        {},
        {
          MINDVAULT_ALLOW_MAINNET: "1",
        },
      ),
    ).not.toThrow();
  });

  it("error message is deterministic and agent-safe", () => {
    const err = mainnetConfirmationRequiredError("mindvault_buy");
    expect(err.message).toContain("mindvault_buy");
    expect(err.message).toContain("confirmMainnet");
    expect(err.message).toContain("MINDVAULT_ALLOW_MAINNET");
    expect(err.message).not.toMatch(/secret|private|key|password/i);
  });
});

describe("formatMainnetDiagnostics", () => {
  it("summarizes network + confirmation mode", () => {
    const text = formatMainnetDiagnostics({
      stellarNetwork: "mainnet",
      x402Network: "stellar:pubnet",
      registryContractId: "CABC",
      allowMainnetEnv: false,
    });
    expect(text).toContain("mainnet");
    expect(text).toContain("stellar:pubnet");
    expect(text).toContain("CABC");
    expect(text).toContain("confirmMainnet");
  });
});

describe("formatMainnetBanner", () => {
  it("reassures on testnet — no confirmation instructions", () => {
    const text = formatMainnetBanner({
      stellarNetwork: "testnet",
      x402Network: "stellar:testnet",
      registryContractId: "CTEST",
      allowMainnetEnv: false,
    });
    expect(text).toContain("testnet");
    expect(text).toContain("not real funds");
    expect(text).not.toContain("MAINNET");
    expect(text).not.toContain("confirmMainnet: true");
  });

  it("warns prominently on mainnet and explains both confirmation paths", () => {
    const text = formatMainnetBanner({
      stellarNetwork: "mainnet",
      x402Network: "stellar:pubnet",
      registryContractId: "CLIVE",
      allowMainnetEnv: false,
    });
    expect(text).toContain("MAINNET");
    expect(text).toContain("real USDC");
    expect(text).toContain("CLIVE");
    expect(text).toContain("confirmMainnet: true");
    expect(text).toContain("MINDVAULT_ALLOW_MAINNET=1");
    for (const tool of MAINNET_GATED_TOOLS) {
      expect(text).toContain(tool);
    }
    expect(text).not.toMatch(/secret|private key|password/i);
  });

  it("flags a missing registry contract on mainnet", () => {
    const text = formatMainnetBanner({
      stellarNetwork: "mainnet",
      x402Network: "stellar:pubnet",
      registryContractId: "",
      allowMainnetEnv: false,
    });
    expect(text).toContain("unset");
  });
});
