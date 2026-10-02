/**
 * Schema parity for advertised MCP structured results (#553).
 */
import { describe, expect, it } from "vitest";
import { dryRunBuy, dryRunPublish } from "./dryRun.js";
import {
  ATTESTATION_VERIFICATION_OUTPUT_SCHEMA,
  CATALOG_LIST_OUTPUT_SCHEMA,
  LIST_PROFILES_OUTPUT_SCHEMA,
  PREVIEW_OUTPUT_SCHEMA,
  PUBLISH_BUY_OUTPUT_SCHEMA,
  PUBLISH_STATUS_OUTPUT_SCHEMA,
  PURCHASE_HISTORY_OUTPUT_SCHEMA,
  RECOVER_CACHE_OUTPUT_SCHEMA,
  REGISTRY_INFO_OUTPUT_SCHEMA,
  REGISTRY_LOOKUP_OUTPUT_SCHEMA,
  TEXT_ONLY_TOOLS,
  TEXT_RESULT_SCHEMA,
  USE_PROFILE_OUTPUT_SCHEMA,
  WALLET_INFO_OUTPUT_SCHEMA,
  WALLET_SETUP_OUTPUT_SCHEMA,
} from "./outputSchemas.js";
import { TOOL_DEFINITIONS } from "./tools.js";

function requiredKeys(schema: { required?: readonly string[] }): readonly string[] {
  return schema.required ?? [];
}

function assertKeys(schema: { required?: readonly string[] }, produced: Record<string, unknown>) {
  for (const key of requiredKeys(schema)) {
    expect(produced, `missing required ${key}`).toHaveProperty(key);
  }
}

describe("text-only tools stay text-only", () => {
  it("do not declare an outputSchema", () => {
    for (const name of TEXT_ONLY_TOOLS) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
      if (!tool) continue;
      expect(tool.outputSchema, `${name} must not advertise outputSchema`).toBeUndefined();
    }
  });
});

describe("structured tools advertise a schema", () => {
  it("every TOOL_DEFINITIONS entry with structured results has outputSchema", () => {
    const structured = TOOL_DEFINITIONS.filter(
      (t) => !(TEXT_ONLY_TOOLS as readonly string[]).includes(t.name),
    );
    expect(structured.length).toBeGreaterThan(10);
    for (const tool of structured) {
      expect(tool.outputSchema, `${tool.name} should advertise outputSchema`).toBeDefined();
    }
  });

  it("publish_status and purchase_history advertise their schemas from TOOL_DEFINITIONS", () => {
    // They used to live in a side table because they were missing from
    // TOOL_DEFINITIONS; both are defined there now, so the schemas travel with
    // the definition like every other tool's (#596).
    const byName = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));
    expect(byName.get("mindvault_publish_status")?.outputSchema).toBe(PUBLISH_STATUS_OUTPUT_SCHEMA);
    expect(byName.get("mindvault_purchase_history")?.outputSchema).toBe(
      PURCHASE_HISTORY_OUTPUT_SCHEMA,
    );
  });
});

describe("representative payloads match advertised required keys", () => {
  it("catalog list", () => {
    assertKeys(CATALOG_LIST_OUTPUT_SCHEMA, {
      items: [{ id: "mock-1", title: "Intro", price: "1.5", description: null, accessUrl: null }],
      notice: null,
      truncated: false,
    });
  });

  it("preview", () => {
    assertKeys(PREVIEW_OUTPUT_SCHEMA, {
      id: "res-001",
      title: "Intro",
      description: "A guide",
      price: "$5.00 USDC",
      type: "link",
      verificationStatus: "verified",
      accessUrl: "https://example.com",
    });
  });

  it("wallet setup / info / profile", () => {
    assertKeys(WALLET_SETUP_OUTPUT_SCHEMA, {
      profile: "testnet",
      address: "GABCDEF",
      persisted: true,
    });
    assertKeys(WALLET_INFO_OUTPUT_SCHEMA, {
      profile: "testnet",
      address: "GABCDEF",
      xlmBalance: "1",
      xlmReserve: "0.5",
      xlmAvailable: "0.5",
      usdcBalance: "10",
      usdcStatus: "funded",
      publisherRegistered: false,
      note: null,
    });
    assertKeys(USE_PROFILE_OUTPUT_SCHEMA, {
      profile: "buyer",
      address: null,
      publisherRegistered: null,
    });
    assertKeys(LIST_PROFILES_OUTPUT_SCHEMA, { active: "testnet", profiles: [] });
  });

  it("dry-run publish/buy match the mutation oneOf", () => {
    const publish = dryRunPublish(
      { title: "T", price: "5.00", externalUrl: "https://example.com" },
      "stellar:testnet",
      "https://example.com",
      true,
      true,
    );
    expect(publish.mode).toBe("dry-run");
    expect(PUBLISH_BUY_OUTPUT_SCHEMA.oneOf.length).toBe(3);

    const buy = dryRunBuy("res-001", "stellar:testnet", "https://example.com", true, "1.5");
    expect(buy.mode).toBe("dry-run");
  });

  it("attestation verification matches its required keys", () => {
    assertKeys(ATTESTATION_VERIFICATION_OUTPUT_SCHEMA, {
      source: "on-chain",
      resourceId: "res-001",
      expectedAttestationHash: "a".repeat(64),
      registeredAttestationHash: "a".repeat(64),
      matches: true,
      verified: true,
      summary: "Attestation hash matches the value registered on-chain.",
      contract: "C…",
    });
  });

  it("registry miss / recover / text fallback", () => {
    assertKeys(REGISTRY_LOOKUP_OUTPUT_SCHEMA, {
      source: "on-chain",
      found: false,
      resourceId: "missing",
      message: "not registered",
      next: "retry",
      contract: "C…",
    });
    assertKeys(REGISTRY_INFO_OUTPUT_SCHEMA, {
      contractId: "C",
      networkPassphrase: "Test SDF",
      rpcUrl: "https://rpc",
      network: "testnet",
      x402Network: "stellar:testnet",
      resourceFields: ["id"],
      mainnetDiagnostics: "",
    });
    assertKeys(RECOVER_CACHE_OUTPUT_SCHEMA, {
      source: "mcp",
      action: "recover_catalog_cache",
      message: "ok",
    });
    assertKeys(TEXT_RESULT_SCHEMA, {
      status: "text",
      message: "Provide a transaction hash to look up.",
    });
  });
});
