/**
 * Tests for the registry deployment verification report (#1057).
 *
 * The report builder is pure, so every mismatch case is reproducible from
 * crafted values. The on-chain reader is injectable, so orchestration is
 * tested without RPC access.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { networks } from "@mindvault/registry-client";
import {
  CANONICAL_TESTNET_WASM_HASH,
  DEFAULT_DEPLOYMENT_MANIFESTS,
  DEPLOYMENT_MANIFEST_SCHEMA,
  DEPLOYMENT_VERIFICATION_OUTPUT_SCHEMA,
  DEPLOYMENT_VERIFICATION_SCHEMA,
  buildDeploymentVerificationReport,
  parseDeploymentManifest,
  verifyDeployment,
  type DeploymentManifest,
  type DeploymentSnapshot,
  type DeploymentVerificationConfigured,
} from "./deploymentVerification.js";
import { checkOutput } from "./outputValidation.js";

const CONTRACT_ID = networks.testnet.defaultRegistryContractId!;
const PASSPHRASE = networks.testnet.networkPassphrase;

const MANIFEST: DeploymentManifest = {
  schema: DEPLOYMENT_MANIFEST_SCHEMA,
  network: "testnet",
  contractId: CONTRACT_ID,
  wasmHash: CANONICAL_TESTNET_WASM_HASH,
  crateVersion: "0.0.0",
  resourceSchemaVersion: 7,
};

const CONFIGURED: DeploymentVerificationConfigured = {
  network: "testnet",
  contractId: CONTRACT_ID,
  rpcUrl: networks.testnet.sorobanRpcUrl,
  networkPassphrase: PASSPHRASE,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(overrides: Partial<DeploymentSnapshot> = {}): DeploymentSnapshot {
  return {
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    networkId: sha256(PASSPHRASE),
    registryName: "mindvault-vault-registry",
    crateVersion: MANIFEST.crateVersion,
    resourceSchemaVersion: MANIFEST.resourceSchemaVersion,
    wasmHash: MANIFEST.wasmHash,
    ...overrides,
  };
}

function report(overrides: {
  expected?: DeploymentManifest | null;
  observed?: DeploymentSnapshot | null;
  configured?: DeploymentVerificationConfigured;
  fetchError?: string | null;
  manifestErrors?: { code: string; message: string }[];
}) {
  return buildDeploymentVerificationReport({
    configured: overrides.configured ?? CONFIGURED,
    expected: overrides.expected === undefined ? MANIFEST : overrides.expected,
    observed: overrides.observed === undefined ? snapshot() : overrides.observed,
    fetchError: overrides.fetchError,
    manifestErrors: overrides.manifestErrors,
    mode: "mock",
  });
}

describe("default manifests", () => {
  it("ships a canonical testnet manifest that matches the network preset", () => {
    const manifest = DEFAULT_DEPLOYMENT_MANIFESTS.testnet!;
    expect(manifest.contractId).toBe(CONTRACT_ID);
    expect(manifest.network).toBe("testnet");
    expect(manifest.wasmHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.wasmHash).toBe(CANONICAL_TESTNET_WASM_HASH);
  });

  it("does not invent a mainnet manifest", () => {
    expect(DEFAULT_DEPLOYMENT_MANIFESTS.mainnet).toBeNull();
  });
});

describe("parseDeploymentManifest", () => {
  it("accepts a complete manifest and canonicalizes the WASM hash", () => {
    const parsed = parseDeploymentManifest({
      ...MANIFEST,
      wasmHash: MANIFEST.wasmHash.toUpperCase(),
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.wasmHash).toBe(MANIFEST.wasmHash);
  });

  it("accepts a manifest without the schema field", () => {
    const withoutSchema = {
      network: MANIFEST.network,
      contractId: MANIFEST.contractId,
      wasmHash: MANIFEST.wasmHash,
      crateVersion: MANIFEST.crateVersion,
      resourceSchemaVersion: MANIFEST.resourceSchemaVersion,
    };
    const parsed = parseDeploymentManifest(withoutSchema);
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.schema).toBe(DEPLOYMENT_MANIFEST_SCHEMA);
  });

  it("canonicalizes a network alias", () => {
    const parsed = parseDeploymentManifest({ ...MANIFEST, network: "pubnet" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.network).toBe("mainnet");
  });

  it("rejects a non-object value", () => {
    for (const value of [null, "manifest", [], 7]) {
      const parsed = parseDeploymentManifest(value);
      expect(parsed.manifest).toBeNull();
      expect(parsed.errors[0].code).toBe("manifest_not_object");
    }
  });

  it("collects every field problem in one pass", () => {
    const parsed = parseDeploymentManifest({
      schema: "other/v1",
      network: "devnet",
      contractId: "not-a-contract",
      wasmHash: "abc",
      crateVersion: "",
      resourceSchemaVersion: 1.5,
      extra: true,
    });
    expect(parsed.manifest).toBeNull();
    expect(parsed.errors.map((error) => error.code)).toEqual([
      "manifest_unknown_field",
      "manifest_invalid_schema",
      "manifest_invalid_network",
      "manifest_invalid_contract_id",
      "manifest_invalid_wasm_hash",
      "manifest_invalid_crate_version",
      "manifest_invalid_resource_schema_version",
    ]);
  });
});

describe("buildDeploymentVerificationReport", () => {
  it("reports a match when every configured and on-chain value agrees", () => {
    const result = report({});
    expect(result.schema).toBe(DEPLOYMENT_VERIFICATION_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("match");
    expect(result.readOnly).toBe(true);
    expect(result.signing).toBe("none");
    expect(result.mismatches).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.checks.map((check) => check.field)).toEqual([
      "network",
      "contract_id",
      "rpc_network",
      "network_id",
      "contract_version",
      "resource_schema_version",
      "wasm_hash",
    ]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("identifies a configured network mismatch", () => {
    const result = report({
      configured: { ...CONFIGURED, network: "mainnet" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("mismatch");
    expect(result.mismatches.map((mismatch) => mismatch.field)).toContain("network");
    expect(result.mismatches[0]).toMatchObject({
      field: "network",
      expected: "testnet",
      actual: "mainnet",
    });
  });

  it("identifies a configured contract ID mismatch", () => {
    const otherContract = "C" + "A".repeat(55);
    const result = report({
      configured: { ...CONFIGURED, contractId: otherContract },
    });
    expect(result.status).toBe("mismatch");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({
        field: "contract_id",
        expected: CONTRACT_ID,
        actual: otherContract,
      }),
    );
  });

  it("reports an unset configured contract ID as a mismatch, not a match", () => {
    const result = report({ configured: { ...CONFIGURED, contractId: "" } });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("mismatch");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({
        field: "contract_id",
        expected: CONTRACT_ID,
        actual: "",
      }),
    );
  });

  it("identifies an RPC endpoint on the wrong network", () => {
    const result = report({
      observed: snapshot({ networkPassphrase: networks.mainnet.networkPassphrase }),
    });
    expect(result.status).toBe("mismatch");
    expect(result.mismatches.map((mismatch) => mismatch.field)).toContain("rpc_network");
  });

  it("identifies an on-chain network id mismatch", () => {
    const result = report({ observed: snapshot({ networkId: "00".repeat(32) }) });
    expect(result.status).toBe("mismatch");
    expect(result.mismatches.map((mismatch) => mismatch.field)).toContain("network_id");
  });

  it("identifies a contract version mismatch", () => {
    const result = report({ observed: snapshot({ crateVersion: "1.2.3" }) });
    expect(result.status).toBe("mismatch");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({
        field: "contract_version",
        expected: "0.0.0",
        actual: "1.2.3",
      }),
    );
  });

  it("identifies a resource schema version mismatch", () => {
    const result = report({ observed: snapshot({ resourceSchemaVersion: 6 }) });
    expect(result.status).toBe("mismatch");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({
        field: "resource_schema_version",
        expected: 7,
        actual: 6,
      }),
    );
  });

  it("identifies a WASM hash mismatch", () => {
    const result = report({ observed: snapshot({ wasmHash: "ab".repeat(32) }) });
    expect(result.status).toBe("mismatch");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({
        field: "wasm_hash",
        expected: MANIFEST.wasmHash,
        actual: "ab".repeat(32),
      }),
    );
  });

  it("treats an upper-case observed WASM hash as a match", () => {
    const result = report({ observed: snapshot({ wasmHash: MANIFEST.wasmHash.toUpperCase() }) });
    expect(result.status).toBe("match");
  });

  it("reports unreachable RPC without inventing a match", () => {
    const result = report({ observed: null, fetchError: "connection refused" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.errors).toContainEqual({
      code: "rpc_unreachable",
      message: "connection refused",
    });
    expect(result.checks.filter((check) => check.status === "unavailable")).toHaveLength(5);
  });

  it("reports an unusable manifest instead of verifying nothing", () => {
    const result = report({
      expected: null,
      observed: null,
      manifestErrors: [{ code: "manifest_invalid_network", message: "bad network" }],
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("invalid_manifest");
    expect(result.expected).toBeNull();
    expect(result.observed).toBeNull();
    expect(result.errors).toEqual([{ code: "manifest_invalid_network", message: "bad network" }]);
  });

  it("validates against the advertised success schema", () => {
    for (const result of [
      report({}),
      report({ observed: snapshot({ wasmHash: "ab".repeat(32) }) }),
      report({ observed: null, fetchError: "down" }),
      report({
        expected: null,
        observed: null,
        manifestErrors: [{ code: "manifest_missing", message: "none" }],
      }),
    ]) {
      expect(checkOutput(DEPLOYMENT_VERIFICATION_OUTPUT_SCHEMA, result)).toEqual({ valid: true });
    }
  });
});

describe("verifyDeployment", () => {
  it("uses the default testnet manifest and returns the fetched snapshot", async () => {
    const fetchSnapshot = vi.fn(async () => snapshot());
    const result = await verifyDeployment({ configured: CONFIGURED, fetchSnapshot });

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot).toHaveBeenCalledWith({
      contractId: CONTRACT_ID,
      rpcUrl: CONFIGURED.rpcUrl,
      networkPassphrase: PASSPHRASE,
    });
    expect(result.ok).toBe(true);
    expect(result.expected).toEqual(MANIFEST);
    expect(result.mode).toBe("live");
  });

  it("accepts an explicit manifest for a custom deployment", async () => {
    const custom: DeploymentManifest = {
      ...MANIFEST,
      crateVersion: "9.9.9",
      resourceSchemaVersion: 8,
    };
    const fetchSnapshot = vi.fn(async () =>
      snapshot({ crateVersion: "9.9.9", resourceSchemaVersion: 8 }),
    );

    const result = await verifyDeployment({
      configured: { ...CONFIGURED, contractId: CONTRACT_ID },
      manifest: custom,
      fetchSnapshot,
    });

    expect(result.expected).toEqual(custom);
    expect(result.ok).toBe(true);
  });

  it("reports a missing mainnet manifest without contacting RPC", async () => {
    const fetchSnapshot = vi.fn(async () => snapshot());
    const result = await verifyDeployment({
      configured: {
        ...CONFIGURED,
        network: "mainnet",
        networkPassphrase: networks.mainnet.networkPassphrase,
      },
      fetchSnapshot,
    });

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(result.status).toBe("invalid_manifest");
    expect(result.errors[0].code).toBe("manifest_missing");
  });

  it("turns a thrown RPC failure into an unreachable report", async () => {
    const fetchSnapshot = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await verifyDeployment({ configured: CONFIGURED, fetchSnapshot });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.errors).toContainEqual({
      code: "rpc_unreachable",
      message: "connection refused",
    });
  });

  it("does not contact RPC in mock mode", async () => {
    const fetchSnapshot = vi.fn(async () => snapshot());
    const result = await verifyDeployment({
      configured: CONFIGURED,
      mode: "mock",
      fetchSnapshot,
    });

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(result.mode).toBe("mock");
    expect(result.ok).toBe(true);
    expect(result.signing).toBe("none");
  });
});
