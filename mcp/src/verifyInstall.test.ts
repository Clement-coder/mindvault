/**
 * Unit tests for verifyInstall.
 *
 * verifyInstall is pure — no I/O, no network — so every case is reproducible
 * with a crafted env + Node.js version string. The tests cover:
 *
 *   - clean install with all defaults        → ok: true
 *   - Node.js below minimum                  → ok: false
 *   - MCP SDK missing                        → ok: false
 *   - MCP SDK below minimum                  → ok: false
 *   - MCP SDK at or above minimum            → ok: true
 *   - unrecognised STELLAR_NETWORK           → ok: false
 *   - malformed MINDVAULT_URL                → ok: false
 *   - malformed SPONSORED_ACCOUNT_URL        → ok: false
 *   - malformed HORIZON_URL                  → ok: false
 *   - malformed SOROBAN_RPC_URL              → ok: false
 *   - missing contract ID on mainnet         → ok: false
 *   - malformed contract ID                  → ok: false
 *   - plaintext secret in env                → ok: false
 *   - valid custom URL overrides             → ok: true
 *   - valid mainnet config with contract ID  → ok: true
 *   - summary output shape
 */

import { describe, it, expect } from "vitest";
import {
  verifyInstall,
  formatVerifyInstall,
  compareSemver,
  MCP_SDK_MINIMUM,
} from "./verifyInstall.js";

// A minimal clean environment — all optional variables absent.
const CLEAN_ENV: NodeJS.ProcessEnv = {};
const NODE_OK = "v20.11.0";
/** A known-good SDK version that satisfies the minimum. */
const SDK_OK = "1.29.0";

describe("verifyInstall", () => {
  it("returns ok:true for a clean default config", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, SDK_OK);
    expect(result.ok).toBe(true);
    expect(result.nodeVersion).toBe(NODE_OK);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails when Node.js is below v20", () => {
    const result = verifyInstall(CLEAN_ENV, "v18.20.0", SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "node_version")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/below the minimum/);
  });

  // ── MCP SDK version checks ─────────────────────────────────────────────────

  it("fails when the MCP SDK package is not found (null)", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, null);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "mcp_sdk_version")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/@modelcontextprotocol\/sdk/);
    expect(check.detail).toMatch(/not found/i);
  });

  it("fails when the installed SDK version is below the minimum", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, "1.0.0");
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "mcp_sdk_version")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/below the minimum/);
    expect(check.detail).toMatch(MCP_SDK_MINIMUM);
  });

  it("fails when the installed SDK version is a pre-1.x release", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, "0.9.0");
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "mcp_sdk_version")!;
    expect(check.ok).toBe(false);
  });

  it("passes when the installed SDK is exactly the minimum", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, MCP_SDK_MINIMUM);
    const check = result.checks.find((c) => c.name === "mcp_sdk_version")!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain(MCP_SDK_MINIMUM);
  });

  it("passes when the installed SDK is newer than the minimum", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, "2.0.0");
    const check = result.checks.find((c) => c.name === "mcp_sdk_version")!;
    expect(check.ok).toBe(true);
  });

  it("the mcp_sdk_version check appears in the checks list", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, SDK_OK);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("mcp_sdk_version");
  });

  // ── compareSemver ──────────────────────────────────────────────────────────

  describe("compareSemver", () => {
    it("returns 0 for identical versions", () => {
      expect(compareSemver("1.12.1", "1.12.1")).toBe(0);
    });

    it("returns negative when the first version is older (patch)", () => {
      expect(compareSemver("1.12.0", "1.12.1")).toBeLessThan(0);
    });

    it("returns negative when the first version is older (minor)", () => {
      expect(compareSemver("1.11.9", "1.12.0")).toBeLessThan(0);
    });

    it("returns negative when the first version is older (major)", () => {
      expect(compareSemver("0.9.0", "1.0.0")).toBeLessThan(0);
    });

    it("returns positive when the first version is newer", () => {
      expect(compareSemver("2.0.0", "1.29.0")).toBeGreaterThan(0);
    });

    it("handles leading 'v' prefix", () => {
      expect(compareSemver("v1.12.1", "1.12.1")).toBe(0);
    });
  });

  // ── Existing env/config checks ─────────────────────────────────────────────

  it("fails for an unrecognised STELLAR_NETWORK", () => {
    const result = verifyInstall({ STELLAR_NETWORK: "devnet" }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "STELLAR_NETWORK")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/not recognised/);
  });

  it("accepts known network values", () => {
    for (const network of ["testnet", "mainnet", "pubnet", "public"]) {
      const result = verifyInstall({ STELLAR_NETWORK: network }, NODE_OK, SDK_OK);
      const check = result.checks.find((c) => c.name === "STELLAR_NETWORK")!;
      expect(check.ok).toBe(true);
    }
  });

  it("treats absent STELLAR_NETWORK as ok (defaults to testnet)", () => {
    const result = verifyInstall({}, NODE_OK, SDK_OK);
    const check = result.checks.find((c) => c.name === "STELLAR_NETWORK")!;
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/defaults to testnet/);
  });

  it("fails when MINDVAULT_URL is not a valid URL", () => {
    const result = verifyInstall({ MINDVAULT_URL: "not-a-url" }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "MINDVAULT_URL")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/not a valid URL/i);
  });

  it("fails when MINDVAULT_URL uses a non-http scheme", () => {
    const result = verifyInstall({ MINDVAULT_URL: "ftp://example.com" }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "MINDVAULT_URL")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/http\(s\)/);
  });

  it("accepts a valid custom MINDVAULT_URL", () => {
    const result = verifyInstall(
      { MINDVAULT_URL: "https://my-mindvault.example.com" },
      NODE_OK,
      SDK_OK,
    );
    const check = result.checks.find((c) => c.name === "MINDVAULT_URL")!;
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/custom/);
  });

  it("fails when SPONSORED_ACCOUNT_URL is invalid", () => {
    const result = verifyInstall({ SPONSORED_ACCOUNT_URL: "://broken" }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "SPONSORED_ACCOUNT_URL")!;
    expect(check.ok).toBe(false);
  });

  it.each(["HORIZON_URL", "SOROBAN_RPC_URL"] as const)("fails when %s is invalid", (variable) => {
    const result = verifyInstall({ [variable]: "not-a-url" }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === variable)!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/not a valid URL/i);
  });

  it.each(["HORIZON_URL", "SOROBAN_RPC_URL"] as const)(
    "rejects non-http schemes for %s",
    (variable) => {
      const result = verifyInstall({ [variable]: "ftp://example.com" }, NODE_OK, SDK_OK);
      const check = result.checks.find((c) => c.name === variable)!;
      expect(check.ok).toBe(false);
      expect(check.detail).toMatch(/http\(s\)/);
    },
  );

  it("fails when mainnet is set but VAULT_REGISTRY_CONTRACT_ID is absent", () => {
    const result = verifyInstall({ STELLAR_NETWORK: "mainnet" }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "VAULT_REGISTRY_CONTRACT_ID")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/required on mainnet/);
  });

  it("fails when VAULT_REGISTRY_CONTRACT_ID does not match the expected format", () => {
    const result = verifyInstall({ VAULT_REGISTRY_CONTRACT_ID: "GBADCONTRACTID" }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "VAULT_REGISTRY_CONTRACT_ID")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/does not look like/);
  });

  it("accepts a valid contract ID on mainnet", () => {
    // 55 base32 chars after 'C': use all-A padding (valid StrKey format for tests)
    const contractId = "C" + "A".repeat(55);
    const result = verifyInstall(
      { STELLAR_NETWORK: "mainnet", VAULT_REGISTRY_CONTRACT_ID: contractId },
      NODE_OK,
      SDK_OK,
    );
    const check = result.checks.find((c) => c.name === "VAULT_REGISTRY_CONTRACT_ID")!;
    expect(check.ok).toBe(true);
  });

  it("warns when a plaintext secret variable is present in the env", () => {
    const result = verifyInstall({ MY_AGENT_SECRET_KEY: "SABC..." }, NODE_OK, SDK_OK);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "no_plaintext_secrets")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/MY_AGENT_SECRET_KEY/);
    // The value itself must NOT appear in the detail
    expect(check.detail).not.toMatch(/SABC/);
  });

  it("does not warn about secrets when none are present", () => {
    const result = verifyInstall({ MINDVAULT_URL: "https://example.com" }, NODE_OK, SDK_OK);
    const check = result.checks.find((c) => c.name === "no_plaintext_secrets")!;
    expect(check.ok).toBe(true);
  });

  it("summary starts with ✓ on a clean install", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, SDK_OK);
    expect(result.summary).toMatch(/^✓ MindVault MCP install OK\./);
  });

  it("summary starts with ✗ when checks fail", () => {
    const result = verifyInstall(CLEAN_ENV, "v16.0.0", SDK_OK);
    expect(result.summary).toMatch(/^✗ MindVault MCP install has issues\./);
  });

  it("summary includes a fix hint when there are failures", () => {
    const result = verifyInstall(CLEAN_ENV, "v16.0.0", SDK_OK);
    expect(result.summary).toMatch(/check\(s\) failed/);
    expect(result.summary).toMatch(/mcp-client-configs\.md/);
  });

  it("formatVerifyInstall returns the summary string", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, SDK_OK);
    expect(formatVerifyInstall(result)).toBe(result.summary);
  });

  it("result includes nodeVersion", () => {
    const result = verifyInstall(CLEAN_ENV, "v22.1.0", SDK_OK);
    expect(result.nodeVersion).toBe("v22.1.0");
  });

  it("every check has a name, ok flag, and non-empty detail", () => {
    const result = verifyInstall(CLEAN_ENV, NODE_OK, SDK_OK);
    for (const check of result.checks) {
      expect(typeof check.name).toBe("string");
      expect(check.name.length).toBeGreaterThan(0);
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.detail).toBe("string");
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });
});
