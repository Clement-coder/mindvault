/**
 * Tests for the MCP tool argument validation layer.
 *
 * Coverage has three parts:
 *   1. structural — the spec table and the advertised tool metadata agree
 *   2. per-tool   — every public tool rejects its own bad input
 *   3. semantics  — each argument kind (string/enum/flag/hash) and every issue
 *                   code behaves deterministically
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./tools.js";
import {
  BATCH_LOOKUP_MAX_IDS,
  TOOL_ARGUMENT_SPECS,
  TOOLS_WITHOUT_ARG_VALIDATION,
  ToolValidationError,
  UnknownToolError,
  flag,
  knownToolNames,
  optionalString,
  requiredString,
  requiredStringArray,
  requiredTagArray,
  validateToolArgs,
} from "./validation.js";

const VALID_SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/**
 * A real valid Stellar public key for use in test fixtures.
 * Verified with StrKey.isValidEd25519PublicKey — passes checksum.
 */
const VALID_PUBLIC_KEY = "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH";

/**
 * A real valid Stellar secret key for use in test fixtures.
 * Derived from a deterministic seed (Buffer.alloc(32, 0x01)) — passes StrKey checksum.
 * IMPORTANT: Never use this key for real funds. It is a test fixture only.
 */
const VALID_SECRET_KEY = "SAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC5MY";

/**
 * A Stellar public key that passes the character-set regex (/^G[A-Z2-7]{55}$/)
 * but fails the CRC-16 checksum. Used to verify the StrKey validation gap is closed.
 */
const BAD_CHECKSUM_PUBLIC_KEY = "G" + "A".repeat(55);

/**
 * A Stellar secret key that passes the character-set regex (/^S[A-Z2-7]{55}$/)
 * but fails the CRC-16 checksum. Used to verify the StrKey validation gap is closed.
 */
const BAD_CHECKSUM_SECRET_KEY = "S" + "A".repeat(55);

/** One id longer than BATCH_LOOKUP_MAX_IDS allows, for the batch tool's ceiling test. */
const OVERSIZE_BATCH = Array.from({ length: 26 }, (_, i) => `res-${String(i).padStart(3, "0")}`);

/**
 * Advertised tools that go through this layer.
 *
 * `mindvault_publish_status` and `mindvault_purchase_history` normalize their
 * own arguments (see TOOLS_WITHOUT_ARG_VALIDATION) and so have no spec to
 * compare against. The exemption itself is checked below.
 */
function specValidatedTools() {
  const exempt = new Set(TOOLS_WITHOUT_ARG_VALIDATION);
  return TOOL_DEFINITIONS.filter((tool) => !exempt.has(tool.name));
}

/** Minimum arguments that must pass for each tool. */
const VALID_CALLS: Record<string, Record<string, unknown>> = {
  mindvault_setup_wallet: {},
  mindvault_repair_sponsored_account: {
    secretKey: VALID_SECRET_KEY,
  },
  mindvault_wallet_info: {},
  mindvault_wallet_allowance: {},
  mindvault_use_profile: { name: "publisher" },
  mindvault_switch_network_profile: { name: "mainnet", network: "mainnet" },
  mindvault_list_profiles: {},
  mindvault_browse: {},
  mindvault_search: { query: "stellar" },
  mindvault_preview: { resourceId: "res-001" },
  mindvault_register: { name: "Agent A", email: "agent@example.com" },
  mindvault_publish: {
    title: "Dataset",
    price: "5.00",
    externalUrl: "https://example.com/data.json",
  },
  mindvault_buy: { resourceId: "res-001" },
  mindvault_buy_lease: { resourceId: "res-001", tier: "day" },
  mindvault_lease_status: {
    resourceId: "res-001",
    holder: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
  },
  mindvault_import_profiles: { data: "{}" },
  mindvault_export_profiles: {},
  mindvault_export_receipts: {},
  mindvault_register_onchain: { resourceId: "res-001" },
  mindvault_agent_status: {},
  mindvault_registry_info: {},
  mindvault_terms: {
    operation: "get",
    creator: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
  },
  mindvault_network_profile: {},
  mindvault_check_bindings: {},
  mindvault_check_consistency: { resourceId: "res-001" },
  mindvault_metadata_diff: { resourceId: "res-001" },
  mindvault_verify_attestation: {
    resourceId: "res001",
    attestationHash: "a".repeat(64),
  },
  mindvault_registry_lookup: { resourceId: "res-001" },
  mindvault_registry_list: {},
  mindvault_registry_count: {},
  mindvault_registry_count: {},
  mindvault_registry_creator_page: {
    creator: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
  },
  mindvault_registry_tag_search: { prefix: "dat" },
  mindvault_tx_status: { txHash: VALID_SHA256 },
  mindvault_reset: {},
  mindvault_backup_state: { passphrase: "correct-horse" },
  mindvault_compare_state_backup: { blob: "v1:abc", passphrase: "correct-horse" },
  mindvault_resource_provenance: { resourceId: "res-001" },
  mindvault_resource_change_log: { resourceId: "res-001" },
  mindvault_restore_state: { blob: "v1:abc", passphrase: "correct-horse" },
  mindvault_metrics: {},
  mindvault_update_metadata: { resourceId: "res-001", metadata: "ipfs://Qm123" },
  mindvault_set_price: { resourceId: "res-001", price: "10.00" },
  mindvault_transfer_ownership: {
    resourceId: "res-001",
    newCreator: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
  },
  mindvault_accept_transfer: { resourceId: "res-001" },
  mindvault_cancel_transfer: { resourceId: "res-001" },
  mindvault_pending_transfer: { resourceId: "res-001" },
  mindvault_set_listed: { resourceId: "res-001", listed: true },
  mindvault_set_tags: { resourceId: "res-001", tags: ["dataset"] },
  mindvault_freeze: { resourceId: "res-001", confirm: "freeze_metadata" },
  mindvault_fee_config: {},
  mindvault_royalty: {
    resourceId: "res-001",
    royaltyRecipient: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
  },
  mindvault_check_state_permissions: {},
  mindvault_registry_health: {},
  mindvault_prewarm_catalog: {},
  mindvault_client_config: {},
  mindvault_mainnet_banner: {},
  mindvault_import_wallet: {},
  mindvault_rotate_publisher_key: {},
  mindvault_verify_install: {},
  mindvault_debug_bundle: { auditLogLines: 50, includeEnvironment: true },
  mindvault_onchain_preflight: { requestedSchemaVersion: 7 },
  mindvault_verify_deployment: {},
  mindvault_migration_preview: {},
  mindvault_support_bundle: { incidentId: "mv-01hq7x9k2m4p6r8t0v2w4y6a8c", auditLines: 100 },
  mindvault_recover_catalog_cache: {},
  mindvault_wallet_balances: {},
  mindvault_server_endpoints: {},
};

function expectInvalid(tool: string, args: unknown): ToolValidationError {
  try {
    validateToolArgs(tool, args);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolValidationError);
    return err as ToolValidationError;
  }
  throw new Error(`expected ${tool} to reject ${JSON.stringify(args)}`);
}

// ── 1. Structural: specs and advertised metadata cannot drift ────────────────

describe("spec coverage", () => {
  it("every advertised tool has a validation spec", () => {
    for (const tool of specValidatedTools()) {
      expect(TOOL_ARGUMENT_SPECS, `${tool.name} has no validation spec`).toHaveProperty(tool.name);
    }
  });

  it("the self-validating exemption names exactly the tools without a spec", () => {
    // Keeps TOOLS_WITHOUT_ARG_VALIDATION honest in both directions: a tool that
    // gains a spec must leave the list, and a tool that loses one must not
    // silently join it.
    const withoutSpec = TOOL_DEFINITIONS.filter((tool) => !(tool.name in TOOL_ARGUMENT_SPECS)).map(
      (tool) => tool.name,
    );
    expect(withoutSpec.sort()).toEqual([...TOOLS_WITHOUT_ARG_VALIDATION].sort());
  });

  it("every validation spec belongs to an advertised tool", () => {
    const advertised = new Set(knownToolNames());
    for (const name of Object.keys(TOOL_ARGUMENT_SPECS)) {
      expect(advertised, `${name} is validated but not advertised`).toContain(name);
    }
  });

  it("spec arguments match the advertised inputSchema properties", () => {
    for (const tool of specValidatedTools()) {
      const spec = TOOL_ARGUMENT_SPECS[tool.name];
      expect(Object.keys(spec).sort(), `${tool.name} argument names`).toEqual(
        Object.keys(tool.inputSchema.properties).sort(),
      );
    }
  });

  it("required arguments match the advertised required list", () => {
    for (const tool of specValidatedTools()) {
      const spec = TOOL_ARGUMENT_SPECS[tool.name];
      const specRequired = Object.entries(spec)
        .filter(([, argSpec]) => argSpec.required)
        .map(([field]) => field)
        .sort();
      expect(specRequired, `${tool.name} required arguments`).toEqual(
        [...tool.inputSchema.required].sort(),
      );
    }
  });

  it("the fixture table covers every tool", () => {
    expect(Object.keys(VALID_CALLS).sort()).toEqual(Object.keys(TOOL_ARGUMENT_SPECS).sort());
  });
});

// ── 2. Per-tool: valid calls pass, bad calls fail deterministically ──────────

describe.each(Object.keys(TOOL_ARGUMENT_SPECS))("%s", (tool) => {
  const spec = TOOL_ARGUMENT_SPECS[tool];
  const requiredFields = Object.entries(spec)
    .filter(([, argSpec]) => argSpec.required)
    .map(([field]) => field);

  it("accepts its minimal valid arguments", () => {
    expect(() => validateToolArgs(tool, VALID_CALLS[tool])).not.toThrow();
  });

  it("accepts omitted arguments (undefined bag)", () => {
    if (requiredFields.length > 0) {
      const err = expectInvalid(tool, undefined);
      expect(err.issues.every((i) => i.code === "missing_required")).toBe(true);
    } else {
      expect(() => validateToolArgs(tool, undefined)).not.toThrow();
    }
  });

  it("rejects unknown arguments", () => {
    const err = expectInvalid(tool, { ...VALID_CALLS[tool], nope: "x" });
    expect(err.issues.some((i) => i.code === "unknown_argument" && i.field === "nope")).toBe(true);
    expect(err.message).toContain("not a recognized argument");
  });

  it("rejects a non-object argument bag", () => {
    const err = expectInvalid(tool, ["not", "an", "object"]);
    expect(err.issues[0].code).toBe("not_an_object");
    expect(err.message).toContain("must be a JSON object");
  });

  if (requiredFields.length > 0) {
    it.each(requiredFields)("reports %s as missing when omitted", (field) => {
      const args = { ...VALID_CALLS[tool] };
      delete args[field];
      const err = expectInvalid(tool, args);
      expect(err.issues.some((i) => i.field === field && i.code === "missing_required")).toBe(true);
    });

    it.each(requiredFields)("rejects a non-string %s", (field) => {
      const err = expectInvalid(tool, { ...VALID_CALLS[tool], [field]: 42 });
      expect(err.issues.some((i) => i.field === field)).toBe(true);
      // The rejected value is never echoed back into the message.
      expect(err.message).not.toContain("42");
    });
  }

  it("produces the same message for the same bad call", () => {
    const bad = { ...VALID_CALLS[tool], nope: "x" };
    expect(expectInvalid(tool, bad).message).toBe(expectInvalid(tool, bad).message);
  });
});

// ── 3. Semantics per argument kind ───────────────────────────────────────────

describe("unknown tools", () => {
  it("throws UnknownToolError naming the available tools", () => {
    try {
      validateToolArgs("mindvault_not_a_tool", {});
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownToolError);
      expect((err as Error).message).toContain("Unknown tool: mindvault_not_a_tool");
      expect((err as Error).message).toContain("mindvault_browse");
    }
  });
});

describe("string arguments", () => {
  it("trims surrounding whitespace", () => {
    const args = validateToolArgs("mindvault_search", { query: "  stellar  " });
    expect(requiredString(args, "query")).toBe("stellar");
  });

  it("rejects an empty or whitespace-only required string", () => {
    expect(expectInvalid("mindvault_search", { query: "" }).issues[0].code).toBe("empty_string");
    expect(expectInvalid("mindvault_search", { query: "   " }).issues[0].code).toBe("empty_string");
  });

  it("enforces maxLength", () => {
    const err = expectInvalid("mindvault_search", { query: "x".repeat(257) });
    expect(err.issues[0].code).toBe("too_long");
    expect(err.message).toContain("at most 256 characters");
  });

  it("enforces minLength for passphrases", () => {
    const err = expectInvalid("mindvault_backup_state", { passphrase: "short" });
    expect(err.issues[0].code).toBe("too_short");
    expect(err.message).toContain("at least 8 characters");
    // The rejected passphrase must not appear in agent-facing output.
    expect(err.message).not.toContain("short");
  });

  it("rejects a resourceId that could alter the request path", () => {
    for (const bad of ["../secrets", "res 001", "res/001", "res?x=1"]) {
      expect(expectInvalid("mindvault_preview", { resourceId: bad }).issues[0].code).toBe(
        "pattern_mismatch",
      );
    }
  });

  it("enforces the on-chain resource id and attestation hash limits", () => {
    const invalidId = expectInvalid("mindvault_verify_attestation", {
      resourceId: "res-001",
      attestationHash: "a".repeat(64),
    });
    expect(invalidId.issues[0].code).toBe("pattern_mismatch");

    const oversizedHash = expectInvalid("mindvault_verify_attestation", {
      resourceId: "res001",
      attestationHash: "a".repeat(65),
    });
    expect(oversizedHash.issues[0].code).toBe("too_long");
  });

  it("rejects a malformed email and accepts a valid one", () => {
    const err = expectInvalid("mindvault_register", { name: "A", email: "not-an-email" });
    expect(err.issues[0].field).toBe("email");
    expect(err.issues[0].code).toBe("pattern_mismatch");
    expect(() =>
      validateToolArgs("mindvault_register", { name: "A", email: "a@b.co" }),
    ).not.toThrow();
  });

  it("rejects a non-Stellar wallet address", () => {
    const err = expectInvalid("mindvault_register", {
      name: "A",
      email: "a@b.co",
      walletAddress: "not-a-key",
    });
    expect(err.issues[0].field).toBe("walletAddress");
  });

  it("rejects a non-http externalUrl", () => {
    const err = expectInvalid("mindvault_publish", {
      title: "T",
      price: "1.00",
      externalUrl: "ftp://example.com/x",
    });
    expect(err.issues[0].field).toBe("externalUrl");
    expect(err.message).toContain("http(s) URL");
  });

  it("rejects a non-decimal price", () => {
    for (const price of ["free", "-1", "1.2.3", "1,50"]) {
      const err = expectInvalid("mindvault_publish", {
        title: "T",
        price,
        externalUrl: "https://example.com/x",
      });
      expect(err.issues[0].field).toBe("price");
    }
  });

  it("rejects an invalid profile name", () => {
    expect(expectInvalid("mindvault_use_profile", { name: "has space" }).issues[0].code).toBe(
      "pattern_mismatch",
    );
    expect(expectInvalid("mindvault_use_profile", { name: "x".repeat(65) }).issues[0].code).toBe(
      "too_long",
    );
  });
});

describe("outbound URL safety (#1078)", () => {
  const publish = (externalUrl: string) =>
    validateToolArgs("mindvault_publish", { title: "T", price: "1.00", externalUrl });

  it("accepts a public http(s) externalUrl", () => {
    expect(publish("https://example.com/data.json")).toMatchObject({
      externalUrl: "https://example.com/data.json",
    });
  });

  it.each([
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    "http://[::1]/x",
    "http://[fe80::1]/x",
  ])("rejects the private/loopback externalUrl %s", (externalUrl) => {
    const err = expectInvalid("mindvault_publish", { title: "T", price: "1.00", externalUrl });
    expect(err.issues[0].field).toBe("externalUrl");
    expect(err.issues[0].code).toBe("blocked_url");
  });

  it.each(["http://localhost:4021/x", "http://api.internal/x", "http://svc.local/x"])(
    "rejects the local-name externalUrl %s",
    (externalUrl) => {
      const err = expectInvalid("mindvault_publish", { title: "T", price: "1.00", externalUrl });
      expect(err.issues[0].code).toBe("blocked_url");
    },
  );

  it("rejects an http(s) metadata pointer to a private host", () => {
    const err = expectInvalid("mindvault_update_metadata", {
      resourceId: "res-001",
      metadata: "http://169.254.169.254/meta.json",
    });
    expect(err.issues[0].field).toBe("metadata");
    expect(err.issues[0].code).toBe("blocked_url");
  });

  it("accepts a non-URL metadata pointer without host checks", () => {
    expect(() =>
      validateToolArgs("mindvault_update_metadata", {
        resourceId: "res-001",
        metadata: "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
      }),
    ).not.toThrow();
    expect(() =>
      validateToolArgs("mindvault_update_metadata", {
        resourceId: "res-001",
        metadata: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      }),
    ).not.toThrow();
  });

  it("accepts a public http(s) metadata pointer", () => {
    expect(() =>
      validateToolArgs("mindvault_update_metadata", {
        resourceId: "res-001",
        metadata: "https://example.com/meta.json",
      }),
    ).not.toThrow();
  });

  it("honours MINDVAULT_URL_ALLOWLIST for a private host", () => {
    const previous = process.env.MINDVAULT_URL_ALLOWLIST;
    process.env.MINDVAULT_URL_ALLOWLIST = "10.0.0.5";
    try {
      expect(() =>
        validateToolArgs("mindvault_publish", {
          title: "T",
          price: "1.00",
          externalUrl: "http://10.0.0.5/x",
        }),
      ).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.MINDVAULT_URL_ALLOWLIST;
      else process.env.MINDVAULT_URL_ALLOWLIST = previous;
    }
  });
});

describe("enum arguments", () => {
  it("accepts every advertised literal", () => {
    for (const status of ["pending", "verified", "rejected", "skipped"]) {
      expect(() =>
        validateToolArgs("mindvault_search", { query: "x", verificationStatus: status }),
      ).not.toThrow();
    }
    for (const type of ["file", "link"]) {
      expect(() =>
        validateToolArgs("mindvault_search", { query: "x", resourceType: type }),
      ).not.toThrow();
    }
  });

  it("rejects a value outside the set and lists the alternatives", () => {
    const err = expectInvalid("mindvault_search", { query: "x", verificationStatus: "approved" });
    expect(err.issues[0].code).toBe("not_in_enum");
    expect(err.message).toContain("pending, verified, rejected, skipped");
  });
});

describe("flag arguments", () => {
  it("accepts booleans", () => {
    expect(flag(validateToolArgs("mindvault_reset", { all: true }), "all")).toBe(true);
    expect(flag(validateToolArgs("mindvault_reset", { all: false }), "all")).toBe(false);
  });

  it("accepts the common string and numeric spellings", () => {
    for (const value of ["true", "TRUE", " yes ", "1", "on", 1]) {
      expect(flag(validateToolArgs("mindvault_metrics", { reset: value }), "reset")).toBe(true);
    }
    for (const value of ["false", "no", "0", "off", 0]) {
      expect(flag(validateToolArgs("mindvault_metrics", { reset: value }), "reset")).toBe(false);
    }
  });

  it("defaults to false when omitted", () => {
    expect(flag(validateToolArgs("mindvault_metrics", {}), "reset")).toBe(false);
  });

  it("rejects ambiguous values", () => {
    const err = expectInvalid("mindvault_metrics", { reset: "maybe" });
    expect(err.issues[0].code).toBe("wrong_type");
    expect(err.message).toContain("boolean");
  });
});

describe("hash arguments", () => {
  it("normalizes txHash to bare lowercase hex", () => {
    const args = validateToolArgs("mindvault_tx_status", { txHash: VALID_SHA256.toUpperCase() });
    expect(requiredString(args, "txHash")).toBe(VALID_SHA256);
  });

  it("accepts a sha256:-prefixed txHash", () => {
    const args = validateToolArgs("mindvault_tx_status", { txHash: `sha256:${VALID_SHA256}` });
    expect(requiredString(args, "txHash")).toBe(VALID_SHA256);
  });

  it("normalizes expectedMetadataHash to canonical algorithm:hex form", () => {
    const args = validateToolArgs("mindvault_check_consistency", {
      resourceId: "res-001",
      expectedMetadataHash: VALID_SHA256,
    });
    expect(optionalString(args, "expectedMetadataHash")).toBe(`sha256:${VALID_SHA256}`);
  });

  it("rejects a digest of the wrong length", () => {
    const err = expectInvalid("mindvault_tx_status", { txHash: VALID_SHA256.slice(0, 63) });
    expect(err.issues[0].code).toBe("invalid_hash");
    expect(err.message).toContain("63 hex characters");
  });

  it("rejects non-hexadecimal characters", () => {
    const err = expectInvalid("mindvault_tx_status", { txHash: "z".repeat(64) });
    expect(err.issues[0].code).toBe("invalid_hash");
    expect(err.message).toContain("hexadecimal");
  });
});

// ── StrKey validation: stellar_address and stellar_secret kinds ──────────────

describe("stellar_address arguments", () => {
  it("accepts a valid Stellar public key", () => {
    expect(() =>
      validateToolArgs("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: VALID_PUBLIC_KEY,
      }),
    ).not.toThrow();
  });

  it("accepts a valid address in mindvault_terms, mindvault_royalty, mindvault_lease_status", () => {
    expect(() =>
      validateToolArgs("mindvault_terms", { operation: "get", creator: VALID_PUBLIC_KEY }),
    ).not.toThrow();
    expect(() =>
      validateToolArgs("mindvault_royalty", {
        resourceId: "res-001",
        royaltyRecipient: VALID_PUBLIC_KEY,
      }),
    ).not.toThrow();
    expect(() =>
      validateToolArgs("mindvault_lease_status", {
        resourceId: "res-001",
        holder: VALID_PUBLIC_KEY,
      }),
    ).not.toThrow();
    expect(() =>
      validateToolArgs("mindvault_register", {
        name: "Agent A",
        email: "a@b.co",
        walletAddress: VALID_PUBLIC_KEY,
      }),
    ).not.toThrow();
  });

  it("rejects a key that passes the character-set regex but fails the StrKey checksum", () => {
    // BAD_CHECKSUM_PUBLIC_KEY matches /^G[A-Z2-7]{55}$/ but isValidEd25519PublicKey returns false.
    // This is the core of the bug being fixed: the old regex-only check would have accepted it.
    const err = expectInvalid("mindvault_transfer_ownership", {
      resourceId: "res-001",
      newCreator: BAD_CHECKSUM_PUBLIC_KEY,
    });
    expect(err.issues[0].field).toBe("newCreator");
    expect(err.issues[0].code).toBe("invalid_stellar_address");
    expect(err.message).toContain("not a valid Stellar public key");
    // Rejected value must never appear in the error message.
    expect(err.message).not.toContain(BAD_CHECKSUM_PUBLIC_KEY);
  });

  it("rejects a non-string value", () => {
    const err = expectInvalid("mindvault_transfer_ownership", {
      resourceId: "res-001",
      newCreator: 42,
    });
    expect(err.issues[0].field).toBe("newCreator");
    expect(err.issues[0].code).toBe("wrong_type");
    expect(err.message).not.toContain("42");
  });

  it("rejects an empty string", () => {
    const err = expectInvalid("mindvault_transfer_ownership", {
      resourceId: "res-001",
      newCreator: "",
    });
    expect(err.issues[0].field).toBe("newCreator");
    expect(err.issues[0].code).toBe("empty_string");
  });

  it("rejects a plain string that is not a G-prefixed key", () => {
    const err = expectInvalid("mindvault_transfer_ownership", {
      resourceId: "res-001",
      newCreator: "not-a-key",
    });
    expect(err.issues[0].code).toBe("invalid_stellar_address");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(() =>
      validateToolArgs("mindvault_transfer_ownership", {
        resourceId: "res-001",
        newCreator: `  ${VALID_PUBLIC_KEY}  `,
      }),
    ).not.toThrow();
  });
});

describe("stellar_secret arguments", () => {
  it("accepts a valid Stellar secret key", () => {
    expect(() =>
      validateToolArgs("mindvault_repair_sponsored_account", { secretKey: VALID_SECRET_KEY }),
    ).not.toThrow();
    expect(() =>
      validateToolArgs("mindvault_import_wallet", { secretKey: VALID_SECRET_KEY }),
    ).not.toThrow();
  });

  it("rejects a key that passes the character-set regex but fails the StrKey checksum", () => {
    // BAD_CHECKSUM_SECRET_KEY matches /^S[A-Z2-7]{55}$/ but isValidEd25519SecretSeed returns false.
    const err = expectInvalid("mindvault_repair_sponsored_account", {
      secretKey: BAD_CHECKSUM_SECRET_KEY,
    });
    expect(err.issues[0].field).toBe("secretKey");
    expect(err.issues[0].code).toBe("invalid_stellar_secret");
    expect(err.message).toContain("not a valid Stellar secret key");
    // Secret value must never appear in the error message.
    expect(err.message).not.toContain(BAD_CHECKSUM_SECRET_KEY);
  });

  it("rejects a non-string value without leaking it", () => {
    const err = expectInvalid("mindvault_repair_sponsored_account", { secretKey: 123 });
    expect(err.issues[0].field).toBe("secretKey");
    expect(err.issues[0].code).toBe("wrong_type");
    expect(err.message).not.toContain("123");
  });

  it("rejects an empty string", () => {
    const err = expectInvalid("mindvault_repair_sponsored_account", { secretKey: "" });
    expect(err.issues[0].code).toBe("empty_string");
  });

  it("rejects a plain G-prefixed key submitted where a secret is expected", () => {
    const err = expectInvalid("mindvault_repair_sponsored_account", {
      secretKey: VALID_PUBLIC_KEY,
    });
    expect(err.issues[0].code).toBe("invalid_stellar_secret");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(() =>
      validateToolArgs("mindvault_repair_sponsored_account", {
        secretKey: `  ${VALID_SECRET_KEY}  `,
      }),
    ).not.toThrow();
  });
});

describe("string_array arguments", () => {
  it("accepts an array and keeps case and duplicates (#608)", () => {
    const args = validateToolArgs("mindvault_batch_catalog_lookup", {
      resourceIds: ["Res-001", "res-001"],
    });
    expect(requiredStringArray(args, "resourceIds")).toEqual(["Res-001", "res-001"]);
  });

  it("trims entries and drops empties", () => {
    const args = validateToolArgs("mindvault_batch_catalog_lookup", {
      resourceIds: [" res-001 ", "", "   ", "res-002"],
    });
    expect(requiredStringArray(args, "resourceIds")).toEqual(["res-001", "res-002"]);
  });

  it("accepts a comma-separated string", () => {
    const args = validateToolArgs("mindvault_batch_catalog_lookup", {
      resourceIds: "res-001, res-002,res-003",
    });
    expect(requiredStringArray(args, "resourceIds")).toEqual(["res-001", "res-002", "res-003"]);
  });

  it("rejects a non-string entry with a deterministic message", () => {
    const err = expectInvalid("mindvault_batch_catalog_lookup", {
      resourceIds: ["res-001", 42],
    });
    expect(err.issues[0].code).toBe("invalid_string_array");
    expect(err.message).toContain("array of strings");
    // Rejected values are never echoed back.
    expect(err.message).not.toContain("42");
  });

  it("reports the position of a malformed entry", () => {
    const err = expectInvalid("mindvault_batch_catalog_lookup", {
      resourceIds: ["res-001", "not ok!"],
    });
    expect(err.issues[0].code).toBe("invalid_string_array");
    expect(err.issues[0].message).toContain("resourceIds[2]");
  });

  it("rejects an empty selection after normalization", () => {
    const err = expectInvalid("mindvault_batch_catalog_lookup", { resourceIds: [] });
    expect(err.issues[0].code).toBe("invalid_string_array");
    expect(err.message).toContain("at least 1");
  });

  it("rejects a batch above the advertised ceiling", () => {
    const err = expectInvalid("mindvault_batch_catalog_lookup", { resourceIds: OVERSIZE_BATCH });
    expect(err.issues[0].code).toBe("invalid_string_array");
    expect(err.message).toContain(`at most ${BATCH_LOOKUP_MAX_IDS}`);
  });

  it("rejects a non-array bag for the batch field", () => {
    const err = expectInvalid("mindvault_batch_catalog_lookup", { resourceIds: 7 });
    expect(err.issues[0].code).toBe("invalid_string_array");
    expect(err.message).toContain("array of strings or a comma-separated string");
  });
});

describe("multi-issue reporting", () => {
  it("reports every problem in one deterministic error", () => {
    const err = expectInvalid("mindvault_publish", {
      title: "",
      price: "free",
      externalUrl: "nope",
      typo: 1,
    });
    const fields = err.issues.map((i) => i.field);
    expect(fields).toEqual(["typo", "title", "price", "externalUrl"]);
    expect(err.tool).toBe("mindvault_publish");
    expect(err.message.startsWith("Invalid arguments for mindvault_publish:")).toBe(true);
  });
});

describe("normalized output", () => {
  it("returns only validated fields", () => {
    const args = validateToolArgs("mindvault_publish", {
      title: " Dataset ",
      price: "5.00",
      externalUrl: "https://example.com/data.json",
    });
    expect(args).toEqual({
      title: "Dataset",
      price: "5.00",
      externalUrl: "https://example.com/data.json",
    });
    expect(optionalString(args, "description")).toBeUndefined();
  });
});

// ── Catalog filters: the browse/search argument surface ─────────────────────

describe("tag array arguments", () => {
  it("normalizes, deduplicates, and accepts an empty replacement", () => {
    const args = validateToolArgs("mindvault_set_tags", {
      resourceId: "res-001",
      tags: [" Dataset ", "dataset", "API"],
    });
    expect(requiredTagArray(args, "tags")).toEqual(["dataset", "api"]);
    expect(
      requiredTagArray(
        validateToolArgs("mindvault_set_tags", { resourceId: "res-001", tags: [] }),
        "tags",
      ),
    ).toEqual([]);
  });

  it("accepts the documented comma-separated convenience form", () => {
    const args = validateToolArgs("mindvault_set_tags", {
      resourceId: "res-001",
      tags: "dataset, research",
    });
    expect(requiredTagArray(args, "tags")).toEqual(["dataset", "research"]);
  });

  it("rejects invalid tag arrays with a stable issue code", () => {
    const tooMany = expectInvalid("mindvault_set_tags", {
      resourceId: "res-001",
      tags: Array.from({ length: 9 }, (_, i) => `tag-${i}`),
    });
    expect(tooMany.issues[0].code).toBe("invalid_tag_array");

    const invalidCharacter = expectInvalid("mindvault_set_tags", {
      resourceId: "res-001",
      tags: ["not valid"],
    });
    expect(invalidCharacter.issues[0].code).toBe("invalid_tag_array");
  });
});

describe("catalog filter arguments", () => {
  it("accepts every sort value on browse and on search", () => {
    for (const sort of ["newest", "price_asc", "price_desc", "title"]) {
      expect(() => validateToolArgs("mindvault_browse", { sort })).not.toThrow();
      expect(() => validateToolArgs("mindvault_search", { query: "x", sort })).not.toThrow();
    }
  });

  it("rejects an unknown sort value", () => {
    const err = expectInvalid("mindvault_browse", { sort: "cheapest" });
    expect(err.issues[0].code).toBe("not_in_enum");
  });

  it("accepts the whole advertised filter set on browse", () => {
    expect(() =>
      validateToolArgs("mindvault_browse", {
        query: "stellar",
        minPrice: "0.10",
        maxPrice: "5.00",
        verificationStatus: "verified",
        resourceType: "link",
        owner: "Alice",
        sort: "price_asc",
        limit: 20,
        offset: 0,
        tags: "dataset,research",
        listed: true,
      }),
    ).not.toThrow();
  });

  it("still reports a typo rather than silently ignoring it", () => {
    const err = expectInvalid("mindvault_browse", { sortBy: "price" });
    expect(err.issues[0].code).toBe("unknown_argument");
    expect(err.issues[0].message).toContain("sort");
  });

  it("browse and search validate against the same argument names", () => {
    expect(Object.keys(TOOL_ARGUMENT_SPECS.mindvault_browse).sort()).toEqual(
      Object.keys(TOOL_ARGUMENT_SPECS.mindvault_search).sort(),
    );
  });
});

describe("mindvault_export_receipts arguments", () => {
  it("accepts the documented filters", () => {
    expect(() =>
      validateToolArgs("mindvault_export_receipts", {
        format: "csv",
        resourceId: "res-001",
        network: "stellar:testnet",
        since: "2026-08-01",
        until: "2026-08-31",
        limit: 50,
      }),
    ).not.toThrow();
  });

  it("rejects a format it cannot produce", () => {
    const err = expectInvalid("mindvault_export_receipts", { format: "xml" });
    expect(err.issues[0].code).toBe("not_in_enum");
  });

  it("rejects a limit outside the supported range", () => {
    expect(expectInvalid("mindvault_export_receipts", { limit: 0 }).issues).toHaveLength(1);
  });
});

describe("mindvault_debug_bundle", () => {
  it("accepts an empty call and both arguments", () => {
    expect(() => validateToolArgs("mindvault_debug_bundle", {})).not.toThrow();
    expect(() =>
      validateToolArgs("mindvault_debug_bundle", { auditLogLines: 0, includeEnvironment: false }),
    ).not.toThrow();
  });

  it("rejects an audit line count outside 0..500 and a non-boolean flag", () => {
    expectInvalid("mindvault_debug_bundle", { auditLogLines: 501 });
    expectInvalid("mindvault_debug_bundle", { auditLogLines: -1 });
    expectInvalid("mindvault_debug_bundle", { includeEnvironment: "maybe" });
  });
});
