import { describe, it, expect } from "vitest";
import { networks, X402_NETWORK_IDS } from "@mindvault/registry-client";

import {
  buildConfig,
  resolveConfig,
  DEFAULT_MINDVAULT_URL,
  DEFAULT_SPONSORED_ACCOUNT_URL,
} from "./config.js";

// An environment that passes every startup check. Individual tests add one
// override at a time so a failure points at a single variable.
const VALID_TESTNET_ENV: NodeJS.ProcessEnv = { STELLAR_NETWORK: "testnet" };

describe("buildConfig — defaults", () => {
  it("resolves an empty environment to the testnet preset with every default filled in", () => {
    const config = buildConfig({});
    expect(config).toMatchObject({
      stellarNetwork: "testnet",
      x402Network: X402_NETWORK_IDS.testnet,
      baseUrl: DEFAULT_MINDVAULT_URL,
      sponsoredAccountUrl: DEFAULT_SPONSORED_ACCOUNT_URL,
      registryContractId: networks.testnet.defaultRegistryContractId,
      registryNetworkPassphrase: networks.testnet.networkPassphrase,
      horizonUrl: networks.testnet.horizonUrl,
      sorobanRpcUrl: networks.testnet.sorobanRpcUrl,
    });
    expect(config.networkPreset).toBe(networks.testnet);
  });

  it("selects the mainnet preset when STELLAR_NETWORK=mainnet", () => {
    const config = buildConfig({ STELLAR_NETWORK: "mainnet" });
    expect(config.stellarNetwork).toBe("mainnet");
    expect(config.networkPreset).toBe(networks.mainnet);
    expect(config.x402Network).toBe(X402_NETWORK_IDS.mainnet);
    expect(config.horizonUrl).toBe(networks.mainnet.horizonUrl);
    // Mainnet ships no default registry contract, so it resolves to "".
    expect(config.registryContractId).toBe("");
  });

  it("accepts STELLAR_NETWORK aliases (pubnet ⇒ mainnet)", () => {
    expect(buildConfig({ STELLAR_NETWORK: "pubnet" }).stellarNetwork).toBe("mainnet");
  });

  it("falls back to testnet for an unrecognized STELLAR_NETWORK", () => {
    expect(buildConfig({ STELLAR_NETWORK: "not-a-network" }).stellarNetwork).toBe("testnet");
  });
});

describe("buildConfig — environment overrides", () => {
  it("prefers explicit env vars over preset values", () => {
    const config = buildConfig({
      STELLAR_NETWORK: "testnet",
      MINDVAULT_URL: "https://api.example.test",
      SPONSORED_ACCOUNT_URL: "https://sponsor.example.test",
      HORIZON_URL: "https://horizon.example.test",
      SOROBAN_RPC_URL: "https://rpc.example.test",
      VAULT_REGISTRY_CONTRACT_ID: "CCUSTOMREGISTRYCONTRACTID000000000000000000000000000000000",
    });
    expect(config).toMatchObject({
      baseUrl: "https://api.example.test",
      sponsoredAccountUrl: "https://sponsor.example.test",
      horizonUrl: "https://horizon.example.test",
      sorobanRpcUrl: "https://rpc.example.test",
      registryContractId: "CCUSTOMREGISTRYCONTRACTID000000000000000000000000000000000",
    });
  });

  it("normalizes the x402 NETWORK id (stellar:mainnet ⇒ stellar:pubnet)", () => {
    expect(buildConfig({ NETWORK: "stellar:mainnet" }).x402Network).toBe(X402_NETWORK_IDS.mainnet);
  });

  it("uses VAULT_REGISTRY_CONTRACT_ID on mainnet where there is no preset default", () => {
    const config = buildConfig({
      STELLAR_NETWORK: "mainnet",
      VAULT_REGISTRY_CONTRACT_ID: "CMAINNETREGISTRY000000000000000000000000000000000000000000",
    });
    expect(config.registryContractId).toBe(
      "CMAINNETREGISTRY000000000000000000000000000000000000000000",
    );
  });
});

describe("buildConfig — purity", () => {
  it("returns a frozen object", () => {
    expect(Object.isFrozen(buildConfig({}))).toBe(true);
  });

  it("is deterministic for a given environment", () => {
    const env = { STELLAR_NETWORK: "testnet", MINDVAULT_URL: "https://x.test" };
    expect(buildConfig(env)).toEqual(buildConfig(env));
  });

  it("never throws, even on a nonsensical environment", () => {
    expect(() =>
      buildConfig({ STELLAR_NETWORK: "???", NETWORK: "", HORIZON_URL: "not a url" }),
    ).not.toThrow();
  });
});

describe("resolveConfig — valid environments", () => {
  it("reports ok with no diagnostics for a clean testnet environment", () => {
    const result = resolveConfig(VALID_TESTNET_ENV, true);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.report).toBeNull();
    expect(result.config.stellarNetwork).toBe("testnet");
  });

  it("stays ok but surfaces a warnings-only report for a non-blocking mismatch", () => {
    // NETWORK=pubnet against STELLAR_NETWORK=testnet is a warning, not an error.
    const result = resolveConfig({ STELLAR_NETWORK: "testnet", NETWORK: "stellar:pubnet" }, true);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => d.severity === "warning")).toBe(true);
    expect(result.report).toContain("warning");
    expect(result.report).toContain("NETWORK");
  });
});

describe("resolveConfig — invalid environments", () => {
  it("reports not-ok with a formatted report when mainnet has no registry contract", () => {
    const result = resolveConfig({ STELLAR_NETWORK: "mainnet" }, true);
    expect(result.ok).toBe(false);
    expect(result.report).toContain("VAULT_REGISTRY_CONTRACT_ID");
    // The typed config is still returned so test/mock callers can use it.
    expect(result.config.stellarNetwork).toBe("mainnet");
  });

  it("reports not-ok for a cross-network SOROBAN_RPC_URL", () => {
    const result = resolveConfig(
      { STELLAR_NETWORK: "testnet", SOROBAN_RPC_URL: "https://soroban.stellar.org" },
      true,
    );
    expect(result.ok).toBe(false);
    const rpcDiag = result.diagnostics.find((d) => d.variable === "SOROBAN_RPC_URL");
    expect(rpcDiag?.severity).toBe("error");
  });

  it("reports not-ok (and names the runtime) when no global fetch is available", () => {
    const result = resolveConfig(VALID_TESTNET_ENV, false);
    expect(result.ok).toBe(false);
    expect(result.report).toContain("globalThis.fetch");
  });

  it("returns a result instead of exiting for a fully broken environment", () => {
    expect(() =>
      resolveConfig({ STELLAR_NETWORK: "mainnet", MINDVAULT_URL: "nope" }, false),
    ).not.toThrow();
  });
});

describe("resolveConfig — determinism", () => {
  it("produces identical results (config, ok, and report text) for the same environment", () => {
    const env = { STELLAR_NETWORK: "mainnet" };
    const a = resolveConfig(env, true);
    const b = resolveConfig(env, true);
    expect(a).toEqual(b);
  });
});
