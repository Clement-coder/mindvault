import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}





/**
 * Time-limited access lease: `holder` may access `resource_id` while the
 * lease is `Active` and the current ledger is below `expiry_ledger`.
 */
export interface Lease {
  /**
 * Amount paid in USDC stroops; equals `lease_price` at recording time.
 */
amount: i128;
  /**
 * First ledger at which the lease no longer grants access.
 */
expiry_ledger: u32;
  holder: string;
  /**
 * Ledger sequence at which the lease was recorded.
 */
recorded_at: u32;
  resource_id: string;
  /**
 * Ledger sequence at which the window opened (the recording ledger).
 */
start_ledger: u32;
  state: LeaseState;
  tier: LeaseTier;
  /**
 * Stellar transaction hash of the USDC transfer (non-empty, max 128 bytes).
 */
tx_hash: string;
}


/**
 * One page of an id-indexed listing plus the cursor for the next page.
 */
export interface IdPage {
  items: Array<Resource>;
  next_cursor: IdCursor;
}

export type DataKey = {tag: "Resource", values: readonly [string]} | {tag: "Count", values: void} | {tag: "Index", values: readonly [u32]} | {tag: "Admin", values: void} | {tag: "PendingAdmin", values: void} | {tag: "CreatorTerms", values: readonly [string]} | {tag: "CreatorResources", values: readonly [string]} | {tag: "CreatorCount", values: readonly [string]} | {tag: "PendingTransfer", values: readonly [string]} | {tag: "Verifier", values: readonly [string]} | {tag: "NetworkId", values: void} | {tag: "PaymentReceipt", values: readonly [string]} | {tag: "PaymentIndex", values: readonly [string, string]} | {tag: "PaymentTxHash", values: readonly [string]} | {tag: "PaymentRecipient", values: readonly [string]} | {tag: "RefundReceipt", values: readonly [string]} | {tag: "RefundTxHash", values: readonly [string]} | {tag: "RefundDeadline", values: readonly [string]} | {tag: "RefundedAmount", values: readonly [string]} | {tag: "RefundWindow", values: void} | {tag: "Lease", values: readonly [string, string]} | {tag: "AnchorAttempts", values: readonly [string, string]} | {tag: "RegistryTerms", values: void} | {tag: "Paused", values: void} | {tag: "PauseUntil", values: void} | {tag: "Settler", values: readonly [string]} | {tag: "PurchaseReceipt", values: readonly [string, string]} | {tag: "AnchorFailure", values: readonly [string, string]} | {tag: "TagIndex", values: readonly [string]} | {tag: "FeeConfig", values: void} | {tag: "Moderator", values: readonly [string]} | {tag: "DisputeFlag", values: readonly [string]} | {tag: "ListedCount", values: void} | {tag: "FlagReasonHash", values: readonly [string]} | {tag: "AttestationHash", values: readonly [string]} | {tag: "PendingAdminExpiry", values: void} | {tag: "PendingAdminNominatedAt", values: void} | {tag: "TagCount", values: readonly [string]} | {tag: "TopTags", values: void} | {tag: "CreatorListedCount", values: readonly [string]} | {tag: "MemoHash", values: readonly [string]} | {tag: "FeeDestination", values: void} | {tag: "MetadataPointers", values: readonly [string]} | {tag: "FlagModerator", values: readonly [string]} | {tag: "CreatorEarnings", values: readonly [string]} | {tag: "VerifierHistory", values: readonly [string]} | {tag: "RecoveryAdmin", values: void} | {tag: "Revision", values: readonly [string]} | {tag: "RoleHolders", values: readonly [RoleKind]};

/**
 * Cursor passed to and returned by the id-indexed listings
 * (`list_by_creator_page`, `list_by_tag_page`). Pass `Start` for the first
 * page and each page's `next_cursor` for the following one; `End` back means
 * end-of-list (passing `End` in returns an empty page).
 * 
 * The backing index vectors can lose entries between pages (tombstone,
 * ownership transfer), so a plain position would skip or repeat entries when
 * the vector shifts. `After(position, last_id, created_at)` names the last
 * resource returned instead: its index in the vector when the page was
 * built, its id, and its registration ledger. Resuming looks the id up
 * again: at `position` on the fast path, anywhere in the vector if entries
 * before it were removed, and, if the id itself is gone, at the first entry
 * registered after it (`created_at`), falling back to its former slot.
 */
export type IdCursor = {tag: "Start", values: void} | {tag: "After", values: readonly [u32, string, u32]} | {tag: "End", values: void};


export interface Resource {
  /**
 * Optional immutable digest of the resource's off-chain content, set
 * once at registration via `register_with_hash`. `None` for resources
 * registered through plain `register`.
 */
content_hash: Option<string>;
  /**
 * Ledger sequence number at which this resource was first registered.
 * This value is immutable for the lifetime of the resource.
 */
created_at: u32;
  creator: string;
  /**
 * Active dispute flag set by a moderator, or `DisputeFlag::NoFlag` if the
 * resource is not flagged. Flagging does not delist or delete the resource —
 * it is informational state that callers can filter on. Only a moderator may
 * set or clear this field (see `flag_resource` / `unflag_resource`).
 */
dispute_flag: DisputeFlag;
  /**
 * Once true, `update_metadata` permanently rejects further changes.
 */
frozen: boolean;
  id: string;
  /**
 * Backwards-compatible projection of `state == ResourceState::Listed`.
 */
listed: boolean;
  metadata: string;
  /**
 * Ledger sequence when `freeze_metadata` was first called. `None` until
 * the metadata pointer is frozen.
 */
metadata_frozen_at: Option<u32>;
  /**
 * Listed price in USDC base units ([`USDC_DECIMALS`] = 7).
 */
price: i128;
  /**
 * Optional per-resource royalty recipient override. When set, royalties
 * for this resource go to this address instead of the global fee_recipient.
 * Only the resource creator may set this field via `set_royalty_recipient`.
 */
royalty_recipient: Option<string>;
  /**
 * On-chain `Resource` schema version for decoder compatibility.
 */
schema_version: u32;
  /**
 * Explicit resource lifecycle state. See `contract/README.md` for the
 * transition table and the role allowed to make each transition.
 */
state: ResourceState;
  /**
 * Discovery labels (e.g. "dataset", "research"). Distinct from `metadata`,
 * which remains the off-chain content anchor (IPFS URI, content hash, etc.).
 */
tags: Array<string>;
  /**
 * Ledger sequence number at which this resource was last written
 * (register or any mutation). Clients can use this to detect staleness
 * or order events without trusting off-chain timestamps.
 */
updated_at: u32;
  /**
 * On-chain verification status, settable only by a verifier.
 */
verified: VerificationStatus;
  /**
 * Monotonic write counter, incremented on every persisted mutation.
 * Clients can use it as an optimistic-concurrency token without
 * comparing every field.
 */
version: u32;
}


/**
 * Registry-level fee and royalty configuration.
 */
export interface FeeConfig {
  fee_recipient: Option<string>;
  platform_fee_bps: u32;
  royalty_bps: u32;
}


/**
 * Structured payload emitted by `flag_resource()`.
 */
export interface FlagEvent {
  id: string;
  moderator: string;
  reason: FlagReason;
}

/**
 * Duration tier of a time-limited access lease. Each tier maps to a fixed
 * number of ledgers (`lease_tier_ledgers`) and a price multiplier over the
 * resource's per-request price (`lease_price`).
 * 
 * The discriminants are stable — do not renumber existing variants.
 */
export enum LeaseTier {
  Hour = 0,
  Day = 1,
  Week = 2,
}


/**
 * One bounded page of `export_page`.
 */
export interface ExportPage {
  /**
 * [`EXPORT_VIEW_VERSION`] of the `items` layout.
 */
export_version: u32;
  items: Array<ResourceExport>;
  /**
 * Catalog index to pass back as `cursor`; `None` once the end is reached.
 */
next_cursor: Option<u32>;
  /**
 * `RESOURCE_SCHEMA_VERSION` of the contract that produced the page.
 */
resource_schema_version: u32;
  /**
 * Total catalog index slots (`count`) when the page was read.
 */
total: u32;
}

/**
 * Reason code supplied when a moderator flags a resource for dispute.
 * 
 * The discriminants are stable — do not renumber existing variants.
 */
export enum FlagReason {
  Spam = 0,
  Copyright = 1,
  Malicious = 2,
  Other = 3,
}

/**
 * Protocol role whose holders `role_inventory_page` enumerates.
 *
 * The discriminants are stable — do not renumber existing variants.
 */
export enum RoleKind {
  /**
 * Single-holder contract admin (`admin()`).
 */
  Admin = 0,
  /**
 * Multi-member verifier role (`is_verifier`).
 */
  Verifier = 1,
  /**
 * Multi-member moderator role (`is_moderator`).
 */
  Moderator = 2,
  /**
 * Multi-member settler role (`is_settler`).
 */
  Settler = 3,
}

/**
 * Lifecycle state of an access lease.
 * 
 * `Pending` is a holder-recorded lease awaiting settlement confirmation;
 * `Active` grants access until `expiry_ledger`; `Revoked` is terminal.
 */
export type LeaseState = {tag: "Pending", values: void} | {tag: "Active", values: void} | {tag: "Revoked", values: void};


/**
 * Payload of every role grant/revoke event (`addverif`/`rmverif`,
 * `addsettlr`/`rmsettlr`, `addmod`/`rmmod`). Carries the admin that
 * authorized the change and the affected address so the event log alone
 * is a complete audit trail of role changes.
 */
export interface RoleChange {
  admin: string;
  /**
 * `true` for a grant, `false` for a revocation.
 */
granted: boolean;
  target: string;
}


/**
 * One page of the on-chain catalog plus a cursor for the next page.
 * 
 * `next_cursor` is the catalog index to pass back into `list` / `list_page`
 * as `start`/`cursor`. `None` means end-of-list — clients must not recompute
 * offsets themselves.
 */
export interface CatalogPage {
  items: Array<Resource>;
  next_cursor: Option<u32>;
}

/**
 * Wrapper for an optional [`FlagReason`] value, used as the `dispute_flag`
 * field of [`Resource`]. Soroban's `contracttype` macro requires that all
 * field types are `ScVal`-encodable; `Option<FlagReason>` is not directly
 * supported when `FlagReason` is a custom `contracttype` enum, so we use a
 * two-variant enum instead of native `Option`.
 * 
 * `NoFlag` encodes the absence of a dispute flag (analogous to `None`).
 * `Flagged(FlagReason)` encodes an active flag with a specific reason code.
 */
export type DisputeFlag = {tag: "NoFlag", values: void} | {tag: "Flagged", values: readonly [FlagReason]};


/**
 * A resource's moderation state in one read, returned by `flag_details`.
 */
export interface FlagDetails {
  /**
 * Active dispute flag, or `DisputeFlag::NoFlag`.
 */
dispute_flag: DisputeFlag;
  /**
 * Moderator whose flag, unflag, or reason hash write came last, if any.
 */
last_moderator: Option<string>;
  /**
 * Hash set via `set_flag_reason_hash`, if any.
 */
reason_hash: Option<string>;
}

export type OptFeeConfig = {tag: "None", values: void} | {tag: "Some", values: readonly [FeeConfig]};

/**
 * On-chain record of a single x402/Soroban payment settlement for a resource.
 * 
 * The allowed transition is `Escrowed → Settled`. A receipt starts in
 * `Escrowed` when first recorded and moves to `Settled` once
 * `settle_payment` is called by a settler. Reverting to `Escrowed` or
 * creating a receipt directly in `Settled` state are not permitted
 * (`InvalidPaymentTransition`).
 */
export type PaymentState = {tag: "Escrowed", values: void} | {tag: "Settled", values: void};


/**
 * Structured payload published with the `setprice` event.
 * Includes the resource id, the price before and after the update, and the
 * address that authorised the change — enabling indexers to reconcile price
 * history without re-reading contract storage.
 */
export interface PriceUpdated {
  id: string;
  new_price: i128;
  old_price: i128;
  /**
 * Listing revision after this update (see `get_revision`).
 */
revision: u32;
  updater: string;
}


/**
 * Registry discovery metadata returned by [`VaultRegistry::registry_info`].
 * Lets a client discover the deployed registry's identity and shape with a
 * single read-only call instead of hardcoding assumptions.
 */
export interface RegistryInfo {
  /**
 * Stable, human-readable registry name (`REGISTRY_NAME`).
 */
name: string;
  /**
 * Network passphrase digest of the ledger this contract is running on
 * (`env.ledger().network_id()`), so clients can confirm they are
 * talking to the network they expect without a hardcoded config value.
 */
network_id: Buffer;
  /**
 * Version of the `Resource` schema (`RESOURCE_SCHEMA_VERSION`).
 */
resource_schema_version: u32;
  /**
 * Version of the role-administration capability surface
 * (`ROLE_CAPABILITY_VERSION`). Clients compare this against a known
 * value to detect optional role methods and role features before
 * invoking them.
 */
role_capability_version: u32;
  /**
 * Contract crate version (`CARGO_PKG_VERSION` at build time).
 */
version: string;
}


/**
 * Payload of the `anchrfail` event, also stored durably by
 * [`record_anchor_failure`]. Carries the caller's inputs plus the reason and
 * ledger, so a buyer can reconstruct the attempt from [`get_anchor_failure`].
 */
export interface AnchorFailure {
  buyer: string;
  ledger: u32;
  reason: AnchorFailureReason;
  receipt_hash: string;
  resource_id: string;
}


/**
 * On-chain record of a completed refund transfer associated with a payment.
 * The registry records and caps refunds but does not custody or transfer USDC.
 */
export interface RefundReceipt {
  admin_override: boolean;
  amount: i128;
  initiated_by: string;
  payment_receipt_id: string;
  recipient: string;
  recorded_at: u32;
  refund_id: string;
  resource_id: string;
  tx_hash: string;
}


/**
 * Structured payload emitted by `register()`.
 * 
 * Consumers can reconstruct a full `Resource` from this event without an
 * additional on-chain read.
 */
export interface RegisterEvent {
  content_hash: Option<string>;
  creator: string;
  id: string;
  listed: boolean;
  metadata: string;
  price: i128;
  tags: Array<string>;
}

/**
 * The availability and moderation state of a resource.
 * 
 * `listed` remains on [`Resource`] as a backwards-compatible projection: it
 * is true exactly when this value is [`ResourceState::Listed`]. Clients that
 * need to distinguish a moderation hold from a creator delist must use this
 * field rather than the boolean projection.
 */
export type ResourceState = {tag: "Listed", values: void} | {tag: "Delisted", values: void} | {tag: "Frozen", values: void} | {tag: "Disputed", values: void} | {tag: "Tombstoned", values: void};


/**
 * One `(resource_id, tag)` pair reported by [`VaultRegistry::check_tag_index`].
 */
export interface TagMembership {
  id: string;
  tag: string;
}


export interface TagPopularity {
  count: u32;
  tag: string;
}


/**
 * Rejected-attempt bookkeeping for one `(resource_id, buyer)` anchor pair.
 * Read back by `get_anchor_attempts`; both fields are `0` for a pair that
 * has never been rejected or whose anchor has since been written.
 */
export interface AnchorAttempts {
  /**
 * Rejected attempts so far (never more than `MAX_ANCHOR_ATTEMPTS`).
 */
attempts: u32;
  /**
 * Ledger sequence of the most recent rejected attempt.
 */
last_attempt_ledger: u32;
}

export type FeeDestination = {tag: "None", values: void} | {tag: "Burn", values: void} | {tag: "Charity", values: readonly [string]};


/**
 * A payment receipt anchoring an x402/Soroban settlement to a specific
 * vault resource and payer. Written by an address holding the settler role.
 * 
 * `receipt_id` is a caller-chosen unique identifier (max 64 bytes) —
 * typically the x402 facilitator's own receipt or transaction ID.
 * `tx_hash` is the Stellar transaction hash of the USDC transfer (max 128
 * bytes), present from creation so indexers can verify settlement on-chain
 * without a second round-trip.
 * 
 * Fields are intentionally read-only after recording. To update state,
 * call `settle_payment` which transitions `Escrowed → Settled` and
 * re-emits the receipt as a `settle` event.
 */
export interface PaymentReceipt {
  /**
 * Payment amount in USDC base units, the same unit as
 * [`Resource::price`]; `record_payment` requires exact equality. `> 0`.
 */
amount: i128;
  /**
 * Compatibility alias for `recorded_at`.
 */
ledger: u32;
  /**
 * Stellar address of the party that made the payment.
 */
payer: string;
  /**
 * Caller-assigned unique receipt identifier (max 64 bytes).
 */
receipt_id: string;
  /**
 * Ledger sequence number at which this receipt was first recorded.
 */
recorded_at: u32;
  /**
 * The resource this payment is for.
 */
resource_id: string;
  /**
 * Current lifecycle state of this receipt.
 */
state: PaymentState;
  /**
 * Stellar transaction hash of the USDC transfer (non-empty, max 128 bytes).
 */
tx_hash: string;
}


/**
 * One row of a bounded registry export (`export_page`).
 * 
 * A flattened projection of [`Resource`] for migration tooling: it carries
 * only the fields an indexer needs to rebuild state elsewhere, and never
 * the resource's metadata pointer.
 */
export interface ResourceExport {
  created_at: u32;
  creator: string;
  /**
 * `true` while a moderator dispute flag is active. The flag reason is
 * not exported.
 */
flagged: boolean;
  frozen: boolean;
  id: string;
  /**
 * Catalog index (`DataKey::Index`) the resource was registered under.
 * Strictly increasing within and across pages.
 */
index: u32;
  listed: boolean;
  /**
 * Listed price in USDC base units.
 */
price: i128;
  /**
 * `Resource` storage schema the entry was last written with. Entries
 * below `RESOURCE_SCHEMA_VERSION` still need `migrate_resource`.
 */
schema_version: u32;
  state: ResourceState;
  updated_at: u32;
  verified: VerificationStatus;
  /**
 * Monotonic write counter (`Resource.version`).
 */
version: u32;
}


/**
 * Result of [`VaultRegistry::check_tag_index`]. `missing` lists memberships
 * the resource carries but the tag index does not; `stale` lists memberships
 * the tag index holds that the resource does not carry.
 */
export interface TagIndexReport {
  /**
 * In resource tags but absent from `TagIndex`.
 */
missing: Array<TagMembership>;
  /**
 * Present in `TagIndex` but absent from the resource's tags.
 */
stale: Array<TagMembership>;
}


/**
 * Compact version struct returned by [`VaultRegistry::contract_version`].
 * 
 * Deployment scripts and upgrade tooling should call `contract_version`
 * before and after a redeploy to confirm which build is running on-chain.
 * Only `resource_schema_version` is relevant to whether callers must update
 * their `Resource` decoding logic; a `crate_version` bump alone is safe.
 */
export interface ContractVersion {
  /**
 * Cargo semver string baked in at build time (`CARGO_PKG_VERSION`).
 */
crate_version: string;
  /**
 * On-chain `Resource` schema version (`RESOURCE_SCHEMA_VERSION`).
 * Bump this only when the `Resource` struct changes in a breaking way.
 */
resource_schema_version: u32;
}


/**
 * One page of a deterministic registry-state digest for off-chain indexer
 * reconciliation.
 * 
 * `page_hash` is `sha256` over the versioned preimage described on
 * [`VaultRegistry::state_digest`]. Two indexers that hold the same registry
 * state over the same window will always compute the same `page_hash`;
 * comparing page hashes locates the first window that drifted.
 */
export interface StateDigestPage {
  /**
 * Digest encoding version ([`STATE_DIGEST_ENCODING_VERSION`]).
 */
encoding_version: u32;
  /**
 * Cursor to pass as `start` on the next call, or `None` at end-of-list.
 */
next_cursor: Option<u32>;
  /**
 * `sha256` digest of this page's entries under the versioned encoding.
 */
page_hash: Buffer;
  /**
 * Index of the first entry covered by this page.
 */
start: u32;
  /**
 * Total number of registered resources when the page was computed.
 */
total: u32;
}


/**
 * Input for one item in a batch price update.
 */
export interface BatchPriceUpdate {
  id: string;
  new_price: i128;
}


export interface FeeConfigUpdated {
  new_config: FeeConfig;
  old_config: OptFeeConfig;
}


/**
 * Redundant metadata pointers for a resource, so its content survives a
 * single storage outage. `pointers[primary]` is the preferred pointer and is
 * always equal to `Resource.metadata`.
 */
export interface MetadataPointers {
  pointers: Array<string>;
  primary: u32;
}


export interface VerifierRotation {
  /**
 * Admin that authorized the rotation (the acting account).
 */
admin: string;
  ledger: u32;
  new_verifier: string;
  old_verifier: string;
}


/**
 * Input for a single resource in a batch registration.
 */
export interface BatchRegisterItem {
  content_hash: Option<string>;
  id: string;
  metadata: string;
  price: i128;
  tags: Array<string>;
}

/**
 * On-chain mirror of the server's off-chain verification result. Settable
 * only by an address holding the verifier role (see `add_verifier`).
 */
export type VerificationStatus = {tag: "Pending", values: void} | {tag: "Verified", values: void} | {tag: "Rejected", values: void};


/**
 * One page of verifier status history with a cursor for the next page.
 * Mirrors `CatalogPage` semantics: `next_cursor` is `None` at end-of-list.
 */
export interface VerifierStatusPage {
  items: Array<VerifierStatusEntry>;
  next_cursor: Option<u32>;
}

/**
 * One page of active holders of a protocol role, with a cursor for the next
 * page. Returned by `role_inventory_page`. Mirrors `CatalogPage` semantics:
 * `next_cursor` is `None` at end-of-list. The page is a read-only projection
 * and never mutates role state.
 */
export interface RoleInventoryPage {
  /**
 * Active holders of the requested role, in grant order.
 */
holders: Array<string>;
  /**
 * Index into the role's holder list to pass as `cursor` on the next
 * call, or `None` at end-of-list.
 */
next_cursor: Option<u32>;
}

/**
 * Why an anchor attempt could not write an anchor.
 * 
 * Discriminants are stable — do not renumber existing variants. The first
 * three map 1:1 to the `Error` `anchor_purchase_receipt` returns; the last
 * three are reachable only via the settler entry points.
 */
export enum AnchorFailureReason {
  ResourceNotFound = 0,
  InvalidReceiptHash = 1,
  DuplicateReceipt = 2,
  RetryTooSoon = 3,
  AttemptsExhausted = 4,
  VerifierUnavailable = 5,
  NoPaymentRecorded = 6,
  ReceiptHashMismatch = 7,
}


/**
 * Input for one item in a batch metadata-pointer update.
 */
export interface BatchMetadataUpdate {
  id: string;
  metadata: string;
}


/**
 * Result of a batch registration attempt. Contains successfully registered
 * resource IDs and any errors encountered (with their indices).
 */
export interface BatchRegisterResult {
  /**
 * Indices (into the input batch) of items that failed, paired with their error codes.
 */
failed: Array<readonly [u32, u32]>;
  /**
 * Resource IDs that were successfully registered (in order).
 */
succeeded: Array<string>;
}


/**
 * Event data emitted when a resource's metadata pointer is updated.
 * Carries the resource id, the previous metadata pointer, and the new one
 * so that off-chain indexers can build a full audit trail without querying
 * historical ledger state.
 */
export interface MetadataUpdateEvent {
  id: string;
  new_metadata: string;
  old_metadata: string;
  /**
 * Listing revision after this update (see `get_revision`).
 */
revision: u32;
}


/**
 * A single entry in a verifier's status-change history, stored per verifier.
 * Written by `set_verification_status`; returned by `get_verifier_status_history`.
 */
export interface VerifierStatusEntry {
  /**
 * Attestation hash supplied with this status change, if any.
 */
attestation_hash: Option<string>;
  /**
 * Ledger sequence at which this change was recorded.
 */
ledger: u32;
  /**
 * New status applied.
 */
new_status: VerificationStatus;
  /**
 * Previous status.
 */
old_status: VerificationStatus;
  /**
 * The resource whose verification status changed.
 */
resource_id: string;
}


/**
 * Structured payload emitted by `emergency_delist()`.
 * 
 * Modelled on [`FlagEvent`]: an `id` for the resource, the acting `admin`, and
 * the caller's justification. This is what makes an emergency delist
 * distinguishable from a creator delist at the event boundary — a creator
 * delist emits `setlisted` and nothing else, so an indexer that sees `emdelist`
 * knows an admin took the resource down and can attribute it.
 */
export interface EmergencyDelistEvent {
  admin: string;
  id: string;
  reason: string;
}


export interface FeeDestinationConfig {
  bps: u32;
  destination: FeeDestination;
}


export interface FeeDestinationUpdated {
  ledger: u32;
  new_destination: FeeDestinationConfig;
  old_destination: FeeDestinationConfig;
}


/**
 * Immutable on-chain anchor for a purchase receipt hash.
 */
export interface PurchaseReceiptAnchor {
  buyer: string;
  ledger: u32;
  receipt_hash: string;
  resource_id: string;
}


/**
 * Structured payload emitted by `transfer_ownership_with_terms` (event topic
 * `txfrterms`). Extends the basic `transfer` payload with terms-handoff
 * information so indexers have a full atomic record without extra reads.
 */
export interface TransferWithTermsEvent {
  /**
 * Whether the attestation hash was cleared as part of this transfer.
 */
attestation_reset: boolean;
  id: string;
  new_owner: string;
  previous_owner: string;
  /**
 * The new terms hash set on the incoming owner at the time of transfer.
 * `None` when no `new_terms_hash` was supplied.
 */
terms_hash: Option<string>;
}


/**
 * Aggregated creator earnings returned by `creator_earnings_estimate`.
 * Carries both the address and the total in one read so callers do not need
 * to issue a separate `get_owner` query.
 */
export interface CreatorEarningsEstimate {
  /**
 * The creator whose earnings are aggregated.
 */
creator: string;
  /**
 * Number of settled payment receipts included in `total_settled`.
 */
settled_count: u32;
  /**
 * Sum of all settled payment amounts (in USDC stroops) for resources
 * owned by this creator at the time each payment was settled.
 */
total_settled: i128;
}

export interface Client {
  /**
   * Construct and simulate a get transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch a resource. Errors with `NotFound` if it does not exist.
   */
  get: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Resource>>>

  /**
   * Construct and simulate a list transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated resource list in insertion order. `limit` is capped at 20.
   * 
   * Kept for callers that only need the page body. Prefer `list_page` when
   * the client must know the next cursor / end-of-list without recomputing
   * offsets.
   */
  list: ({start, limit}: {start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Resource>>>

  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current contract admin.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Total number of resources successfully registered (monotonic; not decremented on transfer).
   */
  count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a delist transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Delist a resource (convenience method for set_listed(false)). Only the creator may call this.
   */
  delist: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a exists transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether a resource with `id` is registered.
   */
  exists: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a get_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read several resources in one invocation, preserving input order.
   * Missing resources are represented by `None`; valid resources are
   * returned as `Some(Resource)`. The batch is capped to bound execution
   * and response size.
   */
  get_many: ({ids}: {ids: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<Option<Resource>>>>>

  /**
   * Construct and simulate a register transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a new resource. Price is in USDC base units (7 decimals).
   * Rejects `price <= 0` (`InvalidPrice`) or `price > MAX_PRICE` (`PriceExceedsMax`).
   * Requires the creator's authorization.
   * 
   * Equivalent to `register_with_hash` with `content_hash = None`.
   */
  register: ({creator, id, price, metadata, tags}: {creator: string, id: string, price: i128, metadata: string, tags: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_tags transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Replace a resource's discovery tags. Only the creator may call this.
   * Does not modify `metadata` (the off-chain content pointer).
   * Tags are normalized to lowercase ASCII before storage; the normalized
   * form is what gets indexed and returned from `list_by_tag`.
   * 
   * No-op guard: if the normalized `tags` are identical to the resource's
   * current tags (same values, same order), the call succeeds without
   * touching storage or emitting a `settags` event.
   */
  set_tags: ({id, tags}: {id: string, tags: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a top_tags transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  top_tags: ({limit}: {limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<TagPopularity>>>

  /**
   * Construct and simulate a buy_lease transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a lease bought by `holder` in `Pending` state, awaiting a
   * settler's confirmation of the USDC transfer identified by `tx_hash`
   * (`settle_lease`). The resource must be `Listed` (`ResourceNotListed`),
   * `amount` must equal `lease_price(resource_id, tier)`
   * (`LeaseAmountMismatch`), and `holder` must not already hold a pending
   * or unexpired active lease on the resource (`LeaseAlreadyActive`); an
   * expired or revoked lease is replaced. Emits `lease`.
   */
  buy_lease: ({holder, resource_id, tier, amount, tx_hash}: {holder: string, resource_id: string, tier: LeaseTier, amount: i128, tx_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Lease>>>

  /**
   * Construct and simulate a get_lease transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch the lease recorded for `(resource_id, holder)`, whatever its
   * state. Errors `NotFound` if none exists. Bumps the entry's TTL.
   */
  get_lease: ({resource_id, holder}: {resource_id: string, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Lease>>>

  /**
   * Construct and simulate a get_owner transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Get the owner address of a resource. Errors with `NotFound` if it does not exist.
   */
  get_owner: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a is_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether the registry is currently paused. Returns `false` when the
   * pause flag has never been set. Never blocked by the pause itself.
   */
  is_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a list_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated catalog page with next-cursor metadata.
   * 
   * - `cursor` is a 0-based catalog index (same domain as `list`'s `start`).
   * - `limit` is capped at 20.
   * - `next_cursor` is `Some(next_index)` when more entries may exist after
   * this page, or `None` at end-of-list (including empty catalog / cursor
   * past the end).
   */
  list_page: ({cursor, limit}: {cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<CatalogPage>>

  /**
   * Construct and simulate a set_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update a resource's price. Rejects `new_price <= 0` or `new_price > MAX_PRICE`.
   * Only the creator may call this.
   * 
   * Emits a `setprice` event whose data is a [`PriceUpdated`] value
   * containing `id`, `old_price`, `new_price`, and `updater`.
   * 
   * No-op guard: if `new_price` is identical to the resource's current
   * price, the call succeeds without touching storage or emitting a
   * `setprice` event.
   */
  set_price: ({id, new_price}: {id: string, new_price: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch a refund record by its caller-assigned `refund_id`.
   */
  get_refund: ({refund_id}: {refund_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<RefundReceipt>>>

  /**
   * Construct and simulate a is_flagged transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether a resource currently carries a moderator dispute flag.
   * Errors with `NotFound` if the resource does not exist.
   */
  is_flagged: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a is_settler transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `address` currently holds the settler role.
   */
  is_settler: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a network_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the initialized network identifier. Callers can use this value
   * as a deployment guard before submitting network-sensitive operations.
   */
  network_id: (options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a set_listed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set a resource's creator-controlled listing state. Only
   * `Listed <-> Delisted` transitions are accepted; all other lifecycle
   * states reject this method with `InvalidLifecycleTransition`.
   */
  set_listed: ({id, listed}: {id: string, listed: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set or clear the emergency pause on all registry mutations.
   * 
   * When `paused` is `true` every write method returns
   * [`Error::ContractPaused`] without modifying any state. Read-only
   * methods are unaffected and remain fully available.
   * 
   * Requires the current admin's authorization. Errors `AdminNotSet` if no
   * admin has been set yet, and `Unauthorized` if `admin` is not the
   * current admin.
   * 
   * Emits a `pause` event with data `(paused: bool, admin: Address)` on
   * every call, including no-op transitions, so off-chain monitors can
   * detect rapid pause/unpause cycles.
   */
  set_paused: ({admin, paused}: {admin: string, paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a add_settler transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grant the settler role to `settler`, authorizing `record_payment` and
   * `settle_payment`. Only the admin may call this. Errors `AdminNotSet`
   * if no admin has been set yet.
   */
  add_settler: ({settler}: {settler: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a exists_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch existence check. Returns a `Vec<bool>` parallel to `ids`:
   * `result[i]` is `true` iff a resource with `ids[i]` is registered.
   * 
   * Semantics match `exists` for each element: IDs that fail format
   * validation are treated as absent (`false`) rather than erroring.
   * TTL is bumped for every ID that resolves to a registered resource,
   * keeping the hot entries alive exactly as a sequence of individual
   * `exists` calls would.
   * 
   * This is useful for server-side bulk validation before publishing or
   * reconciliation — callers can check many IDs in a single contract
   * invocation instead of one round-trip per ID.
   */
  exists_many: ({ids}: {ids: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Array<boolean>>>

  /**
   * Construct and simulate a export_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Bounded, deterministic export of every resource for migration and
   * audit tooling, in catalog index order.
   * 
   * - Each call reads at most `EXPORT_PAGE_CAP` index slots, starting at
   * `cursor`. `limit` is clamped to `1..=EXPORT_PAGE_CAP`, so a `0` limit
   * still makes progress instead of returning the same cursor forever.
   * - Every lifecycle state is exported, including `Delisted`, `Frozen`,
   * `Disputed`, and `Tombstoned`: a migration must see the whole registry,
   * not only what is for sale.
   * - Entries are read without the schema guard used by mutations, so a
   * resource still on an older `schema_version` is exported (and can be
   * found and migrated) rather than failing the page.
   * - The same storage always yields the same pages. `next_cursor` is the
   * next index slot to read, or `None` at the end.
   * - Only the [`ResourceExport`] allowlist is returned; no private values.
   * - Read-only and available while the contract is paused.
   */
  export_page: ({cursor, limit}: {cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<ExportPage>>

  /**
   * Construct and simulate a get_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch a payment receipt by its `receipt_id`. Errors `NotFound` when no
   * receipt has been recorded under that id. Bumps the entry's TTL on a
   * successful read.
   */
  get_payment: ({receipt_id}: {receipt_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PaymentReceipt>>>

  /**
   * Construct and simulate a is_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `address` currently holds the verifier role.
   */
  is_verifier: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a lease_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Price of a lease of `tier` on `resource_id`: the resource's current
   * per-request price times the tier's multiplier (`LEASE_*_MULTIPLIER`).
   * Errors `NotFound` for an unknown resource.
   */
  lease_price: ({resource_id, tier}: {resource_id: string, tier: LeaseTier}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a list_by_tag transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the resource ids tagged with `tag` (normalized to lowercase),
   * paginated by `start`/`limit`. `limit` is capped at 20. Resources are
   * returned in the order they were added to the tag index (insertion
   * order per tag). If the tag has never been assigned to any resource
   * returns an empty vec. Each resource entry that is read has its TTL
   * bumped to keep hot resources alive.
   */
  list_by_tag: ({tag, start, limit}: {tag: string, start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Resource>>>

  /**
   * Construct and simulate a list_listed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated list of resources whose `listed` flag is true, in insertion order.
   * 
   * - Resources are ordered by registration sequence.
   * - `limit` is capped at `20`.
   * - Delisted resources are skipped; relisted resources will reappear.
   * - Returns an empty `Vec` if no listed resources fall in range.
   */
  list_listed: ({start, limit}: {start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Resource>>>

  /**
   * Construct and simulate a pause_until transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The active scheduled pause deadline, if one exists.
   * Bumps the instance storage TTL to keep the entry alive for active monitors.
   */
  pause_until: (options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Accept the pending admin nomination and become the contract admin.
   * Only the pending admin may call this.
   */
  accept_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a add_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grant the verifier role to `verifier`, authorizing `set_verification_status`.
   * Only the admin may call this. Errors `AdminNotSet` if no admin has
   * been set yet (see `nominate_new_admin`).
   */
  add_verifier: ({verifier}: {verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a flag_details transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dispute flag, reason hash, and last acting moderator for a resource in
   * one read. Errors with `NotFound` if the resource does not exist; a
   * resource no moderator has touched returns `NoFlag` and two `None`s.
   */
  flag_details: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<FlagDetails>>>

  /**
   * Construct and simulate a get_revision transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Monotonic listing revision for a resource. Starts at `0` and
   * increments by exactly one on every successful metadata or price
   * mutation; rejected calls leave it unchanged. Errors `NotFound` when
   * the resource does not exist.
   */
  get_revision: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a is_moderator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `address` currently holds the moderator role.
   */
  is_moderator: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a role_inventory_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Bounded, read-only page of the active holders of a protocol role.
   */
  role_inventory_page: ({role, cursor, limit}: {role: RoleKind, cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<RoleInventoryPage>>

  /**
   * Construct and simulate a listed_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of resources currently in the Listed state.
   */
  listed_count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a open_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Place an active resource under an admin-controlled dispute hold.
   */
  open_dispute: ({id, admin}: {id: string, admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a record_lease transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settler-recorded lease: the same checks as `buy_lease`, written
   * directly in `Active` state because the settler has already confirmed
   * the payment. Requires the settler role (`NotSettler`) and the holder's
   * authorization, mirroring `record_payment`. Emits `lease`.
   */
  record_lease: ({settler, holder, resource_id, tier, amount, tx_hash}: {settler: string, holder: string, resource_id: string, tier: LeaseTier, amount: i128, tx_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Lease>>>

  /**
   * Construct and simulate a repair_index transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rebuild the pagination index (`list`/`list_page`/`count`) from an
   * authoritative, admin-supplied ordered list of resource ids. Only the
   * admin may call this. Every id must already exist as a registered
   * `Resource` (else `NotFound`) and the list must not contain duplicates
   * (else `DuplicateInRepair`). Never touches `Resource` storage itself —
   * only rewrites the derived `Index`/`Count` pointers, so it's safe to
   * re-run with the current correct id list as a no-op. See
   * `docs/index-repair.md` for the full repair strategy.
   */
  repair_index: ({ids}: {ids: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_lease transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke a `Pending` or `Active` lease. Only the resource creator may
   * call this. Revocation is immediate and terminal: `lease_is_active`
   * returns `false` from this ledger on, and the holder may buy a new
   * lease afterwards. Errors `NotFound` if no lease exists for the pair
   * and `InvalidLeaseTransition` if it is already `Revoked`. Emits
   * `leaserevk`.
   */
  revoke_lease: ({resource_id, holder}: {resource_id: string, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Lease>>>

  /**
   * Construct and simulate a settle_lease transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Advance a `Pending` lease to `Active` once its payment is confirmed.
   * Requires the settler role. Errors `NotFound` if no lease exists for
   * the pair and `InvalidLeaseTransition` if it is not `Pending`. Emits
   * `leasesetl`.
   */
  settle_lease: ({settler, resource_id, holder}: {settler: string, resource_id: string, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Lease>>>

  /**
   * Construct and simulate a state_digest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated, deterministic digest of registry entries for off-chain
   * indexer reconciliation. Walks the catalog insertion index exactly like
   * `list_page`, covering `min(limit, MAX_DIGEST_PAGE)` entries starting at
   * `start`, and returns a versioned [`StateDigestPage`].
   * 
   * `page_hash` is `sha256` over this preimage (encoding version 1):
   * 
   * ```text
   * STATE_DIGEST_DOMAIN
   * || u32_be(total) || u32_be(start)
   * || for each entry in the window, in index order:
   * u32_be(len(id))       || id
   * || i128_be(price)
   * || u32_be(len(metadata)) || metadata
   * || u32_be(state as u32) || u8(frozen as u8)
   * || u32_be(version)    || u32_be(updated_at)
   * || u8(has_content_hash)
   * || (if has_content_hash: u32_be(len(hash)) || hash)
   * ```
   * 
   * The encoding is deterministic for the same registry state and bounded
   * per call. A client verifies a page by reconstructing this preimage from
   * `get`/`list_page` output and comparing `sha256(preimage)` to
   * `page_hash`; see `state_digest_client_verification_roundtrip` in the
   * contract tests for a worked example.
   */
  state_digest: ({start, limit}: {start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<StateDigestPage>>

  /**
   * Construct and simulate a add_moderator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grant the moderator role to `moderator`, authorizing `flag_resource` and
   * `unflag_resource`. Only the admin may call this. Errors `AdminNotSet` if
   * no admin has been set yet (see `nominate_new_admin`).
   */
  add_moderator: ({moderator}: {moderator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a flag_resource transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Flag a resource for dispute. Only an address currently holding the
   * moderator role (see `add_moderator`) may call this.
   * 
   * Sets `Resource.dispute_flag` to `Some(reason)`. Flagging is informational:
   * it does not delist, delete, or restrict the resource — callers may filter
   * on this field. Calling `flag_resource` on an already-flagged resource
   * replaces the existing flag with the new reason.
   * 
   * Emits a `flag` event with `FlagEvent { id, moderator, reason }`.
   * 
   * Errors deterministically:
   * - [`Error::Unauthorized`] — caller does not hold the moderator role
   * - [`Error::NotFound`] — `id` is not a registered resource
   * - [`Error::InvalidResourceId`] — `id` fails format validation
   */
  flag_resource: ({id, moderator, reason}: {id: string, moderator: string, reason: FlagReason}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_memo_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the memo hash recorded for a resource at registration, if it was
   * registered through `register_with_memo` with one. `None` for every
   * other resource and for ids that are unknown or malformed.
   */
  get_memo_hash: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Buffer>>>

  /**
   * Construct and simulate a list_by_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated list of resources whose lifecycle state exactly matches
   * `state`. Unlike the boolean `listed` projection, this distinguishes
   * all five states: `Listed`, `Delisted`, `Frozen`, `Disputed`, and
   * `Tombstoned`.
   * 
   * - `cursor` is a 0-based global catalog index (same domain as
   * `list_page`'s `cursor`).
   * - `limit` is capped at [`LIST_PAGE_CAP`] (20).
   * - Returns a [`CatalogPage`] with `items` and `next_cursor`.
   */
  list_by_state: ({state, cursor, limit}: {state: ResourceState, cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<CatalogPage>>

  /**
   * Construct and simulate a pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pending nominated contract admin.
   */
  pending_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a recover_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Replace a lost admin key. Only the recovery admin may call this.
   * Sets `new_admin` as admin immediately and clears any pending admin
   * nomination. The recovery admin itself is unchanged. Errors
   * `AdminNotSet`, `AdminNotSet`, or `SameAdmin`. Emits `recover`.
   */
  recover_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a refund_window transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Current creator refund window in ledgers. Defaults to one day.
   */
  refund_window: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a registry_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Discover this registry's stable identity and capabilities in one
   * read-only call: name, crate version, `Resource` schema version, and
   * the network this contract is deployed on. Always succeeds — there is
   * no failure mode a caller needs to handle.
   */
  registry_info: (options?: MethodOptions) => Promise<AssembledTransaction<RegistryInfo>>

  /**
   * Construct and simulate a get_fee_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the registry-level fee / royalty configuration. Returns `None`
   * if `set_fee_config` has never been called.
   */
  get_fee_config: (options?: MethodOptions) => Promise<AssembledTransaction<Option<FeeConfig>>>

  /**
   * Construct and simulate a get_owner_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch owner lookup. Returns a `Vec<Option<Address>>` parallel to `ids`.
   * Missing resources are `None`; invalid resource ids fail the whole call,
   * matching `get_many` and keeping malformed multi-select requests visible.
   */
  get_owner_many: ({ids}: {ids: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<Option<string>>>>>

  /**
   * Construct and simulate a get_terms_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch a creator's marketplace terms hash. Errors with `NotFound` if it does not exist.
   * Bumps the entry's TTL on a successful read.
   */
  get_terms_hash: ({creator}: {creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a record_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record an x402/Soroban payment receipt in `Escrowed` state. Only an
   * address currently holding the settler role may call this.
   * 
   * - `receipt_id` must be unique (max 64 bytes, non-empty); duplicate ids
   * error `ReceiptAlreadyExists`. Use `record_payment_idempotent` for a
   * retry-safe variant that returns the stored receipt instead.
   * - `resource_id` must refer to an existing registered resource
   * (`NotFound` otherwise).
   * - `amount` must be `> 0` (`InvalidPaymentAmount` otherwise).
   * - `amount` must match the resource's current price
   * (`PaymentAmountMismatch` otherwise).
   * - `tx_hash` must be non-empty and at most 128 bytes (`InvalidTxHash`).
   * - `tx_hash` must not already back another receipt (`DuplicateTxHash`).
   * 
   * Emits a `payment` event whose data is the full [`PaymentReceipt`] so
   * off-chain indexers can index the receipt without reading contract
   * storage.
   * 
   * Provenance: this entry point cannot prove which resource the settlement
   * transaction paid for, so it also emits a `nomemo` warning event. Prefer
   * `record_payment_with_memo`, whi
   */
  record_payment: ({settler, receipt_id, resource_id, payer, amount, tx_hash}: {settler: string, receipt_id: string, resource_id: string, payer: string, amount: i128, tx_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a recovery_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The configured recovery admin, if any.
   */
  recovery_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a register_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register multiple resources in a single transaction. The batch is capped
   * at [`MAX_BATCH_REGISTER`] (10) to bound execution cost. All resources
   * are registered under the same `creator`.
   * 
   * Returns a [`BatchRegisterResult`] containing:
   * - `succeeded`: IDs of successfully registered resources
   * - `failed`: Indices and error codes of failed registrations
   * 
   * This function continues processing after individual failures, allowing
   * partial success. The creator is authorized once at the start, and each
   * resource is validated independently. Common failure causes include
   * duplicate IDs, invalid prices, or invalid metadata pointers.
   * 
   * A batch that repeats any id is rejected up front with
   * `AlreadyRegistered` and leaves resource records, counters, indexes, and
   * events unchanged — see the within-batch duplicate guard below.
   * 
   * Use case: Bulk onboarding of resources by publishers or automated systems.
   */
  register_batch: ({creator, items}: {creator: string, items: Array<BatchRegisterItem>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<BatchRegisterResult>>>

  /**
   * Construct and simulate a remove_settler transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke the settler role from `settler`. Only the admin may call this.
   */
  remove_settler: ({settler}: {settler: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Advance a payment receipt from `Escrowed` to `Settled`. Only an
   * address currently holding the settler role may call this.
   * 
   * Errors:
   * - `NotFound` — no receipt exists for `receipt_id`.
   * - `InvalidPaymentTransition` — receipt is not in `Escrowed` state
   * (e.g. already `Settled`).
   * 
   * Emits a `settle` event whose data is the updated [`PaymentReceipt`]
   * (with `state: Settled`) so off-chain indexers can confirm settlement
   * without reading contract storage.
   */
  settle_payment: ({settler, receipt_id}: {settler: string, receipt_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set the registry-level fee / royalty configuration. Only the admin may
   * call this. Errors `AdminNotSet` if no admin has been set yet.
   * 
   * Both `platform_fee_bps` and `royalty_bps` must be ≤ [`MAX_FEE_BPS`]
   * (5 000 bp = 50 %) individually, **and** their sum must also be ≤
   * [`MAX_FEE_BPS`]. Violating either bound errors `FeeBpsTooHigh` (for an
   * individual field out of range) or `TotalFeeTooHigh` (for a valid
   * individual pair whose sum exceeds the ceiling).
   * 
   * Together with the price-validation rule (`price > platform_fee_bps +
   * royalty_bps`), this guarantees the creator always receives a positive
   * remainder of at least [`MIN_CREATOR_SHARE_BPS`] (50 %) on every sale.
   * 
   * Stores the config under the singleton [`DataKey::FeeConfig`] instance
   * entry and emits a `setfee` event carrying the old config (or `None` on
   * first set) and the new config, so off-chain indexers have a full
   * audit trail.
   */
  set_fee_config: ({config}: {config: FeeConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_price_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update prices for multiple resources owned by `creator` in one call.
   * The creator authorizes the invocation once, and every item is
   * validated before any price is written. If one item is invalid, no
   * prices are changed. Duplicate IDs use the last supplied price.
   * 
   * The batch is capped at [`MAX_BATCH_PRICE_UPDATES`] items. A no-op price
   * update succeeds without writing storage or emitting `setprice`.
   */
  set_price_many: ({creator, updates}: {creator: string, updates: Array<BatchPriceUpdate>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_terms_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store a hash of creator marketplace terms.
   */
  set_terms_hash: ({creator, terms_hash}: {creator: string, terms_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Accept a proposed transfer. Only the pending owner can call this.
   */
  accept_transfer: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel a proposed transfer. Only the current owner can call this.
   * 
   * Self-cancel protection: `cancel_transfer` requires the caller to be the
   * current `resource.creator`. After `accept_transfer` completes the
   * pending-transfer entry is removed and ownership moves to the new
   * creator, so any subsequent `cancel_transfer` call by either party
   * returns `NoPendingTransfer` — an accepted transfer can never be
   * reversed through this path.
   */
  cancel_transfer: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a check_tag_index transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only tag-index integrity check for a bounded set of resource ids.
   * 
   * Compares each resource's canonical tags (the source of truth) against
   * `TagIndex` membership and reports drift in both directions:
   * - [`TagIndexReport::missing`] — the resource carries the tag but the
   * index does not list the id under it.
   * - [`TagIndexReport::stale`] — the index lists the id under a tag the
   * resource does not carry.
   * 
   * Bounded by [`MAX_TAG_INDEX_CHECK`]. Stale memberships are audited only
   * under the union of tags carried by the checked resources; memberships
   * under tags outside that union are not reported (use `repair_tag_index`
   * for a full rebuild). Never writes storage and never emits events, so it
   * is safe to run from operational tooling before a repair.
   * 
   * Errors deterministically:
   * - [`Error::BatchTooLarge`] — more than [`MAX_TAG_INDEX_CHECK`] ids
   * - [`Error::NotFound`] — any id is not a registered resource
   * - [`Error::InvalidResourceId`] — any id fails format validation
   */
  check_tag_index: ({ids}: {ids: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TagIndexReport>>>

  /**
   * Construct and simulate a freeze_metadata transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permanently freeze a resource's metadata pointer. Only the creator may
   * call this. Irreversible — errors `AlreadyFrozen` if called twice.
   * Price, listing, tags, and ownership remain mutable after freezing.
   */
  freeze_metadata: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a freeze_resource transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Freeze an otherwise active resource. The creator may freeze a listed or
   * delisted resource, and may restore it (or a post-dispute `Frozen`
   * resolution) through `reactivate_resource`. This lifecycle freeze is
   * separate from `freeze_metadata`.
   */
  freeze_resource: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a lease_is_active transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `holder` currently has access to `resource_id` through a
   * lease: one exists, it is `Active`, and the current ledger is below
   * its `expiry_ledger`. Never errors; unknown pairs and malformed ids
   * simply return `false`.
   */
  lease_is_active: ({resource_id, holder}: {resource_id: string, holder: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a list_by_creator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated listing of resources owned by `creator` in insertion order.
   * 
   * - Results are ordered by global registration sequence for that creator.
   * - `limit` is capped at `20`.
   * - Returns empty `Vec` when `start` is beyond the creator's known items.
   */
  list_by_creator: ({creator, start, limit}: {creator: string, start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Resource>>>

  /**
   * Construct and simulate a remove_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke the verifier role from `verifier`. Only the admin may call this.
   */
  remove_verifier: ({verifier}: {verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Resolve a disputed resource to `Listed`, `Delisted`, or `Frozen`.
   */
  resolve_dispute: ({id, admin, state}: {id: string, admin: string, state: ResourceState}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a rotate_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  rotate_verifier: ({old_verifier, new_verifier}: {old_verifier: string, new_verifier: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unflag_resource transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Remove the dispute flag from a resource. Only an address currently holding
   * the moderator role (see `add_moderator`) may call this.
   * 
   * Clears `Resource.dispute_flag` to `None`. If the resource is not currently
   * flagged this is a no-op (the event is still emitted so off-chain indexers
   * have a complete audit trail).
   * 
   * Emits an `unflag` event with the resource `id` as the data payload.
   * 
   * Errors deterministically:
   * - [`Error::Unauthorized`] — caller does not hold the moderator role
   * - [`Error::NotFound`] — `id` is not a registered resource
   * - [`Error::InvalidResourceId`] — `id` fails format validation
   */
  unflag_resource: ({id, moderator}: {id: string, moderator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a update_metadata transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update a resource's metadata pointer. Only the creator may call this.
   * 
   * Emits a [`MetadataUpdateEvent`] containing the resource id, the previous
   * metadata pointer (`old_metadata`), and the new one (`new_metadata`).
   * Off-chain indexers can use these fields to build an audit trail without
   * querying historical ledger state.
   * 
   * No-op guard: if `metadata` is identical to the resource's current
   * metadata pointer, the call succeeds without touching storage or
   * emitting an `updmeta` event. A resource registered with a content hash
   * rejects any divergent pointer with `MetadataFrozen`.
   */
  update_metadata: ({id, metadata}: {id: string, metadata: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a contract_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the contract crate version and the `Resource` schema version as a
   * stable, compact struct. Deployment scripts and upgrade tools should call
   * this to confirm which version of the contract is running on-chain before
   * and after a redeploy, without needing to parse the full `registry_info`
   * response.
   * 
   * Upgrade compatibility: `crate_version` is the Cargo semver string baked
   * in at build time (`CARGO_PKG_VERSION`). `resource_schema_version` is an
   * integer bumped only when the on-chain `Resource` struct changes in a way
   * that requires callers to update how they decode it. A change to
   * `crate_version` alone does not imply a schema change.
   */
  contract_version: (options?: MethodOptions) => Promise<AssembledTransaction<ContractVersion>>

  /**
   * Construct and simulate a emergency_delist transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Emergency-delist a disputed resource. Only the current admin may call
   * this, and only while the resource is in the `Disputed` state.
   * 
   * Emits an `emdelist` event with `EmergencyDelistEvent { id, admin, reason }`.
   * A creator delist goes through `set_listed`/`delist` and emits `setlisted`,
   * so the two actions are now distinguishable by topic alone: an indexer
   * seeing `emdelist` knows an admin pulled the resource and can attribute it
   * to `admin` with the caller's stated `reason`. Before this event existed,
   * `emergency_delist` emitted nothing at all, so an admin takedown was only
   * visible by reading resource state after the fact.
   * 
   * `reason` is free-form and is not length-validated. The caller is the
   * authenticated current admin, so an oversized value costs the admin their
   * own transaction fee rather than enabling griefing, and the contract has no
   * spare error code to reject it with — `Error` is at the protocol's 50-case
   * cap (see the note on the enum). Admin justification is best left
   * unopinionated; consumers that need a con
   */
  emergency_delist: ({id, admin, reason}: {id: string, admin: string, reason: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a list_by_tag_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `list_by_tag` with an id-based cursor (see `list_by_creator_page`).
   * Tombstoned resources are skipped exactly as `list_by_tag` skips them.
   */
  list_by_tag_page: ({tag, cursor, limit}: {tag: string, cursor: IdCursor, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<IdPage>>

  /**
   * Construct and simulate a list_listed_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `list_listed` with next-cursor metadata: `cursor` and `next_cursor`
   * are global catalog indexes (same domain as `list_page`), so a page
   * boundary is stable however many resources change state between calls.
   */
  list_listed_page: ({cursor, limit}: {cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<CatalogPage>>

  /**
   * Construct and simulate a migrate_resource transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Upgrade a resource written using the immediately preceding supported
   * schema. Current-schema resources are accepted as a no-op. Unsupported
   * schema versions are rejected before storage is touched.
   */
  migrate_resource: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a propose_transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Propose a transfer to a new owner. The new owner must accept it.
   */
  propose_transfer: ({id, new_creator}: {id: string, new_creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a remove_moderator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke the moderator role from `moderator`. Only the admin may call this.
   */
  remove_moderator: ({moderator}: {moderator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a repair_tag_index transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rebuild the tag index from an authoritative, admin-supplied ordered
   * list of resource ids. Only the admin may call this. Every id must
   * already exist as a registered `Resource` (else `NotFound`). Unlike
   * `repair_index`, duplicates in the id list are harmless (tag index has
   * set semantics per tag — re-indexing the same id is idempotent) and
   * are silently de-duplicated rather than rejected. Never reads, writes,
   * or deletes `Resource` storage — only rewrites the derived `TagIndex`
   * entries for the tags those resources currently carry. Safe to re-run
   * with the correct current id list as a no-op. See
   * `docs/tag-index-repair-design.md` for the full strategy.
   * 
   * An empty `ids` list is a documented no-op: it returns `Ok(())` and
   * deliberately emits **no** `retagidx` event. There is nothing to index, so
   * every `TagIndex` entry is left exactly as it was, and suppressing the
   * event is what keeps the call from reading as a successful repair — the
   * ADR's `retagidx` payload is the signal operators and audit tooling use to
   * see that 
   */
  repair_tag_index: ({ids}: {ids: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_paused_until transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Schedule an emergency pause that automatically expires at `pause_until`.
   * 
   * The deadline is an absolute Unix timestamp in seconds from the ledger
   * clock. The existing `set_paused(admin, true)` entry point remains the
   * way to create an indefinite pause. A deadline at or before the current
   * ledger timestamp takes effect as an immediate resume.
   */
  set_paused_until: ({admin, pause_until}: {admin: string, pause_until: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_recipient transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update only the fee recipient address without changing fee rates.
   * Only the admin may call this. Errors `AdminNotSet` if no admin has been
   * set yet, or `FeeConfigNotSet` if `set_fee_config` has never been called.
   * 
   * This is a convenience method that allows updating the recipient without
   * having to re-specify the existing `platform_fee_bps` and `royalty_bps`.
   * Emits a `setfee` event with the old and new complete `FeeConfig`.
   */
  set_fee_recipient: ({recipient}: {recipient: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_refund_window transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configure the creator refund window for payments settled after this call.
   * Existing payment deadlines are not changed. The initial value is one day.
   */
  set_refund_window: ({admin, window_ledgers}: {admin: string, window_ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_anchor_failure transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the anchor-failure record for `(resource_id, buyer)`. Open to
   * anyone, since a buyer must be able to find their own failure without a
   * role. Errors `NotFound` when there is no outstanding failure.
   */
  get_anchor_failure: ({resource_id, buyer}: {resource_id: string, buyer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<AnchorFailure>>>

  /**
   * Construct and simulate a get_resource_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch the current lifecycle state of a resource. Errors with `NotFound` if absent.
   */
  get_resource_state: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<ResourceState>>>

  /**
   * Construct and simulate a initialize_network transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store the intended network identifier once. The supplied ID must match
   * the ledger this contract is executing on, preventing a deployment
   * script from accidentally recording a different Stellar network.
   */
  initialize_network: ({network_id}: {network_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a nominate_new_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Nominate a new contract admin. Only the current admin may call this.
   * Sets `pending_admin`. The nomination does not take effect until
   * the pending admin calls `accept_admin`.
   */
  nominate_new_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_with_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a new resource together with an immutable digest of its
   * off-chain content. Supplying a hash binds the metadata pointer to this
   * registration: `update_metadata` cannot change it afterward. Passing
   * `None` preserves the mutable metadata behavior of `register`.
   * 
   * Rejects an empty hash or one longer than `MAX_CONTENT_HASH_LEN`
   * (`ContentHashTooLong`). All other validation matches `register`.
   */
  register_with_hash: ({creator, id, price, metadata, tags, content_hash}: {creator: string, id: string, price: i128, metadata: string, tags: Array<string>, content_hash: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a register_with_memo transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register a new resource together with an optional content hash and an
   * optional 32-byte memo hash. The memo hash is the registration's link to
   * an off-chain record (typically the `MEMO_HASH` of the Stellar
   * transaction that announced or paid for it) and is written once at
   * registration; nothing can change it afterwards. Read it back with
   * `get_memo_hash`. When present it is also emitted in a `regmemo` event.
   * 
   * All other validation matches `register_with_hash`.
   */
  register_with_memo: ({creator, id, price, metadata, tags, content_hash, memo_hash}: {creator: string, id: string, price: i128, metadata: string, tags: Array<string>, content_hash: Option<string>, memo_hash: Option<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_recovery_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set or clear the recovery admin. Only the current admin may call this;
   * the recovery admin must differ from the admin (`SameAdmin`). Emits
   * `setrecov`.
   */
  set_recovery_admin: ({recovery_admin}: {recovery_admin: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a tombstone_resource transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permanently retire a resource. Only an admin may tombstone it; the
   * tombstoned state has no outgoing transitions.
   * 
   * Tombstoning purges the resource from every derived listing index the
   * contract can reach in bounded gas — the tag index and the creator
   * index — so it stops surfacing in `list_by_tag`, `list_by_creator`, and
   * `creator_resource_count`. The canonical `Resource` entry is left in
   * place and stays readable through `get` for audit, and the global
   * `Index`/`Count` pair is deliberately untouched: `Count` is monotonic
   * and finding a resource's slot in it would cost an unbounded scan.
   */
  tombstone_resource: ({id, admin}: {id: string, admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_ownership transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  transfer_ownership: ({id, new_creator}: {id: string, new_creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a extend_resource_ttl transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Extend the TTL of a resource's persistent storage entry.
   * 
   * Only the resource's current creator (owner) may call this.
   * Emits a `"ttlext"` event with the `resource_id` as payload.
   */
  extend_resource_ttl: ({creator, resource_id}: {creator: string, resource_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_anchor_attempts transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rejected `attempt_anchor_purchase_receipt` bookkeeping for a pair:
   * how many attempts have been rejected and at which ledger the last one
   * was. Both fields are `0` when the pair has never been rejected or its
   * anchor has since been written.
   */
  get_anchor_attempts: ({resource_id, buyer}: {resource_id: string, buyer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<AnchorAttempts>>>

  /**
   * Construct and simulate a get_fee_destination transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_fee_destination: (options?: MethodOptions) => Promise<AssembledTransaction<FeeDestinationConfig>>

  /**
   * Construct and simulate a get_payment_receipt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch the most recent payment receipt recorded for
   * `(resource_id, payer)`, resolved through the `PaymentIndex` secondary
   * index. Errors `NotFound` when that pair has no recorded payment.
   * Bumps the TTL of both the index entry and the receipt on a successful
   * read.
   */
  get_payment_receipt: ({resource_id, payer}: {resource_id: string, payer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PaymentReceipt>>>

  /**
   * Construct and simulate a get_refunded_amount transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Total amount recorded as refunded for a payment receipt.
   */
  get_refunded_amount: ({payment_receipt_id}: {payment_receipt_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_refund_deadline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Exclusive ledger deadline for creator refunds of a settled payment.
   */
  get_refund_deadline: ({payment_receipt_id}: {payment_receipt_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a get_resource_states transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return lifecycle states for up to `MAX_BATCH_RESOURCE_STATES` ids.
   * Results preserve input order; ids with no resource return `None`.
   */
  get_resource_states: ({ids}: {ids: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<Option<ResourceState>>>>>

  /**
   * Construct and simulate a reactivate_resource transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reactivate a resource that was resolved out of a dispute (or otherwise
   * left inactive) back to the public `Listed` state. Only the creator may
   * call this, and only while the resource is `Frozen` or `Delisted`.
   * 
   * `Disputed` resources have no creator exit: an admin must resolve the
   * dispute first, and `Tombstoned` resources are terminal — reactivation
   * from either fails with `InvalidLifecycleTransition`.
   * 
   * Reconciliation rule for an active moderator dispute flag: a resource
   * whose `dispute_flag` is set is mid-moderator-dispute, and relisting it
   * as `Listed` would be ambiguous. The creator cannot clear the flag by
   * reactivating — a moderator must call `unflag_resource` first, after
   * which reactivation succeeds as normal. Until then the call fails with
   * `InvalidLifecycleTransition`.
   * 
   * Mirrors `set_listed(id, true)` for the `Delisted` case but is the only
   * creator path out of `Frozen`, and always flips the `listed` projection
   * and listed-count index back to active.
   * 
   * Emits a `reactive` event whose topic carries the resource 
   */
  reactivate_resource: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a record_admin_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a refund under the admin override path. This bypasses the
   * creator signature and refund deadline, but not payer or amount checks.
   */
  record_admin_refund: ({admin, refund_id, payment_receipt_id, recipient, amount, tx_hash}: {admin: string, refund_id: string, payment_receipt_id: string, recipient: string, amount: i128, tx_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_destination transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_fee_destination: ({config}: {config: FeeDestinationConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a bootstrap_dual_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Optional dual-key bootstrap: set `admin` and a separate
   * `recovery_admin` in one call, so the deployment can recover via
   * `recover_admin` if the sole admin key is lost. Both addresses must
   * authorize and must differ (`SameAdmin`). Only valid before any admin is
   * set (`AlreadyRegistered`); `nominate_new_admin` remains the single-key
   * bootstrap path. Emits `setadmin` and `setrecov`.
   */
  bootstrap_dual_admin: ({admin, recovery_admin}: {admin: string, recovery_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a creator_listed_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of resources owned by `creator` that are currently in the
   * `Listed` state. The per-creator counterpart of `listed_count`: it
   * follows every listed-state transition (delist, freeze, dispute,
   * reactivate, tombstone) and moves between owners on transfer.
   */
  creator_listed_count: ({creator}: {creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_attestation_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the off-chain attestation hash for a resource, if one has been recorded
   * via `set_verification_status`.
   */
  get_attestation_hash: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_flag_reason_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch the moderator dispute reason hash stored for a resource.
   * Errors with `NotFound` if none has been set.
   */
  get_flag_reason_hash: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>

  /**
   * Construct and simulate a get_purchase_receipt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetch a purchase receipt anchor for `(resource_id, buyer)`.
   */
  get_purchase_receipt: ({resource_id, buyer}: {resource_id: string, buyer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PurchaseReceiptAnchor>>>

  /**
   * Construct and simulate a list_by_creator_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `list_by_creator` with an id-based cursor. Pass `IdCursor::Start` for
   * the first page and the returned `next_cursor` for each following page;
   * `IdCursor::End` back means end-of-list. See [`IdCursor`] for how the
   * cursor survives tombstones and transfers that remove entries from the
   * creator index.
   */
  list_by_creator_page: ({creator, cursor, limit}: {creator: string, cursor: IdCursor, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<IdPage>>

  /**
   * Construct and simulate a pending_admin_expiry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the ledger sequence at which the pending admin nomination expires.
   * Bumps the instance storage TTL to keep the entry alive for active monitors.
   */
  pending_admin_expiry: (options?: MethodOptions) => Promise<AssembledTransaction<Option<u32>>>

  /**
   * Construct and simulate a search_by_tag_prefix transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Bounded discovery read for the resources that carry a tag sharing a
   * normalized prefix.
   * 
   * This complements [`list_by_tag`], which only resolves one exact tag.
   * The prefix is normalized with exactly the same rules tags are stored
   * with ([`Self::normalize_tag`]: trim ASCII whitespace, lowercase ASCII
   * letters), so `"  DATA "` resolves the same way as `"data"`.
   * 
   * - A prefix that normalizes to the empty string would match every tag
   * in the catalog, so it is rejected by returning an empty page.
   * - `cursor` is a global catalog index — the same domain as `list_page`
   * and `list_listed_page`. It points at the first catalog entry that
   * has not been scanned yet, so a page that matched nothing still
   * advances and a later page cannot repeat an entry.
   * - `limit` is the maximum number of resources the page returns. It is
   * clamped to `1..=[`LIST_PAGE_CAP`] (20): a `limit` of `0` still
   * returns one match so the scan always makes progress and a client
   * following the cursor can never be stuck on the same slot.
   * - Results are ordered by globa
   */
  search_by_tag_prefix: ({prefix, cursor, limit}: {prefix: string, cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<CatalogPage>>

  /**
   * Construct and simulate a set_flag_reason_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store a hash of a moderator's off-chain dispute reason writeup for a
   * resource. Only an address currently holding the moderator role (see
   * `add_moderator`) may call this.
   * 
   * Independent of `flag_resource`'s `FlagReason` code: that's a fixed,
   * small enum; this carries a digest of free-form off-chain detail (a
   * longer writeup, evidence links, etc.), the same pattern as
   * `set_terms_hash`. Calling this again for the same resource replaces
   * the stored hash. Does not require the resource to currently be
   * flagged, since a moderator may want to attach detail before or after
   * calling `flag_resource`.
   * 
   * Emits a `flagrsn` event with `(moderator, reason_hash)`.
   * 
   * Errors deterministically:
   * - [`Error::Unauthorized`] — caller does not hold the moderator role
   * - [`Error::InvalidResourceId`] — `id` fails format validation
   * - [`Error::NotFound`] — `id` is not a registered resource
   * - [`Error::FlagReasonHashTooLong`] — `reason_hash` exceeds `MAX_FLAG_REASON_HASH_LEN`
   */
  set_flag_reason_hash: ({id, moderator, reason_hash}: {id: string, moderator: string, reason_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a update_metadata_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update the metadata pointer for a small bounded set of owned resources
   * in one transaction. The batch is capped at
   * [`MAX_BATCH_METADATA_UPDATES`] items.
   * 
   * Failure behavior is **atomic**: every item is validated (id format,
   * ownership, metadata-freeze / content-hash rules, pointer validity)
   * before any write. If any item fails validation the whole call errors
   * and no resource records, pointers, or events change. When every item
   * passes, each resource is written and emits its own `updmeta` event —
   * the per-item results an indexer needs — under a single creator
   * authorization.
   * 
   * Freeze invariant: a frozen resource (`freeze_metadata`, or registered
   * with a content hash) rejects any divergent pointer with
   * `MetadataFrozen`, exactly as `update_metadata` does. No-op items whose
   * pointer is unchanged are skipped silently.
   */
  update_metadata_many: ({creator, updates}: {creator: string, updates: Array<BatchMetadataUpdate>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_metadata_pointers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * All metadata pointers for a resource. Falls back to a single-entry list
   * holding `Resource.metadata` (primary `0`) when no mirrors were set.
   */
  get_metadata_pointers: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<MetadataPointers>>>

  /**
   * Construct and simulate a record_anchor_failure transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Durably record that `(resource_id, buyer)` could not be anchored, so the
   * buyer can query it with [`get_anchor_failure`}. Only a settler may call
   * this; see `contract/README.md` for why the settler, and not the revoked
   * verifier, is the only actor that can report this (#781). Widening
   * *reporting* to a trusted role does not weaken the invariant that a
   * roleless address cannot write to the log.
   * 
   * Last-write-wins. If an anchor already exists the record is cleared and
   * `Ok(())` returned, so `get_anchor_failure` can never disagree with
   * `get_purchase_receipt`. Emits `anchrfail` with `reason`
   * [`AnchorFailureReason::VerifierUnavailable`].
   * Errors `NotSettler`, `ContractPaused`, `InvalidResourceId`, `NotFound`
   * (no such resource), or `InvalidTxHash` (empty or over-long hash).
   */
  record_anchor_failure: ({settler, resource_id, buyer, receipt_hash}: {settler: string, resource_id: string, buyer: string, receipt_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a record_creator_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record a completed creator-initiated refund for a settled payment.
   * The transfer must already have occurred; the registry stores its hash
   * as an audit anchor and does not custody or move USDC.
   */
  record_creator_refund: ({creator, refund_id, payment_receipt_id, recipient, amount, tx_hash}: {creator: string, refund_id: string, payment_receipt_id: string, recipient: string, amount: i128, tx_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_metadata_pointers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set up to `MAX_METADATA_POINTERS` redundant metadata pointers (e.g.
   * IPFS + Arweave + hosted) with `pointers[primary]` as the preferred one,
   * so the resource survives a single storage outage. Only the creator may
   * call this. Every pointer is validated like `update_metadata`, and
   * `Resource.metadata` is set to the primary pointer so single-pointer
   * readers keep working. Subject to the same freeze / content-hash rules
   * as `update_metadata`: a frozen resource may only re-publish mirrors
   * whose primary equals its current pointer. Emits `setptrs`.
   */
  set_metadata_pointers: ({id, pointers, primary}: {id: string, pointers: Array<string>, primary: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_royalty_recipient transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set a per-resource royalty recipient override. Only the creator may call
   * this. When set, royalties for this resource will go to this address instead
   * of the global `fee_recipient` from `FeeConfig`. Set to `None` to clear the
   * override and use the global recipient.
   * 
   * Emits a `setroyal` event with the old and new recipient addresses.
   */
  set_royalty_recipient: ({id, recipient}: {id: string, recipient: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a creator_resource_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of resources currently owned by `creator` (moves with
   * `transfer_ownership`/`accept_transfer`; unrelated to the monotonic,
   * never-decremented `count()`).
   */
  creator_resource_count: ({creator}: {creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a list_by_dispute_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated list of resources filtered by active moderator dispute flag.
   * 
   * `flagged = true` returns resources with `DisputeFlag::Flagged(_)`;
   * `flagged = false` returns resources with `DisputeFlag::NoFlag`.
   * `start` is a global catalog cursor, matching `list_listed`.
   */
  list_by_dispute_status: ({flagged, start, limit}: {flagged: boolean, start: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Resource>>>

  /**
   * Construct and simulate a anchor_purchase_receipt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Anchor a purchase receipt hash for `(resource_id, buyer)`.
   * 
   * This is immutable: duplicate anchors for the same pair error with
   * `DuplicateReceipt`, so downstream services can treat the first anchor as
   * canonical. The caller must hold the verifier role.
   */
  anchor_purchase_receipt: ({service, resource_id, buyer, receipt_hash}: {service: string, resource_id: string, buyer: string, receipt_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resource_schema_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return `RESOURCE_SCHEMA_VERSION` as a bare `u32`, so clients can do
   * feature detection (e.g. "does `Resource` carry `metadata_frozen_at`?")
   * with a single integer comparison instead of decoding
   * `contract_version` or `registry_info`. Always succeeds.
   */
  resource_schema_version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a set_registry_terms_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Store the registry-wide canonical terms hash. Only the admin may call
   * this. When a creator has not stored their own terms, `get_terms_hash`
   * returns this value as the authoritative vault listing terms.
   */
  set_registry_terms_hash: ({terms_hash}: {terms_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_verification_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update a resource's on-chain verification status. Only an address
   * currently holding the verifier role (see `add_verifier`) may call
   * this. Only `Pending -> Verified`, `Pending -> Rejected`,
   * `Verified -> Rejected`, and `Rejected -> Verified` are allowed;
   * self-transitions and reverting to `Pending` error with
   * `InvalidVerificationTransition`.
   */
  set_verification_status: ({id, verifier, status, attestation_hash}: {id: string, verifier: string, status: VerificationStatus, attestation_hash: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a verify_attestation_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether the resource is currently in `status` and its stored
   * attestation hash equals `compute_attestation_hash(id, status, document_hash)`.
   */
  verify_attestation_hash: ({id, status, document_hash}: {id: string, status: VerificationStatus, document_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a compute_attestation_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pure function: recompute the attestation hash a verifier is expected to
   * submit for `(id, status, document_hash)`, so off-chain clients can
   * check integrity without trusting a wallet provider. Returns
   * `sha256:<64 lowercase hex>` over the preimage
   * `ATTESTATION_HASH_DOMAIN || u32_be(len(id)) || id || u32_be(status) || document_hash`.
   * Reads no storage and requires no auth.
   */
  compute_attestation_hash: ({id, status, document_hash}: {id: string, status: VerificationStatus, document_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a creator_earnings_estimate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the total USDC stroops earned by `creator` across all settled
   * payment receipts for resources they owned at settlement time. The
   * estimate is a running tally that `settle_payment` increments
   * atomically, so it is always consistent without re-scanning history.
   * 
   * Returns a [`CreatorEarningsEstimate`] carrying the creator address,
   * the total settled amount, and the count of settled receipts included.
   * 
   * A creator with no settled payments returns `total_settled = 0` and
   * `settled_count = 0` — this is not an error.
   */
  creator_earnings_estimate: ({creator}: {creator: string}, options?: MethodOptions) => Promise<AssembledTransaction<CreatorEarningsEstimate>>

  /**
   * Construct and simulate a record_payment_idempotent transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Retry-safe `record_payment`: same auth, validation, and pause rules,
   * but returns the stored receipt. If `receipt_id` is already recorded
   * with the same `resource_id`, `payer`, `amount`, and `tx_hash`, that
   * receipt is returned unchanged, whatever its state, with no write and
   * no event. The same id with different arguments still errors
   * `ReceiptAlreadyExists`.
   */
  record_payment_idempotent: ({settler, receipt_id, resource_id, payer, amount, tx_hash}: {settler: string, receipt_id: string, resource_id: string, payer: string, amount: i128, tx_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PaymentReceipt>>>

  /**
   * Construct and simulate a get_verifier_status_history transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return a page of verification status changes performed by `verifier`,
   * in chronological order (oldest first).
   * 
   * - `cursor` is a 0-based index into the verifier's history list.
   * - `limit` is capped at [`LIST_PAGE_CAP`] (20).
   * - `next_cursor` is `Some(next_index)` when more entries exist, or
   * `None` at end-of-list.
   * 
   * A verifier with no recorded history returns an empty page — not an error.
   */
  get_verifier_status_history: ({verifier, cursor, limit}: {verifier: string, cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<VerifierStatusPage>>

  /**
   * Construct and simulate a list_by_dispute_status_page transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `list_by_dispute_status` with next-cursor metadata. Because the cursor
   * is a catalog index rather than a count of matches, a flag flipping
   * between pages can neither skip nor repeat a resource: each catalog slot
   * is visited exactly once, and its current flag decides inclusion.
   */
  list_by_dispute_status_page: ({flagged, cursor, limit}: {flagged: boolean, cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<CatalogPage>>

  /**
   * Construct and simulate a list_by_verification_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated list of resources filtered by verification status.
   * 
   * Returns resources whose `verified` field matches `status`.
   * `cursor` is a global catalog index (same semantics as `list_page`).
   * `limit` is capped at 20.
   * Returns a `CatalogPage` with `items` (matching resources) and
   * `next_cursor` (next catalog position, or `None` at end-of-list).
   */
  list_by_verification_status: ({status, cursor, limit}: {status: VerificationStatus, cursor: u32, limit: u32}, options?: MethodOptions) => Promise<AssembledTransaction<CatalogPage>>

  /**
   * Construct and simulate a list_by_creator_page_filtered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Paginated listing of the resources owned by `creator`, filtered by
   * listing state and lifecycle state.
   * 
   * This is the filtered counterpart of [`list_by_creator_page`]: it walks
   * the same creator-scoped index with the same [`IdCursor`] pagination, so
   * a creator dashboard reads only its own inventory instead of scanning
   * the global catalog, and the two calls can be interleaved.
   * 
   * - `cursor` is an [`IdCursor`]: `Start` for the first page, then the
   * `next_cursor` returned by the previous call. It survives resources
   * that leave the creator index (tombstones, transfers) exactly as it
   * does for `list_by_creator_page`.
   * - `limit` is capped at [`LIST_PAGE_CAP`] (20). A `limit` of `0`
   * returns an empty page.
   * - `listed` filters on the creator-facing listing projection:
   * `Some(true)` keeps only resources in the `Listed` state,
   * `Some(false)` keeps only resources that are *not* listed, and
   * `None` keeps every resource.
   * - `state` filters on the explicit lifecycle state; `None` keeps every
   * state.
   * - The two filters compose with AND: a reso
   */
  list_by_creator_page_filtered: ({creator, cursor, limit, listed, state}: {creator: string, cursor: IdCursor, limit: u32, listed: Option<boolean>, state: Option<ResourceState>}, options?: MethodOptions) => Promise<AssembledTransaction<IdPage>>

  /**
   * Construct and simulate a retry_anchor_purchase_receipt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settle-time retry hook: write the anchor for `(resource_id, buyer)` as
   * the settler, with no verifier involved. Returns `true` on success.
   * 
   * The authority granted is strictly *narrower* than the verifier path:
   * `receipt_hash` must equal the `tx_hash` of the payment already recorded
   * for the pair, so this can neither anchor a hash no payment backs nor
   * invent a payment (#781).
   * 
   * Data problems are reported as in
   * [`attempt_anchor_purchase_receipt`]: `Ok(false)` plus an `anchrfail`
   * event and a record, so a settlement loop can call this on every payment
   * without reverting. The same hash is an idempotent `Ok(true)`; a different
   * hash reports [`AnchorFailureReason::DuplicateReceipt`].
   * 
   * Errors `NotSettler`, `ContractPaused`, or `InvalidResourceId`; every
   * other problem is reported as `Ok(false)`.
   */
  retry_anchor_purchase_receipt: ({settler, resource_id, buyer, receipt_hash}: {settler: string, resource_id: string, buyer: string, receipt_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a transfer_ownership_with_terms transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer resource ownership while optionally rebinding the new owner's
   * terms hash and/or resetting the resource's attestation record
   * atomically in the same transaction.
   * 
   * - `id` — resource to transfer.
   * - `new_creator` — the incoming owner.
   * - `new_terms_hash` — when `Some`, store this hash under the new
   * creator's [`DataKey::CreatorTerms`] entry (max 64 bytes). The
   * *old* owner's terms entry is left unchanged.
   * - `reset_attestation` — when `true`, clear the resource's stored
   * attestation hash so the new owner can request fresh verification.
   * 
   * Behaves identically to `transfer_ownership` when both optional
   * arguments are `None`/`false`: it errors `AlreadyOwner`, clears any
   * pending `propose_transfer`, and emits a `transfer` event. It also
   * emits a `txfrterms` event (even when neither optional action was
   * taken) so callers who care about terms-aware transfers can index
   * just that topic.
   * 
   * Errors:
   * - [`Error::AlreadyOwner`] — `new_creator` already owns the resource.
   * - [`Error::TermsHashTooLong`] — `new_terms_hash` 
   */
  transfer_ownership_with_terms: ({id, new_creator, new_terms_hash, reset_attestation}: {id: string, new_creator: string, new_terms_hash: Option<string>, reset_attestation: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a attempt_anchor_purchase_receipt transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Attempt to anchor a purchase receipt, reporting a rejected attempt as
   * an on-chain `anchrfail` event instead of reverting.
   * 
   * `anchor_purchase_receipt` returns an `Error` when the attempt is not
   * anchorable, and a Soroban error rolls the whole invocation back —
   * events included — so a settlement service batching many anchors loses
   * both the surviving anchors and any on-chain trace of what failed. This
   * variant keeps authorization strict (a non-verifier still reverts, and
   * so does a malformed `resource_id`) but turns the three *data* failures
   * — unknown resource, unusable receipt hash, and an already-anchored
   * `(resource_id, buyer)` pair — into an [`AnchorFailure`] event plus a
   * `false` return, so monitors can see the rejected attempt and its
   * reason without replaying the caller's logs.
   * 
   * Returns `true` and emits the usual `anchor` event on success.
   * 
   * 
   * Rejected attempts are counted per `(resource_id, buyer)` pair (see
   * `get_anchor_attempts`). A retry fewer than `ANCHOR_RETRY_BACKOFF_LEDGERS`
   * ledgers after the last re
   */
  attempt_anchor_purchase_receipt: ({service, resource_id, buyer, receipt_hash}: {service: string, resource_id: string, buyer: string, receipt_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a override_purchase_receipt_anchor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Override a purchase receipt anchor for `(resource_id, buyer)`.
   * 
   * This method allows the admin to forcibly update an existing purchase receipt
   * anchor for a given buyer. If no anchor exists, it returns `NotFound`.
   */
  override_purchase_receipt_anchor: ({admin, resource_id, buyer, new_receipt_hash}: {admin: string, resource_id: string, buyer: string, new_receipt_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAD5GZXRjaCBhIHJlc291cmNlLiBFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIGl0IGRvZXMgbm90IGV4aXN0LgAAAAAAA2dldAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAH0AAAAAhSZXNvdXJjZQAAAAM=",
        "AAAAAAAAANxQYWdpbmF0ZWQgcmVzb3VyY2UgbGlzdCBpbiBpbnNlcnRpb24gb3JkZXIuIGBsaW1pdGAgaXMgY2FwcGVkIGF0IDIwLgoKS2VwdCBmb3IgY2FsbGVycyB0aGF0IG9ubHkgbmVlZCB0aGUgcGFnZSBib2R5LiBQcmVmZXIgYGxpc3RfcGFnZWAgd2hlbgp0aGUgY2xpZW50IG11c3Qga25vdyB0aGUgbmV4dCBjdXJzb3IgLyBlbmQtb2YtbGlzdCB3aXRob3V0IHJlY29tcHV0aW5nCm9mZnNldHMuAAAABGxpc3QAAAACAAAAAAAAAAVzdGFydAAAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPqAAAH0AAAAAhSZXNvdXJjZQ==",
        "AAAAAAAAABdDdXJyZW50IGNvbnRyYWN0IGFkbWluLgAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAAFtUb3RhbCBudW1iZXIgb2YgcmVzb3VyY2VzIHN1Y2Nlc3NmdWxseSByZWdpc3RlcmVkIChtb25vdG9uaWM7IG5vdCBkZWNyZW1lbnRlZCBvbiB0cmFuc2ZlcikuAAAAAAVjb3VudAAAAAAAAAAAAAABAAAABA==",
        "AAAAAAAAAF1EZWxpc3QgYSByZXNvdXJjZSAoY29udmVuaWVuY2UgbWV0aG9kIGZvciBzZXRfbGlzdGVkKGZhbHNlKSkuIE9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4AAAAAAAAGZGVsaXN0AAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAACtXaGV0aGVyIGEgcmVzb3VyY2Ugd2l0aCBgaWRgIGlzIHJlZ2lzdGVyZWQuAAAAAAZleGlzdHMAAAAAAAEAAAAAAAAAAmlkAAAAAAAQAAAAAQAAAAE=",
        "AAAAAQAAAIlUaW1lLWxpbWl0ZWQgYWNjZXNzIGxlYXNlOiBgaG9sZGVyYCBtYXkgYWNjZXNzIGByZXNvdXJjZV9pZGAgd2hpbGUgdGhlCmxlYXNlIGlzIGBBY3RpdmVgIGFuZCB0aGUgY3VycmVudCBsZWRnZXIgaXMgYmVsb3cgYGV4cGlyeV9sZWRnZXJgLgAAAAAAAAAAAAAFTGVhc2UAAAAAAAAJAAAAREFtb3VudCBwYWlkIGluIFVTREMgc3Ryb29wczsgZXF1YWxzIGBsZWFzZV9wcmljZWAgYXQgcmVjb3JkaW5nIHRpbWUuAAAABmFtb3VudAAAAAAACwAAADhGaXJzdCBsZWRnZXIgYXQgd2hpY2ggdGhlIGxlYXNlIG5vIGxvbmdlciBncmFudHMgYWNjZXNzLgAAAA1leHBpcnlfbGVkZ2VyAAAAAAAABAAAAAAAAAAGaG9sZGVyAAAAAAATAAAAMExlZGdlciBzZXF1ZW5jZSBhdCB3aGljaCB0aGUgbGVhc2Ugd2FzIHJlY29yZGVkLgAAAAtyZWNvcmRlZF9hdAAAAAAEAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAQkxlZGdlciBzZXF1ZW5jZSBhdCB3aGljaCB0aGUgd2luZG93IG9wZW5lZCAodGhlIHJlY29yZGluZyBsZWRnZXIpLgAAAAAADHN0YXJ0X2xlZGdlcgAAAAQAAAAAAAAABXN0YXRlAAAAAAAH0AAAAApMZWFzZVN0YXRlAAAAAAAAAAAABHRpZXIAAAfQAAAACUxlYXNlVGllcgAAAAAAAElTdGVsbGFyIHRyYW5zYWN0aW9uIGhhc2ggb2YgdGhlIFVTREMgdHJhbnNmZXIgKG5vbi1lbXB0eSwgbWF4IDEyOCBieXRlcykuAAAAAAAAB3R4X2hhc2gAAAAAEA==",
        "AAAAAAAAANpSZWFkIHNldmVyYWwgcmVzb3VyY2VzIGluIG9uZSBpbnZvY2F0aW9uLCBwcmVzZXJ2aW5nIGlucHV0IG9yZGVyLgpNaXNzaW5nIHJlc291cmNlcyBhcmUgcmVwcmVzZW50ZWQgYnkgYE5vbmVgOyB2YWxpZCByZXNvdXJjZXMgYXJlCnJldHVybmVkIGFzIGBTb21lKFJlc291cmNlKWAuIFRoZSBiYXRjaCBpcyBjYXBwZWQgdG8gYm91bmQgZXhlY3V0aW9uCmFuZCByZXNwb25zZSBzaXplLgAAAAAACGdldF9tYW55AAAAAQAAAAAAAAADaWRzAAAAA+oAAAAQAAAAAQAAA+kAAAPqAAAD6AAAB9AAAAAIUmVzb3VyY2UAAAAD",
        "AAAAAAAAAPpSZWdpc3RlciBhIG5ldyByZXNvdXJjZS4gUHJpY2UgaXMgaW4gVVNEQyBiYXNlIHVuaXRzICg3IGRlY2ltYWxzKS4KUmVqZWN0cyBgcHJpY2UgPD0gMGAgKGBJbnZhbGlkUHJpY2VgKSBvciBgcHJpY2UgPiBNQVhfUFJJQ0VgIChgUHJpY2VFeGNlZWRzTWF4YCkuClJlcXVpcmVzIHRoZSBjcmVhdG9yJ3MgYXV0aG9yaXphdGlvbi4KCkVxdWl2YWxlbnQgdG8gYHJlZ2lzdGVyX3dpdGhfaGFzaGAgd2l0aCBgY29udGVudF9oYXNoID0gTm9uZWAuAAAAAAAIcmVnaXN0ZXIAAAAFAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAACG1ldGFkYXRhAAAAEAAAAAAAAAAEdGFncwAAA+oAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAbpSZXBsYWNlIGEgcmVzb3VyY2UncyBkaXNjb3ZlcnkgdGFncy4gT25seSB0aGUgY3JlYXRvciBtYXkgY2FsbCB0aGlzLgpEb2VzIG5vdCBtb2RpZnkgYG1ldGFkYXRhYCAodGhlIG9mZi1jaGFpbiBjb250ZW50IHBvaW50ZXIpLgpUYWdzIGFyZSBub3JtYWxpemVkIHRvIGxvd2VyY2FzZSBBU0NJSSBiZWZvcmUgc3RvcmFnZTsgdGhlIG5vcm1hbGl6ZWQKZm9ybSBpcyB3aGF0IGdldHMgaW5kZXhlZCBhbmQgcmV0dXJuZWQgZnJvbSBgbGlzdF9ieV90YWdgLgoKTm8tb3AgZ3VhcmQ6IGlmIHRoZSBub3JtYWxpemVkIGB0YWdzYCBhcmUgaWRlbnRpY2FsIHRvIHRoZSByZXNvdXJjZSdzCmN1cnJlbnQgdGFncyAoc2FtZSB2YWx1ZXMsIHNhbWUgb3JkZXIpLCB0aGUgY2FsbCBzdWNjZWVkcyB3aXRob3V0CnRvdWNoaW5nIHN0b3JhZ2Ugb3IgZW1pdHRpbmcgYSBgc2V0dGFnc2AgZXZlbnQuAAAAAAAIc2V0X3RhZ3MAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAEdGFncwAAA+oAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAAAAAAAIdG9wX3RhZ3MAAAABAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAD6gAAB9AAAAANVGFnUG9wdWxhcml0eQAAAA==",
        "AAAAAQAAAERPbmUgcGFnZSBvZiBhbiBpZC1pbmRleGVkIGxpc3RpbmcgcGx1cyB0aGUgY3Vyc29yIGZvciB0aGUgbmV4dCBwYWdlLgAAAAAAAAAGSWRQYWdlAAAAAAACAAAAAAAAAAVpdGVtcwAAAAAAA+oAAAfQAAAACFJlc291cmNlAAAAAAAAAAtuZXh0X2N1cnNvcgAAAAfQAAAACElkQ3Vyc29y",
        "AAAAAAAAAcBSZWNvcmQgYSBsZWFzZSBib3VnaHQgYnkgYGhvbGRlcmAgaW4gYFBlbmRpbmdgIHN0YXRlLCBhd2FpdGluZyBhCnNldHRsZXIncyBjb25maXJtYXRpb24gb2YgdGhlIFVTREMgdHJhbnNmZXIgaWRlbnRpZmllZCBieSBgdHhfaGFzaGAKKGBzZXR0bGVfbGVhc2VgKS4gVGhlIHJlc291cmNlIG11c3QgYmUgYExpc3RlZGAgKGBSZXNvdXJjZU5vdExpc3RlZGApLApgYW1vdW50YCBtdXN0IGVxdWFsIGBsZWFzZV9wcmljZShyZXNvdXJjZV9pZCwgdGllcilgCihgTGVhc2VBbW91bnRNaXNtYXRjaGApLCBhbmQgYGhvbGRlcmAgbXVzdCBub3QgYWxyZWFkeSBob2xkIGEgcGVuZGluZwpvciB1bmV4cGlyZWQgYWN0aXZlIGxlYXNlIG9uIHRoZSByZXNvdXJjZSAoYExlYXNlQWxyZWFkeUFjdGl2ZWApOyBhbgpleHBpcmVkIG9yIHJldm9rZWQgbGVhc2UgaXMgcmVwbGFjZWQuIEVtaXRzIGBsZWFzZWAuAAAACWJ1eV9sZWFzZQAAAAAAAAUAAAAAAAAABmhvbGRlcgAAAAAAEwAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAEdGllcgAAB9AAAAAJTGVhc2VUaWVyAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAB3R4X2hhc2gAAAAAEAAAAAEAAAPpAAAH0AAAAAVMZWFzZQAAAAAAAAM=",
        "AAAAAAAAAIJGZXRjaCB0aGUgbGVhc2UgcmVjb3JkZWQgZm9yIGAocmVzb3VyY2VfaWQsIGhvbGRlcilgLCB3aGF0ZXZlciBpdHMKc3RhdGUuIEVycm9ycyBgTm90Rm91bmRgIGlmIG5vbmUgZXhpc3RzLiBCdW1wcyB0aGUgZW50cnkncyBUVEwuAAAAAAAJZ2V0X2xlYXNlAAAAAAAAAgAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAQAAA+kAAAfQAAAABUxlYXNlAAAAAAAAAw==",
        "AAAAAAAAAFFHZXQgdGhlIG93bmVyIGFkZHJlc3Mgb2YgYSByZXNvdXJjZS4gRXJyb3JzIHdpdGggYE5vdEZvdW5kYCBpZiBpdCBkb2VzIG5vdCBleGlzdC4AAAAAAAAJZ2V0X293bmVyAAAAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAABMAAAAD",
        "AAAAAAAAAIRXaGV0aGVyIHRoZSByZWdpc3RyeSBpcyBjdXJyZW50bHkgcGF1c2VkLiBSZXR1cm5zIGBmYWxzZWAgd2hlbiB0aGUKcGF1c2UgZmxhZyBoYXMgbmV2ZXIgYmVlbiBzZXQuIE5ldmVyIGJsb2NrZWQgYnkgdGhlIHBhdXNlIGl0c2VsZi4AAAAJaXNfcGF1c2VkAAAAAAAAAAAAAAEAAAAB",
        "AAAAAAAAATNQYWdpbmF0ZWQgY2F0YWxvZyBwYWdlIHdpdGggbmV4dC1jdXJzb3IgbWV0YWRhdGEuCgotIGBjdXJzb3JgIGlzIGEgMC1iYXNlZCBjYXRhbG9nIGluZGV4IChzYW1lIGRvbWFpbiBhcyBgbGlzdGAncyBgc3RhcnRgKS4KLSBgbGltaXRgIGlzIGNhcHBlZCBhdCAyMC4KLSBgbmV4dF9jdXJzb3JgIGlzIGBTb21lKG5leHRfaW5kZXgpYCB3aGVuIG1vcmUgZW50cmllcyBtYXkgZXhpc3QgYWZ0ZXIKdGhpcyBwYWdlLCBvciBgTm9uZWAgYXQgZW5kLW9mLWxpc3QgKGluY2x1ZGluZyBlbXB0eSBjYXRhbG9nIC8gY3Vyc29yCnBhc3QgdGhlIGVuZCkuAAAAAAlsaXN0X3BhZ2UAAAAAAAACAAAAAAAAAAZjdXJzb3IAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAfQAAAAC0NhdGFsb2dQYWdlAA==",
        "AAAAAAAAAYBVcGRhdGUgYSByZXNvdXJjZSdzIHByaWNlLiBSZWplY3RzIGBuZXdfcHJpY2UgPD0gMGAgb3IgYG5ld19wcmljZSA+IE1BWF9QUklDRWAuCk9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4KCkVtaXRzIGEgYHNldHByaWNlYCBldmVudCB3aG9zZSBkYXRhIGlzIGEgW2BQcmljZVVwZGF0ZWRgXSB2YWx1ZQpjb250YWluaW5nIGBpZGAsIGBvbGRfcHJpY2VgLCBgbmV3X3ByaWNlYCwgYW5kIGB1cGRhdGVyYC4KCk5vLW9wIGd1YXJkOiBpZiBgbmV3X3ByaWNlYCBpcyBpZGVudGljYWwgdG8gdGhlIHJlc291cmNlJ3MgY3VycmVudApwcmljZSwgdGhlIGNhbGwgc3VjY2VlZHMgd2l0aG91dCB0b3VjaGluZyBzdG9yYWdlIG9yIGVtaXR0aW5nIGEKYHNldHByaWNlYCBldmVudC4AAAAJc2V0X3ByaWNlAAAAAAAAAgAAAAAAAAACaWQAAAAAABAAAAAAAAAACW5ld19wcmljZQAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAMAAAAAEAAAAAAAAACFJlc291cmNlAAAAAQAAABAAAAAAAAAAAAAAAAVDb3VudAAAAAAAAAEAAAAAAAAABUluZGV4AAAAAAAAAQAAAAQAAAAAAAAAAAAAAAVBZG1pbgAAAAAAAAAAAAAAAAAADFBlbmRpbmdBZG1pbgAAAAEAAAAAAAAADENyZWF0b3JUZXJtcwAAAAEAAAATAAAAAQAAAAAAAAAQQ3JlYXRvclJlc291cmNlcwAAAAEAAAATAAAAAQAAAAAAAAAMQ3JlYXRvckNvdW50AAAAAQAAABMAAAABAAAAAAAAAA9QZW5kaW5nVHJhbnNmZXIAAAAAAQAAABAAAAABAAAAAAAAAAhWZXJpZmllcgAAAAEAAAATAAAAAAAAAAAAAAAJTmV0d29ya0lkAAAAAAAAAQAAAEVDYW5vbmljYWwgcGF5bWVudCByZWNlaXB0LCBrZXllZCBieSBpdHMgY2FsbGVyLWFzc2lnbmVkIGByZWNlaXB0X2lkYC4AAAAAAAAOUGF5bWVudFJlY2VpcHQAAAAAAAEAAAAQAAAAAQAAAMhTZWNvbmRhcnkgaW5kZXggbWFwcGluZyBgKHJlc291cmNlX2lkLCBwYXllcilgIHRvIHRoZSBgcmVjZWlwdF9pZGAgb2YKdGhlIG1vc3QgcmVjZW50IHBheW1lbnQgcmVjb3JkZWQgZm9yIHRoYXQgcGFpciwgc28gZXNjcm93L2xlYXNlCmNvbnRyYWN0cyBjYW4gbG9vayB1cCBhIHNldHRsZW1lbnQgd2l0aG91dCBzY2FubmluZyBldmVudCBoaXN0b3J5LgAAAAxQYXltZW50SW5kZXgAAAACAAAAEAAAABMAAAABAAAAqFNlY29uZGFyeSBpbmRleCBtYXBwaW5nIGEgc2V0dGxlbWVudCB0cmFuc2FjdGlvbiBoYXNoIHRvIHRoZQpgcmVjZWlwdF9pZGAgcmVjb3JkZWQgZm9yIGl0LCBndWFyYW50ZWVpbmcgb25lIHBheW1lbnQgcmVjZWlwdCBwZXIKU3RlbGxhciB0eCAoYER1cGxpY2F0ZVR4SGFzaGAgb24gcmV1c2UpLgAAAA1QYXltZW50VHhIYXNoAAAAAAAAAQAAABAAAAABAAAAg0FkZHJlc3MgdGhhdCBvcmlnaW5hbGx5IGZ1bmRlZCBhIHBheW1lbnQgcmVjZWlwdCwgcHJlc2VydmVkIGFjcm9zcwpzZXR0bGVtZW50IHNvIHJlZnVuZHMgY2FuIGJlIHJvdXRlZCBiYWNrIHdpdGhvdXQgcmUtZGVyaXZpbmcgaXQuAAAAABBQYXltZW50UmVjaXBpZW50AAAAAQAAABAAAAABAAAAQ0Nhbm9uaWNhbCByZWZ1bmQgcmVjZWlwdCwga2V5ZWQgYnkgaXRzIGNhbGxlci1hc3NpZ25lZCBgcmVmdW5kX2lkYC4AAAAADVJlZnVuZFJlY2VpcHQAAAAAAAABAAAAEAAAAAEAAABFU2Vjb25kYXJ5IGluZGV4IG1hcHBpbmcgYSByZWZ1bmQgdHJhbnNhY3Rpb24gaGFzaCB0byBpdHMgYHJlZnVuZF9pZGAuAAAAAAAADFJlZnVuZFR4SGFzaAAAAAEAAAAQAAAAAQAAAEZMZWRnZXIgc2VxdWVuY2UgYXQgd2hpY2ggYSByZWZ1bmQgd2luZG93IGNsb3NlcyBmb3IgYSBwYXltZW50IHJlY2VpcHQuAAAAAAAOUmVmdW5kRGVhZGxpbmUAAAAAAAEAAAAQAAAAAQAAADNDdW11bGF0aXZlIFVTREMgcmVmdW5kZWQgYWdhaW5zdCBhIHBheW1lbnQgcmVjZWlwdC4AAAAADlJlZnVuZGVkQW1vdW50AAAAAAABAAAAEAAAAAAAAAA0Q29uZmlndXJlZCBjcmVhdG9yLXJlZnVuZCB3aW5kb3cgbGVuZ3RoLCBpbiBsZWRnZXJzLgAAAAxSZWZ1bmRXaW5kb3cAAAABAAAALEFjdGl2ZSBsZWFzZSBoZWxkIGJ5IGBob2xkZXJgIG9uIGEgcmVzb3VyY2UuAAAABUxlYXNlAAAAAAAAAgAAABAAAAATAAAAAQAAADJBbmNob3IgYXR0ZW1wdCBjb3VudGVyIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgLgAAAAAADkFuY2hvckF0dGVtcHRzAAAAAAACAAAAEAAAABMAAAAAAAAAQlJlZ2lzdHJ5LWxldmVsIGxpc3RpbmcgdGVybXMgaGFzaCAoZmFsbGJhY2sgZm9yIGBnZXRfdGVybXNfaGFzaGApLgAAAAAADVJlZ2lzdHJ5VGVybXMAAAAAAAAAAAAAWEVtZXJnZW5jeSBwYXVzZSBmbGFnLiBXaGVuIGB0cnVlYCwgZXZlcnkgc3RhdGUtY2hhbmdpbmcgbWV0aG9kCnJldHVybnMgYENvbnRyYWN0UGF1c2VkYC4AAAAGUGF1c2VkAAAAAAAAAAAAQFVuaXggdGltZXN0YW1wIGF0IHdoaWNoIGEgc2NoZWR1bGVkIHBhdXNlIGF1dG9tYXRpY2FsbHkgZXhwaXJlcy4AAAAKUGF1c2VVbnRpbAAAAAAAAQAAAERTZXR0bGVyIHJvbGUgZ3JhbnQsIGF1dGhvcml6aW5nIGByZWNvcmRfcGF5bWVudGAgLyBgc2V0dGxlX3BheW1lbnRgLgAAAAdTZXR0bGVyAAAAAAEAAAATAAAAAQAAAD1JbW11dGFibGUgcHVyY2hhc2UgcmVjZWlwdCBhbmNob3IgZm9yIGAocmVzb3VyY2VfaWQsIGJ1eWVyKWAuAAAAAAAAD1B1cmNoYXNlUmVjZWlwdAAAAAACAAAAEAAAABMAAAABAAAAV0R1cmFibGUgYW5jaG9yLWZhaWx1cmUgcmVjb3JkLCByZWFkYWJsZSBieSB0aGUgYnV5ZXIuIENsZWFyZWQgYnkgYW55CnN1Y2Nlc3NmdWwgYW5jaG9yLgAAAAANQW5jaG9yRmFpbHVyZQAAAAAAAAIAAAAQAAAAEwAAAAEAAABBU2Vjb25kYXJ5IGluZGV4IG1hcHBpbmcgYSBub3JtYWxpemVkIHRhZyB0byBvcmRlcmVkIHJlc291cmNlIGlkcy4AAAAAAAAIVGFnSW5kZXgAAAABAAAAEAAAAAAAAAAtUmVnaXN0cnktbGV2ZWwgZmVlIGFuZCByb3lhbHR5IGNvbmZpZ3VyYXRpb24uAAAAAAAACUZlZUNvbmZpZwAAAAAAAAEAAAAAAAAACU1vZGVyYXRvcgAAAAAAAAEAAAATAAAAAQAAAAAAAAALRGlzcHV0ZUZsYWcAAAAAAQAAABAAAAAAAAAAMk51bWJlciBvZiByZXNvdXJjZXMgY3VycmVudGx5IGluIHRoZSBMaXN0ZWQgc3RhdGUuAAAAAAALTGlzdGVkQ291bnQAAAAAAQAAAP5IYXNoIG9mIGEgbW9kZXJhdG9yJ3Mgb2ZmLWNoYWluIGRpc3B1dGUgcmVhc29uIHdyaXRldXAgZm9yIGEgcmVzb3VyY2UsCnNldCB2aWEgYHNldF9mbGFnX3JlYXNvbl9oYXNoYC4gSW5kZXBlbmRlbnQgb2YgYEZsYWdSZWFzb25gIChhIGZpeGVkCmVudW0gY29kZSk6IHRoaXMgY2FycmllcyBhIGRpZ2VzdCBvZiBmcmVlLWZvcm0gZGV0YWlsIGEgbW9kZXJhdG9yCnJlY29yZGVkIG9mZi1jaGFpbiwgYW5hbG9nb3VzIHRvIGBDcmVhdG9yVGVybXNgLgAAAAAADkZsYWdSZWFzb25IYXNoAAAAAAABAAAAEAAAAAEAAABzSGFzaCBvZiBhIHZlcmlmaWVyJ3Mgb2ZmLWNoYWluIGF0dGVzdGF0aW9uIGRvY3VtZW50LCBwcm92aWRlZCBkdXJpbmcgYQpzdGF0dXMgY2hhbmdlIHZpYSBgc2V0X3ZlcmlmaWNhdGlvbl9zdGF0dXNgLgAAAAAPQXR0ZXN0YXRpb25IYXNoAAAAAAEAAAAQAAAAAAAAAD5MZWRnZXIgc2VxdWVuY2UgYXQgd2hpY2ggdGhlIHBlbmRpbmcgYWRtaW4gbm9taW5hdGlvbiBleHBpcmVzLgAAAAAAElBlbmRpbmdBZG1pbkV4cGlyeQAAAAAAAAAAAMhMZWRnZXIgc2VxdWVuY2UgYXQgd2hpY2ggdGhlIHBlbmRpbmcgYWRtaW4gbm9taW5hdGlvbiB3YXMgY3JlYXRlZC4KVXNlZCB0byBlbmZvcmNlIGBBRE1JTl9OT01JTkFUSU9OX01JTl9HQVBgIGluIGBhY2NlcHRfYWRtaW5gIHNvIHRoYXQKbm9taW5hdGUgYW5kIGFjY2VwdCBjYW5ub3QgYmUgYmF0Y2hlZCBpbnRvIGEgc2luZ2xlIHRyYW5zYWN0aW9uLgAAABdQZW5kaW5nQWRtaW5Ob21pbmF0ZWRBdAAAAAABAAAAAAAAAAhUYWdDb3VudAAAAAEAAAAQAAAAAAAAAAAAAAAHVG9wVGFncwAAAAABAAABBU51bWJlciBvZiBgY3JlYXRvcmAncyByZXNvdXJjZXMgY3VycmVudGx5IGluIHRoZSBgTGlzdGVkYCBzdGF0ZS4gS2VwdAppbiBzdGVwIHdpdGggYExpc3RlZENvdW50YCBvbiBldmVyeSBsaXN0ZWQtc3RhdGUgdHJhbnNpdGlvbiBhbmQgbW92ZWQKYmV0d2VlbiBvd25lcnMgb24gdHJhbnNmZXIsIHNvIGl0IGlzIHRoZSBwZXItY3JlYXRvciB2aWV3IG9mCmBsaXN0ZWRfY291bnRgIGluIHRoZSBzYW1lIHdheSBgQ3JlYXRvckNvdW50YCBpcyBvZiBgY291bnRgLgAAAAAAABJDcmVhdG9yTGlzdGVkQ291bnQAAAAAAAEAAAATAAAAAQAAAQ1PcHRpb25hbCAzMi1ieXRlIG1lbW8gaGFzaCByZWNvcmRlZCBhdCByZWdpc3RyYXRpb24gdGhyb3VnaApgcmVnaXN0ZXJfd2l0aF9tZW1vYCwgZm9yIGV4YW1wbGUgdGhlIGBNRU1PX0hBU0hgIG9mIHRoZSB0cmFuc2FjdGlvbgp0aGF0IGFubm91bmNlZCBvciBwYWlkIGZvciB0aGUgcmVnaXN0cmF0aW9uLiBXcml0dGVuIG9uY2UgYW5kIG5ldmVyCm11dGF0ZWQ7IGBOb25lYCBmb3IgcmVzb3VyY2VzIHJlZ2lzdGVyZWQgdGhyb3VnaCB0aGUgb3RoZXIgZW50cnkgcG9pbnRzLgAAAAAAAAhNZW1vSGFzaAAAAAEAAAAQAAAAAAAAAAAAAAAORmVlRGVzdGluYXRpb24AAAAAAAEAAAB3UmVkdW5kYW50IG1ldGFkYXRhIHBvaW50ZXJzIHNldCB2aWEgYHNldF9tZXRhZGF0YV9wb2ludGVyc2AuIFRoZQplbnRyeSBhdCBgcHJpbWFyeWAgYWx3YXlzIG1pcnJvcnMgYFJlc291cmNlLm1ldGFkYXRhYC4AAAAAEE1ldGFkYXRhUG9pbnRlcnMAAAABAAAAEAAAAAEAAACETW9kZXJhdG9yIHdobyBsYXN0IGNhbGxlZCBgZmxhZ19yZXNvdXJjZWAsIGB1bmZsYWdfcmVzb3VyY2VgLCBvcgpgc2V0X2ZsYWdfcmVhc29uX2hhc2hgIGZvciBhIHJlc291cmNlLiBSZWFkIGJhY2sgYnkgYGZsYWdfZGV0YWlsc2AuAAAADUZsYWdNb2RlcmF0b3IAAAAAAAABAAAAEAAAAAEAAAEWQWdncmVnYXRlZCBzZXR0bGVkLXBheW1lbnQgZWFybmluZ3MgZm9yIGEgY3JlYXRvciB3YWxsZXQgYWRkcmVzcy4KV3JpdHRlbiBieSBgc2V0dGxlX3BheW1lbnRgIGFuZCByZWFkIGJ5IGBjcmVhdG9yX2Vhcm5pbmdzX2VzdGltYXRlYC4KVmFsdWUgdHlwZTogYChpMTI4LCB1MzIpYCB0dXBsZSDigJQgKHRvdGFsIFVTREMgc3Ryb29wcyBvZiBhbGwgc2V0dGxlZApyZWNlaXB0cyBmb3IgcmVzb3VyY2VzIG93bmVkIGJ5IHRoaXMgY3JlYXRvciBhdCBzZXR0bGVtZW50IHRpbWUsIGNvdW50KS4AAAAAAA9DcmVhdG9yRWFybmluZ3MAAAAAAQAAABMAAAABAAAAu09yZGVyZWQgaGlzdG9yeSBvZiB2ZXJpZmljYXRpb24gc3RhdHVzIGNoYW5nZXMgZm9yIGEgdmVyaWZpZXIgYWRkcmVzcy4KV3JpdHRlbiBieSBgc2V0X3ZlcmlmaWNhdGlvbl9zdGF0dXNgOyByZWFkIGJ5IGBnZXRfdmVyaWZpZXJfc3RhdHVzX2hpc3RvcnlgLgpWYWx1ZSB0eXBlOiBgVmVjPFZlcmlmaWVyU3RhdHVzRW50cnk+YC4AAAAAD1ZlcmlmaWVySGlzdG9yeQAAAAABAAAAEwAAAAAAAACCT3B0aW9uYWwgcmVjb3ZlcnkgYWRtaW4gc2V0IHZpYSBgYm9vdHN0cmFwX2R1YWxfYWRtaW5gIG9yCmBzZXRfcmVjb3ZlcnlfYWRtaW5gOyBtYXkgY2FsbCBgcmVjb3Zlcl9hZG1pbmAgaWYgdGhlIGFkbWluIGtleSBpcyBsb3N0LgAAAAAADVJlY292ZXJ5QWRtaW4AAAAAAAABAAAAq01vbm90b25pYyBsaXN0aW5nIHJldmlzaW9uIGZvciBhIHJlc291cmNlLCBidW1wZWQgb25jZSBwZXIgc3VjY2Vzc2Z1bAptZXRhZGF0YSBvciBwcmljZSBjaGFuZ2UuIEFic2VudCAocmVhZCBhcyBgMGApIHVudGlsIHRoZSBmaXJzdCBzdWNoCm11dGF0aW9uLiBSZWFkIGJ5IGBnZXRfcmV2aXNpb25gLgAAAAAIUmV2aXNpb24AAAABAAAAEA==",
        "AAAAAAAAADlGZXRjaCBhIHJlZnVuZCByZWNvcmQgYnkgaXRzIGNhbGxlci1hc3NpZ25lZCBgcmVmdW5kX2lkYC4AAAAAAAAKZ2V0X3JlZnVuZAAAAAAAAQAAAAAAAAAJcmVmdW5kX2lkAAAAAAAAEAAAAAEAAAPpAAAH0AAAAA1SZWZ1bmRSZWNlaXB0AAAAAAAAAw==",
        "AAAAAAAAAHVXaGV0aGVyIGEgcmVzb3VyY2UgY3VycmVudGx5IGNhcnJpZXMgYSBtb2RlcmF0b3IgZGlzcHV0ZSBmbGFnLgpFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIHRoZSByZXNvdXJjZSBkb2VzIG5vdCBleGlzdC4AAAAAAAAKaXNfZmxhZ2dlZAAAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAADNXaGV0aGVyIGBhZGRyZXNzYCBjdXJyZW50bHkgaG9sZHMgdGhlIHNldHRsZXIgcm9sZS4AAAAACmlzX3NldHRsZXIAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAItSZXR1cm4gdGhlIGluaXRpYWxpemVkIG5ldHdvcmsgaWRlbnRpZmllci4gQ2FsbGVycyBjYW4gdXNlIHRoaXMgdmFsdWUKYXMgYSBkZXBsb3ltZW50IGd1YXJkIGJlZm9yZSBzdWJtaXR0aW5nIG5ldHdvcmstc2Vuc2l0aXZlIG9wZXJhdGlvbnMuAAAAAApuZXR3b3JrX2lkAAAAAAAAAAAAAQAAA+kAAAPuAAAAIAAAAAM=",
        "AAAAAAAAALhTZXQgYSByZXNvdXJjZSdzIGNyZWF0b3ItY29udHJvbGxlZCBsaXN0aW5nIHN0YXRlLiBPbmx5CmBMaXN0ZWQgPC0+IERlbGlzdGVkYCB0cmFuc2l0aW9ucyBhcmUgYWNjZXB0ZWQ7IGFsbCBvdGhlciBsaWZlY3ljbGUKc3RhdGVzIHJlamVjdCB0aGlzIG1ldGhvZCB3aXRoIGBJbnZhbGlkTGlmZWN5Y2xlVHJhbnNpdGlvbmAuAAAACnNldF9saXN0ZWQAAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAZsaXN0ZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAiZTZXQgb3IgY2xlYXIgdGhlIGVtZXJnZW5jeSBwYXVzZSBvbiBhbGwgcmVnaXN0cnkgbXV0YXRpb25zLgoKV2hlbiBgcGF1c2VkYCBpcyBgdHJ1ZWAgZXZlcnkgd3JpdGUgbWV0aG9kIHJldHVybnMKW2BFcnJvcjo6Q29udHJhY3RQYXVzZWRgXSB3aXRob3V0IG1vZGlmeWluZyBhbnkgc3RhdGUuIFJlYWQtb25seQptZXRob2RzIGFyZSB1bmFmZmVjdGVkIGFuZCByZW1haW4gZnVsbHkgYXZhaWxhYmxlLgoKUmVxdWlyZXMgdGhlIGN1cnJlbnQgYWRtaW4ncyBhdXRob3JpemF0aW9uLiBFcnJvcnMgYEFkbWluTm90U2V0YCBpZiBubwphZG1pbiBoYXMgYmVlbiBzZXQgeWV0LCBhbmQgYFVuYXV0aG9yaXplZGAgaWYgYGFkbWluYCBpcyBub3QgdGhlCmN1cnJlbnQgYWRtaW4uCgpFbWl0cyBhIGBwYXVzZWAgZXZlbnQgd2l0aCBkYXRhIGAocGF1c2VkOiBib29sLCBhZG1pbjogQWRkcmVzcylgIG9uCmV2ZXJ5IGNhbGwsIGluY2x1ZGluZyBuby1vcCB0cmFuc2l0aW9ucywgc28gb2ZmLWNoYWluIG1vbml0b3JzIGNhbgpkZXRlY3QgcmFwaWQgcGF1c2UvdW5wYXVzZSBjeWNsZXMuAAAAAAAKc2V0X3BhdXNlZAAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAgAAAz5DdXJzb3IgcGFzc2VkIHRvIGFuZCByZXR1cm5lZCBieSB0aGUgaWQtaW5kZXhlZCBsaXN0aW5ncwooYGxpc3RfYnlfY3JlYXRvcl9wYWdlYCwgYGxpc3RfYnlfdGFnX3BhZ2VgKS4gUGFzcyBgU3RhcnRgIGZvciB0aGUgZmlyc3QKcGFnZSBhbmQgZWFjaCBwYWdlJ3MgYG5leHRfY3Vyc29yYCBmb3IgdGhlIGZvbGxvd2luZyBvbmU7IGBFbmRgIGJhY2sgbWVhbnMKZW5kLW9mLWxpc3QgKHBhc3NpbmcgYEVuZGAgaW4gcmV0dXJucyBhbiBlbXB0eSBwYWdlKS4KClRoZSBiYWNraW5nIGluZGV4IHZlY3RvcnMgY2FuIGxvc2UgZW50cmllcyBiZXR3ZWVuIHBhZ2VzICh0b21ic3RvbmUsCm93bmVyc2hpcCB0cmFuc2ZlciksIHNvIGEgcGxhaW4gcG9zaXRpb24gd291bGQgc2tpcCBvciByZXBlYXQgZW50cmllcyB3aGVuCnRoZSB2ZWN0b3Igc2hpZnRzLiBgQWZ0ZXIocG9zaXRpb24sIGxhc3RfaWQsIGNyZWF0ZWRfYXQpYCBuYW1lcyB0aGUgbGFzdApyZXNvdXJjZSByZXR1cm5lZCBpbnN0ZWFkOiBpdHMgaW5kZXggaW4gdGhlIHZlY3RvciB3aGVuIHRoZSBwYWdlIHdhcwpidWlsdCwgaXRzIGlkLCBhbmQgaXRzIHJlZ2lzdHJhdGlvbiBsZWRnZXIuIFJlc3VtaW5nIGxvb2tzIHRoZSBpZCB1cAphZ2FpbjogYXQgYHBvc2l0aW9uYCBvbiB0aGUgZmFzdCBwYXRoLCBhbnl3aGVyZSBpbiB0aGUgdmVjdG9yIGlmIGVudHJpZXMKYmVmb3JlIGl0IHdlcmUgcmVtb3ZlZCwgYW5kLCBpZiB0aGUgaWQgaXRzZWxmIGlzIGdvbmUsIGF0IHRoZSBmaXJzdCBlbnRyeQpyZWdpc3RlcmVkIGFmdGVyIGl0IChgY3JlYXRlZF9hdGApLCBmYWxsaW5nIGJhY2sgdG8gaXRzIGZvcm1lciBzbG90LgAAAAAAAAAAAAhJZEN1cnNvcgAAAAMAAAAAAAAAAAAAAAVTdGFydAAAAAAAAAEAAAAAAAAABUFmdGVyAAAAAAAAAwAAAAQAAAAQAAAABAAAAAAAAAAAAAAAA0VuZAA=",
        "AAAAAQAAAAAAAAAAAAAACFJlc291cmNlAAAAEQAAAKtPcHRpb25hbCBpbW11dGFibGUgZGlnZXN0IG9mIHRoZSByZXNvdXJjZSdzIG9mZi1jaGFpbiBjb250ZW50LCBzZXQKb25jZSBhdCByZWdpc3RyYXRpb24gdmlhIGByZWdpc3Rlcl93aXRoX2hhc2hgLiBgTm9uZWAgZm9yIHJlc291cmNlcwpyZWdpc3RlcmVkIHRocm91Z2ggcGxhaW4gYHJlZ2lzdGVyYC4AAAAADGNvbnRlbnRfaGFzaAAAA+gAAAAQAAAAfUxlZGdlciBzZXF1ZW5jZSBudW1iZXIgYXQgd2hpY2ggdGhpcyByZXNvdXJjZSB3YXMgZmlyc3QgcmVnaXN0ZXJlZC4KVGhpcyB2YWx1ZSBpcyBpbW11dGFibGUgZm9yIHRoZSBsaWZldGltZSBvZiB0aGUgcmVzb3VyY2UuAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAQAAAAAAAAAB2NyZWF0b3IAAAAAEwAAASJBY3RpdmUgZGlzcHV0ZSBmbGFnIHNldCBieSBhIG1vZGVyYXRvciwgb3IgYERpc3B1dGVGbGFnOjpOb0ZsYWdgIGlmIHRoZQpyZXNvdXJjZSBpcyBub3QgZmxhZ2dlZC4gRmxhZ2dpbmcgZG9lcyBub3QgZGVsaXN0IG9yIGRlbGV0ZSB0aGUgcmVzb3VyY2Ug4oCUCml0IGlzIGluZm9ybWF0aW9uYWwgc3RhdGUgdGhhdCBjYWxsZXJzIGNhbiBmaWx0ZXIgb24uIE9ubHkgYSBtb2RlcmF0b3IgbWF5CnNldCBvciBjbGVhciB0aGlzIGZpZWxkIChzZWUgYGZsYWdfcmVzb3VyY2VgIC8gYHVuZmxhZ19yZXNvdXJjZWApLgAAAAAADGRpc3B1dGVfZmxhZwAAB9AAAAALRGlzcHV0ZUZsYWcAAAAAQU9uY2UgdHJ1ZSwgYHVwZGF0ZV9tZXRhZGF0YWAgcGVybWFuZW50bHkgcmVqZWN0cyBmdXJ0aGVyIGNoYW5nZXMuAAAAAAAABmZyb3plbgAAAAAAAQAAAAAAAAACaWQAAAAAABAAAABEQmFja3dhcmRzLWNvbXBhdGlibGUgcHJvamVjdGlvbiBvZiBgc3RhdGUgPT0gUmVzb3VyY2VTdGF0ZTo6TGlzdGVkYC4AAAAGbGlzdGVkAAAAAAABAAAAAAAAAAhtZXRhZGF0YQAAABAAAABlTGVkZ2VyIHNlcXVlbmNlIHdoZW4gYGZyZWV6ZV9tZXRhZGF0YWAgd2FzIGZpcnN0IGNhbGxlZC4gYE5vbmVgIHVudGlsCnRoZSBtZXRhZGF0YSBwb2ludGVyIGlzIGZyb3plbi4AAAAAAAASbWV0YWRhdGFfZnJvemVuX2F0AAAAAAPoAAAABAAAADhMaXN0ZWQgcHJpY2UgaW4gVVNEQyBiYXNlIHVuaXRzIChbYFVTRENfREVDSU1BTFNgXSA9IDcpLgAAAAVwcmljZQAAAAAAAAsAAADZT3B0aW9uYWwgcGVyLXJlc291cmNlIHJveWFsdHkgcmVjaXBpZW50IG92ZXJyaWRlLiBXaGVuIHNldCwgcm95YWx0aWVzCmZvciB0aGlzIHJlc291cmNlIGdvIHRvIHRoaXMgYWRkcmVzcyBpbnN0ZWFkIG9mIHRoZSBnbG9iYWwgZmVlX3JlY2lwaWVudC4KT25seSB0aGUgcmVzb3VyY2UgY3JlYXRvciBtYXkgc2V0IHRoaXMgZmllbGQgdmlhIGBzZXRfcm95YWx0eV9yZWNpcGllbnRgLgAAAAAAABFyb3lhbHR5X3JlY2lwaWVudAAAAAAAA+gAAAATAAAAPU9uLWNoYWluIGBSZXNvdXJjZWAgc2NoZW1hIHZlcnNpb24gZm9yIGRlY29kZXIgY29tcGF0aWJpbGl0eS4AAAAAAAAOc2NoZW1hX3ZlcnNpb24AAAAAAAQAAACCRXhwbGljaXQgcmVzb3VyY2UgbGlmZWN5Y2xlIHN0YXRlLiBTZWUgYGNvbnRyYWN0L1JFQURNRS5tZGAgZm9yIHRoZQp0cmFuc2l0aW9uIHRhYmxlIGFuZCB0aGUgcm9sZSBhbGxvd2VkIHRvIG1ha2UgZWFjaCB0cmFuc2l0aW9uLgAAAAAABXN0YXRlAAAAAAAH0AAAAA1SZXNvdXJjZVN0YXRlAAAAAAAAk0Rpc2NvdmVyeSBsYWJlbHMgKGUuZy4gImRhdGFzZXQiLCAicmVzZWFyY2giKS4gRGlzdGluY3QgZnJvbSBgbWV0YWRhdGFgLAp3aGljaCByZW1haW5zIHRoZSBvZmYtY2hhaW4gY29udGVudCBhbmNob3IgKElQRlMgVVJJLCBjb250ZW50IGhhc2gsIGV0Yy4pLgAAAAAEdGFncwAAA+oAAAAQAAAAukxlZGdlciBzZXF1ZW5jZSBudW1iZXIgYXQgd2hpY2ggdGhpcyByZXNvdXJjZSB3YXMgbGFzdCB3cml0dGVuCihyZWdpc3RlciBvciBhbnkgbXV0YXRpb24pLiBDbGllbnRzIGNhbiB1c2UgdGhpcyB0byBkZXRlY3Qgc3RhbGVuZXNzCm9yIG9yZGVyIGV2ZW50cyB3aXRob3V0IHRydXN0aW5nIG9mZi1jaGFpbiB0aW1lc3RhbXBzLgAAAAAACnVwZGF0ZWRfYXQAAAAAAAQAAAA6T24tY2hhaW4gdmVyaWZpY2F0aW9uIHN0YXR1cywgc2V0dGFibGUgb25seSBieSBhIHZlcmlmaWVyLgAAAAAACHZlcmlmaWVkAAAH0AAAABJWZXJpZmljYXRpb25TdGF0dXMAAAAAAJZNb25vdG9uaWMgd3JpdGUgY291bnRlciwgaW5jcmVtZW50ZWQgb24gZXZlcnkgcGVyc2lzdGVkIG11dGF0aW9uLgpDbGllbnRzIGNhbiB1c2UgaXQgYXMgYW4gb3B0aW1pc3RpYy1jb25jdXJyZW5jeSB0b2tlbiB3aXRob3V0CmNvbXBhcmluZyBldmVyeSBmaWVsZC4AAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAAAAAKhHcmFudCB0aGUgc2V0dGxlciByb2xlIHRvIGBzZXR0bGVyYCwgYXV0aG9yaXppbmcgYHJlY29yZF9wYXltZW50YCBhbmQKYHNldHRsZV9wYXltZW50YC4gT25seSB0aGUgYWRtaW4gbWF5IGNhbGwgdGhpcy4gRXJyb3JzIGBBZG1pbk5vdFNldGAKaWYgbm8gYWRtaW4gaGFzIGJlZW4gc2V0IHlldC4AAAALYWRkX3NldHRsZXIAAAAAAQAAAAAAAAAHc2V0dGxlcgAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAlNCYXRjaCBleGlzdGVuY2UgY2hlY2suIFJldHVybnMgYSBgVmVjPGJvb2w+YCBwYXJhbGxlbCB0byBgaWRzYDoKYHJlc3VsdFtpXWAgaXMgYHRydWVgIGlmZiBhIHJlc291cmNlIHdpdGggYGlkc1tpXWAgaXMgcmVnaXN0ZXJlZC4KClNlbWFudGljcyBtYXRjaCBgZXhpc3RzYCBmb3IgZWFjaCBlbGVtZW50OiBJRHMgdGhhdCBmYWlsIGZvcm1hdAp2YWxpZGF0aW9uIGFyZSB0cmVhdGVkIGFzIGFic2VudCAoYGZhbHNlYCkgcmF0aGVyIHRoYW4gZXJyb3JpbmcuClRUTCBpcyBidW1wZWQgZm9yIGV2ZXJ5IElEIHRoYXQgcmVzb2x2ZXMgdG8gYSByZWdpc3RlcmVkIHJlc291cmNlLAprZWVwaW5nIHRoZSBob3QgZW50cmllcyBhbGl2ZSBleGFjdGx5IGFzIGEgc2VxdWVuY2Ugb2YgaW5kaXZpZHVhbApgZXhpc3RzYCBjYWxscyB3b3VsZC4KClRoaXMgaXMgdXNlZnVsIGZvciBzZXJ2ZXItc2lkZSBidWxrIHZhbGlkYXRpb24gYmVmb3JlIHB1Ymxpc2hpbmcgb3IKcmVjb25jaWxpYXRpb24g4oCUIGNhbGxlcnMgY2FuIGNoZWNrIG1hbnkgSURzIGluIGEgc2luZ2xlIGNvbnRyYWN0Cmludm9jYXRpb24gaW5zdGVhZCBvZiBvbmUgcm91bmQtdHJpcCBwZXIgSUQuAAAAAAtleGlzdHNfbWFueQAAAAABAAAAAAAAAANpZHMAAAAD6gAAABAAAAABAAAD6gAAAAE=",
        "AAAAAAAAA41Cb3VuZGVkLCBkZXRlcm1pbmlzdGljIGV4cG9ydCBvZiBldmVyeSByZXNvdXJjZSBmb3IgbWlncmF0aW9uIGFuZAphdWRpdCB0b29saW5nLCBpbiBjYXRhbG9nIGluZGV4IG9yZGVyLgoKLSBFYWNoIGNhbGwgcmVhZHMgYXQgbW9zdCBgRVhQT1JUX1BBR0VfQ0FQYCBpbmRleCBzbG90cywgc3RhcnRpbmcgYXQKYGN1cnNvcmAuIGBsaW1pdGAgaXMgY2xhbXBlZCB0byBgMS4uPUVYUE9SVF9QQUdFX0NBUGAsIHNvIGEgYDBgIGxpbWl0CnN0aWxsIG1ha2VzIHByb2dyZXNzIGluc3RlYWQgb2YgcmV0dXJuaW5nIHRoZSBzYW1lIGN1cnNvciBmb3JldmVyLgotIEV2ZXJ5IGxpZmVjeWNsZSBzdGF0ZSBpcyBleHBvcnRlZCwgaW5jbHVkaW5nIGBEZWxpc3RlZGAsIGBGcm96ZW5gLApgRGlzcHV0ZWRgLCBhbmQgYFRvbWJzdG9uZWRgOiBhIG1pZ3JhdGlvbiBtdXN0IHNlZSB0aGUgd2hvbGUgcmVnaXN0cnksCm5vdCBvbmx5IHdoYXQgaXMgZm9yIHNhbGUuCi0gRW50cmllcyBhcmUgcmVhZCB3aXRob3V0IHRoZSBzY2hlbWEgZ3VhcmQgdXNlZCBieSBtdXRhdGlvbnMsIHNvIGEKcmVzb3VyY2Ugc3RpbGwgb24gYW4gb2xkZXIgYHNjaGVtYV92ZXJzaW9uYCBpcyBleHBvcnRlZCAoYW5kIGNhbiBiZQpmb3VuZCBhbmQgbWlncmF0ZWQpIHJhdGhlciB0aGFuIGZhaWxpbmcgdGhlIHBhZ2UuCi0gVGhlIHNhbWUgc3RvcmFnZSBhbHdheXMgeWllbGRzIHRoZSBzYW1lIHBhZ2VzLiBgbmV4dF9jdXJzb3JgIGlzIHRoZQpuZXh0IGluZGV4IHNsb3QgdG8gcmVhZCwgb3IgYE5vbmVgIGF0IHRoZSBlbmQuCi0gT25seSB0aGUgW2BSZXNvdXJjZUV4cG9ydGBdIGFsbG93bGlzdCBpcyByZXR1cm5lZDsgbm8gcHJpdmF0ZSB2YWx1ZXMuCi0gUmVhZC1vbmx5IGFuZCBhdmFpbGFibGUgd2hpbGUgdGhlIGNvbnRyYWN0IGlzIHBhdXNlZC4AAAAAAAALZXhwb3J0X3BhZ2UAAAAAAgAAAAAAAAAGY3Vyc29yAAAAAAAEAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAH0AAAAApFeHBvcnRQYWdlAAA=",
        "AAAAAAAAAJtGZXRjaCBhIHBheW1lbnQgcmVjZWlwdCBieSBpdHMgYHJlY2VpcHRfaWRgLiBFcnJvcnMgYE5vdEZvdW5kYCB3aGVuIG5vCnJlY2VpcHQgaGFzIGJlZW4gcmVjb3JkZWQgdW5kZXIgdGhhdCBpZC4gQnVtcHMgdGhlIGVudHJ5J3MgVFRMIG9uIGEKc3VjY2Vzc2Z1bCByZWFkLgAAAAALZ2V0X3BheW1lbnQAAAAAAQAAAAAAAAAKcmVjZWlwdF9pZAAAAAAAEAAAAAEAAAPpAAAH0AAAAA5QYXltZW50UmVjZWlwdAAAAAAAAw==",
        "AAAAAAAAADRXaGV0aGVyIGBhZGRyZXNzYCBjdXJyZW50bHkgaG9sZHMgdGhlIHZlcmlmaWVyIHJvbGUuAAAAC2lzX3ZlcmlmaWVyAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAALRQcmljZSBvZiBhIGxlYXNlIG9mIGB0aWVyYCBvbiBgcmVzb3VyY2VfaWRgOiB0aGUgcmVzb3VyY2UncyBjdXJyZW50CnBlci1yZXF1ZXN0IHByaWNlIHRpbWVzIHRoZSB0aWVyJ3MgbXVsdGlwbGllciAoYExFQVNFXypfTVVMVElQTElFUmApLgpFcnJvcnMgYE5vdEZvdW5kYCBmb3IgYW4gdW5rbm93biByZXNvdXJjZS4AAAALbGVhc2VfcHJpY2UAAAAAAgAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAEdGllcgAAB9AAAAAJTGVhc2VUaWVyAAAAAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAXVSZXR1cm4gdGhlIHJlc291cmNlIGlkcyB0YWdnZWQgd2l0aCBgdGFnYCAobm9ybWFsaXplZCB0byBsb3dlcmNhc2UpLApwYWdpbmF0ZWQgYnkgYHN0YXJ0YC9gbGltaXRgLiBgbGltaXRgIGlzIGNhcHBlZCBhdCAyMC4gUmVzb3VyY2VzIGFyZQpyZXR1cm5lZCBpbiB0aGUgb3JkZXIgdGhleSB3ZXJlIGFkZGVkIHRvIHRoZSB0YWcgaW5kZXggKGluc2VydGlvbgpvcmRlciBwZXIgdGFnKS4gSWYgdGhlIHRhZyBoYXMgbmV2ZXIgYmVlbiBhc3NpZ25lZCB0byBhbnkgcmVzb3VyY2UKcmV0dXJucyBhbiBlbXB0eSB2ZWMuIEVhY2ggcmVzb3VyY2UgZW50cnkgdGhhdCBpcyByZWFkIGhhcyBpdHMgVFRMCmJ1bXBlZCB0byBrZWVwIGhvdCByZXNvdXJjZXMgYWxpdmUuAAAAAAAAC2xpc3RfYnlfdGFnAAAAAAMAAAAAAAAAA3RhZwAAAAAQAAAAAAAAAAVzdGFydAAAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPqAAAH0AAAAAhSZXNvdXJjZQ==",
        "AAAAAAAAAR9QYWdpbmF0ZWQgbGlzdCBvZiByZXNvdXJjZXMgd2hvc2UgYGxpc3RlZGAgZmxhZyBpcyB0cnVlLCBpbiBpbnNlcnRpb24gb3JkZXIuCgotIFJlc291cmNlcyBhcmUgb3JkZXJlZCBieSByZWdpc3RyYXRpb24gc2VxdWVuY2UuCi0gYGxpbWl0YCBpcyBjYXBwZWQgYXQgYDIwYC4KLSBEZWxpc3RlZCByZXNvdXJjZXMgYXJlIHNraXBwZWQ7IHJlbGlzdGVkIHJlc291cmNlcyB3aWxsIHJlYXBwZWFyLgotIFJldHVybnMgYW4gZW1wdHkgYFZlY2AgaWYgbm8gbGlzdGVkIHJlc291cmNlcyBmYWxsIGluIHJhbmdlLgAAAAALbGlzdF9saXN0ZWQAAAAAAgAAAAAAAAAFc3RhcnQAAAAAAAAEAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAD6gAAB9AAAAAIUmVzb3VyY2U=",
        "AAAAAAAAAH9UaGUgYWN0aXZlIHNjaGVkdWxlZCBwYXVzZSBkZWFkbGluZSwgaWYgb25lIGV4aXN0cy4KQnVtcHMgdGhlIGluc3RhbmNlIHN0b3JhZ2UgVFRMIHRvIGtlZXAgdGhlIGVudHJ5IGFsaXZlIGZvciBhY3RpdmUgbW9uaXRvcnMuAAAAAAtwYXVzZV91bnRpbAAAAAAAAAAAAQAAA+gAAAAG",
        "AAAAAQAAAC1SZWdpc3RyeS1sZXZlbCBmZWUgYW5kIHJveWFsdHkgY29uZmlndXJhdGlvbi4AAAAAAAAAAAAACUZlZUNvbmZpZwAAAAAAAAMAAAAAAAAADWZlZV9yZWNpcGllbnQAAAAAAAPoAAAAEwAAAAAAAAAQcGxhdGZvcm1fZmVlX2JwcwAAAAQAAAAAAAAAC3JveWFsdHlfYnBzAAAAAAQ=",
        "AAAAAQAAADBTdHJ1Y3R1cmVkIHBheWxvYWQgZW1pdHRlZCBieSBgZmxhZ19yZXNvdXJjZSgpYC4AAAAAAAAACUZsYWdFdmVudAAAAAAAAAMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAAAAAAZyZWFzb24AAAAAB9AAAAAKRmxhZ1JlYXNvbgAA",
        "AAAAAwAAAQNEdXJhdGlvbiB0aWVyIG9mIGEgdGltZS1saW1pdGVkIGFjY2VzcyBsZWFzZS4gRWFjaCB0aWVyIG1hcHMgdG8gYSBmaXhlZApudW1iZXIgb2YgbGVkZ2VycyAoYGxlYXNlX3RpZXJfbGVkZ2Vyc2ApIGFuZCBhIHByaWNlIG11bHRpcGxpZXIgb3ZlciB0aGUKcmVzb3VyY2UncyBwZXItcmVxdWVzdCBwcmljZSAoYGxlYXNlX3ByaWNlYCkuCgpUaGUgZGlzY3JpbWluYW50cyBhcmUgc3RhYmxlIOKAlCBkbyBub3QgcmVudW1iZXIgZXhpc3RpbmcgdmFyaWFudHMuAAAAAAAAAAAJTGVhc2VUaWVyAAAAAAAAAwAAAAAAAAAESG91cgAAAAAAAAAAAAAAA0RheQAAAAABAAAAAAAAAARXZWVrAAAAAg==",
        "AAAAAAAAAGhBY2NlcHQgdGhlIHBlbmRpbmcgYWRtaW4gbm9taW5hdGlvbiBhbmQgYmVjb21lIHRoZSBjb250cmFjdCBhZG1pbi4KT25seSB0aGUgcGVuZGluZyBhZG1pbiBtYXkgY2FsbCB0aGlzLgAAAAxhY2NlcHRfYWRtaW4AAAABAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAALlHcmFudCB0aGUgdmVyaWZpZXIgcm9sZSB0byBgdmVyaWZpZXJgLCBhdXRob3JpemluZyBgc2V0X3ZlcmlmaWNhdGlvbl9zdGF0dXNgLgpPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLiBFcnJvcnMgYEFkbWluTm90U2V0YCBpZiBubyBhZG1pbiBoYXMKYmVlbiBzZXQgeWV0IChzZWUgYG5vbWluYXRlX25ld19hZG1pbmApLgAAAAAAAAxhZGRfdmVyaWZpZXIAAAABAAAAAAAAAAh2ZXJpZmllcgAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAM1EaXNwdXRlIGZsYWcsIHJlYXNvbiBoYXNoLCBhbmQgbGFzdCBhY3RpbmcgbW9kZXJhdG9yIGZvciBhIHJlc291cmNlIGluCm9uZSByZWFkLiBFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIHRoZSByZXNvdXJjZSBkb2VzIG5vdCBleGlzdDsgYQpyZXNvdXJjZSBubyBtb2RlcmF0b3IgaGFzIHRvdWNoZWQgcmV0dXJucyBgTm9GbGFnYCBhbmQgdHdvIGBOb25lYHMuAAAAAAAADGZsYWdfZGV0YWlscwAAAAEAAAAAAAAAAmlkAAAAAAAQAAAAAQAAA+kAAAfQAAAAC0ZsYWdEZXRhaWxzAAAAAAM=",
        "AAAAAAAAAN1Nb25vdG9uaWMgbGlzdGluZyByZXZpc2lvbiBmb3IgYSByZXNvdXJjZS4gU3RhcnRzIGF0IGAwYCBhbmQKaW5jcmVtZW50cyBieSBleGFjdGx5IG9uZSBvbiBldmVyeSBzdWNjZXNzZnVsIG1ldGFkYXRhIG9yIHByaWNlCm11dGF0aW9uOyByZWplY3RlZCBjYWxscyBsZWF2ZSBpdCB1bmNoYW5nZWQuIEVycm9ycyBgTm90Rm91bmRgIHdoZW4KdGhlIHJlc291cmNlIGRvZXMgbm90IGV4aXN0LgAAAAAAAAxnZXRfcmV2aXNpb24AAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAADVXaGV0aGVyIGBhZGRyZXNzYCBjdXJyZW50bHkgaG9sZHMgdGhlIG1vZGVyYXRvciByb2xlLgAAAAAAAAxpc19tb2RlcmF0b3IAAAABAAAAAAAAAAdhZGRyZXNzAAAAABMAAAABAAAAAQ==",
        "AAAAAAAAADJOdW1iZXIgb2YgcmVzb3VyY2VzIGN1cnJlbnRseSBpbiB0aGUgTGlzdGVkIHN0YXRlLgAAAAAADGxpc3RlZF9jb3VudAAAAAAAAAABAAAABA==",
        "AAAAAAAAAEBQbGFjZSBhbiBhY3RpdmUgcmVzb3VyY2UgdW5kZXIgYW4gYWRtaW4tY29udHJvbGxlZCBkaXNwdXRlIGhvbGQuAAAADG9wZW5fZGlzcHV0ZQAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAQVTZXR0bGVyLXJlY29yZGVkIGxlYXNlOiB0aGUgc2FtZSBjaGVja3MgYXMgYGJ1eV9sZWFzZWAsIHdyaXR0ZW4KZGlyZWN0bHkgaW4gYEFjdGl2ZWAgc3RhdGUgYmVjYXVzZSB0aGUgc2V0dGxlciBoYXMgYWxyZWFkeSBjb25maXJtZWQKdGhlIHBheW1lbnQuIFJlcXVpcmVzIHRoZSBzZXR0bGVyIHJvbGUgKGBOb3RTZXR0bGVyYCkgYW5kIHRoZSBob2xkZXIncwphdXRob3JpemF0aW9uLCBtaXJyb3JpbmcgYHJlY29yZF9wYXltZW50YC4gRW1pdHMgYGxlYXNlYC4AAAAAAAAMcmVjb3JkX2xlYXNlAAAABgAAAAAAAAAHc2V0dGxlcgAAAAATAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAAC3Jlc291cmNlX2lkAAAAABAAAAAAAAAABHRpZXIAAAfQAAAACUxlYXNlVGllcgAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAd0eF9oYXNoAAAAABAAAAABAAAD6QAAB9AAAAAFTGVhc2UAAAAAAAAD",
        "AAAAAAAAAgZSZWJ1aWxkIHRoZSBwYWdpbmF0aW9uIGluZGV4IChgbGlzdGAvYGxpc3RfcGFnZWAvYGNvdW50YCkgZnJvbSBhbgphdXRob3JpdGF0aXZlLCBhZG1pbi1zdXBwbGllZCBvcmRlcmVkIGxpc3Qgb2YgcmVzb3VyY2UgaWRzLiBPbmx5IHRoZQphZG1pbiBtYXkgY2FsbCB0aGlzLiBFdmVyeSBpZCBtdXN0IGFscmVhZHkgZXhpc3QgYXMgYSByZWdpc3RlcmVkCmBSZXNvdXJjZWAgKGVsc2UgYE5vdEZvdW5kYCkgYW5kIHRoZSBsaXN0IG11c3Qgbm90IGNvbnRhaW4gZHVwbGljYXRlcwooZWxzZSBgRHVwbGljYXRlSW5SZXBhaXJgKS4gTmV2ZXIgdG91Y2hlcyBgUmVzb3VyY2VgIHN0b3JhZ2UgaXRzZWxmIOKAlApvbmx5IHJld3JpdGVzIHRoZSBkZXJpdmVkIGBJbmRleGAvYENvdW50YCBwb2ludGVycywgc28gaXQncyBzYWZlIHRvCnJlLXJ1biB3aXRoIHRoZSBjdXJyZW50IGNvcnJlY3QgaWQgbGlzdCBhcyBhIG5vLW9wLiBTZWUKYGRvY3MvaW5kZXgtcmVwYWlyLm1kYCBmb3IgdGhlIGZ1bGwgcmVwYWlyIHN0cmF0ZWd5LgAAAAAADHJlcGFpcl9pbmRleAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAVhSZXZva2UgYSBgUGVuZGluZ2Agb3IgYEFjdGl2ZWAgbGVhc2UuIE9ubHkgdGhlIHJlc291cmNlIGNyZWF0b3IgbWF5CmNhbGwgdGhpcy4gUmV2b2NhdGlvbiBpcyBpbW1lZGlhdGUgYW5kIHRlcm1pbmFsOiBgbGVhc2VfaXNfYWN0aXZlYApyZXR1cm5zIGBmYWxzZWAgZnJvbSB0aGlzIGxlZGdlciBvbiwgYW5kIHRoZSBob2xkZXIgbWF5IGJ1eSBhIG5ldwpsZWFzZSBhZnRlcndhcmRzLiBFcnJvcnMgYE5vdEZvdW5kYCBpZiBubyBsZWFzZSBleGlzdHMgZm9yIHRoZSBwYWlyCmFuZCBgSW52YWxpZExlYXNlVHJhbnNpdGlvbmAgaWYgaXQgaXMgYWxyZWFkeSBgUmV2b2tlZGAuIEVtaXRzCmBsZWFzZXJldmtgLgAAAAxyZXZva2VfbGVhc2UAAAACAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAZob2xkZXIAAAAAABMAAAABAAAD6QAAB9AAAAAFTGVhc2UAAAAAAAAD",
        "AAAAAAAAANlBZHZhbmNlIGEgYFBlbmRpbmdgIGxlYXNlIHRvIGBBY3RpdmVgIG9uY2UgaXRzIHBheW1lbnQgaXMgY29uZmlybWVkLgpSZXF1aXJlcyB0aGUgc2V0dGxlciByb2xlLiBFcnJvcnMgYE5vdEZvdW5kYCBpZiBubyBsZWFzZSBleGlzdHMgZm9yCnRoZSBwYWlyIGFuZCBgSW52YWxpZExlYXNlVHJhbnNpdGlvbmAgaWYgaXQgaXMgbm90IGBQZW5kaW5nYC4gRW1pdHMKYGxlYXNlc2V0bGAuAAAAAAAADHNldHRsZV9sZWFzZQAAAAMAAAAAAAAAB3NldHRsZXIAAAAAEwAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAQAAA+kAAAfQAAAABUxlYXNlAAAAAAAAAw==",
        "AAAAAAAAA+lQYWdpbmF0ZWQsIGRldGVybWluaXN0aWMgZGlnZXN0IG9mIHJlZ2lzdHJ5IGVudHJpZXMgZm9yIG9mZi1jaGFpbgppbmRleGVyIHJlY29uY2lsaWF0aW9uLiBXYWxrcyB0aGUgY2F0YWxvZyBpbnNlcnRpb24gaW5kZXggZXhhY3RseSBsaWtlCmBsaXN0X3BhZ2VgLCBjb3ZlcmluZyBgbWluKGxpbWl0LCBNQVhfRElHRVNUX1BBR0UpYCBlbnRyaWVzIHN0YXJ0aW5nIGF0CmBzdGFydGAsIGFuZCByZXR1cm5zIGEgdmVyc2lvbmVkIFtgU3RhdGVEaWdlc3RQYWdlYF0uCgpgcGFnZV9oYXNoYCBpcyBgc2hhMjU2YCBvdmVyIHRoaXMgcHJlaW1hZ2UgKGVuY29kaW5nIHZlcnNpb24gMSk6CgpgYGB0ZXh0ClNUQVRFX0RJR0VTVF9ET01BSU4KfHwgdTMyX2JlKHRvdGFsKSB8fCB1MzJfYmUoc3RhcnQpCnx8IGZvciBlYWNoIGVudHJ5IGluIHRoZSB3aW5kb3csIGluIGluZGV4IG9yZGVyOgp1MzJfYmUobGVuKGlkKSkgICAgICAgfHwgaWQKfHwgaTEyOF9iZShwcmljZSkKfHwgdTMyX2JlKGxlbihtZXRhZGF0YSkpIHx8IG1ldGFkYXRhCnx8IHUzMl9iZShzdGF0ZSBhcyB1MzIpIHx8IHU4KGZyb3plbiBhcyB1OCkKfHwgdTMyX2JlKHZlcnNpb24pICAgIHx8IHUzMl9iZSh1cGRhdGVkX2F0KQp8fCB1OChoYXNfY29udGVudF9oYXNoKQp8fCAoaWYgaGFzX2NvbnRlbnRfaGFzaDogdTMyX2JlKGxlbihoYXNoKSkgfHwgaGFzaCkKYGBgCgpUaGUgZW5jb2RpbmcgaXMgZGV0ZXJtaW5pc3RpYyBmb3IgdGhlIHNhbWUgcmVnaXN0cnkgc3RhdGUgYW5kIGJvdW5kZWQKcGVyIGNhbGwuIEEgY2xpZW50IHZlcmlmaWVzIGEgcGFnZSBieSByZWNvbnN0cnVjdGluZyB0aGlzIHByZWltYWdlIGZyb20KYGdldGAvYGxpc3RfcGFnZWAgb3V0cHV0IGFuZCBjb21wYXJpbmcgYHNoYTI1NihwcmVpbWFnZSlgIHRvCmBwYWdlX2hhc2hgOyBzZWUgYHN0YXRlX2RpZ2VzdF9jbGllbnRfdmVyaWZpY2F0aW9uX3JvdW5kdHJpcGAgaW4gdGhlCmNvbnRyYWN0IHRlc3RzIGZvciBhIHdvcmtlZCBleGFtcGxlLgAAAAAAAAxzdGF0ZV9kaWdlc3QAAAACAAAAAAAAAAVzdGFydAAAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAfQAAAAD1N0YXRlRGlnZXN0UGFnZQA=",
        "AAAAAQAAACJPbmUgYm91bmRlZCBwYWdlIG9mIGBleHBvcnRfcGFnZWAuAAAAAAAAAAAACkV4cG9ydFBhZ2UAAAAAAAUAAAAuW2BFWFBPUlRfVklFV19WRVJTSU9OYF0gb2YgdGhlIGBpdGVtc2AgbGF5b3V0LgAAAAAADmV4cG9ydF92ZXJzaW9uAAAAAAAEAAAAAAAAAAVpdGVtcwAAAAAAA+oAAAfQAAAADlJlc291cmNlRXhwb3J0AAAAAABHQ2F0YWxvZyBpbmRleCB0byBwYXNzIGJhY2sgYXMgYGN1cnNvcmA7IGBOb25lYCBvbmNlIHRoZSBlbmQgaXMgcmVhY2hlZC4AAAAAC25leHRfY3Vyc29yAAAAA+gAAAAEAAAAQWBSRVNPVVJDRV9TQ0hFTUFfVkVSU0lPTmAgb2YgdGhlIGNvbnRyYWN0IHRoYXQgcHJvZHVjZWQgdGhlIHBhZ2UuAAAAAAAAF3Jlc291cmNlX3NjaGVtYV92ZXJzaW9uAAAAAAQAAAA7VG90YWwgY2F0YWxvZyBpbmRleCBzbG90cyAoYGNvdW50YCkgd2hlbiB0aGUgcGFnZSB3YXMgcmVhZC4AAAAABXRvdGFsAAAAAAAABA==",
        "AAAAAwAAAIhSZWFzb24gY29kZSBzdXBwbGllZCB3aGVuIGEgbW9kZXJhdG9yIGZsYWdzIGEgcmVzb3VyY2UgZm9yIGRpc3B1dGUuCgpUaGUgZGlzY3JpbWluYW50cyBhcmUgc3RhYmxlIOKAlCBkbyBub3QgcmVudW1iZXIgZXhpc3RpbmcgdmFyaWFudHMuAAAAAAAAAApGbGFnUmVhc29uAAAAAAAEAAAAAAAAAARTcGFtAAAAAAAAAAAAAAAJQ29weXJpZ2h0AAAAAAAAAQAAAAAAAAAJTWFsaWNpb3VzAAAAAAAAAgAAAAAAAAAFT3RoZXIAAAAAAAAD",
        "AAAAAgAAALBMaWZlY3ljbGUgc3RhdGUgb2YgYW4gYWNjZXNzIGxlYXNlLgoKYFBlbmRpbmdgIGlzIGEgaG9sZGVyLXJlY29yZGVkIGxlYXNlIGF3YWl0aW5nIHNldHRsZW1lbnQgY29uZmlybWF0aW9uOwpgQWN0aXZlYCBncmFudHMgYWNjZXNzIHVudGlsIGBleHBpcnlfbGVkZ2VyYDsgYFJldm9rZWRgIGlzIHRlcm1pbmFsLgAAAAAAAAAKTGVhc2VTdGF0ZQAAAAAAAwAAAAAAAAAAAAAAB1BlbmRpbmcAAAAAAAAAAAAAAAAGQWN0aXZlAAAAAAAAAAAAAAAAAAdSZXZva2VkAA==",
        "AAAAAQAAAPJQYXlsb2FkIG9mIGV2ZXJ5IHJvbGUgZ3JhbnQvcmV2b2tlIGV2ZW50IChgYWRkdmVyaWZgL2BybXZlcmlmYCwKYGFkZHNldHRscmAvYHJtc2V0dGxyYCwgYGFkZG1vZGAvYHJtbW9kYCkuIENhcnJpZXMgdGhlIGFkbWluIHRoYXQKYXV0aG9yaXplZCB0aGUgY2hhbmdlIGFuZCB0aGUgYWZmZWN0ZWQgYWRkcmVzcyBzbyB0aGUgZXZlbnQgbG9nIGFsb25lCmlzIGEgY29tcGxldGUgYXVkaXQgdHJhaWwgb2Ygcm9sZSBjaGFuZ2VzLgAAAAAAAAAAAApSb2xlQ2hhbmdlAAAAAAADAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAtYHRydWVgIGZvciBhIGdyYW50LCBgZmFsc2VgIGZvciBhIHJldm9jYXRpb24uAAAAAAAAB2dyYW50ZWQAAAAAAQAAAAAAAAAGdGFyZ2V0AAAAAAAT",
        "AAAAAAAAAMdHcmFudCB0aGUgbW9kZXJhdG9yIHJvbGUgdG8gYG1vZGVyYXRvcmAsIGF1dGhvcml6aW5nIGBmbGFnX3Jlc291cmNlYCBhbmQKYHVuZmxhZ19yZXNvdXJjZWAuIE9ubHkgdGhlIGFkbWluIG1heSBjYWxsIHRoaXMuIEVycm9ycyBgQWRtaW5Ob3RTZXRgIGlmCm5vIGFkbWluIGhhcyBiZWVuIHNldCB5ZXQgKHNlZSBgbm9taW5hdGVfbmV3X2FkbWluYCkuAAAAAA1hZGRfbW9kZXJhdG9yAAAAAAAAAQAAAAAAAAAJbW9kZXJhdG9yAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAqNGbGFnIGEgcmVzb3VyY2UgZm9yIGRpc3B1dGUuIE9ubHkgYW4gYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZyB0aGUKbW9kZXJhdG9yIHJvbGUgKHNlZSBgYWRkX21vZGVyYXRvcmApIG1heSBjYWxsIHRoaXMuCgpTZXRzIGBSZXNvdXJjZS5kaXNwdXRlX2ZsYWdgIHRvIGBTb21lKHJlYXNvbilgLiBGbGFnZ2luZyBpcyBpbmZvcm1hdGlvbmFsOgppdCBkb2VzIG5vdCBkZWxpc3QsIGRlbGV0ZSwgb3IgcmVzdHJpY3QgdGhlIHJlc291cmNlIOKAlCBjYWxsZXJzIG1heSBmaWx0ZXIKb24gdGhpcyBmaWVsZC4gQ2FsbGluZyBgZmxhZ19yZXNvdXJjZWAgb24gYW4gYWxyZWFkeS1mbGFnZ2VkIHJlc291cmNlCnJlcGxhY2VzIHRoZSBleGlzdGluZyBmbGFnIHdpdGggdGhlIG5ldyByZWFzb24uCgpFbWl0cyBhIGBmbGFnYCBldmVudCB3aXRoIGBGbGFnRXZlbnQgeyBpZCwgbW9kZXJhdG9yLCByZWFzb24gfWAuCgpFcnJvcnMgZGV0ZXJtaW5pc3RpY2FsbHk6Ci0gW2BFcnJvcjo6VW5hdXRob3JpemVkYF0g4oCUIGNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSBtb2RlcmF0b3Igcm9sZQotIFtgRXJyb3I6Ok5vdEZvdW5kYF0g4oCUIGBpZGAgaXMgbm90IGEgcmVnaXN0ZXJlZCByZXNvdXJjZQotIFtgRXJyb3I6OkludmFsaWRSZXNvdXJjZUlkYF0g4oCUIGBpZGAgZmFpbHMgZm9ybWF0IHZhbGlkYXRpb24AAAAADWZsYWdfcmVzb3VyY2UAAAAAAAADAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAJbW9kZXJhdG9yAAAAAAAAEwAAAAAAAAAGcmVhc29uAAAAAAfQAAAACkZsYWdSZWFzb24AAAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAMJSZWFkIHRoZSBtZW1vIGhhc2ggcmVjb3JkZWQgZm9yIGEgcmVzb3VyY2UgYXQgcmVnaXN0cmF0aW9uLCBpZiBpdCB3YXMKcmVnaXN0ZXJlZCB0aHJvdWdoIGByZWdpc3Rlcl93aXRoX21lbW9gIHdpdGggb25lLiBgTm9uZWAgZm9yIGV2ZXJ5Cm90aGVyIHJlc291cmNlIGFuZCBmb3IgaWRzIHRoYXQgYXJlIHVua25vd24gb3IgbWFsZm9ybWVkLgAAAAAADWdldF9tZW1vX2hhc2gAAAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPoAAAD7gAAACA=",
        "AAAAAAAAAZZQYWdpbmF0ZWQgbGlzdCBvZiByZXNvdXJjZXMgd2hvc2UgbGlmZWN5Y2xlIHN0YXRlIGV4YWN0bHkgbWF0Y2hlcwpgc3RhdGVgLiBVbmxpa2UgdGhlIGJvb2xlYW4gYGxpc3RlZGAgcHJvamVjdGlvbiwgdGhpcyBkaXN0aW5ndWlzaGVzCmFsbCBmaXZlIHN0YXRlczogYExpc3RlZGAsIGBEZWxpc3RlZGAsIGBGcm96ZW5gLCBgRGlzcHV0ZWRgLCBhbmQKYFRvbWJzdG9uZWRgLgoKLSBgY3Vyc29yYCBpcyBhIDAtYmFzZWQgZ2xvYmFsIGNhdGFsb2cgaW5kZXggKHNhbWUgZG9tYWluIGFzCmBsaXN0X3BhZ2VgJ3MgYGN1cnNvcmApLgotIGBsaW1pdGAgaXMgY2FwcGVkIGF0IFtgTElTVF9QQUdFX0NBUGBdICgyMCkuCi0gUmV0dXJucyBhIFtgQ2F0YWxvZ1BhZ2VgXSB3aXRoIGBpdGVtc2AgYW5kIGBuZXh0X2N1cnNvcmAuAAAAAAANbGlzdF9ieV9zdGF0ZQAAAAAAAAMAAAAAAAAABXN0YXRlAAAAAAAH0AAAAA1SZXNvdXJjZVN0YXRlAAAAAAAAAAAAAAZjdXJzb3IAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAfQAAAAC0NhdGFsb2dQYWdlAA==",
        "AAAAAAAAACFQZW5kaW5nIG5vbWluYXRlZCBjb250cmFjdCBhZG1pbi4AAAAAAAANcGVuZGluZ19hZG1pbgAAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAAP1SZXBsYWNlIGEgbG9zdCBhZG1pbiBrZXkuIE9ubHkgdGhlIHJlY292ZXJ5IGFkbWluIG1heSBjYWxsIHRoaXMuClNldHMgYG5ld19hZG1pbmAgYXMgYWRtaW4gaW1tZWRpYXRlbHkgYW5kIGNsZWFycyBhbnkgcGVuZGluZyBhZG1pbgpub21pbmF0aW9uLiBUaGUgcmVjb3ZlcnkgYWRtaW4gaXRzZWxmIGlzIHVuY2hhbmdlZC4gRXJyb3JzCmBBZG1pbk5vdFNldGAsIGBBZG1pbk5vdFNldGAsIG9yIGBTYW1lQWRtaW5gLiBFbWl0cyBgcmVjb3ZlcmAuAAAAAAAADXJlY292ZXJfYWRtaW4AAAAAAAABAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAD5DdXJyZW50IGNyZWF0b3IgcmVmdW5kIHdpbmRvdyBpbiBsZWRnZXJzLiBEZWZhdWx0cyB0byBvbmUgZGF5LgAAAAAADXJlZnVuZF93aW5kb3cAAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAPVEaXNjb3ZlciB0aGlzIHJlZ2lzdHJ5J3Mgc3RhYmxlIGlkZW50aXR5IGFuZCBjYXBhYmlsaXRpZXMgaW4gb25lCnJlYWQtb25seSBjYWxsOiBuYW1lLCBjcmF0ZSB2ZXJzaW9uLCBgUmVzb3VyY2VgIHNjaGVtYSB2ZXJzaW9uLCBhbmQKdGhlIG5ldHdvcmsgdGhpcyBjb250cmFjdCBpcyBkZXBsb3llZCBvbi4gQWx3YXlzIHN1Y2NlZWRzIOKAlCB0aGVyZSBpcwpubyBmYWlsdXJlIG1vZGUgYSBjYWxsZXIgbmVlZHMgdG8gaGFuZGxlLgAAAAAAAA1yZWdpc3RyeV9pbmZvAAAAAAAAAAAAAAEAAAfQAAAADFJlZ2lzdHJ5SW5mbw==",
        "AAAAAQAAAO1PbmUgcGFnZSBvZiB0aGUgb24tY2hhaW4gY2F0YWxvZyBwbHVzIGEgY3Vyc29yIGZvciB0aGUgbmV4dCBwYWdlLgoKYG5leHRfY3Vyc29yYCBpcyB0aGUgY2F0YWxvZyBpbmRleCB0byBwYXNzIGJhY2sgaW50byBgbGlzdGAgLyBgbGlzdF9wYWdlYAphcyBgc3RhcnRgL2BjdXJzb3JgLiBgTm9uZWAgbWVhbnMgZW5kLW9mLWxpc3Qg4oCUIGNsaWVudHMgbXVzdCBub3QgcmVjb21wdXRlCm9mZnNldHMgdGhlbXNlbHZlcy4AAAAAAAAAAAAAC0NhdGFsb2dQYWdlAAAAAAIAAAAAAAAABWl0ZW1zAAAAAAAD6gAAB9AAAAAIUmVzb3VyY2UAAAAAAAAAC25leHRfY3Vyc29yAAAAA+gAAAAE",
        "AAAAAgAAAd9XcmFwcGVyIGZvciBhbiBvcHRpb25hbCBbYEZsYWdSZWFzb25gXSB2YWx1ZSwgdXNlZCBhcyB0aGUgYGRpc3B1dGVfZmxhZ2AKZmllbGQgb2YgW2BSZXNvdXJjZWBdLiBTb3JvYmFuJ3MgYGNvbnRyYWN0dHlwZWAgbWFjcm8gcmVxdWlyZXMgdGhhdCBhbGwKZmllbGQgdHlwZXMgYXJlIGBTY1ZhbGAtZW5jb2RhYmxlOyBgT3B0aW9uPEZsYWdSZWFzb24+YCBpcyBub3QgZGlyZWN0bHkKc3VwcG9ydGVkIHdoZW4gYEZsYWdSZWFzb25gIGlzIGEgY3VzdG9tIGBjb250cmFjdHR5cGVgIGVudW0sIHNvIHdlIHVzZSBhCnR3by12YXJpYW50IGVudW0gaW5zdGVhZCBvZiBuYXRpdmUgYE9wdGlvbmAuCgpgTm9GbGFnYCBlbmNvZGVzIHRoZSBhYnNlbmNlIG9mIGEgZGlzcHV0ZSBmbGFnIChhbmFsb2dvdXMgdG8gYE5vbmVgKS4KYEZsYWdnZWQoRmxhZ1JlYXNvbilgIGVuY29kZXMgYW4gYWN0aXZlIGZsYWcgd2l0aCBhIHNwZWNpZmljIHJlYXNvbiBjb2RlLgAAAAAAAAAAC0Rpc3B1dGVGbGFnAAAAAAIAAAAAAAAAAAAAAAZOb0ZsYWcAAAAAAAEAAAAAAAAAB0ZsYWdnZWQAAAAAAQAAB9AAAAAKRmxhZ1JlYXNvbgAA",
        "AAAAAQAAAEZBIHJlc291cmNlJ3MgbW9kZXJhdGlvbiBzdGF0ZSBpbiBvbmUgcmVhZCwgcmV0dXJuZWQgYnkgYGZsYWdfZGV0YWlsc2AuAAAAAAAAAAAAC0ZsYWdEZXRhaWxzAAAAAAMAAAAuQWN0aXZlIGRpc3B1dGUgZmxhZywgb3IgYERpc3B1dGVGbGFnOjpOb0ZsYWdgLgAAAAAADGRpc3B1dGVfZmxhZwAAB9AAAAALRGlzcHV0ZUZsYWcAAAAARU1vZGVyYXRvciB3aG9zZSBmbGFnLCB1bmZsYWcsIG9yIHJlYXNvbiBoYXNoIHdyaXRlIGNhbWUgbGFzdCwgaWYgYW55LgAAAAAAAA5sYXN0X21vZGVyYXRvcgAAAAAD6AAAABMAAAAsSGFzaCBzZXQgdmlhIGBzZXRfZmxhZ19yZWFzb25faGFzaGAsIGlmIGFueS4AAAALcmVhc29uX2hhc2gAAAAD6AAAABA=",
        "AAAAAAAAAG5SZWFkIHRoZSByZWdpc3RyeS1sZXZlbCBmZWUgLyByb3lhbHR5IGNvbmZpZ3VyYXRpb24uIFJldHVybnMgYE5vbmVgCmlmIGBzZXRfZmVlX2NvbmZpZ2AgaGFzIG5ldmVyIGJlZW4gY2FsbGVkLgAAAAAADmdldF9mZWVfY29uZmlnAAAAAAAAAAAAAQAAA+gAAAfQAAAACUZlZUNvbmZpZwAAAA==",
        "AAAAAAAAANhCYXRjaCBvd25lciBsb29rdXAuIFJldHVybnMgYSBgVmVjPE9wdGlvbjxBZGRyZXNzPj5gIHBhcmFsbGVsIHRvIGBpZHNgLgpNaXNzaW5nIHJlc291cmNlcyBhcmUgYE5vbmVgOyBpbnZhbGlkIHJlc291cmNlIGlkcyBmYWlsIHRoZSB3aG9sZSBjYWxsLAptYXRjaGluZyBgZ2V0X21hbnlgIGFuZCBrZWVwaW5nIG1hbGZvcm1lZCBtdWx0aS1zZWxlY3QgcmVxdWVzdHMgdmlzaWJsZS4AAAAOZ2V0X293bmVyX21hbnkAAAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAAEAAAAAEAAAPpAAAD6gAAA+gAAAATAAAAAw==",
        "AAAAAAAAAIJGZXRjaCBhIGNyZWF0b3IncyBtYXJrZXRwbGFjZSB0ZXJtcyBoYXNoLiBFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIGl0IGRvZXMgbm90IGV4aXN0LgpCdW1wcyB0aGUgZW50cnkncyBUVEwgb24gYSBzdWNjZXNzZnVsIHJlYWQuAAAAAAAOZ2V0X3Rlcm1zX2hhc2gAAAAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAAEAAAAAM=",
        "AAAAAAAABABSZWNvcmQgYW4geDQwMi9Tb3JvYmFuIHBheW1lbnQgcmVjZWlwdCBpbiBgRXNjcm93ZWRgIHN0YXRlLiBPbmx5IGFuCmFkZHJlc3MgY3VycmVudGx5IGhvbGRpbmcgdGhlIHNldHRsZXIgcm9sZSBtYXkgY2FsbCB0aGlzLgoKLSBgcmVjZWlwdF9pZGAgbXVzdCBiZSB1bmlxdWUgKG1heCA2NCBieXRlcywgbm9uLWVtcHR5KTsgZHVwbGljYXRlIGlkcwplcnJvciBgUmVjZWlwdEFscmVhZHlFeGlzdHNgLiBVc2UgYHJlY29yZF9wYXltZW50X2lkZW1wb3RlbnRgIGZvciBhCnJldHJ5LXNhZmUgdmFyaWFudCB0aGF0IHJldHVybnMgdGhlIHN0b3JlZCByZWNlaXB0IGluc3RlYWQuCi0gYHJlc291cmNlX2lkYCBtdXN0IHJlZmVyIHRvIGFuIGV4aXN0aW5nIHJlZ2lzdGVyZWQgcmVzb3VyY2UKKGBOb3RGb3VuZGAgb3RoZXJ3aXNlKS4KLSBgYW1vdW50YCBtdXN0IGJlIGA+IDBgIChgSW52YWxpZFBheW1lbnRBbW91bnRgIG90aGVyd2lzZSkuCi0gYGFtb3VudGAgbXVzdCBtYXRjaCB0aGUgcmVzb3VyY2UncyBjdXJyZW50IHByaWNlCihgUGF5bWVudEFtb3VudE1pc21hdGNoYCBvdGhlcndpc2UpLgotIGB0eF9oYXNoYCBtdXN0IGJlIG5vbi1lbXB0eSBhbmQgYXQgbW9zdCAxMjggYnl0ZXMgKGBJbnZhbGlkVHhIYXNoYCkuCi0gYHR4X2hhc2hgIG11c3Qgbm90IGFscmVhZHkgYmFjayBhbm90aGVyIHJlY2VpcHQgKGBEdXBsaWNhdGVUeEhhc2hgKS4KCkVtaXRzIGEgYHBheW1lbnRgIGV2ZW50IHdob3NlIGRhdGEgaXMgdGhlIGZ1bGwgW2BQYXltZW50UmVjZWlwdGBdIHNvCm9mZi1jaGFpbiBpbmRleGVycyBjYW4gaW5kZXggdGhlIHJlY2VpcHQgd2l0aG91dCByZWFkaW5nIGNvbnRyYWN0CnN0b3JhZ2UuCgpQcm92ZW5hbmNlOiB0aGlzIGVudHJ5IHBvaW50IGNhbm5vdCBwcm92ZSB3aGljaCByZXNvdXJjZSB0aGUgc2V0dGxlbWVudAp0cmFuc2FjdGlvbiBwYWlkIGZvciwgc28gaXQgYWxzbyBlbWl0cyBhIGBub21lbW9gIHdhcm5pbmcgZXZlbnQuIFByZWZlcgpgcmVjb3JkX3BheW1lbnRfd2l0aF9tZW1vYCwgd2hpAAAADnJlY29yZF9wYXltZW50AAAAAAAGAAAAAAAAAAdzZXR0bGVyAAAAABMAAAAAAAAACnJlY2VpcHRfaWQAAAAAABAAAAAAAAAAC3Jlc291cmNlX2lkAAAAABAAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAd0eF9oYXNoAAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAACZUaGUgY29uZmlndXJlZCByZWNvdmVyeSBhZG1pbiwgaWYgYW55LgAAAAAADnJlY292ZXJ5X2FkbWluAAAAAAAAAAAAAQAAA+gAAAAT",
        "AAAAAAAAA3VSZWdpc3RlciBtdWx0aXBsZSByZXNvdXJjZXMgaW4gYSBzaW5nbGUgdHJhbnNhY3Rpb24uIFRoZSBiYXRjaCBpcyBjYXBwZWQKYXQgW2BNQVhfQkFUQ0hfUkVHSVNURVJgXSAoMTApIHRvIGJvdW5kIGV4ZWN1dGlvbiBjb3N0LiBBbGwgcmVzb3VyY2VzCmFyZSByZWdpc3RlcmVkIHVuZGVyIHRoZSBzYW1lIGBjcmVhdG9yYC4KClJldHVybnMgYSBbYEJhdGNoUmVnaXN0ZXJSZXN1bHRgXSBjb250YWluaW5nOgotIGBzdWNjZWVkZWRgOiBJRHMgb2Ygc3VjY2Vzc2Z1bGx5IHJlZ2lzdGVyZWQgcmVzb3VyY2VzCi0gYGZhaWxlZGA6IEluZGljZXMgYW5kIGVycm9yIGNvZGVzIG9mIGZhaWxlZCByZWdpc3RyYXRpb25zCgpUaGlzIGZ1bmN0aW9uIGNvbnRpbnVlcyBwcm9jZXNzaW5nIGFmdGVyIGluZGl2aWR1YWwgZmFpbHVyZXMsIGFsbG93aW5nCnBhcnRpYWwgc3VjY2Vzcy4gVGhlIGNyZWF0b3IgaXMgYXV0aG9yaXplZCBvbmNlIGF0IHRoZSBzdGFydCwgYW5kIGVhY2gKcmVzb3VyY2UgaXMgdmFsaWRhdGVkIGluZGVwZW5kZW50bHkuIENvbW1vbiBmYWlsdXJlIGNhdXNlcyBpbmNsdWRlCmR1cGxpY2F0ZSBJRHMsIGludmFsaWQgcHJpY2VzLCBvciBpbnZhbGlkIG1ldGFkYXRhIHBvaW50ZXJzLgoKQSBiYXRjaCB0aGF0IHJlcGVhdHMgYW55IGlkIGlzIHJlamVjdGVkIHVwIGZyb250IHdpdGgKYEFscmVhZHlSZWdpc3RlcmVkYCBhbmQgbGVhdmVzIHJlc291cmNlIHJlY29yZHMsIGNvdW50ZXJzLCBpbmRleGVzLCBhbmQKZXZlbnRzIHVuY2hhbmdlZCDigJQgc2VlIHRoZSB3aXRoaW4tYmF0Y2ggZHVwbGljYXRlIGd1YXJkIGJlbG93LgoKVXNlIGNhc2U6IEJ1bGsgb25ib2FyZGluZyBvZiByZXNvdXJjZXMgYnkgcHVibGlzaGVycyBvciBhdXRvbWF0ZWQgc3lzdGVtcy4AAAAAAAAOcmVnaXN0ZXJfYmF0Y2gAAAAAAAIAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAFaXRlbXMAAAAAAAPqAAAH0AAAABFCYXRjaFJlZ2lzdGVySXRlbQAAAAAAAAEAAAPpAAAH0AAAABNCYXRjaFJlZ2lzdGVyUmVzdWx0AAAAAAM=",
        "AAAAAAAAAEVSZXZva2UgdGhlIHNldHRsZXIgcm9sZSBmcm9tIGBzZXR0bGVyYC4gT25seSB0aGUgYWRtaW4gbWF5IGNhbGwgdGhpcy4AAAAAAAAOcmVtb3ZlX3NldHRsZXIAAAAAAAEAAAAAAAAAB3NldHRsZXIAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAcFBZHZhbmNlIGEgcGF5bWVudCByZWNlaXB0IGZyb20gYEVzY3Jvd2VkYCB0byBgU2V0dGxlZGAuIE9ubHkgYW4KYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZyB0aGUgc2V0dGxlciByb2xlIG1heSBjYWxsIHRoaXMuCgpFcnJvcnM6Ci0gYE5vdEZvdW5kYCDigJQgbm8gcmVjZWlwdCBleGlzdHMgZm9yIGByZWNlaXB0X2lkYC4KLSBgSW52YWxpZFBheW1lbnRUcmFuc2l0aW9uYCDigJQgcmVjZWlwdCBpcyBub3QgaW4gYEVzY3Jvd2VkYCBzdGF0ZQooZS5nLiBhbHJlYWR5IGBTZXR0bGVkYCkuCgpFbWl0cyBhIGBzZXR0bGVgIGV2ZW50IHdob3NlIGRhdGEgaXMgdGhlIHVwZGF0ZWQgW2BQYXltZW50UmVjZWlwdGBdCih3aXRoIGBzdGF0ZTogU2V0dGxlZGApIHNvIG9mZi1jaGFpbiBpbmRleGVycyBjYW4gY29uZmlybSBzZXR0bGVtZW50CndpdGhvdXQgcmVhZGluZyBjb250cmFjdCBzdG9yYWdlLgAAAAAAAA5zZXR0bGVfcGF5bWVudAAAAAAAAgAAAAAAAAAHc2V0dGxlcgAAAAATAAAAAAAAAApyZWNlaXB0X2lkAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAA3RTZXQgdGhlIHJlZ2lzdHJ5LWxldmVsIGZlZSAvIHJveWFsdHkgY29uZmlndXJhdGlvbi4gT25seSB0aGUgYWRtaW4gbWF5CmNhbGwgdGhpcy4gRXJyb3JzIGBBZG1pbk5vdFNldGAgaWYgbm8gYWRtaW4gaGFzIGJlZW4gc2V0IHlldC4KCkJvdGggYHBsYXRmb3JtX2ZlZV9icHNgIGFuZCBgcm95YWx0eV9icHNgIG11c3QgYmUg4omkIFtgTUFYX0ZFRV9CUFNgXQooNSAwMDAgYnAgPSA1MCAlKSBpbmRpdmlkdWFsbHksICoqYW5kKiogdGhlaXIgc3VtIG11c3QgYWxzbyBiZSDiiaQKW2BNQVhfRkVFX0JQU2BdLiBWaW9sYXRpbmcgZWl0aGVyIGJvdW5kIGVycm9ycyBgRmVlQnBzVG9vSGlnaGAgKGZvciBhbgppbmRpdmlkdWFsIGZpZWxkIG91dCBvZiByYW5nZSkgb3IgYFRvdGFsRmVlVG9vSGlnaGAgKGZvciBhIHZhbGlkCmluZGl2aWR1YWwgcGFpciB3aG9zZSBzdW0gZXhjZWVkcyB0aGUgY2VpbGluZykuCgpUb2dldGhlciB3aXRoIHRoZSBwcmljZS12YWxpZGF0aW9uIHJ1bGUgKGBwcmljZSA+IHBsYXRmb3JtX2ZlZV9icHMgKwpyb3lhbHR5X2Jwc2ApLCB0aGlzIGd1YXJhbnRlZXMgdGhlIGNyZWF0b3IgYWx3YXlzIHJlY2VpdmVzIGEgcG9zaXRpdmUKcmVtYWluZGVyIG9mIGF0IGxlYXN0IFtgTUlOX0NSRUFUT1JfU0hBUkVfQlBTYF0gKDUwICUpIG9uIGV2ZXJ5IHNhbGUuCgpTdG9yZXMgdGhlIGNvbmZpZyB1bmRlciB0aGUgc2luZ2xldG9uIFtgRGF0YUtleTo6RmVlQ29uZmlnYF0gaW5zdGFuY2UKZW50cnkgYW5kIGVtaXRzIGEgYHNldGZlZWAgZXZlbnQgY2FycnlpbmcgdGhlIG9sZCBjb25maWcgKG9yIGBOb25lYCBvbgpmaXJzdCBzZXQpIGFuZCB0aGUgbmV3IGNvbmZpZywgc28gb2ZmLWNoYWluIGluZGV4ZXJzIGhhdmUgYSBmdWxsCmF1ZGl0IHRyYWlsLgAAAA5zZXRfZmVlX2NvbmZpZwAAAAAAAQAAAAAAAAAGY29uZmlnAAAAAAfQAAAACUZlZUNvbmZpZwAAAAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAYxVcGRhdGUgcHJpY2VzIGZvciBtdWx0aXBsZSByZXNvdXJjZXMgb3duZWQgYnkgYGNyZWF0b3JgIGluIG9uZSBjYWxsLgpUaGUgY3JlYXRvciBhdXRob3JpemVzIHRoZSBpbnZvY2F0aW9uIG9uY2UsIGFuZCBldmVyeSBpdGVtIGlzCnZhbGlkYXRlZCBiZWZvcmUgYW55IHByaWNlIGlzIHdyaXR0ZW4uIElmIG9uZSBpdGVtIGlzIGludmFsaWQsIG5vCnByaWNlcyBhcmUgY2hhbmdlZC4gRHVwbGljYXRlIElEcyB1c2UgdGhlIGxhc3Qgc3VwcGxpZWQgcHJpY2UuCgpUaGUgYmF0Y2ggaXMgY2FwcGVkIGF0IFtgTUFYX0JBVENIX1BSSUNFX1VQREFURVNgXSBpdGVtcy4gQSBuby1vcCBwcmljZQp1cGRhdGUgc3VjY2VlZHMgd2l0aG91dCB3cml0aW5nIHN0b3JhZ2Ugb3IgZW1pdHRpbmcgYHNldHByaWNlYC4AAAAOc2V0X3ByaWNlX21hbnkAAAAAAAIAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAHdXBkYXRlcwAAAAPqAAAH0AAAABBCYXRjaFByaWNlVXBkYXRlAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAACpTdG9yZSBhIGhhc2ggb2YgY3JlYXRvciBtYXJrZXRwbGFjZSB0ZXJtcy4AAAAAAA5zZXRfdGVybXNfaGFzaAAAAAAAAgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAp0ZXJtc19oYXNoAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAgAAAAAAAAAAAAAADE9wdEZlZUNvbmZpZwAAAAIAAAAAAAAAAAAAAAROb25lAAAAAQAAAAAAAAAEU29tZQAAAAEAAAfQAAAACUZlZUNvbmZpZwAAAA==",
        "AAAAAgAAAXBPbi1jaGFpbiByZWNvcmQgb2YgYSBzaW5nbGUgeDQwMi9Tb3JvYmFuIHBheW1lbnQgc2V0dGxlbWVudCBmb3IgYSByZXNvdXJjZS4KClRoZSBhbGxvd2VkIHRyYW5zaXRpb24gaXMgYEVzY3Jvd2VkIOKGkiBTZXR0bGVkYC4gQSByZWNlaXB0IHN0YXJ0cyBpbgpgRXNjcm93ZWRgIHdoZW4gZmlyc3QgcmVjb3JkZWQgYW5kIG1vdmVzIHRvIGBTZXR0bGVkYCBvbmNlCmBzZXR0bGVfcGF5bWVudGAgaXMgY2FsbGVkIGJ5IGEgc2V0dGxlci4gUmV2ZXJ0aW5nIHRvIGBFc2Nyb3dlZGAgb3IKY3JlYXRpbmcgYSByZWNlaXB0IGRpcmVjdGx5IGluIGBTZXR0bGVkYCBzdGF0ZSBhcmUgbm90IHBlcm1pdHRlZAooYEludmFsaWRQYXltZW50VHJhbnNpdGlvbmApLgAAAAAAAAAMUGF5bWVudFN0YXRlAAAAAgAAAAAAAAC5UGF5bWVudCBoYXMgYmVlbiBhdXRob3Jpc2VkIGJ5IHRoZSBwYXllciBhbmQgaXMgaGVsZCBwZW5kaW5nIGZpbmFsCm9uLWNoYWluIHNldHRsZW1lbnQuIFRoZSB4NDAyIGZhY2lsaXRhdG9yIHJlY29yZHMgcmVjZWlwdHMgaW4gdGhpcwpzdGF0ZTsgYHNldHRsZV9wYXltZW50YCBhZHZhbmNlcyB0aGVtIHRvIGBTZXR0bGVkYC4AAAAAAAAIRXNjcm93ZWQAAAAAAAAAdFBheW1lbnQgaGFzIGJlZW4gc2V0dGxlZCBvbi1jaGFpbi4gVGhlIFVTREMgdHJhbnNmZXIgaGFzIGJlZW4KY29uZmlybWVkIGFuZCB0aGUgY3JlYXRvcidzIGJhbGFuY2UgaGFzIGJlZW4gY3JlZGl0ZWQuAAAAB1NldHRsZWQA",
        "AAAAAQAAAPlTdHJ1Y3R1cmVkIHBheWxvYWQgcHVibGlzaGVkIHdpdGggdGhlIGBzZXRwcmljZWAgZXZlbnQuCkluY2x1ZGVzIHRoZSByZXNvdXJjZSBpZCwgdGhlIHByaWNlIGJlZm9yZSBhbmQgYWZ0ZXIgdGhlIHVwZGF0ZSwgYW5kIHRoZQphZGRyZXNzIHRoYXQgYXV0aG9yaXNlZCB0aGUgY2hhbmdlIOKAlCBlbmFibGluZyBpbmRleGVycyB0byByZWNvbmNpbGUgcHJpY2UKaGlzdG9yeSB3aXRob3V0IHJlLXJlYWRpbmcgY29udHJhY3Qgc3RvcmFnZS4AAAAAAAAAAAAADFByaWNlVXBkYXRlZAAAAAUAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAluZXdfcHJpY2UAAAAAAAALAAAAAAAAAAlvbGRfcHJpY2UAAAAAAAALAAAAOExpc3RpbmcgcmV2aXNpb24gYWZ0ZXIgdGhpcyB1cGRhdGUgKHNlZSBgZ2V0X3JldmlzaW9uYCkuAAAACHJldmlzaW9uAAAABAAAAAAAAAAHdXBkYXRlcgAAAAAT",
        "AAAAAQAAAMtSZWdpc3RyeSBkaXNjb3ZlcnkgbWV0YWRhdGEgcmV0dXJuZWQgYnkgW2BWYXVsdFJlZ2lzdHJ5OjpyZWdpc3RyeV9pbmZvYF0uCkxldHMgYSBjbGllbnQgZGlzY292ZXIgdGhlIGRlcGxveWVkIHJlZ2lzdHJ5J3MgaWRlbnRpdHkgYW5kIHNoYXBlIHdpdGggYQpzaW5nbGUgcmVhZC1vbmx5IGNhbGwgaW5zdGVhZCBvZiBoYXJkY29kaW5nIGFzc3VtcHRpb25zLgAAAAAAAAAADFJlZ2lzdHJ5SW5mbwAAAAQAAAA3U3RhYmxlLCBodW1hbi1yZWFkYWJsZSByZWdpc3RyeSBuYW1lIChgUkVHSVNUUllfTkFNRWApLgAAAAAEbmFtZQAAABAAAADHTmV0d29yayBwYXNzcGhyYXNlIGRpZ2VzdCBvZiB0aGUgbGVkZ2VyIHRoaXMgY29udHJhY3QgaXMgcnVubmluZyBvbgooYGVudi5sZWRnZXIoKS5uZXR3b3JrX2lkKClgKSwgc28gY2xpZW50cyBjYW4gY29uZmlybSB0aGV5IGFyZQp0YWxraW5nIHRvIHRoZSBuZXR3b3JrIHRoZXkgZXhwZWN0IHdpdGhvdXQgYSBoYXJkY29kZWQgY29uZmlnIHZhbHVlLgAAAAAKbmV0d29ya19pZAAAAAAD7gAAACAAAABGVmVyc2lvbiBvZiB0aGUgb24tY2hhaW4gYFJlc291cmNlYCBzY2hlbWEgKGBSRVNPVVJDRV9TQ0hFTUFfVkVSU0lPTmApLgAAAAAAF3Jlc291cmNlX3NjaGVtYV92ZXJzaW9uAAAAAAQAAAA7Q29udHJhY3QgY3JhdGUgdmVyc2lvbiAoYENBUkdPX1BLR19WRVJTSU9OYCBhdCBidWlsZCB0aW1lKS4AAAAAB3ZlcnNpb24AAAAAEA==",
        "AAAAAAAAAEFBY2NlcHQgYSBwcm9wb3NlZCB0cmFuc2Zlci4gT25seSB0aGUgcGVuZGluZyBvd25lciBjYW4gY2FsbCB0aGlzLgAAAAAAAA9hY2NlcHRfdHJhbnNmZXIAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAa1DYW5jZWwgYSBwcm9wb3NlZCB0cmFuc2Zlci4gT25seSB0aGUgY3VycmVudCBvd25lciBjYW4gY2FsbCB0aGlzLgoKU2VsZi1jYW5jZWwgcHJvdGVjdGlvbjogYGNhbmNlbF90cmFuc2ZlcmAgcmVxdWlyZXMgdGhlIGNhbGxlciB0byBiZSB0aGUKY3VycmVudCBgcmVzb3VyY2UuY3JlYXRvcmAuIEFmdGVyIGBhY2NlcHRfdHJhbnNmZXJgIGNvbXBsZXRlcyB0aGUKcGVuZGluZy10cmFuc2ZlciBlbnRyeSBpcyByZW1vdmVkIGFuZCBvd25lcnNoaXAgbW92ZXMgdG8gdGhlIG5ldwpjcmVhdG9yLCBzbyBhbnkgc3Vic2VxdWVudCBgY2FuY2VsX3RyYW5zZmVyYCBjYWxsIGJ5IGVpdGhlciBwYXJ0eQpyZXR1cm5zIGBOb1BlbmRpbmdUcmFuc2ZlcmAg4oCUIGFuIGFjY2VwdGVkIHRyYW5zZmVyIGNhbiBuZXZlciBiZQpyZXZlcnNlZCB0aHJvdWdoIHRoaXMgcGF0aC4AAAAAAAAPY2FuY2VsX3RyYW5zZmVyAAAAAAEAAAAAAAAAAmlkAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAA8tSZWFkLW9ubHkgdGFnLWluZGV4IGludGVncml0eSBjaGVjayBmb3IgYSBib3VuZGVkIHNldCBvZiByZXNvdXJjZSBpZHMuCgpDb21wYXJlcyBlYWNoIHJlc291cmNlJ3MgY2Fub25pY2FsIHRhZ3MgKHRoZSBzb3VyY2Ugb2YgdHJ1dGgpIGFnYWluc3QKYFRhZ0luZGV4YCBtZW1iZXJzaGlwIGFuZCByZXBvcnRzIGRyaWZ0IGluIGJvdGggZGlyZWN0aW9uczoKLSBbYFRhZ0luZGV4UmVwb3J0OjptaXNzaW5nYF0g4oCUIHRoZSByZXNvdXJjZSBjYXJyaWVzIHRoZSB0YWcgYnV0IHRoZQppbmRleCBkb2VzIG5vdCBsaXN0IHRoZSBpZCB1bmRlciBpdC4KLSBbYFRhZ0luZGV4UmVwb3J0OjpzdGFsZWBdIOKAlCB0aGUgaW5kZXggbGlzdHMgdGhlIGlkIHVuZGVyIGEgdGFnIHRoZQpyZXNvdXJjZSBkb2VzIG5vdCBjYXJyeS4KCkJvdW5kZWQgYnkgW2BNQVhfVEFHX0lOREVYX0NIRUNLYF0uIFN0YWxlIG1lbWJlcnNoaXBzIGFyZSBhdWRpdGVkIG9ubHkKdW5kZXIgdGhlIHVuaW9uIG9mIHRhZ3MgY2FycmllZCBieSB0aGUgY2hlY2tlZCByZXNvdXJjZXM7IG1lbWJlcnNoaXBzCnVuZGVyIHRhZ3Mgb3V0c2lkZSB0aGF0IHVuaW9uIGFyZSBub3QgcmVwb3J0ZWQgKHVzZSBgcmVwYWlyX3RhZ19pbmRleGAKZm9yIGEgZnVsbCByZWJ1aWxkKS4gTmV2ZXIgd3JpdGVzIHN0b3JhZ2UgYW5kIG5ldmVyIGVtaXRzIGV2ZW50cywgc28gaXQKaXMgc2FmZSB0byBydW4gZnJvbSBvcGVyYXRpb25hbCB0b29saW5nIGJlZm9yZSBhIHJlcGFpci4KCkVycm9ycyBkZXRlcm1pbmlzdGljYWxseToKLSBbYEVycm9yOjpCYXRjaFRvb0xhcmdlYF0g4oCUIG1vcmUgdGhhbiBbYE1BWF9UQUdfSU5ERVhfQ0hFQ0tgXSBpZHMKLSBbYEVycm9yOjpOb3RGb3VuZGBdIOKAlCBhbnkgaWQgaXMgbm90IGEgcmVnaXN0ZXJlZCByZXNvdXJjZQotIFtgRXJyb3I6OkludmFsaWRSZXNvdXJjZUlkYF0g4oCUIGFueSBpZCBmYWlscyBmb3JtYXQgdmFsaWRhdGlvbgAAAAAPY2hlY2tfdGFnX2luZGV4AAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAAEAAAAAEAAAPpAAAH0AAAAA5UYWdJbmRleFJlcG9ydAAAAAAAAw==",
        "AAAAAAAAAM1QZXJtYW5lbnRseSBmcmVlemUgYSByZXNvdXJjZSdzIG1ldGFkYXRhIHBvaW50ZXIuIE9ubHkgdGhlIGNyZWF0b3IgbWF5CmNhbGwgdGhpcy4gSXJyZXZlcnNpYmxlIOKAlCBlcnJvcnMgYEFscmVhZHlGcm96ZW5gIGlmIGNhbGxlZCB0d2ljZS4KUHJpY2UsIGxpc3RpbmcsIHRhZ3MsIGFuZCBvd25lcnNoaXAgcmVtYWluIG11dGFibGUgYWZ0ZXIgZnJlZXppbmcuAAAAAAAAD2ZyZWV6ZV9tZXRhZGF0YQAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAO5GcmVlemUgYW4gb3RoZXJ3aXNlIGFjdGl2ZSByZXNvdXJjZS4gVGhlIGNyZWF0b3IgbWF5IGZyZWV6ZSBhIGxpc3RlZCBvcgpkZWxpc3RlZCByZXNvdXJjZSwgYW5kIG1heSByZXN0b3JlIGl0IChvciBhIHBvc3QtZGlzcHV0ZSBgRnJvemVuYApyZXNvbHV0aW9uKSB0aHJvdWdoIGByZWFjdGl2YXRlX3Jlc291cmNlYC4gVGhpcyBsaWZlY3ljbGUgZnJlZXplIGlzCnNlcGFyYXRlIGZyb20gYGZyZWV6ZV9tZXRhZGF0YWAuAAAAAAAPZnJlZXplX3Jlc291cmNlAAAAAAEAAAAAAAAAAmlkAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAN1XaGV0aGVyIGBob2xkZXJgIGN1cnJlbnRseSBoYXMgYWNjZXNzIHRvIGByZXNvdXJjZV9pZGAgdGhyb3VnaCBhCmxlYXNlOiBvbmUgZXhpc3RzLCBpdCBpcyBgQWN0aXZlYCwgYW5kIHRoZSBjdXJyZW50IGxlZGdlciBpcyBiZWxvdwppdHMgYGV4cGlyeV9sZWRnZXJgLiBOZXZlciBlcnJvcnM7IHVua25vd24gcGFpcnMgYW5kIG1hbGZvcm1lZCBpZHMKc2ltcGx5IHJldHVybiBgZmFsc2VgLgAAAAAAAA9sZWFzZV9pc19hY3RpdmUAAAAAAgAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAPNQYWdpbmF0ZWQgbGlzdGluZyBvZiByZXNvdXJjZXMgb3duZWQgYnkgYGNyZWF0b3JgIGluIGluc2VydGlvbiBvcmRlci4KCi0gUmVzdWx0cyBhcmUgb3JkZXJlZCBieSBnbG9iYWwgcmVnaXN0cmF0aW9uIHNlcXVlbmNlIGZvciB0aGF0IGNyZWF0b3IuCi0gYGxpbWl0YCBpcyBjYXBwZWQgYXQgYDIwYC4KLSBSZXR1cm5zIGVtcHR5IGBWZWNgIHdoZW4gYHN0YXJ0YCBpcyBiZXlvbmQgdGhlIGNyZWF0b3IncyBrbm93biBpdGVtcy4AAAAAD2xpc3RfYnlfY3JlYXRvcgAAAAADAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAABXN0YXJ0AAAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+oAAAfQAAAACFJlc291cmNl",
        "AAAAAAAAAEdSZXZva2UgdGhlIHZlcmlmaWVyIHJvbGUgZnJvbSBgdmVyaWZpZXJgLiBPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLgAAAAAPcmVtb3ZlX3ZlcmlmaWVyAAAAAAEAAAAAAAAACHZlcmlmaWVyAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAEFSZXNvbHZlIGEgZGlzcHV0ZWQgcmVzb3VyY2UgdG8gYExpc3RlZGAsIGBEZWxpc3RlZGAsIG9yIGBGcm96ZW5gLgAAAAAAAA9yZXNvbHZlX2Rpc3B1dGUAAAAAAwAAAAAAAAACaWQAAAAAABAAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFc3RhdGUAAAAAAAfQAAAADVJlc291cmNlU3RhdGUAAAAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAPcm90YXRlX3ZlcmlmaWVyAAAAAAIAAAAAAAAADG9sZF92ZXJpZmllcgAAABMAAAAAAAAADG5ld192ZXJpZmllcgAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAlhSZW1vdmUgdGhlIGRpc3B1dGUgZmxhZyBmcm9tIGEgcmVzb3VyY2UuIE9ubHkgYW4gYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZwp0aGUgbW9kZXJhdG9yIHJvbGUgKHNlZSBgYWRkX21vZGVyYXRvcmApIG1heSBjYWxsIHRoaXMuCgpDbGVhcnMgYFJlc291cmNlLmRpc3B1dGVfZmxhZ2AgdG8gYE5vbmVgLiBJZiB0aGUgcmVzb3VyY2UgaXMgbm90IGN1cnJlbnRseQpmbGFnZ2VkIHRoaXMgaXMgYSBuby1vcCAodGhlIGV2ZW50IGlzIHN0aWxsIGVtaXR0ZWQgc28gb2ZmLWNoYWluIGluZGV4ZXJzCmhhdmUgYSBjb21wbGV0ZSBhdWRpdCB0cmFpbCkuCgpFbWl0cyBhbiBgdW5mbGFnYCBldmVudCB3aXRoIHRoZSByZXNvdXJjZSBgaWRgIGFzIHRoZSBkYXRhIHBheWxvYWQuCgpFcnJvcnMgZGV0ZXJtaW5pc3RpY2FsbHk6Ci0gW2BFcnJvcjo6VW5hdXRob3JpemVkYF0g4oCUIGNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSBtb2RlcmF0b3Igcm9sZQotIFtgRXJyb3I6Ok5vdEZvdW5kYF0g4oCUIGBpZGAgaXMgbm90IGEgcmVnaXN0ZXJlZCByZXNvdXJjZQotIFtgRXJyb3I6OkludmFsaWRSZXNvdXJjZUlkYF0g4oCUIGBpZGAgZmFpbHMgZm9ybWF0IHZhbGlkYXRpb24AAAAPdW5mbGFnX3Jlc291cmNlAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAj1VcGRhdGUgYSByZXNvdXJjZSdzIG1ldGFkYXRhIHBvaW50ZXIuIE9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4KCkVtaXRzIGEgW2BNZXRhZGF0YVVwZGF0ZUV2ZW50YF0gY29udGFpbmluZyB0aGUgcmVzb3VyY2UgaWQsIHRoZSBwcmV2aW91cwptZXRhZGF0YSBwb2ludGVyIChgb2xkX21ldGFkYXRhYCksIGFuZCB0aGUgbmV3IG9uZSAoYG5ld19tZXRhZGF0YWApLgpPZmYtY2hhaW4gaW5kZXhlcnMgY2FuIHVzZSB0aGVzZSBmaWVsZHMgdG8gYnVpbGQgYW4gYXVkaXQgdHJhaWwgd2l0aG91dApxdWVyeWluZyBoaXN0b3JpY2FsIGxlZGdlciBzdGF0ZS4KCk5vLW9wIGd1YXJkOiBpZiBgbWV0YWRhdGFgIGlzIGlkZW50aWNhbCB0byB0aGUgcmVzb3VyY2UncyBjdXJyZW50Cm1ldGFkYXRhIHBvaW50ZXIsIHRoZSBjYWxsIHN1Y2NlZWRzIHdpdGhvdXQgdG91Y2hpbmcgc3RvcmFnZSBvcgplbWl0dGluZyBhbiBgdXBkbWV0YWAgZXZlbnQuIEEgcmVzb3VyY2UgcmVnaXN0ZXJlZCB3aXRoIGEgY29udGVudCBoYXNoCnJlamVjdHMgYW55IGRpdmVyZ2VudCBwb2ludGVyIHdpdGggYE1ldGFkYXRhRnJvemVuYC4AAAAAAAAPdXBkYXRlX21ldGFkYXRhAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAhtZXRhZGF0YQAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAAM9QYXlsb2FkIG9mIHRoZSBgYW5jaHJmYWlsYCBldmVudCwgYWxzbyBzdG9yZWQgZHVyYWJseSBieQpbYHJlY29yZF9hbmNob3JfZmFpbHVyZWBdLiBDYXJyaWVzIHRoZSBjYWxsZXIncyBpbnB1dHMgcGx1cyB0aGUgcmVhc29uIGFuZApsZWRnZXIsIHNvIGEgYnV5ZXIgY2FuIHJlY29uc3RydWN0IHRoZSBhdHRlbXB0IGZyb20gW2BnZXRfYW5jaG9yX2ZhaWx1cmVgXS4AAAAAAAAAAA1BbmNob3JGYWlsdXJlAAAAAAAABQAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAAAZsZWRnZXIAAAAAAAQAAAAAAAAABnJlYXNvbgAAAAAH0AAAABNBbmNob3JGYWlsdXJlUmVhc29uAAAAAAAAAAAMcmVjZWlwdF9oYXNoAAAAEAAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEA==",
        "AAAAAQAAAJZPbi1jaGFpbiByZWNvcmQgb2YgYSBjb21wbGV0ZWQgcmVmdW5kIHRyYW5zZmVyIGFzc29jaWF0ZWQgd2l0aCBhIHBheW1lbnQuClRoZSByZWdpc3RyeSByZWNvcmRzIGFuZCBjYXBzIHJlZnVuZHMgYnV0IGRvZXMgbm90IGN1c3RvZHkgb3IgdHJhbnNmZXIgVVNEQy4AAAAAAAAAAAANUmVmdW5kUmVjZWlwdAAAAAAAAAkAAAAAAAAADmFkbWluX292ZXJyaWRlAAAAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAADGluaXRpYXRlZF9ieQAAABMAAAAAAAAAEnBheW1lbnRfcmVjZWlwdF9pZAAAAAAAEAAAAAAAAAAJcmVjaXBpZW50AAAAAAAAEwAAAAAAAAALcmVjb3JkZWRfYXQAAAAABAAAAAAAAAAJcmVmdW5kX2lkAAAAAAAAEAAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAHdHhfaGFzaAAAAAAQ",
        "AAAAAQAAAI1TdHJ1Y3R1cmVkIHBheWxvYWQgZW1pdHRlZCBieSBgcmVnaXN0ZXIoKWAuCgpDb25zdW1lcnMgY2FuIHJlY29uc3RydWN0IGEgZnVsbCBgUmVzb3VyY2VgIGZyb20gdGhpcyBldmVudCB3aXRob3V0IGFuCmFkZGl0aW9uYWwgb24tY2hhaW4gcmVhZC4AAAAAAAAAAAAADVJlZ2lzdGVyRXZlbnQAAAAAAAAHAAAAAAAAAAxjb250ZW50X2hhc2gAAAPoAAAAEAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAGbGlzdGVkAAAAAAABAAAAAAAAAAhtZXRhZGF0YQAAABAAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAEdGFncwAAA+oAAAAQ",
        "AAAAAgAAAT5UaGUgYXZhaWxhYmlsaXR5IGFuZCBtb2RlcmF0aW9uIHN0YXRlIG9mIGEgcmVzb3VyY2UuCgpgbGlzdGVkYCByZW1haW5zIG9uIFtgUmVzb3VyY2VgXSBhcyBhIGJhY2t3YXJkcy1jb21wYXRpYmxlIHByb2plY3Rpb246IGl0CmlzIHRydWUgZXhhY3RseSB3aGVuIHRoaXMgdmFsdWUgaXMgW2BSZXNvdXJjZVN0YXRlOjpMaXN0ZWRgXS4gQ2xpZW50cyB0aGF0Cm5lZWQgdG8gZGlzdGluZ3Vpc2ggYSBtb2RlcmF0aW9uIGhvbGQgZnJvbSBhIGNyZWF0b3IgZGVsaXN0IG11c3QgdXNlIHRoaXMKZmllbGQgcmF0aGVyIHRoYW4gdGhlIGJvb2xlYW4gcHJvamVjdGlvbi4AAAAAAAAAAAANUmVzb3VyY2VTdGF0ZQAAAAAAAAUAAAAAAAAAAAAAAAZMaXN0ZWQAAAAAAAAAAAAAAAAACERlbGlzdGVkAAAAAAAAAAAAAAAGRnJvemVuAAAAAAAAAAAAAAAAAAhEaXNwdXRlZAAAAAAAAAAAAAAAClRvbWJzdG9uZWQAAA==",
        "AAAAAQAAAE1PbmUgYChyZXNvdXJjZV9pZCwgdGFnKWAgcGFpciByZXBvcnRlZCBieSBbYFZhdWx0UmVnaXN0cnk6OmNoZWNrX3RhZ19pbmRleGBdLgAAAAAAAAAAAAANVGFnTWVtYmVyc2hpcAAAAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAN0YWcAAAAAEA==",
        "AAAAAQAAAAAAAAAAAAAADVRhZ1BvcHVsYXJpdHkAAAAAAAACAAAAAAAAAAVjb3VudAAAAAAAAAQAAAAAAAAAA3RhZwAAAAAQ",
        "AAAAAAAAAnxSZXR1cm4gdGhlIGNvbnRyYWN0IGNyYXRlIHZlcnNpb24gYW5kIHRoZSBgUmVzb3VyY2VgIHNjaGVtYSB2ZXJzaW9uIGFzIGEKc3RhYmxlLCBjb21wYWN0IHN0cnVjdC4gRGVwbG95bWVudCBzY3JpcHRzIGFuZCB1cGdyYWRlIHRvb2xzIHNob3VsZCBjYWxsCnRoaXMgdG8gY29uZmlybSB3aGljaCB2ZXJzaW9uIG9mIHRoZSBjb250cmFjdCBpcyBydW5uaW5nIG9uLWNoYWluIGJlZm9yZQphbmQgYWZ0ZXIgYSByZWRlcGxveSwgd2l0aG91dCBuZWVkaW5nIHRvIHBhcnNlIHRoZSBmdWxsIGByZWdpc3RyeV9pbmZvYApyZXNwb25zZS4KClVwZ3JhZGUgY29tcGF0aWJpbGl0eTogYGNyYXRlX3ZlcnNpb25gIGlzIHRoZSBDYXJnbyBzZW12ZXIgc3RyaW5nIGJha2VkCmluIGF0IGJ1aWxkIHRpbWUgKGBDQVJHT19QS0dfVkVSU0lPTmApLiBgcmVzb3VyY2Vfc2NoZW1hX3ZlcnNpb25gIGlzIGFuCmludGVnZXIgYnVtcGVkIG9ubHkgd2hlbiB0aGUgb24tY2hhaW4gYFJlc291cmNlYCBzdHJ1Y3QgY2hhbmdlcyBpbiBhIHdheQp0aGF0IHJlcXVpcmVzIGNhbGxlcnMgdG8gdXBkYXRlIGhvdyB0aGV5IGRlY29kZSBpdC4gQSBjaGFuZ2UgdG8KYGNyYXRlX3ZlcnNpb25gIGFsb25lIGRvZXMgbm90IGltcGx5IGEgc2NoZW1hIGNoYW5nZS4AAAAQY29udHJhY3RfdmVyc2lvbgAAAAAAAAABAAAH0AAAAA9Db250cmFjdFZlcnNpb24A",
        "AAAAAAAABABFbWVyZ2VuY3ktZGVsaXN0IGEgZGlzcHV0ZWQgcmVzb3VyY2UuIE9ubHkgdGhlIGN1cnJlbnQgYWRtaW4gbWF5IGNhbGwKdGhpcywgYW5kIG9ubHkgd2hpbGUgdGhlIHJlc291cmNlIGlzIGluIHRoZSBgRGlzcHV0ZWRgIHN0YXRlLgoKRW1pdHMgYW4gYGVtZGVsaXN0YCBldmVudCB3aXRoIGBFbWVyZ2VuY3lEZWxpc3RFdmVudCB7IGlkLCBhZG1pbiwgcmVhc29uIH1gLgpBIGNyZWF0b3IgZGVsaXN0IGdvZXMgdGhyb3VnaCBgc2V0X2xpc3RlZGAvYGRlbGlzdGAgYW5kIGVtaXRzIGBzZXRsaXN0ZWRgLApzbyB0aGUgdHdvIGFjdGlvbnMgYXJlIG5vdyBkaXN0aW5ndWlzaGFibGUgYnkgdG9waWMgYWxvbmU6IGFuIGluZGV4ZXIKc2VlaW5nIGBlbWRlbGlzdGAga25vd3MgYW4gYWRtaW4gcHVsbGVkIHRoZSByZXNvdXJjZSBhbmQgY2FuIGF0dHJpYnV0ZSBpdAp0byBgYWRtaW5gIHdpdGggdGhlIGNhbGxlcidzIHN0YXRlZCBgcmVhc29uYC4gQmVmb3JlIHRoaXMgZXZlbnQgZXhpc3RlZCwKYGVtZXJnZW5jeV9kZWxpc3RgIGVtaXR0ZWQgbm90aGluZyBhdCBhbGwsIHNvIGFuIGFkbWluIHRha2Vkb3duIHdhcyBvbmx5CnZpc2libGUgYnkgcmVhZGluZyByZXNvdXJjZSBzdGF0ZSBhZnRlciB0aGUgZmFjdC4KCmByZWFzb25gIGlzIGZyZWUtZm9ybSBhbmQgaXMgbm90IGxlbmd0aC12YWxpZGF0ZWQuIFRoZSBjYWxsZXIgaXMgdGhlCmF1dGhlbnRpY2F0ZWQgY3VycmVudCBhZG1pbiwgc28gYW4gb3ZlcnNpemVkIHZhbHVlIGNvc3RzIHRoZSBhZG1pbiB0aGVpcgpvd24gdHJhbnNhY3Rpb24gZmVlIHJhdGhlciB0aGFuIGVuYWJsaW5nIGdyaWVmaW5nLCBhbmQgdGhlIGNvbnRyYWN0IGhhcyBubwpzcGFyZSBlcnJvciBjb2RlIHRvIHJlamVjdCBpdCB3aXRoIOKAlCBgRXJyb3JgIGlzIGF0IHRoZSBwcm90b2NvbCdzIDUwLWNhc2UKY2FwIChzZWUgdGhlIG5vdGUgb24gdGhlIGVudW0pLiBBZG1pbiBqdXN0aWZpY2F0aW9uIGlzIGJlc3QgbGVmdAp1bm9waW5pb25hdGVkOyBjb25zdW1lcnMgdGhhdCBuZWVkIGEgY29uAAAAEGVtZXJnZW5jeV9kZWxpc3QAAAADAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAZyZWFzb24AAAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAIlgbGlzdF9ieV90YWdgIHdpdGggYW4gaWQtYmFzZWQgY3Vyc29yIChzZWUgYGxpc3RfYnlfY3JlYXRvcl9wYWdlYCkuClRvbWJzdG9uZWQgcmVzb3VyY2VzIGFyZSBza2lwcGVkIGV4YWN0bHkgYXMgYGxpc3RfYnlfdGFnYCBza2lwcyB0aGVtLgAAAAAAABBsaXN0X2J5X3RhZ19wYWdlAAAAAwAAAAAAAAADdGFnAAAAABAAAAAAAAAABmN1cnNvcgAAAAAH0AAAAAhJZEN1cnNvcgAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAB9AAAAAGSWRQYWdlAAA=",
        "AAAAAAAAAMxgbGlzdF9saXN0ZWRgIHdpdGggbmV4dC1jdXJzb3IgbWV0YWRhdGE6IGBjdXJzb3JgIGFuZCBgbmV4dF9jdXJzb3JgCmFyZSBnbG9iYWwgY2F0YWxvZyBpbmRleGVzIChzYW1lIGRvbWFpbiBhcyBgbGlzdF9wYWdlYCksIHNvIGEgcGFnZQpib3VuZGFyeSBpcyBzdGFibGUgaG93ZXZlciBtYW55IHJlc291cmNlcyBjaGFuZ2Ugc3RhdGUgYmV0d2VlbiBjYWxscy4AAAAQbGlzdF9saXN0ZWRfcGFnZQAAAAIAAAAAAAAABmN1cnNvcgAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAB9AAAAALQ2F0YWxvZ1BhZ2UA",
        "AAAAAAAAAMJVcGdyYWRlIGEgcmVzb3VyY2Ugd3JpdHRlbiB1c2luZyB0aGUgaW1tZWRpYXRlbHkgcHJlY2VkaW5nIHN1cHBvcnRlZApzY2hlbWEuIEN1cnJlbnQtc2NoZW1hIHJlc291cmNlcyBhcmUgYWNjZXB0ZWQgYXMgYSBuby1vcC4gVW5zdXBwb3J0ZWQKc2NoZW1hIHZlcnNpb25zIGFyZSByZWplY3RlZCBiZWZvcmUgc3RvcmFnZSBpcyB0b3VjaGVkLgAAAAAAEG1pZ3JhdGVfcmVzb3VyY2UAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAEBQcm9wb3NlIGEgdHJhbnNmZXIgdG8gYSBuZXcgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBhY2NlcHQgaXQuAAAAEHByb3Bvc2VfdHJhbnNmZXIAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAElSZXZva2UgdGhlIG1vZGVyYXRvciByb2xlIGZyb20gYG1vZGVyYXRvcmAuIE9ubHkgdGhlIGFkbWluIG1heSBjYWxsIHRoaXMuAAAAAAAAEHJlbW92ZV9tb2RlcmF0b3IAAAABAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAABABSZWJ1aWxkIHRoZSB0YWcgaW5kZXggZnJvbSBhbiBhdXRob3JpdGF0aXZlLCBhZG1pbi1zdXBwbGllZCBvcmRlcmVkCmxpc3Qgb2YgcmVzb3VyY2UgaWRzLiBPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLiBFdmVyeSBpZCBtdXN0CmFscmVhZHkgZXhpc3QgYXMgYSByZWdpc3RlcmVkIGBSZXNvdXJjZWAgKGVsc2UgYE5vdEZvdW5kYCkuIFVubGlrZQpgcmVwYWlyX2luZGV4YCwgZHVwbGljYXRlcyBpbiB0aGUgaWQgbGlzdCBhcmUgaGFybWxlc3MgKHRhZyBpbmRleCBoYXMKc2V0IHNlbWFudGljcyBwZXIgdGFnIOKAlCByZS1pbmRleGluZyB0aGUgc2FtZSBpZCBpcyBpZGVtcG90ZW50KSBhbmQKYXJlIHNpbGVudGx5IGRlLWR1cGxpY2F0ZWQgcmF0aGVyIHRoYW4gcmVqZWN0ZWQuIE5ldmVyIHJlYWRzLCB3cml0ZXMsCm9yIGRlbGV0ZXMgYFJlc291cmNlYCBzdG9yYWdlIOKAlCBvbmx5IHJld3JpdGVzIHRoZSBkZXJpdmVkIGBUYWdJbmRleGAKZW50cmllcyBmb3IgdGhlIHRhZ3MgdGhvc2UgcmVzb3VyY2VzIGN1cnJlbnRseSBjYXJyeS4gU2FmZSB0byByZS1ydW4Kd2l0aCB0aGUgY29ycmVjdCBjdXJyZW50IGlkIGxpc3QgYXMgYSBuby1vcC4gU2VlCmBkb2NzL3RhZy1pbmRleC1yZXBhaXItZGVzaWduLm1kYCBmb3IgdGhlIGZ1bGwgc3RyYXRlZ3kuCgpBbiBlbXB0eSBgaWRzYCBsaXN0IGlzIGEgZG9jdW1lbnRlZCBuby1vcDogaXQgcmV0dXJucyBgT2soKCkpYCBhbmQKZGVsaWJlcmF0ZWx5IGVtaXRzICoqbm8qKiBgcmV0YWdpZHhgIGV2ZW50LiBUaGVyZSBpcyBub3RoaW5nIHRvIGluZGV4LCBzbwpldmVyeSBgVGFnSW5kZXhgIGVudHJ5IGlzIGxlZnQgZXhhY3RseSBhcyBpdCB3YXMsIGFuZCBzdXBwcmVzc2luZyB0aGUKZXZlbnQgaXMgd2hhdCBrZWVwcyB0aGUgY2FsbCBmcm9tIHJlYWRpbmcgYXMgYSBzdWNjZXNzZnVsIHJlcGFpciDigJQgdGhlCkFEUidzIGByZXRhZ2lkeGAgcGF5bG9hZCBpcyB0aGUgc2lnbmFsIG9wZXJhdG9ycyBhbmQgYXVkaXQgdG9vbGluZyB1c2UgdG8Kc2VlIHRoYXQgAAAAEHJlcGFpcl90YWdfaW5kZXgAAAABAAAAAAAAAANpZHMAAAAD6gAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAVJTY2hlZHVsZSBhbiBlbWVyZ2VuY3kgcGF1c2UgdGhhdCBhdXRvbWF0aWNhbGx5IGV4cGlyZXMgYXQgYHBhdXNlX3VudGlsYC4KClRoZSBkZWFkbGluZSBpcyBhbiBhYnNvbHV0ZSBVbml4IHRpbWVzdGFtcCBpbiBzZWNvbmRzIGZyb20gdGhlIGxlZGdlcgpjbG9jay4gVGhlIGV4aXN0aW5nIGBzZXRfcGF1c2VkKGFkbWluLCB0cnVlKWAgZW50cnkgcG9pbnQgcmVtYWlucyB0aGUKd2F5IHRvIGNyZWF0ZSBhbiBpbmRlZmluaXRlIHBhdXNlLiBBIGRlYWRsaW5lIGF0IG9yIGJlZm9yZSB0aGUgY3VycmVudApsZWRnZXIgdGltZXN0YW1wIHRha2VzIGVmZmVjdCBhcyBhbiBpbW1lZGlhdGUgcmVzdW1lLgAAAAAAEHNldF9wYXVzZWRfdW50aWwAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAC3BhdXNlX3VudGlsAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAANBSZWplY3RlZC1hdHRlbXB0IGJvb2trZWVwaW5nIGZvciBvbmUgYChyZXNvdXJjZV9pZCwgYnV5ZXIpYCBhbmNob3IgcGFpci4KUmVhZCBiYWNrIGJ5IGBnZXRfYW5jaG9yX2F0dGVtcHRzYDsgYm90aCBmaWVsZHMgYXJlIGAwYCBmb3IgYSBwYWlyIHRoYXQKaGFzIG5ldmVyIGJlZW4gcmVqZWN0ZWQgb3Igd2hvc2UgYW5jaG9yIGhhcyBzaW5jZSBiZWVuIHdyaXR0ZW4uAAAAAAAAAA5BbmNob3JBdHRlbXB0cwAAAAAAAgAAAEFSZWplY3RlZCBhdHRlbXB0cyBzbyBmYXIgKG5ldmVyIG1vcmUgdGhhbiBgTUFYX0FOQ0hPUl9BVFRFTVBUU2ApLgAAAAAAAAhhdHRlbXB0cwAAAAQAAAA0TGVkZ2VyIHNlcXVlbmNlIG9mIHRoZSBtb3N0IHJlY2VudCByZWplY3RlZCBhdHRlbXB0LgAAABNsYXN0X2F0dGVtcHRfbGVkZ2VyAAAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAADkZlZURlc3RpbmF0aW9uAAAAAAADAAAAAAAAAAAAAAAETm9uZQAAAAAAAAAAAAAABEJ1cm4AAAABAAAAAAAAAAdDaGFyaXR5AAAAAAEAAAAT",
        "AAAAAQAAAnVBIHBheW1lbnQgcmVjZWlwdCBhbmNob3JpbmcgYW4geDQwMi9Tb3JvYmFuIHNldHRsZW1lbnQgdG8gYSBzcGVjaWZpYwp2YXVsdCByZXNvdXJjZSBhbmQgcGF5ZXIuIFdyaXR0ZW4gYnkgYW4gYWRkcmVzcyBob2xkaW5nIHRoZSBzZXR0bGVyIHJvbGUuCgpgcmVjZWlwdF9pZGAgaXMgYSBjYWxsZXItY2hvc2VuIHVuaXF1ZSBpZGVudGlmaWVyIChtYXggNjQgYnl0ZXMpIOKAlAp0eXBpY2FsbHkgdGhlIHg0MDIgZmFjaWxpdGF0b3IncyBvd24gcmVjZWlwdCBvciB0cmFuc2FjdGlvbiBJRC4KYHR4X2hhc2hgIGlzIHRoZSBTdGVsbGFyIHRyYW5zYWN0aW9uIGhhc2ggb2YgdGhlIFVTREMgdHJhbnNmZXIgKG1heCAxMjgKYnl0ZXMpLCBwcmVzZW50IGZyb20gY3JlYXRpb24gc28gaW5kZXhlcnMgY2FuIHZlcmlmeSBzZXR0bGVtZW50IG9uLWNoYWluCndpdGhvdXQgYSBzZWNvbmQgcm91bmQtdHJpcC4KCkZpZWxkcyBhcmUgaW50ZW50aW9uYWxseSByZWFkLW9ubHkgYWZ0ZXIgcmVjb3JkaW5nLiBUbyB1cGRhdGUgc3RhdGUsCmNhbGwgYHNldHRsZV9wYXltZW50YCB3aGljaCB0cmFuc2l0aW9ucyBgRXNjcm93ZWQg4oaSIFNldHRsZWRgIGFuZApyZS1lbWl0cyB0aGUgcmVjZWlwdCBhcyBhIGBzZXR0bGVgIGV2ZW50LgAAAAAAAAAAAAAOUGF5bWVudFJlY2VpcHQAAAAAAAgAAAB5UGF5bWVudCBhbW91bnQgaW4gVVNEQyBiYXNlIHVuaXRzLCB0aGUgc2FtZSB1bml0IGFzCltgUmVzb3VyY2U6OnByaWNlYF07IGByZWNvcmRfcGF5bWVudGAgcmVxdWlyZXMgZXhhY3QgZXF1YWxpdHkuIGA+IDBgLgAAAAAAAAZhbW91bnQAAAAAAAsAAAAmQ29tcGF0aWJpbGl0eSBhbGlhcyBmb3IgYHJlY29yZGVkX2F0YC4AAAAAAAZsZWRnZXIAAAAAAAQAAAAzU3RlbGxhciBhZGRyZXNzIG9mIHRoZSBwYXJ0eSB0aGF0IG1hZGUgdGhlIHBheW1lbnQuAAAAAAVwYXllcgAAAAAAABMAAAA5Q2FsbGVyLWFzc2lnbmVkIHVuaXF1ZSByZWNlaXB0IGlkZW50aWZpZXIgKG1heCA2NCBieXRlcykuAAAAAAAACnJlY2VpcHRfaWQAAAAAABAAAABATGVkZ2VyIHNlcXVlbmNlIG51bWJlciBhdCB3aGljaCB0aGlzIHJlY2VpcHQgd2FzIGZpcnN0IHJlY29yZGVkLgAAAAtyZWNvcmRlZF9hdAAAAAAEAAAAIVRoZSByZXNvdXJjZSB0aGlzIHBheW1lbnQgaXMgZm9yLgAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAKEN1cnJlbnQgbGlmZWN5Y2xlIHN0YXRlIG9mIHRoaXMgcmVjZWlwdC4AAAAFc3RhdGUAAAAAAAfQAAAADFBheW1lbnRTdGF0ZQAAAElTdGVsbGFyIHRyYW5zYWN0aW9uIGhhc2ggb2YgdGhlIFVTREMgdHJhbnNmZXIgKG5vbi1lbXB0eSwgbWF4IDEyOCBieXRlcykuAAAAAAAAB3R4X2hhc2gAAAAAEA==",
        "AAAAAQAAAOdPbmUgcm93IG9mIGEgYm91bmRlZCByZWdpc3RyeSBleHBvcnQgKGBleHBvcnRfcGFnZWApLgoKQSBmbGF0dGVuZWQgcHJvamVjdGlvbiBvZiBbYFJlc291cmNlYF0gZm9yIG1pZ3JhdGlvbiB0b29saW5nOiBpdCBjYXJyaWVzCm9ubHkgdGhlIGZpZWxkcyBhbiBpbmRleGVyIG5lZWRzIHRvIHJlYnVpbGQgc3RhdGUgZWxzZXdoZXJlLCBhbmQgbmV2ZXIKdGhlIHJlc291cmNlJ3MgbWV0YWRhdGEgcG9pbnRlci4AAAAAAAAAAA5SZXNvdXJjZUV4cG9ydAAAAAAADQAAAAAAAAAKY3JlYXRlZF9hdAAAAAAABAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAUWB0cnVlYCB3aGlsZSBhIG1vZGVyYXRvciBkaXNwdXRlIGZsYWcgaXMgYWN0aXZlLiBUaGUgZmxhZyByZWFzb24gaXMKbm90IGV4cG9ydGVkLgAAAAAAAAdmbGFnZ2VkAAAAAAEAAAAAAAAABmZyb3plbgAAAAAAAQAAAAAAAAACaWQAAAAAABAAAABwQ2F0YWxvZyBpbmRleCAoYERhdGFLZXk6OkluZGV4YCkgdGhlIHJlc291cmNlIHdhcyByZWdpc3RlcmVkIHVuZGVyLgpTdHJpY3RseSBpbmNyZWFzaW5nIHdpdGhpbiBhbmQgYWNyb3NzIHBhZ2VzLgAAAAVpbmRleAAAAAAAAAQAAAAAAAAABmxpc3RlZAAAAAAAAQAAACBMaXN0ZWQgcHJpY2UgaW4gVVNEQyBiYXNlIHVuaXRzLgAAAAVwcmljZQAAAAAAAAsAAACBYFJlc291cmNlYCBzdG9yYWdlIHNjaGVtYSB0aGUgZW50cnkgd2FzIGxhc3Qgd3JpdHRlbiB3aXRoLiBFbnRyaWVzCmJlbG93IGBSRVNPVVJDRV9TQ0hFTUFfVkVSU0lPTmAgc3RpbGwgbmVlZCBgbWlncmF0ZV9yZXNvdXJjZWAuAAAAAAAADnNjaGVtYV92ZXJzaW9uAAAAAAAEAAAAAAAAAAVzdGF0ZQAAAAAAB9AAAAANUmVzb3VyY2VTdGF0ZQAAAAAAAAAAAAAKdXBkYXRlZF9hdAAAAAAABAAAAAAAAAAIdmVyaWZpZWQAAAfQAAAAElZlcmlmaWNhdGlvblN0YXR1cwAAAAAALU1vbm90b25pYyB3cml0ZSBjb3VudGVyIChgUmVzb3VyY2UudmVyc2lvbmApLgAAAAAAAAd2ZXJzaW9uAAAAAAQ=",
        "AAAAAQAAAMpSZXN1bHQgb2YgW2BWYXVsdFJlZ2lzdHJ5OjpjaGVja190YWdfaW5kZXhgXS4gYG1pc3NpbmdgIGxpc3RzIG1lbWJlcnNoaXBzCnRoZSByZXNvdXJjZSBjYXJyaWVzIGJ1dCB0aGUgdGFnIGluZGV4IGRvZXMgbm90OyBgc3RhbGVgIGxpc3RzIG1lbWJlcnNoaXBzCnRoZSB0YWcgaW5kZXggaG9sZHMgdGhhdCB0aGUgcmVzb3VyY2UgZG9lcyBub3QgY2FycnkuAAAAAAAAAAAADlRhZ0luZGV4UmVwb3J0AAAAAAACAAAALEluIHJlc291cmNlIHRhZ3MgYnV0IGFic2VudCBmcm9tIGBUYWdJbmRleGAuAAAAB21pc3NpbmcAAAAD6gAAB9AAAAANVGFnTWVtYmVyc2hpcAAAAAAAADpQcmVzZW50IGluIGBUYWdJbmRleGAgYnV0IGFic2VudCBmcm9tIHRoZSByZXNvdXJjZSdzIHRhZ3MuAAAAAAAFc3RhbGUAAAAAAAPqAAAH0AAAAA1UYWdNZW1iZXJzaGlwAAAA",
        "AAAAAAAAAaVVcGRhdGUgb25seSB0aGUgZmVlIHJlY2lwaWVudCBhZGRyZXNzIHdpdGhvdXQgY2hhbmdpbmcgZmVlIHJhdGVzLgpPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLiBFcnJvcnMgYEFkbWluTm90U2V0YCBpZiBubyBhZG1pbiBoYXMgYmVlbgpzZXQgeWV0LCBvciBgRmVlQ29uZmlnTm90U2V0YCBpZiBgc2V0X2ZlZV9jb25maWdgIGhhcyBuZXZlciBiZWVuIGNhbGxlZC4KClRoaXMgaXMgYSBjb252ZW5pZW5jZSBtZXRob2QgdGhhdCBhbGxvd3MgdXBkYXRpbmcgdGhlIHJlY2lwaWVudCB3aXRob3V0CmhhdmluZyB0byByZS1zcGVjaWZ5IHRoZSBleGlzdGluZyBgcGxhdGZvcm1fZmVlX2Jwc2AgYW5kIGByb3lhbHR5X2Jwc2AuCkVtaXRzIGEgYHNldGZlZWAgZXZlbnQgd2l0aCB0aGUgb2xkIGFuZCBuZXcgY29tcGxldGUgYEZlZUNvbmZpZ2AuAAAAAAAAEXNldF9mZWVfcmVjaXBpZW50AAAAAAAAAQAAAAAAAAAJcmVjaXBpZW50AAAAAAAD6AAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAJNDb25maWd1cmUgdGhlIGNyZWF0b3IgcmVmdW5kIHdpbmRvdyBmb3IgcGF5bWVudHMgc2V0dGxlZCBhZnRlciB0aGlzIGNhbGwuCkV4aXN0aW5nIHBheW1lbnQgZGVhZGxpbmVzIGFyZSBub3QgY2hhbmdlZC4gVGhlIGluaXRpYWwgdmFsdWUgaXMgb25lIGRheS4AAAAAEXNldF9yZWZ1bmRfd2luZG93AAAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAA53aW5kb3dfbGVkZ2VycwAAAAAABAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAAWdDb21wYWN0IHZlcnNpb24gc3RydWN0IHJldHVybmVkIGJ5IFtgVmF1bHRSZWdpc3RyeTo6Y29udHJhY3RfdmVyc2lvbmBdLgoKRGVwbG95bWVudCBzY3JpcHRzIGFuZCB1cGdyYWRlIHRvb2xpbmcgc2hvdWxkIGNhbGwgYGNvbnRyYWN0X3ZlcnNpb25gCmJlZm9yZSBhbmQgYWZ0ZXIgYSByZWRlcGxveSB0byBjb25maXJtIHdoaWNoIGJ1aWxkIGlzIHJ1bm5pbmcgb24tY2hhaW4uCk9ubHkgYHJlc291cmNlX3NjaGVtYV92ZXJzaW9uYCBpcyByZWxldmFudCB0byB3aGV0aGVyIGNhbGxlcnMgbXVzdCB1cGRhdGUKdGhlaXIgYFJlc291cmNlYCBkZWNvZGluZyBsb2dpYzsgYSBgY3JhdGVfdmVyc2lvbmAgYnVtcCBhbG9uZSBpcyBzYWZlLgAAAAAAAAAAD0NvbnRyYWN0VmVyc2lvbgAAAAACAAAAQUNhcmdvIHNlbXZlciBzdHJpbmcgYmFrZWQgaW4gYXQgYnVpbGQgdGltZSAoYENBUkdPX1BLR19WRVJTSU9OYCkuAAAAAAAADWNyYXRlX3ZlcnNpb24AAAAAAAAQAAAAhE9uLWNoYWluIGBSZXNvdXJjZWAgc2NoZW1hIHZlcnNpb24gKGBSRVNPVVJDRV9TQ0hFTUFfVkVSU0lPTmApLgpCdW1wIHRoaXMgb25seSB3aGVuIHRoZSBgUmVzb3VyY2VgIHN0cnVjdCBjaGFuZ2VzIGluIGEgYnJlYWtpbmcgd2F5LgAAABdyZXNvdXJjZV9zY2hlbWFfdmVyc2lvbgAAAAAE",
        "AAAAAQAAAWVPbmUgcGFnZSBvZiBhIGRldGVybWluaXN0aWMgcmVnaXN0cnktc3RhdGUgZGlnZXN0IGZvciBvZmYtY2hhaW4gaW5kZXhlcgpyZWNvbmNpbGlhdGlvbi4KCmBwYWdlX2hhc2hgIGlzIGBzaGEyNTZgIG92ZXIgdGhlIHZlcnNpb25lZCBwcmVpbWFnZSBkZXNjcmliZWQgb24KW2BWYXVsdFJlZ2lzdHJ5OjpzdGF0ZV9kaWdlc3RgXS4gVHdvIGluZGV4ZXJzIHRoYXQgaG9sZCB0aGUgc2FtZSByZWdpc3RyeQpzdGF0ZSBvdmVyIHRoZSBzYW1lIHdpbmRvdyB3aWxsIGFsd2F5cyBjb21wdXRlIHRoZSBzYW1lIGBwYWdlX2hhc2hgOwpjb21wYXJpbmcgcGFnZSBoYXNoZXMgbG9jYXRlcyB0aGUgZmlyc3Qgd2luZG93IHRoYXQgZHJpZnRlZC4AAAAAAAAAAAAAD1N0YXRlRGlnZXN0UGFnZQAAAAAFAAAAPERpZ2VzdCBlbmNvZGluZyB2ZXJzaW9uIChbYFNUQVRFX0RJR0VTVF9FTkNPRElOR19WRVJTSU9OYF0pLgAAABBlbmNvZGluZ192ZXJzaW9uAAAABAAAAEVDdXJzb3IgdG8gcGFzcyBhcyBgc3RhcnRgIG9uIHRoZSBuZXh0IGNhbGwsIG9yIGBOb25lYCBhdCBlbmQtb2YtbGlzdC4AAAAAAAALbmV4dF9jdXJzb3IAAAAD6AAAAAQAAABEYHNoYTI1NmAgZGlnZXN0IG9mIHRoaXMgcGFnZSdzIGVudHJpZXMgdW5kZXIgdGhlIHZlcnNpb25lZCBlbmNvZGluZy4AAAAJcGFnZV9oYXNoAAAAAAAD7gAAACAAAAAuSW5kZXggb2YgdGhlIGZpcnN0IGVudHJ5IGNvdmVyZWQgYnkgdGhpcyBwYWdlLgAAAAAABXN0YXJ0AAAAAAAABAAAAEBUb3RhbCBudW1iZXIgb2YgcmVnaXN0ZXJlZCByZXNvdXJjZXMgd2hlbiB0aGUgcGFnZSB3YXMgY29tcHV0ZWQuAAAABXRvdGFsAAAAAAAABA==",
        "AAAAAAAAAMdSZWFkIHRoZSBhbmNob3ItZmFpbHVyZSByZWNvcmQgZm9yIGAocmVzb3VyY2VfaWQsIGJ1eWVyKWAuIE9wZW4gdG8KYW55b25lLCBzaW5jZSBhIGJ1eWVyIG11c3QgYmUgYWJsZSB0byBmaW5kIHRoZWlyIG93biBmYWlsdXJlIHdpdGhvdXQgYQpyb2xlLiBFcnJvcnMgYE5vdEZvdW5kYCB3aGVuIHRoZXJlIGlzIG5vIG91dHN0YW5kaW5nIGZhaWx1cmUuAAAAABJnZXRfYW5jaG9yX2ZhaWx1cmUAAAAAAAIAAAAAAAAAC3Jlc291cmNlX2lkAAAAABAAAAAAAAAABWJ1eWVyAAAAAAAAEwAAAAEAAAPpAAAH0AAAAA1BbmNob3JGYWlsdXJlAAAAAAAAAw==",
        "AAAAAAAAAFJGZXRjaCB0aGUgY3VycmVudCBsaWZlY3ljbGUgc3RhdGUgb2YgYSByZXNvdXJjZS4gRXJyb3JzIHdpdGggYE5vdEZvdW5kYCBpZiBhYnNlbnQuAAAAAAASZ2V0X3Jlc291cmNlX3N0YXRlAAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAH0AAAAA1SZXNvdXJjZVN0YXRlAAAAAAAAAw==",
        "AAAAAAAAAMhTdG9yZSB0aGUgaW50ZW5kZWQgbmV0d29yayBpZGVudGlmaWVyIG9uY2UuIFRoZSBzdXBwbGllZCBJRCBtdXN0IG1hdGNoCnRoZSBsZWRnZXIgdGhpcyBjb250cmFjdCBpcyBleGVjdXRpbmcgb24sIHByZXZlbnRpbmcgYSBkZXBsb3ltZW50CnNjcmlwdCBmcm9tIGFjY2lkZW50YWxseSByZWNvcmRpbmcgYSBkaWZmZXJlbnQgU3RlbGxhciBuZXR3b3JrLgAAABJpbml0aWFsaXplX25ldHdvcmsAAAAAAAEAAAAAAAAACm5ldHdvcmtfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAKxOb21pbmF0ZSBhIG5ldyBjb250cmFjdCBhZG1pbi4gT25seSB0aGUgY3VycmVudCBhZG1pbiBtYXkgY2FsbCB0aGlzLgpTZXRzIGBwZW5kaW5nX2FkbWluYC4gVGhlIG5vbWluYXRpb24gZG9lcyBub3QgdGFrZSBlZmZlY3QgdW50aWwKdGhlIHBlbmRpbmcgYWRtaW4gY2FsbHMgYGFjY2VwdF9hZG1pbmAuAAAAEm5vbWluYXRlX25ld19hZG1pbgAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAYtSZWdpc3RlciBhIG5ldyByZXNvdXJjZSB0b2dldGhlciB3aXRoIGFuIGltbXV0YWJsZSBkaWdlc3Qgb2YgaXRzCm9mZi1jaGFpbiBjb250ZW50LiBTdXBwbHlpbmcgYSBoYXNoIGJpbmRzIHRoZSBtZXRhZGF0YSBwb2ludGVyIHRvIHRoaXMKcmVnaXN0cmF0aW9uOiBgdXBkYXRlX21ldGFkYXRhYCBjYW5ub3QgY2hhbmdlIGl0IGFmdGVyd2FyZC4gUGFzc2luZwpgTm9uZWAgcHJlc2VydmVzIHRoZSBtdXRhYmxlIG1ldGFkYXRhIGJlaGF2aW9yIG9mIGByZWdpc3RlcmAuCgpSZWplY3RzIGFuIGVtcHR5IGhhc2ggb3Igb25lIGxvbmdlciB0aGFuIGBNQVhfQ09OVEVOVF9IQVNIX0xFTmAKKGBDb250ZW50SGFzaFRvb0xvbmdgKS4gQWxsIG90aGVyIHZhbGlkYXRpb24gbWF0Y2hlcyBgcmVnaXN0ZXJgLgAAAAAScmVnaXN0ZXJfd2l0aF9oYXNoAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAACG1ldGFkYXRhAAAAEAAAAAAAAAAEdGFncwAAA+oAAAAQAAAAAAAAAAxjb250ZW50X2hhc2gAAAPoAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAcpSZWdpc3RlciBhIG5ldyByZXNvdXJjZSB0b2dldGhlciB3aXRoIGFuIG9wdGlvbmFsIGNvbnRlbnQgaGFzaCBhbmQgYW4Kb3B0aW9uYWwgMzItYnl0ZSBtZW1vIGhhc2guIFRoZSBtZW1vIGhhc2ggaXMgdGhlIHJlZ2lzdHJhdGlvbidzIGxpbmsgdG8KYW4gb2ZmLWNoYWluIHJlY29yZCAodHlwaWNhbGx5IHRoZSBgTUVNT19IQVNIYCBvZiB0aGUgU3RlbGxhcgp0cmFuc2FjdGlvbiB0aGF0IGFubm91bmNlZCBvciBwYWlkIGZvciBpdCkgYW5kIGlzIHdyaXR0ZW4gb25jZSBhdApyZWdpc3RyYXRpb247IG5vdGhpbmcgY2FuIGNoYW5nZSBpdCBhZnRlcndhcmRzLiBSZWFkIGl0IGJhY2sgd2l0aApgZ2V0X21lbW9faGFzaGAuIFdoZW4gcHJlc2VudCBpdCBpcyBhbHNvIGVtaXR0ZWQgaW4gYSBgcmVnbWVtb2AgZXZlbnQuCgpBbGwgb3RoZXIgdmFsaWRhdGlvbiBtYXRjaGVzIGByZWdpc3Rlcl93aXRoX2hhc2hgLgAAAAAAEnJlZ2lzdGVyX3dpdGhfbWVtbwAAAAAABwAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAhtZXRhZGF0YQAAABAAAAAAAAAABHRhZ3MAAAPqAAAAEAAAAAAAAAAMY29udGVudF9oYXNoAAAD6AAAABAAAAAAAAAACW1lbW9faGFzaAAAAAAAA+gAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAJVTZXQgb3IgY2xlYXIgdGhlIHJlY292ZXJ5IGFkbWluLiBPbmx5IHRoZSBjdXJyZW50IGFkbWluIG1heSBjYWxsIHRoaXM7CnRoZSByZWNvdmVyeSBhZG1pbiBtdXN0IGRpZmZlciBmcm9tIHRoZSBhZG1pbiAoYFNhbWVBZG1pbmApLiBFbWl0cwpgc2V0cmVjb3ZgLgAAAAAAABJzZXRfcmVjb3ZlcnlfYWRtaW4AAAAAAAEAAAAAAAAADnJlY292ZXJ5X2FkbWluAAAAAAPoAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAk9QZXJtYW5lbnRseSByZXRpcmUgYSByZXNvdXJjZS4gT25seSBhbiBhZG1pbiBtYXkgdG9tYnN0b25lIGl0OyB0aGUKdG9tYnN0b25lZCBzdGF0ZSBoYXMgbm8gb3V0Z29pbmcgdHJhbnNpdGlvbnMuCgpUb21ic3RvbmluZyBwdXJnZXMgdGhlIHJlc291cmNlIGZyb20gZXZlcnkgZGVyaXZlZCBsaXN0aW5nIGluZGV4IHRoZQpjb250cmFjdCBjYW4gcmVhY2ggaW4gYm91bmRlZCBnYXMg4oCUIHRoZSB0YWcgaW5kZXggYW5kIHRoZSBjcmVhdG9yCmluZGV4IOKAlCBzbyBpdCBzdG9wcyBzdXJmYWNpbmcgaW4gYGxpc3RfYnlfdGFnYCwgYGxpc3RfYnlfY3JlYXRvcmAsIGFuZApgY3JlYXRvcl9yZXNvdXJjZV9jb3VudGAuIFRoZSBjYW5vbmljYWwgYFJlc291cmNlYCBlbnRyeSBpcyBsZWZ0IGluCnBsYWNlIGFuZCBzdGF5cyByZWFkYWJsZSB0aHJvdWdoIGBnZXRgIGZvciBhdWRpdCwgYW5kIHRoZSBnbG9iYWwKYEluZGV4YC9gQ291bnRgIHBhaXIgaXMgZGVsaWJlcmF0ZWx5IHVudG91Y2hlZDogYENvdW50YCBpcyBtb25vdG9uaWMKYW5kIGZpbmRpbmcgYSByZXNvdXJjZSdzIHNsb3QgaW4gaXQgd291bGQgY29zdCBhbiB1bmJvdW5kZWQgc2Nhbi4AAAAAEnRvbWJzdG9uZV9yZXNvdXJjZQAAAAAAAgAAAAAAAAACaWQAAAAAABAAAAAAAAAABWFkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAACtJbnB1dCBmb3Igb25lIGl0ZW0gaW4gYSBiYXRjaCBwcmljZSB1cGRhdGUuAAAAAAAAAAAQQmF0Y2hQcmljZVVwZGF0ZQAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAluZXdfcHJpY2UAAAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAAEEZlZUNvbmZpZ1VwZGF0ZWQAAAACAAAAAAAAAApuZXdfY29uZmlnAAAAAAfQAAAACUZlZUNvbmZpZwAAAAAAAAAAAAAKb2xkX2NvbmZpZwAAAAAH0AAAAAxPcHRGZWVDb25maWc=",
        "AAAAAQAAALVSZWR1bmRhbnQgbWV0YWRhdGEgcG9pbnRlcnMgZm9yIGEgcmVzb3VyY2UsIHNvIGl0cyBjb250ZW50IHN1cnZpdmVzIGEKc2luZ2xlIHN0b3JhZ2Ugb3V0YWdlLiBgcG9pbnRlcnNbcHJpbWFyeV1gIGlzIHRoZSBwcmVmZXJyZWQgcG9pbnRlciBhbmQgaXMKYWx3YXlzIGVxdWFsIHRvIGBSZXNvdXJjZS5tZXRhZGF0YWAuAAAAAAAAAAAAABBNZXRhZGF0YVBvaW50ZXJzAAAAAgAAAAAAAAAIcG9pbnRlcnMAAAPqAAAAEAAAAAAAAAAHcHJpbWFyeQAAAAAE",
        "AAAAAQAAAAAAAAAAAAAAEFZlcmlmaWVyUm90YXRpb24AAAADAAAAAAAAAAZsZWRnZXIAAAAAAAQAAAAAAAAADG5ld192ZXJpZmllcgAAABMAAAAAAAAADG9sZF92ZXJpZmllcgAAABM=",
        "AAAAAAAAALBFeHRlbmQgdGhlIFRUTCBvZiBhIHJlc291cmNlJ3MgcGVyc2lzdGVudCBzdG9yYWdlIGVudHJ5LgoKT25seSB0aGUgcmVzb3VyY2UncyBjdXJyZW50IGNyZWF0b3IgKG93bmVyKSBtYXkgY2FsbCB0aGlzLgpFbWl0cyBhIGAidHRsZXh0ImAgZXZlbnQgd2l0aCB0aGUgYHJlc291cmNlX2lkYCBhcyBwYXlsb2FkLgAAABNleHRlbmRfcmVzb3VyY2VfdHRsAAAAAAIAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAO1SZWplY3RlZCBgYXR0ZW1wdF9hbmNob3JfcHVyY2hhc2VfcmVjZWlwdGAgYm9va2tlZXBpbmcgZm9yIGEgcGFpcjoKaG93IG1hbnkgYXR0ZW1wdHMgaGF2ZSBiZWVuIHJlamVjdGVkIGFuZCBhdCB3aGljaCBsZWRnZXIgdGhlIGxhc3Qgb25lCndhcy4gQm90aCBmaWVsZHMgYXJlIGAwYCB3aGVuIHRoZSBwYWlyIGhhcyBuZXZlciBiZWVuIHJlamVjdGVkIG9yIGl0cwphbmNob3IgaGFzIHNpbmNlIGJlZW4gd3JpdHRlbi4AAAAAAAATZ2V0X2FuY2hvcl9hdHRlbXB0cwAAAAACAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVidXllcgAAAAAAABMAAAABAAAD6QAAB9AAAAAOQW5jaG9yQXR0ZW1wdHMAAAAAAAM=",
        "AAAAAAAAAAAAAAATZ2V0X2ZlZV9kZXN0aW5hdGlvbgAAAAAAAAAAAQAAB9AAAAAURmVlRGVzdGluYXRpb25Db25maWc=",
        "AAAAAAAAAQVGZXRjaCB0aGUgbW9zdCByZWNlbnQgcGF5bWVudCByZWNlaXB0IHJlY29yZGVkIGZvcgpgKHJlc291cmNlX2lkLCBwYXllcilgLCByZXNvbHZlZCB0aHJvdWdoIHRoZSBgUGF5bWVudEluZGV4YCBzZWNvbmRhcnkKaW5kZXguIEVycm9ycyBgTm90Rm91bmRgIHdoZW4gdGhhdCBwYWlyIGhhcyBubyByZWNvcmRlZCBwYXltZW50LgpCdW1wcyB0aGUgVFRMIG9mIGJvdGggdGhlIGluZGV4IGVudHJ5IGFuZCB0aGUgcmVjZWlwdCBvbiBhIHN1Y2Nlc3NmdWwKcmVhZC4AAAAAAAATZ2V0X3BheW1lbnRfcmVjZWlwdAAAAAACAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVwYXllcgAAAAAAABMAAAABAAAD6QAAB9AAAAAOUGF5bWVudFJlY2VpcHQAAAAAAAM=",
        "AAAAAAAAADhUb3RhbCBhbW91bnQgcmVjb3JkZWQgYXMgcmVmdW5kZWQgZm9yIGEgcGF5bWVudCByZWNlaXB0LgAAABNnZXRfcmVmdW5kZWRfYW1vdW50AAAAAAEAAAAAAAAAEnBheW1lbnRfcmVjZWlwdF9pZAAAAAAAEAAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAENFeGNsdXNpdmUgbGVkZ2VyIGRlYWRsaW5lIGZvciBjcmVhdG9yIHJlZnVuZHMgb2YgYSBzZXR0bGVkIHBheW1lbnQuAAAAABNnZXRfcmVmdW5kX2RlYWRsaW5lAAAAAAEAAAAAAAAAEnBheW1lbnRfcmVjZWlwdF9pZAAAAAAAEAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAIRSZXR1cm4gbGlmZWN5Y2xlIHN0YXRlcyBmb3IgdXAgdG8gYE1BWF9CQVRDSF9SRVNPVVJDRV9TVEFURVNgIGlkcy4KUmVzdWx0cyBwcmVzZXJ2ZSBpbnB1dCBvcmRlcjsgaWRzIHdpdGggbm8gcmVzb3VyY2UgcmV0dXJuIGBOb25lYC4AAAATZ2V0X3Jlc291cmNlX3N0YXRlcwAAAAABAAAAAAAAAANpZHMAAAAD6gAAABAAAAABAAAD6QAAA+oAAAPoAAAH0AAAAA1SZXNvdXJjZVN0YXRlAAAAAAAAAw==",
        "AAAAAAAABABSZWFjdGl2YXRlIGEgcmVzb3VyY2UgdGhhdCB3YXMgcmVzb2x2ZWQgb3V0IG9mIGEgZGlzcHV0ZSAob3Igb3RoZXJ3aXNlCmxlZnQgaW5hY3RpdmUpIGJhY2sgdG8gdGhlIHB1YmxpYyBgTGlzdGVkYCBzdGF0ZS4gT25seSB0aGUgY3JlYXRvciBtYXkKY2FsbCB0aGlzLCBhbmQgb25seSB3aGlsZSB0aGUgcmVzb3VyY2UgaXMgYEZyb3plbmAgb3IgYERlbGlzdGVkYC4KCmBEaXNwdXRlZGAgcmVzb3VyY2VzIGhhdmUgbm8gY3JlYXRvciBleGl0OiBhbiBhZG1pbiBtdXN0IHJlc29sdmUgdGhlCmRpc3B1dGUgZmlyc3QsIGFuZCBgVG9tYnN0b25lZGAgcmVzb3VyY2VzIGFyZSB0ZXJtaW5hbCDigJQgcmVhY3RpdmF0aW9uCmZyb20gZWl0aGVyIGZhaWxzIHdpdGggYEludmFsaWRMaWZlY3ljbGVUcmFuc2l0aW9uYC4KClJlY29uY2lsaWF0aW9uIHJ1bGUgZm9yIGFuIGFjdGl2ZSBtb2RlcmF0b3IgZGlzcHV0ZSBmbGFnOiBhIHJlc291cmNlCndob3NlIGBkaXNwdXRlX2ZsYWdgIGlzIHNldCBpcyBtaWQtbW9kZXJhdG9yLWRpc3B1dGUsIGFuZCByZWxpc3RpbmcgaXQKYXMgYExpc3RlZGAgd291bGQgYmUgYW1iaWd1b3VzLiBUaGUgY3JlYXRvciBjYW5ub3QgY2xlYXIgdGhlIGZsYWcgYnkKcmVhY3RpdmF0aW5nIOKAlCBhIG1vZGVyYXRvciBtdXN0IGNhbGwgYHVuZmxhZ19yZXNvdXJjZWAgZmlyc3QsIGFmdGVyCndoaWNoIHJlYWN0aXZhdGlvbiBzdWNjZWVkcyBhcyBub3JtYWwuIFVudGlsIHRoZW4gdGhlIGNhbGwgZmFpbHMgd2l0aApgSW52YWxpZExpZmVjeWNsZVRyYW5zaXRpb25gLgoKTWlycm9ycyBgc2V0X2xpc3RlZChpZCwgdHJ1ZSlgIGZvciB0aGUgYERlbGlzdGVkYCBjYXNlIGJ1dCBpcyB0aGUgb25seQpjcmVhdG9yIHBhdGggb3V0IG9mIGBGcm96ZW5gLCBhbmQgYWx3YXlzIGZsaXBzIHRoZSBgbGlzdGVkYCBwcm9qZWN0aW9uCmFuZCBsaXN0ZWQtY291bnQgaW5kZXggYmFjayB0byBhY3RpdmUuCgpFbWl0cyBhIGByZWFjdGl2ZWAgZXZlbnQgd2hvc2UgdG9waWMgY2FycmllcyB0aGUgcmVzb3VyY2UgAAAAE3JlYWN0aXZhdGVfcmVzb3VyY2UAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAIdSZWNvcmQgYSByZWZ1bmQgdW5kZXIgdGhlIGFkbWluIG92ZXJyaWRlIHBhdGguIFRoaXMgYnlwYXNzZXMgdGhlCmNyZWF0b3Igc2lnbmF0dXJlIGFuZCByZWZ1bmQgZGVhZGxpbmUsIGJ1dCBub3QgcGF5ZXIgb3IgYW1vdW50IGNoZWNrcy4AAAAAE3JlY29yZF9hZG1pbl9yZWZ1bmQAAAAABgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAlyZWZ1bmRfaWQAAAAAAAAQAAAAAAAAABJwYXltZW50X3JlY2VpcHRfaWQAAAAAABAAAAAAAAAACXJlY2lwaWVudAAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAHdHhfaGFzaAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAAAAAAATc2V0X2ZlZV9kZXN0aW5hdGlvbgAAAAABAAAAAAAAAAZjb25maWcAAAAAB9AAAAAURmVlRGVzdGluYXRpb25Db25maWcAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAADRJbnB1dCBmb3IgYSBzaW5nbGUgcmVzb3VyY2UgaW4gYSBiYXRjaCByZWdpc3RyYXRpb24uAAAAAAAAABFCYXRjaFJlZ2lzdGVySXRlbQAAAAAAAAUAAAAAAAAADGNvbnRlbnRfaGFzaAAAA+gAAAAQAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAIbWV0YWRhdGEAAAAQAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAABHRhZ3MAAAPqAAAAEA==",
        "AAAAAAAAAXpPcHRpb25hbCBkdWFsLWtleSBib290c3RyYXA6IHNldCBgYWRtaW5gIGFuZCBhIHNlcGFyYXRlCmByZWNvdmVyeV9hZG1pbmAgaW4gb25lIGNhbGwsIHNvIHRoZSBkZXBsb3ltZW50IGNhbiByZWNvdmVyIHZpYQpgcmVjb3Zlcl9hZG1pbmAgaWYgdGhlIHNvbGUgYWRtaW4ga2V5IGlzIGxvc3QuIEJvdGggYWRkcmVzc2VzIG11c3QKYXV0aG9yaXplIGFuZCBtdXN0IGRpZmZlciAoYFNhbWVBZG1pbmApLiBPbmx5IHZhbGlkIGJlZm9yZSBhbnkgYWRtaW4gaXMKc2V0IChgQWxyZWFkeVJlZ2lzdGVyZWRgKTsgYG5vbWluYXRlX25ld19hZG1pbmAgcmVtYWlucyB0aGUgc2luZ2xlLWtleQpib290c3RyYXAgcGF0aC4gRW1pdHMgYHNldGFkbWluYCBhbmQgYHNldHJlY292YC4AAAAAABRib290c3RyYXBfZHVhbF9hZG1pbgAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAOcmVjb3ZlcnlfYWRtaW4AAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAP9OdW1iZXIgb2YgcmVzb3VyY2VzIG93bmVkIGJ5IGBjcmVhdG9yYCB0aGF0IGFyZSBjdXJyZW50bHkgaW4gdGhlCmBMaXN0ZWRgIHN0YXRlLiBUaGUgcGVyLWNyZWF0b3IgY291bnRlcnBhcnQgb2YgYGxpc3RlZF9jb3VudGA6IGl0CmZvbGxvd3MgZXZlcnkgbGlzdGVkLXN0YXRlIHRyYW5zaXRpb24gKGRlbGlzdCwgZnJlZXplLCBkaXNwdXRlLApyZWFjdGl2YXRlLCB0b21ic3RvbmUpIGFuZCBtb3ZlcyBiZXR3ZWVuIG93bmVycyBvbiB0cmFuc2Zlci4AAAAAFGNyZWF0b3JfbGlzdGVkX2NvdW50AAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAQ=",
        "AAAAAAAAAGtSZWFkIHRoZSBvZmYtY2hhaW4gYXR0ZXN0YXRpb24gaGFzaCBmb3IgYSByZXNvdXJjZSwgaWYgb25lIGhhcyBiZWVuIHJlY29yZGVkCnZpYSBgc2V0X3ZlcmlmaWNhdGlvbl9zdGF0dXNgLgAAAAAUZ2V0X2F0dGVzdGF0aW9uX2hhc2gAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPoAAAAEA==",
        "AAAAAAAAAGtGZXRjaCB0aGUgbW9kZXJhdG9yIGRpc3B1dGUgcmVhc29uIGhhc2ggc3RvcmVkIGZvciBhIHJlc291cmNlLgpFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIG5vbmUgaGFzIGJlZW4gc2V0LgAAAAAUZ2V0X2ZsYWdfcmVhc29uX2hhc2gAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAAEAAAAAM=",
        "AAAAAAAAADtGZXRjaCBhIHB1cmNoYXNlIHJlY2VpcHQgYW5jaG9yIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgLgAAAAAUZ2V0X3B1cmNoYXNlX3JlY2VpcHQAAAACAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVidXllcgAAAAAAABMAAAABAAAD6QAAB9AAAAAVUHVyY2hhc2VSZWNlaXB0QW5jaG9yAAAAAAAAAw==",
        "AAAAAAAAASZgbGlzdF9ieV9jcmVhdG9yYCB3aXRoIGFuIGlkLWJhc2VkIGN1cnNvci4gUGFzcyBgSWRDdXJzb3I6OlN0YXJ0YCBmb3IKdGhlIGZpcnN0IHBhZ2UgYW5kIHRoZSByZXR1cm5lZCBgbmV4dF9jdXJzb3JgIGZvciBlYWNoIGZvbGxvd2luZyBwYWdlOwpgSWRDdXJzb3I6OkVuZGAgYmFjayBtZWFucyBlbmQtb2YtbGlzdC4gU2VlIFtgSWRDdXJzb3JgXSBmb3IgaG93IHRoZQpjdXJzb3Igc3Vydml2ZXMgdG9tYnN0b25lcyBhbmQgdHJhbnNmZXJzIHRoYXQgcmVtb3ZlIGVudHJpZXMgZnJvbSB0aGUKY3JlYXRvciBpbmRleC4AAAAAABRsaXN0X2J5X2NyZWF0b3JfcGFnZQAAAAMAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAGY3Vyc29yAAAAAAfQAAAACElkQ3Vyc29yAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAH0AAAAAZJZFBhZ2UAAA==",
        "AAAAAAAAAJVSZXR1cm4gdGhlIGxlZGdlciBzZXF1ZW5jZSBhdCB3aGljaCB0aGUgcGVuZGluZyBhZG1pbiBub21pbmF0aW9uIGV4cGlyZXMuCkJ1bXBzIHRoZSBpbnN0YW5jZSBzdG9yYWdlIFRUTCB0byBrZWVwIHRoZSBlbnRyeSBhbGl2ZSBmb3IgYWN0aXZlIG1vbml0b3JzLgAAAAAAABRwZW5kaW5nX2FkbWluX2V4cGlyeQAAAAAAAAABAAAD6AAAAAQ=",
        "AAAAAAAABABCb3VuZGVkIGRpc2NvdmVyeSByZWFkIGZvciB0aGUgcmVzb3VyY2VzIHRoYXQgY2FycnkgYSB0YWcgc2hhcmluZyBhCm5vcm1hbGl6ZWQgcHJlZml4LgoKVGhpcyBjb21wbGVtZW50cyBbYGxpc3RfYnlfdGFnYF0sIHdoaWNoIG9ubHkgcmVzb2x2ZXMgb25lIGV4YWN0IHRhZy4KVGhlIHByZWZpeCBpcyBub3JtYWxpemVkIHdpdGggZXhhY3RseSB0aGUgc2FtZSBydWxlcyB0YWdzIGFyZSBzdG9yZWQKd2l0aCAoW2BTZWxmOjpub3JtYWxpemVfdGFnYF06IHRyaW0gQVNDSUkgd2hpdGVzcGFjZSwgbG93ZXJjYXNlIEFTQ0lJCmxldHRlcnMpLCBzbyBgIiAgREFUQSAiYCByZXNvbHZlcyB0aGUgc2FtZSB3YXkgYXMgYCJkYXRhImAuCgotIEEgcHJlZml4IHRoYXQgbm9ybWFsaXplcyB0byB0aGUgZW1wdHkgc3RyaW5nIHdvdWxkIG1hdGNoIGV2ZXJ5IHRhZwppbiB0aGUgY2F0YWxvZywgc28gaXQgaXMgcmVqZWN0ZWQgYnkgcmV0dXJuaW5nIGFuIGVtcHR5IHBhZ2UuCi0gYGN1cnNvcmAgaXMgYSBnbG9iYWwgY2F0YWxvZyBpbmRleCDigJQgdGhlIHNhbWUgZG9tYWluIGFzIGBsaXN0X3BhZ2VgCmFuZCBgbGlzdF9saXN0ZWRfcGFnZWAuIEl0IHBvaW50cyBhdCB0aGUgZmlyc3QgY2F0YWxvZyBlbnRyeSB0aGF0CmhhcyBub3QgYmVlbiBzY2FubmVkIHlldCwgc28gYSBwYWdlIHRoYXQgbWF0Y2hlZCBub3RoaW5nIHN0aWxsCmFkdmFuY2VzIGFuZCBhIGxhdGVyIHBhZ2UgY2Fubm90IHJlcGVhdCBhbiBlbnRyeS4KLSBgbGltaXRgIGlzIHRoZSBtYXhpbXVtIG51bWJlciBvZiByZXNvdXJjZXMgdGhlIHBhZ2UgcmV0dXJucy4gSXQgaXMKY2xhbXBlZCB0byBgMS4uPVtgTElTVF9QQUdFX0NBUGBdICgyMCk6IGEgYGxpbWl0YCBvZiBgMGAgc3RpbGwKcmV0dXJucyBvbmUgbWF0Y2ggc28gdGhlIHNjYW4gYWx3YXlzIG1ha2VzIHByb2dyZXNzIGFuZCBhIGNsaWVudApmb2xsb3dpbmcgdGhlIGN1cnNvciBjYW4gbmV2ZXIgYmUgc3R1Y2sgb24gdGhlIHNhbWUgc2xvdC4KLSBSZXN1bHRzIGFyZSBvcmRlcmVkIGJ5IGdsb2JhAAAAFHNlYXJjaF9ieV90YWdfcHJlZml4AAAAAwAAAAAAAAAGcHJlZml4AAAAAAAQAAAAAAAAAAZjdXJzb3IAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAfQAAAAC0NhdGFsb2dQYWdlAA==",
        "AAAAAAAAA7tTdG9yZSBhIGhhc2ggb2YgYSBtb2RlcmF0b3IncyBvZmYtY2hhaW4gZGlzcHV0ZSByZWFzb24gd3JpdGV1cCBmb3IgYQpyZXNvdXJjZS4gT25seSBhbiBhZGRyZXNzIGN1cnJlbnRseSBob2xkaW5nIHRoZSBtb2RlcmF0b3Igcm9sZSAoc2VlCmBhZGRfbW9kZXJhdG9yYCkgbWF5IGNhbGwgdGhpcy4KCkluZGVwZW5kZW50IG9mIGBmbGFnX3Jlc291cmNlYCdzIGBGbGFnUmVhc29uYCBjb2RlOiB0aGF0J3MgYSBmaXhlZCwKc21hbGwgZW51bTsgdGhpcyBjYXJyaWVzIGEgZGlnZXN0IG9mIGZyZWUtZm9ybSBvZmYtY2hhaW4gZGV0YWlsIChhCmxvbmdlciB3cml0ZXVwLCBldmlkZW5jZSBsaW5rcywgZXRjLiksIHRoZSBzYW1lIHBhdHRlcm4gYXMKYHNldF90ZXJtc19oYXNoYC4gQ2FsbGluZyB0aGlzIGFnYWluIGZvciB0aGUgc2FtZSByZXNvdXJjZSByZXBsYWNlcwp0aGUgc3RvcmVkIGhhc2guIERvZXMgbm90IHJlcXVpcmUgdGhlIHJlc291cmNlIHRvIGN1cnJlbnRseSBiZQpmbGFnZ2VkLCBzaW5jZSBhIG1vZGVyYXRvciBtYXkgd2FudCB0byBhdHRhY2ggZGV0YWlsIGJlZm9yZSBvciBhZnRlcgpjYWxsaW5nIGBmbGFnX3Jlc291cmNlYC4KCkVtaXRzIGEgYGZsYWdyc25gIGV2ZW50IHdpdGggYChtb2RlcmF0b3IsIHJlYXNvbl9oYXNoKWAuCgpFcnJvcnMgZGV0ZXJtaW5pc3RpY2FsbHk6Ci0gW2BFcnJvcjo6VW5hdXRob3JpemVkYF0g4oCUIGNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSBtb2RlcmF0b3Igcm9sZQotIFtgRXJyb3I6OkludmFsaWRSZXNvdXJjZUlkYF0g4oCUIGBpZGAgZmFpbHMgZm9ybWF0IHZhbGlkYXRpb24KLSBbYEVycm9yOjpOb3RGb3VuZGBdIOKAlCBgaWRgIGlzIG5vdCBhIHJlZ2lzdGVyZWQgcmVzb3VyY2UKLSBbYEVycm9yOjpGbGFnUmVhc29uSGFzaFRvb0xvbmdgXSDigJQgYHJlYXNvbl9oYXNoYCBleGNlZWRzIGBNQVhfRkxBR19SRUFTT05fSEFTSF9MRU5gAAAAABRzZXRfZmxhZ19yZWFzb25faGFzaAAAAAMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAAAAAAtyZWFzb25faGFzaAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAzFVcGRhdGUgdGhlIG1ldGFkYXRhIHBvaW50ZXIgZm9yIGEgc21hbGwgYm91bmRlZCBzZXQgb2Ygb3duZWQgcmVzb3VyY2VzCmluIG9uZSB0cmFuc2FjdGlvbi4gVGhlIGJhdGNoIGlzIGNhcHBlZCBhdApbYE1BWF9CQVRDSF9NRVRBREFUQV9VUERBVEVTYF0gaXRlbXMuCgpGYWlsdXJlIGJlaGF2aW9yIGlzICoqYXRvbWljKio6IGV2ZXJ5IGl0ZW0gaXMgdmFsaWRhdGVkIChpZCBmb3JtYXQsCm93bmVyc2hpcCwgbWV0YWRhdGEtZnJlZXplIC8gY29udGVudC1oYXNoIHJ1bGVzLCBwb2ludGVyIHZhbGlkaXR5KQpiZWZvcmUgYW55IHdyaXRlLiBJZiBhbnkgaXRlbSBmYWlscyB2YWxpZGF0aW9uIHRoZSB3aG9sZSBjYWxsIGVycm9ycwphbmQgbm8gcmVzb3VyY2UgcmVjb3JkcywgcG9pbnRlcnMsIG9yIGV2ZW50cyBjaGFuZ2UuIFdoZW4gZXZlcnkgaXRlbQpwYXNzZXMsIGVhY2ggcmVzb3VyY2UgaXMgd3JpdHRlbiBhbmQgZW1pdHMgaXRzIG93biBgdXBkbWV0YWAgZXZlbnQg4oCUCnRoZSBwZXItaXRlbSByZXN1bHRzIGFuIGluZGV4ZXIgbmVlZHMg4oCUIHVuZGVyIGEgc2luZ2xlIGNyZWF0b3IKYXV0aG9yaXphdGlvbi4KCkZyZWV6ZSBpbnZhcmlhbnQ6IGEgZnJvemVuIHJlc291cmNlIChgZnJlZXplX21ldGFkYXRhYCwgb3IgcmVnaXN0ZXJlZAp3aXRoIGEgY29udGVudCBoYXNoKSByZWplY3RzIGFueSBkaXZlcmdlbnQgcG9pbnRlciB3aXRoCmBNZXRhZGF0YUZyb3plbmAsIGV4YWN0bHkgYXMgYHVwZGF0ZV9tZXRhZGF0YWAgZG9lcy4gTm8tb3AgaXRlbXMgd2hvc2UKcG9pbnRlciBpcyB1bmNoYW5nZWQgYXJlIHNraXBwZWQgc2lsZW50bHkuAAAAAAAAFHVwZGF0ZV9tZXRhZGF0YV9tYW55AAAAAgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAd1cGRhdGVzAAAAA+oAAAfQAAAAE0JhdGNoTWV0YWRhdGFVcGRhdGUAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAgAAAIpPbi1jaGFpbiBtaXJyb3Igb2YgdGhlIHNlcnZlcidzIG9mZi1jaGFpbiB2ZXJpZmljYXRpb24gcmVzdWx0LiBTZXR0YWJsZQpvbmx5IGJ5IGFuIGFkZHJlc3MgaG9sZGluZyB0aGUgdmVyaWZpZXIgcm9sZSAoc2VlIGBhZGRfdmVyaWZpZXJgKS4AAAAAAAAAAAASVmVyaWZpY2F0aW9uU3RhdHVzAAAAAAADAAAAAAAAAAAAAAAHUGVuZGluZwAAAAAAAAAAAAAAAAhWZXJpZmllZAAAAAAAAAAAAAAACFJlamVjdGVk",
        "AAAAAQAAAI1PbmUgcGFnZSBvZiB2ZXJpZmllciBzdGF0dXMgaGlzdG9yeSB3aXRoIGEgY3Vyc29yIGZvciB0aGUgbmV4dCBwYWdlLgpNaXJyb3JzIGBDYXRhbG9nUGFnZWAgc2VtYW50aWNzOiBgbmV4dF9jdXJzb3JgIGlzIGBOb25lYCBhdCBlbmQtb2YtbGlzdC4AAAAAAAAAAAAAElZlcmlmaWVyU3RhdHVzUGFnZQAAAAAAAgAAAAAAAAAFaXRlbXMAAAAAAAPqAAAH0AAAABNWZXJpZmllclN0YXR1c0VudHJ5AAAAAAAAAAALbmV4dF9jdXJzb3IAAAAD6AAAAAQ=",
        "AAAAAAAAAItBbGwgbWV0YWRhdGEgcG9pbnRlcnMgZm9yIGEgcmVzb3VyY2UuIEZhbGxzIGJhY2sgdG8gYSBzaW5nbGUtZW50cnkgbGlzdApob2xkaW5nIGBSZXNvdXJjZS5tZXRhZGF0YWAgKHByaW1hcnkgYDBgKSB3aGVuIG5vIG1pcnJvcnMgd2VyZSBzZXQuAAAAABVnZXRfbWV0YWRhdGFfcG9pbnRlcnMAAAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAH0AAAABBNZXRhZGF0YVBvaW50ZXJzAAAAAw==",
        "AAAAAAAAAwFEdXJhYmx5IHJlY29yZCB0aGF0IGAocmVzb3VyY2VfaWQsIGJ1eWVyKWAgY291bGQgbm90IGJlIGFuY2hvcmVkLCBzbyB0aGUKYnV5ZXIgY2FuIHF1ZXJ5IGl0IHdpdGggW2BnZXRfYW5jaG9yX2ZhaWx1cmVgfS4gT25seSBhIHNldHRsZXIgbWF5IGNhbGwKdGhpczsgc2VlIGBjb250cmFjdC9SRUFETUUubWRgIGZvciB3aHkgdGhlIHNldHRsZXIsIGFuZCBub3QgdGhlIHJldm9rZWQKdmVyaWZpZXIsIGlzIHRoZSBvbmx5IGFjdG9yIHRoYXQgY2FuIHJlcG9ydCB0aGlzICgjNzgxKS4gV2lkZW5pbmcKKnJlcG9ydGluZyogdG8gYSB0cnVzdGVkIHJvbGUgZG9lcyBub3Qgd2Vha2VuIHRoZSBpbnZhcmlhbnQgdGhhdCBhCnJvbGVsZXNzIGFkZHJlc3MgY2Fubm90IHdyaXRlIHRvIHRoZSBsb2cuCgpMYXN0LXdyaXRlLXdpbnMuIElmIGFuIGFuY2hvciBhbHJlYWR5IGV4aXN0cyB0aGUgcmVjb3JkIGlzIGNsZWFyZWQgYW5kCmBPaygoKSlgIHJldHVybmVkLCBzbyBgZ2V0X2FuY2hvcl9mYWlsdXJlYCBjYW4gbmV2ZXIgZGlzYWdyZWUgd2l0aApgZ2V0X3B1cmNoYXNlX3JlY2VpcHRgLiBFbWl0cyBgYW5jaHJmYWlsYCB3aXRoIGByZWFzb25gCltgQW5jaG9yRmFpbHVyZVJlYXNvbjo6VmVyaWZpZXJVbmF2YWlsYWJsZWBdLgpFcnJvcnMgYE5vdFNldHRsZXJgLCBgQ29udHJhY3RQYXVzZWRgLCBgSW52YWxpZFJlc291cmNlSWRgLCBgTm90Rm91bmRgCihubyBzdWNoIHJlc291cmNlKSwgb3IgYEludmFsaWRUeEhhc2hgIChlbXB0eSBvciBvdmVyLWxvbmcgaGFzaCkuAAAAAAAAFXJlY29yZF9hbmNob3JfZmFpbHVyZQAAAAAAAAQAAAAAAAAAB3NldHRsZXIAAAAAEwAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAAAxyZWNlaXB0X2hhc2gAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAL5SZWNvcmQgYSBjb21wbGV0ZWQgY3JlYXRvci1pbml0aWF0ZWQgcmVmdW5kIGZvciBhIHNldHRsZWQgcGF5bWVudC4KVGhlIHRyYW5zZmVyIG11c3QgYWxyZWFkeSBoYXZlIG9jY3VycmVkOyB0aGUgcmVnaXN0cnkgc3RvcmVzIGl0cyBoYXNoCmFzIGFuIGF1ZGl0IGFuY2hvciBhbmQgZG9lcyBub3QgY3VzdG9keSBvciBtb3ZlIFVTREMuAAAAAAAVcmVjb3JkX2NyZWF0b3JfcmVmdW5kAAAAAAAABgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAlyZWZ1bmRfaWQAAAAAAAAQAAAAAAAAABJwYXltZW50X3JlY2VpcHRfaWQAAAAAABAAAAAAAAAACXJlY2lwaWVudAAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAHdHhfaGFzaAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAh1TZXQgdXAgdG8gYE1BWF9NRVRBREFUQV9QT0lOVEVSU2AgcmVkdW5kYW50IG1ldGFkYXRhIHBvaW50ZXJzIChlLmcuCklQRlMgKyBBcndlYXZlICsgaG9zdGVkKSB3aXRoIGBwb2ludGVyc1twcmltYXJ5XWAgYXMgdGhlIHByZWZlcnJlZCBvbmUsCnNvIHRoZSByZXNvdXJjZSBzdXJ2aXZlcyBhIHNpbmdsZSBzdG9yYWdlIG91dGFnZS4gT25seSB0aGUgY3JlYXRvciBtYXkKY2FsbCB0aGlzLiBFdmVyeSBwb2ludGVyIGlzIHZhbGlkYXRlZCBsaWtlIGB1cGRhdGVfbWV0YWRhdGFgLCBhbmQKYFJlc291cmNlLm1ldGFkYXRhYCBpcyBzZXQgdG8gdGhlIHByaW1hcnkgcG9pbnRlciBzbyBzaW5nbGUtcG9pbnRlcgpyZWFkZXJzIGtlZXAgd29ya2luZy4gU3ViamVjdCB0byB0aGUgc2FtZSBmcmVlemUgLyBjb250ZW50LWhhc2ggcnVsZXMKYXMgYHVwZGF0ZV9tZXRhZGF0YWA6IGEgZnJvemVuIHJlc291cmNlIG1heSBvbmx5IHJlLXB1Ymxpc2ggbWlycm9ycwp3aG9zZSBwcmltYXJ5IGVxdWFscyBpdHMgY3VycmVudCBwb2ludGVyLiBFbWl0cyBgc2V0cHRyc2AuAAAAAAAAFXNldF9tZXRhZGF0YV9wb2ludGVycwAAAAAAAAMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAhwb2ludGVycwAAA+oAAAAQAAAAAAAAAAdwcmltYXJ5AAAAAAQAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAUpTZXQgYSBwZXItcmVzb3VyY2Ugcm95YWx0eSByZWNpcGllbnQgb3ZlcnJpZGUuIE9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwKdGhpcy4gV2hlbiBzZXQsIHJveWFsdGllcyBmb3IgdGhpcyByZXNvdXJjZSB3aWxsIGdvIHRvIHRoaXMgYWRkcmVzcyBpbnN0ZWFkCm9mIHRoZSBnbG9iYWwgYGZlZV9yZWNpcGllbnRgIGZyb20gYEZlZUNvbmZpZ2AuIFNldCB0byBgTm9uZWAgdG8gY2xlYXIgdGhlCm92ZXJyaWRlIGFuZCB1c2UgdGhlIGdsb2JhbCByZWNpcGllbnQuCgpFbWl0cyBhIGBzZXRyb3lhbGAgZXZlbnQgd2l0aCB0aGUgb2xkIGFuZCBuZXcgcmVjaXBpZW50IGFkZHJlc3Nlcy4AAAAAABVzZXRfcm95YWx0eV9yZWNpcGllbnQAAAAAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAJcmVjaXBpZW50AAAAAAAD6AAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAwAAAPtXaHkgYW4gYW5jaG9yIGF0dGVtcHQgY291bGQgbm90IHdyaXRlIGFuIGFuY2hvci4KCkRpc2NyaW1pbmFudHMgYXJlIHN0YWJsZSDigJQgZG8gbm90IHJlbnVtYmVyIGV4aXN0aW5nIHZhcmlhbnRzLiBUaGUgZmlyc3QKdGhyZWUgbWFwIDE6MSB0byB0aGUgYEVycm9yYCBgYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHRgIHJldHVybnM7IHRoZSBsYXN0CnRocmVlIGFyZSByZWFjaGFibGUgb25seSB2aWEgdGhlIHNldHRsZXIgZW50cnkgcG9pbnRzLgAAAAAAAAAAE0FuY2hvckZhaWx1cmVSZWFzb24AAAAACAAAAEJObyByZXNvdXJjZSBpcyByZWdpc3RlcmVkIHVuZGVyIGByZXNvdXJjZV9pZGAgKGBFcnJvcjo6Tm90Rm91bmRgKS4AAAAAABBSZXNvdXJjZU5vdEZvdW5kAAAAAAAAAE5gcmVjZWlwdF9oYXNoYCBpcyBlbXB0eSBvciBleGNlZWRzIGBNQVhfVFhfSEFTSF9MRU5gCihgRXJyb3I6OkludmFsaWRUeEhhc2hgKS4AAAAAABJJbnZhbGlkUmVjZWlwdEhhc2gAAAAAAAEAAABQQW4gYW5jaG9yIGFscmVhZHkgZXhpc3RzIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgCihgRXJyb3I6OkR1cGxpY2F0ZVJlY2VpcHRgKS4AAAAQRHVwbGljYXRlUmVjZWlwdAAAAAIAAADkVGhlIHBhaXIgd2FzIHJldHJpZWQgZmV3ZXIgdGhhbiBgQU5DSE9SX1JFVFJZX0JBQ0tPRkZfTEVER0VSU2AgbGVkZ2VycwphZnRlciBpdHMgbGFzdCByZWplY3RlZCBhdHRlbXB0LiBSZXBvcnRlZCB3aXRob3V0IHJlLXJ1bm5pbmcgdGhlIGRhdGEKY2hlY2tzIGFuZCB3aXRob3V0IHdyaXRpbmcgc3RvcmFnZTsgb25seSBgYXR0ZW1wdF9hbmNob3JfcHVyY2hhc2VfcmVjZWlwdGAKcHJvZHVjZXMgaXQuAAAADFJldHJ5VG9vU29vbgAAAAMAAAC8VGhlIHBhaXIgaGFzIGFscmVhZHkgYmVlbiByZWplY3RlZCBgTUFYX0FOQ0hPUl9BVFRFTVBUU2AgdGltZXMuIFJlcG9ydGVkCndpdGhvdXQgcmUtcnVubmluZyB0aGUgZGF0YSBjaGVja3MgYW5kIHdpdGhvdXQgd3JpdGluZyBzdG9yYWdlOyBvbmx5CmBhdHRlbXB0X2FuY2hvcl9wdXJjaGFzZV9yZWNlaXB0YCBwcm9kdWNlcyBpdC4AAAARQXR0ZW1wdHNFeGhhdXN0ZWQAAAAAAAAEAAAAOk5vIHZlcmlmaWVyIGlzIGN1cnJlbnRseSByZWdpc3RlcmVkIHRvIGFuY2hvciB0aGUgcmVjZWlwdC4AAAAAABNWZXJpZmllclVuYXZhaWxhYmxlAAAAAAUAAAA6Tm8gcGF5bWVudCByZWNlaXB0IGlzIHJlY29yZGVkIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgLgAAAAAAEU5vUGF5bWVudFJlY29yZGVkAAAAAAAABgAAAEZUaGUgc3VwcGxpZWQgcmVjZWlwdCBoYXNoIGRvZXMgbm90IG1hdGNoIHRoZSByZWNvcmRlZCBwYXltZW50IHJlY2VpcHQuAAAAAAATUmVjZWlwdEhhc2hNaXNtYXRjaAAAAAAH",
        "AAAAAQAAADZJbnB1dCBmb3Igb25lIGl0ZW0gaW4gYSBiYXRjaCBtZXRhZGF0YS1wb2ludGVyIHVwZGF0ZS4AAAAAAAAAAAATQmF0Y2hNZXRhZGF0YVVwZGF0ZQAAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAIbWV0YWRhdGEAAAAQ",
        "AAAAAQAAAIZSZXN1bHQgb2YgYSBiYXRjaCByZWdpc3RyYXRpb24gYXR0ZW1wdC4gQ29udGFpbnMgc3VjY2Vzc2Z1bGx5IHJlZ2lzdGVyZWQKcmVzb3VyY2UgSURzIGFuZCBhbnkgZXJyb3JzIGVuY291bnRlcmVkICh3aXRoIHRoZWlyIGluZGljZXMpLgAAAAAAAAAAABNCYXRjaFJlZ2lzdGVyUmVzdWx0AAAAAAIAAABTSW5kaWNlcyAoaW50byB0aGUgaW5wdXQgYmF0Y2gpIG9mIGl0ZW1zIHRoYXQgZmFpbGVkLCBwYWlyZWQgd2l0aCB0aGVpciBlcnJvciBjb2Rlcy4AAAAABmZhaWxlZAAAAAAD6gAAA+0AAAACAAAABAAAAAQAAAA6UmVzb3VyY2UgSURzIHRoYXQgd2VyZSBzdWNjZXNzZnVsbHkgcmVnaXN0ZXJlZCAoaW4gb3JkZXIpLgAAAAAACXN1Y2NlZWRlZAAAAAAAA+oAAAAQ",
        "AAAAAQAAAOtFdmVudCBkYXRhIGVtaXR0ZWQgd2hlbiBhIHJlc291cmNlJ3MgbWV0YWRhdGEgcG9pbnRlciBpcyB1cGRhdGVkLgpDYXJyaWVzIHRoZSByZXNvdXJjZSBpZCwgdGhlIHByZXZpb3VzIG1ldGFkYXRhIHBvaW50ZXIsIGFuZCB0aGUgbmV3IG9uZQpzbyB0aGF0IG9mZi1jaGFpbiBpbmRleGVycyBjYW4gYnVpbGQgYSBmdWxsIGF1ZGl0IHRyYWlsIHdpdGhvdXQgcXVlcnlpbmcKaGlzdG9yaWNhbCBsZWRnZXIgc3RhdGUuAAAAAAAAAAATTWV0YWRhdGFVcGRhdGVFdmVudAAAAAAEAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAMbmV3X21ldGFkYXRhAAAAEAAAAAAAAAAMb2xkX21ldGFkYXRhAAAAEAAAADhMaXN0aW5nIHJldmlzaW9uIGFmdGVyIHRoaXMgdXBkYXRlIChzZWUgYGdldF9yZXZpc2lvbmApLgAAAAhyZXZpc2lvbgAAAAQ=",
        "AAAAAQAAAJtBIHNpbmdsZSBlbnRyeSBpbiBhIHZlcmlmaWVyJ3Mgc3RhdHVzLWNoYW5nZSBoaXN0b3J5LCBzdG9yZWQgcGVyIHZlcmlmaWVyLgpXcml0dGVuIGJ5IGBzZXRfdmVyaWZpY2F0aW9uX3N0YXR1c2A7IHJldHVybmVkIGJ5IGBnZXRfdmVyaWZpZXJfc3RhdHVzX2hpc3RvcnlgLgAAAAAAAAAAE1ZlcmlmaWVyU3RhdHVzRW50cnkAAAAABQAAADpBdHRlc3RhdGlvbiBoYXNoIHN1cHBsaWVkIHdpdGggdGhpcyBzdGF0dXMgY2hhbmdlLCBpZiBhbnkuAAAAAAAQYXR0ZXN0YXRpb25faGFzaAAAA+gAAAAQAAAAMkxlZGdlciBzZXF1ZW5jZSBhdCB3aGljaCB0aGlzIGNoYW5nZSB3YXMgcmVjb3JkZWQuAAAAAAAGbGVkZ2VyAAAAAAAEAAAAE05ldyBzdGF0dXMgYXBwbGllZC4AAAAACm5ld19zdGF0dXMAAAAAB9AAAAASVmVyaWZpY2F0aW9uU3RhdHVzAAAAAAAQUHJldmlvdXMgc3RhdHVzLgAAAApvbGRfc3RhdHVzAAAAAAfQAAAAElZlcmlmaWNhdGlvblN0YXR1cwAAAAAAL1RoZSByZXNvdXJjZSB3aG9zZSB2ZXJpZmljYXRpb24gc3RhdHVzIGNoYW5nZWQuAAAAAAtyZXNvdXJjZV9pZAAAAAAQ",
        "AAAAAAAAAJ5OdW1iZXIgb2YgcmVzb3VyY2VzIGN1cnJlbnRseSBvd25lZCBieSBgY3JlYXRvcmAgKG1vdmVzIHdpdGgKYHRyYW5zZmVyX293bmVyc2hpcGAvYGFjY2VwdF90cmFuc2ZlcmA7IHVucmVsYXRlZCB0byB0aGUgbW9ub3RvbmljLApuZXZlci1kZWNyZW1lbnRlZCBgY291bnQoKWApLgAAAAAAFmNyZWF0b3JfcmVzb3VyY2VfY291bnQAAAAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAEAAAAE",
        "AAAAAAAAAQZQYWdpbmF0ZWQgbGlzdCBvZiByZXNvdXJjZXMgZmlsdGVyZWQgYnkgYWN0aXZlIG1vZGVyYXRvciBkaXNwdXRlIGZsYWcuCgpgZmxhZ2dlZCA9IHRydWVgIHJldHVybnMgcmVzb3VyY2VzIHdpdGggYERpc3B1dGVGbGFnOjpGbGFnZ2VkKF8pYDsKYGZsYWdnZWQgPSBmYWxzZWAgcmV0dXJucyByZXNvdXJjZXMgd2l0aCBgRGlzcHV0ZUZsYWc6Ok5vRmxhZ2AuCmBzdGFydGAgaXMgYSBnbG9iYWwgY2F0YWxvZyBjdXJzb3IsIG1hdGNoaW5nIGBsaXN0X2xpc3RlZGAuAAAAAAAWbGlzdF9ieV9kaXNwdXRlX3N0YXR1cwAAAAAAAwAAAAAAAAAHZmxhZ2dlZAAAAAABAAAAAAAAAAVzdGFydAAAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPqAAAH0AAAAAhSZXNvdXJjZQ==",
        "AAAAAQAAAZhTdHJ1Y3R1cmVkIHBheWxvYWQgZW1pdHRlZCBieSBgZW1lcmdlbmN5X2RlbGlzdCgpYC4KCk1vZGVsbGVkIG9uIFtgRmxhZ0V2ZW50YF06IGFuIGBpZGAgZm9yIHRoZSByZXNvdXJjZSwgdGhlIGFjdGluZyBgYWRtaW5gLCBhbmQKdGhlIGNhbGxlcidzIGp1c3RpZmljYXRpb24uIFRoaXMgaXMgd2hhdCBtYWtlcyBhbiBlbWVyZ2VuY3kgZGVsaXN0CmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgY3JlYXRvciBkZWxpc3QgYXQgdGhlIGV2ZW50IGJvdW5kYXJ5IOKAlCBhIGNyZWF0b3IKZGVsaXN0IGVtaXRzIGBzZXRsaXN0ZWRgIGFuZCBub3RoaW5nIGVsc2UsIHNvIGFuIGluZGV4ZXIgdGhhdCBzZWVzIGBlbWRlbGlzdGAKa25vd3MgYW4gYWRtaW4gdG9vayB0aGUgcmVzb3VyY2UgZG93biBhbmQgY2FuIGF0dHJpYnV0ZSBpdC4AAAAAAAAAFEVtZXJnZW5jeURlbGlzdEV2ZW50AAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAGcmVhc29uAAAAAAAQ",
        "AAAAAQAAAAAAAAAAAAAAFEZlZURlc3RpbmF0aW9uQ29uZmlnAAAAAgAAAAAAAAADYnBzAAAAAAQAAAAAAAAAC2Rlc3RpbmF0aW9uAAAAB9AAAAAORmVlRGVzdGluYXRpb24AAA==",
        "AAAAAAAAAPlBbmNob3IgYSBwdXJjaGFzZSByZWNlaXB0IGhhc2ggZm9yIGAocmVzb3VyY2VfaWQsIGJ1eWVyKWAuCgpUaGlzIGlzIGltbXV0YWJsZTogZHVwbGljYXRlIGFuY2hvcnMgZm9yIHRoZSBzYW1lIHBhaXIgZXJyb3Igd2l0aApgRHVwbGljYXRlUmVjZWlwdGAsIHNvIGRvd25zdHJlYW0gc2VydmljZXMgY2FuIHRyZWF0IHRoZSBmaXJzdCBhbmNob3IgYXMKY2Fub25pY2FsLiBUaGUgY2FsbGVyIG11c3QgaG9sZCB0aGUgdmVyaWZpZXIgcm9sZS4AAAAAAAAXYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHQAAAAABAAAAAAAAAAHc2VydmljZQAAAAATAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVidXllcgAAAAAAABMAAAAAAAAADHJlY2VpcHRfaGFzaAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAPdSZXR1cm4gYFJFU09VUkNFX1NDSEVNQV9WRVJTSU9OYCBhcyBhIGJhcmUgYHUzMmAsIHNvIGNsaWVudHMgY2FuIGRvCmZlYXR1cmUgZGV0ZWN0aW9uIChlLmcuICJkb2VzIGBSZXNvdXJjZWAgY2FycnkgYG1ldGFkYXRhX2Zyb3plbl9hdGA/IikKd2l0aCBhIHNpbmdsZSBpbnRlZ2VyIGNvbXBhcmlzb24gaW5zdGVhZCBvZiBkZWNvZGluZwpgY29udHJhY3RfdmVyc2lvbmAgb3IgYHJlZ2lzdHJ5X2luZm9gLiBBbHdheXMgc3VjY2VlZHMuAAAAABdyZXNvdXJjZV9zY2hlbWFfdmVyc2lvbgAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAMhTdG9yZSB0aGUgcmVnaXN0cnktd2lkZSBjYW5vbmljYWwgdGVybXMgaGFzaC4gT25seSB0aGUgYWRtaW4gbWF5IGNhbGwKdGhpcy4gV2hlbiBhIGNyZWF0b3IgaGFzIG5vdCBzdG9yZWQgdGhlaXIgb3duIHRlcm1zLCBgZ2V0X3Rlcm1zX2hhc2hgCnJldHVybnMgdGhpcyB2YWx1ZSBhcyB0aGUgYXV0aG9yaXRhdGl2ZSB2YXVsdCBsaXN0aW5nIHRlcm1zLgAAABdzZXRfcmVnaXN0cnlfdGVybXNfaGFzaAAAAAABAAAAAAAAAAp0ZXJtc19oYXNoAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAVRVcGRhdGUgYSByZXNvdXJjZSdzIG9uLWNoYWluIHZlcmlmaWNhdGlvbiBzdGF0dXMuIE9ubHkgYW4gYWRkcmVzcwpjdXJyZW50bHkgaG9sZGluZyB0aGUgdmVyaWZpZXIgcm9sZSAoc2VlIGBhZGRfdmVyaWZpZXJgKSBtYXkgY2FsbAp0aGlzLiBPbmx5IGBQZW5kaW5nIC0+IFZlcmlmaWVkYCwgYFBlbmRpbmcgLT4gUmVqZWN0ZWRgLApgVmVyaWZpZWQgLT4gUmVqZWN0ZWRgLCBhbmQgYFJlamVjdGVkIC0+IFZlcmlmaWVkYCBhcmUgYWxsb3dlZDsKc2VsZi10cmFuc2l0aW9ucyBhbmQgcmV2ZXJ0aW5nIHRvIGBQZW5kaW5nYCBlcnJvciB3aXRoCmBJbnZhbGlkVmVyaWZpY2F0aW9uVHJhbnNpdGlvbmAuAAAAF3NldF92ZXJpZmljYXRpb25fc3RhdHVzAAAAAAQAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAh2ZXJpZmllcgAAABMAAAAAAAAABnN0YXR1cwAAAAAH0AAAABJWZXJpZmljYXRpb25TdGF0dXMAAAAAAAAAAAAQYXR0ZXN0YXRpb25faGFzaAAAA+gAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAItXaGV0aGVyIHRoZSByZXNvdXJjZSBpcyBjdXJyZW50bHkgaW4gYHN0YXR1c2AgYW5kIGl0cyBzdG9yZWQKYXR0ZXN0YXRpb24gaGFzaCBlcXVhbHMgYGNvbXB1dGVfYXR0ZXN0YXRpb25faGFzaChpZCwgc3RhdHVzLCBkb2N1bWVudF9oYXNoKWAuAAAAABd2ZXJpZnlfYXR0ZXN0YXRpb25faGFzaAAAAAADAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAGc3RhdHVzAAAAAAfQAAAAElZlcmlmaWNhdGlvblN0YXR1cwAAAAAAAAAAAA1kb2N1bWVudF9oYXNoAAAAAAAD7gAAACAAAAABAAAAAQ==",
        "AAAAAQAAAAAAAAAAAAAAFUZlZURlc3RpbmF0aW9uVXBkYXRlZAAAAAAAAAMAAAAAAAAABmxlZGdlcgAAAAAABAAAAAAAAAAPbmV3X2Rlc3RpbmF0aW9uAAAAB9AAAAAURmVlRGVzdGluYXRpb25Db25maWcAAAAAAAAAD29sZF9kZXN0aW5hdGlvbgAAAAfQAAAAFEZlZURlc3RpbmF0aW9uQ29uZmln",
        "AAAAAQAAADZJbW11dGFibGUgb24tY2hhaW4gYW5jaG9yIGZvciBhIHB1cmNoYXNlIHJlY2VpcHQgaGFzaC4AAAAAAAAAAAAVUHVyY2hhc2VSZWNlaXB0QW5jaG9yAAAAAAAABAAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAAAZsZWRnZXIAAAAAAAQAAAAAAAAADHJlY2VpcHRfaGFzaAAAABAAAAAAAAAAC3Jlc291cmNlX2lkAAAAABA=",
        "AAAAAAAAAXJQdXJlIGZ1bmN0aW9uOiByZWNvbXB1dGUgdGhlIGF0dGVzdGF0aW9uIGhhc2ggYSB2ZXJpZmllciBpcyBleHBlY3RlZCB0bwpzdWJtaXQgZm9yIGAoaWQsIHN0YXR1cywgZG9jdW1lbnRfaGFzaClgLCBzbyBvZmYtY2hhaW4gY2xpZW50cyBjYW4KY2hlY2sgaW50ZWdyaXR5IHdpdGhvdXQgdHJ1c3RpbmcgYSB3YWxsZXQgcHJvdmlkZXIuIFJldHVybnMKYHNoYTI1Njo8NjQgbG93ZXJjYXNlIGhleD5gIG92ZXIgdGhlIHByZWltYWdlCmBBVFRFU1RBVElPTl9IQVNIX0RPTUFJTiB8fCB1MzJfYmUobGVuKGlkKSkgfHwgaWQgfHwgdTMyX2JlKHN0YXR1cykgfHwgZG9jdW1lbnRfaGFzaGAuClJlYWRzIG5vIHN0b3JhZ2UgYW5kIHJlcXVpcmVzIG5vIGF1dGguAAAAAAAYY29tcHV0ZV9hdHRlc3RhdGlvbl9oYXNoAAAAAwAAAAAAAAACaWQAAAAAABAAAAAAAAAABnN0YXR1cwAAAAAH0AAAABJWZXJpZmljYXRpb25TdGF0dXMAAAAAAAAAAAANZG9jdW1lbnRfaGFzaAAAAAAAA+4AAAAgAAAAAQAAABA=",
        "AAAAAQAAANdTdHJ1Y3R1cmVkIHBheWxvYWQgZW1pdHRlZCBieSBgdHJhbnNmZXJfb3duZXJzaGlwX3dpdGhfdGVybXNgIChldmVudCB0b3BpYwpgdHhmcnRlcm1zYCkuIEV4dGVuZHMgdGhlIGJhc2ljIGB0cmFuc2ZlcmAgcGF5bG9hZCB3aXRoIHRlcm1zLWhhbmRvZmYKaW5mb3JtYXRpb24gc28gaW5kZXhlcnMgaGF2ZSBhIGZ1bGwgYXRvbWljIHJlY29yZCB3aXRob3V0IGV4dHJhIHJlYWRzLgAAAAAAAAAAFlRyYW5zZmVyV2l0aFRlcm1zRXZlbnQAAAAAAAUAAABCV2hldGhlciB0aGUgYXR0ZXN0YXRpb24gaGFzaCB3YXMgY2xlYXJlZCBhcyBwYXJ0IG9mIHRoaXMgdHJhbnNmZXIuAAAAAAARYXR0ZXN0YXRpb25fcmVzZXQAAAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAJbmV3X293bmVyAAAAAAAAEwAAAAAAAAAOcHJldmlvdXNfb3duZXIAAAAAABMAAABzVGhlIG5ldyB0ZXJtcyBoYXNoIHNldCBvbiB0aGUgaW5jb21pbmcgb3duZXIgYXQgdGhlIHRpbWUgb2YgdHJhbnNmZXIuCmBOb25lYCB3aGVuIG5vIGBuZXdfdGVybXNfaGFzaGAgd2FzIHN1cHBsaWVkLgAAAAAKdGVybXNfaGFzaAAAAAAD6AAAABA=",
        "AAAAAAAAAgRSZXR1cm4gdGhlIHRvdGFsIFVTREMgc3Ryb29wcyBlYXJuZWQgYnkgYGNyZWF0b3JgIGFjcm9zcyBhbGwgc2V0dGxlZApwYXltZW50IHJlY2VpcHRzIGZvciByZXNvdXJjZXMgdGhleSBvd25lZCBhdCBzZXR0bGVtZW50IHRpbWUuIFRoZQplc3RpbWF0ZSBpcyBhIHJ1bm5pbmcgdGFsbHkgdGhhdCBgc2V0dGxlX3BheW1lbnRgIGluY3JlbWVudHMKYXRvbWljYWxseSwgc28gaXQgaXMgYWx3YXlzIGNvbnNpc3RlbnQgd2l0aG91dCByZS1zY2FubmluZyBoaXN0b3J5LgoKUmV0dXJucyBhIFtgQ3JlYXRvckVhcm5pbmdzRXN0aW1hdGVgXSBjYXJyeWluZyB0aGUgY3JlYXRvciBhZGRyZXNzLAp0aGUgdG90YWwgc2V0dGxlZCBhbW91bnQsIGFuZCB0aGUgY291bnQgb2Ygc2V0dGxlZCByZWNlaXB0cyBpbmNsdWRlZC4KCkEgY3JlYXRvciB3aXRoIG5vIHNldHRsZWQgcGF5bWVudHMgcmV0dXJucyBgdG90YWxfc2V0dGxlZCA9IDBgIGFuZApgc2V0dGxlZF9jb3VudCA9IDBgIOKAlCB0aGlzIGlzIG5vdCBhbiBlcnJvci4AAAAZY3JlYXRvcl9lYXJuaW5nc19lc3RpbWF0ZQAAAAAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAEAAAfQAAAAF0NyZWF0b3JFYXJuaW5nc0VzdGltYXRlAA==",
        "AAAAAAAAAWVSZXRyeS1zYWZlIGByZWNvcmRfcGF5bWVudGA6IHNhbWUgYXV0aCwgdmFsaWRhdGlvbiwgYW5kIHBhdXNlIHJ1bGVzLApidXQgcmV0dXJucyB0aGUgc3RvcmVkIHJlY2VpcHQuIElmIGByZWNlaXB0X2lkYCBpcyBhbHJlYWR5IHJlY29yZGVkCndpdGggdGhlIHNhbWUgYHJlc291cmNlX2lkYCwgYHBheWVyYCwgYGFtb3VudGAsIGFuZCBgdHhfaGFzaGAsIHRoYXQKcmVjZWlwdCBpcyByZXR1cm5lZCB1bmNoYW5nZWQsIHdoYXRldmVyIGl0cyBzdGF0ZSwgd2l0aCBubyB3cml0ZSBhbmQKbm8gZXZlbnQuIFRoZSBzYW1lIGlkIHdpdGggZGlmZmVyZW50IGFyZ3VtZW50cyBzdGlsbCBlcnJvcnMKYFJlY2VpcHRBbHJlYWR5RXhpc3RzYC4AAAAAAAAZcmVjb3JkX3BheW1lbnRfaWRlbXBvdGVudAAAAAAAAAYAAAAAAAAAB3NldHRsZXIAAAAAEwAAAAAAAAAKcmVjZWlwdF9pZAAAAAAAEAAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAB3R4X2hhc2gAAAAAEAAAAAEAAAPpAAAH0AAAAA5QYXltZW50UmVjZWlwdAAAAAAAAw==",
        "AAAAAQAAALVBZ2dyZWdhdGVkIGNyZWF0b3IgZWFybmluZ3MgcmV0dXJuZWQgYnkgYGNyZWF0b3JfZWFybmluZ3NfZXN0aW1hdGVgLgpDYXJyaWVzIGJvdGggdGhlIGFkZHJlc3MgYW5kIHRoZSB0b3RhbCBpbiBvbmUgcmVhZCBzbyBjYWxsZXJzIGRvIG5vdCBuZWVkCnRvIGlzc3VlIGEgc2VwYXJhdGUgYGdldF9vd25lcmAgcXVlcnkuAAAAAAAAAAAAABdDcmVhdG9yRWFybmluZ3NFc3RpbWF0ZQAAAAADAAAAKlRoZSBjcmVhdG9yIHdob3NlIGVhcm5pbmdzIGFyZSBhZ2dyZWdhdGVkLgAAAAAAB2NyZWF0b3IAAAAAEwAAAD9OdW1iZXIgb2Ygc2V0dGxlZCBwYXltZW50IHJlY2VpcHRzIGluY2x1ZGVkIGluIGB0b3RhbF9zZXR0bGVkYC4AAAAADXNldHRsZWRfY291bnQAAAAAAAAEAAAAflN1bSBvZiBhbGwgc2V0dGxlZCBwYXltZW50IGFtb3VudHMgKGluIFVTREMgc3Ryb29wcykgZm9yIHJlc291cmNlcwpvd25lZCBieSB0aGlzIGNyZWF0b3IgYXQgdGhlIHRpbWUgZWFjaCBwYXltZW50IHdhcyBzZXR0bGVkLgAAAAAADXRvdGFsX3NldHRsZWQAAAAAAAAL",
        "AAAAAAAAAYJSZXR1cm4gYSBwYWdlIG9mIHZlcmlmaWNhdGlvbiBzdGF0dXMgY2hhbmdlcyBwZXJmb3JtZWQgYnkgYHZlcmlmaWVyYCwKaW4gY2hyb25vbG9naWNhbCBvcmRlciAob2xkZXN0IGZpcnN0KS4KCi0gYGN1cnNvcmAgaXMgYSAwLWJhc2VkIGluZGV4IGludG8gdGhlIHZlcmlmaWVyJ3MgaGlzdG9yeSBsaXN0LgotIGBsaW1pdGAgaXMgY2FwcGVkIGF0IFtgTElTVF9QQUdFX0NBUGBdICgyMCkuCi0gYG5leHRfY3Vyc29yYCBpcyBgU29tZShuZXh0X2luZGV4KWAgd2hlbiBtb3JlIGVudHJpZXMgZXhpc3QsIG9yCmBOb25lYCBhdCBlbmQtb2YtbGlzdC4KCkEgdmVyaWZpZXIgd2l0aCBubyByZWNvcmRlZCBoaXN0b3J5IHJldHVybnMgYW4gZW1wdHkgcGFnZSDigJQgbm90IGFuIGVycm9yLgAAAAAAG2dldF92ZXJpZmllcl9zdGF0dXNfaGlzdG9yeQAAAAADAAAAAAAAAAh2ZXJpZmllcgAAABMAAAAAAAAABmN1cnNvcgAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAB9AAAAASVmVyaWZpZXJTdGF0dXNQYWdlAAA=",
        "AAAAAAAAARJgbGlzdF9ieV9kaXNwdXRlX3N0YXR1c2Agd2l0aCBuZXh0LWN1cnNvciBtZXRhZGF0YS4gQmVjYXVzZSB0aGUgY3Vyc29yCmlzIGEgY2F0YWxvZyBpbmRleCByYXRoZXIgdGhhbiBhIGNvdW50IG9mIG1hdGNoZXMsIGEgZmxhZyBmbGlwcGluZwpiZXR3ZWVuIHBhZ2VzIGNhbiBuZWl0aGVyIHNraXAgbm9yIHJlcGVhdCBhIHJlc291cmNlOiBlYWNoIGNhdGFsb2cgc2xvdAppcyB2aXNpdGVkIGV4YWN0bHkgb25jZSwgYW5kIGl0cyBjdXJyZW50IGZsYWcgZGVjaWRlcyBpbmNsdXNpb24uAAAAAAAbbGlzdF9ieV9kaXNwdXRlX3N0YXR1c19wYWdlAAAAAAMAAAAAAAAAB2ZsYWdnZWQAAAAAAQAAAAAAAAAGY3Vyc29yAAAAAAAEAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAH0AAAAAtDYXRhbG9nUGFnZQA=",
        "AAAAAAAAAVRQYWdpbmF0ZWQgbGlzdCBvZiByZXNvdXJjZXMgZmlsdGVyZWQgYnkgdmVyaWZpY2F0aW9uIHN0YXR1cy4KClJldHVybnMgcmVzb3VyY2VzIHdob3NlIGB2ZXJpZmllZGAgZmllbGQgbWF0Y2hlcyBgc3RhdHVzYC4KYGN1cnNvcmAgaXMgYSBnbG9iYWwgY2F0YWxvZyBpbmRleCAoc2FtZSBzZW1hbnRpY3MgYXMgYGxpc3RfcGFnZWApLgpgbGltaXRgIGlzIGNhcHBlZCBhdCAyMC4KUmV0dXJucyBhIGBDYXRhbG9nUGFnZWAgd2l0aCBgaXRlbXNgIChtYXRjaGluZyByZXNvdXJjZXMpIGFuZApgbmV4dF9jdXJzb3JgIChuZXh0IGNhdGFsb2cgcG9zaXRpb24sIG9yIGBOb25lYCBhdCBlbmQtb2YtbGlzdCkuAAAAG2xpc3RfYnlfdmVyaWZpY2F0aW9uX3N0YXR1cwAAAAADAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAASVmVyaWZpY2F0aW9uU3RhdHVzAAAAAAAAAAAABmN1cnNvcgAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAB9AAAAALQ2F0YWxvZ1BhZ2UA",
        "AAAAAAAABABQYWdpbmF0ZWQgbGlzdGluZyBvZiB0aGUgcmVzb3VyY2VzIG93bmVkIGJ5IGBjcmVhdG9yYCwgZmlsdGVyZWQgYnkKbGlzdGluZyBzdGF0ZSBhbmQgbGlmZWN5Y2xlIHN0YXRlLgoKVGhpcyBpcyB0aGUgZmlsdGVyZWQgY291bnRlcnBhcnQgb2YgW2BsaXN0X2J5X2NyZWF0b3JfcGFnZWBdOiBpdCB3YWxrcwp0aGUgc2FtZSBjcmVhdG9yLXNjb3BlZCBpbmRleCB3aXRoIHRoZSBzYW1lIFtgSWRDdXJzb3JgXSBwYWdpbmF0aW9uLCBzbwphIGNyZWF0b3IgZGFzaGJvYXJkIHJlYWRzIG9ubHkgaXRzIG93biBpbnZlbnRvcnkgaW5zdGVhZCBvZiBzY2FubmluZwp0aGUgZ2xvYmFsIGNhdGFsb2csIGFuZCB0aGUgdHdvIGNhbGxzIGNhbiBiZSBpbnRlcmxlYXZlZC4KCi0gYGN1cnNvcmAgaXMgYW4gW2BJZEN1cnNvcmBdOiBgU3RhcnRgIGZvciB0aGUgZmlyc3QgcGFnZSwgdGhlbiB0aGUKYG5leHRfY3Vyc29yYCByZXR1cm5lZCBieSB0aGUgcHJldmlvdXMgY2FsbC4gSXQgc3Vydml2ZXMgcmVzb3VyY2VzCnRoYXQgbGVhdmUgdGhlIGNyZWF0b3IgaW5kZXggKHRvbWJzdG9uZXMsIHRyYW5zZmVycykgZXhhY3RseSBhcyBpdApkb2VzIGZvciBgbGlzdF9ieV9jcmVhdG9yX3BhZ2VgLgotIGBsaW1pdGAgaXMgY2FwcGVkIGF0IFtgTElTVF9QQUdFX0NBUGBdICgyMCkuIEEgYGxpbWl0YCBvZiBgMGAKcmV0dXJucyBhbiBlbXB0eSBwYWdlLgotIGBsaXN0ZWRgIGZpbHRlcnMgb24gdGhlIGNyZWF0b3ItZmFjaW5nIGxpc3RpbmcgcHJvamVjdGlvbjoKYFNvbWUodHJ1ZSlgIGtlZXBzIG9ubHkgcmVzb3VyY2VzIGluIHRoZSBgTGlzdGVkYCBzdGF0ZSwKYFNvbWUoZmFsc2UpYCBrZWVwcyBvbmx5IHJlc291cmNlcyB0aGF0IGFyZSAqbm90KiBsaXN0ZWQsIGFuZApgTm9uZWAga2VlcHMgZXZlcnkgcmVzb3VyY2UuCi0gYHN0YXRlYCBmaWx0ZXJzIG9uIHRoZSBleHBsaWNpdCBsaWZlY3ljbGUgc3RhdGU7IGBOb25lYCBrZWVwcyBldmVyeQpzdGF0ZS4KLSBUaGUgdHdvIGZpbHRlcnMgY29tcG9zZSB3aXRoIEFORDogYSByZXNvAAAAHWxpc3RfYnlfY3JlYXRvcl9wYWdlX2ZpbHRlcmVkAAAAAAAABQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAZjdXJzb3IAAAAAB9AAAAAISWRDdXJzb3IAAAAAAAAABWxpbWl0AAAAAAAABAAAAAAAAAAGbGlzdGVkAAAAAAPoAAAAAQAAAAAAAAAFc3RhdGUAAAAAAAPoAAAH0AAAAA1SZXNvdXJjZVN0YXRlAAAAAAAAAQAAB9AAAAAGSWRQYWdlAAA=",
        "AAAAAAAAAxZTZXR0bGUtdGltZSByZXRyeSBob29rOiB3cml0ZSB0aGUgYW5jaG9yIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgIGFzCnRoZSBzZXR0bGVyLCB3aXRoIG5vIHZlcmlmaWVyIGludm9sdmVkLiBSZXR1cm5zIGB0cnVlYCBvbiBzdWNjZXNzLgoKVGhlIGF1dGhvcml0eSBncmFudGVkIGlzIHN0cmljdGx5ICpuYXJyb3dlciogdGhhbiB0aGUgdmVyaWZpZXIgcGF0aDoKYHJlY2VpcHRfaGFzaGAgbXVzdCBlcXVhbCB0aGUgYHR4X2hhc2hgIG9mIHRoZSBwYXltZW50IGFscmVhZHkgcmVjb3JkZWQKZm9yIHRoZSBwYWlyLCBzbyB0aGlzIGNhbiBuZWl0aGVyIGFuY2hvciBhIGhhc2ggbm8gcGF5bWVudCBiYWNrcyBub3IKaW52ZW50IGEgcGF5bWVudCAoIzc4MSkuCgpEYXRhIHByb2JsZW1zIGFyZSByZXBvcnRlZCBhcyBpbgpbYGF0dGVtcHRfYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHRgXTogYE9rKGZhbHNlKWAgcGx1cyBhbiBgYW5jaHJmYWlsYApldmVudCBhbmQgYSByZWNvcmQsIHNvIGEgc2V0dGxlbWVudCBsb29wIGNhbiBjYWxsIHRoaXMgb24gZXZlcnkgcGF5bWVudAp3aXRob3V0IHJldmVydGluZy4gVGhlIHNhbWUgaGFzaCBpcyBhbiBpZGVtcG90ZW50IGBPayh0cnVlKWA7IGEgZGlmZmVyZW50Cmhhc2ggcmVwb3J0cyBbYEFuY2hvckZhaWx1cmVSZWFzb246OkR1cGxpY2F0ZVJlY2VpcHRgXS4KCkVycm9ycyBgTm90U2V0dGxlcmAsIGBDb250cmFjdFBhdXNlZGAsIG9yIGBJbnZhbGlkUmVzb3VyY2VJZGA7IGV2ZXJ5Cm90aGVyIHByb2JsZW0gaXMgcmVwb3J0ZWQgYXMgYE9rKGZhbHNlKWAuAAAAAAAdcmV0cnlfYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHQAAAAAAAAEAAAAAAAAAAdzZXR0bGVyAAAAABMAAAAAAAAAC3Jlc291cmNlX2lkAAAAABAAAAAAAAAABWJ1eWVyAAAAAAAAEwAAAAAAAAAMcmVjZWlwdF9oYXNoAAAAEAAAAAEAAAPpAAAAAQAAAAM=",
        "AAAAAAAABABUcmFuc2ZlciByZXNvdXJjZSBvd25lcnNoaXAgd2hpbGUgb3B0aW9uYWxseSByZWJpbmRpbmcgdGhlIG5ldyBvd25lcidzCnRlcm1zIGhhc2ggYW5kL29yIHJlc2V0dGluZyB0aGUgcmVzb3VyY2UncyBhdHRlc3RhdGlvbiByZWNvcmQKYXRvbWljYWxseSBpbiB0aGUgc2FtZSB0cmFuc2FjdGlvbi4KCi0gYGlkYCDigJQgcmVzb3VyY2UgdG8gdHJhbnNmZXIuCi0gYG5ld19jcmVhdG9yYCDigJQgdGhlIGluY29taW5nIG93bmVyLgotIGBuZXdfdGVybXNfaGFzaGAg4oCUIHdoZW4gYFNvbWVgLCBzdG9yZSB0aGlzIGhhc2ggdW5kZXIgdGhlIG5ldwpjcmVhdG9yJ3MgW2BEYXRhS2V5OjpDcmVhdG9yVGVybXNgXSBlbnRyeSAobWF4IDY0IGJ5dGVzKS4gVGhlCipvbGQqIG93bmVyJ3MgdGVybXMgZW50cnkgaXMgbGVmdCB1bmNoYW5nZWQuCi0gYHJlc2V0X2F0dGVzdGF0aW9uYCDigJQgd2hlbiBgdHJ1ZWAsIGNsZWFyIHRoZSByZXNvdXJjZSdzIHN0b3JlZAphdHRlc3RhdGlvbiBoYXNoIHNvIHRoZSBuZXcgb3duZXIgY2FuIHJlcXVlc3QgZnJlc2ggdmVyaWZpY2F0aW9uLgoKQmVoYXZlcyBpZGVudGljYWxseSB0byBgdHJhbnNmZXJfb3duZXJzaGlwYCB3aGVuIGJvdGggb3B0aW9uYWwKYXJndW1lbnRzIGFyZSBgTm9uZWAvYGZhbHNlYDogaXQgZXJyb3JzIGBBbHJlYWR5T3duZXJgLCBjbGVhcnMgYW55CnBlbmRpbmcgYHByb3Bvc2VfdHJhbnNmZXJgLCBhbmQgZW1pdHMgYSBgdHJhbnNmZXJgIGV2ZW50LiBJdCBhbHNvCmVtaXRzIGEgYHR4ZnJ0ZXJtc2AgZXZlbnQgKGV2ZW4gd2hlbiBuZWl0aGVyIG9wdGlvbmFsIGFjdGlvbiB3YXMKdGFrZW4pIHNvIGNhbGxlcnMgd2hvIGNhcmUgYWJvdXQgdGVybXMtYXdhcmUgdHJhbnNmZXJzIGNhbiBpbmRleApqdXN0IHRoYXQgdG9waWMuCgpFcnJvcnM6Ci0gW2BFcnJvcjo6QWxyZWFkeU93bmVyYF0g4oCUIGBuZXdfY3JlYXRvcmAgYWxyZWFkeSBvd25zIHRoZSByZXNvdXJjZS4KLSBbYEVycm9yOjpUZXJtc0hhc2hUb29Mb25nYF0g4oCUIGBuZXdfdGVybXNfaGFzaGAgAAAAHXRyYW5zZmVyX293bmVyc2hpcF93aXRoX3Rlcm1zAAAAAAAABAAAAAAAAAACaWQAAAAAABAAAAAAAAAAC25ld19jcmVhdG9yAAAAABMAAAAAAAAADm5ld190ZXJtc19oYXNoAAAAAAPoAAAAEAAAAAAAAAARcmVzZXRfYXR0ZXN0YXRpb24AAAAAAAABAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAABABBdHRlbXB0IHRvIGFuY2hvciBhIHB1cmNoYXNlIHJlY2VpcHQsIHJlcG9ydGluZyBhIHJlamVjdGVkIGF0dGVtcHQgYXMKYW4gb24tY2hhaW4gYGFuY2hyZmFpbGAgZXZlbnQgaW5zdGVhZCBvZiByZXZlcnRpbmcuCgpgYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHRgIHJldHVybnMgYW4gYEVycm9yYCB3aGVuIHRoZSBhdHRlbXB0IGlzIG5vdAphbmNob3JhYmxlLCBhbmQgYSBTb3JvYmFuIGVycm9yIHJvbGxzIHRoZSB3aG9sZSBpbnZvY2F0aW9uIGJhY2sg4oCUCmV2ZW50cyBpbmNsdWRlZCDigJQgc28gYSBzZXR0bGVtZW50IHNlcnZpY2UgYmF0Y2hpbmcgbWFueSBhbmNob3JzIGxvc2VzCmJvdGggdGhlIHN1cnZpdmluZyBhbmNob3JzIGFuZCBhbnkgb24tY2hhaW4gdHJhY2Ugb2Ygd2hhdCBmYWlsZWQuIFRoaXMKdmFyaWFudCBrZWVwcyBhdXRob3JpemF0aW9uIHN0cmljdCAoYSBub24tdmVyaWZpZXIgc3RpbGwgcmV2ZXJ0cywgYW5kCnNvIGRvZXMgYSBtYWxmb3JtZWQgYHJlc291cmNlX2lkYCkgYnV0IHR1cm5zIHRoZSB0aHJlZSAqZGF0YSogZmFpbHVyZXMK4oCUIHVua25vd24gcmVzb3VyY2UsIHVudXNhYmxlIHJlY2VpcHQgaGFzaCwgYW5kIGFuIGFscmVhZHktYW5jaG9yZWQKYChyZXNvdXJjZV9pZCwgYnV5ZXIpYCBwYWlyIOKAlCBpbnRvIGFuIFtgQW5jaG9yRmFpbHVyZWBdIGV2ZW50IHBsdXMgYQpgZmFsc2VgIHJldHVybiwgc28gbW9uaXRvcnMgY2FuIHNlZSB0aGUgcmVqZWN0ZWQgYXR0ZW1wdCBhbmQgaXRzCnJlYXNvbiB3aXRob3V0IHJlcGxheWluZyB0aGUgY2FsbGVyJ3MgbG9ncy4KClJldHVybnMgYHRydWVgIGFuZCBlbWl0cyB0aGUgdXN1YWwgYGFuY2hvcmAgZXZlbnQgb24gc3VjY2Vzcy4KCgpSZWplY3RlZCBhdHRlbXB0cyBhcmUgY291bnRlZCBwZXIgYChyZXNvdXJjZV9pZCwgYnV5ZXIpYCBwYWlyIChzZWUKYGdldF9hbmNob3JfYXR0ZW1wdHNgKS4gQSByZXRyeSBmZXdlciB0aGFuIGBBTkNIT1JfUkVUUllfQkFDS09GRl9MRURHRVJTYApsZWRnZXJzIGFmdGVyIHRoZSBsYXN0IHJlAAAAH2F0dGVtcHRfYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHQAAAAABAAAAAAAAAAHc2VydmljZQAAAAATAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVidXllcgAAAAAAABMAAAAAAAAADHJlY2VpcHRfaGFzaAAAABAAAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAANJPdmVycmlkZSBhIHB1cmNoYXNlIHJlY2VpcHQgYW5jaG9yIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgLgoKVGhpcyBtZXRob2QgYWxsb3dzIHRoZSBhZG1pbiB0byBmb3JjaWJseSB1cGRhdGUgYW4gZXhpc3RpbmcgcHVyY2hhc2UgcmVjZWlwdAphbmNob3IgZm9yIGEgZ2l2ZW4gYnV5ZXIuIElmIG5vIGFuY2hvciBleGlzdHMsIGl0IHJldHVybnMgYE5vdEZvdW5kYC4AAAAAACBvdmVycmlkZV9wdXJjaGFzZV9yZWNlaXB0X2FuY2hvcgAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAABBuZXdfcmVjZWlwdF9oYXNoAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD" ]),
      options
    )
  }
  public readonly fromJSON = {
    get: this.txFromJSON<Result<Resource>>,
        list: this.txFromJSON<Array<Resource>>,
        admin: this.txFromJSON<Option<string>>,
        count: this.txFromJSON<u32>,
        delist: this.txFromJSON<Result<void>>,
        exists: this.txFromJSON<boolean>,
        get_many: this.txFromJSON<Result<Array<Option<Resource>>>>,
        register: this.txFromJSON<Result<void>>,
        set_tags: this.txFromJSON<Result<void>>,
        top_tags: this.txFromJSON<Array<TagPopularity>>,
        buy_lease: this.txFromJSON<Result<Lease>>,
        get_lease: this.txFromJSON<Result<Lease>>,
        get_owner: this.txFromJSON<Result<string>>,
        is_paused: this.txFromJSON<boolean>,
        list_page: this.txFromJSON<CatalogPage>,
        set_price: this.txFromJSON<Result<void>>,
        get_refund: this.txFromJSON<Result<RefundReceipt>>,
        is_flagged: this.txFromJSON<Result<boolean>>,
        is_settler: this.txFromJSON<boolean>,
        network_id: this.txFromJSON<Result<Buffer>>,
        set_listed: this.txFromJSON<Result<void>>,
        set_paused: this.txFromJSON<Result<void>>,
        add_settler: this.txFromJSON<Result<void>>,
        exists_many: this.txFromJSON<Array<boolean>>,
        export_page: this.txFromJSON<ExportPage>,
        get_payment: this.txFromJSON<Result<PaymentReceipt>>,
        is_verifier: this.txFromJSON<boolean>,
        lease_price: this.txFromJSON<Result<i128>>,
        list_by_tag: this.txFromJSON<Array<Resource>>,
        list_listed: this.txFromJSON<Array<Resource>>,
        pause_until: this.txFromJSON<Option<u64>>,
        accept_admin: this.txFromJSON<Result<void>>,
        add_verifier: this.txFromJSON<Result<void>>,
        flag_details: this.txFromJSON<Result<FlagDetails>>,
        get_revision: this.txFromJSON<Result<u32>>,
        is_moderator: this.txFromJSON<boolean>,
        role_inventory_page: this.txFromJSON<RoleInventoryPage>,
        listed_count: this.txFromJSON<u32>,
        open_dispute: this.txFromJSON<Result<void>>,
        record_lease: this.txFromJSON<Result<Lease>>,
        repair_index: this.txFromJSON<Result<void>>,
        revoke_lease: this.txFromJSON<Result<Lease>>,
        settle_lease: this.txFromJSON<Result<Lease>>,
        state_digest: this.txFromJSON<StateDigestPage>,
        add_moderator: this.txFromJSON<Result<void>>,
        flag_resource: this.txFromJSON<Result<void>>,
        get_memo_hash: this.txFromJSON<Option<Buffer>>,
        list_by_state: this.txFromJSON<CatalogPage>,
        pending_admin: this.txFromJSON<Option<string>>,
        recover_admin: this.txFromJSON<Result<void>>,
        refund_window: this.txFromJSON<u32>,
        registry_info: this.txFromJSON<RegistryInfo>,
        get_fee_config: this.txFromJSON<Option<FeeConfig>>,
        get_owner_many: this.txFromJSON<Result<Array<Option<string>>>>,
        get_terms_hash: this.txFromJSON<Result<string>>,
        record_payment: this.txFromJSON<Result<void>>,
        recovery_admin: this.txFromJSON<Option<string>>,
        register_batch: this.txFromJSON<Result<BatchRegisterResult>>,
        remove_settler: this.txFromJSON<Result<void>>,
        settle_payment: this.txFromJSON<Result<void>>,
        set_fee_config: this.txFromJSON<Result<void>>,
        set_price_many: this.txFromJSON<Result<void>>,
        set_terms_hash: this.txFromJSON<Result<void>>,
        accept_transfer: this.txFromJSON<Result<void>>,
        cancel_transfer: this.txFromJSON<Result<void>>,
        check_tag_index: this.txFromJSON<Result<TagIndexReport>>,
        freeze_metadata: this.txFromJSON<Result<void>>,
        freeze_resource: this.txFromJSON<Result<void>>,
        lease_is_active: this.txFromJSON<boolean>,
        list_by_creator: this.txFromJSON<Array<Resource>>,
        remove_verifier: this.txFromJSON<Result<void>>,
        resolve_dispute: this.txFromJSON<Result<void>>,
        rotate_verifier: this.txFromJSON<Result<void>>,
        unflag_resource: this.txFromJSON<Result<void>>,
        update_metadata: this.txFromJSON<Result<void>>,
        contract_version: this.txFromJSON<ContractVersion>,
        emergency_delist: this.txFromJSON<Result<void>>,
        list_by_tag_page: this.txFromJSON<IdPage>,
        list_listed_page: this.txFromJSON<CatalogPage>,
        migrate_resource: this.txFromJSON<Result<void>>,
        propose_transfer: this.txFromJSON<Result<void>>,
        remove_moderator: this.txFromJSON<Result<void>>,
        repair_tag_index: this.txFromJSON<Result<void>>,
        set_paused_until: this.txFromJSON<Result<void>>,
        set_fee_recipient: this.txFromJSON<Result<void>>,
        set_refund_window: this.txFromJSON<Result<void>>,
        get_anchor_failure: this.txFromJSON<Result<AnchorFailure>>,
        get_resource_state: this.txFromJSON<Result<ResourceState>>,
        initialize_network: this.txFromJSON<Result<void>>,
        nominate_new_admin: this.txFromJSON<Result<void>>,
        register_with_hash: this.txFromJSON<Result<void>>,
        register_with_memo: this.txFromJSON<Result<void>>,
        set_recovery_admin: this.txFromJSON<Result<void>>,
        tombstone_resource: this.txFromJSON<Result<void>>,
        transfer_ownership: this.txFromJSON<Result<void>>,
        extend_resource_ttl: this.txFromJSON<Result<void>>,
        get_anchor_attempts: this.txFromJSON<Result<AnchorAttempts>>,
        get_fee_destination: this.txFromJSON<FeeDestinationConfig>,
        get_payment_receipt: this.txFromJSON<Result<PaymentReceipt>>,
        get_refunded_amount: this.txFromJSON<Result<i128>>,
        get_refund_deadline: this.txFromJSON<Result<u32>>,
        get_resource_states: this.txFromJSON<Result<Array<Option<ResourceState>>>>,
        reactivate_resource: this.txFromJSON<Result<void>>,
        record_admin_refund: this.txFromJSON<Result<void>>,
        set_fee_destination: this.txFromJSON<Result<void>>,
        bootstrap_dual_admin: this.txFromJSON<Result<void>>,
        creator_listed_count: this.txFromJSON<u32>,
        get_attestation_hash: this.txFromJSON<Option<string>>,
        get_flag_reason_hash: this.txFromJSON<Result<string>>,
        get_purchase_receipt: this.txFromJSON<Result<PurchaseReceiptAnchor>>,
        list_by_creator_page: this.txFromJSON<IdPage>,
        pending_admin_expiry: this.txFromJSON<Option<u32>>,
        search_by_tag_prefix: this.txFromJSON<CatalogPage>,
        set_flag_reason_hash: this.txFromJSON<Result<void>>,
        update_metadata_many: this.txFromJSON<Result<void>>,
        get_metadata_pointers: this.txFromJSON<Result<MetadataPointers>>,
        record_anchor_failure: this.txFromJSON<Result<void>>,
        record_creator_refund: this.txFromJSON<Result<void>>,
        set_metadata_pointers: this.txFromJSON<Result<void>>,
        set_royalty_recipient: this.txFromJSON<Result<void>>,
        creator_resource_count: this.txFromJSON<u32>,
        list_by_dispute_status: this.txFromJSON<Array<Resource>>,
        anchor_purchase_receipt: this.txFromJSON<Result<void>>,
        resource_schema_version: this.txFromJSON<u32>,
        set_registry_terms_hash: this.txFromJSON<Result<void>>,
        set_verification_status: this.txFromJSON<Result<void>>,
        verify_attestation_hash: this.txFromJSON<boolean>,
        compute_attestation_hash: this.txFromJSON<string>,
        creator_earnings_estimate: this.txFromJSON<CreatorEarningsEstimate>,
        record_payment_idempotent: this.txFromJSON<Result<PaymentReceipt>>,
        get_verifier_status_history: this.txFromJSON<VerifierStatusPage>,
        list_by_dispute_status_page: this.txFromJSON<CatalogPage>,
        list_by_verification_status: this.txFromJSON<CatalogPage>,
        list_by_creator_page_filtered: this.txFromJSON<IdPage>,
        retry_anchor_purchase_receipt: this.txFromJSON<Result<boolean>>,
        transfer_ownership_with_terms: this.txFromJSON<Result<void>>,
        attempt_anchor_purchase_receipt: this.txFromJSON<Result<boolean>>,
        override_purchase_receipt_anchor: this.txFromJSON<Result<void>>
  }
}