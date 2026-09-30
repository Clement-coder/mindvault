import { describe, it, expect } from "vitest";

import {
  collectStartupDiagnostics,
  formatDiagnostics,
  hasBlockingDiagnostics,
} from "./diagnostics.js";

// A minimal env that passes every other check, so these tests isolate the
// missing-global-fetch diagnostic (#665) from the rest of the module.
const VALID_ENV: NodeJS.ProcessEnv = {
  STELLAR_NETWORK: "testnet",
};

describe("collectStartupDiagnostics — global fetch", () => {
  it("reports no diagnostic when a global fetch is available", () => {
    const diagnostics = collectStartupDiagnostics(VALID_ENV, true);
    expect(diagnostics).toEqual([]);
  });

  it("reports a blocking error when no global fetch is available", () => {
    const diagnostics = collectStartupDiagnostics(VALID_ENV, false);
    const fetchDiagnostic = diagnostics.find((d) => d.variable === "globalThis.fetch");
    expect(fetchDiagnostic).toBeDefined();
    expect(fetchDiagnostic?.severity).toBe("error");
    expect(hasBlockingDiagnostics(diagnostics)).toBe(true);
  });

  it("names the runtime requirement in the formatted report", () => {
    const diagnostics = collectStartupDiagnostics(VALID_ENV, false);
    const report = formatDiagnostics(diagnostics);
    expect(report).toContain("globalThis.fetch");
    expect(report).toContain("Node.js >=20");
  });

  it("defaults to checking the real ambient fetch when not overridden", () => {
    // In the Vitest/Node test runtime, global fetch is always present, so the
    // default-parameter path must not report the missing-fetch diagnostic.
    const diagnostics = collectStartupDiagnostics(VALID_ENV);
    expect(diagnostics.some((d) => d.variable === "globalThis.fetch")).toBe(false);
  });
});

describe("collectStartupDiagnostics — x402 / Stellar network mismatch", () => {
  // NETWORK=stellar:pubnet with STELLAR_NETWORK=testnet is a mismatch: the
  // x402 payment network and the Soroban/Horizon target disagree. This should
  // be a non-blocking warning so the server can still start, but the operator
  // is alerted that payments will likely fail.
  it("reports a warning (not an error) when NETWORK does not match STELLAR_NETWORK", () => {
    const env: NodeJS.ProcessEnv = {
      STELLAR_NETWORK: "testnet",
      NETWORK: "stellar:pubnet", // pubnet x402 id against testnet Soroban
    };
    const diagnostics = collectStartupDiagnostics(env, true);
    const networkDiag = diagnostics.find((d) => d.variable === "NETWORK");
    expect(networkDiag).toBeDefined();
    expect(networkDiag?.severity).toBe("warning");
  });

  it("does not block startup when only NETWORK mismatches STELLAR_NETWORK", () => {
    const env: NodeJS.ProcessEnv = {
      STELLAR_NETWORK: "testnet",
      NETWORK: "stellar:pubnet",
    };
    const diagnostics = collectStartupDiagnostics(env, true);
    // The mismatch is a warning, not an error, so startup should not be blocked.
    expect(hasBlockingDiagnostics(diagnostics)).toBe(false);
  });

  it("includes the mismatch detail in the formatted warning report", () => {
    const env: NodeJS.ProcessEnv = {
      STELLAR_NETWORK: "testnet",
      NETWORK: "stellar:pubnet",
    };
    const diagnostics = collectStartupDiagnostics(env, true);
    const report = formatDiagnostics(diagnostics);
    expect(report).toContain("NETWORK");
    expect(report).toContain("warning");
  });

  it("reports no NETWORK diagnostic when x402 and Stellar networks are consistent", () => {
    const env: NodeJS.ProcessEnv = {
      STELLAR_NETWORK: "testnet",
      NETWORK: "stellar:testnet",
    };
    const diagnostics = collectStartupDiagnostics(env, true);
    expect(diagnostics.some((d) => d.variable === "NETWORK")).toBe(false);
  });

  it("keeps SOROBAN_RPC_URL cross-network issue as a blocking error", () => {
    // Pointing the RPC URL at mainnet while STELLAR_NETWORK=testnet is a hard
    // misconfiguration: every Soroban call will fail immediately.
    const env: NodeJS.ProcessEnv = {
      STELLAR_NETWORK: "testnet",
      SOROBAN_RPC_URL: "https://soroban.stellar.org", // mainnet RPC
    };
    const diagnostics = collectStartupDiagnostics(env, true);
    const rpcDiag = diagnostics.find((d) => d.variable === "SOROBAN_RPC_URL");
    expect(rpcDiag).toBeDefined();
    expect(rpcDiag?.severity).toBe("error");
    expect(hasBlockingDiagnostics(diagnostics)).toBe(true);
  });
});

describe("collectStartupDiagnostics — service URL validation", () => {
  it.each(["MINDVAULT_URL", "SPONSORED_ACCOUNT_URL", "HORIZON_URL", "SOROBAN_RPC_URL"] as const)(
    "reports a blocking error for an invalid %s",
    (variable) => {
      const diagnostics = collectStartupDiagnostics(
        { STELLAR_NETWORK: "testnet", [variable]: "not-a-url" },
        true,
      );
      const diagnostic = diagnostics.find((item) => item.variable === variable);
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.severity).toBe("error");
      expect(diagnostic?.message).toContain("Not a valid URL");
    },
  );

  it("accepts valid HTTP(S) overrides for every service URL", () => {
    const diagnostics = collectStartupDiagnostics(
      {
        STELLAR_NETWORK: "testnet",
        MINDVAULT_URL: "https://api.example.com",
        SPONSORED_ACCOUNT_URL: "http://sponsor.example.com",
        HORIZON_URL: "https://horizon-testnet.example.com",
        SOROBAN_RPC_URL: "https://rpc-testnet.example.com",
      },
      true,
    );
    expect(diagnostics.filter((item) => item.variable.endsWith("URL"))).toEqual([]);
  });
});
