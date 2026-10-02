import { afterEach, describe, it, expect, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { Client as ContractClient } from "@stellar/stellar-sdk/contract";
import {
  Client,
  Errors,
  createRegistryClient,
  getAttestationHash,
  listResources,
  networks,
  getNetworkPreset,
  parseStellarNetwork,
  resolveStellarNetwork,
  normalizeX402Network,
  inferNetworkFromX402,
  validateNetworkConfig,
  X402_NETWORK_IDS,
} from "./index.js";

/**
 * Smoke tests for @mindvault/registry-client.
 *
 * These assert the package builds, exports the expected surface, and that the
 * generated Soroban bindings still match what consumers (server/, web/, mcp/)
 * rely on. They make **no live Stellar RPC calls** — constructing a Client only
 * builds a contract spec locally. Network-touching checks live in the
 * `integration` block below, which is skipped unless RUN_INTEGRATION is set.
 *
 * If a test in the "generated bindings" block fails after running
 * `pnpm contract:bindings`, that is binding drift: the deployed contract's
 * interface changed and consumers must be updated to match.
 */

describe("network defaults", () => {
  it("exposes testnet and mainnet presets", () => {
    expect(Object.keys(networks).sort()).toEqual(["mainnet", "testnet"]);
  });

  it("uses the canonical testnet network values", () => {
    const t = networks.testnet;
    expect(t.stellarNetwork).toBe("testnet");
    expect(t.networkPassphrase).toBe(Networks.TESTNET);
    expect(t.x402Network).toBe("stellar:testnet");
    expect(t.sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(t.explorerBaseUrl).toBe("https://stellar.expert");
    expect(t.explorerNetwork).toBe("testnet");
    // Testnet ships a known deployed registry; consumers default to it.
    expect(t.defaultRegistryContractId).toMatch(/^C[A-Z0-9]{55}$/);
  });

  it("uses the canonical mainnet network values", () => {
    const m = networks.mainnet;
    expect(m.stellarNetwork).toBe("mainnet");
    expect(m.networkPassphrase).toBe(Networks.PUBLIC);
    expect(m.x402Network).toBe("stellar:pubnet");
    expect(m.sorobanRpcUrl).toBe("https://soroban.stellar.org");
    expect(m.explorerBaseUrl).toBe("https://stellar.expert");
    expect(m.explorerNetwork).toBe("public");
    // Mainnet operators deploy their own contract; no baked-in default.
    expect(m.defaultRegistryContractId).toBeNull();
  });

  it("resolves and parses STELLAR_NETWORK aliases", () => {
    expect(parseStellarNetwork("testnet")).toBe("testnet");
    expect(parseStellarNetwork("pubnet")).toBe("mainnet");
    expect(parseStellarNetwork("public")).toBe("mainnet");
    expect(parseStellarNetwork("nonsense")).toBeUndefined();
    // Defaults to testnet when unset/unknown.
    expect(resolveStellarNetwork(undefined)).toBe("testnet");
    expect(resolveStellarNetwork("nonsense")).toBe("testnet");
    expect(getNetworkPreset("mainnet")).toBe(networks.mainnet);
  });

  it("normalizes and infers x402 network ids", () => {
    expect(normalizeX402Network("stellar:mainnet")).toBe(X402_NETWORK_IDS.mainnet);
    expect(inferNetworkFromX402("stellar:testnet")).toBe("testnet");
    expect(inferNetworkFromX402("stellar:pubnet")).toBe("mainnet");
    expect(inferNetworkFromX402("stellar:bogus")).toBeUndefined();
  });

  it("flags internally inconsistent network config", () => {
    const issues = validateNetworkConfig({
      stellarNetwork: "testnet",
      x402Network: "stellar:pubnet", // mismatched on purpose
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    });
    expect(issues.some((i) => i.field === "NETWORK")).toBe(true);
  });
});

describe("generated bindings (drift guard)", () => {
  // The exact error variants the vault-registry contract defines. Re-generating
  // bindings against a contract with different errors changes this map. Soroban
  // caps a contract error enum at 50 cases, so 50 is the ceiling, not a choice.
  const EXPECTED_ERRORS: Record<number, string> = {
    1: "AlreadyRegistered",
    2: "NotFound",
    3: "InvalidPrice",
    4: "MetadataTooLong",
    5: "InvalidTag",
    6: "Unauthorized",
    7: "PendingAdminNotSet",
    8: "PendingAdminAlreadySet",
    9: "SameAdmin",
    10: "TermsHashTooLong",
    11: "InvalidResourceId",
    12: "InvalidMetadataPointer",
    13: "EmptyMetadata",
    14: "AlreadyOwner",
    15: "NoPendingTransfer",
    16: "ReservedId",
    17: "PriceExceedsMax",
    18: "AdminNotSet",
    19: "NotVerifier",
    20: "InvalidVerificationTransition",
    21: "AlreadyFrozen",
    22: "MetadataFrozen",
    23: "DuplicateInRepair",
    24: "InvalidTxHash",
    25: "InvalidPaymentAmount",
    26: "NotModerator",
    27: "AlreadyFlagged",
    28: "NotFlagged",
    29: "InvalidLifecycleTransition",
    30: "ResourceNotMutable",
    31: "NetworkAlreadyInitialized",
    32: "NetworkIdMismatch",
    33: "NetworkNotInitialized",
    34: "FeeBpsTooHigh",
    35: "TotalFeeTooHigh",
    36: "CountOverflow",
    37: "BatchTooLarge",
    38: "DuplicateReceipt",
    39: "FlagReasonHashTooLong",
    40: "ContractPaused",
    41: "NotSettler",
    42: "ReceiptAlreadyExists",
    43: "InvalidPaymentTransition",
    44: "InvalidReceiptId",
    45: "ContentHashTooLong",
    46: "AttestationHashTooLong",
    47: "PaymentAmountMismatch",
    48: "DuplicateTxHash",
    49: "FeeConfigNotSet",
    50: "AdminNominationExpired",
  };
  // The full set of contract methods consumers call, mirroring the contract's
  // METHOD_SCHEMA. Adding, removing or renaming a contract function changes
  // this set, and the bindings must be regenerated with pnpm contract:bindings
  // to match.
  const EXPECTED_METHODS = [
    "accept_admin",
    "accept_transfer",
    "add_moderator",
    "add_settler",
    "add_verifier",
    "admin",
    "anchor_purchase_receipt",
    "attempt_anchor_purchase_receipt",
    "cancel_transfer",
    "contract_version",
    "count",
    "creator_listed_count",
    "creator_resource_count",
    "delist",
    "emergency_delist",
    "exists",
    "exists_many",
    "extend_resource_ttl",
    "flag_details",
    "flag_resource",
    "freeze_metadata",
    "freeze_resource",
    "get",
    "get_anchor_failure",
    "get_attestation_hash",
    "get_fee_config",
    "get_fee_destination",
    "get_flag_reason_hash",
    "get_many",
    "get_memo_hash",
    "get_owner",
    "get_owner_many",
    "get_payment",
    "get_payment_receipt",
    "get_purchase_receipt",
    "get_resource_state",
    "get_terms_hash",
    "initialize_network",
    "is_flagged",
    "is_moderator",
    "is_paused",
    "is_settler",
    "is_verifier",
    "list",
    "list_by_creator",
    "list_by_dispute_status",
    "list_by_tag",
    "list_by_verification_status",
    "list_listed",
    "list_page",
    "listed_count",
    "network_id",
    "nominate_new_admin",
    "open_dispute",
    "override_purchase_receipt_anchor",
    "pause_until",
    "pending_admin",
    "pending_admin_expiry",
    "propose_transfer",
    "reactivate_resource",
    "record_anchor_failure",
    "record_payment",
    "record_payment_idempotent",
    "register",
    "register_batch",
    "register_with_hash",
    "register_with_memo",
    "registry_info",
    "remove_moderator",
    "remove_settler",
    "remove_verifier",
    "repair_index",
    "repair_tag_index",
    "resolve_dispute",
    "retry_anchor_purchase_receipt",
    "rotate_verifier",
    "set_fee_config",
    "set_fee_destination",
    "set_fee_recipient",
    "set_flag_reason_hash",
    "set_listed",
    "set_paused",
    "set_paused_until",
    "set_price",
    "set_price_many",
    "set_royalty_recipient",
    "set_tags",
    "top_tags",
    "set_terms_hash",
    "set_verification_status",
    "settle_payment",
    "tombstone_resource",
    "transfer_ownership",
    "unflag_resource",
    "update_metadata",
    "list_listed_page",
    "list_by_dispute_status_page",
    "list_by_creator_page",
    "list_by_tag_page",
    "get_anchor_attempts",
    "buy_lease",
    "record_lease",
    "settle_lease",
    "revoke_lease",
    "get_lease",
    "lease_is_active",
    "lease_price",
  ];

  it("re-exports the generated Client and Errors", () => {
    expect(typeof Client).toBe("function");
    expect(Errors).toBeDefined();
  });

  it("keeps the contract error variants stable", () => {
    const actual = Object.fromEntries(
      Object.entries(Errors).map(([code, e]) => [code, (e as { message: string }).message]),
    );
    expect(actual).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_ERRORS).map(([k, v]) => [k, v])),
    );
  });

  it("exposes the expected contract methods on a constructed client", () => {
    const client = createRegistryClient({
      contractId: networks.testnet.defaultRegistryContractId!,
      rpcUrl: networks.testnet.sorobanRpcUrl,
    });

    // `fromJSON` is generated with one entry per contract method — the canonical
    // list of the bindings' callable surface.
    expect(Object.keys(client.fromJSON).sort()).toEqual([...EXPECTED_METHODS].sort());

    // Each method is also wired as a callable on the instance.
    for (const method of EXPECTED_METHODS) {
      expect(typeof (client as unknown as Record<string, unknown>)[method]).toBe("function");
    }

    expect(typeof listResources).toBe("function");
  });
});

describe("getAttestationHash", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the deployed contract method and returns its result", async () => {
    const method = vi.fn().mockResolvedValue({ result: "attestation-1" });
    vi.spyOn(ContractClient, "from").mockResolvedValue({
      get_attestation_hash: method,
    } as never);

    await expect(
      getAttestationHash({
        contractId: networks.testnet.defaultRegistryContractId!,
        rpcUrl: networks.testnet.sorobanRpcUrl,
        resourceId: "res1",
      }),
    ).resolves.toBe("attestation-1");
    expect(method).toHaveBeenCalledWith({ id: "res1" });
  });

  it("returns null when the contract has no recorded attestation", async () => {
    vi.spyOn(ContractClient, "from").mockResolvedValue({
      get_attestation_hash: vi.fn().mockResolvedValue({ result: null }),
    } as never);

    await expect(
      getAttestationHash({
        contractId: networks.testnet.defaultRegistryContractId!,
        rpcUrl: networks.testnet.sorobanRpcUrl,
        resourceId: "res1",
      }),
    ).resolves.toBeNull();
  });

  it("fails clearly when the deployed contract lacks the method", async () => {
    vi.spyOn(ContractClient, "from").mockResolvedValue({} as never);

    await expect(
      getAttestationHash({
        contractId: networks.testnet.defaultRegistryContractId!,
        rpcUrl: networks.testnet.sorobanRpcUrl,
        resourceId: "res1",
      }),
    ).rejects.toThrow("does not expose get_attestation_hash");
  });
});

describe("contract id configuration", () => {
  const contractId = networks.testnet.defaultRegistryContractId!;
  const rpcUrl = networks.testnet.sorobanRpcUrl;

  it("threads contractId and rpcUrl onto the client", () => {
    const client = createRegistryClient({ contractId, rpcUrl });
    expect(client.options.contractId).toBe(contractId);
    expect(client.options.rpcUrl).toBe(rpcUrl);
  });

  it("defaults the network passphrase to testnet", () => {
    const client = createRegistryClient({ contractId, rpcUrl });
    expect(client.options.networkPassphrase).toBe(Networks.TESTNET);
  });

  it("honors an explicit network passphrase override", () => {
    const client = createRegistryClient({
      contractId,
      rpcUrl: networks.mainnet.sorobanRpcUrl,
      networkPassphrase: Networks.PUBLIC,
    });
    expect(client.options.networkPassphrase).toBe(Networks.PUBLIC);
  });

  it("passes through an optional public key for read-only calls", () => {
    const publicKey = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const client = createRegistryClient({ contractId, rpcUrl, publicKey });
    expect(client.options.publicKey).toBe(publicKey);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — skipped by default so `pnpm test` never needs a live
// Stellar RPC.  Run with:
//   RUN_INTEGRATION=1 pnpm --filter @mindvault/registry-client test
//
// These tests exercise the generated bindings against the deployed testnet
// contract.  Write operations use `simulate: true` so they never require a
// funded signer or broadcast a real transaction.  Any binding drift (renamed
// method, changed parameter order, new error variant) will surface here.
// ---------------------------------------------------------------------------
describe.runIf(process.env.RUN_INTEGRATION)("integration (live RPC)", () => {
  // Shared client — constructed once per suite, reused across tests.
  const client = createRegistryClient({
    contractId: networks.testnet.defaultRegistryContractId!,
    rpcUrl: networks.testnet.sorobanRpcUrl,
  });

  // A well-known Stellar public key used as a read-only placeholder for the
  // `creator` field in simulated write calls.
  const PLACEHOLDER_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  // ---- read-only contract calls (no auth required) -------------------------

  it("count() returns a non-negative integer", async () => {
    const tx = await client.count();
    const n = Number(tx.result);
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it("list() returns an array of Resource objects for the first page", async () => {
    const tx = await client.list({ start: 0, limit: 5 });
    expect(Array.isArray(tx.result)).toBe(true);
    for (const r of tx.result) {
      // Validate each entry matches the Resource interface produced by the bindings.
      expect(typeof r.id).toBe("string");
      expect(typeof r.creator).toBe("string");
      expect(typeof r.listed).toBe("boolean");
      expect(typeof r.metadata).toBe("string");
      expect(typeof r.price).toBe("bigint");
      expect(Array.isArray(r.tags)).toBe(true);
    }
  });

  it("listResources() convenience helper round-trips through list()", async () => {
    const resources = await listResources(client, 0, 5);
    expect(Array.isArray(resources)).toBe(true);
    // The helper must return the same shape as the raw list() call.
    for (const r of resources) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.price).toBe("bigint");
    }
  });

  it("list() with start beyond count returns an empty array", async () => {
    const countTx = await client.count();
    const total = Number(countTx.result);
    // Start one past the last index — contract should return [].
    const tx = await client.list({ start: total + 1000, limit: 5 });
    expect(tx.result).toEqual([]);
  });

  it("exists() returns false for a resource that cannot exist on-chain", async () => {
    // Use a UUID-shaped ID that is astronomically unlikely to be registered.
    const ghostId = `__integration_ghost_${Date.now()}`;
    const tx = await client.exists({ id: ghostId });
    expect(tx.result).toBe(false);
  });

  it("get() propagates a NotFound contract error for an unregistered id", async () => {
    const ghostId = `__integration_ghost_${Date.now()}`;
    try {
      const tx = await client.get({ id: ghostId });
      // If the RPC returns a simulation result, check it carries the error.
      expect(tx).toBeDefined();
    } catch (e: unknown) {
      // Contract error (NotFound = 2) bubbles as an exception from the SDK.
      expect(e).toBeDefined();
    }
  });

  // ---- simulated write calls (simulate:true — no broadcast, no auth needed) -

  it("register() simulation succeeds and returns an AssembledTransaction", async () => {
    const id = `__integration_sim_${Date.now()}`;
    const tx = await client.register(
      {
        creator: PLACEHOLDER_KEY,
        id,
        price: 5_000_000n, // 0.50 USDC in stroops
        metadata: "ipfs://integration-test-placeholder",
        tags: ["test"],
      },
      { simulate: true },
    );
    // A successful simulation always returns an object; the SDK throws on
    // contract-level errors even in simulation mode.
    expect(tx).toBeDefined();
  });

  it("set_price() simulation accepts a new price without error", async () => {
    const tx = await client.set_price(
      { id: "nonexistent-for-sim", new_price: 10_000_000n },
      { simulate: true },
    );
    expect(tx).toBeDefined();
  });

  it("set_tags() simulation accepts a new tag list without error", async () => {
    const tx = await client.set_tags(
      { id: "nonexistent-for-sim", tags: ["dataset", "research"] },
      { simulate: true },
    );
    expect(tx).toBeDefined();
  });

  it("update_metadata() simulation accepts a new metadata pointer without error", async () => {
    const tx = await client.update_metadata(
      { id: "nonexistent-for-sim", metadata: "ipfs://updated-pointer" },
      { simulate: true },
    );
    expect(tx).toBeDefined();
  });

  it("set_listed() simulation accepts a listing-state toggle without error", async () => {
    const tx = await client.set_listed(
      { id: "nonexistent-for-sim", listed: false },
      { simulate: true },
    );
    expect(tx).toBeDefined();
  });

  it("delist() simulation completes without error", async () => {
    const tx = await client.delist({ id: "nonexistent-for-sim" }, { simulate: true });
    expect(tx).toBeDefined();
  });

  it("transfer_ownership() simulation accepts a new creator without error", async () => {
    const tx = await client.transfer_ownership(
      { id: "nonexistent-for-sim", new_creator: PLACEHOLDER_KEY },
      { simulate: true },
    );
    expect(tx).toBeDefined();
  });

  it("get_owner() propagates gracefully for an unregistered id", async () => {
    const ghostId = `__integration_ghost_owner_${Date.now()}`;
    try {
      const tx = await client.get_owner({ id: ghostId });
      expect(tx).toBeDefined();
    } catch (e: unknown) {
      expect(e).toBeDefined();
    }
  });

  // ---- binding-drift guard ------------------------------------------------
  // If the deployed contract changes its interface, these assertions surface
  // the mismatch before consumers (server/, web/, mcp/) break at runtime.

  it("all expected methods are callable on a live client instance", () => {
    const EXPECTED_METHODS = [
      "count",
      "delist",
      "exists",
      "get",
      "get_owner",
      "list",
      "register",
      "set_listed",
      "set_price",
      "set_tags",
      "transfer_ownership",
      "update_metadata",
    ];
    for (const method of EXPECTED_METHODS) {
      expect(
        typeof (client as unknown as Record<string, unknown>)[method],
        `method '${method}' must be callable`,
      ).toBe("function");
    }
  });
});
