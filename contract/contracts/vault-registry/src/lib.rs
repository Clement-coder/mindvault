#![no_std]
//! MindVault on-chain vault registry.
//!
//! Records each vault resource on Stellar: its creator, price (in USDC base
//! units, 7 decimals — see [`USDC_DECIMALS`]), and a metadata pointer. Payment
//! itself still flows through x402 + the USDC SAC off this contract — this
//! registry is the transparent, on-chain source of truth for *what* exists,
//! *who* owns it, and *what it costs*.
//!
//! Only the recorded creator can mutate a resource (enforced via
//! `require_auth`). Ownership can be transferred.

extern crate alloc;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    IntoVal, String, Symbol, Val, Vec,
};

// ~5s ledgers → 17,280 per day. Persistent entries are bumped ~30 days on each
// write so an actively-managed resource is never archived out from under us.
const DAY_IN_LEDGERS: u32 = 17280;
const ADMIN_NOMINATION_DURATION: u32 = 7 * DAY_IN_LEDGERS;
/// Default creator refund window, matching the ADR's example dispute window.
pub const DEFAULT_REFUND_WINDOW_LEDGERS: u32 = DAY_IN_LEDGERS;
/// Maximum refund window leaves one day of TTL beyond the 30-day storage bump.
pub const MAX_REFUND_WINDOW_LEDGERS: u32 = 29 * DAY_IN_LEDGERS;
const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const LIFETIME_THRESHOLD: u32 = BUMP_AMOUNT - DAY_IN_LEDGERS;
/// Max length for metadata pointers (IPFS URI, content hash, compact JSON anchor).
pub const MAX_METADATA_POINTER_LEN: u32 = 512;
pub const MAX_TERMS_HASH_LEN: u32 = 64;
/// Max number of redundant metadata pointers (e.g. IPFS + Arweave + hosted)
/// a resource may carry via `set_metadata_pointers`.
pub const MAX_METADATA_POINTERS: u32 = 4;
/// Domain separator prefixed to every preimage hashed by
/// `compute_attestation_hash`, so the digest can never collide with a hash
/// computed for another purpose over the same bytes.
pub const ATTESTATION_HASH_DOMAIN: &str = "mindvault-attestation-v1";
pub const MAX_CONTENT_HASH_LEN: u32 = 128;
pub const DEFAULT_ATTESTATION_HASH_ALGORITHM: &str = "sha256";
pub const MAX_ATTESTATION_HASH_ALGORITHM_LEN: u32 = 16;
pub const MAX_ATTESTATION_HASH_LEN: u32 = 64;
/// Max length for a moderator's off-chain dispute reason hash, set via
/// `set_flag_reason_hash`. Same bound as `MAX_TERMS_HASH_LEN` — both store a
/// fixed-size digest of arbitrary off-chain content.
pub const MAX_FLAG_REASON_HASH_LEN: u32 = 64;
const MAX_TAGS: u32 = 8;
/// Decimal places in Stellar USDC, so 1 USDC is `10^7` base units. A USDC base
/// unit is *not* a "stroop" (a stroop is `10^-5` XLM — a 100x difference).
pub const USDC_DECIMALS: u32 = 7;
/// Base units in 1 USDC, i.e. `10^USDC_DECIMALS`.
pub const USDC_BASE_UNITS_PER_USDC: i128 = 10_000_000;
/// Maximum price in USDC base units (`USDC_DECIMALS` = 7), i.e. `10^18` units
/// = **100 billion USDC**, not 1 trillion (which would need 6 decimals).
pub const MAX_PRICE: i128 = 1_000_000_000_000_000_000;
const MAX_TAG_LEN: u32 = 32;
/// Maximum byte length of a resource id (1–`MAX_RESOURCE_ID_LEN` ASCII
/// lowercase letters/digits). Ids that exceed this are rejected with
/// `InvalidResourceId`. The cuid2 generator always produces ids within this
/// bound.
pub const MAX_RESOURCE_ID_LEN: u32 = 24;
/// Maximum number of items returned per page by `list`, `list_page`,
/// `list_listed`, and `list_by_creator`. Centralised here so the cap is
/// easy to find, document, and change in a single place instead of
/// scattered `limit.min(20)` literals.
pub const LIST_PAGE_CAP: u32 = 20;
pub const TOP_TAGS_CAP: u32 = 20;
/// Maximum number of resources that can be registered in a single batch
/// via `register_batch`. Keeps execution bounded and prevents transaction
/// timeouts.
pub const MAX_BATCH_REGISTER: u32 = 10;
/// Maximum number of prices that can be updated in one `set_price_many` call.
pub const MAX_BATCH_PRICE_UPDATES: u32 = 10;

// ── Fee / royalty configuration ──────────────────────────────────────────────
/// Fee basis-point ceiling: 50 % (5 000 bp). Neither platform_fee_bps nor
/// royalty_bps may individually exceed this value, and their *sum* may not
/// exceed it either, so the worst case is 50 % of each purchase price.
pub const MAX_FEE_BPS: u32 = 5_000;
/// Denominator for converting basis-point values to a fraction (1/10 000).
pub const FEE_BPS_DENOM: u32 = 10_000;
pub const MAX_FEE_DESTINATION_BPS: u32 = FEE_BPS_DENOM;
/// Minimum creator share in basis points (50 % = 5 000 bp).
///
/// `validate_price` enforces that the price in stroops strictly exceeds the
/// combined `platform_fee_bps + royalty_bps` so that the creator always
/// receives a positive, non-zero remainder on every sale.  Together with
/// `MAX_FEE_BPS` capping the sum of fees at 50 %, this guarantees the creator
/// can never receive less than 50 % of any sale price.
pub const MIN_CREATOR_SHARE_BPS: u32 = FEE_BPS_DENOM - MAX_FEE_BPS; // 5_000

/// Stable registry name returned by [`VaultRegistry::registry_info`].
pub const REGISTRY_NAME: &str = "mindvault-vault-registry";
/// Version of the on-chain `Resource` schema. Bump whenever a change to the
/// `Resource` struct's fields would require callers to change how they decode
/// it (e.g. the tags field added in schema version 2, dispute_flag added in
/// schema version 4, metadata_frozen_at added in schema version 6).
pub const RESOURCE_SCHEMA_VERSION: u32 = 6;

/// Maximum byte length of a settlement transaction hash stored in a
/// [`PaymentReceipt`]. Stellar transaction hashes are 64 hex characters
/// (32 bytes), but we allow up to 128 to accommodate future hash formats
/// (e.g. a `sha256:` prefixed hex string).
pub const MAX_TX_HASH_LEN: u32 = 128;

/// Maximum byte length of a caller-assigned payment `receipt_id`.
pub const MAX_RECEIPT_ID_LEN: u32 = 64;

/// Prefix of the canonical settlement memo. A payment transaction settling a
/// purchase of resource `id` should carry the `MEMO_TEXT` `mv:<id>`, which
/// `record_payment_with_memo` checks so each receipt proves which resource
/// the on-chain payment was for. `MAX_RESOURCE_ID_LEN` (24) plus this prefix
/// fits within Stellar's 28-byte `MEMO_TEXT` limit.
pub const PAYMENT_MEMO_PREFIX: &str = "mv:";

/// Upper bound, in ledgers, on the admin-configurable flag resolution window
/// (`set_flag_resolution_window`). Roughly 30 days at ~5s per ledger.
pub const MAX_FLAG_RESOLUTION_WINDOW: u32 = 535_680;

/// Canonical list of every exported method this contract exposes, paired with
/// the required authorisation rule (who must sign the call). This is the
/// single source of truth for the API surface: `contract/README.md`'s Methods
/// table must document exactly these function names, and every entry here must
/// appear as a row in that table. Both directions are enforced by the test
/// `readme_methods_table_matches_method_schema` in `test.rs`, so any drift
/// between code, this const, and the README fails a test.
#[cfg(test)]
pub const METHOD_SCHEMA: &[(&str, &str)] = &[
    // ── Resource lifecycle ────────────────────────────────────────────────
    ("register", "creator"),
    ("register_with_hash", "creator"),
    ("register_with_memo", "creator"),
    ("register_batch", "creator"),
    ("set_price", "creator"),
    ("set_price_many", "creator"),
    ("update_metadata", "creator"),
    ("freeze_metadata", "creator"),
    ("set_metadata_pointers", "creator"),
    ("get_metadata_pointers", "—"),
    ("set_tags", "creator"),
    ("set_royalty_recipient", "creator"),
    ("set_listed", "creator"),
    ("delist", "creator"),
    ("freeze_resource", "creator"),
    ("open_dispute", "admin"),
    ("resolve_dispute", "admin"),
    ("emergency_delist", "admin"),
    ("tombstone_resource", "admin"),
    ("reactivate_resource", "creator"),
    // ── Ownership transfer ────────────────────────────────────────────────
    ("transfer_ownership", "creator"),
    ("propose_transfer", "creator"),
    ("accept_transfer", "proposed new_creator"),
    ("cancel_transfer", "creator"),
    // ── Read-only queries ─────────────────────────────────────────────────
    ("get", "—"),
    ("get_resource_state", "—"),
    ("get_many", "—"),
    ("exists", "—"),
    ("exists_many", "—"),
    ("get_owner", "—"),
    ("get_owner_many", "—"),
    ("count", "—"),
    ("listed_count", "—"),
    ("creator_resource_count", "—"),
    ("creator_listed_count", "—"),
    // ── Paginated catalog ─────────────────────────────────────────────────
    ("list", "—"),
    ("list_page", "—"),
    ("list_listed", "—"),
    ("list_by_creator", "—"),
    ("list_by_tag", "—"),
    ("top_tags", "—"),
    ("list_by_dispute_status", "—"),
    ("list_by_verification_status", "—"),
    ("list_listed_page", "—"),
    ("list_by_dispute_status_page", "—"),
    ("list_by_creator_page", "—"),
    ("list_by_tag_page", "—"),
    // ── Verification ──────────────────────────────────────────────────────
    ("add_verifier", "admin"),
    ("remove_verifier", "admin"),
    ("rotate_verifier", "admin"),
    ("is_verifier", "—"),
    ("set_verification_status", "verifier"),
    ("get_attestation_hash", "—"),
    ("compute_attestation_hash", "—"),
    ("verify_attestation_hash", "—"),
    ("get_memo_hash", "—"),
    // ── Registry introspection ────────────────────────────────────────────
    ("registry_info", "—"),
    ("contract_version", "—"),
    ("resource_schema_version", "—"),
    ("initialize_network", "—"),
    ("network_id", "—"),
    // ── Admin role ────────────────────────────────────────────────────────
    ("admin", "—"),
    ("pending_admin", "—"),
    ("pending_admin_expiry", "—"),
    (
        "nominate_new_admin",
        "current admin (or new_admin for bootstrap)",
    ),
    ("accept_admin", "pending admin"),
    ("bootstrap_dual_admin", "admin + recovery_admin"),
    ("recovery_admin", "—"),
    ("set_recovery_admin", "admin"),
    ("recover_admin", "recovery admin"),
    ("set_paused", "admin"),
    ("set_paused_until", "admin"),
    ("is_paused", "—"),
    ("pause_until", "—"),
    // ── Settler role ──────────────────────────────────────────────────────
    ("add_settler", "admin"),
    ("record_payment_with_memo", "settler + payer"),
    ("get_payment_memo", "—"),
    ("remove_settler", "admin"),
    ("is_settler", "—"),
    // ── Moderator role / dispute flags ───────────────────────────────────
    ("add_moderator", "admin"),
    ("remove_moderator", "admin"),
    ("is_moderator", "—"),
    ("flag_resource", "moderator"),
    ("unflag_resource", "moderator"),
    ("set_flag_reason_hash", "moderator"),
    ("get_flag_reason_hash", "—"),
    ("set_flag_resolution_window", "admin"),
    ("flag_resolution_window", "—"),
    ("get_flag_deadline", "—"),
    ("is_flag_overdue", "—"),
    ("force_resolve_flag", "admin"),
    ("is_flagged", "—"),
    ("flag_details", "—"),
    // ── Terms hashes ──────────────────────────────────────────────────────
    ("set_terms_hash", "creator"),
    ("get_terms_hash", "—"),
    ("set_registry_terms_hash", "admin"),
    // ── Fees ──────────────────────────────────────────────────────────────
    ("set_fee_config", "admin"),
    ("get_fee_config", "—"),
    ("set_fee_recipient", "admin"),
    ("set_fee_destination", "admin"),
    ("get_fee_destination", "—"),
    // ── Index repair ──────────────────────────────────────────────────────
    ("repair_index", "admin"),
    ("repair_tag_index", "admin"),
    // ── Payment receipts ──────────────────────────────────────────────────
    ("record_payment", "settler + payer"),
    ("record_payment_idempotent", "settler + payer"),
    ("settle_payment", "settler"),
    ("get_payment", "—"),
    ("get_payment_receipt", "—"),
    ("set_refund_window", "admin"),
    ("refund_window", "—"),
    ("record_creator_refund", "creator"),
    ("record_admin_refund", "admin override"),
    ("get_refund", "—"),
    ("get_refunded_amount", "—"),
    ("get_refund_deadline", "—"),
    ("anchor_purchase_receipt", "verifier"),
    ("attempt_anchor_purchase_receipt", "verifier"),
    ("override_purchase_receipt_anchor", "admin"),
    ("get_purchase_receipt", "—"),
    ("get_anchor_attempts", "—"),
    // ── Access leases ─────────────────────────────────────────────────────
    ("buy_lease", "holder"),
    ("record_lease", "settler + holder"),
    ("settle_lease", "settler"),
    ("revoke_lease", "creator"),
    ("get_lease", "—"),
    ("lease_is_active", "—"),
    ("lease_price", "—"),
    // ── TTL ───────────────────────────────────────────────────────────────
    ("extend_resource_ttl", "creator"),
    // ── Creator earnings estimator (#804) ─────────────────────────────────
    ("creator_earnings_estimate", "—"),
    // ── Verifier status history (#805) ────────────────────────────────────
    ("get_verifier_status_history", "—"),
    // ── Resource state query (#806) ───────────────────────────────────────
    ("list_by_state", "—"),
    // ── Ownership transfer with terms handoff (#808) ──────────────────────
    ("transfer_ownership_with_terms", "creator"),
];

/// Canonical list of every error code this contract can return, paired with
/// its numeric discriminant and a short description. This is the single source
/// of truth for error codes: `contract/README.md`'s Error codes table must
/// document exactly these codes. Both directions are enforced by the test
/// `readme_error_codes_table_matches_error_schema` in `test.rs`, so any drift
/// between code, this const, and the README fails a test.
#[cfg(test)]
pub const ERROR_SCHEMA: &[(u32, &str, &str)] = &[
    (1, "AlreadyRegistered", "A resource with the given `id` or the target verifier already exists, or the holder already has a pending or unexpired active lease on the resource (`buy_lease` / `record_lease`)."),
    (2, "NotFound", "No resource (or terms hash, receipt, or old verifier) matches the given key."),
    (3, "InvalidPrice", "Price is `<= 0`, exceeds `MAX_PRICE`, or is not strictly greater than the combined active `platform_fee_bps + royalty_bps` (creator-share invariant)."),
    (4, "MetadataTooLong", "Metadata pointer exceeds `MAX_METADATA_POINTER_LEN` (512 bytes)."),
    (5, "InvalidTag", "Tag validation failed (too many tags, empty tag, tag exceeds 32 bytes, or duplicate normalized tag)."),
    (6, "Unauthorized", "Caller is unauthorized, including a refund recipient mismatch."),
    (7, "PendingAdminNotSet", "No pending admin is set, or caller does not match the pending admin."),
    (8, "PendingAdminAlreadySet", "A pending admin nomination is already active."),
    (9, "SameAdmin", "Nominated new admin is already the current contract admin."),
    (10, "TermsHashTooLong", "Terms hash exceeds `MAX_TERMS_HASH_LEN` (64 bytes)."),
    (11, "InvalidResourceId", "Resource id is empty, exceeds 24 bytes, or contains non-lowercase-alphanumeric characters."),
    (12, "InvalidMetadataPointer", "Metadata pointer does not start with a supported prefix."),
    (13, "EmptyMetadata", "Metadata pointer is empty."),
    (14, "AlreadyOwner", "Proposed/target new owner is already the current owner."),
    (15, "NoPendingTransfer", "No pending transfer exists for this resource."),
    (16, "ReservedId", "Resource id collides with a reserved word (e.g. `admin`, `registry`)."),
    (17, "PriceExceedsMax", "Price exceeds `MAX_PRICE`."),
    (18, "AdminNotSet", "`add_verifier`, `remove_verifier`, `rotate_verifier`, or `repair_index` was called before any admin was bootstrapped."),
    (19, "NotVerifier", "`set_verification_status` was called by an address that does not hold the verifier role."),
    (20, "InvalidVerificationTransition", "The requested `VerificationStatus` transition is not allowed (e.g. same-status no-op, or reverting to `Pending`)."),
    (21, "AlreadyFrozen", "`freeze_metadata` was called on a resource whose metadata is already frozen."),
    (22, "MetadataFrozen", "`update_metadata` was called on a resource whose metadata has been frozen."),
    (23, "DuplicateInRepair", "`repair_index` received a list with duplicate resource ids."),
    (24, "InvalidTxHash", "A payment or refund `tx_hash` is empty or exceeds `MAX_TX_HASH_LEN` (128 bytes)."),
    (25, "InvalidPaymentAmount", "A payment or refund `amount` is `<= 0`, or a refund window is outside its allowed bounds."),
    (26, "NotModerator", "Caller does not hold the moderator role."),
    (27, "AlreadyFlagged", "Resource is already flagged as disputed."),
    (28, "NotFlagged", "Resource is not currently flagged as disputed."),
    (29, "InvalidLifecycleTransition", "The requested lifecycle transition is not allowed from the current state."),
    (30, "ResourceNotMutable", "A frozen, disputed, or tombstoned resource cannot be changed by its creator, and a resource that is not `Listed` (delisted, frozen, disputed, or tombstoned) cannot accept a payment (`record_payment`) or a lease (`buy_lease` / `record_lease`)."),
    (31, "NetworkAlreadyInitialized", "Network identifier has already been initialized for this contract instance."),
    (32, "NetworkIdMismatch", "Invocation network identifier does not match configured network ID."),
    (33, "NetworkNotInitialized", "Network identifier has not been initialized."),
    (34, "FeeBpsTooHigh", "A fee or fee-destination basis-point value exceeds its configured ceiling."),
    (35, "TotalFeeTooHigh", "The combined fee policy or fee-destination split is invalid."),
    (36, "CountOverflow", "The global resource count would overflow `u32`."),
    (37, "BatchTooLarge", "`get_many` or `get_owner_many` was called with more than 20 ids."),
    (38, "DuplicateReceipt", "A purchase receipt is already anchored for `(resource_id, buyer)`."),
    (39, "FlagReasonHashTooLong", "`reason_hash` in `set_flag_reason_hash` exceeds `MAX_FLAG_REASON_HASH_LEN` (64 bytes)."),
    (40, "ContractPaused", "A state-changing method was called while the registry is paused."),
    (41, "NotSettler", "Caller does not hold the settler role."),
    (42, "ReceiptAlreadyExists", "A payment or refund receipt is already stored for the supplied id."),
    (43, "InvalidPaymentTransition", "Payment is not settled, its creator refund deadline has expired, or a payment state transition is not allowed."),
    (44, "InvalidReceiptId", "`receipt_id` is empty or exceeds `MAX_RECEIPT_ID_LEN` (64 bytes)."),
    (45, "ContentHashTooLong", "`content_hash` exceeds `MAX_CONTENT_HASH_LEN` (128 bytes)."),
    (46, "AttestationHashTooLong", "`attestation_hash` exceeds `MAX_ATTESTATION_HASH_LEN` (64 bytes)."),
    (47, "PaymentAmountMismatch", "Payment amount differs from the resource price or cumulative refunds exceed the original payment."),
    (48, "DuplicateTxHash", "A payment or refund receipt already uses the supplied transaction hash (`tx_hash`)."),
    (49, "FeeConfigNotSet", "`set_fee_recipient` or `set_fee_destination` was called before any fee config was set via `set_fee_config`."),
    (50, "AdminNominationExpired", "The pending admin nomination is missing or has expired."),
    (51, "InvalidMetadataPointers", "`set_metadata_pointers` received an empty, oversized (> `MAX_METADATA_POINTERS`), or duplicate pointer list, or an out-of-range `primary` index."),
    (52, "AdminAlreadySet", "`bootstrap_dual_admin` was called after an admin was already set."),
    (53, "RecoveryAdminNotSet", "`recover_admin` was called but no recovery admin is configured."),
];

/// Canonical list of every event topic this contract emits, paired with a
/// human-readable description of its payload shape. This is the single
/// source of truth for event schemas: `contract/README.md`'s Events table
/// must list exactly these topics, and the contract must not emit any topic
/// absent from this list. Both directions are enforced by tests in
/// `test.rs` (`event_schema_matches_documented_readme_table` and
/// `full_workflow_emits_exactly_the_documented_events`) so any drift between
/// code, this const, and the docs fails a test.
#[cfg(test)]
pub const EVENT_SCHEMA: &[(&str, &str)] = &[
    ("register", "Resource"),
    ("regmemo", "memo_hash: BytesN<32>"),
    (
        "setprice",
        "PriceUpdated { id, old_price, new_price, updater }",
    ),
    (
        "updmeta",
        "MetadataUpdateEvent { id, old_metadata, new_metadata }",
    ),
    (
        "settags",
        "(prev_tags: Vec<String>, next_tags: Vec<String>)",
    ),
    ("setroyal", "(old_recipient: Option<Address>, new_recipient: Option<Address>)"),
    ("transfer", "(previous_owner: Address, new_owner: Address)"),
    ("propose", "(owner: Address, proposed: Address)"),
    ("cancel", "owner: Address"),
    ("setlisted", "(old_listed: bool, new_listed: bool)"),
    (
        "emdelist",
        "EmergencyDelistEvent { id, admin, reason }",
    ),
    ("setterms", "terms_hash: String"),
    ("setregt", "terms_hash: String"),
    ("setadmin", "new_admin: Address"),
    ("setrecov", "recovery_admin: Option<Address>"),
    ("recover", "(old_admin: Address, new_admin: Address)"),
    ("setptrs", "MetadataPointers { pointers, primary }"),
    ("nomadmin", "new_admin: Address"),
    ("accadmin", "new_admin: Address"),
    ("netinit", "network_id: BytesN<32>"),
    ("freeze", "()"),
    (
        "verify",
        "(old_status: VerificationStatus, new_status: VerificationStatus, attestation_hash: Option<String>)",
    ),
    ("addverif", "RoleChange { admin, target, granted: true }"),
    ("rmverif", "RoleChange { admin, target, granted: false }"),
    ("verrot", "VerifierRotation { old_verifier, new_verifier, ledger }"),
    ("reindex", "new_count: u32 (topic carries old_count: u32)"),
    (
        "payment",
        "PaymentReceipt { receipt_id, resource_id, payer, amount, state, tx_hash, recorded_at }",
    ),
    (
        "settle",
        "PaymentReceipt { receipt_id, resource_id, payer, amount, state, tx_hash, recorded_at }",
    ),
    ("addsettlr", "RoleChange { admin, target, granted: true }"),
    ("rmsettlr", "RoleChange { admin, target, granted: false }"),
    ("pause", "(paused: bool, admin: Address)"),
    ("pause_until", "(pause_until: u64, admin: Address)"),
    (
        "anchor",
        "PurchaseReceiptAnchor { resource_id, buyer, receipt_hash, ledger }",
    ),
    (
        "anchrfail",
        "AnchorFailure { resource_id, buyer, receipt_hash, reason, ledger }",
    ),
    ("addmod", "RoleChange { admin, target, granted: true }"),
    ("rmmod", "RoleChange { admin, target, granted: false }"),
    ("flag", "FlagEvent { id, moderator, reason }"),
    ("unflag", "resource id"),
    ("flagrsn", "(moderator: Address, reason_hash: String)"),
    ("flagwin", "window_ledgers: u32"),
    ("flagfrc", "(admin: Address, deadline: u32)"),
    ("nomemo", "(receipt_id: String, tx_hash: String)"),
    ("retagidx", "new_count: u32"),
    ("reactive", "resource id"),
    (
        "setfee",
        "FeeConfigUpdated { old_config, new_config }",
    ),
    (
        "setdest",
        "FeeDestinationUpdated { old_destination, new_destination, ledger }",
    ),
    ("ttlext", "()"),
    (
        "txfrterms",
        "TransferWithTermsEvent { id, previous_owner, new_owner, terms_hash, attestation_reset }",
    ),
];

/// Registry discovery metadata returned by [`VaultRegistry::registry_info`].
/// Lets a client discover the deployed registry's identity and shape with a
/// single read-only call instead of hardcoding assumptions.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RegistryInfo {
    /// Stable, human-readable registry name (`REGISTRY_NAME`).
    pub name: String,
    /// Contract crate version (`CARGO_PKG_VERSION` at build time).
    pub version: String,
    /// Version of the on-chain `Resource` schema (`RESOURCE_SCHEMA_VERSION`).
    pub resource_schema_version: u32,
    /// Network passphrase digest of the ledger this contract is running on
    /// (`env.ledger().network_id()`), so clients can confirm they are
    /// talking to the network they expect without a hardcoded config value.
    pub network_id: BytesN<32>,
}

/// Compact version struct returned by [`VaultRegistry::contract_version`].
///
/// Deployment scripts and upgrade tooling should call `contract_version`
/// before and after a redeploy to confirm which build is running on-chain.
/// Only `resource_schema_version` is relevant to whether callers must update
/// their `Resource` decoding logic; a `crate_version` bump alone is safe.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractVersion {
    /// Cargo semver string baked in at build time (`CARGO_PKG_VERSION`).
    pub crate_version: String,
    /// On-chain `Resource` schema version (`RESOURCE_SCHEMA_VERSION`).
    /// Bump this only when the `Resource` struct changes in a breaking way.
    pub resource_schema_version: u32,
}

/// On-chain mirror of the server's off-chain verification result. Settable
/// only by an address holding the verifier role (see `add_verifier`).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum VerificationStatus {
    Pending,
    Verified,
    Rejected,
}

/// The availability and moderation state of a resource.
///
/// `listed` remains on [`Resource`] as a backwards-compatible projection: it
/// is true exactly when this value is [`ResourceState::Listed`]. Clients that
/// need to distinguish a moderation hold from a creator delist must use this
/// field rather than the boolean projection.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ResourceState {
    Listed,
    Delisted,
    Frozen,
    Disputed,
    Tombstoned,
}

/// Reason code supplied when a moderator flags a resource for dispute.
///
/// The discriminants are stable — do not renumber existing variants.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum FlagReason {
    Spam = 0,
    Copyright = 1,
    Malicious = 2,
    Other = 3,
}

/// Wrapper for an optional [`FlagReason`] value, used as the `dispute_flag`
/// field of [`Resource`]. Soroban's `contracttype` macro requires that all
/// field types are `ScVal`-encodable; `Option<FlagReason>` is not directly
/// supported when `FlagReason` is a custom `contracttype` enum, so we use a
/// two-variant enum instead of native `Option`.
///
/// `NoFlag` encodes the absence of a dispute flag (analogous to `None`).
/// `Flagged(FlagReason)` encodes an active flag with a specific reason code.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DisputeFlag {
    NoFlag,
    Flagged(FlagReason),
}

impl DisputeFlag {
    /// Returns `true` when the resource is actively flagged.
    pub fn is_flagged(&self) -> bool {
        matches!(self, DisputeFlag::Flagged(_))
    }
}

/// Structured payload emitted by `flag_resource()`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlagEvent {
    pub id: String,
    pub moderator: Address,
    pub reason: FlagReason,
}

/// Structured payload emitted by `emergency_delist()`.
///
/// Modelled on [`FlagEvent`]: an `id` for the resource, the acting `admin`, and
/// the caller's justification. This is what makes an emergency delist
/// distinguishable from a creator delist at the event boundary — a creator
/// delist emits `setlisted` and nothing else, so an indexer that sees `emdelist`
/// knows an admin took the resource down and can attribute it.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EmergencyDelistEvent {
    pub id: String,
    pub admin: Address,
    pub reason: String,
}

/// A resource's moderation state in one read, returned by `flag_details`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlagDetails {
    /// Active dispute flag, or `DisputeFlag::NoFlag`.
    pub dispute_flag: DisputeFlag,
    /// Hash set via `set_flag_reason_hash`, if any.
    pub reason_hash: Option<String>,
    /// Moderator whose flag, unflag, or reason hash write came last, if any.
    pub last_moderator: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VerifierRotation {
    pub old_verifier: Address,
    pub new_verifier: Address,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Resource {
    pub id: String,
    pub creator: Address,
    /// Listed price in USDC base units ([`USDC_DECIMALS`] = 7).
    pub price: i128,
    pub metadata: String,
    /// Backwards-compatible projection of `state == ResourceState::Listed`.
    pub listed: bool,
    /// Explicit resource lifecycle state. See `contract/README.md` for the
    /// transition table and the role allowed to make each transition.
    pub state: ResourceState,
    /// Discovery labels (e.g. "dataset", "research"). Distinct from `metadata`,
    /// which remains the off-chain content anchor (IPFS URI, content hash, etc.).
    pub tags: Vec<String>,
    /// On-chain verification status, settable only by a verifier.
    pub verified: VerificationStatus,
    /// Once true, `update_metadata` permanently rejects further changes.
    pub frozen: bool,
    /// Ledger sequence when `freeze_metadata` was first called. `None` until
    /// the metadata pointer is frozen.
    pub metadata_frozen_at: Option<u32>,
    /// Ledger sequence number at which this resource was first registered.
    /// This value is immutable for the lifetime of the resource.
    pub created_at: u32,
    /// Ledger sequence number at which this resource was last written
    /// (register or any mutation). Clients can use this to detect staleness
    /// or order events without trusting off-chain timestamps.
    pub updated_at: u32,
    /// Active dispute flag set by a moderator, or `DisputeFlag::NoFlag` if the
    /// resource is not flagged. Flagging does not delist or delete the resource —
    /// it is informational state that callers can filter on. Only a moderator may
    /// set or clear this field (see `flag_resource` / `unflag_resource`).
    pub dispute_flag: DisputeFlag,
    /// On-chain `Resource` schema version for decoder compatibility.
    pub schema_version: u32,
    /// Monotonic write counter, incremented on every persisted mutation.
    /// Clients can use it as an optimistic-concurrency token without
    /// comparing every field.
    pub version: u32,
    /// Optional immutable digest of the resource's off-chain content, set
    /// once at registration via `register_with_hash`. `None` for resources
    /// registered through plain `register`.
    pub content_hash: Option<String>,
    /// Optional per-resource royalty recipient override. When set, royalties
    /// for this resource go to this address instead of the global fee_recipient.
    /// Only the resource creator may set this field via `set_royalty_recipient`.
    pub royalty_recipient: Option<Address>,
}

/// Input for a single resource in a batch registration.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BatchRegisterItem {
    pub id: String,
    pub price: i128,
    pub metadata: String,
    pub tags: Vec<String>,
    pub content_hash: Option<String>,
}

/// Input for one item in a batch price update.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BatchPriceUpdate {
    pub id: String,
    pub new_price: i128,
}

/// Result of a batch registration attempt. Contains successfully registered
/// resource IDs and any errors encountered (with their indices).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BatchRegisterResult {
    /// Resource IDs that were successfully registered (in order).
    pub succeeded: Vec<String>,
    /// Indices (into the input batch) of items that failed, paired with their error codes.
    pub failed: Vec<(u32, u32)>,
}

/// Structured payload emitted by `register()`.
///
/// Consumers can reconstruct a full `Resource` from this event without an
/// additional on-chain read.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RegisterEvent {
    pub id: String,
    pub creator: Address,
    pub price: i128,
    pub metadata: String,
    pub listed: bool,
    pub tags: Vec<String>,
    pub content_hash: Option<String>,
}

/// One page of the on-chain catalog plus a cursor for the next page.
///
/// `next_cursor` is the catalog index to pass back into `list` / `list_page`
/// as `start`/`cursor`. `None` means end-of-list — clients must not recompute
/// offsets themselves.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogPage {
    pub items: Vec<Resource>,
    pub next_cursor: Option<u32>,
}

/// Cursor passed to and returned by the id-indexed listings
/// (`list_by_creator_page`, `list_by_tag_page`). Pass `Start` for the first
/// page and each page's `next_cursor` for the following one; `End` back means
/// end-of-list (passing `End` in returns an empty page).
///
/// The backing index vectors can lose entries between pages (tombstone,
/// ownership transfer), so a plain position would skip or repeat entries when
/// the vector shifts. `After(position, last_id, created_at)` names the last
/// resource returned instead: its index in the vector when the page was
/// built, its id, and its registration ledger. Resuming looks the id up
/// again: at `position` on the fast path, anywhere in the vector if entries
/// before it were removed, and, if the id itself is gone, at the first entry
/// registered after it (`created_at`), falling back to its former slot.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum IdCursor {
    Start,
    After(u32, String, u32),
    End,
}

/// One page of an id-indexed listing plus the cursor for the next page.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct IdPage {
    pub items: Vec<Resource>,
    pub next_cursor: IdCursor,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TagPopularity {
    pub tag: String,
    pub count: u32,
}

/// A single entry in a verifier's status-change history, stored per verifier.
/// Written by `set_verification_status`; returned by `get_verifier_status_history`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VerifierStatusEntry {
    /// The resource whose verification status changed.
    pub resource_id: String,
    /// Previous status.
    pub old_status: VerificationStatus,
    /// New status applied.
    pub new_status: VerificationStatus,
    /// Attestation hash supplied with this status change, if any.
    pub attestation_hash: Option<String>,
    /// Ledger sequence at which this change was recorded.
    pub ledger: u32,
}

/// One page of verifier status history with a cursor for the next page.
/// Mirrors `CatalogPage` semantics: `next_cursor` is `None` at end-of-list.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VerifierStatusPage {
    pub items: Vec<VerifierStatusEntry>,
    pub next_cursor: Option<u32>,
}

/// Aggregated creator earnings returned by `creator_earnings_estimate`.
/// Carries both the address and the total in one read so callers do not need
/// to issue a separate `get_owner` query.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CreatorEarningsEstimate {
    /// The creator whose earnings are aggregated.
    pub creator: Address,
    /// Sum of all settled payment amounts (in USDC stroops) for resources
    /// owned by this creator at the time each payment was settled.
    pub total_settled: i128,
    /// Number of settled payment receipts included in `total_settled`.
    pub settled_count: u32,
}

/// Structured payload emitted by `transfer_ownership_with_terms` (event topic
/// `txfrterms`). Extends the basic `transfer` payload with terms-handoff
/// information so indexers have a full atomic record without extra reads.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TransferWithTermsEvent {
    pub id: String,
    pub previous_owner: Address,
    pub new_owner: Address,
    /// The new terms hash set on the incoming owner at the time of transfer.
    /// `None` when no `new_terms_hash` was supplied.
    pub terms_hash: Option<String>,
    /// Whether the attestation hash was cleared as part of this transfer.
    pub attestation_reset: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Resource(String),
    Count,
    Index(u32),
    Admin,
    PendingAdmin,
    CreatorTerms(Address),
    CreatorResources(Address),
    CreatorCount(Address),
    PendingTransfer(String),
    Verifier(Address),
    NetworkId,
    /// Canonical payment receipt, keyed by its caller-assigned `receipt_id`.
    PaymentReceipt(String),
    /// Secondary index mapping `(resource_id, payer)` to the `receipt_id` of
    /// the most recent payment recorded for that pair, so escrow/lease
    /// contracts can look up a settlement without scanning event history.
    PaymentIndex(String, Address),
    /// Secondary index mapping a settlement transaction hash to the
    /// `receipt_id` recorded for it, guaranteeing one payment receipt per
    /// Stellar tx (`DuplicateTxHash` on reuse).
    PaymentTxHash(String),
    /// Emergency pause flag. When `true`, every state-changing method
    /// returns `ContractPaused`.
    Paused,
    /// Unix timestamp at which a scheduled pause automatically expires.
    PauseUntil,
    /// Settler role grant, authorizing `record_payment` / `settle_payment`.
    Settler(Address),
    /// Immutable purchase receipt anchor for `(resource_id, buyer)`.
    PurchaseReceipt(String, Address),
    /// Durable anchor-failure record, readable by the buyer. Cleared by any
    /// successful anchor.
    AnchorFailure(String, Address),
    /// Secondary index mapping a normalized tag to ordered resource ids.
    TagIndex(String),
    /// Registry-level fee and royalty configuration.
    FeeConfig,
    Moderator(Address),
    DisputeFlag(String),
    /// Number of resources currently in the Listed state.
    ListedCount,
    /// Hash of a moderator's off-chain dispute reason writeup for a resource,
    /// set via `set_flag_reason_hash`. Independent of `FlagReason` (a fixed
    /// enum code): this carries a digest of free-form detail a moderator
    /// recorded off-chain, analogous to `CreatorTerms`.
    FlagReasonHash(String),
    /// Hash of a verifier's off-chain attestation document, provided during a
    /// status change via `set_verification_status`.
    AttestationHash(String),
    /// Ledger sequence at which the pending admin nomination expires.
    PendingAdminExpiry,
    /// Ledger sequence at which the pending admin nomination was created.
    /// Used to enforce `ADMIN_NOMINATION_MIN_GAP` in `accept_admin` so that
    /// nominate and accept cannot be batched into a single transaction.
    PendingAdminNominatedAt,
    TagCount(String),
    TopTags,
    /// Number of `creator`'s resources currently in the `Listed` state. Kept
    /// in step with `ListedCount` on every listed-state transition and moved
    /// between owners on transfer, so it is the per-creator view of
    /// `listed_count` in the same way `CreatorCount` is of `count`.
    CreatorListedCount(Address),
    /// Optional 32-byte memo hash recorded at registration through
    /// `register_with_memo`, for example the `MEMO_HASH` of the transaction
    /// that announced or paid for the registration. Written once and never
    /// mutated; `None` for resources registered through the other entry points.
    MemoHash(String),
    FeeDestination,
    /// Redundant metadata pointers set via `set_metadata_pointers`. The
    /// entry at `primary` always mirrors `Resource.metadata`.
    MetadataPointers(String),
    /// Optional recovery admin set via `bootstrap_dual_admin` or
    /// `set_recovery_admin`; may call `recover_admin` if the admin key is lost.
    RecoveryAdmin,
}

/// Payload of every role grant/revoke event (`addverif`/`rmverif`,
/// `addsettlr`/`rmsettlr`, `addmod`/`rmmod`). Carries the admin that
/// authorized the change and the affected address so the event log alone
/// is a complete audit trail of role changes.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RoleChange {
    pub admin: Address,
    pub target: Address,
    /// `true` for a grant, `false` for a revocation.
    pub granted: bool,
}

/// Redundant metadata pointers for a resource, so its content survives a
/// single storage outage. `pointers[primary]` is the preferred pointer and is
/// always equal to `Resource.metadata`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MetadataPointers {
    pub pointers: Vec<String>,
    pub primary: u32,
    /// Moderator who last called `flag_resource`, `unflag_resource`, or
    /// `set_flag_reason_hash` for a resource. Read back by `flag_details`.
    FlagModerator(String),
    /// Aggregated settled-payment earnings for a creator wallet address.
    /// Written by `settle_payment` and read by `creator_earnings_estimate`.
    /// Value type: `(i128, u32)` tuple — (total USDC stroops of all settled
    /// receipts for resources owned by this creator at settlement time, count).
    CreatorEarnings(Address),
    /// Ordered history of verification status changes for a verifier address.
    /// Written by `set_verification_status`; read by `get_verifier_status_history`.
    /// Value type: `Vec<VerifierStatusEntry>`.
    VerifierHistory(Address),
}

/// Event data emitted when a resource's metadata pointer is updated.
/// Carries the resource id, the previous metadata pointer, and the new one
/// so that off-chain indexers can build a full audit trail without querying
/// historical ledger state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MetadataUpdateEvent {
    pub id: String,
    pub old_metadata: String,
    pub new_metadata: String,
}

/// Structured payload published with the `setprice` event.
/// Includes the resource id, the price before and after the update, and the
/// address that authorised the change — enabling indexers to reconcile price
/// history without re-reading contract storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceUpdated {
    pub id: String,
    pub old_price: i128,
    pub new_price: i128,
    pub updater: Address,
}

/// Registry-level fee and royalty configuration.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeConfig {
    pub platform_fee_bps: u32,
    pub royalty_bps: u32,
    pub fee_recipient: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OptFeeConfig {
    None,
    Some(FeeConfig),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeConfigUpdated {
    pub old_config: OptFeeConfig,
    pub new_config: FeeConfig,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum FeeDestination {
    None,
    Burn,
    Charity(Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeDestinationConfig {
    pub bps: u32,
    pub destination: FeeDestination,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FeeDestinationUpdated {
    pub old_destination: FeeDestinationConfig,
    pub new_destination: FeeDestinationConfig,
    pub ledger: u32,
}

/// On-chain record of a single x402/Soroban payment settlement for a resource.
///
/// The allowed transition is `Escrowed → Settled`. A receipt starts in
/// `Escrowed` when first recorded and moves to `Settled` once
/// `settle_payment` is called by a settler. Reverting to `Escrowed` or
/// creating a receipt directly in `Settled` state are not permitted
/// (`InvalidPaymentTransition`).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum PaymentState {
    /// Payment has been authorised by the payer and is held pending final
    /// on-chain settlement. The x402 facilitator records receipts in this
    /// state; `settle_payment` advances them to `Settled`.
    Escrowed,
    /// Payment has been settled on-chain. The USDC transfer has been
    /// confirmed and the creator's balance has been credited.
    Settled,
}

/// A payment receipt anchoring an x402/Soroban settlement to a specific
/// vault resource and payer. Written by an address holding the settler role.
///
/// `receipt_id` is a caller-chosen unique identifier (max 64 bytes) —
/// typically the x402 facilitator's own receipt or transaction ID.
/// `tx_hash` is the Stellar transaction hash of the USDC transfer (max 128
/// bytes), present from creation so indexers can verify settlement on-chain
/// without a second round-trip.
///
/// Fields are intentionally read-only after recording. To update state,
/// call `settle_payment` which transitions `Escrowed → Settled` and
/// re-emits the receipt as a `settle` event.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentReceipt {
    /// Caller-assigned unique receipt identifier (max 64 bytes).
    pub receipt_id: String,
    /// The resource this payment is for.
    pub resource_id: String,
    /// Stellar address of the party that made the payment.
    pub payer: Address,
    /// Payment amount in USDC base units, the same unit as
    /// [`Resource::price`]; `record_payment` requires exact equality. `> 0`.
    pub amount: i128,
    /// Current lifecycle state of this receipt.
    pub state: PaymentState,
    /// Stellar transaction hash of the USDC transfer (non-empty, max 128 bytes).
    pub tx_hash: String,
    /// Ledger sequence number at which this receipt was first recorded.
    pub recorded_at: u32,
    /// Compatibility alias for `recorded_at`.
    pub ledger: u32,
}

/// On-chain record of a completed refund transfer associated with a payment.
/// The registry records and caps refunds but does not custody or transfer USDC.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RefundReceipt {
    pub refund_id: String,
    pub payment_receipt_id: String,
    pub resource_id: String,
    pub recipient: Address,
    pub amount: i128,
    pub tx_hash: String,
    pub initiated_by: Address,
    pub recorded_at: u32,
    pub admin_override: bool,
}

/// Immutable on-chain anchor for a purchase receipt hash.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PurchaseReceiptAnchor {
    pub resource_id: String,
    pub buyer: Address,
    pub receipt_hash: String,
    pub ledger: u32,
}

/// Why an anchor attempt could not write an anchor.
///
/// Discriminants are stable — do not renumber existing variants. The first
/// three map 1:1 to the `Error` `anchor_purchase_receipt` returns; the last
/// three are reachable only via the settler entry points.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum AnchorFailureReason {
    /// No resource is registered under `resource_id` (`Error::NotFound`).
    ResourceNotFound = 0,
    /// `receipt_hash` is empty or exceeds `MAX_TX_HASH_LEN`
    /// (`Error::InvalidTxHash`).
    InvalidReceiptHash = 1,
    /// An anchor already exists for `(resource_id, buyer)`
    /// (`Error::DuplicateReceipt`).
    DuplicateReceipt = 2,
    /// The pair was retried fewer than `ANCHOR_RETRY_BACKOFF_LEDGERS` ledgers
    /// after its last rejected attempt. Reported without re-running the data
    /// checks and without writing storage; only `attempt_anchor_purchase_receipt`
    /// produces it.
    RetryTooSoon = 3,
    /// The pair has already been rejected `MAX_ANCHOR_ATTEMPTS` times. Reported
    /// without re-running the data checks and without writing storage; only
    /// `attempt_anchor_purchase_receipt` produces it.
    AttemptsExhausted = 4,
}

impl AnchorFailureReason {
    /// The error `anchor_purchase_receipt` returns for this reason. The two
    /// throttling reasons never arise on the reverting path (it keeps no
    /// attempt history); they map to `InvalidPaymentTransition` so the
    /// mapping stays total.
    pub fn as_error(self) -> Error {
        match self {
            AnchorFailureReason::ResourceNotFound => Error::NotFound,
            AnchorFailureReason::InvalidReceiptHash => Error::InvalidTxHash,
            AnchorFailureReason::DuplicateReceipt => Error::DuplicateReceipt,
            AnchorFailureReason::RetryTooSoon | AnchorFailureReason::AttemptsExhausted => {
                Error::InvalidPaymentTransition
            }
        }
    }
}

/// Payload of the `anchrfail` event, also stored durably by
/// [`record_anchor_failure`]. Carries the caller's inputs plus the reason and
/// ledger, so a buyer can reconstruct the attempt from [`get_anchor_failure`].
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AnchorFailure {
    pub resource_id: String,
    pub buyer: Address,
    pub receipt_hash: String,
    pub reason: AnchorFailureReason,
    pub ledger: u32,
}

/// Rejected-attempt bookkeeping for one `(resource_id, buyer)` anchor pair.
/// Read back by `get_anchor_attempts`; both fields are `0` for a pair that
/// has never been rejected or whose anchor has since been written.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AnchorAttempts {
    /// Rejected attempts so far (never more than `MAX_ANCHOR_ATTEMPTS`).
    pub attempts: u32,
    /// Ledger sequence of the most recent rejected attempt.
    pub last_attempt_ledger: u32,
}

/// Duration tier of a time-limited access lease. Each tier maps to a fixed
/// number of ledgers (`lease_tier_ledgers`) and a price multiplier over the
/// resource's per-request price (`lease_price`).
///
/// The discriminants are stable — do not renumber existing variants.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum LeaseTier {
    Hour = 0,
    Day = 1,
    Week = 2,
}

/// Lifecycle state of an access lease.
///
/// `Pending` is a holder-recorded lease awaiting settlement confirmation;
/// `Active` grants access until `expiry_ledger`; `Revoked` is terminal.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum LeaseState {
    Pending,
    Active,
    Revoked,
}

/// Time-limited access lease: `holder` may access `resource_id` while the
/// lease is `Active` and the current ledger is below `expiry_ledger`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Lease {
    pub resource_id: String,
    pub holder: Address,
    pub tier: LeaseTier,
    /// Ledger sequence at which the window opened (the recording ledger).
    pub start_ledger: u32,
    /// First ledger at which the lease no longer grants access.
    pub expiry_ledger: u32,
    /// Amount paid in USDC stroops; equals `lease_price` at recording time.
    pub amount: i128,
    /// Stellar transaction hash of the USDC transfer (non-empty, max 128 bytes).
    pub tx_hash: String,
    pub state: LeaseState,
    /// Ledger sequence at which the lease was recorded.
    pub recorded_at: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyRegistered = 1,
    NotFound = 2,
    /// A price is `<= 0`, exceeds `MAX_PRICE`, or is not strictly greater than
    /// the combined active `platform_fee_bps + royalty_bps`
    /// (creator-share invariant — see `validate_price`).
    InvalidPrice = 3,
    MetadataTooLong = 4,
    InvalidTag = 5,
    Unauthorized = 6,
    PendingAdminNotSet = 7,
    PendingAdminAlreadySet = 8,
    SameAdmin = 9,
    TermsHashTooLong = 10,
    InvalidResourceId = 11,
    InvalidMetadataPointer = 12,
    EmptyMetadata = 13,
    AlreadyOwner = 14,
    NoPendingTransfer = 15,
    ReservedId = 16,
    PriceExceedsMax = 17,
    AdminNotSet = 18,
    NotVerifier = 19,
    InvalidVerificationTransition = 20,
    AlreadyFrozen = 21,
    MetadataFrozen = 22,
    DuplicateInRepair = 23,
    /// A payment or refund `tx_hash` is empty or exceeds `MAX_TX_HASH_LEN` (128 bytes).
    InvalidTxHash = 24,
    /// A payment/refund `amount` is `<= 0`, or a refund window is invalid.
    InvalidPaymentAmount = 25,
    NotModerator = 26,
    AlreadyFlagged = 27,
    NotFlagged = 28,
    InvalidLifecycleTransition = 29,
    ResourceNotMutable = 30,
    NetworkAlreadyInitialized = 31,
    NetworkIdMismatch = 32,
    NetworkNotInitialized = 33,
    /// A fee or fee-destination basis-point value exceeds its configured ceiling.
    FeeBpsTooHigh = 34,
    /// The combined fee policy or fee-destination split is invalid.
    TotalFeeTooHigh = 35,
    /// The global resource count would overflow `u32`.
    CountOverflow = 36,
    /// A batch read exceeded the maximum supported number of IDs.
    BatchTooLarge = 37,
    /// A purchase receipt already exists for `(resource_id, buyer)`.
    DuplicateReceipt = 38,
    /// `reason_hash` supplied to `set_flag_reason_hash` exceeds
    /// `MAX_FLAG_REASON_HASH_LEN` (64 bytes).
    FlagReasonHashTooLong = 39,
    /// A state-changing method was called while the registry is paused.
    ContractPaused = 40,
    /// Caller does not hold the settler role.
    NotSettler = 41,
    /// A payment receipt already exists for the supplied `receipt_id`.
    ReceiptAlreadyExists = 42,
    /// The requested payment receipt state transition is not allowed.
    InvalidPaymentTransition = 43,
    /// `receipt_id` is empty or exceeds `MAX_RECEIPT_ID_LEN` (64 bytes).
    InvalidReceiptId = 44,
    /// `content_hash` exceeds `MAX_CONTENT_HASH_LEN` (128 bytes).
    ContentHashTooLong = 45,
    /// `attestation_hash` exceeds `MAX_ATTESTATION_HASH_LEN` (64 bytes).
    AttestationHashTooLong = 46,
    /// Payment receipt amount does not match the resource's current price.
    PaymentAmountMismatch = 47,
    /// A payment receipt is already stored for the supplied settlement
    /// transaction hash (`tx_hash`); a single Stellar tx must map to one receipt.
    DuplicateTxHash = 48,
    /// `set_fee_recipient` or `set_fee_destination` was called before any fee config was set via `set_fee_config`.
    FeeConfigNotSet = 49,
    /// The pending admin nomination is missing, has expired, or was called too
    /// soon after `nominate_new_admin` (before `ADMIN_NOMINATION_MIN_GAP`
    /// ledgers have elapsed).
    AdminNominationExpired = 50,
    /// `set_metadata_pointers` received zero, more than `MAX_METADATA_POINTERS`,
    /// or duplicate pointers, or a `primary` index out of range.
    InvalidMetadataPointers = 51,
    /// `bootstrap_dual_admin` was called after an admin was already set.
    AdminAlreadySet = 52,
    /// `recover_admin` was called but no recovery admin is configured.
    RecoveryAdminNotSet = 53,
}

#[contract]
pub struct VaultRegistry;

#[contractimpl]
impl VaultRegistry {
    /// Register a new resource. Price is in USDC base units (7 decimals).
    /// Rejects `price <= 0` (`InvalidPrice`) or `price > MAX_PRICE` (`PriceExceedsMax`).
    /// Requires the creator's authorization.
    ///
    /// Equivalent to `register_with_hash` with `content_hash = None`.
    pub fn register(
        env: Env,
        creator: Address,
        id: String,
        price: i128,
        metadata: String,
        tags: Vec<String>,
    ) -> Result<(), Error> {
        creator.require_auth();
        Self::register_internal(env, creator, id, price, metadata, tags, None, None)
    }

    /// Register a new resource together with an immutable digest of its
    /// off-chain content. Supplying a hash binds the metadata pointer to this
    /// registration: `update_metadata` cannot change it afterward. Passing
    /// `None` preserves the mutable metadata behavior of `register`.
    ///
    /// Rejects an empty hash or one longer than `MAX_CONTENT_HASH_LEN`
    /// (`ContentHashTooLong`). All other validation matches `register`.
    pub fn register_with_hash(
        env: Env,
        creator: Address,
        id: String,
        price: i128,
        metadata: String,
        tags: Vec<String>,
        content_hash: Option<String>,
    ) -> Result<(), Error> {
        creator.require_auth();
        Self::register_internal(env, creator, id, price, metadata, tags, content_hash, None)
    }

    /// Register a new resource together with an optional content hash and an
    /// optional 32-byte memo hash. The memo hash is the registration's link to
    /// an off-chain record (typically the `MEMO_HASH` of the Stellar
    /// transaction that announced or paid for it) and is written once at
    /// registration; nothing can change it afterwards. Read it back with
    /// `get_memo_hash`. When present it is also emitted in a `regmemo` event.
    ///
    /// All other validation matches `register_with_hash`.
    #[allow(clippy::too_many_arguments)]
    pub fn register_with_memo(
        env: Env,
        creator: Address,
        id: String,
        price: i128,
        metadata: String,
        tags: Vec<String>,
        content_hash: Option<String>,
        memo_hash: Option<BytesN<32>>,
    ) -> Result<(), Error> {
        creator.require_auth();
        Self::register_internal(
            env,
            creator,
            id,
            price,
            metadata,
            tags,
            content_hash,
            memo_hash,
        )
    }

    /// Register multiple resources in a single transaction. The batch is capped
    /// at [`MAX_BATCH_REGISTER`] (10) to bound execution cost. All resources
    /// are registered under the same `creator`.
    ///
    /// Returns a [`BatchRegisterResult`] containing:
    /// - `succeeded`: IDs of successfully registered resources
    /// - `failed`: Indices and error codes of failed registrations
    ///
    /// This function continues processing after individual failures, allowing
    /// partial success. The creator is authorized once at the start, and each
    /// resource is validated independently. Common failure causes include
    /// duplicate IDs, invalid prices, or invalid metadata pointers.
    ///
    /// Use case: Bulk onboarding of resources by publishers or automated systems.
    pub fn register_batch(
        env: Env,
        creator: Address,
        items: Vec<BatchRegisterItem>,
    ) -> Result<BatchRegisterResult, Error> {
        creator.require_auth();
        Self::require_not_paused(&env)?;

        if items.len() > MAX_BATCH_REGISTER {
            return Err(Error::BatchTooLarge);
        }

        let mut succeeded: Vec<String> = Vec::new(&env);
        let mut failed: Vec<(u32, u32)> = Vec::new(&env);

        for i in 0..items.len() {
            let item = items.get(i).unwrap();

            // Attempt to register this resource
            let result = Self::register_internal(
                env.clone(),
                creator.clone(),
                item.id.clone(),
                item.price,
                item.metadata.clone(),
                item.tags.clone(),
                item.content_hash.clone(),
                None,
            );

            match result {
                Ok(()) => {
                    succeeded.push_back(item.id.clone());
                }
                Err(e) => {
                    // System-level errors that indicate a contract-wide
                    // invariant violation must abort the entire batch, not be
                    // silently recorded as a per-item failure.  These errors
                    // can never be legitimately per-item:
                    //
                    // - ContractPaused: the registry was paused between the
                    //   batch-level `require_not_paused` guard and this
                    //   iteration (impossible in a single transaction, but the
                    //   contract must stay correct if that ever changes).
                    //   Treating it as a per-item failure diverges from the
                    //   single-register path, which always aborts on pause.
                    //
                    // - CountOverflow: the global resource counter saturated
                    //   u32::MAX.  Continuing after this would write indexes
                    //   without updating the counter, corrupting registry state.
                    if matches!(e, Error::ContractPaused | Error::CountOverflow) {
                        return Err(e);
                    }
                    // All other errors are per-resource validation failures
                    // (e.g. duplicate id, invalid price, invalid metadata) and
                    // should be recorded so the batch can partially succeed.
                    failed.push_back((i, e as u32));
                }
            }
        }

        Ok(BatchRegisterResult { succeeded, failed })
    }

    /// Update a resource's price. Rejects `new_price <= 0` or `new_price > MAX_PRICE`.
    /// Only the creator may call this.
    ///
    /// Emits a `setprice` event whose data is a [`PriceUpdated`] value
    /// containing `id`, `old_price`, `new_price`, and `updater`.
    ///
    /// No-op guard: if `new_price` is identical to the resource's current
    /// price, the call succeeds without touching storage or emitting a
    /// `setprice` event.
    pub fn set_price(env: Env, id: String, new_price: i128) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        Self::validate_price(&env, new_price)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;

        if resource.price == new_price {
            return Ok(());
        }

        let old_price = resource.price;
        let updater = resource.creator.clone();
        resource.price = new_price;
        Self::save(&env, &mut resource);
        env.events().publish(
            (symbol_short!("setprice"),),
            PriceUpdated {
                id,
                old_price,
                new_price,
                updater,
            },
        );
        Ok(())
    }

    /// Update prices for multiple resources owned by `creator` in one call.
    /// The creator authorizes the invocation once, and every item is
    /// validated before any price is written. If one item is invalid, no
    /// prices are changed. Duplicate IDs use the last supplied price.
    ///
    /// The batch is capped at [`MAX_BATCH_PRICE_UPDATES`] items. A no-op price
    /// update succeeds without writing storage or emitting `setprice`.
    pub fn set_price_many(
        env: Env,
        creator: Address,
        updates: Vec<BatchPriceUpdate>,
    ) -> Result<(), Error> {
        creator.require_auth();
        Self::require_not_paused(&env)?;
        if updates.len() > MAX_BATCH_PRICE_UPDATES {
            return Err(Error::BatchTooLarge);
        }

        let mut pending: alloc::vec::Vec<(String, Resource, i128)> = alloc::vec::Vec::new();
        for i in 0..updates.len() {
            let item = updates.get(i).unwrap();
            Self::validate_resource_id(&item.id)?;
            Self::validate_price(&env, item.new_price)?;
            let resource = Self::load(&env, &item.id)?;
            if resource.creator != creator {
                return Err(Error::Unauthorized);
            }
            Self::ensure_mutable(&resource)?;

            if let Some(existing) = pending.iter_mut().find(|entry| entry.0 == item.id) {
                existing.2 = item.new_price;
            } else {
                pending.push((item.id, resource, item.new_price));
            }
        }

        for (id, mut resource, new_price) in pending {
            if resource.price == new_price {
                continue;
            }

            let old_price = resource.price;
            let updater = resource.creator.clone();
            resource.price = new_price;
            Self::save(&env, &mut resource);
            env.events().publish(
                (symbol_short!("setprice"),),
                PriceUpdated {
                    id,
                    old_price,
                    new_price,
                    updater,
                },
            );
        }

        Ok(())
    }

    /// Update a resource's metadata pointer. Only the creator may call this.
    ///
    /// Emits a [`MetadataUpdateEvent`] containing the resource id, the previous
    /// metadata pointer (`old_metadata`), and the new one (`new_metadata`).
    /// Off-chain indexers can use these fields to build an audit trail without
    /// querying historical ledger state.
    ///
    /// No-op guard: if `metadata` is identical to the resource's current
    /// metadata pointer, the call succeeds without touching storage or
    /// emitting an `updmeta` event. A resource registered with a content hash
    /// rejects any divergent pointer with `MetadataFrozen`.
    pub fn update_metadata(env: Env, id: String, metadata: String) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;
        if resource.frozen {
            return Err(Error::MetadataFrozen);
        }
        if resource.metadata == metadata {
            return Ok(());
        }

        if resource.content_hash.is_some() {
            return Err(Error::MetadataFrozen);
        }

        Self::validate_metadata_pointer(&metadata)?;

        let old_metadata = resource.metadata.clone();
        resource.metadata = metadata.clone();
        Self::save(&env, &mut resource);
        // A new primary pointer invalidates any previously published mirrors.
        env.storage()
            .persistent()
            .remove(&DataKey::MetadataPointers(id.clone()));
        env.events().publish(
            (symbol_short!("updmeta"), id.clone()),
            MetadataUpdateEvent {
                id,
                old_metadata,
                new_metadata: metadata,
            },
        );
        Ok(())
    }

    /// Permanently freeze a resource's metadata pointer. Only the creator may
    /// call this. Irreversible — errors `AlreadyFrozen` if called twice.
    /// Price, listing, tags, and ownership remain mutable after freezing.
    pub fn freeze_metadata(env: Env, id: String) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;
        if resource.frozen {
            return Err(Error::AlreadyFrozen);
        }
        resource.frozen = true;
        resource.metadata_frozen_at = Some(env.ledger().sequence());
        Self::save(&env, &mut resource);
        env.events().publish((symbol_short!("freeze"), id), ());
        Ok(())
    }

    /// Set up to `MAX_METADATA_POINTERS` redundant metadata pointers (e.g.
    /// IPFS + Arweave + hosted) with `pointers[primary]` as the preferred one,
    /// so the resource survives a single storage outage. Only the creator may
    /// call this. Every pointer is validated like `update_metadata`, and
    /// `Resource.metadata` is set to the primary pointer so single-pointer
    /// readers keep working. Subject to the same freeze / content-hash rules
    /// as `update_metadata`: a frozen resource may only re-publish mirrors
    /// whose primary equals its current pointer. Emits `setptrs`.
    pub fn set_metadata_pointers(
        env: Env,
        id: String,
        pointers: Vec<String>,
        primary: u32,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;

        if pointers.is_empty() || pointers.len() > MAX_METADATA_POINTERS || primary >= pointers.len()
        {
            return Err(Error::InvalidMetadataPointers);
        }
        for i in 0..pointers.len() {
            let pointer = pointers.get_unchecked(i);
            Self::validate_metadata_pointer(&pointer)?;
            for j in (i + 1)..pointers.len() {
                if pointers.get_unchecked(j) == pointer {
                    return Err(Error::InvalidMetadataPointers);
                }
            }
        }

        let primary_pointer = pointers.get_unchecked(primary);
        if primary_pointer != resource.metadata {
            if resource.frozen || resource.content_hash.is_some() {
                return Err(Error::MetadataFrozen);
            }
            let old_metadata = resource.metadata.clone();
            resource.metadata = primary_pointer.clone();
            Self::save(&env, &mut resource);
            env.events().publish(
                (symbol_short!("updmeta"), id.clone()),
                MetadataUpdateEvent {
                    id: id.clone(),
                    old_metadata,
                    new_metadata: primary_pointer,
                },
            );
        }

        let record = MetadataPointers { pointers, primary };
        let key = DataKey::MetadataPointers(id.clone());
        env.storage().persistent().set(&key, &record);
        Self::bump_persistent(&env, &key);
        env.events()
            .publish((symbol_short!("setptrs"), id), record);
        Ok(())
    }

    /// All metadata pointers for a resource. Falls back to a single-entry list
    /// holding `Resource.metadata` (primary `0`) when no mirrors were set.
    pub fn get_metadata_pointers(env: Env, id: String) -> Result<MetadataPointers, Error> {
        Self::validate_resource_id(&id)?;
        let resource = Self::load(&env, &id)?;
        let key = DataKey::MetadataPointers(id);
        if let Some(record) = env
            .storage()
            .persistent()
            .get::<DataKey, MetadataPointers>(&key)
        {
            Self::bump_persistent(&env, &key);
            return Ok(record);
        }
        Ok(MetadataPointers {
            pointers: Vec::from_array(&env, [resource.metadata]),
            primary: 0,
        })
    }

    /// Update a resource's on-chain verification status. Only an address
    /// currently holding the verifier role (see `add_verifier`) may call
    /// this. Only `Pending -> Verified`, `Pending -> Rejected`,
    /// `Verified -> Rejected`, and `Rejected -> Verified` are allowed;
    /// self-transitions and reverting to `Pending` error with
    /// `InvalidVerificationTransition`.
    pub fn set_verification_status(
        env: Env,
        id: String,
        verifier: Address,
        status: VerificationStatus,
        attestation_hash: Option<String>,
    ) -> Result<(), Error> {
        verifier.require_auth();
        Self::require_not_paused(&env)?;
        if !Self::is_verifier(env.clone(), verifier.clone()) {
            return Err(Error::NotVerifier);
        }

        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        let old_status = resource.verified;
        let allowed = matches!(
            (old_status, status),
            (VerificationStatus::Pending, VerificationStatus::Verified)
                | (VerificationStatus::Pending, VerificationStatus::Rejected)
                | (VerificationStatus::Verified, VerificationStatus::Rejected)
                | (VerificationStatus::Rejected, VerificationStatus::Verified)
        );
        if !allowed {
            return Err(Error::InvalidVerificationTransition);
        }

        let hash_key = DataKey::AttestationHash(id.clone());
        let stored_attestation_hash = match attestation_hash {
            Some(hash) => Some(Self::normalize_attestation_hash(&env, &hash)?),
            None => None,
        };
        if let Some(hash) = stored_attestation_hash.clone() {
            env.storage().persistent().set(&hash_key, &hash);
            Self::bump_persistent(&env, &hash_key);
        } else {
            env.storage().persistent().remove(&hash_key);
        }

        resource.verified = status;
        Self::save(&env, &mut resource);

        // Append to the verifier's status-change history for paginated reads.
        let hist_key = DataKey::VerifierHistory(verifier.clone());
        let mut history: Vec<VerifierStatusEntry> = env
            .storage()
            .persistent()
            .get(&hist_key)
            .unwrap_or_else(|| Vec::new(&env));
        history.push_back(VerifierStatusEntry {
            resource_id: id.clone(),
            old_status,
            new_status: status,
            attestation_hash: stored_attestation_hash.clone(),
            ledger: env.ledger().sequence(),
        });
        env.storage().persistent().set(&hist_key, &history);
        Self::bump_persistent(&env, &hist_key);

        env.events().publish(
            (symbol_short!("verify"), id),
            (old_status, status, stored_attestation_hash),
        );
        Ok(())
    }

    /// Read the off-chain attestation hash for a resource, if one has been recorded
    /// via `set_verification_status`.
    pub fn get_attestation_hash(env: Env, id: String) -> Option<String> {
        Self::validate_resource_id(&id).ok()?;
        let key = DataKey::AttestationHash(id);
        let hash: Option<String> = env.storage().persistent().get(&key);
        if hash.is_some() {
            Self::bump_persistent(&env, &key);
        }
        hash
    }

    /// Pure function: recompute the attestation hash a verifier is expected to
    /// submit for `(id, status, document_hash)`, so off-chain clients can
    /// check integrity without trusting a wallet provider. Returns
    /// `sha256:<64 lowercase hex>` over the preimage
    /// `ATTESTATION_HASH_DOMAIN || u32_be(len(id)) || id || u32_be(status) || document_hash`.
    /// Reads no storage and requires no auth.
    pub fn compute_attestation_hash(
        env: Env,
        id: String,
        status: VerificationStatus,
        document_hash: BytesN<32>,
    ) -> String {
        let id_bytes = Self::string_bytes(&id);
        let mut preimage = Bytes::from_slice(&env, ATTESTATION_HASH_DOMAIN.as_bytes());
        preimage.extend_from_array(&(id_bytes.len() as u32).to_be_bytes());
        preimage.extend_from_slice(&id_bytes);
        preimage.extend_from_array(&(status as u32).to_be_bytes());
        preimage.append(&document_hash.into());
        let digest = env.crypto().sha256(&preimage).to_array();

        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = alloc::vec::Vec::with_capacity(DEFAULT_ATTESTATION_HASH_ALGORITHM.len() + 1 + 64);
        out.extend_from_slice(DEFAULT_ATTESTATION_HASH_ALGORITHM.as_bytes());
        out.push(b':');
        for byte in digest {
            out.push(HEX[(byte >> 4) as usize]);
            out.push(HEX[(byte & 0x0f) as usize]);
        }
        String::from_bytes(&env, &out)
    }

    /// Whether the resource is currently in `status` and its stored
    /// attestation hash equals `compute_attestation_hash(id, status, document_hash)`.
    pub fn verify_attestation_hash(
        env: Env,
        id: String,
        status: VerificationStatus,
        document_hash: BytesN<32>,
    ) -> bool {
        let Ok(resource) = Self::validate_resource_id(&id).and_then(|_| Self::load(&env, &id)) else {
            return false;
        };
        if resource.verified != status {
            return false;
        }
        match Self::get_attestation_hash(env.clone(), id.clone()) {
            Some(stored) => stored == Self::compute_attestation_hash(env, id, status, document_hash),
            None => false,
        }
    }

    /// Read the memo hash recorded for a resource at registration, if it was
    /// registered through `register_with_memo` with one. `None` for every
    /// other resource and for ids that are unknown or malformed.
    pub fn get_memo_hash(env: Env, id: String) -> Option<BytesN<32>> {
        Self::validate_resource_id(&id).ok()?;
        let key = DataKey::MemoHash(id);
        let hash: Option<BytesN<32>> = env.storage().persistent().get(&key);
        if hash.is_some() {
            Self::bump_persistent(&env, &key);
        }
        hash
    }

    /// Replace a resource's discovery tags. Only the creator may call this.
    /// Does not modify `metadata` (the off-chain content pointer).
    /// Tags are normalized to lowercase ASCII before storage; the normalized
    /// form is what gets indexed and returned from `list_by_tag`.
    ///
    /// No-op guard: if the normalized `tags` are identical to the resource's
    /// current tags (same values, same order), the call succeeds without
    /// touching storage or emitting a `settags` event.
    pub fn set_tags(env: Env, id: String, tags: Vec<String>) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let norm_tags = Self::normalize_and_validate_tags(&env, &tags)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;

        if resource.tags == norm_tags {
            return Ok(());
        }

        // Capture previous tags before replacement for event emission and index
        let prev_tags = resource.tags.clone();

        Self::tag_index_remove(&env, &prev_tags, &id);
        Self::tag_index_add(&env, &norm_tags, &id);

        resource.tags = norm_tags.clone();
        Self::save(&env, &mut resource);

        // Keep the derived tag index in sync: drop the id from every tag it
        // no longer carries, then add it to the new set (adds are idempotent).
        Self::tag_index_remove(&env, &prev_tags, &id);
        Self::tag_index_add(&env, &norm_tags, &id);

        // Emit event with both previous and next tags for indexer reconciliation
        env.events()
            .publish((symbol_short!("settags"), id), (prev_tags, norm_tags));
        Ok(())
    }

    /// Set a per-resource royalty recipient override. Only the creator may call
    /// this. When set, royalties for this resource will go to this address instead
    /// of the global `fee_recipient` from `FeeConfig`. Set to `None` to clear the
    /// override and use the global recipient.
    ///
    /// Emits a `setroyal` event with the old and new recipient addresses.
    pub fn set_royalty_recipient(
        env: Env,
        id: String,
        recipient: Option<Address>,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;

        let old_recipient = resource.royalty_recipient.clone();
        resource.royalty_recipient = recipient.clone();
        Self::save(&env, &mut resource);

        env.events()
            .publish((symbol_short!("setroyal"), id), (old_recipient, recipient));
        Ok(())
    }

    pub fn transfer_ownership(env: Env, id: String, new_creator: Address) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;
        if resource.creator == new_creator {
            return Err(Error::AlreadyOwner);
        }
        let previous_owner = resource.creator.clone();
        resource.creator = new_creator.clone();
        Self::save(&env, &mut resource);
        Self::move_creator_index(&env, &previous_owner, &new_creator, &id, resource.listed);

        let pending_key = DataKey::PendingTransfer(id.clone());
        if env.storage().persistent().has(&pending_key) {
            env.storage().persistent().remove(&pending_key);
        }

        env.events().publish(
            (symbol_short!("transfer"), id),
            (previous_owner, new_creator),
        );
        Ok(())
    }

    /// Propose a transfer to a new owner. The new owner must accept it.
    pub fn propose_transfer(env: Env, id: String, new_creator: Address) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        let resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;
        if resource.creator == new_creator {
            return Err(Error::AlreadyOwner);
        }
        let key = DataKey::PendingTransfer(id.clone());
        env.storage().persistent().set(&key, &new_creator);
        Self::bump_persistent(&env, &key);
        env.events().publish(
            (symbol_short!("propose"), id),
            (resource.creator, new_creator),
        );
        Ok(())
    }

    /// Accept a proposed transfer. Only the pending owner can call this.
    pub fn accept_transfer(env: Env, id: String) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        let key = DataKey::PendingTransfer(id.clone());
        let pending_owner: Address = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NoPendingTransfer)?;
        pending_owner.require_auth();

        let mut resource = Self::load(&env, &id)?;
        Self::ensure_mutable(&resource)?;
        let previous_owner = resource.creator.clone();
        resource.creator = pending_owner.clone();
        
        // Clear dispute flag on ownership transfer - disputes are tied to the
        // previous owner's actions and should not transfer to the new owner
        resource.dispute_flag = DisputeFlag::NoFlag;
        
        Self::save(&env, &mut resource);
        Self::move_creator_index(&env, &previous_owner, &pending_owner, &id, resource.listed);

        env.storage().persistent().remove(&key);

        env.events().publish(
            (symbol_short!("transfer"), id),
            (previous_owner, pending_owner),
        );
        Ok(())
    }

    /// Cancel a proposed transfer. Only the current owner can call this.
    ///
    /// Self-cancel protection: `cancel_transfer` requires the caller to be the
    /// current `resource.creator`. After `accept_transfer` completes the
    /// pending-transfer entry is removed and ownership moves to the new
    /// creator, so any subsequent `cancel_transfer` call by either party
    /// returns `NoPendingTransfer` — an accepted transfer can never be
    /// reversed through this path.
    pub fn cancel_transfer(env: Env, id: String) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        let resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;

        let key = DataKey::PendingTransfer(id.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoPendingTransfer);
        }

        // Self-cancel guard: the pending recipient cannot be the same address
        // as the current creator. This is structurally enforced by
        // `propose_transfer` (`AlreadyOwner`), but we verify here so
        // `cancel_transfer` remains safe even if called from an unusual path.
        let pending: Address = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NoPendingTransfer)?;
        if pending == resource.creator {
            return Err(Error::AlreadyOwner);
        }

        env.storage().persistent().remove(&key);
        env.events()
            .publish((symbol_short!("cancel"), id), resource.creator);
        Ok(())
    }

    /// Set a resource's creator-controlled listing state. Only
    /// `Listed <-> Delisted` transitions are accepted; all other lifecycle
    /// states reject this method with `InvalidLifecycleTransition`.
    pub fn set_listed(env: Env, id: String, listed: bool) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        let old_listed = resource.listed;
        let next = if listed {
            ResourceState::Listed
        } else {
            ResourceState::Delisted
        };
        // Preserve the established `set_listed` no-op behavior for existing
        // callers. It is not a lifecycle transition, but still refreshes the
        // resource and emits the legacy `setlisted` event.
        if resource.state == next {
            Self::save(&env, &mut resource);
            env.events()
                .publish((symbol_short!("setlisted"), id), (old_listed, listed));
            return Ok(());
        }
        Self::transition_creator_state(&env, &mut resource, next)?;
        env.events()
            .publish((symbol_short!("setlisted"), id), (old_listed, listed));
        Ok(())
    }

    /// Delist a resource (convenience method for set_listed(false)). Only the creator may call this.
    pub fn delist(env: Env, id: String) -> Result<(), Error> {
        Self::set_listed(env, id, false)
    }

    /// Freeze an otherwise active resource. The creator may freeze a listed or
    /// delisted resource, and may restore it (or a post-dispute `Frozen`
    /// resolution) through `reactivate_resource`. This lifecycle freeze is
    /// separate from `freeze_metadata`.
    pub fn freeze_resource(env: Env, id: String) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::transition_creator_state(&env, &mut resource, ResourceState::Frozen)
    }

    /// Place an active resource under an admin-controlled dispute hold.
    pub fn open_dispute(env: Env, id: String, admin: Address) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        Self::require_current_admin(&env, &admin)?;
        let mut resource = Self::load(&env, &id)?;
        
        // Check if resource is already disputed to prevent re-opening
        if resource.state == ResourceState::Disputed {
            return Err(Error::InvalidLifecycleTransition);
        }
        
        if !matches!(
            resource.state,
            ResourceState::Listed | ResourceState::Delisted | ResourceState::Frozen
        ) {
            return Err(Error::InvalidLifecycleTransition);
        }
        Self::transition_state(&env, &mut resource, ResourceState::Disputed);
        Ok(())
    }

    /// Resolve a disputed resource to `Listed`, `Delisted`, or `Frozen`.
    pub fn resolve_dispute(
        env: Env,
        id: String,
        admin: Address,
        state: ResourceState,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        Self::require_current_admin(&env, &admin)?;
        let mut resource = Self::load(&env, &id)?;
        if resource.state != ResourceState::Disputed
            || !matches!(
                state,
                ResourceState::Listed | ResourceState::Delisted | ResourceState::Frozen
            )
        {
            return Err(Error::InvalidLifecycleTransition);
        }
        Self::transition_state(&env, &mut resource, state);
        Ok(())
    }

    /// Emergency-delist a disputed resource. Only the current admin may call
    /// this, and only while the resource is in the `Disputed` state.
    ///
    /// Emits an `emdelist` event with `EmergencyDelistEvent { id, admin, reason }`.
    /// A creator delist goes through `set_listed`/`delist` and emits `setlisted`,
    /// so the two actions are now distinguishable by topic alone: an indexer
    /// seeing `emdelist` knows an admin pulled the resource and can attribute it
    /// to `admin` with the caller's stated `reason`. Before this event existed,
    /// `emergency_delist` emitted nothing at all, so an admin takedown was only
    /// visible by reading resource state after the fact.
    ///
    /// `reason` is free-form and is not length-validated. The caller is the
    /// authenticated current admin, so an oversized value costs the admin their
    /// own transaction fee rather than enabling griefing, and the contract has no
    /// spare error code to reject it with — `Error` is at the protocol's 50-case
    /// cap (see the note on the enum). Admin justification is best left
    /// unopinionated; consumers that need a controlled vocabulary can key off
    /// `admin` plus the resulting `ResourceState`.
    ///
    /// Errors deterministically:
    /// - [`Error::Unauthorized`] — caller is not the current admin
    /// - [`Error::InvalidLifecycleTransition`] — resource is not `Disputed`
    /// - [`Error::NotFound`] — `id` is not a registered resource
    /// - [`Error::InvalidResourceId`] — `id` fails format validation
    /// - [`Error::ContractPaused`] — the registry is paused
    pub fn emergency_delist(
        env: Env,
        id: String,
        admin: Address,
        reason: String,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        Self::require_current_admin(&env, &admin)?;
        let mut resource = Self::load(&env, &id)?;
        if resource.state != ResourceState::Disputed {
            return Err(Error::InvalidLifecycleTransition);
        }
        Self::transition_state(&env, &mut resource, ResourceState::Delisted);
        env.events().publish(
            (symbol_short!("emdelist"), id.clone()),
            EmergencyDelistEvent { id, admin, reason },
        );
        Ok(())
    }

    /// Reactivate a resource that was resolved out of a dispute (or otherwise
    /// left inactive) back to the public `Listed` state. Only the creator may
    /// call this, and only while the resource is `Frozen` or `Delisted`.
    ///
    /// `Disputed` resources have no creator exit: an admin must resolve the
    /// dispute first, and `Tombstoned` resources are terminal — reactivation
    /// from either fails with `InvalidLifecycleTransition`.
    ///
    /// Mirrors `set_listed(id, true)` for the `Delisted` case but is the only
    /// creator path out of `Frozen`, and always flips the `listed` projection
    /// and listed-count index back to active.
    ///
    /// Emits a `reactive` event whose topic carries the resource `id`.
    ///
    /// Errors deterministically:
    /// - [`Error::Unauthorized`] — caller is not the resource creator
    /// - [`Error::InvalidLifecycleTransition`] — resource is not `Frozen` or
    ///   `Delisted` (e.g. still `Disputed`, already `Listed`, or `Tombstoned`)
    /// - [`Error::InvalidResourceId`] — `id` fails format validation
    /// - [`Error::NotFound`] — `id` is not a registered resource
    /// - [`Error::ContractPaused`] — the registry is paused
    pub fn reactivate_resource(env: Env, id: String) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        if !matches!(
            resource.state,
            ResourceState::Frozen | ResourceState::Delisted
        ) {
            return Err(Error::InvalidLifecycleTransition);
        }
        Self::transition_state(&env, &mut resource, ResourceState::Listed);
        env.events().publish((symbol_short!("reactive"), id), ());
        Ok(())
    }

    /// Permanently retire a resource. Only an admin may tombstone it; the
    /// tombstoned state has no outgoing transitions.
    ///
    /// Tombstoning purges the resource from every derived listing index the
    /// contract can reach in bounded gas — the tag index and the creator
    /// index — so it stops surfacing in `list_by_tag`, `list_by_creator`, and
    /// `creator_resource_count`. The canonical `Resource` entry is left in
    /// place and stays readable through `get` for audit, and the global
    /// `Index`/`Count` pair is deliberately untouched: `Count` is monotonic
    /// and finding a resource's slot in it would cost an unbounded scan.
    pub fn tombstone_resource(env: Env, id: String, admin: Address) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        Self::require_current_admin(&env, &admin)?;
        let mut resource = Self::load(&env, &id)?;
        if resource.state == ResourceState::Tombstoned {
            return Err(Error::InvalidLifecycleTransition);
        }

        // Tombstoned resources must no longer be discoverable by tag...
        Self::tag_index_remove(&env, &resource.tags, &id);
        // ...nor listed under the creator that owned them.
        Self::remove_from_creator_index(&env, &resource.creator, &id);
        let owned = Self::creator_count(&env, &resource.creator);
        Self::set_creator_count(&env, &resource.creator, owned.saturating_sub(1));

        env.storage()
            .persistent()
            .remove(&DataKey::PendingTransfer(id.clone()));
        Self::transition_state(&env, &mut resource, ResourceState::Tombstoned);
        Ok(())
    }

    /// Paginated resource list in insertion order. `limit` is capped at 20.
    ///
    /// Kept for callers that only need the page body. Prefer `list_page` when
    /// the client must know the next cursor / end-of-list without recomputing
    /// offsets.
    pub fn list(env: Env, start: u32, limit: u32) -> Vec<Resource> {
        Self::list_page(env, start, limit).items
    }

    /// Paginated catalog page with next-cursor metadata.
    ///
    /// - `cursor` is a 0-based catalog index (same domain as `list`'s `start`).
    /// - `limit` is capped at 20.
    /// - `next_cursor` is `Some(next_index)` when more entries may exist after
    ///   this page, or `None` at end-of-list (including empty catalog / cursor
    ///   past the end).
    pub fn list_page(env: Env, cursor: u32, limit: u32) -> CatalogPage {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut items: Vec<Resource> = Vec::new(&env);
        let mut i = cursor;
        while i < total && items.len() < page_size {
            let idx_key = DataKey::Index(i);
            if let Some(id) = env.storage().persistent().get::<DataKey, String>(&idx_key) {
                Self::bump_persistent(&env, &idx_key);
                let res_key = DataKey::Resource(id);
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&res_key)
                {
                    Self::bump_persistent(&env, &res_key);
                    items.push_back(resource);
                }
            }
            i += 1;
        }
        let next_cursor = if i < total { Some(i) } else { None };
        CatalogPage { items, next_cursor }
    }

    /// Paginated list of resources whose `listed` flag is true, in insertion order.
    ///
    /// - Resources are ordered by registration sequence.
    /// - `limit` is capped at `20`.
    /// - Delisted resources are skipped; relisted resources will reappear.
    /// - Returns an empty `Vec` if no listed resources fall in range.
    pub fn list_listed(env: Env, start: u32, limit: u32) -> Vec<Resource> {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut result: Vec<Resource> = Vec::new(&env);
        let mut i = start;
        while i < total && result.len() < page_size {
            let idx_key = DataKey::Index(i);
            if let Some(id) = env.storage().persistent().get::<DataKey, String>(&idx_key) {
                Self::bump_persistent(&env, &idx_key);
                let res_key = DataKey::Resource(id);
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&res_key)
                {
                    Self::bump_persistent(&env, &res_key);
                    if resource.state == ResourceState::Listed {
                        result.push_back(resource);
                    }
                }
            }
            i += 1;
        }
        result
    }

    /// Paginated listing of resources owned by `creator` in insertion order.
    ///
    /// - Results are ordered by global registration sequence for that creator.
    /// - `limit` is capped at `20`.
    /// - Returns empty `Vec` when `start` is beyond the creator's known items.
    pub fn list_by_creator(env: Env, creator: Address, start: u32, limit: u32) -> Vec<Resource> {
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut result: Vec<Resource> = Vec::new(&env);
        if page_size == 0 {
            return result;
        }

        let list = Self::creator_list(&env, &creator);
        let total = list.len();
        if start >= total {
            return result;
        }

        let mut idx = start;
        while result.len() < page_size && idx < total {
            let id = list.get(idx).unwrap();
            if let Some(resource) = env
                .storage()
                .persistent()
                .get::<DataKey, Resource>(&DataKey::Resource(id.clone()))
            {
                Self::bump_persistent(&env, &DataKey::Resource(id));
                result.push_back(resource);
            }
            idx += 1;
        }
        result
    }

    /// Number of resources currently owned by `creator` (moves with
    /// `transfer_ownership`/`accept_transfer`; unrelated to the monotonic,
    /// never-decremented `count()`).
    pub fn creator_resource_count(env: Env, creator: Address) -> u32 {
        Self::creator_count(&env, &creator)
    }

    /// Number of resources owned by `creator` that are currently in the
    /// `Listed` state. The per-creator counterpart of `listed_count`: it
    /// follows every listed-state transition (delist, freeze, dispute,
    /// reactivate, tombstone) and moves between owners on transfer.
    pub fn creator_listed_count(env: Env, creator: Address) -> u32 {
        Self::creator_listed(&env, &creator)
    }

    /// Return the resource ids tagged with `tag` (normalized to lowercase),
    /// paginated by `start`/`limit`. `limit` is capped at 20. Resources are
    /// returned in the order they were added to the tag index (insertion
    /// order per tag). If the tag has never been assigned to any resource
    /// returns an empty vec. Each resource entry that is read has its TTL
    /// bumped to keep hot resources alive.
    pub fn list_by_tag(env: Env, tag: String, start: u32, limit: u32) -> Vec<Resource> {
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut result: Vec<Resource> = Vec::new(&env);
        if page_size == 0 {
            return result;
        }

        // Normalize the lookup tag the same way tags are stored
        let norm_tag = Self::normalize_tag(&env, &tag);
        let tag_key = DataKey::TagIndex(norm_tag);
        let ids: Vec<String> = env
            .storage()
            .persistent()
            .get(&tag_key)
            .unwrap_or_else(|| Vec::new(&env));

        let total = ids.len();
        if start >= total {
            return result;
        }

        let mut idx = start;
        while result.len() < page_size && idx < total {
            let id = ids.get(idx).unwrap();
            let res_key = DataKey::Resource(id.clone());
            if let Some(resource) = env
                .storage()
                .persistent()
                .get::<DataKey, Resource>(&res_key)
            {
                Self::bump_persistent(&env, &res_key);
                if resource.state != ResourceState::Tombstoned {
                    result.push_back(resource);
                }
            }
            idx += 1;
        }
        result
    }

    pub fn top_tags(env: Env, limit: u32) -> Vec<TagPopularity> {
        let page_size = limit.min(TOP_TAGS_CAP);
        if page_size == 0 {
            return Vec::new(&env);
        }

        let stats: Vec<TagPopularity> = env
            .storage()
            .instance()
            .get(&DataKey::TopTags)
            .unwrap_or_else(|| Vec::new(&env));
        let mut result: Vec<TagPopularity> = Vec::new(&env);
        let mut i = 0u32;
        while i < stats.len() && result.len() < page_size {
            result.push_back(stats.get(i).unwrap());
            i += 1;
        }
        Self::bump_instance(&env);
        result
    }

    /// Paginated list of resources filtered by active moderator dispute flag.
    ///
    /// `flagged = true` returns resources with `DisputeFlag::Flagged(_)`;
    /// `flagged = false` returns resources with `DisputeFlag::NoFlag`.
    /// `start` is a global catalog cursor, matching `list_listed`.
    pub fn list_by_dispute_status(
        env: Env,
        flagged: bool,
        start: u32,
        limit: u32,
    ) -> Vec<Resource> {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut result: Vec<Resource> = Vec::new(&env);
        let mut i = start;
        while i < total && result.len() < page_size {
            let idx_key = DataKey::Index(i);
            if let Some(id) = env.storage().persistent().get::<DataKey, String>(&idx_key) {
                Self::bump_persistent(&env, &idx_key);
                let res_key = DataKey::Resource(id);
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&res_key)
                {
                    Self::bump_persistent(&env, &res_key);
                    if resource.dispute_flag.is_flagged() == flagged {
                        result.push_back(resource);
                    }
                }
            }
            i += 1;
        }
        result
    }

    /// Paginated list of resources filtered by verification status.
    ///
    /// Returns resources whose `verified` field matches `status`.
    /// `cursor` is a global catalog index (same semantics as `list_page`).
    /// `limit` is capped at 20.
    /// Returns a `CatalogPage` with `items` (matching resources) and
    /// `next_cursor` (next catalog position, or `None` at end-of-list).
    pub fn list_by_verification_status(
        env: Env,
        status: VerificationStatus,
        cursor: u32,
        limit: u32,
    ) -> CatalogPage {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut items: Vec<Resource> = Vec::new(&env);
        let mut i = cursor;
        while i < total && items.len() < page_size {
            let idx_key = DataKey::Index(i);
            if let Some(id) = env.storage().persistent().get::<DataKey, String>(&idx_key) {
                Self::bump_persistent(&env, &idx_key);
                let res_key = DataKey::Resource(id);
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&res_key)
                {
                    Self::bump_persistent(&env, &res_key);
                    if resource.verified == status {
                        items.push_back(resource);
                    }
                }
            }
            i += 1;
        }
        let next_cursor = if i < total { Some(i) } else { None };
        CatalogPage { items, next_cursor }
    }

    /// `list_listed` with next-cursor metadata: `cursor` and `next_cursor`
    /// are global catalog indexes (same domain as `list_page`), so a page
    /// boundary is stable however many resources change state between calls.
    pub fn list_listed_page(env: Env, cursor: u32, limit: u32) -> CatalogPage {
        Self::scan_catalog(&env, cursor, limit, |resource| {
            resource.state == ResourceState::Listed
        })
    }

    /// `list_by_dispute_status` with next-cursor metadata. Because the cursor
    /// is a catalog index rather than a count of matches, a flag flipping
    /// between pages can neither skip nor repeat a resource: each catalog slot
    /// is visited exactly once, and its current flag decides inclusion.
    pub fn list_by_dispute_status_page(
        env: Env,
        flagged: bool,
        cursor: u32,
        limit: u32,
    ) -> CatalogPage {
        Self::scan_catalog(&env, cursor, limit, |resource| {
            resource.dispute_flag.is_flagged() == flagged
        })
    }

    /// `list_by_creator` with an id-based cursor. Pass `IdCursor::Start` for
    /// the first page and the returned `next_cursor` for each following page;
    /// `IdCursor::End` back means end-of-list. See [`IdCursor`] for how the
    /// cursor survives tombstones and transfers that remove entries from the
    /// creator index.
    pub fn list_by_creator_page(
        env: Env,
        creator: Address,
        cursor: IdCursor,
        limit: u32,
    ) -> IdPage {
        let ids = Self::creator_list(&env, &creator);
        Self::id_page(&env, &ids, cursor, limit, |_| true)
    }

    /// `list_by_tag` with an id-based cursor (see `list_by_creator_page`).
    /// Tombstoned resources are skipped exactly as `list_by_tag` skips them.
    pub fn list_by_tag_page(env: Env, tag: String, cursor: IdCursor, limit: u32) -> IdPage {
        let norm_tag = Self::normalize_tag(&env, &tag);
        let ids: Vec<String> = env
            .storage()
            .persistent()
            .get(&DataKey::TagIndex(norm_tag))
            .unwrap_or_else(|| Vec::new(&env));
        Self::id_page(&env, &ids, cursor, limit, |resource| {
            resource.state != ResourceState::Tombstoned
        })
    }

    /// Rebuild the tag index from an authoritative, admin-supplied ordered
    /// list of resource ids. Only the admin may call this. Every id must
    /// already exist as a registered `Resource` (else `NotFound`). Unlike
    /// `repair_index`, duplicates in the id list are harmless (tag index has
    /// set semantics per tag — re-indexing the same id is idempotent) and
    /// are silently de-duplicated rather than rejected. Never reads, writes,
    /// or deletes `Resource` storage — only rewrites the derived `TagIndex`
    /// entries for the tags those resources currently carry. Safe to re-run
    /// with the correct current id list as a no-op. See
    /// `docs/tag-index-repair-design.md` for the full strategy.
    ///
    /// An empty `ids` list is a documented no-op: it returns `Ok(())` and
    /// deliberately emits **no** `retagidx` event. There is nothing to index, so
    /// every `TagIndex` entry is left exactly as it was, and suppressing the
    /// event is what keeps the call from reading as a successful repair — the
    /// ADR's `retagidx` payload is the signal operators and audit tooling use to
    /// see that a repair ran and how broad it was, so emitting `retagidx` with a
    /// count of `0` would assert a repair that never touched the index. Callers
    /// driving this off-chain should treat "no `retagidx` event" as "no repair
    /// performed" and must not infer that the tag index is empty.
    ///
    /// Errors deterministically:
    /// - [`Error::NotFound`] — any id in `ids` is not a registered resource
    /// - [`Error::AdminNotSet`] — no admin has been bootstrapped
    /// - [`Error::ContractPaused`] — the registry is paused
    pub fn repair_tag_index(env: Env, ids: Vec<String>) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Self::require_not_paused(&env)?;

        let len = ids.len();
        if len == 0 {
            return Ok(());
        }

        // Validate every id exists before touching anything
        for i in 0..len {
            let id = ids.get(i).unwrap();
            if !env
                .storage()
                .persistent()
                .has(&DataKey::Resource(id.clone()))
            {
                return Err(Error::NotFound);
            }
        }

        // Collect current tags for each id (read canonical Resource data).
        // Build a tag -> Vec<id> map in a simple parallel-vec structure that
        // avoids BTreeMap (unavailable in no_std without alloc feature that
        // isn't brought in here). Small curated tag sets keep this O(n*t).
        let mut tag_keys: Vec<String> = Vec::new(&env); // unique normalized tags seen
        let mut tag_id_vecs: alloc::vec::Vec<Vec<String>> = alloc::vec::Vec::new(); // parallel

        // Helper: find index of tag_key in tag_keys, return None if absent.
        let find_tag_pos = |keys: &Vec<String>, t: &String| -> Option<u32> {
            (0..keys.len()).find(|&k| keys.get(k).unwrap() == *t)
        };

        for i in 0..len {
            let id = ids.get(i).unwrap();
            let resource: Resource = env
                .storage()
                .persistent()
                .get(&DataKey::Resource(id.clone()))
                .unwrap(); // already validated above
            for j in 0..resource.tags.len() {
                let raw_tag = resource.tags.get(j).unwrap();
                let tag = Self::normalize_tag(&env, &raw_tag);
                match find_tag_pos(&tag_keys, &tag) {
                    Some(pos) => {
                        let id_vec = &mut tag_id_vecs[pos as usize];
                        // Deduplicate: only add if not already present
                        let mut already = false;
                        for k in 0..id_vec.len() {
                            if id_vec.get(k).unwrap() == id {
                                already = true;
                                break;
                            }
                        }
                        if !already {
                            id_vec.push_back(id.clone());
                        }
                    }
                    None => {
                        tag_keys.push_back(tag.clone());
                        let mut id_vec: Vec<String> = Vec::new(&env);
                        id_vec.push_back(id.clone());
                        tag_id_vecs.push(id_vec);
                    }
                }
            }
        }

        // Write rebuilt tag index entries
        for k in 0..tag_keys.len() {
            let tag = tag_keys.get(k).unwrap();
            let id_vec = &tag_id_vecs[k as usize];
            let tag_key = DataKey::TagIndex(tag);
            env.storage().persistent().set(&tag_key, id_vec);
            Self::bump_persistent(&env, &tag_key);
        }

        env.events().publish((symbol_short!("retagidx"),), len);
        Ok(())
    }

    /// Fetch a resource. Errors with `NotFound` if it does not exist.
    pub fn get(env: Env, id: String) -> Result<Resource, Error> {
        Self::validate_resource_id(&id)?;
        Self::load(&env, &id)
    }

    /// Fetch the current lifecycle state of a resource. Errors with `NotFound` if absent.
    pub fn get_resource_state(env: Env, id: String) -> Result<ResourceState, Error> {
        Self::validate_resource_id(&id)?;
        let resource = Self::load(&env, &id)?;
        Ok(resource.state)
    }

    /// Read several resources in one invocation, preserving input order.
    /// Missing resources are represented by `None`; valid resources are
    /// returned as `Some(Resource)`. The batch is capped to bound execution
    /// and response size.
    pub fn get_many(env: Env, ids: Vec<String>) -> Result<Vec<Option<Resource>>, Error> {
        const MAX_BATCH_SIZE: u32 = 20;
        if ids.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }
        let mut result: Vec<Option<Resource>> = Vec::new(&env);
        for i in 0..ids.len() {
            let id = ids.get(i).unwrap();
            Self::validate_resource_id(&id)?;
            let key = DataKey::Resource(id);
            let resource = env.storage().persistent().get(&key);
            if resource.is_some() {
                Self::bump_persistent(&env, &key);
            }
            result.push_back(resource);
        }
        Ok(result)
    }

    /// Whether a resource with `id` is registered.
    pub fn exists(env: Env, id: String) -> bool {
        Self::validate_resource_id(&id).is_ok()
            && env.storage().persistent().has(&DataKey::Resource(id))
    }

    /// Batch existence check. Returns a `Vec<bool>` parallel to `ids`:
    /// `result[i]` is `true` iff a resource with `ids[i]` is registered.
    ///
    /// Semantics match `exists` for each element: IDs that fail format
    /// validation are treated as absent (`false`) rather than erroring.
    /// TTL is bumped for every ID that resolves to a registered resource,
    /// keeping the hot entries alive exactly as a sequence of individual
    /// `exists` calls would.
    ///
    /// This is useful for server-side bulk validation before publishing or
    /// reconciliation — callers can check many IDs in a single contract
    /// invocation instead of one round-trip per ID.
    pub fn exists_many(env: Env, ids: Vec<String>) -> Vec<bool> {
        let mut result: Vec<bool> = Vec::new(&env);
        for i in 0..ids.len() {
            let id = ids.get(i).unwrap();
            let found = if Self::validate_resource_id(&id).is_err() {
                false
            } else {
                let key = DataKey::Resource(id);
                if env.storage().persistent().has(&key) {
                    Self::bump_persistent(&env, &key);
                    true
                } else {
                    false
                }
            };
            result.push_back(found);
        }
        result
    }

    /// Get the owner address of a resource. Errors with `NotFound` if it does not exist.
    pub fn get_owner(env: Env, id: String) -> Result<Address, Error> {
        Self::validate_resource_id(&id)?;
        let resource = Self::load(&env, &id)?;
        Ok(resource.creator)
    }

    /// Batch owner lookup. Returns a `Vec<Option<Address>>` parallel to `ids`.
    /// Missing resources are `None`; invalid resource ids fail the whole call,
    /// matching `get_many` and keeping malformed multi-select requests visible.
    pub fn get_owner_many(env: Env, ids: Vec<String>) -> Result<Vec<Option<Address>>, Error> {
        const MAX_BATCH_SIZE: u32 = 20;
        if ids.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }
        let mut result: Vec<Option<Address>> = Vec::new(&env);
        for i in 0..ids.len() {
            let id = ids.get(i).unwrap();
            Self::validate_resource_id(&id)?;
            let key = DataKey::Resource(id);
            let resource: Option<Resource> = env.storage().persistent().get(&key);
            if resource.is_some() {
                Self::bump_persistent(&env, &key);
            }
            result.push_back(resource.map(|resource| resource.creator));
        }
        Ok(result)
    }

    /// Total number of resources successfully registered (monotonic; not decremented on transfer).
    pub fn count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// Number of resources currently in the Listed state.
    pub fn listed_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ListedCount)
            .unwrap_or(0)
    }

    /// Store the intended network identifier once. The supplied ID must match
    /// the ledger this contract is executing on, preventing a deployment
    /// script from accidentally recording a different Stellar network.
    pub fn initialize_network(env: Env, network_id: BytesN<32>) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::NetworkId) {
            return Err(Error::NetworkAlreadyInitialized);
        }
        if network_id != env.ledger().network_id() {
            return Err(Error::NetworkIdMismatch);
        }
        env.storage()
            .instance()
            .set(&DataKey::NetworkId, &network_id);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("netinit"),), network_id);
        Ok(())
    }

    /// Return the initialized network identifier. Callers can use this value
    /// as a deployment guard before submitting network-sensitive operations.
    pub fn network_id(env: Env) -> Result<BytesN<32>, Error> {
        env.storage()
            .instance()
            .get(&DataKey::NetworkId)
            .ok_or(Error::NetworkNotInitialized)
    }

    /// Discover this registry's stable identity and capabilities in one
    /// read-only call: name, crate version, `Resource` schema version, and
    /// the network this contract is deployed on. Always succeeds — there is
    /// no failure mode a caller needs to handle.
    pub fn registry_info(env: Env) -> RegistryInfo {
        RegistryInfo {
            name: String::from_str(&env, REGISTRY_NAME),
            version: String::from_str(&env, env!("CARGO_PKG_VERSION")),
            resource_schema_version: RESOURCE_SCHEMA_VERSION,
            network_id: env.ledger().network_id(),
        }
    }

    /// Return the contract crate version and the `Resource` schema version as a
    /// stable, compact struct. Deployment scripts and upgrade tools should call
    /// this to confirm which version of the contract is running on-chain before
    /// and after a redeploy, without needing to parse the full `registry_info`
    /// response.
    ///
    /// Upgrade compatibility: `crate_version` is the Cargo semver string baked
    /// in at build time (`CARGO_PKG_VERSION`). `resource_schema_version` is an
    /// integer bumped only when the on-chain `Resource` struct changes in a way
    /// that requires callers to update how they decode it. A change to
    /// `crate_version` alone does not imply a schema change.
    pub fn contract_version(env: Env) -> ContractVersion {
        ContractVersion {
            crate_version: String::from_str(&env, env!("CARGO_PKG_VERSION")),
            resource_schema_version: RESOURCE_SCHEMA_VERSION,
        }
    }

    /// Return `RESOURCE_SCHEMA_VERSION` as a bare `u32`, so clients can do
    /// feature detection (e.g. "does `Resource` carry `metadata_frozen_at`?")
    /// with a single integer comparison instead of decoding
    /// `contract_version` or `registry_info`. Always succeeds.
    pub fn resource_schema_version(_env: Env) -> u32 {
        RESOURCE_SCHEMA_VERSION
    }

    /// Current contract admin.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Pending nominated contract admin.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// Return the ledger sequence at which the pending admin nomination expires.
    /// Bumps the instance storage TTL to keep the entry alive for active monitors.
    pub fn pending_admin_expiry(env: Env) -> Option<u32> {
        let expiry = env.storage().instance().get(&DataKey::PendingAdminExpiry);
        if expiry.is_some() {
            Self::bump_instance(&env);
        }
        expiry
    }

    /// Nominate a new contract admin. Only the current admin may call this.
    /// Sets `pending_admin`. The nomination does not take effect until
    /// the pending admin calls `accept_admin`.
    pub fn nominate_new_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            new_admin.require_auth();
            env.storage().instance().set(&DataKey::Admin, &new_admin);
            Self::bump_instance(&env);
            env.events()
                .publish((symbol_short!("setadmin"),), new_admin);
            return Ok(());
        }

        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        stored_admin.require_auth();

        if new_admin == stored_admin {
            return Err(Error::SameAdmin);
        }
        if let Some(expiry) = env
            .storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::PendingAdminExpiry)
        {
            if env.ledger().sequence() >= expiry {
                env.storage().instance().remove(&DataKey::PendingAdmin);
                env.storage()
                    .instance()
                    .remove(&DataKey::PendingAdminExpiry);
                env.storage()
                    .instance()
                    .remove(&DataKey::PendingAdminNominatedAt);
            }
        }
        if env.storage().instance().has(&DataKey::PendingAdmin) {
            return Err(Error::PendingAdminAlreadySet);
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        let nominated_at = env.ledger().sequence();
        let expiry = nominated_at.saturating_add(ADMIN_NOMINATION_DURATION);
        env.storage()
            .instance()
            .set(&DataKey::PendingAdminNominatedAt, &nominated_at);
        env.storage()
            .instance()
            .set(&DataKey::PendingAdminExpiry, &expiry);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("nomadmin"),), new_admin);
        Ok(())
    }

    /// Accept the pending admin nomination and become the contract admin.
    /// Only the pending admin may call this.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let stored_pending: Address = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::PendingAdmin)
            .ok_or(Error::AdminNominationExpired)?;

        let expiry: u32 = env
            .storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::PendingAdminExpiry)
            .unwrap_or(0);
        if env.ledger().sequence() >= expiry {
            env.storage().instance().remove(&DataKey::PendingAdmin);
            env.storage()
                .instance()
                .remove(&DataKey::PendingAdminExpiry);
            env.storage()
                .instance()
                .remove(&DataKey::PendingAdminNominatedAt);
            return Err(Error::AdminNominationExpired);
        }

        // Enforce the mandatory ledger gap: accept_admin must be called at
        // least ADMIN_NOMINATION_MIN_GAP ledgers after nominate_new_admin so
        // that the two steps cannot be batched into a single transaction by a
        // compromised admin.
        let nominated_at: u32 = env
            .storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::PendingAdminNominatedAt)
            .unwrap_or(0);
        if env.ledger().sequence() < nominated_at.saturating_add(ADMIN_NOMINATION_MIN_GAP) {
            return Err(Error::AdminNominationExpired);
        }

        if stored_pending != new_admin {
            return Err(Error::PendingAdminNotSet);
        }

        new_admin.require_auth();
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .remove(&DataKey::PendingAdminExpiry);
        env.storage()
            .instance()
            .remove(&DataKey::PendingAdminNominatedAt);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("accadmin"),), new_admin);
        Ok(())
    }

    /// Optional dual-key bootstrap: set `admin` and a separate
    /// `recovery_admin` in one call, so the deployment can recover via
    /// `recover_admin` if the sole admin key is lost. Both addresses must
    /// authorize and must differ (`SameAdmin`). Only valid before any admin is
    /// set (`AdminAlreadySet`); `nominate_new_admin` remains the single-key
    /// bootstrap path. Emits `setadmin` and `setrecov`.
    pub fn bootstrap_dual_admin(
        env: Env,
        admin: Address,
        recovery_admin: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AdminAlreadySet);
        }
        if admin == recovery_admin {
            return Err(Error::SameAdmin);
        }
        admin.require_auth();
        recovery_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RecoveryAdmin, &recovery_admin);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("setadmin"),), admin);
        env.events()
            .publish((symbol_short!("setrecov"),), Some(recovery_admin));
        Ok(())
    }

    /// The configured recovery admin, if any.
    pub fn recovery_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::RecoveryAdmin)
    }

    /// Set or clear the recovery admin. Only the current admin may call this;
    /// the recovery admin must differ from the admin (`SameAdmin`). Emits
    /// `setrecov`.
    pub fn set_recovery_admin(env: Env, recovery_admin: Option<Address>) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        match &recovery_admin {
            Some(recovery) if *recovery == admin => return Err(Error::SameAdmin),
            Some(recovery) => env
                .storage()
                .instance()
                .set(&DataKey::RecoveryAdmin, recovery),
            None => env.storage().instance().remove(&DataKey::RecoveryAdmin),
        }
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("setrecov"),), recovery_admin);
        Ok(())
    }

    /// Replace a lost admin key. Only the recovery admin may call this.
    /// Sets `new_admin` as admin immediately and clears any pending admin
    /// nomination. The recovery admin itself is unchanged. Errors
    /// `RecoveryAdminNotSet`, `AdminNotSet`, or `SameAdmin`. Emits `recover`.
    pub fn recover_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let recovery: Address = env
            .storage()
            .instance()
            .get(&DataKey::RecoveryAdmin)
            .ok_or(Error::RecoveryAdminNotSet)?;
        recovery.require_auth();
        let old_admin = Self::require_admin(&env)?;
        if new_admin == old_admin || new_admin == recovery {
            return Err(Error::SameAdmin);
        }
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .remove(&DataKey::PendingAdminExpiry);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("recover"),), (old_admin, new_admin));
        Ok(())
    }

    /// Set or clear the emergency pause on all registry mutations.
    ///
    /// When `paused` is `true` every write method returns
    /// [`Error::ContractPaused`] without modifying any state. Read-only
    /// methods are unaffected and remain fully available.
    ///
    /// Requires the current admin's authorization. Errors `AdminNotSet` if no
    /// admin has been set yet, and `Unauthorized` if `admin` is not the
    /// current admin.
    ///
    /// Emits a `pause` event with data `(paused: bool, admin: Address)` on
    /// every call, including no-op transitions, so off-chain monitors can
    /// detect rapid pause/unpause cycles.
    pub fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), Error> {
        Self::require_current_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage().instance().remove(&DataKey::PauseUntil);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pause"), admin.clone()), (paused, admin));
        Ok(())
    }

    /// Schedule an emergency pause that automatically expires at `pause_until`.
    ///
    /// The deadline is an absolute Unix timestamp in seconds from the ledger
    /// clock. The existing `set_paused(admin, true)` entry point remains the
    /// way to create an indefinite pause. A deadline at or before the current
    /// ledger timestamp takes effect as an immediate resume.
    pub fn set_paused_until(env: Env, admin: Address, pause_until: u64) -> Result<(), Error> {
        Self::require_current_admin(&env, &admin)?;
        let active = pause_until > env.ledger().timestamp();
        env.storage().instance().set(&DataKey::Paused, &active);
        if active {
            env.storage()
                .instance()
                .set(&DataKey::PauseUntil, &pause_until);
        } else {
            env.storage().instance().remove(&DataKey::PauseUntil);
        }
        Self::bump_instance(&env);
        env.events().publish(
            (symbol_short!("pause"), admin.clone()),
            (active, admin.clone()),
        );
        env.events().publish(
            (Symbol::new(&env, "pause_until"), admin.clone()),
            (pause_until, admin),
        );
        Ok(())
    }

    /// Whether the registry is currently paused. Returns `false` when the
    /// pause flag has never been set. Never blocked by the pause itself.
    pub fn is_paused(env: Env) -> bool {
        Self::pause_is_active(&env)
    }

    /// The active scheduled pause deadline, if one exists.
    /// Bumps the instance storage TTL to keep the entry alive for active monitors.
    pub fn pause_until(env: Env) -> Option<u64> {
        let pause_until = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::PauseUntil)
            .filter(|pause_until| *pause_until > env.ledger().timestamp());
        if pause_until.is_some() {
            Self::bump_instance(&env);
        }
        pause_until
    }

    /// Grant the verifier role to `verifier`, authorizing `set_verification_status`.
    /// Only the admin may call this. Errors `AdminNotSet` if no admin has
    /// been set yet (see `nominate_new_admin`).
    pub fn add_verifier(env: Env, verifier: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Self::add_verifier_internal(&env, &admin, verifier);
        Ok(())
    }

    /// Revoke the verifier role from `verifier`. Only the admin may call this.
    pub fn remove_verifier(env: Env, verifier: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Self::remove_verifier_internal(&env, &admin, verifier);
        Ok(())
    }

    pub fn rotate_verifier(
        env: Env,
        old_verifier: Address,
        new_verifier: Address,
    ) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        if old_verifier == new_verifier {
            return Err(Error::AlreadyRegistered);
        }
        if !Self::is_verifier(env.clone(), old_verifier.clone()) {
            return Err(Error::NotFound);
        }
        if Self::is_verifier(env.clone(), new_verifier.clone()) {
            return Err(Error::AlreadyRegistered);
        }

        Self::remove_verifier_internal(&env, &admin, old_verifier.clone());
        Self::add_verifier_internal(&env, &admin, new_verifier.clone());
        env.events().publish(
            (symbol_short!("verrot"), old_verifier.clone()),
            VerifierRotation {
                old_verifier,
                new_verifier,
                ledger: env.ledger().sequence(),
            },
        );
        Ok(())
    }

    /// Whether `address` currently holds the verifier role.
    pub fn is_verifier(env: Env, address: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Verifier(address))
            .unwrap_or(false)
    }

    /// Rebuild the pagination index (`list`/`list_page`/`count`) from an
    /// authoritative, admin-supplied ordered list of resource ids. Only the
    /// admin may call this. Every id must already exist as a registered
    /// `Resource` (else `NotFound`) and the list must not contain duplicates
    /// (else `DuplicateInRepair`). Never touches `Resource` storage itself —
    /// only rewrites the derived `Index`/`Count` pointers, so it's safe to
    /// re-run with the current correct id list as a no-op. See
    /// `docs/index-repair.md` for the full repair strategy.
    pub fn repair_index(env: Env, ids: Vec<String>) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Self::require_not_paused(&env)?;

        let len = ids.len();
        for i in 0..len {
            let id = ids.get(i).unwrap();
            if !env
                .storage()
                .persistent()
                .has(&DataKey::Resource(id.clone()))
            {
                return Err(Error::NotFound);
            }
            for j in (i + 1)..len {
                if id == ids.get(j).unwrap() {
                    return Err(Error::DuplicateInRepair);
                }
            }
        }

        let old_count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);

        for i in 0..len {
            let id = ids.get(i).unwrap();
            let idx_key = DataKey::Index(i);
            env.storage().persistent().set(&idx_key, &id);
            Self::bump_persistent(&env, &idx_key);
        }
        env.storage().instance().set(&DataKey::Count, &len);
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("reindex"), old_count), len);
        Ok(())
    }

    /// Set the registry-level fee / royalty configuration. Only the admin may
    /// call this. Errors `AdminNotSet` if no admin has been set yet.
    ///
    /// Both `platform_fee_bps` and `royalty_bps` must be ≤ [`MAX_FEE_BPS`]
    /// (5 000 bp = 50 %) individually, **and** their sum must also be ≤
    /// [`MAX_FEE_BPS`]. Violating either bound errors `FeeBpsTooHigh` (for an
    /// individual field out of range) or `TotalFeeTooHigh` (for a valid
    /// individual pair whose sum exceeds the ceiling).
    ///
    /// Together with the price-validation rule (`price > platform_fee_bps +
    /// royalty_bps`), this guarantees the creator always receives a positive
    /// remainder of at least [`MIN_CREATOR_SHARE_BPS`] (50 %) on every sale.
    ///
    /// Stores the config under the singleton [`DataKey::FeeConfig`] instance
    /// entry and emits a `setfee` event carrying the old config (or `None` on
    /// first set) and the new config, so off-chain indexers have a full
    /// audit trail.
    pub fn set_fee_config(env: Env, config: FeeConfig) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Self::require_not_paused(&env)?;

        // Validate individual bounds first so callers get the more specific error
        if config.platform_fee_bps > MAX_FEE_BPS {
            return Err(Error::FeeBpsTooHigh);
        }
        if config.royalty_bps > MAX_FEE_BPS {
            return Err(Error::FeeBpsTooHigh);
        }
        // Then validate the combined ceiling
        if config.platform_fee_bps + config.royalty_bps > MAX_FEE_BPS {
            return Err(Error::TotalFeeTooHigh);
        }
        let destination = Self::load_fee_destination(&env);
        Self::validate_fee_destination_for_fee_config(&config, &destination)?;

        let old_config: OptFeeConfig = env
            .storage()
            .instance()
            .get::<DataKey, FeeConfig>(&DataKey::FeeConfig)
            .map(OptFeeConfig::Some)
            .unwrap_or(OptFeeConfig::None);
        env.storage().instance().set(&DataKey::FeeConfig, &config);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("setfee"),),
            FeeConfigUpdated {
                old_config,
                new_config: config,
            },
        );
        Ok(())
    }

    /// Read the registry-level fee / royalty configuration. Returns `None`
    /// if `set_fee_config` has never been called.
    pub fn get_fee_config(env: Env) -> Option<FeeConfig> {
        env.storage().instance().get(&DataKey::FeeConfig)
    }

    /// Update only the fee recipient address without changing fee rates.
    /// Only the admin may call this. Errors `AdminNotSet` if no admin has been
    /// set yet, or `FeeConfigNotSet` if `set_fee_config` has never been called.
    ///
    /// This is a convenience method that allows updating the recipient without
    /// having to re-specify the existing `platform_fee_bps` and `royalty_bps`.
    /// Emits a `setfee` event with the old and new complete `FeeConfig`.
    pub fn set_fee_recipient(env: Env, recipient: Option<Address>) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Self::require_not_paused(&env)?;

        // Retrieve existing fee config
        let mut config = env
            .storage()
            .instance()
            .get::<DataKey, FeeConfig>(&DataKey::FeeConfig)
            .ok_or(Error::FeeConfigNotSet)?;
        let destination = Self::load_fee_destination(&env);
        let old_config = OptFeeConfig::Some(config.clone());
        config.fee_recipient = recipient;
        Self::validate_fee_destination_for_fee_config(&config, &destination)?;

        env.storage().instance().set(&DataKey::FeeConfig, &config);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("setfee"),),
            FeeConfigUpdated {
                old_config,
                new_config: config,
            },
        );
        Ok(())
    }

    pub fn set_fee_destination(env: Env, config: FeeDestinationConfig) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Self::require_not_paused(&env)?;

        let fee_config = env
            .storage()
            .instance()
            .get::<DataKey, FeeConfig>(&DataKey::FeeConfig)
            .ok_or(Error::FeeConfigNotSet)?;
        Self::validate_fee_destination_for_fee_config(&fee_config, &config)?;

        let old_destination = Self::load_fee_destination(&env);
        env.storage()
            .instance()
            .set(&DataKey::FeeDestination, &config);
        Self::bump_instance(&env);
        env.events().publish(
            (symbol_short!("setdest"),),
            FeeDestinationUpdated {
                old_destination,
                new_destination: config,
                ledger: env.ledger().sequence(),
            },
        );
        Ok(())
    }

    pub fn get_fee_destination(env: Env) -> FeeDestinationConfig {
        Self::load_fee_destination(&env)
    }

    fn default_fee_destination() -> FeeDestinationConfig {
        FeeDestinationConfig {
            bps: 0,
            destination: FeeDestination::None,
        }
    }

    fn load_fee_destination(env: &Env) -> FeeDestinationConfig {
        env.storage()
            .instance()
            .get(&DataKey::FeeDestination)
            .unwrap_or_else(Self::default_fee_destination)
    }

    fn validate_fee_destination(destination: &FeeDestinationConfig) -> Result<(), Error> {
        if destination.bps > MAX_FEE_DESTINATION_BPS {
            return Err(Error::FeeBpsTooHigh);
        }
        match &destination.destination {
            FeeDestination::None if destination.bps == 0 => Ok(()),
            FeeDestination::Burn | FeeDestination::Charity(_) if destination.bps > 0 => Ok(()),
            _ => Err(Error::TotalFeeTooHigh),
        }
    }

    fn validate_fee_destination_for_fee_config(
        fee_config: &FeeConfig,
        destination: &FeeDestinationConfig,
    ) -> Result<(), Error> {
        Self::validate_fee_destination(destination)?;
        if destination.bps == 0 {
            return Ok(());
        }
        if fee_config.platform_fee_bps == 0 {
            return Err(Error::TotalFeeTooHigh);
        }
        if destination.bps < MAX_FEE_DESTINATION_BPS && fee_config.fee_recipient.is_none() {
            return Err(Error::TotalFeeTooHigh);
        }
        Ok(())
    }

    /// Store a hash of creator marketplace terms.
    pub fn set_terms_hash(env: Env, creator: Address, terms_hash: String) -> Result<(), Error> {
        creator.require_auth();
        Self::require_not_paused(&env)?;
        Self::validate_bounded_string(
            &terms_hash,
            0,
            MAX_TERMS_HASH_LEN,
            Error::TermsHashTooLong,
            Error::TermsHashTooLong,
        )?;
        let key = DataKey::CreatorTerms(creator.clone());
        env.storage().persistent().set(&key, &terms_hash);
        Self::bump_persistent(&env, &key);
        env.events()
            .publish((symbol_short!("setterms"), creator), terms_hash);
        Ok(())
    }

    /// Store the registry-wide canonical terms hash. Only the admin may call
    /// this. When a creator has not stored their own terms, `get_terms_hash`
    /// returns this value as the authoritative vault listing terms.
    pub fn set_registry_terms_hash(
        env: Env,
        terms_hash: String,
    ) -> Result<(), Error> {
        Self::require_current_admin(&env)?.require_auth();
        Self::require_not_paused(&env)?;
        Self::validate_bounded_string(
            &terms_hash,
            0,
            MAX_TERMS_HASH_LEN,
            Error::TermsHashTooLong,
            Error::TermsHashTooLong,
        )?;
        let key = DataKey::RegistryTerms;
        env.storage().persistent().set(&key, &terms_hash);
        Self::bump_persistent(&env, &key);
        env.events()
            .publish((symbol_short!("setregt"),), terms_hash);
        Ok(())
    }

    // ─── Settler role management ─────────────────────────────────────────────

    /// Grant the settler role to `settler`, authorizing `record_payment` and
    /// `settle_payment`. Only the admin may call this. Errors `AdminNotSet`
    /// if no admin has been set yet.
    pub fn add_settler(env: Env, settler: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Settler(settler.clone()), &true);
        Self::bump_instance(&env);
        env.events().publish(
            (symbol_short!("addsettlr"), settler.clone()),
            RoleChange {
                admin: admin,
                target: settler,
                granted: true,
            },
        );
        Ok(())
    }

    /// Revoke the settler role from `settler`. Only the admin may call this.
    pub fn remove_settler(env: Env, settler: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Settler(settler.clone()), &false);
        Self::bump_instance(&env);
        env.events().publish(
            (symbol_short!("rmsettlr"), settler.clone()),
            RoleChange {
                admin: admin,
                target: settler,
                granted: false,
            },
        );
        Ok(())
    }

    /// Whether `address` currently holds the settler role.
    pub fn is_settler(env: Env, address: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Settler(address))
            .unwrap_or(false)
    }

    // ─── Escrow-ready payment state ───────────────────────────────────────────

    /// Configure the creator refund window for payments settled after this call.
    /// Existing payment deadlines are not changed. The initial value is one day.
    pub fn set_refund_window(env: Env, admin: Address, window_ledgers: u32) -> Result<(), Error> {
        Self::require_current_admin(&env, &admin)?;
        Self::require_not_paused(&env)?;
        if window_ledgers == 0 || window_ledgers > MAX_REFUND_WINDOW_LEDGERS {
            return Err(Error::InvalidPaymentAmount);
        }

        let old_window = Self::refund_window(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::RefundWindow, &window_ledgers);
        Self::bump_instance(&env);
        env.events().publish(
            (symbol_short!("refwin"), admin),
            (old_window, window_ledgers),
        );
        Ok(())
    }

    /// Current creator refund window in ledgers. Defaults to one day.
    pub fn refund_window(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RefundWindow)
            .unwrap_or(DEFAULT_REFUND_WINDOW_LEDGERS)
    }

    /// Record an x402/Soroban payment receipt in `Escrowed` state. Only an
    /// address currently holding the settler role may call this.
    ///
    /// - `receipt_id` must be unique (max 64 bytes, non-empty); duplicate ids
    ///   error `ReceiptAlreadyExists`. Use `record_payment_idempotent` for a
    ///   retry-safe variant that returns the stored receipt instead.
    /// - `resource_id` must refer to an existing registered resource
    ///   (`NotFound` otherwise).
    /// - `amount` must be `> 0` (`InvalidPaymentAmount` otherwise).
    /// - `amount` must match the resource's current price
    ///   (`PaymentAmountMismatch` otherwise).
    /// - `tx_hash` must be non-empty and at most 128 bytes (`InvalidTxHash`).
    /// - `tx_hash` must not already back another receipt (`DuplicateTxHash`).
    ///
    /// Emits a `payment` event whose data is the full [`PaymentReceipt`] so
    /// off-chain indexers can index the receipt without reading contract
    /// storage.
    ///
    /// Provenance: this entry point cannot prove which resource the settlement
    /// transaction paid for, so it also emits a `nomemo` warning event. Prefer
    /// `record_payment_with_memo`, which checks the canonical `mv:<resource_id>`
    /// memo (see `PAYMENT_MEMO_PREFIX`).
    pub fn record_payment(
        env: Env,
        settler: Address,
        receipt_id: String,
        resource_id: String,
        payer: Address,
        amount: i128,
        tx_hash: String,
    ) -> Result<(), Error> {
        Self::check_payment_args(
            &env,
            &settler,
            &receipt_id,
            &resource_id,
            &payer,
            amount,
            state: PaymentState::Escrowed,
            tx_hash,
            recorded_at: env.ledger().sequence(),
            ledger: env.ledger().sequence(),
        };

        env.storage().persistent().set(&receipt_key, &receipt);
        Self::bump_persistent(&env, &receipt_key);

        let recipient_key = DataKey::PaymentRecipient(receipt_id.clone());
        env.storage()
            .persistent()
            .set(&recipient_key, &resource.creator);
        Self::bump_persistent(&env, &recipient_key);

        // Secondary indexes: `(resource_id, payer)` -> most recent receipt id
        // (for `get_payment_receipt`), and `tx_hash` -> receipt id (enforces
        // one receipt per Stellar settlement transaction).
        let index_key = DataKey::PaymentIndex(resource_id, payer);
        env.storage().persistent().set(&index_key, &receipt_id);
        Self::bump_persistent(&env, &index_key);

        env.storage().persistent().set(&tx_hash_key, &receipt_id);
        Self::bump_persistent(&env, &tx_hash_key);

        env.events()
            .publish((symbol_short!("payment"), receipt_id), receipt);
            &tx_hash,
        )?;
        Self::write_payment(&env, receipt_id, resource_id, payer, amount, tx_hash)?;
        Ok(())
    }

    /// Retry-safe `record_payment`: same auth, validation, and pause rules,
    /// but returns the stored receipt. If `receipt_id` is already recorded
    /// with the same `resource_id`, `payer`, `amount`, and `tx_hash`, that
    /// receipt is returned unchanged, whatever its state, with no write and
    /// no event. The same id with different arguments still errors
    /// `ReceiptAlreadyExists`.
    pub fn record_payment_idempotent(
        env: Env,
        settler: Address,
        receipt_id: String,
        resource_id: String,
        payer: Address,
        amount: i128,
        tx_hash: String,
    ) -> Result<PaymentReceipt, Error> {
        Self::check_payment_args(
            &env,
            &settler,
            &receipt_id,
            &resource_id,
            &payer,
            amount,
            &tx_hash,
        )?;
        let stored: Option<PaymentReceipt> = env
            .storage()
            .persistent()
            .get(&DataKey::PaymentReceipt(receipt_id.clone()));
        match stored {
            Some(receipt)
                if receipt.resource_id == resource_id
                    && receipt.payer == payer
                    && receipt.amount == amount
                    && receipt.tx_hash == tx_hash =>
            {
                Ok(receipt)
            }
            Some(_) => Err(Error::ReceiptAlreadyExists),
            None => Self::write_payment(&env, receipt_id, resource_id, payer, amount, tx_hash),
        }
    }

    /// Advance a payment receipt from `Escrowed` to `Settled`. Only an
    /// address currently holding the settler role may call this.
    ///
    /// Errors:
    /// - `NotFound` — no receipt exists for `receipt_id`.
    /// - `InvalidPaymentTransition` — receipt is not in `Escrowed` state
    ///   (e.g. already `Settled`).
    ///
    /// Emits a `settle` event whose data is the updated [`PaymentReceipt`]
    /// (with `state: Settled`) so off-chain indexers can confirm settlement
    /// without reading contract storage.
    pub fn settle_payment(env: Env, settler: Address, receipt_id: String) -> Result<(), Error> {
        settler.require_auth();
        if !Self::is_settler(env.clone(), settler) {
            return Err(Error::NotSettler);
        }

        Self::require_not_paused(&env)?;
        Self::validate_receipt_id(&receipt_id)?;

        let receipt_key = DataKey::PaymentReceipt(receipt_id.clone());
        let mut receipt: PaymentReceipt = env
            .storage()
            .persistent()
            .get(&receipt_key)
            .ok_or(Error::NotFound)?;

        if receipt.state != PaymentState::Escrowed {
            return Err(Error::InvalidPaymentTransition);
        }

        receipt.state = PaymentState::Settled;
        env.storage().persistent().set(&receipt_key, &receipt);
        Self::bump_persistent(&env, &receipt_key);

        let deadline = env
            .ledger()
            .sequence()
            .saturating_add(Self::refund_window(env.clone()));
        let deadline_key = DataKey::RefundDeadline(receipt_id.clone());
        env.storage().persistent().set(&deadline_key, &deadline);
        Self::bump_persistent(&env, &deadline_key);
        let recipient_key = DataKey::PaymentRecipient(receipt_id.clone());
        if env.storage().persistent().has(&recipient_key) {
            Self::bump_persistent(&env, &recipient_key);
        }

        env.events()
            .publish((symbol_short!("settle"), receipt_id), receipt);
        Ok(())
    }

    /// Fetch a payment receipt by its `receipt_id`. Errors `NotFound` when no
    /// receipt has been recorded under that id. Bumps the entry's TTL on a
    /// successful read.
    pub fn get_payment(env: Env, receipt_id: String) -> Result<PaymentReceipt, Error> {
        Self::validate_receipt_id(&receipt_id)?;
        let key = DataKey::PaymentReceipt(receipt_id);
        let receipt: PaymentReceipt = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        Self::bump_persistent(&env, &key);
        Ok(receipt)
    }

    /// Fetch the most recent payment receipt recorded for
    /// `(resource_id, payer)`, resolved through the `PaymentIndex` secondary
    /// index. Errors `NotFound` when that pair has no recorded payment.
    /// Bumps the TTL of both the index entry and the receipt on a successful
    /// read.
    pub fn get_payment_receipt(
        env: Env,
        resource_id: String,
        payer: Address,
    ) -> Result<PaymentReceipt, Error> {
        Self::validate_resource_id(&resource_id)?;
        let index_key = DataKey::PaymentIndex(resource_id, payer);
        let receipt_id: String = env
            .storage()
            .persistent()
            .get(&index_key)
            .ok_or(Error::NotFound)?;
        Self::bump_persistent(&env, &index_key);
        Self::get_payment(env, receipt_id)
    }

    /// Record a completed creator-initiated refund for a settled payment.
    /// The transfer must already have occurred; the registry stores its hash
    /// as an audit anchor and does not custody or move USDC.
    pub fn record_creator_refund(
        env: Env,
        creator: Address,
        refund_id: String,
        payment_receipt_id: String,
        recipient: Address,
        amount: i128,
        tx_hash: String,
    ) -> Result<(), Error> {
        creator.require_auth();
        Self::record_refund(
            &env,
            creator,
            refund_id,
            payment_receipt_id,
            recipient,
            amount,
            tx_hash,
            false,
        )
    }

    /// Record a refund under the admin override path. This bypasses the
    /// creator signature and refund deadline, but not payer or amount checks.
    pub fn record_admin_refund(
        env: Env,
        admin: Address,
        refund_id: String,
        payment_receipt_id: String,
        recipient: Address,
        amount: i128,
        tx_hash: String,
    ) -> Result<(), Error> {
        Self::require_current_admin(&env, &admin)?;
        Self::record_refund(
            &env,
            admin,
            refund_id,
            payment_receipt_id,
            recipient,
            amount,
            tx_hash,
            true,
        )
    }

    /// Fetch a refund record by its caller-assigned `refund_id`.
    pub fn get_refund(env: Env, refund_id: String) -> Result<RefundReceipt, Error> {
        Self::validate_receipt_id(&refund_id)?;
        let key = DataKey::RefundReceipt(refund_id);
        let refund: RefundReceipt = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        Self::bump_persistent(&env, &key);
        Ok(refund)
    }

    /// Total amount recorded as refunded for a payment receipt.
    pub fn get_refunded_amount(env: Env, payment_receipt_id: String) -> Result<i128, Error> {
        Self::get_payment(env.clone(), payment_receipt_id.clone())?;
        let key = DataKey::RefundedAmount(payment_receipt_id);
        let refunded = env.storage().persistent().get(&key).unwrap_or(0);
        if env.storage().persistent().has(&key) {
            Self::bump_persistent(&env, &key);
        }
        Ok(refunded)
    }

    /// Exclusive ledger deadline for creator refunds of a settled payment.
    pub fn get_refund_deadline(env: Env, payment_receipt_id: String) -> Result<u32, Error> {
        let payment = Self::get_payment(env.clone(), payment_receipt_id.clone())?;
        if payment.state != PaymentState::Settled {
            return Err(Error::InvalidPaymentTransition);
        }
        let key = DataKey::RefundDeadline(payment_receipt_id);
        if let Some(deadline) = env.storage().persistent().get(&key) {
            Self::bump_persistent(&env, &key);
            Ok(deadline)
        } else {
            Ok(payment
                .recorded_at
                .saturating_add(DEFAULT_REFUND_WINDOW_LEDGERS))
        }
    }

    /// Anchor a purchase receipt hash for `(resource_id, buyer)`.
    ///
    /// This is immutable: duplicate anchors for the same pair error with
    /// `DuplicateReceipt`, so downstream services can treat the first anchor as
    /// canonical. The caller must hold the verifier role.
    pub fn anchor_purchase_receipt(
        env: Env,
        service: Address,
        resource_id: String,
        buyer: Address,
        receipt_hash: String,
    ) -> Result<(), Error> {
        Self::require_anchor_authority(&env, &service)?;
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&resource_id)?;
        if let Some(reason) = Self::anchor_blocker(&env, &resource_id, &buyer, &receipt_hash) {
            return Err(reason.as_error());
        }
        Self::write_anchor(&env, resource_id, buyer, receipt_hash);
        Ok(())
    }

    /// Attempt to anchor a purchase receipt, reporting a rejected attempt as
    /// an on-chain `anchrfail` event instead of reverting.
    ///
    /// `anchor_purchase_receipt` returns an `Error` when the attempt is not
    /// anchorable, and a Soroban error rolls the whole invocation back —
    /// events included — so a settlement service batching many anchors loses
    /// both the surviving anchors and any on-chain trace of what failed. This
    /// variant keeps authorization strict (a non-verifier still reverts, and
    /// so does a malformed `resource_id`) but turns the three *data* failures
    /// — unknown resource, unusable receipt hash, and an already-anchored
    /// `(resource_id, buyer)` pair — into an [`AnchorFailure`] event plus a
    /// `false` return, so monitors can see the rejected attempt and its
    /// reason without replaying the caller's logs.
    ///
    /// Returns `true` and emits the usual `anchor` event on success.
    ///
    ///
    /// Rejected attempts are counted per `(resource_id, buyer)` pair (see
    /// `get_anchor_attempts`). A retry fewer than `ANCHOR_RETRY_BACKOFF_LEDGERS`
    /// ledgers after the last rejection fails fast with reason `RetryTooSoon`,
    /// and once `MAX_ANCHOR_ATTEMPTS` rejections have accumulated every
    /// further call fails fast with reason `AttemptsExhausted`; the attempt
    /// that reaches the cap also emits `anchrxhst`. Both fast failures return
    /// `false` after a single storage read, re-running none of the data checks
    /// and writing nothing, so a permanently failing job stops paying for
    /// resource lookups. A successful anchor clears the counter.
    pub fn attempt_anchor_purchase_receipt(
        env: Env,
        service: Address,
        resource_id: String,
        buyer: Address,
        receipt_hash: String,
    ) -> Result<bool, Error> {
        Self::require_anchor_authority(&env, &service)?;
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&resource_id)?;

        let attempts_key = DataKey::AnchorAttempts(resource_id.clone(), buyer.clone());
        let mut attempts = Self::anchor_attempts_state(&env, &attempts_key);
        let now = env.ledger().sequence();
        let throttled = if attempts.attempts >= MAX_ANCHOR_ATTEMPTS {
            Some(AnchorFailureReason::AttemptsExhausted)
        } else if attempts.attempts > 0
            && now
                < attempts
                    .last_attempt_ledger
                    .saturating_add(ANCHOR_RETRY_BACKOFF_LEDGERS)
        {
            Some(AnchorFailureReason::RetryTooSoon)
        } else {
            None
        };
        if let Some(reason) = throttled {
            let failure = AnchorFailure {
                resource_id: resource_id.clone(),
                buyer,
                receipt_hash,
                reason,
                ledger: now,
            };
            env.events()
                .publish((symbol_short!("anchrfail"), resource_id), failure);
            return Ok(false);
        }

        if let Some(reason) = Self::anchor_blocker(&env, &resource_id, &buyer, &receipt_hash) {
            attempts.attempts += 1;
            attempts.last_attempt_ledger = now;
            env.storage().persistent().set(&attempts_key, &attempts);
            Self::bump_persistent(&env, &attempts_key);

            let failure = AnchorFailure {
                resource_id: resource_id.clone(),
                buyer: buyer.clone(),
                receipt_hash,
                reason,
                ledger: now,
            };
            env.events()
                .publish((symbol_short!("anchrfail"), resource_id.clone()), failure);
            if attempts.attempts >= MAX_ANCHOR_ATTEMPTS {
                // Emitted once per pair, on the attempt that reaches the cap.
                env.events()
                    .publish((symbol_short!("anchrxhst"), resource_id, buyer), attempts);
            }
            return Ok(false);
        }

        Self::write_anchor(&env, resource_id, buyer, receipt_hash);
        Ok(true)
    }

    /// Rejected `attempt_anchor_purchase_receipt` bookkeeping for a pair:
    /// how many attempts have been rejected and at which ledger the last one
    /// was. Both fields are `0` when the pair has never been rejected or its
    /// anchor has since been written.
    pub fn get_anchor_attempts(
        env: Env,
        resource_id: String,
        buyer: Address,
    ) -> Result<AnchorAttempts, Error> {
        Self::validate_resource_id(&resource_id)?;
        let key = DataKey::AnchorAttempts(resource_id, buyer);
        Ok(Self::anchor_attempts_state(&env, &key))
    }

    /// Override a purchase receipt anchor for `(resource_id, buyer)`.
    ///
    /// This method allows the admin to forcibly update an existing purchase receipt
    /// anchor for a given buyer. If no anchor exists, it returns `NotFound`.
    pub fn override_purchase_receipt_anchor(
        env: Env,
        admin: Address,
        resource_id: String,
        buyer: Address,
        new_receipt_hash: String,
    ) -> Result<(), Error> {
        Self::require_current_admin(&env, &admin)?;
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&resource_id)?;

        let key = DataKey::PurchaseReceipt(resource_id.clone(), buyer.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NotFound);
        }

        if new_receipt_hash.is_empty() || new_receipt_hash.len() > MAX_TX_HASH_LEN {
            return Err(Error::InvalidTxHash);
        }

        Self::write_anchor(&env, resource_id, buyer, new_receipt_hash);
        Ok(())
    }

    /// Fetch a purchase receipt anchor for `(resource_id, buyer)`.
    pub fn get_purchase_receipt(
        env: Env,
        resource_id: String,
        buyer: Address,
    ) -> Result<PurchaseReceiptAnchor, Error> {
        Self::validate_resource_id(&resource_id)?;
        let key = DataKey::PurchaseReceipt(resource_id, buyer);
        let anchor = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        Self::bump_persistent(&env, &key);
        Ok(anchor)
    }

    /// Durably record that `(resource_id, buyer)` could not be anchored, so the
    /// buyer can query it with [`get_anchor_failure`}. Only a settler may call
    /// this; see `contract/README.md` for why the settler, and not the revoked
    /// verifier, is the only actor that can report this (#781). Widening
    /// *reporting* to a trusted role does not weaken the invariant that a
    /// roleless address cannot write to the log.
    ///
    /// Last-write-wins. If an anchor already exists the record is cleared and
    /// `Ok(())` returned, so `get_anchor_failure` can never disagree with
    /// `get_purchase_receipt`. Emits `anchrfail` with `reason`
    /// [`AnchorFailureReason::VerifierUnavailable`].
    /// Errors `NotSettler`, `ContractPaused`, `InvalidResourceId`, `NotFound`
    /// (no such resource), or `InvalidTxHash` (empty or over-long hash).
    pub fn record_anchor_failure(
        env: Env,
        settler: Address,
        resource_id: String,
        buyer: Address,
        receipt_hash: String,
    ) -> Result<(), Error> {
        settler.require_auth();
        if !Self::is_settler(env.clone(), settler) {
            return Err(Error::NotSettler);
        }
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&resource_id)?;

        let failure_key = DataKey::AnchorFailure(resource_id.clone(), buyer.clone());
        let anchor_key = DataKey::PurchaseReceipt(resource_id.clone(), buyer.clone());

        // Already anchored: the failure this record would describe has been
        // resolved, so retire the record instead of writing a stale one.
        if env.storage().persistent().has(&anchor_key) {
            if env.storage().persistent().has(&failure_key) {
                env.storage().persistent().remove(&failure_key);
            }
            return Ok(());
        }

        if !env
            .storage()
            .persistent()
            .has(&DataKey::Resource(resource_id.clone()))
        {
            return Err(Error::NotFound);
        }
        if receipt_hash.is_empty() || receipt_hash.len() > MAX_TX_HASH_LEN {
            return Err(Error::InvalidTxHash);
        }

        let failure = AnchorFailure {
            resource_id: resource_id.clone(),
            buyer,
            receipt_hash,
            reason: AnchorFailureReason::VerifierUnavailable,
            ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&failure_key, &failure);
        Self::bump_persistent(&env, &failure_key);
        env.events()
            .publish((symbol_short!("anchrfail"), resource_id), failure);
        Ok(())
    }

    /// Read the anchor-failure record for `(resource_id, buyer)`. Open to
    /// anyone, since a buyer must be able to find their own failure without a
    /// role. Errors `NotFound` when there is no outstanding failure.
    pub fn get_anchor_failure(
        env: Env,
        resource_id: String,
        buyer: Address,
    ) -> Result<AnchorFailure, Error> {
        Self::validate_resource_id(&resource_id)?;
        let key = DataKey::AnchorFailure(resource_id, buyer);
        let failure = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        Self::bump_persistent(&env, &key);
        Ok(failure)
    }

    /// Settle-time retry hook: write the anchor for `(resource_id, buyer)` as
    /// the settler, with no verifier involved. Returns `true` on success.
    ///
    /// The authority granted is strictly *narrower* than the verifier path:
    /// `receipt_hash` must equal the `tx_hash` of the payment already recorded
    /// for the pair, so this can neither anchor a hash no payment backs nor
    /// invent a payment (#781).
    ///
    /// Data problems are reported as in
    /// [`attempt_anchor_purchase_receipt`]: `Ok(false)` plus an `anchrfail`
    /// event and a record, so a settlement loop can call this on every payment
    /// without reverting. The same hash is an idempotent `Ok(true)`; a different
    /// hash reports [`AnchorFailureReason::DuplicateReceipt`].
    ///
    /// Errors `NotSettler`, `ContractPaused`, or `InvalidResourceId`; every
    /// other problem is reported as `Ok(false)`.
    pub fn retry_anchor_purchase_receipt(
        env: Env,
        settler: Address,
        resource_id: String,
        buyer: Address,
        receipt_hash: String,
    ) -> Result<bool, Error> {
        settler.require_auth();
        if !Self::is_settler(env.clone(), settler) {
            return Err(Error::NotSettler);
        }
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&resource_id)?;

        // Resolve the payment this anchor must correspond to.
        let receipt_id: String = match env
            .storage()
            .persistent()
            .get(&DataKey::PaymentIndex(resource_id.clone(), buyer.clone()))
        {
            Some(id) => id,
            None => {
                return Self::report_anchor_failure(
                    &env,
                    resource_id,
                    buyer,
                    receipt_hash,
                    AnchorFailureReason::NoPaymentRecorded,
                );
            }
        };
        let receipt: PaymentReceipt = match env
            .storage()
            .persistent()
            .get(&DataKey::PaymentReceipt(receipt_id))
        {
            Some(receipt) => receipt,
            None => {
                return Self::report_anchor_failure(
                    &env,
                    resource_id,
                    buyer,
                    receipt_hash,
                    AnchorFailureReason::NoPaymentRecorded,
                );
            }
        };

        if receipt_hash.is_empty() || receipt_hash.len() > MAX_TX_HASH_LEN {
            return Self::report_anchor_failure(
                &env,
                resource_id,
                buyer,
                receipt_hash,
                AnchorFailureReason::InvalidReceiptHash,
            );
        }
        if receipt_hash != receipt.tx_hash {
            return Self::report_anchor_failure(
                &env,
                resource_id,
                buyer,
                receipt_hash,
                AnchorFailureReason::ReceiptHashMismatch,
            );
        }

        let anchor_key = DataKey::PurchaseReceipt(resource_id.clone(), buyer.clone());
        let existing: Option<PurchaseReceiptAnchor> = env.storage().persistent().get(&anchor_key);
        if let Some(existing) = existing {
            // Already anchored. Same hash is the desired end state, so a blind
            // retry loop converges; a different hash is a real conflict.
            if existing.receipt_hash == receipt_hash {
                return Ok(true);
            }
            return Self::report_anchor_failure(
                &env,
                resource_id,
                buyer,
                receipt_hash,
                AnchorFailureReason::DuplicateReceipt,
            );
        }

        Self::write_anchor(&env, resource_id, buyer, receipt_hash);
        Ok(true)
    }

    /// Fetch a creator's marketplace terms hash. Errors with `NotFound` if it does not exist.
    /// Bumps the entry's TTL on a successful read.
    pub fn get_terms_hash(env: Env, creator: Address) -> Result<String, Error> {
        let key = DataKey::CreatorTerms(creator);
        if let Some(hash) = env.storage().persistent().get::<DataKey, String>(&key) {
            Self::bump_persistent(&env, &key);
            return Ok(hash);
        }
        // Fall back to the registry-wide canonical terms set by the admin.
        // This gives off-chain callers a single authoritative read path: a
        // creator-specific entry takes precedence; if absent, the vault's
        // listing terms are returned instead of an unconditional NotFound.
        let reg_key = DataKey::RegistryTerms;
        let hash = env
            .storage()
            .persistent()
            .get(&reg_key)
            .ok_or(Error::NotFound)?;
        Self::bump_persistent(&env, &reg_key);
        Ok(hash)
    }

    // ─── Moderator role management (#389) ────────────────────────────────────

    /// Grant the moderator role to `moderator`, authorizing `flag_resource` and
    /// `unflag_resource`. Only the admin may call this. Errors `AdminNotSet` if
    /// no admin has been set yet (see `nominate_new_admin`).
    pub fn add_moderator(env: Env, moderator: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Moderator(moderator.clone()), &true);
        Self::bump_instance(&env);
        env.events().publish(
            (symbol_short!("addmod"), moderator.clone()),
            RoleChange {
                admin: admin,
                target: moderator,
                granted: true,
            },
        );
        Ok(())
    }

    /// Revoke the moderator role from `moderator`. Only the admin may call this.
    pub fn remove_moderator(env: Env, moderator: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Moderator(moderator.clone()), &false);
        Self::bump_instance(&env);
        env.events().publish(
            (symbol_short!("rmmod"), moderator.clone()),
            RoleChange {
                admin: admin,
                target: moderator,
                granted: false,
            },
        );
        Ok(())
    }

    /// Whether `address` currently holds the moderator role.
    pub fn is_moderator(env: Env, address: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Moderator(address))
            .unwrap_or(false)
    }

    // ─── Dispute flagging (#389) ──────────────────────────────────────────────

    /// Flag a resource for dispute. Only an address currently holding the
    /// moderator role (see `add_moderator`) may call this.
    ///
    /// Sets `Resource.dispute_flag` to `Some(reason)`. Flagging is informational:
    /// it does not delist, delete, or restrict the resource — callers may filter
    /// on this field. Calling `flag_resource` on an already-flagged resource
    /// replaces the existing flag with the new reason.
    ///
    /// Emits a `flag` event with `FlagEvent { id, moderator, reason }`.
    ///
    /// Errors deterministically:
    /// - [`Error::Unauthorized`] — caller does not hold the moderator role
    /// - [`Error::NotFound`] — `id` is not a registered resource
    /// - [`Error::InvalidResourceId`] — `id` fails format validation
    pub fn flag_resource(
        env: Env,
        id: String,
        moderator: Address,
        reason: FlagReason,
    ) -> Result<(), Error> {
        moderator.require_auth();
        if !Self::is_moderator(env.clone(), moderator.clone()) {
            return Err(Error::Unauthorized);
        }
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        let was_flagged = resource.dispute_flag.is_flagged();
        resource.dispute_flag = DisputeFlag::Flagged(reason);
        Self::save(&env, &mut resource);
        Self::record_flag_moderator(&env, &id, &moderator);
        env.events().publish(
            (symbol_short!("flag"), id.clone()),
            FlagEvent {
                id,
                moderator,
                reason,
            },
        );
        Ok(())
    }

    /// Remove the dispute flag from a resource. Only an address currently holding
    /// the moderator role (see `add_moderator`) may call this.
    ///
    /// Clears `Resource.dispute_flag` to `None`. If the resource is not currently
    /// flagged this is a no-op (the event is still emitted so off-chain indexers
    /// have a complete audit trail).
    ///
    /// Emits an `unflag` event with the resource `id` as the data payload.
    ///
    /// Errors deterministically:
    /// - [`Error::Unauthorized`] — caller does not hold the moderator role
    /// - [`Error::NotFound`] — `id` is not a registered resource
    /// - [`Error::InvalidResourceId`] — `id` fails format validation
    pub fn unflag_resource(env: Env, id: String, moderator: Address) -> Result<(), Error> {
        moderator.require_auth();
        if !Self::is_moderator(env.clone(), moderator.clone()) {
            return Err(Error::Unauthorized);
        }
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.dispute_flag = DisputeFlag::NoFlag;
        Self::save(&env, &mut resource);
        Self::record_flag_moderator(&env, &id, &moderator);
        env.events()
            .publish((symbol_short!("unflag"), id.clone()), id);
        Ok(())
    }

    /// Store a hash of a moderator's off-chain dispute reason writeup for a
    /// resource. Only an address currently holding the moderator role (see
    /// `add_moderator`) may call this.
    ///
    /// Independent of `flag_resource`'s `FlagReason` code: that's a fixed,
    /// small enum; this carries a digest of free-form off-chain detail (a
    /// longer writeup, evidence links, etc.), the same pattern as
    /// `set_terms_hash`. Calling this again for the same resource replaces
    /// the stored hash. Does not require the resource to currently be
    /// flagged, since a moderator may want to attach detail before or after
    /// calling `flag_resource`.
    ///
    /// Emits a `flagrsn` event with `(moderator, reason_hash)`.
    ///
    /// Errors deterministically:
    /// - [`Error::Unauthorized`] — caller does not hold the moderator role
    /// - [`Error::InvalidResourceId`] — `id` fails format validation
    /// - [`Error::NotFound`] — `id` is not a registered resource
    /// - [`Error::FlagReasonHashTooLong`] — `reason_hash` exceeds `MAX_FLAG_REASON_HASH_LEN`
    pub fn set_flag_reason_hash(
        env: Env,
        id: String,
        moderator: Address,
        reason_hash: String,
    ) -> Result<(), Error> {
        moderator.require_auth();
        if !Self::is_moderator(env.clone(), moderator.clone()) {
            return Err(Error::Unauthorized);
        }
        Self::validate_resource_id(&id)?;
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Resource(id.clone()))
        {
            return Err(Error::NotFound);
        }
        Self::validate_bounded_string(
            &reason_hash,
            0,
            MAX_FLAG_REASON_HASH_LEN,
            Error::FlagReasonHashTooLong,
            Error::FlagReasonHashTooLong,
        )?;

        let key = DataKey::FlagReasonHash(id.clone());
        env.storage().persistent().set(&key, &reason_hash);
        Self::bump_persistent(&env, &key);
        Self::record_flag_moderator(&env, &id, &moderator);

        env.events()
            .publish((symbol_short!("flagrsn"), id), (moderator, reason_hash));
        Ok(())
    }

    /// Fetch the moderator dispute reason hash stored for a resource.
    /// Errors with `NotFound` if none has been set.
    pub fn get_flag_reason_hash(env: Env, id: String) -> Result<String, Error> {
        Self::validate_resource_id(&id)?;
        let key = DataKey::FlagReasonHash(id);
        env.storage().persistent().get(&key).ok_or(Error::NotFound)
    }

    /// Whether a resource currently carries a moderator dispute flag.
    /// Errors with `NotFound` if the resource does not exist.
    pub fn is_flagged(env: Env, id: String) -> Result<bool, Error> {
        Self::validate_resource_id(&id)?;
        Ok(Self::load(&env, &id)?.dispute_flag.is_flagged())
    }

    /// Dispute flag, reason hash, and last acting moderator for a resource in
    /// one read. Errors with `NotFound` if the resource does not exist; a
    /// resource no moderator has touched returns `NoFlag` and two `None`s.
    pub fn flag_details(env: Env, id: String) -> Result<FlagDetails, Error> {
        Self::validate_resource_id(&id)?;
        let resource = Self::load(&env, &id)?;
        let storage = env.storage().persistent();
        Ok(FlagDetails {
            dispute_flag: resource.dispute_flag,
            reason_hash: storage.get(&DataKey::FlagReasonHash(id.clone())),
            last_moderator: storage.get(&DataKey::FlagModerator(id)),
        })
    }

    // ─── Time-limited access leases ──────────────────────────────────────────

    /// Price of a lease of `tier` on `resource_id`: the resource's current
    /// per-request price times the tier's multiplier (`LEASE_*_MULTIPLIER`).
    /// Errors `NotFound` for an unknown resource.
    pub fn lease_price(env: Env, resource_id: String, tier: LeaseTier) -> Result<i128, Error> {
        Self::validate_resource_id(&resource_id)?;
        let resource = Self::load(&env, &resource_id)?;
        Self::tier_price(resource.price, tier)
    }

    /// Record a lease bought by `holder` in `Pending` state, awaiting a
    /// settler's confirmation of the USDC transfer identified by `tx_hash`
    /// (`settle_lease`). The resource must be `Listed` (`ResourceNotListed`),
    /// `amount` must equal `lease_price(resource_id, tier)`
    /// (`LeaseAmountMismatch`), and `holder` must not already hold a pending
    /// or unexpired active lease on the resource (`LeaseAlreadyActive`); an
    /// expired or revoked lease is replaced. Emits `lease`.
    pub fn buy_lease(
        env: Env,
        holder: Address,
        resource_id: String,
        tier: LeaseTier,
        amount: i128,
        tx_hash: String,
    ) -> Result<Lease, Error> {
        holder.require_auth();
        Self::write_lease(
            &env,
            holder,
            resource_id,
            tier,
            amount,
            tx_hash,
            LeaseState::Pending,
        )
    }

    /// Settler-recorded lease: the same checks as `buy_lease`, written
    /// directly in `Active` state because the settler has already confirmed
    /// the payment. Requires the settler role (`NotSettler`) and the holder's
    /// authorization, mirroring `record_payment`. Emits `lease`.
    pub fn record_lease(
        env: Env,
        settler: Address,
        holder: Address,
        resource_id: String,
        tier: LeaseTier,
        amount: i128,
        tx_hash: String,
    ) -> Result<Lease, Error> {
        settler.require_auth();
        if !Self::is_settler(env.clone(), settler) {
            return Err(Error::NotSettler);
        }
        holder.require_auth();
        Self::write_lease(
            &env,
            holder,
            resource_id,
            tier,
            amount,
            tx_hash,
            LeaseState::Active,
        )
    }

    /// Advance a `Pending` lease to `Active` once its payment is confirmed.
    /// Requires the settler role. Errors `NotFound` if no lease exists for
    /// the pair and `InvalidLeaseTransition` if it is not `Pending`. Emits
    /// `leasesetl`.
    pub fn settle_lease(
        env: Env,
        settler: Address,
        resource_id: String,
        holder: Address,
    ) -> Result<Lease, Error> {
        settler.require_auth();
        if !Self::is_settler(env.clone(), settler) {
            return Err(Error::NotSettler);
        }
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&resource_id)?;
        let key = DataKey::Lease(resource_id.clone(), holder);
        let mut lease: Lease = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if lease.state != LeaseState::Pending {
            return Err(Error::InvalidPaymentTransition);
        }
        lease.state = LeaseState::Active;
        env.storage().persistent().set(&key, &lease);
        Self::bump_persistent(&env, &key);
        env.events()
            .publish((symbol_short!("leasesetl"), resource_id), lease.clone());
        Ok(lease)
    }

    /// Revoke a `Pending` or `Active` lease. Only the resource creator may
    /// call this. Revocation is immediate and terminal: `lease_is_active`
    /// returns `false` from this ledger on, and the holder may buy a new
    /// lease afterwards. Errors `NotFound` if no lease exists for the pair
    /// and `InvalidLeaseTransition` if it is already `Revoked`. Emits
    /// `leaserevk`.
    pub fn revoke_lease(env: Env, resource_id: String, holder: Address) -> Result<Lease, Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&resource_id)?;
        let resource = Self::load(&env, &resource_id)?;
        resource.creator.require_auth();
        let key = DataKey::Lease(resource_id.clone(), holder);
        let mut lease: Lease = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if lease.state == LeaseState::Revoked {
            return Err(Error::InvalidPaymentTransition);
        }
        lease.state = LeaseState::Revoked;
        env.storage().persistent().set(&key, &lease);
        Self::bump_persistent(&env, &key);
        env.events()
            .publish((symbol_short!("leaserevk"), resource_id), lease.clone());
        Ok(lease)
    }

    /// Fetch the lease recorded for `(resource_id, holder)`, whatever its
    /// state. Errors `NotFound` if none exists. Bumps the entry's TTL.
    pub fn get_lease(env: Env, resource_id: String, holder: Address) -> Result<Lease, Error> {
        Self::validate_resource_id(&resource_id)?;
        let key = DataKey::Lease(resource_id, holder);
        let lease: Lease = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        Self::bump_persistent(&env, &key);
        Ok(lease)
    }

    /// Whether `holder` currently has access to `resource_id` through a
    /// lease: one exists, it is `Active`, and the current ledger is below
    /// its `expiry_ledger`. Never errors; unknown pairs and malformed ids
    /// simply return `false`.
    pub fn lease_is_active(env: Env, resource_id: String, holder: Address) -> bool {
        if Self::validate_resource_id(&resource_id).is_err() {
            return false;
        }
        match env
            .storage()
            .persistent()
            .get::<DataKey, Lease>(&DataKey::Lease(resource_id, holder))
        {
            Some(lease) => Self::lease_grants_access(&env, &lease),
            None => false,
        }
    }

    /// Extend the TTL of a resource's persistent storage entry.
    ///
    /// Only the resource's current creator (owner) may call this.
    /// Emits a `"ttlext"` event with the `resource_id` as payload.
    pub fn extend_resource_ttl(
        env: Env,
        creator: Address,
        resource_id: String,
    ) -> Result<(), Error> {
        Self::validate_resource_id(&resource_id)?;
        creator.require_auth();
        let resource = Self::load(&env, &resource_id)?;
        if resource.creator != creator {
            return Err(Error::Unauthorized);
        }
        let key = DataKey::Resource(resource_id.clone());
        Self::bump_persistent(&env, &key);
        env.events()
            .publish((symbol_short!("ttlext"), resource_id), ());
        Ok(())
    }

    // ── Issue #804: creator earnings / royalty balance estimator ──────────

    /// Return the total USDC stroops earned by `creator` across all settled
    /// payment receipts for resources they owned at settlement time. The
    /// estimate is a running tally that `settle_payment` increments
    /// atomically, so it is always consistent without re-scanning history.
    ///
    /// Returns a [`CreatorEarningsEstimate`] carrying the creator address,
    /// the total settled amount, and the count of settled receipts included.
    ///
    /// A creator with no settled payments returns `total_settled = 0` and
    /// `settled_count = 0` — this is not an error.
    pub fn creator_earnings_estimate(env: Env, creator: Address) -> CreatorEarningsEstimate {
        let key = DataKey::CreatorEarnings(creator.clone());
        let (total_settled, settled_count): (i128, u32) = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or((0i128, 0u32));
        if total_settled != 0 || settled_count != 0 {
            Self::bump_persistent(&env, &key);
        }
        CreatorEarningsEstimate {
            creator,
            total_settled,
            settled_count,
        }
    }

    // ── Issue #805: paginated verifier status history reads ───────────────

    /// Return a page of verification status changes performed by `verifier`,
    /// in chronological order (oldest first).
    ///
    /// - `cursor` is a 0-based index into the verifier's history list.
    /// - `limit` is capped at [`LIST_PAGE_CAP`] (20).
    /// - `next_cursor` is `Some(next_index)` when more entries exist, or
    ///   `None` at end-of-list.
    ///
    /// A verifier with no recorded history returns an empty page — not an error.
    pub fn get_verifier_status_history(
        env: Env,
        verifier: Address,
        cursor: u32,
        limit: u32,
    ) -> VerifierStatusPage {
        let key = DataKey::VerifierHistory(verifier);
        let history: Vec<VerifierStatusEntry> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        let page_size = limit.min(LIST_PAGE_CAP);
        let total = history.len();
        let mut items: Vec<VerifierStatusEntry> = Vec::new(&env);
        let mut i = cursor;
        while i < total && items.len() < page_size {
            items.push_back(history.get(i).unwrap());
            i += 1;
        }
        let next_cursor = if i < total { Some(i) } else { None };
        if total > 0 {
            Self::bump_persistent(&env, &key);
        }
        VerifierStatusPage { items, next_cursor }
    }

    // ── Issue #806: first-class ResourceState paginated query ─────────────

    /// Paginated list of resources whose lifecycle state exactly matches
    /// `state`. Unlike the boolean `listed` projection, this distinguishes
    /// all five states: `Listed`, `Delisted`, `Frozen`, `Disputed`, and
    /// `Tombstoned`.
    ///
    /// - `cursor` is a 0-based global catalog index (same domain as
    ///   `list_page`'s `cursor`).
    /// - `limit` is capped at [`LIST_PAGE_CAP`] (20).
    /// - Returns a [`CatalogPage`] with `items` and `next_cursor`.
    pub fn list_by_state(
        env: Env,
        state: ResourceState,
        cursor: u32,
        limit: u32,
    ) -> CatalogPage {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut items: Vec<Resource> = Vec::new(&env);
        let mut i = cursor;
        while i < total && items.len() < page_size {
            let idx_key = DataKey::Index(i);
            if let Some(id) = env.storage().persistent().get::<DataKey, String>(&idx_key) {
                Self::bump_persistent(&env, &idx_key);
                let res_key = DataKey::Resource(id);
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&res_key)
                {
                    Self::bump_persistent(&env, &res_key);
                    if resource.state == state {
                        items.push_back(resource);
                    }
                }
            }
            i += 1;
        }
        let next_cursor = if i < total { Some(i) } else { None };
        CatalogPage { items, next_cursor }
    }

    // ── Issue #808: ownership transfer with simultaneous terms handoff ─────

    /// Transfer resource ownership while optionally rebinding the new owner's
    /// terms hash and/or resetting the resource's attestation record
    /// atomically in the same transaction.
    ///
    /// - `id` — resource to transfer.
    /// - `new_creator` — the incoming owner.
    /// - `new_terms_hash` — when `Some`, store this hash under the new
    ///   creator's [`DataKey::CreatorTerms`] entry (max 64 bytes). The
    ///   *old* owner's terms entry is left unchanged.
    /// - `reset_attestation` — when `true`, clear the resource's stored
    ///   attestation hash so the new owner can request fresh verification.
    ///
    /// Behaves identically to `transfer_ownership` when both optional
    /// arguments are `None`/`false`: it errors `AlreadyOwner`, clears any
    /// pending `propose_transfer`, and emits a `transfer` event. It also
    /// emits a `txfrterms` event (even when neither optional action was
    /// taken) so callers who care about terms-aware transfers can index
    /// just that topic.
    ///
    /// Errors:
    /// - [`Error::AlreadyOwner`] — `new_creator` already owns the resource.
    /// - [`Error::TermsHashTooLong`] — `new_terms_hash` exceeds 64 bytes.
    /// - [`Error::ResourceNotMutable`] — resource is `Frozen`, `Disputed`,
    ///   or `Tombstoned`.
    /// - [`Error::ContractPaused`] — the registry is paused.
    pub fn transfer_ownership_with_terms(
        env: Env,
        id: String,
        new_creator: Address,
        new_terms_hash: Option<String>,
        reset_attestation: bool,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::ensure_mutable(&resource)?;
        if resource.creator == new_creator {
            return Err(Error::AlreadyOwner);
        }

        // Validate terms hash length before making any state changes.
        if let Some(ref hash) = new_terms_hash {
            Self::validate_bounded_string(
                hash,
                0,
                MAX_TERMS_HASH_LEN,
                Error::TermsHashTooLong,
                Error::TermsHashTooLong,
            )?;
        }

        let previous_owner = resource.creator.clone();
        resource.creator = new_creator.clone();
        Self::save(&env, &mut resource);
        Self::move_creator_index(&env, &previous_owner, &new_creator, &id, resource.listed);

        // Clear any pending propose_transfer for this resource (same as transfer_ownership).
        let pending_key = DataKey::PendingTransfer(id.clone());
        if env.storage().persistent().has(&pending_key) {
            env.storage().persistent().remove(&pending_key);
        }

        // Optionally bind a terms hash to the new owner.
        let stored_terms = if let Some(ref hash) = new_terms_hash {
            let terms_key = DataKey::CreatorTerms(new_creator.clone());
            env.storage().persistent().set(&terms_key, hash);
            Self::bump_persistent(&env, &terms_key);
            env.events().publish(
                (symbol_short!("setterms"), new_creator.clone()),
                hash.clone(),
            );
            Some(hash.clone())
        } else {
            None
        };

        // Optionally reset the resource's attestation hash.
        if reset_attestation {
            let attestation_key = DataKey::AttestationHash(id.clone());
            if env.storage().persistent().has(&attestation_key) {
                env.storage().persistent().remove(&attestation_key);
            }
        }

        // Emit the basic transfer event for callers that only track ownership.
        env.events().publish(
            (symbol_short!("transfer"), id.clone()),
            (previous_owner.clone(), new_creator.clone()),
        );

        // Emit the terms-aware event for callers that need the full context.
        env.events().publish(
            (Symbol::new(&env, "txfrterms"), id.clone()),
            TransferWithTermsEvent {
                id,
                previous_owner,
                new_owner: new_creator,
                terms_hash: stored_terms,
                attestation_reset: reset_attestation,
            },
        );
        Ok(())
    }
}

impl VaultRegistry {
    fn record_refund(
        env: &Env,
        initiator: Address,
        refund_id: String,
        payment_receipt_id: String,
        recipient: Address,
        amount: i128,
        tx_hash: String,
        admin_override: bool,
    ) -> Result<(), Error> {
        Self::require_not_paused(env)?;
        Self::validate_receipt_id(&refund_id)?;
        Self::validate_receipt_id(&payment_receipt_id)?;
        Self::validate_payment_amount(amount)?;
        Self::validate_tx_hash(&tx_hash)?;

        let refund_key = DataKey::RefundReceipt(refund_id.clone());
        if env.storage().persistent().has(&refund_key) {
            return Err(Error::ReceiptAlreadyExists);
        }
        let refund_tx_key = DataKey::RefundTxHash(tx_hash.clone());
        if env.storage().persistent().has(&refund_tx_key)
            || env
                .storage()
                .persistent()
                .has(&DataKey::PaymentTxHash(tx_hash.clone()))
        {
            return Err(Error::DuplicateTxHash);
        }

        let payment = Self::get_payment(env.clone(), payment_receipt_id.clone())?;
        if payment.state != PaymentState::Settled {
            return Err(Error::InvalidPaymentTransition);
        }
        if recipient != payment.payer {
            return Err(Error::Unauthorized);
        }
        let resource = Self::load(env, &payment.resource_id)?;
        let recipient_key = DataKey::PaymentRecipient(payment_receipt_id.clone());
        let payment_recipient = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&recipient_key)
            .unwrap_or(resource.creator);
        if !admin_override && payment_recipient != initiator {
            return Err(Error::Unauthorized);
        }

        if !admin_override {
            let deadline_key = DataKey::RefundDeadline(payment_receipt_id.clone());
            let deadline = env
                .storage()
                .persistent()
                .get::<DataKey, u32>(&deadline_key)
                .unwrap_or_else(|| {
                    payment
                        .recorded_at
                        .saturating_add(DEFAULT_REFUND_WINDOW_LEDGERS)
                });
            if env.ledger().sequence() >= deadline {
                return Err(Error::InvalidPaymentTransition);
            }
        }

        let refunded_key = DataKey::RefundedAmount(payment_receipt_id.clone());
        let refunded = env
            .storage()
            .persistent()
            .get::<DataKey, i128>(&refunded_key)
            .unwrap_or(0);
        if amount > payment.amount.saturating_sub(refunded) {
            return Err(Error::PaymentAmountMismatch);
        }
        let next_refunded = refunded
            .checked_add(amount)
            .ok_or(Error::PaymentAmountMismatch)?;

        let refund = RefundReceipt {
            refund_id: refund_id.clone(),
            payment_receipt_id,
            resource_id: payment.resource_id,
            recipient,
            amount,
            tx_hash: tx_hash.clone(),
            initiated_by: initiator,
            recorded_at: env.ledger().sequence(),
            admin_override,
        };
        env.storage().persistent().set(&refund_key, &refund);
        Self::bump_persistent(env, &refund_key);
        env.storage()
            .persistent()
            .set(&refunded_key, &next_refunded);
        Self::bump_persistent(env, &refunded_key);
        env.storage().persistent().set(&refund_tx_key, &refund_id);
        Self::bump_persistent(env, &refund_tx_key);

        env.events()
            .publish((symbol_short!("refund"), refund_id), refund);
        Ok(())
    }

    fn validate_price(env: &Env, price: i128) -> Result<(), Error> {
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        if price > MAX_PRICE {
            return Err(Error::PriceExceedsMax);
        }
        // Enforce the minimum creator-share invariant: the price in stroops must
        // strictly exceed the *combined* fee take (platform_fee_bps +
        // royalty_bps) so the creator always receives a positive remainder.
        //
        // Checking only royalty_bps (the old rule) was insufficient: a
        // platform_fee_bps > 0 stacked on top of royalty_bps could consume the
        // entire remaining amount, leaving the creator with zero even when
        // royalty_bps alone was below the price.  No fee config set means no
        // fees are owed, so the check is a no-op until one is configured.
        let combined_fee_bps: i128 = env
            .storage()
            .instance()
            .get::<DataKey, FeeConfig>(&DataKey::FeeConfig)
            .map(|config| i128::from(config.platform_fee_bps + config.royalty_bps))
            .unwrap_or(0);
        if combined_fee_bps >= price {
            return Err(Error::InvalidPrice);
        }
        Ok(())
    }

    fn validate_payment_amount(amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidPaymentAmount);
        }
        Ok(())
    }

    /// Receipt ids are non-empty strings up to `MAX_RECEIPT_ID_LEN` bytes.
    /// No character restrictions beyond length — callers typically use
    /// x402 facilitator receipt identifiers which may contain hyphens, etc.
    fn validate_receipt_id(id: &String) -> Result<(), Error> {
        let len = id.len();
        if len == 0 || len > MAX_RECEIPT_ID_LEN {
            return Err(Error::InvalidReceiptId);
        }
        Ok(())
    }

    /// Transaction hashes are non-empty strings up to `MAX_TX_HASH_LEN` bytes.
    fn validate_tx_hash(tx_hash: &String) -> Result<(), Error> {
        if tx_hash.is_empty() || tx_hash.len() > MAX_TX_HASH_LEN {
            return Err(Error::InvalidTxHash);
        }
        Ok(())
    }

    /// Auth, role, pause, and argument checks shared by `record_payment` and
    /// `record_payment_idempotent`, in the order `record_payment` applies them.
    fn check_payment_args(
        env: &Env,
        settler: &Address,
        receipt_id: &String,
        resource_id: &String,
        payer: &Address,
        amount: i128,
        tx_hash: &String,
    ) -> Result<(), Error> {
        settler.require_auth();
        if !Self::is_settler(env.clone(), settler.clone()) {
            return Err(Error::NotSettler);
        }

        Self::validate_receipt_id(receipt_id)?;
        payer.require_auth();
        Self::require_not_paused(env)?;
        Self::validate_resource_id(resource_id)?;
        Self::validate_payment_amount(amount)?;
        Self::validate_tx_hash(tx_hash)
    }

    /// Store a new `Escrowed` receipt with its secondary indexes and emit the
    /// `payment` event. Callers run `check_payment_args` first.
    fn write_payment(
        env: &Env,
        receipt_id: String,
        resource_id: String,
        payer: Address,
        amount: i128,
        tx_hash: String,
    ) -> Result<PaymentReceipt, Error> {
        // The referenced resource must exist and be for sale: a delisted,
        // frozen, disputed, or tombstoned resource must not accept payments.
        let resource = Self::load(env, &resource_id)?;
        if resource.state != ResourceState::Listed {
            return Err(Error::ResourceNotMutable);
        }

        // Consistency guard: payment amount must match the resource's current price.
        if amount != resource.price {
            return Err(Error::PaymentAmountMismatch);
        }

        let receipt_key = DataKey::PaymentReceipt(receipt_id.clone());
        if env.storage().persistent().has(&receipt_key) {
            return Err(Error::ReceiptAlreadyExists);
        }
        // A single Stellar transaction must settle at most one receipt: the
        // tx hash is the ground truth the facilitator records against, so two
        // receipts with the same tx_hash would double-count one payment.
        let tx_hash_key = DataKey::PaymentTxHash(tx_hash.clone());
        if env.storage().persistent().has(&tx_hash_key) {
            return Err(Error::DuplicateTxHash);
        }
        let receipt = PaymentReceipt {
            receipt_id: receipt_id.clone(),
            resource_id: resource_id.clone(),
            payer: payer.clone(),
            amount,
            state: PaymentState::Escrowed,
            tx_hash,
            recorded_at: env.ledger().sequence(),
            ledger: env.ledger().sequence(),
        };

        env.storage().persistent().set(&receipt_key, &receipt);
        Self::bump_persistent(env, &receipt_key);

        // Secondary indexes: `(resource_id, payer)` -> most recent receipt id
        // (for `get_payment_receipt`), and `tx_hash` -> receipt id (enforces
        // one receipt per Stellar settlement transaction).
        let index_key = DataKey::PaymentIndex(resource_id, payer);
        env.storage().persistent().set(&index_key, &receipt_id);
        Self::bump_persistent(env, &index_key);

        env.storage().persistent().set(&tx_hash_key, &receipt_id);
        Self::bump_persistent(env, &tx_hash_key);

        env.events()
            .publish((symbol_short!("payment"), receipt_id), receipt.clone());
        Ok(receipt)
    }

    fn validate_resource_id(id: &String) -> Result<(), Error> {
        Self::validate_bounded_string(
            id,
            1,
            MAX_RESOURCE_ID_LEN,
            Error::InvalidResourceId,
            Error::InvalidResourceId,
        )?;
        let buf = Self::string_bytes(id);
        for &b in buf.iter() {
            if !(b.is_ascii_lowercase() || b.is_ascii_digit()) {
                return Err(Error::InvalidResourceId);
            }
        }
        Ok(())
    }

    fn is_reserved_id(id: &soroban_sdk::String) -> bool {
        let buf = Self::string_bytes(id);
        let eq_ignore_case = |expected: &[u8]| -> bool {
            if buf.len() != expected.len() {
                return false;
            }
            for i in 0..buf.len() {
                let a = buf[i];
                let b = expected[i];
                if a != b && a != b.wrapping_sub(32) && a.wrapping_sub(32) != b {
                    return false;
                }
            }
            true
        };
        eq_ignore_case(b"admin")
            || eq_ignore_case(b"null")
            || eq_ignore_case(b"registry")
            || eq_ignore_case(b"api")
            || eq_ignore_case(b"index")
            || eq_ignore_case(b"root")
            || eq_ignore_case(b"system")
    }

    fn validate_metadata_pointer(metadata: &String) -> Result<(), Error> {
        Self::validate_bounded_string(
            metadata,
            1,
            MAX_METADATA_POINTER_LEN,
            Error::EmptyMetadata,
            Error::MetadataTooLong,
        )?;
        let buf = Self::string_bytes(metadata);
        let starts_with = |prefix: &[u8]| -> bool {
            if buf.len() < prefix.len() {
                return false;
            }
            buf[..prefix.len()] == *prefix
        };
        if starts_with(b"ipfs://")
            || starts_with(b"ar://")
            || starts_with(b"https://")
            || starts_with(b"http://")
            || starts_with(b"sha256:")
            || starts_with(b"sha-256:")
            || starts_with(b"0x")
        {
            // Enforce that sha256-prefixed pointers carry a 64-hex-char digest.
            let sha256_prefix_len = if starts_with(b"sha-256:") { 8 } else { 7 };
            if starts_with(b"sha256:") || starts_with(b"sha-256:") {
                let hex_part = &buf[sha256_prefix_len..];
                if hex_part.len() != 64 {
                    return Err(Error::InvalidMetadataPointer);
                }
                // All characters in the hex part must be valid hex digits.
                for &b in hex_part {
                    if !b.is_ascii_hexdigit() {
                        return Err(Error::InvalidMetadataPointer);
                    }
                }
            }
            Ok(())
        } else {
            Err(Error::InvalidMetadataPointer)
        }
    }

    fn normalize_attestation_hash(env: &Env, hash: &String) -> Result<String, Error> {
        let bytes = Self::string_bytes(hash);
        let mut separator = None;
        for (idx, byte) in bytes.iter().enumerate() {
            if *byte == b':' {
                separator = Some(idx);
                break;
            }
        }

        if let Some(separator) = separator {
            let algorithm = &bytes[..separator];
            let digest = &bytes[separator + 1..];
            if algorithm.is_empty()
                || algorithm.len() > MAX_ATTESTATION_HASH_ALGORITHM_LEN as usize
                || digest.is_empty()
                || digest.len() > MAX_ATTESTATION_HASH_LEN as usize
            {
                return Err(Error::AttestationHashTooLong);
            }
            for &byte in algorithm {
                if !matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_') {
                    return Err(Error::AttestationHashTooLong);
                }
            }
            return Ok(hash.clone());
        }

        if bytes.is_empty() || bytes.len() > MAX_ATTESTATION_HASH_LEN as usize {
            return Err(Error::AttestationHashTooLong);
        }
        let mut tagged = alloc::vec::Vec::with_capacity(
            DEFAULT_ATTESTATION_HASH_ALGORITHM.len() + 1 + bytes.len(),
        );
        tagged.extend_from_slice(DEFAULT_ATTESTATION_HASH_ALGORITHM.as_bytes());
        tagged.push(b':');
        tagged.extend_from_slice(&bytes);
        Ok(String::from_bytes(env, &tagged))
    }

    /// Normalize every tag in the input list to lowercase ASCII, validate
    /// count and length limits, enforce uniqueness in normalized form, and
    /// return the normalized `Vec<String>`.
    /// Errors `InvalidTag` for empty tags, tags exceeding `MAX_TAG_LEN`,
    /// duplicate normalized tags (including case variants), or more than
    /// `MAX_TAGS` entries.
    fn normalize_and_validate_tags(env: &Env, tags: &Vec<String>) -> Result<Vec<String>, Error> {
        if tags.len() > MAX_TAGS {
            return Err(Error::InvalidTag);
        }
        let mut norm: Vec<String> = Vec::new(env);
        for i in 0..tags.len() {
            let tag = tags.get(i).unwrap();
            Self::validate_bounded_string(
                &tag,
                1,
                MAX_TAG_LEN,
                Error::InvalidTag,
                Error::InvalidTag,
            )?;
            let normalized = Self::normalize_tag(env, &tag);
            Self::validate_bounded_string(
                &normalized,
                1,
                MAX_TAG_LEN,
                Error::InvalidTag,
                Error::InvalidTag,
            )?;
            for j in 0..norm.len() {
                if norm.get(j).unwrap() == normalized {
                    // Two tags that normalize to the same value (e.g. "ML"
                    // and "ml") would index the resource twice under one tag.
                    return Err(Error::InvalidTag);
                }
            }
            norm.push_back(normalized);
        }
        Ok(norm)
    }

    /// Validate a string's byte length while preserving the contract's
    /// caller-visible error for both lower- and upper-bound failures. Keep
    /// all bounded text fields on this helper so future fields cannot drift
    /// into inconsistent boundary handling.
    fn validate_bounded_string(
        value: &String,
        min_len: u32,
        max_len: u32,
        below_min_error: Error,
        above_max_error: Error,
    ) -> Result<(), Error> {
        let len = value.len();
        if len < min_len {
            return Err(below_min_error);
        }
        if len > max_len {
            return Err(above_max_error);
        }
        Ok(())
    }

    /// Materialize Soroban string bytes once for validators that need to
    /// inspect content after a shared length check.
    fn string_bytes(value: &String) -> alloc::vec::Vec<u8> {
        let mut bytes = alloc::vec![0u8; value.len() as usize];
        value.copy_into_slice(&mut bytes);
        bytes
    }

    /// Content and ownership changes are allowed only while a resource is
    /// actively listed or creator-delisted. Frozen, disputed, and tombstoned
    /// resources are preserved as-is until an admin resolves their lifecycle.
    fn ensure_mutable(resource: &Resource) -> Result<(), Error> {
        if matches!(
            resource.state,
            ResourceState::Listed | ResourceState::Delisted
        ) {
            Ok(())
        } else {
            Err(Error::ResourceNotMutable)
        }
    }

    fn transition_creator_state(
        env: &Env,
        resource: &mut Resource,
        next: ResourceState,
    ) -> Result<(), Error> {
        // Check if resource is tombstoned first - tombstoned resources have no outgoing transitions
        if resource.state == ResourceState::Tombstoned {
            return Err(Error::ResourceTombstoned);
        }
        let allowed = matches!(
            (resource.state, next),
            (ResourceState::Listed, ResourceState::Delisted)
                | (ResourceState::Delisted, ResourceState::Listed)
                | (ResourceState::Listed, ResourceState::Frozen)
                | (ResourceState::Delisted, ResourceState::Frozen)
        );
        if !allowed {
            return Err(Error::InvalidLifecycleTransition);
        }
        Self::transition_state(env, resource, next);
        Ok(())
    }

    fn transition_state(env: &Env, resource: &mut Resource, next: ResourceState) {
        let was_listed = resource.state == ResourceState::Listed;
        let becomes_listed = next == ResourceState::Listed;
        resource.state = next;
        resource.listed = becomes_listed;
        Self::save(env, resource);
        // Maintain the listed count indexes, global and per creator.
        if !was_listed && becomes_listed {
            Self::bump_listed_count(env, 1);
            Self::bump_creator_listed_count(env, &resource.creator, 1);
        } else if was_listed && !becomes_listed {
            Self::bump_listed_count(env, -1);
            Self::bump_creator_listed_count(env, &resource.creator, -1);
        }
    }

    /// Adjust the listed-count index by a signed delta. Panics on underflow
    /// (should never happen in production because the delta is always paired
    /// with a prior state check).
    fn bump_listed_count(env: &Env, delta: i32) {
        let current: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ListedCount)
            .unwrap_or(0);
        let next = if delta > 0 {
            current
                .checked_add(delta as u32)
                .expect("listed count overflow")
        } else {
            current
                .checked_sub(delta.unsigned_abs())
                .expect("listed count underflow")
        };
        env.storage().instance().set(&DataKey::ListedCount, &next);
    }

    fn require_current_admin(env: &Env, admin: &Address) -> Result<(), Error> {
        let current = Self::require_admin(env)?;
        if current != *admin {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        Ok(())
    }

    fn load(env: &Env, id: &String) -> Result<Resource, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Resource(id.clone()))
            .ok_or(Error::NotFound)
    }

    /// Remember `moderator` as the last to act on `id`'s moderation state.
    fn record_flag_moderator(env: &Env, id: &String, moderator: &Address) {
        let key = DataKey::FlagModerator(id.clone());
        env.storage().persistent().set(&key, moderator);
        Self::bump_persistent(env, &key);
    }

    fn save(env: &Env, resource: &mut Resource) {
        resource.version = resource.version.checked_add(1).unwrap_or(resource.version);
        resource.updated_at = env.ledger().sequence();
        let key = DataKey::Resource(resource.id.clone());
        env.storage().persistent().set(&key, resource as &Resource);
        Self::bump_persistent(env, &key);
    }

    /// Extend persistent entry TTL when below threshold (Soroban archival safety).
    fn bump_persistent<K>(env: &Env, key: &K)
    where
        K: IntoVal<Env, Val>,
    {
        env.storage()
            .persistent()
            .extend_ttl(key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
    }

    fn creator_key(_env: &Env, creator: &Address) -> DataKey {
        DataKey::CreatorResources(creator.clone())
    }

    /// Walk the global catalog from `cursor`, returning up to `limit` (capped
    /// at `LIST_PAGE_CAP`) resources accepted by `include`, plus the catalog
    /// index to resume from. Every visited entry has its TTL bumped.
    fn scan_catalog(
        env: &Env,
        cursor: u32,
        limit: u32,
        include: impl Fn(&Resource) -> bool,
    ) -> CatalogPage {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut items: Vec<Resource> = Vec::new(env);
        let mut i = cursor;
        while i < total && items.len() < page_size {
            let idx_key = DataKey::Index(i);
            if let Some(id) = env.storage().persistent().get::<DataKey, String>(&idx_key) {
                Self::bump_persistent(env, &idx_key);
                let res_key = DataKey::Resource(id);
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&res_key)
                {
                    Self::bump_persistent(env, &res_key);
                    if include(&resource) {
                        items.push_back(resource);
                    }
                }
            }
            i += 1;
        }
        let next_cursor = if i < total { Some(i) } else { None };
        CatalogPage { items, next_cursor }
    }

    /// Position in `ids` to resume an id-cursor listing from.
    fn resume_position(env: &Env, ids: &Vec<String>, cursor: &IdCursor) -> u32 {
        let total = ids.len();
        let (position, last_id, created_at) = match cursor {
            IdCursor::Start => return 0,
            IdCursor::End => return total,
            IdCursor::After(position, last_id, created_at) => (*position, last_id, *created_at),
        };
        // Fast path: the vector did not shift under the cursor.
        if position < total && ids.get(position).unwrap() == *last_id {
            return position + 1;
        }
        // Entries before the cursor were removed: find the last returned id.
        let mut i = 0u32;
        while i < total {
            if ids.get(i).unwrap() == *last_id {
                return i + 1;
            }
            i += 1;
        }
        // The cursor's own resource was removed. Resume at the first entry
        // registered after it; entries are in registration order, so the
        // first `created_at` above the cursor's is the next unseen one.
        let mut i = 0u32;
        while i < total {
            let id = ids.get(i).unwrap();
            if let Some(resource) = env
                .storage()
                .persistent()
                .get::<DataKey, Resource>(&DataKey::Resource(id))
            {
                if resource.created_at > created_at {
                    return i;
                }
            }
            i += 1;
        }
        // Same-ledger siblings only: fall back to the cursor's former slot.
        position.min(total)
    }

    /// One page of an id-indexed listing (creator or tag index) starting
    /// after `cursor`, including only resources accepted by `include`.
    fn id_page(
        env: &Env,
        ids: &Vec<String>,
        cursor: IdCursor,
        limit: u32,
        include: impl Fn(&Resource) -> bool,
    ) -> IdPage {
        let page_size = limit.min(LIST_PAGE_CAP);
        let mut items: Vec<Resource> = Vec::new(env);
        let mut next_cursor = IdCursor::End;
        if page_size == 0 {
            return IdPage { items, next_cursor };
        }
        let total = ids.len();
        let mut idx = Self::resume_position(env, ids, &cursor);
        while idx < total && items.len() < page_size {
            let id = ids.get(idx).unwrap();
            let res_key = DataKey::Resource(id.clone());
            if let Some(resource) = env
                .storage()
                .persistent()
                .get::<DataKey, Resource>(&res_key)
            {
                Self::bump_persistent(env, &res_key);
                if include(&resource) {
                    next_cursor = IdCursor::After(idx, id, resource.created_at);
                    items.push_back(resource);
                }
            }
            idx += 1;
        }
        // End-of-list once every remaining entry has been visited.
        if idx >= total {
            next_cursor = IdCursor::End;
        }
        IdPage { items, next_cursor }
    }

    fn creator_list(env: &Env, creator: &Address) -> Vec<String> {
        env.storage()
            .persistent()
            .get::<DataKey, Vec<String>>(&Self::creator_key(env, creator))
            .unwrap_or_else(|| Vec::new(env))
    }

    fn append_to_creator_index(env: &Env, creator: &Address, id: String) {
        let mut list = Self::creator_list(env, creator);
        list.push_back(id);
        env.storage()
            .persistent()
            .set(&Self::creator_key(env, creator), &list);
        Self::bump_persistent(env, &Self::creator_key(env, creator));
    }

    fn remove_from_creator_index(env: &Env, creator: &Address, id: &String) {
        let list = Self::creator_list(env, creator);
        let mut out: Vec<String> = Vec::new(env);
        for i in 0..list.len() {
            let v = list.get(i).unwrap();
            if v != *id {
                out.push_back(v);
            }
        }
        env.storage()
            .persistent()
            .set(&Self::creator_key(env, creator), &out);
        Self::bump_persistent(env, &Self::creator_key(env, creator));
    }

    /// Move a resource id from `previous_owner`'s index/count to `new_owner`'s,
    /// keeping `list_by_creator` and `creator_resource_count` in sync with
    /// `Resource.creator` on every ownership change.
    fn move_creator_index(
        env: &Env,
        previous_owner: &Address,
        new_owner: &Address,
        id: &String,
        listed: bool,
    ) {
        Self::remove_from_creator_index(env, previous_owner, id);
        let prev_count = Self::creator_count(env, previous_owner);
        Self::set_creator_count(env, previous_owner, prev_count.saturating_sub(1));

        Self::append_to_creator_index(env, new_owner, id.clone());
        let new_count = Self::creator_count(env, new_owner);
        Self::set_creator_count(env, new_owner, new_count + 1);

        // A listed resource changing hands is one fewer listed for the previous
        // owner and one more for the new one; the global count is unchanged.
        if listed {
            Self::bump_creator_listed_count(env, previous_owner, -1);
            Self::bump_creator_listed_count(env, new_owner, 1);
        }
    }

    fn creator_listed(env: &Env, creator: &Address) -> u32 {
        env.storage()
            .instance()
            .get::<_, u32>(&DataKey::CreatorListedCount(creator.clone()))
            .unwrap_or(0)
    }

    /// Adjust `creator`'s listed-count index by a signed delta. Same contract
    /// as `bump_listed_count`: the delta is always paired with a prior state
    /// check, so underflow would be a logic error and panics.
    fn bump_creator_listed_count(env: &Env, creator: &Address, delta: i32) {
        let current = Self::creator_listed(env, creator);
        let next = if delta > 0 {
            current
                .checked_add(delta as u32)
                .expect("creator listed count overflow")
        } else {
            current
                .checked_sub(delta.unsigned_abs())
                .expect("creator listed count underflow")
        };
        env.storage()
            .instance()
            .set(&DataKey::CreatorListedCount(creator.clone()), &next);
        Self::bump_instance(env);
    }

    fn creator_count(env: &Env, creator: &Address) -> u32 {
        env.storage()
            .instance()
            .get::<_, u32>(&DataKey::CreatorCount(creator.clone()))
            .unwrap_or(0)
    }

    fn set_creator_count(env: &Env, creator: &Address, value: u32) {
        env.storage()
            .instance()
            .set(&DataKey::CreatorCount(creator.clone()), &value);
        Self::bump_instance(env);
    }

    fn add_verifier_internal(env: &Env, admin: &Address, verifier: Address) {
        env.storage()
            .instance()
            .set(&DataKey::Verifier(verifier.clone()), &true);
        Self::bump_instance(env);
        env.events().publish(
            (symbol_short!("addverif"), verifier.clone()),
            RoleChange {
                admin: admin.clone(),
                target: verifier,
                granted: true,
            },
        );
    }

    fn remove_verifier_internal(env: &Env, admin: &Address, verifier: Address) {
        env.storage()
            .instance()
            .set(&DataKey::Verifier(verifier.clone()), &false);
        Self::bump_instance(env);
        env.events().publish(
            (symbol_short!("rmverif"), verifier.clone()),
            RoleChange {
                admin: admin.clone(),
                target: verifier,
                granted: false,
            },
        );
    }

    /// The current admin, or `AdminNotSet` if `nominate_new_admin` has never
    /// been called.
    fn require_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::AdminNotSet)
    }

    /// Both anchor entry points are verifier-gated; neither ever reports an
    /// authorization problem as an `anchrfail` event, because an address that
    /// cannot anchor must not be able to write to the event log either.
    fn require_anchor_authority(env: &Env, service: &Address) -> Result<(), Error> {
        service.require_auth();
        if !Self::is_verifier(env.clone(), service.clone()) {
            return Err(Error::NotVerifier);
        }
        Ok(())
    }

    /// The reason this `(resource_id, buyer)` anchor cannot be written, or
    /// `None` when it can. Shared by `anchor_purchase_receipt` (which turns it
    /// into an `Error`) and `attempt_anchor_purchase_receipt` (which turns it
    /// into an `anchrfail` event), so the two can never disagree about what
    /// counts as anchorable.
    fn anchor_blocker(
        env: &Env,
        resource_id: &String,
        buyer: &Address,
        receipt_hash: &String,
    ) -> Option<AnchorFailureReason> {
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Resource(resource_id.clone()))
        {
            return Some(AnchorFailureReason::ResourceNotFound);
        }
        if receipt_hash.is_empty() || receipt_hash.len() > MAX_TX_HASH_LEN {
            return Some(AnchorFailureReason::InvalidReceiptHash);
        }
        if env.storage().persistent().has(&DataKey::PurchaseReceipt(
            resource_id.clone(),
            buyer.clone(),
        )) {
            return Some(AnchorFailureReason::DuplicateReceipt);
        }
        None
    }

    /// Persist an [`AnchorFailure`] for `(resource_id, buyer)` and emit
    /// `anchrfail`, returning `Ok(false)` so callers can `return` it directly.
    /// Overwrites any earlier record: the newest reason describes the current
    /// attempt, and a pair cannot be both anchored and failing. The record is
    /// the durable half — the event alone is lost if the caller batches.
    fn report_anchor_failure(
        env: &Env,
        resource_id: String,
        buyer: Address,
        receipt_hash: String,
        reason: AnchorFailureReason,
    ) -> Result<bool, Error> {
        let key = DataKey::AnchorFailure(resource_id.clone(), buyer.clone());
        let failure = AnchorFailure {
            resource_id: resource_id.clone(),
            buyer,
            receipt_hash,
            reason,
            ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&key, &failure);
        Self::bump_persistent(env, &key);
        env.events()
            .publish((symbol_short!("anchrfail"), resource_id), failure);
        Ok(false)
    }

    /// Persist an anchor that `anchor_blocker` has already cleared and emit
    /// the `anchor` event.
    fn tier_ledgers(tier: LeaseTier) -> u32 {
        match tier {
            LeaseTier::Hour => LEASE_HOUR_LEDGERS,
            LeaseTier::Day => LEASE_DAY_LEDGERS,
            LeaseTier::Week => LEASE_WEEK_LEDGERS,
        }
    }

    fn tier_price(price: i128, tier: LeaseTier) -> Result<i128, Error> {
        let multiplier = match tier {
            LeaseTier::Hour => LEASE_HOUR_MULTIPLIER,
            LeaseTier::Day => LEASE_DAY_MULTIPLIER,
            LeaseTier::Week => LEASE_WEEK_MULTIPLIER,
        };
        price.checked_mul(multiplier).ok_or(Error::PriceExceedsMax)
    }

    fn lease_grants_access(env: &Env, lease: &Lease) -> bool {
        lease.state == LeaseState::Active && env.ledger().sequence() < lease.expiry_ledger
    }

    /// Validation and storage shared by `buy_lease` and `record_lease`.
    fn write_lease(
        env: &Env,
        holder: Address,
        resource_id: String,
        tier: LeaseTier,
        amount: i128,
        tx_hash: String,
        state: LeaseState,
    ) -> Result<Lease, Error> {
        Self::require_not_paused(env)?;
        Self::validate_resource_id(&resource_id)?;
        Self::validate_payment_amount(amount)?;
        Self::validate_tx_hash(&tx_hash)?;

        let resource = Self::load(env, &resource_id)?;
        if resource.state != ResourceState::Listed {
            return Err(Error::ResourceNotMutable);
        }
        if amount != Self::tier_price(resource.price, tier)? {
            return Err(Error::PaymentAmountMismatch);
        }

        let key = DataKey::Lease(resource_id.clone(), holder.clone());
        if let Some(existing) = env.storage().persistent().get::<DataKey, Lease>(&key) {
            let still_open =
                existing.state == LeaseState::Pending || Self::lease_grants_access(env, &existing);
            if still_open {
                return Err(Error::AlreadyRegistered);
            }
        }

        let now = env.ledger().sequence();
        let lease = Lease {
            resource_id: resource_id.clone(),
            holder,
            tier,
            start_ledger: now,
            expiry_ledger: now.saturating_add(Self::tier_ledgers(tier)),
            amount,
            tx_hash,
            state,
            recorded_at: now,
        };
        env.storage().persistent().set(&key, &lease);
        Self::bump_persistent(env, &key);
        env.events()
            .publish((symbol_short!("lease"), resource_id), lease.clone());
        Ok(lease)
    }

    fn anchor_attempts_state(env: &Env, key: &DataKey) -> AnchorAttempts {
        env.storage()
            .persistent()
            .get(key)
            .unwrap_or(AnchorAttempts {
                attempts: 0,
                last_attempt_ledger: 0,
            })
    }

    fn write_anchor(env: &Env, resource_id: String, buyer: Address, receipt_hash: String) {
        // A written anchor ends the pair's retry history.
        env.storage()
            .persistent()
            .remove(&DataKey::AnchorAttempts(resource_id.clone(), buyer.clone()));
        let key = DataKey::PurchaseReceipt(resource_id.clone(), buyer.clone());
        let anchor = PurchaseReceiptAnchor {
            resource_id: resource_id.clone(),
            buyer: buyer.clone(),
            receipt_hash,
            ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&key, &anchor);
        Self::bump_persistent(env, &key);
        // An anchor existing means the pair is no longer failing. Clearing here
        // keeps `get_anchor_failure` and `get_purchase_receipt` from ever
        // disagreeing, whichever of the three write paths produced the anchor.
        let failure_key = DataKey::AnchorFailure(resource_id.clone(), buyer);
        if env.storage().persistent().has(&failure_key) {
            env.storage().persistent().remove(&failure_key);
        }
        env.events()
            .publish((symbol_short!("anchor"), resource_id), anchor);
    }

    /// Return `ContractPaused` if the emergency pause flag is set.
    ///
    /// Every write method calls this at its entry point. Read-only methods
    /// never call it, so they remain available while the registry is paused.
    fn require_not_paused(env: &Env) -> Result<(), Error> {
        if Self::pause_is_active(env) {
            Err(Error::ContractPaused)
        } else {
            Ok(())
        }
    }

    /// Return whether the registry is paused after applying any scheduled
    /// deadline. Expired deadlines are treated as resumed without requiring a
    /// separate transaction to clear the stored state.
    /// Bumps the instance storage TTL to keep pause entries alive for active monitors.
    fn pause_is_active(env: &Env) -> bool {
        let paused = env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false);

        if !paused {
            // Still bump TTL on read to keep the entry alive
            Self::bump_instance(env);
            return false;
        }

        let result = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::PauseUntil)
            .map(|pause_until| pause_until > env.ledger().timestamp())
            .unwrap_or(true);

        // Bump TTL on read to keep pause entries alive for active monitors
        Self::bump_instance(env);
        result
    }

    /// Normalize a tag for storage and index keying: trim ASCII whitespace and
    /// lowercase ASCII letters.
    fn normalize_tag(env: &Env, tag: &String) -> String {
        let len = tag.len() as usize;
        let mut buf = alloc::vec![0u8; len];
        tag.copy_into_slice(&mut buf);
        let mut start = 0;
        let mut end = buf.len();
        while start < end && buf[start].is_ascii_whitespace() {
            start += 1;
        }
        while end > start && buf[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        let mut normalized = alloc::vec::Vec::with_capacity(end - start);
        for mut b in buf[start..end].iter().copied() {
            if b.is_ascii_uppercase() {
                b = b.to_ascii_lowercase();
            }
            normalized.push(b);
        }
        match core::str::from_utf8(&normalized) {
            Ok(s) => String::from_str(env, s),
            Err(_) => String::from_bytes(env, &normalized),
        }
    }

    fn load_top_tags(env: &Env) -> Vec<TagPopularity> {
        env.storage()
            .instance()
            .get(&DataKey::TopTags)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn tag_popularity_precedes(left: &TagPopularity, right: &TagPopularity) -> bool {
        if left.count != right.count {
            return left.count > right.count;
        }
        Self::string_bytes(&left.tag) < Self::string_bytes(&right.tag)
    }

    fn update_top_tags(env: &Env, tag: &String, count: u32) {
        let mut top = Self::load_top_tags(env);
        let mut existing = None;
        for i in 0..top.len() {
            if top.get(i).unwrap().tag == *tag {
                existing = Some(i);
                break;
            }
        }
        if let Some(index) = existing {
            top.remove_unchecked(index);
        }

        let candidate = TagPopularity {
            tag: tag.clone(),
            count,
        };
        let mut insert_at = top.len();
        for i in 0..top.len() {
            if Self::tag_popularity_precedes(&candidate, &top.get(i).unwrap()) {
                insert_at = i;
                break;
            }
        }

        if existing.is_some() || top.len() < TOP_TAGS_CAP || insert_at < top.len() {
            let mut next: Vec<TagPopularity> = Vec::new(env);
            for i in 0..top.len() {
                if i == insert_at {
                    next.push_back(candidate.clone());
                }
                next.push_back(top.get(i).unwrap());
            }
            if insert_at == top.len() {
                next.push_back(candidate);
            }
            if next.len() > TOP_TAGS_CAP {
                next.remove_unchecked(TOP_TAGS_CAP);
            }
            env.storage().instance().set(&DataKey::TopTags, &next);
        }
    }

    fn increment_tag_popularity(env: &Env, tags: &Vec<String>) {
        if tags.is_empty() {
            return;
        }

        for i in 0..tags.len() {
            let raw_tag = tags.get(i).unwrap();
            let norm = Self::normalize_tag(env, &raw_tag);
            let count_key = DataKey::TagCount(norm.clone());
            let current: u32 = env.storage().instance().get(&count_key).unwrap_or(0);
            let next = current.saturating_add(1);
            env.storage().instance().set(&count_key, &next);
            Self::update_top_tags(env, &norm, next);
        }
        Self::bump_instance(env);
    }

    /// Add `id` to the `TagIndex` entry for each tag in `tags`.
    fn tag_index_add(env: &Env, tags: &Vec<String>, id: &String) {
        for i in 0..tags.len() {
            let raw_tag = tags.get(i).unwrap();
            let norm = Self::normalize_tag(env, &raw_tag);
            let idx_key = DataKey::TagIndex(norm);
            let mut list: Vec<String> = env
                .storage()
                .persistent()
                .get::<DataKey, Vec<String>>(&idx_key)
                .unwrap_or_else(|| Vec::new(env));
            // Avoid duplicates: only add if not already present.
            let mut already = false;
            for j in 0..list.len() {
                if list.get(j).unwrap() == *id {
                    already = true;
                    break;
                }
            }
            if !already {
                list.push_back(id.clone());
                env.storage().persistent().set(&idx_key, &list);
                Self::bump_persistent(env, &idx_key);
            }
        }
    }

    /// Remove `id` from the `TagIndex` entry for each tag in `tags`.
    fn tag_index_remove(env: &Env, tags: &Vec<String>, id: &String) {
        for i in 0..tags.len() {
            let raw_tag = tags.get(i).unwrap();
            let norm = Self::normalize_tag(env, &raw_tag);
            let idx_key = DataKey::TagIndex(norm);
            let existing: Vec<String> = env
                .storage()
                .persistent()
                .get::<DataKey, Vec<String>>(&idx_key)
                .unwrap_or_else(|| Vec::new(env));
            let mut new_list: Vec<String> = Vec::new(env);
            for j in 0..existing.len() {
                let v = existing.get(j).unwrap();
                if v != *id {
                    new_list.push_back(v);
                }
            }
            if new_list.is_empty() {
                if env.storage().persistent().has(&idx_key) {
                    env.storage().persistent().remove(&idx_key);
                }
            } else {
                env.storage().persistent().set(&idx_key, &new_list);
                Self::bump_persistent(env, &idx_key);
            }
        }
    }

    /// Shared registration body. Callers authorize `creator` themselves:
    /// the single-resource entry points do it once per call and
    /// `register_batch` once for the whole batch, so a second `require_auth`
    /// here would be rejected by the host as a duplicate authorization in
    /// the same frame.
    #[allow(clippy::too_many_arguments)]
    fn register_internal(
        env: Env,
        creator: Address,
        id: String,
        price: i128,
        metadata: String,
        tags: Vec<String>,
        content_hash: Option<String>,
        memo_hash: Option<BytesN<32>>,
    ) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        Self::validate_price(&env, price)?;
        Self::validate_resource_id(&id)?;
        Self::validate_metadata_pointer(&metadata)?;
        let norm_tags = Self::normalize_and_validate_tags(&env, &tags)?;
        if Self::is_reserved_id(&id) {
            return Err(Error::ReservedId);
        }
        if let Some(ref hash) = content_hash {
            let hash_len = hash.len();
            if hash_len == 0 || hash_len > MAX_CONTENT_HASH_LEN {
                return Err(Error::ContentHashTooLong);
            }
        }
        let key = DataKey::Resource(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }

        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let next_count = count.checked_add(1).ok_or(Error::CountOverflow)?;

        let cur = Self::creator_count(&env, &creator);
        let next_creator_count = cur.checked_add(1).ok_or(Error::CountOverflow)?;

        let current_listed: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ListedCount)
            .unwrap_or(0);
        let _next_listed = current_listed.checked_add(1).ok_or(Error::CountOverflow)?;

        let current_creator_listed = Self::creator_listed(&env, &creator);
        let _next_creator_listed = current_creator_listed
            .checked_add(1)
            .ok_or(Error::CountOverflow)?;

        let now = env.ledger().sequence();
        let resource = Resource {
            id: id.clone(),
            creator: creator.clone(),
            price,
            metadata: metadata.clone(),
            listed: true,
            state: ResourceState::Listed,
            tags: norm_tags.clone(),
            verified: VerificationStatus::Pending,
            frozen: false,
            metadata_frozen_at: None,
            created_at: now,
            updated_at: now,
            dispute_flag: DisputeFlag::NoFlag,
            schema_version: RESOURCE_SCHEMA_VERSION,
            version: 1,
            content_hash: content_hash.clone(),
            royalty_recipient: None,
        };
        env.storage().persistent().set(&key, &resource);
        Self::bump_persistent(&env, &key);

        // New resources start Listed — track in the listed count indexes.
        Self::bump_listed_count(&env, 1);
        Self::bump_creator_listed_count(&env, &creator, 1);

        let idx_key = DataKey::Index(count);
        env.storage().persistent().set(&idx_key, &id);
        Self::bump_persistent(&env, &idx_key);
        env.storage().instance().set(&DataKey::Count, &next_count);
        Self::bump_instance(&env);

        let mut list = Self::creator_list(&env, &creator);
        list.push_back(id.clone());
        env.storage()
            .persistent()
            .set(&Self::creator_key(&env, &creator), &list);
        Self::bump_persistent(&env, &Self::creator_key(&env, &creator));

        Self::set_creator_count(&env, &creator, next_creator_count);

        // Maintain tag index: add id to each tag's index entry.
        Self::tag_index_add(&env, &norm_tags, &id);
        Self::increment_tag_popularity(&env, &norm_tags);

        let event = RegisterEvent {
            id: id.clone(),
            creator: creator.clone(),
            price,
            metadata,
            listed: true,
            tags: norm_tags,
            content_hash,
        };
        env.events()
            .publish((symbol_short!("register"), id.clone()), event);

        if let Some(memo) = memo_hash {
            let memo_key = DataKey::MemoHash(id.clone());
            env.storage().persistent().set(&memo_key, &memo);
            Self::bump_persistent(&env, &memo_key);
            env.events().publish((symbol_short!("regmemo"), id), memo);
        }
        Ok(())
    }
}

// The TTL policy constants are private (they are policy, not API), so the tests
// reach them through these aliases. See `contracts/vault-registry/README.md`
// ("Storage TTL threshold constants") for what each one means.
#[cfg(test)]
pub(crate) const TTL_DAY_IN_LEDGERS: u32 = DAY_IN_LEDGERS;
#[cfg(test)]
pub(crate) const TTL_BUMP_AMOUNT: u32 = BUMP_AMOUNT;
#[cfg(test)]
pub(crate) const TTL_LIFETIME_THRESHOLD: u32 = LIFETIME_THRESHOLD;

mod test;
