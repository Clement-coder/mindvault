/**
 * What each MCP tool's handler actually does to the world (#1063).
 *
 * Annotations (`readOnlyHint`, `destructiveHint`) and the spend guardrails
 * (`paidOperations.ts`, `mainnetGuardrails.ts`) are four separate claims about
 * a tool's side effects, maintained by hand in three files. Nothing tied them
 * to the handler, and they had drifted: `mindvault_backup_state` was
 * advertised read-only while writing an encrypted backup file on every call,
 * `mindvault_set_tags` advertised a `confirmPaid` argument the paid-operation
 * policy never asked for, and `mindvault_terms` set an on-chain hash without
 * the mainnet guardrail its dispatcher branch was written for.
 *
 * This table is the side-effect inventory, one row per tool, written from the
 * handler. `toolSideEffects.test.ts` derives the annotations and guardrail
 * classifications from it and fails when any of them disagree, and it runs
 * every tool this table calls side-effect free against a scratch home
 * directory to check that the handler really writes nothing.
 *
 * Effects are worst case over the tool's arguments: `mindvault_terms` with
 * `operation: "get"` is a read, but the tool can set a hash, so its row says
 * so. Per-call exemptions (a dry run, a terms read) live in the dispatcher.
 *
 * Not counted as a tool's side effect: the operator-configured audit log, the
 * in-memory metrics every call increments, and in-memory read caches (catalog
 * snapshots, single-flight entries). They are server bookkeeping that no other
 * tool's result depends on.
 */

/** Effect on state kept by this MCP server process or under `~/.mindvault`. */
export type LocalEffect =
  /** Reads at most. */
  | "none"
  /** Changes in-process state other calls observe (e.g. resets counters). */
  | "memory"
  /** Adds or updates local files without discarding anything stored. */
  | "write"
  /**
   * Can replace or delete stored local data irreversibly: a wallet secret,
   * an API key, profile state, or the whole state file.
   */
  | "overwrite";

/** Effect outside this process. Reads (GET, simulation, Horizon) are not effects. */
export type RemoteEffect =
  | "none"
  /** A non-idempotent MindVault / sponsored-account API request. */
  | "api"
  /** Submits a Stellar transaction signed by the agent wallet. */
  | "chain";

/** What the agent wallet pays. Mirrors `PaidOperationClass` in `paidOperations.ts`. */
export type PaymentEffect = "none" | "usdc" | "fee";

export interface ToolSideEffects {
  local: LocalEffect;
  remote: RemoteEffect;
  payment: PaymentEffect;
  /** An on-chain change that can never be undone (e.g. freezing metadata). */
  irreversible?: true;
}

const READ: ToolSideEffects = { local: "none", remote: "none", payment: "none" };
const CHAIN_FEE: ToolSideEffects = { local: "none", remote: "chain", payment: "fee" };
/** A registry mutation that also appends to the local resource history. */
const CHAIN_FEE_WITH_HISTORY: ToolSideEffects = { local: "write", remote: "chain", payment: "fee" };

export const TOOL_SIDE_EFFECTS: Readonly<Record<string, ToolSideEffects>> = {
  // ── Wallet and profiles ──────────────────────────────────────────────────
  // Replaces the target profile's wallet secret; the sponsor pays for the account.
  mindvault_setup_wallet: { local: "overwrite", remote: "api", payment: "none" },
  mindvault_wallet_info: READ,
  // Replaces the target profile's wallet secret after a Horizon read.
  mindvault_repair_sponsored_account: { local: "overwrite", remote: "none", payment: "none" },
  mindvault_use_profile: { local: "write", remote: "none", payment: "none" },
  mindvault_list_profiles: READ,
  mindvault_export_profiles: READ,
  // Merges profile setup; credentials are never changed.
  mindvault_import_profiles: { local: "write", remote: "none", payment: "none" },
  mindvault_switch_network_profile: { local: "write", remote: "none", payment: "none" },
  // Replaces the target profile's wallet secret when persisting.
  mindvault_import_wallet: { local: "overwrite", remote: "none", payment: "none" },
  // Server-side registration; stores (and replaces) the profile's API key.
  mindvault_register: { local: "overwrite", remote: "api", payment: "none" },
  // Revokes the old API key server-side and replaces it locally.
  mindvault_rotate_publisher_key: { local: "overwrite", remote: "api", payment: "none" },

  // ── Catalog ──────────────────────────────────────────────────────────────
  mindvault_browse: READ,
  mindvault_search: READ,
  mindvault_preview: READ,
  mindvault_prewarm_catalog: READ,
  // Returns guidance only; it invalidates nothing.
  mindvault_recover_catalog_cache: READ,

  // ── Publishing and buying ────────────────────────────────────────────────
  // x402 payments are signed Stellar transfers, so they count as chain effects.
  mindvault_publish: { local: "write", remote: "chain", payment: "usdc" },
  mindvault_publish_batch: { local: "none", remote: "chain", payment: "usdc" },
  mindvault_publish_status: READ,
  mindvault_buy: { local: "write", remote: "chain", payment: "usdc" },
  mindvault_buy_lease: { local: "write", remote: "chain", payment: "usdc" },
  mindvault_lease_status: READ,
  mindvault_purchase_history: READ,
  mindvault_export_receipts: READ,

  // ── Registry reads ───────────────────────────────────────────────────────
  mindvault_agent_status: READ,
  mindvault_registry_info: READ,
  mindvault_network_profile: READ,
  mindvault_check_bindings: READ,
  mindvault_check_consistency: READ,
  mindvault_verify_attestation: READ,
  mindvault_registry_lookup: READ,
  // Explains a contract error from a table; it reads nothing and writes nothing.
  mindvault_explain_error_code: READ,
  mindvault_registry_list: READ,
  mindvault_registry_count: READ,
  mindvault_registry_creator_page: READ,
  mindvault_registry_tag_search: READ,
  mindvault_pending_transfer: READ,
  mindvault_fee_config: READ,
  mindvault_tx_status: READ,
  mindvault_resource_provenance: READ,
  mindvault_resource_change_log: READ,

  // ── Registry mutations (signed Soroban transactions) ─────────────────────
  mindvault_register_onchain: CHAIN_FEE,
  // `operation: "set"` submits set_terms_hash; "get" is exempted per call.
  mindvault_terms: CHAIN_FEE,
  mindvault_update_metadata: CHAIN_FEE_WITH_HISTORY,
  mindvault_set_price: CHAIN_FEE_WITH_HISTORY,
  mindvault_set_tags: CHAIN_FEE,
  mindvault_transfer_ownership: CHAIN_FEE_WITH_HISTORY,
  mindvault_accept_transfer: CHAIN_FEE,
  mindvault_cancel_transfer: CHAIN_FEE,
  mindvault_set_listed: CHAIN_FEE,
  mindvault_freeze: { ...CHAIN_FEE, irreversible: true },
  mindvault_royalty: CHAIN_FEE,

  // ── Local state ──────────────────────────────────────────────────────────
  mindvault_reset: { local: "overwrite", remote: "none", payment: "none" },
  // Writes a new encrypted backup file under ~/.mindvault/backups each call.
  mindvault_backup_state: { local: "write", remote: "none", payment: "none" },
  mindvault_compare_state_backup: READ,
  mindvault_restore_state: { local: "overwrite", remote: "none", payment: "none" },
  mindvault_check_state_permissions: READ,

  // ── Diagnostics ──────────────────────────────────────────────────────────
  // `reset: true` clears the in-process counters other calls report.
  mindvault_metrics: { local: "memory", remote: "none", payment: "none" },
  mindvault_registry_health: READ,
  mindvault_rpc_health: READ,
  mindvault_client_config: READ,
  mindvault_mainnet_banner: READ,
  mindvault_verify_install: READ,
  mindvault_debug_bundle: READ,
};

/** The annotation hints a side-effect row implies. */
export interface ExpectedAnnotationHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

/**
 * Derive the hints from the effects:
 *
 *  - `readOnlyHint` exactly when the tool has no local, remote, or payment
 *    effect of any kind;
 *  - `destructiveHint` exactly when it can overwrite or delete stored local
 *    data, or make an irreversible on-chain change.
 */
export function expectedAnnotationHints(effects: ToolSideEffects): ExpectedAnnotationHints {
  const readOnly =
    effects.local === "none" && effects.remote === "none" && effects.payment === "none";
  return {
    readOnlyHint: readOnly,
    destructiveHint: effects.local === "overwrite" || effects.irreversible === true,
  };
}

/** Whether the mainnet guardrail must cover a tool with these effects. */
export function requiresMainnetGate(effects: ToolSideEffects): boolean {
  return effects.remote === "chain" || effects.payment !== "none";
}
