/**
 * Unit tests for onchainPreflight (#1054).
 *
 * The builder is pure — no I/O, no network, no process.env — so every case is
 * reproducible with crafted inputs. The tests cover:
 *
 *   - valid explicit testnet env               → ready: true, all pass
 *   - preset-default contract ID               → warn (still ready)
 *   - malformed contract ID                     → fail + remediation
 *   - empty contract ID on mainnet              → fail
 *   - x402/stellar network mismatch             → fail
 *   - unsupported x402 network value            → fail
 *   - unknown STELLAR_NETWORK                   → fail
 *   - requestedSchemaVersion in supported set   → pass
 *   - requestedSchemaVersion outside the set    → fail, lists supported set
 *   - non-integer requestedSchemaVersion        → fail
 *   - mainnet readiness note                    → warn, not fail
 *   - assertOnchainSetupReady throws / passes
 *   - onchainPreflightTool JSON envelope shape (validated with checkOutput)
 *   - the builder never throws on garbage input
 */

import { describe, it, expect } from "vitest";
import {
  ONCHAIN_PREFLIGHT_OUTPUT_SCHEMA,
  ONCHAIN_PREFLIGHT_SCHEMA,
  SUPPORTED_RESOURCE_SCHEMA_VERSIONS,
  assertOnchainSetupReady,
  onchainPreflightTool,
  runOnchainPreflight,
  type OnchainPreflightInput,
} from "./onchainPreflight.js";
import { checkOutput } from "./outputValidation.js";

/** A valid-format StrKey contract ID for tests (C + 55 base32 chars). */
const VALID_CONTRACT_ID = "CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4";

/** Fully aligned, explicit testnet input — the happy path. */
function testnetInput(overrides: Partial<OnchainPreflightInput> = {}): OnchainPreflightInput {
  return {
    contractId: VALID_CONTRACT_ID,
    contractIdSource: "env",
    stellarNetwork: "testnet",
    rawStellarNetwork: "testnet",
    x402Network: "stellar:testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    requestedSchemaVersion: null,
    ...overrides,
  };
}

function checkByName(result: ReturnType<typeof runOnchainPreflight>, name: string) {
  const check = result.checks.find((c) => c.name === name);
  expect(check, `expected a "${name}" check`).toBeDefined();
  return check!;
}

describe("runOnchainPreflight", () => {
  it("is ready with all-pass checks for a valid explicit testnet config", () => {
    const result = runOnchainPreflight(testnetInput());
    expect(result.schema).toBe(ONCHAIN_PREFLIGHT_SCHEMA);
    expect(result.ready).toBe(true);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.contract.status).toBe("ok");
    expect(result.network.stellarNetwork).toBe("testnet");
    expect(result.network.x402Network).toBe("stellar:testnet");
    expect(result.schemaVersions.requested).toBeNull();
    expect(result.schemaVersions.status).toBe("pass");
  });

  it("warns (not fails) when the contract ID comes from the preset default", () => {
    const result = runOnchainPreflight(
      testnetInput({ contractIdSource: "preset", allowMainnetEnv: false }),
    );
    const check = checkByName(result, "contract_id");
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/preset default/);
    expect(check.remediation).toMatch(/VAULT_REGISTRY_CONTRACT_ID/);
    expect(result.contract.note).toMatch(/preset default/);
    expect(result.ready).toBe(true);
  });

  it("fails on a malformed contract ID with a VAULT_REGISTRY_CONTRACT_ID remediation", () => {
    const result = runOnchainPreflight(testnetInput({ contractId: "GBADCONTRACTID" }));
    expect(result.ready).toBe(false);
    const check = checkByName(result, "contract_id");
    expect(check.status).toBe("fail");
    expect(check.remediation).toMatch(/VAULT_REGISTRY_CONTRACT_ID/);
    expect(check.remediation).toMatch(/55 base32/);
    expect(result.contract.status).toBe("malformed");
    expect(result.mismatches.some((m) => m.startsWith("contract_id:"))).toBe(true);
  });

  it("fails when the contract ID is empty on mainnet", () => {
    const result = runOnchainPreflight(
      testnetInput({
        contractId: "",
        contractIdSource: "none",
        stellarNetwork: "mainnet",
        rawStellarNetwork: "mainnet",
        x402Network: "stellar:pubnet",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    );
    expect(result.ready).toBe(false);
    const check = checkByName(result, "contract_id");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/mainnet/);
    expect(check.remediation).toMatch(/VAULT_REGISTRY_CONTRACT_ID/);
    expect(result.contract.status).toBe("missing");
  });

  it("fails when NETWORK does not match STELLAR_NETWORK", () => {
    const result = runOnchainPreflight(testnetInput({ x402Network: "stellar:pubnet" }));
    expect(result.ready).toBe(false);
    const check = checkByName(result, "x402_network");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/does not match STELLAR_NETWORK=testnet/);
    expect(check.remediation).toMatch(/stellar:testnet/);
  });

  it("fails on an unsupported x402 network value", () => {
    const result = runOnchainPreflight(testnetInput({ x402Network: "base-mainnet" }));
    expect(result.ready).toBe(false);
    const check = checkByName(result, "x402_network");
    expect(check.status).toBe("fail");
    expect(check.remediation).toMatch(/stellar:testnet|stellar:pubnet/);
  });

  it("fails on an unrecognized STELLAR_NETWORK", () => {
    const result = runOnchainPreflight(testnetInput({ rawStellarNetwork: "devnet" }));
    expect(result.ready).toBe(false);
    const check = checkByName(result, "stellar_network");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/devnet/);
    expect(check.remediation).toMatch(/testnet.*mainnet|mainnet.*testnet/);
  });

  it("passes the requested schema version when it is in the supported set", () => {
    const result = runOnchainPreflight(
      testnetInput({ requestedSchemaVersion: SUPPORTED_RESOURCE_SCHEMA_VERSIONS[0] }),
    );
    expect(result.ready).toBe(true);
    expect(result.schemaVersions.requested).toBe(SUPPORTED_RESOURCE_SCHEMA_VERSIONS[0]);
    expect(result.schemaVersions.status).toBe("pass");
    const check = checkByName(result, "resource_schema_version");
    expect(check.status).toBe("pass");
  });

  it("fails a requested schema version outside the set and lists the supported set", () => {
    const result = runOnchainPreflight(testnetInput({ requestedSchemaVersion: 99 }));
    expect(result.ready).toBe(false);
    expect(result.schemaVersions.status).toBe("fail");
    const check = checkByName(result, "resource_schema_version");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("99");
    for (const version of SUPPORTED_RESOURCE_SCHEMA_VERSIONS) {
      expect(check.detail).toContain(String(version));
    }
  });

  it("fails when requestedSchemaVersion is not an integer", () => {
    const result = runOnchainPreflight(
      testnetInput({ requestedSchemaVersion: "2" as unknown as number }),
    );
    expect(result.ready).toBe(false);
    expect(checkByName(result, "resource_schema_version").status).toBe("fail");
  });

  it("adds a mainnet readiness note as a warning, never a failure", () => {
    const contractId = "C" + "A".repeat(55);
    const result = runOnchainPreflight(
      testnetInput({
        contractId,
        stellarNetwork: "mainnet",
        rawStellarNetwork: "mainnet",
        x402Network: "stellar:pubnet",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    );
    const check = checkByName(result, "mainnet_readiness");
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/THIS IS MAINNET|Mainnet mutations/i);
    expect(result.ready).toBe(true);
  });

  it("reports supported schema versions when no version is requested", () => {
    const result = runOnchainPreflight(testnetInput());
    expect(result.schemaVersions.supported).toEqual([...SUPPORTED_RESOURCE_SCHEMA_VERSIONS]);
    expect(result.schemaVersions.requested).toBeNull();
  });

  it("summary is a non-empty string naming every check", () => {
    const result = runOnchainPreflight(testnetInput());
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
    for (const check of result.checks) {
      expect(result.summary).toContain(check.name);
    }
  });
});

describe("runOnchainPreflight never throws on garbage input", () => {
  const garbageInputs: OnchainPreflightInput[] = [
    {} as unknown as OnchainPreflightInput,
    {
      contractId: 42 as unknown as string,
      stellarNetwork: null as unknown as string,
      x402Network: undefined as unknown as string,
      networkPassphrase: { nested: true } as unknown as string,
      requestedSchemaVersion: "latest" as unknown as number,
    },
    {
      contractId: "   ",
      contractIdSource: "env",
      stellarNetwork: "???",
      rawStellarNetwork: 12345 as unknown as string,
      x402Network: "",
      networkPassphrase: "",
      requestedSchemaVersion: NaN,
    },
  ];

  it.each(garbageInputs.map((input, index) => [index, input] as const))(
    "never throws on garbage input #%i",
    (_index, input) => {
      expect(() => runOnchainPreflight(input)).not.toThrow();
      const result = runOnchainPreflight(input);
      expect(typeof result.ready).toBe("boolean");
      expect(Array.isArray(result.checks)).toBe(true);
    },
  );
});

describe("assertOnchainSetupReady", () => {
  it("passes on a valid explicit testnet env", () => {
    expect(() =>
      assertOnchainSetupReady({
        STELLAR_NETWORK: "testnet",
        VAULT_REGISTRY_CONTRACT_ID: VALID_CONTRACT_ID,
      }),
    ).not.toThrow();
  });

  it("passes on the default (empty) env — testnet preset default contract", () => {
    expect(() => assertOnchainSetupReady({})).not.toThrow();
  });

  it("throws on a malformed contract ID with an actionable message", () => {
    let thrown: Error | undefined;
    try {
      assertOnchainSetupReady({
        STELLAR_NETWORK: "testnet",
        VAULT_REGISTRY_CONTRACT_ID: "GBADCONTRACTID",
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/contract_id/);
    expect(thrown!.message).toMatch(/VAULT_REGISTRY_CONTRACT_ID/);
    expect(thrown!.message).toMatch(/mindvault_onchain_preflight/);
  });

  it("throws on mainnet without a contract ID", () => {
    expect(() => assertOnchainSetupReady({ STELLAR_NETWORK: "mainnet" })).toThrow(
      /VAULT_REGISTRY_CONTRACT_ID/,
    );
  });

  it("throws on an unrecognized STELLAR_NETWORK", () => {
    expect(() => assertOnchainSetupReady({ STELLAR_NETWORK: "devnet" })).toThrow(/devnet/);
  });

  it("does not throw on an x402/stellar mismatch (not locally fatal)", () => {
    expect(() =>
      assertOnchainSetupReady({
        STELLAR_NETWORK: "testnet",
        NETWORK: "stellar:pubnet",
        VAULT_REGISTRY_CONTRACT_ID: VALID_CONTRACT_ID,
      }),
    ).not.toThrow();
  });
});

describe("onchainPreflightTool", () => {
  it("returns parseable JSON matching the required envelope keys", () => {
    const parsed = JSON.parse(onchainPreflightTool({}));
    expect(parsed.schema).toBe(ONCHAIN_PREFLIGHT_SCHEMA);
    const check = checkOutput(ONCHAIN_PREFLIGHT_OUTPUT_SCHEMA, parsed);
    expect(check.valid).toBe(true);
  });

  it("accepts an integer requestedSchemaVersion and echoes it", () => {
    const version = SUPPORTED_RESOURCE_SCHEMA_VERSIONS[0];
    const parsed = JSON.parse(onchainPreflightTool({ requestedSchemaVersion: version }));
    expect(parsed.schemaVersions.requested).toBe(version);
    expect(parsed.schemaVersions.status).toBe("pass");
  });

  it("is ready under the default (unset) environment", () => {
    const parsed = JSON.parse(onchainPreflightTool({}));
    expect(parsed.ready).toBe(true);
  });

  it("throws a clear validation error for a non-integer requestedSchemaVersion", () => {
    expect(() => onchainPreflightTool({ requestedSchemaVersion: "2" })).toThrow(
      /requestedSchemaVersion must be an integer/,
    );
    expect(() => onchainPreflightTool({ requestedSchemaVersion: 1.5 })).toThrow(
      /requestedSchemaVersion must be an integer/,
    );
  });
});
