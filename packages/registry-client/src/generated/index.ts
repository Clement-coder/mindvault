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




export const Errors = {
  1: {message:"AlreadyRegistered"},
  2: {message:"NotFound"},
  /**
   * A price is `<= 0`, exceeds `MAX_PRICE`, or is too small to support the
   * active `royalty_bps` (see `validate_price`).
   */
  3: {message:"InvalidPrice"},
  4: {message:"MetadataTooLong"},
  5: {message:"InvalidTag"},
  6: {message:"Unauthorized"},
  7: {message:"PendingAdminNotSet"},
  8: {message:"PendingAdminAlreadySet"},
  9: {message:"SameAdmin"},
  10: {message:"TermsHashTooLong"},
  11: {message:"InvalidResourceId"},
  12: {message:"InvalidMetadataPointer"},
  13: {message:"EmptyMetadata"},
  14: {message:"AlreadyOwner"},
  15: {message:"NoPendingTransfer"},
  16: {message:"ReservedId"},
  17: {message:"PriceExceedsMax"},
  18: {message:"AdminNotSet"},
  19: {message:"NotVerifier"},
  20: {message:"InvalidVerificationTransition"},
  21: {message:"AlreadyFrozen"},
  22: {message:"MetadataFrozen"},
  23: {message:"DuplicateInRepair"},
  /**
   * `tx_hash` is empty or exceeds `MAX_TX_HASH_LEN` (128 bytes).
   */
  24: {message:"InvalidTxHash"},
  /**
   * `amount` supplied to `record_payment` is `<= 0`.
   */
  25: {message:"InvalidPaymentAmount"},
  26: {message:"NotModerator"},
  27: {message:"AlreadyFlagged"},
  28: {message:"NotFlagged"},
  29: {message:"InvalidLifecycleTransition"},
  30: {message:"ResourceNotMutable"},
  31: {message:"NetworkAlreadyInitialized"},
  32: {message:"NetworkIdMismatch"},
  33: {message:"NetworkNotInitialized"},
  /**
   * A fee or fee-destination basis-point value exceeds its configured ceiling.
   */
  34: {message:"FeeBpsTooHigh"},
  /**
   * The combined fee policy or fee-destination split is invalid.
   */
  35: {message:"TotalFeeTooHigh"},
  /**
   * The global resource count would overflow `u32`.
   */
  36: {message:"CountOverflow"},
  /**
   * A batch read exceeded the maximum supported number of IDs.
   */
  37: {message:"BatchTooLarge"},
  /**
   * A purchase receipt already exists for `(resource_id, buyer)`.
   */
  38: {message:"DuplicateReceipt"},
  /**
   * `reason_hash` supplied to `set_flag_reason_hash` exceeds
   * `MAX_FLAG_REASON_HASH_LEN` (64 bytes).
   */
  39: {message:"FlagReasonHashTooLong"},
  /**
   * A state-changing method was called while the registry is paused.
   */
  40: {message:"ContractPaused"},
  /**
   * Caller does not hold the settler role.
   */
  41: {message:"NotSettler"},
  /**
   * A payment receipt already exists for the supplied `receipt_id`.
   */
  42: {message:"ReceiptAlreadyExists"},
  /**
   * The requested payment receipt state transition is not allowed.
   */
  43: {message:"InvalidPaymentTransition"},
  /**
   * `receipt_id` is empty or exceeds `MAX_RECEIPT_ID_LEN` (64 bytes).
   */
  44: {message:"InvalidReceiptId"},
  /**
   * `content_hash` exceeds `MAX_CONTENT_HASH_LEN` (128 bytes).
   */
  45: {message:"ContentHashTooLong"},
  /**
   * `attestation_hash` exceeds `MAX_ATTESTATION_HASH_LEN` (64 bytes).
   */
  46: {message:"AttestationHashTooLong"},
  /**
   * Payment receipt amount does not match the resource's current price.
   */
  47: {message:"PaymentAmountMismatch"},
  /**
   * A payment receipt is already stored for the supplied settlement
   * transaction hash (`tx_hash`); a single Stellar tx must map to one receipt.
   */
  48: {message:"DuplicateTxHash"},
  /**
   * `set_fee_recipient` or `set_fee_destination` was called before any fee config was set via `set_fee_config`.
   */
  49: {message:"FeeConfigNotSet"},
  /**
   * The pending admin nomination is missing or has expired.
   */
  50: {message:"AdminNominationExpired"}
}

export type DataKey = {tag: "Resource", values: readonly [string]} | {tag: "Count", values: void} | {tag: "Index", values: readonly [u32]} | {tag: "Admin", values: void} | {tag: "PendingAdmin", values: void} | {tag: "CreatorTerms", values: readonly [string]} | {tag: "CreatorResources", values: readonly [string]} | {tag: "CreatorCount", values: readonly [string]} | {tag: "PendingTransfer", values: readonly [string]} | {tag: "Verifier", values: readonly [string]} | {tag: "NetworkId", values: void} | {tag: "PaymentReceipt", values: readonly [string]} | {tag: "PaymentIndex", values: readonly [string, string]} | {tag: "PaymentTxHash", values: readonly [string]} | {tag: "Paused", values: void} | {tag: "PauseUntil", values: void} | {tag: "Settler", values: readonly [string]} | {tag: "PurchaseReceipt", values: readonly [string, string]} | {tag: "TagIndex", values: readonly [string]} | {tag: "FeeConfig", values: void} | {tag: "Moderator", values: readonly [string]} | {tag: "DisputeFlag", values: readonly [string]} | {tag: "ListedCount", values: void} | {tag: "FlagReasonHash", values: readonly [string]} | {tag: "AttestationHash", values: readonly [string]} | {tag: "PendingAdminExpiry", values: void} | {tag: "TagCount", values: readonly [string]} | {tag: "TopTags", values: void} | {tag: "CreatorListedCount", values: readonly [string]} | {tag: "MemoHash", values: readonly [string]} | {tag: "FeeDestination", values: void};


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
 * Version of the on-chain `Resource` schema (`RESOURCE_SCHEMA_VERSION`).
 */
resource_schema_version: u32;
  /**
 * Contract crate version (`CARGO_PKG_VERSION` at build time).
 */
version: string;
}


/**
 * Structured payload emitted by `attempt_anchor_purchase_receipt` when an
 * anchor is rejected. Carries everything the caller supplied plus the reason
 * and the ledger it was rejected at, so a monitor can reconstruct the failed
 * attempt without the caller's own logs.
 */
export interface AnchorFailure {
  buyer: string;
  ledger: u32;
  reason: AnchorFailureReason;
  receipt_hash: string;
  resource_id: string;
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


export interface TagPopularity {
  count: u32;
  tag: string;
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
 * Payment amount in USDC stroops (must be `> 0`, matches the resource's
 * on-chain price at settlement time).
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


export interface VerifierRotation {
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
 * Why an `attempt_anchor_purchase_receipt` call could not write an anchor.
 * 
 * The discriminants are stable — do not renumber existing variants. Each
 * maps 1:1 to the `Error` that `anchor_purchase_receipt` would have returned
 * for the same input, so a consumer can treat the two paths interchangeably.
 */
export enum AnchorFailureReason {
  ResourceNotFound = 0,
  InvalidReceiptHash = 1,
  DuplicateReceipt = 2,
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
   * Register a new resource. Price is in USDC stroops (6 decimals).
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
   * Construct and simulate a is_moderator transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether `address` currently holds the moderator role.
   */
  is_moderator: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

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
   * Construct and simulate a pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pending nominated contract admin.
   */
  pending_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

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
   * error `ReceiptAlreadyExists`.
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
   */
  record_payment: ({settler, receipt_id, resource_id, payer, amount, tx_hash}: {settler: string, receipt_id: string, resource_id: string, payer: string, amount: i128, tx_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   */
  emergency_delist: ({id, admin}: {id: string, admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a reactivate_resource transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reactivate a resource that was resolved out of a dispute (or otherwise
   * left inactive) back to the public `Listed` state. Only the creator may
   * call this, and only while the resource is `Frozen` or `Delisted`.
   * 
   * `Disputed` resources have no creator exit: an admin must resolve the
   * dispute first, and `Tombstoned` resources are terminal — reactivation
   * from either fails with `InvalidLifecycleTransition`.
   * 
   * Mirrors `set_listed(id, true)` for the `Delisted` case but is the only
   * creator path out of `Frozen`, and always flips the `listed` projection
   * and listed-count index back to active.
   * 
   * Emits a `reactive` event whose topic carries the resource `id`.
   * 
   * Errors deterministically:
   * - [`Error::Unauthorized`] — caller is not the resource creator
   * - [`Error::InvalidLifecycleTransition`] — resource is not `Frozen` or
   * `Delisted` (e.g. still `Disputed`, already `Listed`, or `Tombstoned`)
   * - [`Error::InvalidResourceId`] — `id` fails format validation
   * - [`Error::NotFound`] — `id` is not a registered resource
   * - [`Error::Contr
   */
  reactivate_resource: ({id}: {id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_destination transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_fee_destination: ({config}: {config: FeeDestinationConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a pending_admin_expiry transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the ledger sequence at which the pending admin nomination expires.
   */
  pending_admin_expiry: (options?: MethodOptions) => Promise<AssembledTransaction<Option<u32>>>

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
   */
  attempt_anchor_purchase_receipt: ({service, resource_id, buyer, receipt_hash}: {service: string, resource_id: string, buyer: string, receipt_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a override_purchase_receipt_anchor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Override a purchase receipt anchor for `(resource_id, buyer)`.
   * 
   * This method allows a verifier to forcibly update an existing purchase receipt
   * anchor for a given buyer. If no anchor exists, it returns `NotFound`.
   */
  override_purchase_receipt_anchor: ({service, resource_id, buyer, new_receipt_hash}: {service: string, resource_id: string, buyer: string, new_receipt_hash: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAMgAAAAAAAAARQWxyZWFkeVJlZ2lzdGVyZWQAAAAAAAABAAAAAAAAAAhOb3RGb3VuZAAAAAIAAABzQSBwcmljZSBpcyBgPD0gMGAsIGV4Y2VlZHMgYE1BWF9QUklDRWAsIG9yIGlzIHRvbyBzbWFsbCB0byBzdXBwb3J0IHRoZQphY3RpdmUgYHJveWFsdHlfYnBzYCAoc2VlIGB2YWxpZGF0ZV9wcmljZWApLgAAAAAMSW52YWxpZFByaWNlAAAAAwAAAAAAAAAPTWV0YWRhdGFUb29Mb25nAAAAAAQAAAAAAAAACkludmFsaWRUYWcAAAAAAAUAAAAAAAAADFVuYXV0aG9yaXplZAAAAAYAAAAAAAAAElBlbmRpbmdBZG1pbk5vdFNldAAAAAAABwAAAAAAAAAWUGVuZGluZ0FkbWluQWxyZWFkeVNldAAAAAAACAAAAAAAAAAJU2FtZUFkbWluAAAAAAAACQAAAAAAAAAQVGVybXNIYXNoVG9vTG9uZwAAAAoAAAAAAAAAEUludmFsaWRSZXNvdXJjZUlkAAAAAAAACwAAAAAAAAAWSW52YWxpZE1ldGFkYXRhUG9pbnRlcgAAAAAADAAAAAAAAAANRW1wdHlNZXRhZGF0YQAAAAAAAA0AAAAAAAAADEFscmVhZHlPd25lcgAAAA4AAAAAAAAAEU5vUGVuZGluZ1RyYW5zZmVyAAAAAAAADwAAAAAAAAAKUmVzZXJ2ZWRJZAAAAAAAEAAAAAAAAAAPUHJpY2VFeGNlZWRzTWF4AAAAABEAAAAAAAAAC0FkbWluTm90U2V0AAAAABIAAAAAAAAAC05vdFZlcmlmaWVyAAAAABMAAAAAAAAAHUludmFsaWRWZXJpZmljYXRpb25UcmFuc2l0aW9uAAAAAAAAFAAAAAAAAAANQWxyZWFkeUZyb3plbgAAAAAAABUAAAAAAAAADk1ldGFkYXRhRnJvemVuAAAAAAAWAAAAAAAAABFEdXBsaWNhdGVJblJlcGFpcgAAAAAAABcAAAA8YHR4X2hhc2hgIGlzIGVtcHR5IG9yIGV4Y2VlZHMgYE1BWF9UWF9IQVNIX0xFTmAgKDEyOCBieXRlcykuAAAADUludmFsaWRUeEhhc2gAAAAAAAAYAAAAMGBhbW91bnRgIHN1cHBsaWVkIHRvIGByZWNvcmRfcGF5bWVudGAgaXMgYDw9IDBgLgAAABRJbnZhbGlkUGF5bWVudEFtb3VudAAAABkAAAAAAAAADE5vdE1vZGVyYXRvcgAAABoAAAAAAAAADkFscmVhZHlGbGFnZ2VkAAAAAAAbAAAAAAAAAApOb3RGbGFnZ2VkAAAAAAAcAAAAAAAAABpJbnZhbGlkTGlmZWN5Y2xlVHJhbnNpdGlvbgAAAAAAHQAAAAAAAAASUmVzb3VyY2VOb3RNdXRhYmxlAAAAAAAeAAAAAAAAABlOZXR3b3JrQWxyZWFkeUluaXRpYWxpemVkAAAAAAAAHwAAAAAAAAARTmV0d29ya0lkTWlzbWF0Y2gAAAAAAAAgAAAAAAAAABVOZXR3b3JrTm90SW5pdGlhbGl6ZWQAAAAAAAAhAAAASkEgZmVlIG9yIGZlZS1kZXN0aW5hdGlvbiBiYXNpcy1wb2ludCB2YWx1ZSBleGNlZWRzIGl0cyBjb25maWd1cmVkIGNlaWxpbmcuAAAAAAANRmVlQnBzVG9vSGlnaAAAAAAAACIAAAA8VGhlIGNvbWJpbmVkIGZlZSBwb2xpY3kgb3IgZmVlLWRlc3RpbmF0aW9uIHNwbGl0IGlzIGludmFsaWQuAAAAD1RvdGFsRmVlVG9vSGlnaAAAAAAjAAAAL1RoZSBnbG9iYWwgcmVzb3VyY2UgY291bnQgd291bGQgb3ZlcmZsb3cgYHUzMmAuAAAAAA1Db3VudE92ZXJmbG93AAAAAAAAJAAAADpBIGJhdGNoIHJlYWQgZXhjZWVkZWQgdGhlIG1heGltdW0gc3VwcG9ydGVkIG51bWJlciBvZiBJRHMuAAAAAAANQmF0Y2hUb29MYXJnZQAAAAAAACUAAAA9QSBwdXJjaGFzZSByZWNlaXB0IGFscmVhZHkgZXhpc3RzIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgLgAAAAAAABBEdXBsaWNhdGVSZWNlaXB0AAAAJgAAAF9gcmVhc29uX2hhc2hgIHN1cHBsaWVkIHRvIGBzZXRfZmxhZ19yZWFzb25faGFzaGAgZXhjZWVkcwpgTUFYX0ZMQUdfUkVBU09OX0hBU0hfTEVOYCAoNjQgYnl0ZXMpLgAAAAAVRmxhZ1JlYXNvbkhhc2hUb29Mb25nAAAAAAAAJwAAAEBBIHN0YXRlLWNoYW5naW5nIG1ldGhvZCB3YXMgY2FsbGVkIHdoaWxlIHRoZSByZWdpc3RyeSBpcyBwYXVzZWQuAAAADkNvbnRyYWN0UGF1c2VkAAAAAAAoAAAAJkNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSBzZXR0bGVyIHJvbGUuAAAAAAAKTm90U2V0dGxlcgAAAAAAKQAAAD9BIHBheW1lbnQgcmVjZWlwdCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhlIHN1cHBsaWVkIGByZWNlaXB0X2lkYC4AAAAAFFJlY2VpcHRBbHJlYWR5RXhpc3RzAAAAKgAAAD5UaGUgcmVxdWVzdGVkIHBheW1lbnQgcmVjZWlwdCBzdGF0ZSB0cmFuc2l0aW9uIGlzIG5vdCBhbGxvd2VkLgAAAAAAGEludmFsaWRQYXltZW50VHJhbnNpdGlvbgAAACsAAABBYHJlY2VpcHRfaWRgIGlzIGVtcHR5IG9yIGV4Y2VlZHMgYE1BWF9SRUNFSVBUX0lEX0xFTmAgKDY0IGJ5dGVzKS4AAAAAAAAQSW52YWxpZFJlY2VpcHRJZAAAACwAAAA6YGNvbnRlbnRfaGFzaGAgZXhjZWVkcyBgTUFYX0NPTlRFTlRfSEFTSF9MRU5gICgxMjggYnl0ZXMpLgAAAAAAEkNvbnRlbnRIYXNoVG9vTG9uZwAAAAAALQAAAEFgYXR0ZXN0YXRpb25faGFzaGAgZXhjZWVkcyBgTUFYX0FUVEVTVEFUSU9OX0hBU0hfTEVOYCAoNjQgYnl0ZXMpLgAAAAAAABZBdHRlc3RhdGlvbkhhc2hUb29Mb25nAAAAAAAuAAAAQ1BheW1lbnQgcmVjZWlwdCBhbW91bnQgZG9lcyBub3QgbWF0Y2ggdGhlIHJlc291cmNlJ3MgY3VycmVudCBwcmljZS4AAAAAFVBheW1lbnRBbW91bnRNaXNtYXRjaAAAAAAAAC8AAACKQSBwYXltZW50IHJlY2VpcHQgaXMgYWxyZWFkeSBzdG9yZWQgZm9yIHRoZSBzdXBwbGllZCBzZXR0bGVtZW50CnRyYW5zYWN0aW9uIGhhc2ggKGB0eF9oYXNoYCk7IGEgc2luZ2xlIFN0ZWxsYXIgdHggbXVzdCBtYXAgdG8gb25lIHJlY2VpcHQuAAAAAAAPRHVwbGljYXRlVHhIYXNoAAAAADAAAABrYHNldF9mZWVfcmVjaXBpZW50YCBvciBgc2V0X2ZlZV9kZXN0aW5hdGlvbmAgd2FzIGNhbGxlZCBiZWZvcmUgYW55IGZlZSBjb25maWcgd2FzIHNldCB2aWEgYHNldF9mZWVfY29uZmlnYC4AAAAAD0ZlZUNvbmZpZ05vdFNldAAAAAAxAAAAN1RoZSBwZW5kaW5nIGFkbWluIG5vbWluYXRpb24gaXMgbWlzc2luZyBvciBoYXMgZXhwaXJlZC4AAAAAFkFkbWluTm9taW5hdGlvbkV4cGlyZWQAAAAAADI=",
        "AAAAAAAAANpSZWFkIHNldmVyYWwgcmVzb3VyY2VzIGluIG9uZSBpbnZvY2F0aW9uLCBwcmVzZXJ2aW5nIGlucHV0IG9yZGVyLgpNaXNzaW5nIHJlc291cmNlcyBhcmUgcmVwcmVzZW50ZWQgYnkgYE5vbmVgOyB2YWxpZCByZXNvdXJjZXMgYXJlCnJldHVybmVkIGFzIGBTb21lKFJlc291cmNlKWAuIFRoZSBiYXRjaCBpcyBjYXBwZWQgdG8gYm91bmQgZXhlY3V0aW9uCmFuZCByZXNwb25zZSBzaXplLgAAAAAACGdldF9tYW55AAAAAQAAAAAAAAADaWRzAAAAA+oAAAAQAAAAAQAAA+kAAAPqAAAD6AAAB9AAAAAIUmVzb3VyY2UAAAAD",
        "AAAAAAAAAPdSZWdpc3RlciBhIG5ldyByZXNvdXJjZS4gUHJpY2UgaXMgaW4gVVNEQyBzdHJvb3BzICg2IGRlY2ltYWxzKS4KUmVqZWN0cyBgcHJpY2UgPD0gMGAgKGBJbnZhbGlkUHJpY2VgKSBvciBgcHJpY2UgPiBNQVhfUFJJQ0VgIChgUHJpY2VFeGNlZWRzTWF4YCkuClJlcXVpcmVzIHRoZSBjcmVhdG9yJ3MgYXV0aG9yaXphdGlvbi4KCkVxdWl2YWxlbnQgdG8gYHJlZ2lzdGVyX3dpdGhfaGFzaGAgd2l0aCBgY29udGVudF9oYXNoID0gTm9uZWAuAAAAAAhyZWdpc3RlcgAAAAUAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAACaWQAAAAAABAAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAIbWV0YWRhdGEAAAAQAAAAAAAAAAR0YWdzAAAD6gAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAbpSZXBsYWNlIGEgcmVzb3VyY2UncyBkaXNjb3ZlcnkgdGFncy4gT25seSB0aGUgY3JlYXRvciBtYXkgY2FsbCB0aGlzLgpEb2VzIG5vdCBtb2RpZnkgYG1ldGFkYXRhYCAodGhlIG9mZi1jaGFpbiBjb250ZW50IHBvaW50ZXIpLgpUYWdzIGFyZSBub3JtYWxpemVkIHRvIGxvd2VyY2FzZSBBU0NJSSBiZWZvcmUgc3RvcmFnZTsgdGhlIG5vcm1hbGl6ZWQKZm9ybSBpcyB3aGF0IGdldHMgaW5kZXhlZCBhbmQgcmV0dXJuZWQgZnJvbSBgbGlzdF9ieV90YWdgLgoKTm8tb3AgZ3VhcmQ6IGlmIHRoZSBub3JtYWxpemVkIGB0YWdzYCBhcmUgaWRlbnRpY2FsIHRvIHRoZSByZXNvdXJjZSdzCmN1cnJlbnQgdGFncyAoc2FtZSB2YWx1ZXMsIHNhbWUgb3JkZXIpLCB0aGUgY2FsbCBzdWNjZWVkcyB3aXRob3V0CnRvdWNoaW5nIHN0b3JhZ2Ugb3IgZW1pdHRpbmcgYSBgc2V0dGFnc2AgZXZlbnQuAAAAAAAIc2V0X3RhZ3MAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAEdGFncwAAA+oAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAAAAAAAIdG9wX3RhZ3MAAAABAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAD6gAAB9AAAAANVGFnUG9wdWxhcml0eQAAAA==",
        "AAAAAAAAAFFHZXQgdGhlIG93bmVyIGFkZHJlc3Mgb2YgYSByZXNvdXJjZS4gRXJyb3JzIHdpdGggYE5vdEZvdW5kYCBpZiBpdCBkb2VzIG5vdCBleGlzdC4AAAAAAAAJZ2V0X293bmVyAAAAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAABMAAAAD",
        "AAAAAAAAAIRXaGV0aGVyIHRoZSByZWdpc3RyeSBpcyBjdXJyZW50bHkgcGF1c2VkLiBSZXR1cm5zIGBmYWxzZWAgd2hlbiB0aGUKcGF1c2UgZmxhZyBoYXMgbmV2ZXIgYmVlbiBzZXQuIE5ldmVyIGJsb2NrZWQgYnkgdGhlIHBhdXNlIGl0c2VsZi4AAAAJaXNfcGF1c2VkAAAAAAAAAAAAAAEAAAAB",
        "AAAAAAAAATNQYWdpbmF0ZWQgY2F0YWxvZyBwYWdlIHdpdGggbmV4dC1jdXJzb3IgbWV0YWRhdGEuCgotIGBjdXJzb3JgIGlzIGEgMC1iYXNlZCBjYXRhbG9nIGluZGV4IChzYW1lIGRvbWFpbiBhcyBgbGlzdGAncyBgc3RhcnRgKS4KLSBgbGltaXRgIGlzIGNhcHBlZCBhdCAyMC4KLSBgbmV4dF9jdXJzb3JgIGlzIGBTb21lKG5leHRfaW5kZXgpYCB3aGVuIG1vcmUgZW50cmllcyBtYXkgZXhpc3QgYWZ0ZXIKdGhpcyBwYWdlLCBvciBgTm9uZWAgYXQgZW5kLW9mLWxpc3QgKGluY2x1ZGluZyBlbXB0eSBjYXRhbG9nIC8gY3Vyc29yCnBhc3QgdGhlIGVuZCkuAAAAAAlsaXN0X3BhZ2UAAAAAAAACAAAAAAAAAAZjdXJzb3IAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAfQAAAAC0NhdGFsb2dQYWdlAA==",
        "AAAAAAAAAYBVcGRhdGUgYSByZXNvdXJjZSdzIHByaWNlLiBSZWplY3RzIGBuZXdfcHJpY2UgPD0gMGAgb3IgYG5ld19wcmljZSA+IE1BWF9QUklDRWAuCk9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4KCkVtaXRzIGEgYHNldHByaWNlYCBldmVudCB3aG9zZSBkYXRhIGlzIGEgW2BQcmljZVVwZGF0ZWRgXSB2YWx1ZQpjb250YWluaW5nIGBpZGAsIGBvbGRfcHJpY2VgLCBgbmV3X3ByaWNlYCwgYW5kIGB1cGRhdGVyYC4KCk5vLW9wIGd1YXJkOiBpZiBgbmV3X3ByaWNlYCBpcyBpZGVudGljYWwgdG8gdGhlIHJlc291cmNlJ3MgY3VycmVudApwcmljZSwgdGhlIGNhbGwgc3VjY2VlZHMgd2l0aG91dCB0b3VjaGluZyBzdG9yYWdlIG9yIGVtaXR0aW5nIGEKYHNldHByaWNlYCBldmVudC4AAAAJc2V0X3ByaWNlAAAAAAAAAgAAAAAAAAACaWQAAAAAABAAAAAAAAAACW5ld19wcmljZQAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAHwAAAAEAAAAAAAAACFJlc291cmNlAAAAAQAAABAAAAAAAAAAAAAAAAVDb3VudAAAAAAAAAEAAAAAAAAABUluZGV4AAAAAAAAAQAAAAQAAAAAAAAAAAAAAAVBZG1pbgAAAAAAAAAAAAAAAAAADFBlbmRpbmdBZG1pbgAAAAEAAAAAAAAADENyZWF0b3JUZXJtcwAAAAEAAAATAAAAAQAAAAAAAAAQQ3JlYXRvclJlc291cmNlcwAAAAEAAAATAAAAAQAAAAAAAAAMQ3JlYXRvckNvdW50AAAAAQAAABMAAAABAAAAAAAAAA9QZW5kaW5nVHJhbnNmZXIAAAAAAQAAABAAAAABAAAAAAAAAAhWZXJpZmllcgAAAAEAAAATAAAAAAAAAAAAAAAJTmV0d29ya0lkAAAAAAAAAQAAAEVDYW5vbmljYWwgcGF5bWVudCByZWNlaXB0LCBrZXllZCBieSBpdHMgY2FsbGVyLWFzc2lnbmVkIGByZWNlaXB0X2lkYC4AAAAAAAAOUGF5bWVudFJlY2VpcHQAAAAAAAEAAAAQAAAAAQAAAMhTZWNvbmRhcnkgaW5kZXggbWFwcGluZyBgKHJlc291cmNlX2lkLCBwYXllcilgIHRvIHRoZSBgcmVjZWlwdF9pZGAgb2YKdGhlIG1vc3QgcmVjZW50IHBheW1lbnQgcmVjb3JkZWQgZm9yIHRoYXQgcGFpciwgc28gZXNjcm93L2xlYXNlCmNvbnRyYWN0cyBjYW4gbG9vayB1cCBhIHNldHRsZW1lbnQgd2l0aG91dCBzY2FubmluZyBldmVudCBoaXN0b3J5LgAAAAxQYXltZW50SW5kZXgAAAACAAAAEAAAABMAAAABAAAAqFNlY29uZGFyeSBpbmRleCBtYXBwaW5nIGEgc2V0dGxlbWVudCB0cmFuc2FjdGlvbiBoYXNoIHRvIHRoZQpgcmVjZWlwdF9pZGAgcmVjb3JkZWQgZm9yIGl0LCBndWFyYW50ZWVpbmcgb25lIHBheW1lbnQgcmVjZWlwdCBwZXIKU3RlbGxhciB0eCAoYER1cGxpY2F0ZVR4SGFzaGAgb24gcmV1c2UpLgAAAA1QYXltZW50VHhIYXNoAAAAAAAAAQAAABAAAAAAAAAAWEVtZXJnZW5jeSBwYXVzZSBmbGFnLiBXaGVuIGB0cnVlYCwgZXZlcnkgc3RhdGUtY2hhbmdpbmcgbWV0aG9kCnJldHVybnMgYENvbnRyYWN0UGF1c2VkYC4AAAAGUGF1c2VkAAAAAAAAAAAAQFVuaXggdGltZXN0YW1wIGF0IHdoaWNoIGEgc2NoZWR1bGVkIHBhdXNlIGF1dG9tYXRpY2FsbHkgZXhwaXJlcy4AAAAKUGF1c2VVbnRpbAAAAAAAAQAAAERTZXR0bGVyIHJvbGUgZ3JhbnQsIGF1dGhvcml6aW5nIGByZWNvcmRfcGF5bWVudGAgLyBgc2V0dGxlX3BheW1lbnRgLgAAAAdTZXR0bGVyAAAAAAEAAAATAAAAAQAAAD1JbW11dGFibGUgcHVyY2hhc2UgcmVjZWlwdCBhbmNob3IgZm9yIGAocmVzb3VyY2VfaWQsIGJ1eWVyKWAuAAAAAAAAD1B1cmNoYXNlUmVjZWlwdAAAAAACAAAAEAAAABMAAAABAAAAQVNlY29uZGFyeSBpbmRleCBtYXBwaW5nIGEgbm9ybWFsaXplZCB0YWcgdG8gb3JkZXJlZCByZXNvdXJjZSBpZHMuAAAAAAAACFRhZ0luZGV4AAAAAQAAABAAAAAAAAAALVJlZ2lzdHJ5LWxldmVsIGZlZSBhbmQgcm95YWx0eSBjb25maWd1cmF0aW9uLgAAAAAAAAlGZWVDb25maWcAAAAAAAABAAAAAAAAAAlNb2RlcmF0b3IAAAAAAAABAAAAEwAAAAEAAAAAAAAAC0Rpc3B1dGVGbGFnAAAAAAEAAAAQAAAAAAAAADJOdW1iZXIgb2YgcmVzb3VyY2VzIGN1cnJlbnRseSBpbiB0aGUgTGlzdGVkIHN0YXRlLgAAAAAAC0xpc3RlZENvdW50AAAAAAEAAAD+SGFzaCBvZiBhIG1vZGVyYXRvcidzIG9mZi1jaGFpbiBkaXNwdXRlIHJlYXNvbiB3cml0ZXVwIGZvciBhIHJlc291cmNlLApzZXQgdmlhIGBzZXRfZmxhZ19yZWFzb25faGFzaGAuIEluZGVwZW5kZW50IG9mIGBGbGFnUmVhc29uYCAoYSBmaXhlZAplbnVtIGNvZGUpOiB0aGlzIGNhcnJpZXMgYSBkaWdlc3Qgb2YgZnJlZS1mb3JtIGRldGFpbCBhIG1vZGVyYXRvcgpyZWNvcmRlZCBvZmYtY2hhaW4sIGFuYWxvZ291cyB0byBgQ3JlYXRvclRlcm1zYC4AAAAAAA5GbGFnUmVhc29uSGFzaAAAAAAAAQAAABAAAAABAAAAc0hhc2ggb2YgYSB2ZXJpZmllcidzIG9mZi1jaGFpbiBhdHRlc3RhdGlvbiBkb2N1bWVudCwgcHJvdmlkZWQgZHVyaW5nIGEKc3RhdHVzIGNoYW5nZSB2aWEgYHNldF92ZXJpZmljYXRpb25fc3RhdHVzYC4AAAAAD0F0dGVzdGF0aW9uSGFzaAAAAAABAAAAEAAAAAAAAAA+TGVkZ2VyIHNlcXVlbmNlIGF0IHdoaWNoIHRoZSBwZW5kaW5nIGFkbWluIG5vbWluYXRpb24gZXhwaXJlcy4AAAAAABJQZW5kaW5nQWRtaW5FeHBpcnkAAAAAAAEAAAAAAAAACFRhZ0NvdW50AAAAAQAAABAAAAAAAAAAAAAAAAdUb3BUYWdzAAAAAAEAAAEFTnVtYmVyIG9mIGBjcmVhdG9yYCdzIHJlc291cmNlcyBjdXJyZW50bHkgaW4gdGhlIGBMaXN0ZWRgIHN0YXRlLiBLZXB0CmluIHN0ZXAgd2l0aCBgTGlzdGVkQ291bnRgIG9uIGV2ZXJ5IGxpc3RlZC1zdGF0ZSB0cmFuc2l0aW9uIGFuZCBtb3ZlZApiZXR3ZWVuIG93bmVycyBvbiB0cmFuc2Zlciwgc28gaXQgaXMgdGhlIHBlci1jcmVhdG9yIHZpZXcgb2YKYGxpc3RlZF9jb3VudGAgaW4gdGhlIHNhbWUgd2F5IGBDcmVhdG9yQ291bnRgIGlzIG9mIGBjb3VudGAuAAAAAAAAEkNyZWF0b3JMaXN0ZWRDb3VudAAAAAAAAQAAABMAAAABAAABDU9wdGlvbmFsIDMyLWJ5dGUgbWVtbyBoYXNoIHJlY29yZGVkIGF0IHJlZ2lzdHJhdGlvbiB0aHJvdWdoCmByZWdpc3Rlcl93aXRoX21lbW9gLCBmb3IgZXhhbXBsZSB0aGUgYE1FTU9fSEFTSGAgb2YgdGhlIHRyYW5zYWN0aW9uCnRoYXQgYW5ub3VuY2VkIG9yIHBhaWQgZm9yIHRoZSByZWdpc3RyYXRpb24uIFdyaXR0ZW4gb25jZSBhbmQgbmV2ZXIKbXV0YXRlZDsgYE5vbmVgIGZvciByZXNvdXJjZXMgcmVnaXN0ZXJlZCB0aHJvdWdoIHRoZSBvdGhlciBlbnRyeSBwb2ludHMuAAAAAAAACE1lbW9IYXNoAAAAAQAAABAAAAAAAAAAAAAAAA5GZWVEZXN0aW5hdGlvbgAA",
        "AAAAAAAAADNXaGV0aGVyIGBhZGRyZXNzYCBjdXJyZW50bHkgaG9sZHMgdGhlIHNldHRsZXIgcm9sZS4AAAAACmlzX3NldHRsZXIAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAItSZXR1cm4gdGhlIGluaXRpYWxpemVkIG5ldHdvcmsgaWRlbnRpZmllci4gQ2FsbGVycyBjYW4gdXNlIHRoaXMgdmFsdWUKYXMgYSBkZXBsb3ltZW50IGd1YXJkIGJlZm9yZSBzdWJtaXR0aW5nIG5ldHdvcmstc2Vuc2l0aXZlIG9wZXJhdGlvbnMuAAAAAApuZXR3b3JrX2lkAAAAAAAAAAAAAQAAA+kAAAPuAAAAIAAAAAM=",
        "AAAAAAAAALhTZXQgYSByZXNvdXJjZSdzIGNyZWF0b3ItY29udHJvbGxlZCBsaXN0aW5nIHN0YXRlLiBPbmx5CmBMaXN0ZWQgPC0+IERlbGlzdGVkYCB0cmFuc2l0aW9ucyBhcmUgYWNjZXB0ZWQ7IGFsbCBvdGhlciBsaWZlY3ljbGUKc3RhdGVzIHJlamVjdCB0aGlzIG1ldGhvZCB3aXRoIGBJbnZhbGlkTGlmZWN5Y2xlVHJhbnNpdGlvbmAuAAAACnNldF9saXN0ZWQAAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAZsaXN0ZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAiZTZXQgb3IgY2xlYXIgdGhlIGVtZXJnZW5jeSBwYXVzZSBvbiBhbGwgcmVnaXN0cnkgbXV0YXRpb25zLgoKV2hlbiBgcGF1c2VkYCBpcyBgdHJ1ZWAgZXZlcnkgd3JpdGUgbWV0aG9kIHJldHVybnMKW2BFcnJvcjo6Q29udHJhY3RQYXVzZWRgXSB3aXRob3V0IG1vZGlmeWluZyBhbnkgc3RhdGUuIFJlYWQtb25seQptZXRob2RzIGFyZSB1bmFmZmVjdGVkIGFuZCByZW1haW4gZnVsbHkgYXZhaWxhYmxlLgoKUmVxdWlyZXMgdGhlIGN1cnJlbnQgYWRtaW4ncyBhdXRob3JpemF0aW9uLiBFcnJvcnMgYEFkbWluTm90U2V0YCBpZiBubwphZG1pbiBoYXMgYmVlbiBzZXQgeWV0LCBhbmQgYFVuYXV0aG9yaXplZGAgaWYgYGFkbWluYCBpcyBub3QgdGhlCmN1cnJlbnQgYWRtaW4uCgpFbWl0cyBhIGBwYXVzZWAgZXZlbnQgd2l0aCBkYXRhIGAocGF1c2VkOiBib29sLCBhZG1pbjogQWRkcmVzcylgIG9uCmV2ZXJ5IGNhbGwsIGluY2x1ZGluZyBuby1vcCB0cmFuc2l0aW9ucywgc28gb2ZmLWNoYWluIG1vbml0b3JzIGNhbgpkZXRlY3QgcmFwaWQgcGF1c2UvdW5wYXVzZSBjeWNsZXMuAAAAAAAKc2V0X3BhdXNlZAAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAAAAAAAAAAAAACFJlc291cmNlAAAAEQAAAKtPcHRpb25hbCBpbW11dGFibGUgZGlnZXN0IG9mIHRoZSByZXNvdXJjZSdzIG9mZi1jaGFpbiBjb250ZW50LCBzZXQKb25jZSBhdCByZWdpc3RyYXRpb24gdmlhIGByZWdpc3Rlcl93aXRoX2hhc2hgLiBgTm9uZWAgZm9yIHJlc291cmNlcwpyZWdpc3RlcmVkIHRocm91Z2ggcGxhaW4gYHJlZ2lzdGVyYC4AAAAADGNvbnRlbnRfaGFzaAAAA+gAAAAQAAAAfUxlZGdlciBzZXF1ZW5jZSBudW1iZXIgYXQgd2hpY2ggdGhpcyByZXNvdXJjZSB3YXMgZmlyc3QgcmVnaXN0ZXJlZC4KVGhpcyB2YWx1ZSBpcyBpbW11dGFibGUgZm9yIHRoZSBsaWZldGltZSBvZiB0aGUgcmVzb3VyY2UuAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAQAAAAAAAAAB2NyZWF0b3IAAAAAEwAAASJBY3RpdmUgZGlzcHV0ZSBmbGFnIHNldCBieSBhIG1vZGVyYXRvciwgb3IgYERpc3B1dGVGbGFnOjpOb0ZsYWdgIGlmIHRoZQpyZXNvdXJjZSBpcyBub3QgZmxhZ2dlZC4gRmxhZ2dpbmcgZG9lcyBub3QgZGVsaXN0IG9yIGRlbGV0ZSB0aGUgcmVzb3VyY2Ug4oCUCml0IGlzIGluZm9ybWF0aW9uYWwgc3RhdGUgdGhhdCBjYWxsZXJzIGNhbiBmaWx0ZXIgb24uIE9ubHkgYSBtb2RlcmF0b3IgbWF5CnNldCBvciBjbGVhciB0aGlzIGZpZWxkIChzZWUgYGZsYWdfcmVzb3VyY2VgIC8gYHVuZmxhZ19yZXNvdXJjZWApLgAAAAAADGRpc3B1dGVfZmxhZwAAB9AAAAALRGlzcHV0ZUZsYWcAAAAAQU9uY2UgdHJ1ZSwgYHVwZGF0ZV9tZXRhZGF0YWAgcGVybWFuZW50bHkgcmVqZWN0cyBmdXJ0aGVyIGNoYW5nZXMuAAAAAAAABmZyb3plbgAAAAAAAQAAAAAAAAACaWQAAAAAABAAAABEQmFja3dhcmRzLWNvbXBhdGlibGUgcHJvamVjdGlvbiBvZiBgc3RhdGUgPT0gUmVzb3VyY2VTdGF0ZTo6TGlzdGVkYC4AAAAGbGlzdGVkAAAAAAABAAAAAAAAAAhtZXRhZGF0YQAAABAAAABlTGVkZ2VyIHNlcXVlbmNlIHdoZW4gYGZyZWV6ZV9tZXRhZGF0YWAgd2FzIGZpcnN0IGNhbGxlZC4gYE5vbmVgIHVudGlsCnRoZSBtZXRhZGF0YSBwb2ludGVyIGlzIGZyb3plbi4AAAAAAAASbWV0YWRhdGFfZnJvemVuX2F0AAAAAAPoAAAABAAAAAAAAAAFcHJpY2UAAAAAAAALAAAA2U9wdGlvbmFsIHBlci1yZXNvdXJjZSByb3lhbHR5IHJlY2lwaWVudCBvdmVycmlkZS4gV2hlbiBzZXQsIHJveWFsdGllcwpmb3IgdGhpcyByZXNvdXJjZSBnbyB0byB0aGlzIGFkZHJlc3MgaW5zdGVhZCBvZiB0aGUgZ2xvYmFsIGZlZV9yZWNpcGllbnQuCk9ubHkgdGhlIHJlc291cmNlIGNyZWF0b3IgbWF5IHNldCB0aGlzIGZpZWxkIHZpYSBgc2V0X3JveWFsdHlfcmVjaXBpZW50YC4AAAAAAAARcm95YWx0eV9yZWNpcGllbnQAAAAAAAPoAAAAEwAAAD1Pbi1jaGFpbiBgUmVzb3VyY2VgIHNjaGVtYSB2ZXJzaW9uIGZvciBkZWNvZGVyIGNvbXBhdGliaWxpdHkuAAAAAAAADnNjaGVtYV92ZXJzaW9uAAAAAAAEAAAAgkV4cGxpY2l0IHJlc291cmNlIGxpZmVjeWNsZSBzdGF0ZS4gU2VlIGBjb250cmFjdC9SRUFETUUubWRgIGZvciB0aGUKdHJhbnNpdGlvbiB0YWJsZSBhbmQgdGhlIHJvbGUgYWxsb3dlZCB0byBtYWtlIGVhY2ggdHJhbnNpdGlvbi4AAAAAAAVzdGF0ZQAAAAAAB9AAAAANUmVzb3VyY2VTdGF0ZQAAAAAAAJNEaXNjb3ZlcnkgbGFiZWxzIChlLmcuICJkYXRhc2V0IiwgInJlc2VhcmNoIikuIERpc3RpbmN0IGZyb20gYG1ldGFkYXRhYCwKd2hpY2ggcmVtYWlucyB0aGUgb2ZmLWNoYWluIGNvbnRlbnQgYW5jaG9yIChJUEZTIFVSSSwgY29udGVudCBoYXNoLCBldGMuKS4AAAAABHRhZ3MAAAPqAAAAEAAAALpMZWRnZXIgc2VxdWVuY2UgbnVtYmVyIGF0IHdoaWNoIHRoaXMgcmVzb3VyY2Ugd2FzIGxhc3Qgd3JpdHRlbgoocmVnaXN0ZXIgb3IgYW55IG11dGF0aW9uKS4gQ2xpZW50cyBjYW4gdXNlIHRoaXMgdG8gZGV0ZWN0IHN0YWxlbmVzcwpvciBvcmRlciBldmVudHMgd2l0aG91dCB0cnVzdGluZyBvZmYtY2hhaW4gdGltZXN0YW1wcy4AAAAAAAp1cGRhdGVkX2F0AAAAAAAEAAAAOk9uLWNoYWluIHZlcmlmaWNhdGlvbiBzdGF0dXMsIHNldHRhYmxlIG9ubHkgYnkgYSB2ZXJpZmllci4AAAAAAAh2ZXJpZmllZAAAB9AAAAASVmVyaWZpY2F0aW9uU3RhdHVzAAAAAACWTW9ub3RvbmljIHdyaXRlIGNvdW50ZXIsIGluY3JlbWVudGVkIG9uIGV2ZXJ5IHBlcnNpc3RlZCBtdXRhdGlvbi4KQ2xpZW50cyBjYW4gdXNlIGl0IGFzIGFuIG9wdGltaXN0aWMtY29uY3VycmVuY3kgdG9rZW4gd2l0aG91dApjb21wYXJpbmcgZXZlcnkgZmllbGQuAAAAAAAHdmVyc2lvbgAAAAAE",
        "AAAAAAAAAKhHcmFudCB0aGUgc2V0dGxlciByb2xlIHRvIGBzZXR0bGVyYCwgYXV0aG9yaXppbmcgYHJlY29yZF9wYXltZW50YCBhbmQKYHNldHRsZV9wYXltZW50YC4gT25seSB0aGUgYWRtaW4gbWF5IGNhbGwgdGhpcy4gRXJyb3JzIGBBZG1pbk5vdFNldGAKaWYgbm8gYWRtaW4gaGFzIGJlZW4gc2V0IHlldC4AAAALYWRkX3NldHRsZXIAAAAAAQAAAAAAAAAHc2V0dGxlcgAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAlNCYXRjaCBleGlzdGVuY2UgY2hlY2suIFJldHVybnMgYSBgVmVjPGJvb2w+YCBwYXJhbGxlbCB0byBgaWRzYDoKYHJlc3VsdFtpXWAgaXMgYHRydWVgIGlmZiBhIHJlc291cmNlIHdpdGggYGlkc1tpXWAgaXMgcmVnaXN0ZXJlZC4KClNlbWFudGljcyBtYXRjaCBgZXhpc3RzYCBmb3IgZWFjaCBlbGVtZW50OiBJRHMgdGhhdCBmYWlsIGZvcm1hdAp2YWxpZGF0aW9uIGFyZSB0cmVhdGVkIGFzIGFic2VudCAoYGZhbHNlYCkgcmF0aGVyIHRoYW4gZXJyb3JpbmcuClRUTCBpcyBidW1wZWQgZm9yIGV2ZXJ5IElEIHRoYXQgcmVzb2x2ZXMgdG8gYSByZWdpc3RlcmVkIHJlc291cmNlLAprZWVwaW5nIHRoZSBob3QgZW50cmllcyBhbGl2ZSBleGFjdGx5IGFzIGEgc2VxdWVuY2Ugb2YgaW5kaXZpZHVhbApgZXhpc3RzYCBjYWxscyB3b3VsZC4KClRoaXMgaXMgdXNlZnVsIGZvciBzZXJ2ZXItc2lkZSBidWxrIHZhbGlkYXRpb24gYmVmb3JlIHB1Ymxpc2hpbmcgb3IKcmVjb25jaWxpYXRpb24g4oCUIGNhbGxlcnMgY2FuIGNoZWNrIG1hbnkgSURzIGluIGEgc2luZ2xlIGNvbnRyYWN0Cmludm9jYXRpb24gaW5zdGVhZCBvZiBvbmUgcm91bmQtdHJpcCBwZXIgSUQuAAAAAAtleGlzdHNfbWFueQAAAAABAAAAAAAAAANpZHMAAAAD6gAAABAAAAABAAAD6gAAAAE=",
        "AAAAAAAAAJtGZXRjaCBhIHBheW1lbnQgcmVjZWlwdCBieSBpdHMgYHJlY2VpcHRfaWRgLiBFcnJvcnMgYE5vdEZvdW5kYCB3aGVuIG5vCnJlY2VpcHQgaGFzIGJlZW4gcmVjb3JkZWQgdW5kZXIgdGhhdCBpZC4gQnVtcHMgdGhlIGVudHJ5J3MgVFRMIG9uIGEKc3VjY2Vzc2Z1bCByZWFkLgAAAAALZ2V0X3BheW1lbnQAAAAAAQAAAAAAAAAKcmVjZWlwdF9pZAAAAAAAEAAAAAEAAAPpAAAH0AAAAA5QYXltZW50UmVjZWlwdAAAAAAAAw==",
        "AAAAAAAAADRXaGV0aGVyIGBhZGRyZXNzYCBjdXJyZW50bHkgaG9sZHMgdGhlIHZlcmlmaWVyIHJvbGUuAAAAC2lzX3ZlcmlmaWVyAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAXVSZXR1cm4gdGhlIHJlc291cmNlIGlkcyB0YWdnZWQgd2l0aCBgdGFnYCAobm9ybWFsaXplZCB0byBsb3dlcmNhc2UpLApwYWdpbmF0ZWQgYnkgYHN0YXJ0YC9gbGltaXRgLiBgbGltaXRgIGlzIGNhcHBlZCBhdCAyMC4gUmVzb3VyY2VzIGFyZQpyZXR1cm5lZCBpbiB0aGUgb3JkZXIgdGhleSB3ZXJlIGFkZGVkIHRvIHRoZSB0YWcgaW5kZXggKGluc2VydGlvbgpvcmRlciBwZXIgdGFnKS4gSWYgdGhlIHRhZyBoYXMgbmV2ZXIgYmVlbiBhc3NpZ25lZCB0byBhbnkgcmVzb3VyY2UKcmV0dXJucyBhbiBlbXB0eSB2ZWMuIEVhY2ggcmVzb3VyY2UgZW50cnkgdGhhdCBpcyByZWFkIGhhcyBpdHMgVFRMCmJ1bXBlZCB0byBrZWVwIGhvdCByZXNvdXJjZXMgYWxpdmUuAAAAAAAAC2xpc3RfYnlfdGFnAAAAAAMAAAAAAAAAA3RhZwAAAAAQAAAAAAAAAAVzdGFydAAAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPqAAAH0AAAAAhSZXNvdXJjZQ==",
        "AAAAAAAAAR9QYWdpbmF0ZWQgbGlzdCBvZiByZXNvdXJjZXMgd2hvc2UgYGxpc3RlZGAgZmxhZyBpcyB0cnVlLCBpbiBpbnNlcnRpb24gb3JkZXIuCgotIFJlc291cmNlcyBhcmUgb3JkZXJlZCBieSByZWdpc3RyYXRpb24gc2VxdWVuY2UuCi0gYGxpbWl0YCBpcyBjYXBwZWQgYXQgYDIwYC4KLSBEZWxpc3RlZCByZXNvdXJjZXMgYXJlIHNraXBwZWQ7IHJlbGlzdGVkIHJlc291cmNlcyB3aWxsIHJlYXBwZWFyLgotIFJldHVybnMgYW4gZW1wdHkgYFZlY2AgaWYgbm8gbGlzdGVkIHJlc291cmNlcyBmYWxsIGluIHJhbmdlLgAAAAALbGlzdF9saXN0ZWQAAAAAAgAAAAAAAAAFc3RhcnQAAAAAAAAEAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAD6gAAB9AAAAAIUmVzb3VyY2U=",
        "AAAAAAAAADNUaGUgYWN0aXZlIHNjaGVkdWxlZCBwYXVzZSBkZWFkbGluZSwgaWYgb25lIGV4aXN0cy4AAAAAC3BhdXNlX3VudGlsAAAAAAAAAAABAAAD6AAAAAY=",
        "AAAAAQAAAC1SZWdpc3RyeS1sZXZlbCBmZWUgYW5kIHJveWFsdHkgY29uZmlndXJhdGlvbi4AAAAAAAAAAAAACUZlZUNvbmZpZwAAAAAAAAMAAAAAAAAADWZlZV9yZWNpcGllbnQAAAAAAAPoAAAAEwAAAAAAAAAQcGxhdGZvcm1fZmVlX2JwcwAAAAQAAAAAAAAAC3JveWFsdHlfYnBzAAAAAAQ=",
        "AAAAAQAAADBTdHJ1Y3R1cmVkIHBheWxvYWQgZW1pdHRlZCBieSBgZmxhZ19yZXNvdXJjZSgpYC4AAAAAAAAACUZsYWdFdmVudAAAAAAAAAMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAAAAAAZyZWFzb24AAAAAB9AAAAAKRmxhZ1JlYXNvbgAA",
        "AAAAAAAAAGhBY2NlcHQgdGhlIHBlbmRpbmcgYWRtaW4gbm9taW5hdGlvbiBhbmQgYmVjb21lIHRoZSBjb250cmFjdCBhZG1pbi4KT25seSB0aGUgcGVuZGluZyBhZG1pbiBtYXkgY2FsbCB0aGlzLgAAAAxhY2NlcHRfYWRtaW4AAAABAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAALlHcmFudCB0aGUgdmVyaWZpZXIgcm9sZSB0byBgdmVyaWZpZXJgLCBhdXRob3JpemluZyBgc2V0X3ZlcmlmaWNhdGlvbl9zdGF0dXNgLgpPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLiBFcnJvcnMgYEFkbWluTm90U2V0YCBpZiBubyBhZG1pbiBoYXMKYmVlbiBzZXQgeWV0IChzZWUgYG5vbWluYXRlX25ld19hZG1pbmApLgAAAAAAAAxhZGRfdmVyaWZpZXIAAAABAAAAAAAAAAh2ZXJpZmllcgAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAADVXaGV0aGVyIGBhZGRyZXNzYCBjdXJyZW50bHkgaG9sZHMgdGhlIG1vZGVyYXRvciByb2xlLgAAAAAAAAxpc19tb2RlcmF0b3IAAAABAAAAAAAAAAdhZGRyZXNzAAAAABMAAAABAAAAAQ==",
        "AAAAAAAAADJOdW1iZXIgb2YgcmVzb3VyY2VzIGN1cnJlbnRseSBpbiB0aGUgTGlzdGVkIHN0YXRlLgAAAAAADGxpc3RlZF9jb3VudAAAAAAAAAABAAAABA==",
        "AAAAAAAAAEBQbGFjZSBhbiBhY3RpdmUgcmVzb3VyY2UgdW5kZXIgYW4gYWRtaW4tY29udHJvbGxlZCBkaXNwdXRlIGhvbGQuAAAADG9wZW5fZGlzcHV0ZQAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAgZSZWJ1aWxkIHRoZSBwYWdpbmF0aW9uIGluZGV4IChgbGlzdGAvYGxpc3RfcGFnZWAvYGNvdW50YCkgZnJvbSBhbgphdXRob3JpdGF0aXZlLCBhZG1pbi1zdXBwbGllZCBvcmRlcmVkIGxpc3Qgb2YgcmVzb3VyY2UgaWRzLiBPbmx5IHRoZQphZG1pbiBtYXkgY2FsbCB0aGlzLiBFdmVyeSBpZCBtdXN0IGFscmVhZHkgZXhpc3QgYXMgYSByZWdpc3RlcmVkCmBSZXNvdXJjZWAgKGVsc2UgYE5vdEZvdW5kYCkgYW5kIHRoZSBsaXN0IG11c3Qgbm90IGNvbnRhaW4gZHVwbGljYXRlcwooZWxzZSBgRHVwbGljYXRlSW5SZXBhaXJgKS4gTmV2ZXIgdG91Y2hlcyBgUmVzb3VyY2VgIHN0b3JhZ2UgaXRzZWxmIOKAlApvbmx5IHJld3JpdGVzIHRoZSBkZXJpdmVkIGBJbmRleGAvYENvdW50YCBwb2ludGVycywgc28gaXQncyBzYWZlIHRvCnJlLXJ1biB3aXRoIHRoZSBjdXJyZW50IGNvcnJlY3QgaWQgbGlzdCBhcyBhIG5vLW9wLiBTZWUKYGRvY3MvaW5kZXgtcmVwYWlyLm1kYCBmb3IgdGhlIGZ1bGwgcmVwYWlyIHN0cmF0ZWd5LgAAAAAADHJlcGFpcl9pbmRleAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAwAAAIhSZWFzb24gY29kZSBzdXBwbGllZCB3aGVuIGEgbW9kZXJhdG9yIGZsYWdzIGEgcmVzb3VyY2UgZm9yIGRpc3B1dGUuCgpUaGUgZGlzY3JpbWluYW50cyBhcmUgc3RhYmxlIOKAlCBkbyBub3QgcmVudW1iZXIgZXhpc3RpbmcgdmFyaWFudHMuAAAAAAAAAApGbGFnUmVhc29uAAAAAAAEAAAAAAAAAARTcGFtAAAAAAAAAAAAAAAJQ29weXJpZ2h0AAAAAAAAAQAAAAAAAAAJTWFsaWNpb3VzAAAAAAAAAgAAAAAAAAAFT3RoZXIAAAAAAAAD",
        "AAAAAAAAAMdHcmFudCB0aGUgbW9kZXJhdG9yIHJvbGUgdG8gYG1vZGVyYXRvcmAsIGF1dGhvcml6aW5nIGBmbGFnX3Jlc291cmNlYCBhbmQKYHVuZmxhZ19yZXNvdXJjZWAuIE9ubHkgdGhlIGFkbWluIG1heSBjYWxsIHRoaXMuIEVycm9ycyBgQWRtaW5Ob3RTZXRgIGlmCm5vIGFkbWluIGhhcyBiZWVuIHNldCB5ZXQgKHNlZSBgbm9taW5hdGVfbmV3X2FkbWluYCkuAAAAAA1hZGRfbW9kZXJhdG9yAAAAAAAAAQAAAAAAAAAJbW9kZXJhdG9yAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAqNGbGFnIGEgcmVzb3VyY2UgZm9yIGRpc3B1dGUuIE9ubHkgYW4gYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZyB0aGUKbW9kZXJhdG9yIHJvbGUgKHNlZSBgYWRkX21vZGVyYXRvcmApIG1heSBjYWxsIHRoaXMuCgpTZXRzIGBSZXNvdXJjZS5kaXNwdXRlX2ZsYWdgIHRvIGBTb21lKHJlYXNvbilgLiBGbGFnZ2luZyBpcyBpbmZvcm1hdGlvbmFsOgppdCBkb2VzIG5vdCBkZWxpc3QsIGRlbGV0ZSwgb3IgcmVzdHJpY3QgdGhlIHJlc291cmNlIOKAlCBjYWxsZXJzIG1heSBmaWx0ZXIKb24gdGhpcyBmaWVsZC4gQ2FsbGluZyBgZmxhZ19yZXNvdXJjZWAgb24gYW4gYWxyZWFkeS1mbGFnZ2VkIHJlc291cmNlCnJlcGxhY2VzIHRoZSBleGlzdGluZyBmbGFnIHdpdGggdGhlIG5ldyByZWFzb24uCgpFbWl0cyBhIGBmbGFnYCBldmVudCB3aXRoIGBGbGFnRXZlbnQgeyBpZCwgbW9kZXJhdG9yLCByZWFzb24gfWAuCgpFcnJvcnMgZGV0ZXJtaW5pc3RpY2FsbHk6Ci0gW2BFcnJvcjo6VW5hdXRob3JpemVkYF0g4oCUIGNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSBtb2RlcmF0b3Igcm9sZQotIFtgRXJyb3I6Ok5vdEZvdW5kYF0g4oCUIGBpZGAgaXMgbm90IGEgcmVnaXN0ZXJlZCByZXNvdXJjZQotIFtgRXJyb3I6OkludmFsaWRSZXNvdXJjZUlkYF0g4oCUIGBpZGAgZmFpbHMgZm9ybWF0IHZhbGlkYXRpb24AAAAADWZsYWdfcmVzb3VyY2UAAAAAAAADAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAJbW9kZXJhdG9yAAAAAAAAEwAAAAAAAAAGcmVhc29uAAAAAAfQAAAACkZsYWdSZWFzb24AAAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAMJSZWFkIHRoZSBtZW1vIGhhc2ggcmVjb3JkZWQgZm9yIGEgcmVzb3VyY2UgYXQgcmVnaXN0cmF0aW9uLCBpZiBpdCB3YXMKcmVnaXN0ZXJlZCB0aHJvdWdoIGByZWdpc3Rlcl93aXRoX21lbW9gIHdpdGggb25lLiBgTm9uZWAgZm9yIGV2ZXJ5Cm90aGVyIHJlc291cmNlIGFuZCBmb3IgaWRzIHRoYXQgYXJlIHVua25vd24gb3IgbWFsZm9ybWVkLgAAAAAADWdldF9tZW1vX2hhc2gAAAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPoAAAD7gAAACA=",
        "AAAAAAAAACFQZW5kaW5nIG5vbWluYXRlZCBjb250cmFjdCBhZG1pbi4AAAAAAAANcGVuZGluZ19hZG1pbgAAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAAPVEaXNjb3ZlciB0aGlzIHJlZ2lzdHJ5J3Mgc3RhYmxlIGlkZW50aXR5IGFuZCBjYXBhYmlsaXRpZXMgaW4gb25lCnJlYWQtb25seSBjYWxsOiBuYW1lLCBjcmF0ZSB2ZXJzaW9uLCBgUmVzb3VyY2VgIHNjaGVtYSB2ZXJzaW9uLCBhbmQKdGhlIG5ldHdvcmsgdGhpcyBjb250cmFjdCBpcyBkZXBsb3llZCBvbi4gQWx3YXlzIHN1Y2NlZWRzIOKAlCB0aGVyZSBpcwpubyBmYWlsdXJlIG1vZGUgYSBjYWxsZXIgbmVlZHMgdG8gaGFuZGxlLgAAAAAAAA1yZWdpc3RyeV9pbmZvAAAAAAAAAAAAAAEAAAfQAAAADFJlZ2lzdHJ5SW5mbw==",
        "AAAAAQAAAO1PbmUgcGFnZSBvZiB0aGUgb24tY2hhaW4gY2F0YWxvZyBwbHVzIGEgY3Vyc29yIGZvciB0aGUgbmV4dCBwYWdlLgoKYG5leHRfY3Vyc29yYCBpcyB0aGUgY2F0YWxvZyBpbmRleCB0byBwYXNzIGJhY2sgaW50byBgbGlzdGAgLyBgbGlzdF9wYWdlYAphcyBgc3RhcnRgL2BjdXJzb3JgLiBgTm9uZWAgbWVhbnMgZW5kLW9mLWxpc3Qg4oCUIGNsaWVudHMgbXVzdCBub3QgcmVjb21wdXRlCm9mZnNldHMgdGhlbXNlbHZlcy4AAAAAAAAAAAAAC0NhdGFsb2dQYWdlAAAAAAIAAAAAAAAABWl0ZW1zAAAAAAAD6gAAB9AAAAAIUmVzb3VyY2UAAAAAAAAAC25leHRfY3Vyc29yAAAAA+gAAAAE",
        "AAAAAgAAAd9XcmFwcGVyIGZvciBhbiBvcHRpb25hbCBbYEZsYWdSZWFzb25gXSB2YWx1ZSwgdXNlZCBhcyB0aGUgYGRpc3B1dGVfZmxhZ2AKZmllbGQgb2YgW2BSZXNvdXJjZWBdLiBTb3JvYmFuJ3MgYGNvbnRyYWN0dHlwZWAgbWFjcm8gcmVxdWlyZXMgdGhhdCBhbGwKZmllbGQgdHlwZXMgYXJlIGBTY1ZhbGAtZW5jb2RhYmxlOyBgT3B0aW9uPEZsYWdSZWFzb24+YCBpcyBub3QgZGlyZWN0bHkKc3VwcG9ydGVkIHdoZW4gYEZsYWdSZWFzb25gIGlzIGEgY3VzdG9tIGBjb250cmFjdHR5cGVgIGVudW0sIHNvIHdlIHVzZSBhCnR3by12YXJpYW50IGVudW0gaW5zdGVhZCBvZiBuYXRpdmUgYE9wdGlvbmAuCgpgTm9GbGFnYCBlbmNvZGVzIHRoZSBhYnNlbmNlIG9mIGEgZGlzcHV0ZSBmbGFnIChhbmFsb2dvdXMgdG8gYE5vbmVgKS4KYEZsYWdnZWQoRmxhZ1JlYXNvbilgIGVuY29kZXMgYW4gYWN0aXZlIGZsYWcgd2l0aCBhIHNwZWNpZmljIHJlYXNvbiBjb2RlLgAAAAAAAAAAC0Rpc3B1dGVGbGFnAAAAAAIAAAAAAAAAAAAAAAZOb0ZsYWcAAAAAAAEAAAAAAAAAB0ZsYWdnZWQAAAAAAQAAB9AAAAAKRmxhZ1JlYXNvbgAA",
        "AAAAAAAAAG5SZWFkIHRoZSByZWdpc3RyeS1sZXZlbCBmZWUgLyByb3lhbHR5IGNvbmZpZ3VyYXRpb24uIFJldHVybnMgYE5vbmVgCmlmIGBzZXRfZmVlX2NvbmZpZ2AgaGFzIG5ldmVyIGJlZW4gY2FsbGVkLgAAAAAADmdldF9mZWVfY29uZmlnAAAAAAAAAAAAAQAAA+gAAAfQAAAACUZlZUNvbmZpZwAAAA==",
        "AAAAAAAAANhCYXRjaCBvd25lciBsb29rdXAuIFJldHVybnMgYSBgVmVjPE9wdGlvbjxBZGRyZXNzPj5gIHBhcmFsbGVsIHRvIGBpZHNgLgpNaXNzaW5nIHJlc291cmNlcyBhcmUgYE5vbmVgOyBpbnZhbGlkIHJlc291cmNlIGlkcyBmYWlsIHRoZSB3aG9sZSBjYWxsLAptYXRjaGluZyBgZ2V0X21hbnlgIGFuZCBrZWVwaW5nIG1hbGZvcm1lZCBtdWx0aS1zZWxlY3QgcmVxdWVzdHMgdmlzaWJsZS4AAAAOZ2V0X293bmVyX21hbnkAAAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAAEAAAAAEAAAPpAAAD6gAAA+gAAAATAAAAAw==",
        "AAAAAAAAAIJGZXRjaCBhIGNyZWF0b3IncyBtYXJrZXRwbGFjZSB0ZXJtcyBoYXNoLiBFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIGl0IGRvZXMgbm90IGV4aXN0LgpCdW1wcyB0aGUgZW50cnkncyBUVEwgb24gYSBzdWNjZXNzZnVsIHJlYWQuAAAAAAAOZ2V0X3Rlcm1zX2hhc2gAAAAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAAEAAAAAM=",
        "AAAAAAAAAu1SZWNvcmQgYW4geDQwMi9Tb3JvYmFuIHBheW1lbnQgcmVjZWlwdCBpbiBgRXNjcm93ZWRgIHN0YXRlLiBPbmx5IGFuCmFkZHJlc3MgY3VycmVudGx5IGhvbGRpbmcgdGhlIHNldHRsZXIgcm9sZSBtYXkgY2FsbCB0aGlzLgoKLSBgcmVjZWlwdF9pZGAgbXVzdCBiZSB1bmlxdWUgKG1heCA2NCBieXRlcywgbm9uLWVtcHR5KTsgZHVwbGljYXRlIGlkcwplcnJvciBgUmVjZWlwdEFscmVhZHlFeGlzdHNgLgotIGByZXNvdXJjZV9pZGAgbXVzdCByZWZlciB0byBhbiBleGlzdGluZyByZWdpc3RlcmVkIHJlc291cmNlCihgTm90Rm91bmRgIG90aGVyd2lzZSkuCi0gYGFtb3VudGAgbXVzdCBiZSBgPiAwYCAoYEludmFsaWRQYXltZW50QW1vdW50YCBvdGhlcndpc2UpLgotIGBhbW91bnRgIG11c3QgbWF0Y2ggdGhlIHJlc291cmNlJ3MgY3VycmVudCBwcmljZQooYFBheW1lbnRBbW91bnRNaXNtYXRjaGAgb3RoZXJ3aXNlKS4KLSBgdHhfaGFzaGAgbXVzdCBiZSBub24tZW1wdHkgYW5kIGF0IG1vc3QgMTI4IGJ5dGVzIChgSW52YWxpZFR4SGFzaGApLgotIGB0eF9oYXNoYCBtdXN0IG5vdCBhbHJlYWR5IGJhY2sgYW5vdGhlciByZWNlaXB0IChgRHVwbGljYXRlVHhIYXNoYCkuCgpFbWl0cyBhIGBwYXltZW50YCBldmVudCB3aG9zZSBkYXRhIGlzIHRoZSBmdWxsIFtgUGF5bWVudFJlY2VpcHRgXSBzbwpvZmYtY2hhaW4gaW5kZXhlcnMgY2FuIGluZGV4IHRoZSByZWNlaXB0IHdpdGhvdXQgcmVhZGluZyBjb250cmFjdApzdG9yYWdlLgAAAAAAAA5yZWNvcmRfcGF5bWVudAAAAAAABgAAAAAAAAAHc2V0dGxlcgAAAAATAAAAAAAAAApyZWNlaXB0X2lkAAAAAAAQAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAHdHhfaGFzaAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAArVSZWdpc3RlciBtdWx0aXBsZSByZXNvdXJjZXMgaW4gYSBzaW5nbGUgdHJhbnNhY3Rpb24uIFRoZSBiYXRjaCBpcyBjYXBwZWQKYXQgW2BNQVhfQkFUQ0hfUkVHSVNURVJgXSAoMTApIHRvIGJvdW5kIGV4ZWN1dGlvbiBjb3N0LiBBbGwgcmVzb3VyY2VzCmFyZSByZWdpc3RlcmVkIHVuZGVyIHRoZSBzYW1lIGBjcmVhdG9yYC4KClJldHVybnMgYSBbYEJhdGNoUmVnaXN0ZXJSZXN1bHRgXSBjb250YWluaW5nOgotIGBzdWNjZWVkZWRgOiBJRHMgb2Ygc3VjY2Vzc2Z1bGx5IHJlZ2lzdGVyZWQgcmVzb3VyY2VzCi0gYGZhaWxlZGA6IEluZGljZXMgYW5kIGVycm9yIGNvZGVzIG9mIGZhaWxlZCByZWdpc3RyYXRpb25zCgpUaGlzIGZ1bmN0aW9uIGNvbnRpbnVlcyBwcm9jZXNzaW5nIGFmdGVyIGluZGl2aWR1YWwgZmFpbHVyZXMsIGFsbG93aW5nCnBhcnRpYWwgc3VjY2Vzcy4gVGhlIGNyZWF0b3IgaXMgYXV0aG9yaXplZCBvbmNlIGF0IHRoZSBzdGFydCwgYW5kIGVhY2gKcmVzb3VyY2UgaXMgdmFsaWRhdGVkIGluZGVwZW5kZW50bHkuIENvbW1vbiBmYWlsdXJlIGNhdXNlcyBpbmNsdWRlCmR1cGxpY2F0ZSBJRHMsIGludmFsaWQgcHJpY2VzLCBvciBpbnZhbGlkIG1ldGFkYXRhIHBvaW50ZXJzLgoKVXNlIGNhc2U6IEJ1bGsgb25ib2FyZGluZyBvZiByZXNvdXJjZXMgYnkgcHVibGlzaGVycyBvciBhdXRvbWF0ZWQgc3lzdGVtcy4AAAAAAAAOcmVnaXN0ZXJfYmF0Y2gAAAAAAAIAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAFaXRlbXMAAAAAAAPqAAAH0AAAABFCYXRjaFJlZ2lzdGVySXRlbQAAAAAAAAEAAAPpAAAH0AAAABNCYXRjaFJlZ2lzdGVyUmVzdWx0AAAAAAM=",
        "AAAAAAAAAEVSZXZva2UgdGhlIHNldHRsZXIgcm9sZSBmcm9tIGBzZXR0bGVyYC4gT25seSB0aGUgYWRtaW4gbWF5IGNhbGwgdGhpcy4AAAAAAAAOcmVtb3ZlX3NldHRsZXIAAAAAAAEAAAAAAAAAB3NldHRsZXIAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAcFBZHZhbmNlIGEgcGF5bWVudCByZWNlaXB0IGZyb20gYEVzY3Jvd2VkYCB0byBgU2V0dGxlZGAuIE9ubHkgYW4KYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZyB0aGUgc2V0dGxlciByb2xlIG1heSBjYWxsIHRoaXMuCgpFcnJvcnM6Ci0gYE5vdEZvdW5kYCDigJQgbm8gcmVjZWlwdCBleGlzdHMgZm9yIGByZWNlaXB0X2lkYC4KLSBgSW52YWxpZFBheW1lbnRUcmFuc2l0aW9uYCDigJQgcmVjZWlwdCBpcyBub3QgaW4gYEVzY3Jvd2VkYCBzdGF0ZQooZS5nLiBhbHJlYWR5IGBTZXR0bGVkYCkuCgpFbWl0cyBhIGBzZXR0bGVgIGV2ZW50IHdob3NlIGRhdGEgaXMgdGhlIHVwZGF0ZWQgW2BQYXltZW50UmVjZWlwdGBdCih3aXRoIGBzdGF0ZTogU2V0dGxlZGApIHNvIG9mZi1jaGFpbiBpbmRleGVycyBjYW4gY29uZmlybSBzZXR0bGVtZW50CndpdGhvdXQgcmVhZGluZyBjb250cmFjdCBzdG9yYWdlLgAAAAAAAA5zZXR0bGVfcGF5bWVudAAAAAAAAgAAAAAAAAAHc2V0dGxlcgAAAAATAAAAAAAAAApyZWNlaXB0X2lkAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAqJTZXQgdGhlIHJlZ2lzdHJ5LWxldmVsIGZlZSAvIHJveWFsdHkgY29uZmlndXJhdGlvbi4gT25seSB0aGUgYWRtaW4gbWF5CmNhbGwgdGhpcy4gRXJyb3JzIGBBZG1pbk5vdFNldGAgaWYgbm8gYWRtaW4gaGFzIGJlZW4gc2V0IHlldC4KCkJvdGggYHBsYXRmb3JtX2ZlZV9icHNgIGFuZCBgcm95YWx0eV9icHNgIG11c3QgYmUg4omkIFtgTUFYX0ZFRV9CUFNgXQooNSAwMDAgYnAgPSA1MCAlKSBpbmRpdmlkdWFsbHksICoqYW5kKiogdGhlaXIgc3VtIG11c3QgYWxzbyBiZSDiiaQKW2BNQVhfRkVFX0JQU2BdLiBWaW9sYXRpbmcgZWl0aGVyIGJvdW5kIGVycm9ycyBgRmVlQnBzVG9vSGlnaGAgKGZvciBhbgppbmRpdmlkdWFsIGZpZWxkIG91dCBvZiByYW5nZSkgb3IgYFRvdGFsRmVlVG9vSGlnaGAgKGZvciBhIHZhbGlkCmluZGl2aWR1YWwgcGFpciB3aG9zZSBzdW0gZXhjZWVkcyB0aGUgY2VpbGluZykuCgpTdG9yZXMgdGhlIGNvbmZpZyB1bmRlciB0aGUgc2luZ2xldG9uIFtgRGF0YUtleTo6RmVlQ29uZmlnYF0gaW5zdGFuY2UKZW50cnkgYW5kIGVtaXRzIGEgYHNldGZlZWAgZXZlbnQgY2FycnlpbmcgdGhlIG9sZCBjb25maWcgKG9yIGBOb25lYCBvbgpmaXJzdCBzZXQpIGFuZCB0aGUgbmV3IGNvbmZpZywgc28gb2ZmLWNoYWluIGluZGV4ZXJzIGhhdmUgYSBmdWxsCmF1ZGl0IHRyYWlsLgAAAAAADnNldF9mZWVfY29uZmlnAAAAAAABAAAAAAAAAAZjb25maWcAAAAAB9AAAAAJRmVlQ29uZmlnAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAYxVcGRhdGUgcHJpY2VzIGZvciBtdWx0aXBsZSByZXNvdXJjZXMgb3duZWQgYnkgYGNyZWF0b3JgIGluIG9uZSBjYWxsLgpUaGUgY3JlYXRvciBhdXRob3JpemVzIHRoZSBpbnZvY2F0aW9uIG9uY2UsIGFuZCBldmVyeSBpdGVtIGlzCnZhbGlkYXRlZCBiZWZvcmUgYW55IHByaWNlIGlzIHdyaXR0ZW4uIElmIG9uZSBpdGVtIGlzIGludmFsaWQsIG5vCnByaWNlcyBhcmUgY2hhbmdlZC4gRHVwbGljYXRlIElEcyB1c2UgdGhlIGxhc3Qgc3VwcGxpZWQgcHJpY2UuCgpUaGUgYmF0Y2ggaXMgY2FwcGVkIGF0IFtgTUFYX0JBVENIX1BSSUNFX1VQREFURVNgXSBpdGVtcy4gQSBuby1vcCBwcmljZQp1cGRhdGUgc3VjY2VlZHMgd2l0aG91dCB3cml0aW5nIHN0b3JhZ2Ugb3IgZW1pdHRpbmcgYHNldHByaWNlYC4AAAAOc2V0X3ByaWNlX21hbnkAAAAAAAIAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAAHdXBkYXRlcwAAAAPqAAAH0AAAABBCYXRjaFByaWNlVXBkYXRlAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAACpTdG9yZSBhIGhhc2ggb2YgY3JlYXRvciBtYXJrZXRwbGFjZSB0ZXJtcy4AAAAAAA5zZXRfdGVybXNfaGFzaAAAAAAAAgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAp0ZXJtc19oYXNoAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAgAAAAAAAAAAAAAADE9wdEZlZUNvbmZpZwAAAAIAAAAAAAAAAAAAAAROb25lAAAAAQAAAAAAAAAEU29tZQAAAAEAAAfQAAAACUZlZUNvbmZpZwAAAA==",
        "AAAAAgAAAXBPbi1jaGFpbiByZWNvcmQgb2YgYSBzaW5nbGUgeDQwMi9Tb3JvYmFuIHBheW1lbnQgc2V0dGxlbWVudCBmb3IgYSByZXNvdXJjZS4KClRoZSBhbGxvd2VkIHRyYW5zaXRpb24gaXMgYEVzY3Jvd2VkIOKGkiBTZXR0bGVkYC4gQSByZWNlaXB0IHN0YXJ0cyBpbgpgRXNjcm93ZWRgIHdoZW4gZmlyc3QgcmVjb3JkZWQgYW5kIG1vdmVzIHRvIGBTZXR0bGVkYCBvbmNlCmBzZXR0bGVfcGF5bWVudGAgaXMgY2FsbGVkIGJ5IGEgc2V0dGxlci4gUmV2ZXJ0aW5nIHRvIGBFc2Nyb3dlZGAgb3IKY3JlYXRpbmcgYSByZWNlaXB0IGRpcmVjdGx5IGluIGBTZXR0bGVkYCBzdGF0ZSBhcmUgbm90IHBlcm1pdHRlZAooYEludmFsaWRQYXltZW50VHJhbnNpdGlvbmApLgAAAAAAAAAMUGF5bWVudFN0YXRlAAAAAgAAAAAAAAC5UGF5bWVudCBoYXMgYmVlbiBhdXRob3Jpc2VkIGJ5IHRoZSBwYXllciBhbmQgaXMgaGVsZCBwZW5kaW5nIGZpbmFsCm9uLWNoYWluIHNldHRsZW1lbnQuIFRoZSB4NDAyIGZhY2lsaXRhdG9yIHJlY29yZHMgcmVjZWlwdHMgaW4gdGhpcwpzdGF0ZTsgYHNldHRsZV9wYXltZW50YCBhZHZhbmNlcyB0aGVtIHRvIGBTZXR0bGVkYC4AAAAAAAAIRXNjcm93ZWQAAAAAAAAAdFBheW1lbnQgaGFzIGJlZW4gc2V0dGxlZCBvbi1jaGFpbi4gVGhlIFVTREMgdHJhbnNmZXIgaGFzIGJlZW4KY29uZmlybWVkIGFuZCB0aGUgY3JlYXRvcidzIGJhbGFuY2UgaGFzIGJlZW4gY3JlZGl0ZWQuAAAAB1NldHRsZWQA",
        "AAAAAQAAAPlTdHJ1Y3R1cmVkIHBheWxvYWQgcHVibGlzaGVkIHdpdGggdGhlIGBzZXRwcmljZWAgZXZlbnQuCkluY2x1ZGVzIHRoZSByZXNvdXJjZSBpZCwgdGhlIHByaWNlIGJlZm9yZSBhbmQgYWZ0ZXIgdGhlIHVwZGF0ZSwgYW5kIHRoZQphZGRyZXNzIHRoYXQgYXV0aG9yaXNlZCB0aGUgY2hhbmdlIOKAlCBlbmFibGluZyBpbmRleGVycyB0byByZWNvbmNpbGUgcHJpY2UKaGlzdG9yeSB3aXRob3V0IHJlLXJlYWRpbmcgY29udHJhY3Qgc3RvcmFnZS4AAAAAAAAAAAAADFByaWNlVXBkYXRlZAAAAAQAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAluZXdfcHJpY2UAAAAAAAALAAAAAAAAAAlvbGRfcHJpY2UAAAAAAAALAAAAAAAAAAd1cGRhdGVyAAAAABM=",
        "AAAAAQAAAMtSZWdpc3RyeSBkaXNjb3ZlcnkgbWV0YWRhdGEgcmV0dXJuZWQgYnkgW2BWYXVsdFJlZ2lzdHJ5OjpyZWdpc3RyeV9pbmZvYF0uCkxldHMgYSBjbGllbnQgZGlzY292ZXIgdGhlIGRlcGxveWVkIHJlZ2lzdHJ5J3MgaWRlbnRpdHkgYW5kIHNoYXBlIHdpdGggYQpzaW5nbGUgcmVhZC1vbmx5IGNhbGwgaW5zdGVhZCBvZiBoYXJkY29kaW5nIGFzc3VtcHRpb25zLgAAAAAAAAAADFJlZ2lzdHJ5SW5mbwAAAAQAAAA3U3RhYmxlLCBodW1hbi1yZWFkYWJsZSByZWdpc3RyeSBuYW1lIChgUkVHSVNUUllfTkFNRWApLgAAAAAEbmFtZQAAABAAAADHTmV0d29yayBwYXNzcGhyYXNlIGRpZ2VzdCBvZiB0aGUgbGVkZ2VyIHRoaXMgY29udHJhY3QgaXMgcnVubmluZyBvbgooYGVudi5sZWRnZXIoKS5uZXR3b3JrX2lkKClgKSwgc28gY2xpZW50cyBjYW4gY29uZmlybSB0aGV5IGFyZQp0YWxraW5nIHRvIHRoZSBuZXR3b3JrIHRoZXkgZXhwZWN0IHdpdGhvdXQgYSBoYXJkY29kZWQgY29uZmlnIHZhbHVlLgAAAAAKbmV0d29ya19pZAAAAAAD7gAAACAAAABGVmVyc2lvbiBvZiB0aGUgb24tY2hhaW4gYFJlc291cmNlYCBzY2hlbWEgKGBSRVNPVVJDRV9TQ0hFTUFfVkVSU0lPTmApLgAAAAAAF3Jlc291cmNlX3NjaGVtYV92ZXJzaW9uAAAAAAQAAAA7Q29udHJhY3QgY3JhdGUgdmVyc2lvbiAoYENBUkdPX1BLR19WRVJTSU9OYCBhdCBidWlsZCB0aW1lKS4AAAAAB3ZlcnNpb24AAAAAEA==",
        "AAAAAAAAAEFBY2NlcHQgYSBwcm9wb3NlZCB0cmFuc2Zlci4gT25seSB0aGUgcGVuZGluZyBvd25lciBjYW4gY2FsbCB0aGlzLgAAAAAAAA9hY2NlcHRfdHJhbnNmZXIAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAa1DYW5jZWwgYSBwcm9wb3NlZCB0cmFuc2Zlci4gT25seSB0aGUgY3VycmVudCBvd25lciBjYW4gY2FsbCB0aGlzLgoKU2VsZi1jYW5jZWwgcHJvdGVjdGlvbjogYGNhbmNlbF90cmFuc2ZlcmAgcmVxdWlyZXMgdGhlIGNhbGxlciB0byBiZSB0aGUKY3VycmVudCBgcmVzb3VyY2UuY3JlYXRvcmAuIEFmdGVyIGBhY2NlcHRfdHJhbnNmZXJgIGNvbXBsZXRlcyB0aGUKcGVuZGluZy10cmFuc2ZlciBlbnRyeSBpcyByZW1vdmVkIGFuZCBvd25lcnNoaXAgbW92ZXMgdG8gdGhlIG5ldwpjcmVhdG9yLCBzbyBhbnkgc3Vic2VxdWVudCBgY2FuY2VsX3RyYW5zZmVyYCBjYWxsIGJ5IGVpdGhlciBwYXJ0eQpyZXR1cm5zIGBOb1BlbmRpbmdUcmFuc2ZlcmAg4oCUIGFuIGFjY2VwdGVkIHRyYW5zZmVyIGNhbiBuZXZlciBiZQpyZXZlcnNlZCB0aHJvdWdoIHRoaXMgcGF0aC4AAAAAAAAPY2FuY2VsX3RyYW5zZmVyAAAAAAEAAAAAAAAAAmlkAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAM1QZXJtYW5lbnRseSBmcmVlemUgYSByZXNvdXJjZSdzIG1ldGFkYXRhIHBvaW50ZXIuIE9ubHkgdGhlIGNyZWF0b3IgbWF5CmNhbGwgdGhpcy4gSXJyZXZlcnNpYmxlIOKAlCBlcnJvcnMgYEFscmVhZHlGcm96ZW5gIGlmIGNhbGxlZCB0d2ljZS4KUHJpY2UsIGxpc3RpbmcsIHRhZ3MsIGFuZCBvd25lcnNoaXAgcmVtYWluIG11dGFibGUgYWZ0ZXIgZnJlZXppbmcuAAAAAAAAD2ZyZWV6ZV9tZXRhZGF0YQAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAO5GcmVlemUgYW4gb3RoZXJ3aXNlIGFjdGl2ZSByZXNvdXJjZS4gVGhlIGNyZWF0b3IgbWF5IGZyZWV6ZSBhIGxpc3RlZCBvcgpkZWxpc3RlZCByZXNvdXJjZSwgYW5kIG1heSByZXN0b3JlIGl0IChvciBhIHBvc3QtZGlzcHV0ZSBgRnJvemVuYApyZXNvbHV0aW9uKSB0aHJvdWdoIGByZWFjdGl2YXRlX3Jlc291cmNlYC4gVGhpcyBsaWZlY3ljbGUgZnJlZXplIGlzCnNlcGFyYXRlIGZyb20gYGZyZWV6ZV9tZXRhZGF0YWAuAAAAAAAPZnJlZXplX3Jlc291cmNlAAAAAAEAAAAAAAAAAmlkAAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAPNQYWdpbmF0ZWQgbGlzdGluZyBvZiByZXNvdXJjZXMgb3duZWQgYnkgYGNyZWF0b3JgIGluIGluc2VydGlvbiBvcmRlci4KCi0gUmVzdWx0cyBhcmUgb3JkZXJlZCBieSBnbG9iYWwgcmVnaXN0cmF0aW9uIHNlcXVlbmNlIGZvciB0aGF0IGNyZWF0b3IuCi0gYGxpbWl0YCBpcyBjYXBwZWQgYXQgYDIwYC4KLSBSZXR1cm5zIGVtcHR5IGBWZWNgIHdoZW4gYHN0YXJ0YCBpcyBiZXlvbmQgdGhlIGNyZWF0b3IncyBrbm93biBpdGVtcy4AAAAAD2xpc3RfYnlfY3JlYXRvcgAAAAADAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAABXN0YXJ0AAAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAA+oAAAfQAAAACFJlc291cmNl",
        "AAAAAAAAAEdSZXZva2UgdGhlIHZlcmlmaWVyIHJvbGUgZnJvbSBgdmVyaWZpZXJgLiBPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLgAAAAAPcmVtb3ZlX3ZlcmlmaWVyAAAAAAEAAAAAAAAACHZlcmlmaWVyAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAEFSZXNvbHZlIGEgZGlzcHV0ZWQgcmVzb3VyY2UgdG8gYExpc3RlZGAsIGBEZWxpc3RlZGAsIG9yIGBGcm96ZW5gLgAAAAAAAA9yZXNvbHZlX2Rpc3B1dGUAAAAAAwAAAAAAAAACaWQAAAAAABAAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFc3RhdGUAAAAAAAfQAAAADVJlc291cmNlU3RhdGUAAAAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAPcm90YXRlX3ZlcmlmaWVyAAAAAAIAAAAAAAAADG9sZF92ZXJpZmllcgAAABMAAAAAAAAADG5ld192ZXJpZmllcgAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAlhSZW1vdmUgdGhlIGRpc3B1dGUgZmxhZyBmcm9tIGEgcmVzb3VyY2UuIE9ubHkgYW4gYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZwp0aGUgbW9kZXJhdG9yIHJvbGUgKHNlZSBgYWRkX21vZGVyYXRvcmApIG1heSBjYWxsIHRoaXMuCgpDbGVhcnMgYFJlc291cmNlLmRpc3B1dGVfZmxhZ2AgdG8gYE5vbmVgLiBJZiB0aGUgcmVzb3VyY2UgaXMgbm90IGN1cnJlbnRseQpmbGFnZ2VkIHRoaXMgaXMgYSBuby1vcCAodGhlIGV2ZW50IGlzIHN0aWxsIGVtaXR0ZWQgc28gb2ZmLWNoYWluIGluZGV4ZXJzCmhhdmUgYSBjb21wbGV0ZSBhdWRpdCB0cmFpbCkuCgpFbWl0cyBhbiBgdW5mbGFnYCBldmVudCB3aXRoIHRoZSByZXNvdXJjZSBgaWRgIGFzIHRoZSBkYXRhIHBheWxvYWQuCgpFcnJvcnMgZGV0ZXJtaW5pc3RpY2FsbHk6Ci0gW2BFcnJvcjo6VW5hdXRob3JpemVkYF0g4oCUIGNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSBtb2RlcmF0b3Igcm9sZQotIFtgRXJyb3I6Ok5vdEZvdW5kYF0g4oCUIGBpZGAgaXMgbm90IGEgcmVnaXN0ZXJlZCByZXNvdXJjZQotIFtgRXJyb3I6OkludmFsaWRSZXNvdXJjZUlkYF0g4oCUIGBpZGAgZmFpbHMgZm9ybWF0IHZhbGlkYXRpb24AAAAPdW5mbGFnX3Jlc291cmNlAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAj1VcGRhdGUgYSByZXNvdXJjZSdzIG1ldGFkYXRhIHBvaW50ZXIuIE9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4KCkVtaXRzIGEgW2BNZXRhZGF0YVVwZGF0ZUV2ZW50YF0gY29udGFpbmluZyB0aGUgcmVzb3VyY2UgaWQsIHRoZSBwcmV2aW91cwptZXRhZGF0YSBwb2ludGVyIChgb2xkX21ldGFkYXRhYCksIGFuZCB0aGUgbmV3IG9uZSAoYG5ld19tZXRhZGF0YWApLgpPZmYtY2hhaW4gaW5kZXhlcnMgY2FuIHVzZSB0aGVzZSBmaWVsZHMgdG8gYnVpbGQgYW4gYXVkaXQgdHJhaWwgd2l0aG91dApxdWVyeWluZyBoaXN0b3JpY2FsIGxlZGdlciBzdGF0ZS4KCk5vLW9wIGd1YXJkOiBpZiBgbWV0YWRhdGFgIGlzIGlkZW50aWNhbCB0byB0aGUgcmVzb3VyY2UncyBjdXJyZW50Cm1ldGFkYXRhIHBvaW50ZXIsIHRoZSBjYWxsIHN1Y2NlZWRzIHdpdGhvdXQgdG91Y2hpbmcgc3RvcmFnZSBvcgplbWl0dGluZyBhbiBgdXBkbWV0YWAgZXZlbnQuIEEgcmVzb3VyY2UgcmVnaXN0ZXJlZCB3aXRoIGEgY29udGVudCBoYXNoCnJlamVjdHMgYW55IGRpdmVyZ2VudCBwb2ludGVyIHdpdGggYE1ldGFkYXRhRnJvemVuYC4AAAAAAAAPdXBkYXRlX21ldGFkYXRhAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAhtZXRhZGF0YQAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAAQRTdHJ1Y3R1cmVkIHBheWxvYWQgZW1pdHRlZCBieSBgYXR0ZW1wdF9hbmNob3JfcHVyY2hhc2VfcmVjZWlwdGAgd2hlbiBhbgphbmNob3IgaXMgcmVqZWN0ZWQuIENhcnJpZXMgZXZlcnl0aGluZyB0aGUgY2FsbGVyIHN1cHBsaWVkIHBsdXMgdGhlIHJlYXNvbgphbmQgdGhlIGxlZGdlciBpdCB3YXMgcmVqZWN0ZWQgYXQsIHNvIGEgbW9uaXRvciBjYW4gcmVjb25zdHJ1Y3QgdGhlIGZhaWxlZAphdHRlbXB0IHdpdGhvdXQgdGhlIGNhbGxlcidzIG93biBsb2dzLgAAAAAAAAANQW5jaG9yRmFpbHVyZQAAAAAAAAUAAAAAAAAABWJ1eWVyAAAAAAAAEwAAAAAAAAAGbGVkZ2VyAAAAAAAEAAAAAAAAAAZyZWFzb24AAAAAB9AAAAATQW5jaG9yRmFpbHVyZVJlYXNvbgAAAAAAAAAADHJlY2VpcHRfaGFzaAAAABAAAAAAAAAAC3Jlc291cmNlX2lkAAAAABA=",
        "AAAAAQAAAI1TdHJ1Y3R1cmVkIHBheWxvYWQgZW1pdHRlZCBieSBgcmVnaXN0ZXIoKWAuCgpDb25zdW1lcnMgY2FuIHJlY29uc3RydWN0IGEgZnVsbCBgUmVzb3VyY2VgIGZyb20gdGhpcyBldmVudCB3aXRob3V0IGFuCmFkZGl0aW9uYWwgb24tY2hhaW4gcmVhZC4AAAAAAAAAAAAADVJlZ2lzdGVyRXZlbnQAAAAAAAAHAAAAAAAAAAxjb250ZW50X2hhc2gAAAPoAAAAEAAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAGbGlzdGVkAAAAAAABAAAAAAAAAAhtZXRhZGF0YQAAABAAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAEdGFncwAAA+oAAAAQ",
        "AAAAAgAAAT5UaGUgYXZhaWxhYmlsaXR5IGFuZCBtb2RlcmF0aW9uIHN0YXRlIG9mIGEgcmVzb3VyY2UuCgpgbGlzdGVkYCByZW1haW5zIG9uIFtgUmVzb3VyY2VgXSBhcyBhIGJhY2t3YXJkcy1jb21wYXRpYmxlIHByb2plY3Rpb246IGl0CmlzIHRydWUgZXhhY3RseSB3aGVuIHRoaXMgdmFsdWUgaXMgW2BSZXNvdXJjZVN0YXRlOjpMaXN0ZWRgXS4gQ2xpZW50cyB0aGF0Cm5lZWQgdG8gZGlzdGluZ3Vpc2ggYSBtb2RlcmF0aW9uIGhvbGQgZnJvbSBhIGNyZWF0b3IgZGVsaXN0IG11c3QgdXNlIHRoaXMKZmllbGQgcmF0aGVyIHRoYW4gdGhlIGJvb2xlYW4gcHJvamVjdGlvbi4AAAAAAAAAAAANUmVzb3VyY2VTdGF0ZQAAAAAAAAUAAAAAAAAAAAAAAAZMaXN0ZWQAAAAAAAAAAAAAAAAACERlbGlzdGVkAAAAAAAAAAAAAAAGRnJvemVuAAAAAAAAAAAAAAAAAAhEaXNwdXRlZAAAAAAAAAAAAAAAClRvbWJzdG9uZWQAAA==",
        "AAAAAQAAAAAAAAAAAAAADVRhZ1BvcHVsYXJpdHkAAAAAAAACAAAAAAAAAAVjb3VudAAAAAAAAAQAAAAAAAAAA3RhZwAAAAAQ",
        "AAAAAAAAAnxSZXR1cm4gdGhlIGNvbnRyYWN0IGNyYXRlIHZlcnNpb24gYW5kIHRoZSBgUmVzb3VyY2VgIHNjaGVtYSB2ZXJzaW9uIGFzIGEKc3RhYmxlLCBjb21wYWN0IHN0cnVjdC4gRGVwbG95bWVudCBzY3JpcHRzIGFuZCB1cGdyYWRlIHRvb2xzIHNob3VsZCBjYWxsCnRoaXMgdG8gY29uZmlybSB3aGljaCB2ZXJzaW9uIG9mIHRoZSBjb250cmFjdCBpcyBydW5uaW5nIG9uLWNoYWluIGJlZm9yZQphbmQgYWZ0ZXIgYSByZWRlcGxveSwgd2l0aG91dCBuZWVkaW5nIHRvIHBhcnNlIHRoZSBmdWxsIGByZWdpc3RyeV9pbmZvYApyZXNwb25zZS4KClVwZ3JhZGUgY29tcGF0aWJpbGl0eTogYGNyYXRlX3ZlcnNpb25gIGlzIHRoZSBDYXJnbyBzZW12ZXIgc3RyaW5nIGJha2VkCmluIGF0IGJ1aWxkIHRpbWUgKGBDQVJHT19QS0dfVkVSU0lPTmApLiBgcmVzb3VyY2Vfc2NoZW1hX3ZlcnNpb25gIGlzIGFuCmludGVnZXIgYnVtcGVkIG9ubHkgd2hlbiB0aGUgb24tY2hhaW4gYFJlc291cmNlYCBzdHJ1Y3QgY2hhbmdlcyBpbiBhIHdheQp0aGF0IHJlcXVpcmVzIGNhbGxlcnMgdG8gdXBkYXRlIGhvdyB0aGV5IGRlY29kZSBpdC4gQSBjaGFuZ2UgdG8KYGNyYXRlX3ZlcnNpb25gIGFsb25lIGRvZXMgbm90IGltcGx5IGEgc2NoZW1hIGNoYW5nZS4AAAAQY29udHJhY3RfdmVyc2lvbgAAAAAAAAABAAAH0AAAAA9Db250cmFjdFZlcnNpb24A",
        "AAAAAAAAAINFbWVyZ2VuY3ktZGVsaXN0IGEgZGlzcHV0ZWQgcmVzb3VyY2UuIE9ubHkgdGhlIGN1cnJlbnQgYWRtaW4gbWF5IGNhbGwKdGhpcywgYW5kIG9ubHkgd2hpbGUgdGhlIHJlc291cmNlIGlzIGluIHRoZSBgRGlzcHV0ZWRgIHN0YXRlLgAAAAAQZW1lcmdlbmN5X2RlbGlzdAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAVhZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAEBQcm9wb3NlIGEgdHJhbnNmZXIgdG8gYSBuZXcgb3duZXIuIFRoZSBuZXcgb3duZXIgbXVzdCBhY2NlcHQgaXQuAAAAEHByb3Bvc2VfdHJhbnNmZXIAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAElSZXZva2UgdGhlIG1vZGVyYXRvciByb2xlIGZyb20gYG1vZGVyYXRvcmAuIE9ubHkgdGhlIGFkbWluIG1heSBjYWxsIHRoaXMuAAAAAAAAEHJlbW92ZV9tb2RlcmF0b3IAAAABAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAo9SZWJ1aWxkIHRoZSB0YWcgaW5kZXggZnJvbSBhbiBhdXRob3JpdGF0aXZlLCBhZG1pbi1zdXBwbGllZCBvcmRlcmVkCmxpc3Qgb2YgcmVzb3VyY2UgaWRzLiBPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLiBFdmVyeSBpZCBtdXN0CmFscmVhZHkgZXhpc3QgYXMgYSByZWdpc3RlcmVkIGBSZXNvdXJjZWAgKGVsc2UgYE5vdEZvdW5kYCkuIFVubGlrZQpgcmVwYWlyX2luZGV4YCwgZHVwbGljYXRlcyBpbiB0aGUgaWQgbGlzdCBhcmUgaGFybWxlc3MgKHRhZyBpbmRleCBoYXMKc2V0IHNlbWFudGljcyBwZXIgdGFnIOKAlCByZS1pbmRleGluZyB0aGUgc2FtZSBpZCBpcyBpZGVtcG90ZW50KSBhbmQKYXJlIHNpbGVudGx5IGRlLWR1cGxpY2F0ZWQgcmF0aGVyIHRoYW4gcmVqZWN0ZWQuIE5ldmVyIHJlYWRzLCB3cml0ZXMsCm9yIGRlbGV0ZXMgYFJlc291cmNlYCBzdG9yYWdlIOKAlCBvbmx5IHJld3JpdGVzIHRoZSBkZXJpdmVkIGBUYWdJbmRleGAKZW50cmllcyBmb3IgdGhlIHRhZ3MgdGhvc2UgcmVzb3VyY2VzIGN1cnJlbnRseSBjYXJyeS4gU2FmZSB0byByZS1ydW4Kd2l0aCB0aGUgY29ycmVjdCBjdXJyZW50IGlkIGxpc3QgYXMgYSBuby1vcC4gU2VlCmBkb2NzL3RhZy1pbmRleC1yZXBhaXItZGVzaWduLm1kYCBmb3IgdGhlIGZ1bGwgc3RyYXRlZ3kuAAAAABByZXBhaXJfdGFnX2luZGV4AAAAAQAAAAAAAAADaWRzAAAAA+oAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAVJTY2hlZHVsZSBhbiBlbWVyZ2VuY3kgcGF1c2UgdGhhdCBhdXRvbWF0aWNhbGx5IGV4cGlyZXMgYXQgYHBhdXNlX3VudGlsYC4KClRoZSBkZWFkbGluZSBpcyBhbiBhYnNvbHV0ZSBVbml4IHRpbWVzdGFtcCBpbiBzZWNvbmRzIGZyb20gdGhlIGxlZGdlcgpjbG9jay4gVGhlIGV4aXN0aW5nIGBzZXRfcGF1c2VkKGFkbWluLCB0cnVlKWAgZW50cnkgcG9pbnQgcmVtYWlucyB0aGUKd2F5IHRvIGNyZWF0ZSBhbiBpbmRlZmluaXRlIHBhdXNlLiBBIGRlYWRsaW5lIGF0IG9yIGJlZm9yZSB0aGUgY3VycmVudApsZWRnZXIgdGltZXN0YW1wIHRha2VzIGVmZmVjdCBhcyBhbiBpbW1lZGlhdGUgcmVzdW1lLgAAAAAAEHNldF9wYXVzZWRfdW50aWwAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAC3BhdXNlX3VudGlsAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAgAAAAAAAAAAAAAADkZlZURlc3RpbmF0aW9uAAAAAAADAAAAAAAAAAAAAAAETm9uZQAAAAAAAAAAAAAABEJ1cm4AAAABAAAAAAAAAAdDaGFyaXR5AAAAAAEAAAAT",
        "AAAAAQAAAnVBIHBheW1lbnQgcmVjZWlwdCBhbmNob3JpbmcgYW4geDQwMi9Tb3JvYmFuIHNldHRsZW1lbnQgdG8gYSBzcGVjaWZpYwp2YXVsdCByZXNvdXJjZSBhbmQgcGF5ZXIuIFdyaXR0ZW4gYnkgYW4gYWRkcmVzcyBob2xkaW5nIHRoZSBzZXR0bGVyIHJvbGUuCgpgcmVjZWlwdF9pZGAgaXMgYSBjYWxsZXItY2hvc2VuIHVuaXF1ZSBpZGVudGlmaWVyIChtYXggNjQgYnl0ZXMpIOKAlAp0eXBpY2FsbHkgdGhlIHg0MDIgZmFjaWxpdGF0b3IncyBvd24gcmVjZWlwdCBvciB0cmFuc2FjdGlvbiBJRC4KYHR4X2hhc2hgIGlzIHRoZSBTdGVsbGFyIHRyYW5zYWN0aW9uIGhhc2ggb2YgdGhlIFVTREMgdHJhbnNmZXIgKG1heCAxMjgKYnl0ZXMpLCBwcmVzZW50IGZyb20gY3JlYXRpb24gc28gaW5kZXhlcnMgY2FuIHZlcmlmeSBzZXR0bGVtZW50IG9uLWNoYWluCndpdGhvdXQgYSBzZWNvbmQgcm91bmQtdHJpcC4KCkZpZWxkcyBhcmUgaW50ZW50aW9uYWxseSByZWFkLW9ubHkgYWZ0ZXIgcmVjb3JkaW5nLiBUbyB1cGRhdGUgc3RhdGUsCmNhbGwgYHNldHRsZV9wYXltZW50YCB3aGljaCB0cmFuc2l0aW9ucyBgRXNjcm93ZWQg4oaSIFNldHRsZWRgIGFuZApyZS1lbWl0cyB0aGUgcmVjZWlwdCBhcyBhIGBzZXR0bGVgIGV2ZW50LgAAAAAAAAAAAAAOUGF5bWVudFJlY2VpcHQAAAAAAAgAAABpUGF5bWVudCBhbW91bnQgaW4gVVNEQyBzdHJvb3BzIChtdXN0IGJlIGA+IDBgLCBtYXRjaGVzIHRoZSByZXNvdXJjZSdzCm9uLWNoYWluIHByaWNlIGF0IHNldHRsZW1lbnQgdGltZSkuAAAAAAAABmFtb3VudAAAAAAACwAAACZDb21wYXRpYmlsaXR5IGFsaWFzIGZvciBgcmVjb3JkZWRfYXRgLgAAAAAABmxlZGdlcgAAAAAABAAAADNTdGVsbGFyIGFkZHJlc3Mgb2YgdGhlIHBhcnR5IHRoYXQgbWFkZSB0aGUgcGF5bWVudC4AAAAABXBheWVyAAAAAAAAEwAAADlDYWxsZXItYXNzaWduZWQgdW5pcXVlIHJlY2VpcHQgaWRlbnRpZmllciAobWF4IDY0IGJ5dGVzKS4AAAAAAAAKcmVjZWlwdF9pZAAAAAAAEAAAAEBMZWRnZXIgc2VxdWVuY2UgbnVtYmVyIGF0IHdoaWNoIHRoaXMgcmVjZWlwdCB3YXMgZmlyc3QgcmVjb3JkZWQuAAAAC3JlY29yZGVkX2F0AAAAAAQAAAAhVGhlIHJlc291cmNlIHRoaXMgcGF5bWVudCBpcyBmb3IuAAAAAAAAC3Jlc291cmNlX2lkAAAAABAAAAAoQ3VycmVudCBsaWZlY3ljbGUgc3RhdGUgb2YgdGhpcyByZWNlaXB0LgAAAAVzdGF0ZQAAAAAAB9AAAAAMUGF5bWVudFN0YXRlAAAASVN0ZWxsYXIgdHJhbnNhY3Rpb24gaGFzaCBvZiB0aGUgVVNEQyB0cmFuc2ZlciAobm9uLWVtcHR5LCBtYXggMTI4IGJ5dGVzKS4AAAAAAAAHdHhfaGFzaAAAAAAQ",
        "AAAAAAAAAaVVcGRhdGUgb25seSB0aGUgZmVlIHJlY2lwaWVudCBhZGRyZXNzIHdpdGhvdXQgY2hhbmdpbmcgZmVlIHJhdGVzLgpPbmx5IHRoZSBhZG1pbiBtYXkgY2FsbCB0aGlzLiBFcnJvcnMgYEFkbWluTm90U2V0YCBpZiBubyBhZG1pbiBoYXMgYmVlbgpzZXQgeWV0LCBvciBgRmVlQ29uZmlnTm90U2V0YCBpZiBgc2V0X2ZlZV9jb25maWdgIGhhcyBuZXZlciBiZWVuIGNhbGxlZC4KClRoaXMgaXMgYSBjb252ZW5pZW5jZSBtZXRob2QgdGhhdCBhbGxvd3MgdXBkYXRpbmcgdGhlIHJlY2lwaWVudCB3aXRob3V0CmhhdmluZyB0byByZS1zcGVjaWZ5IHRoZSBleGlzdGluZyBgcGxhdGZvcm1fZmVlX2Jwc2AgYW5kIGByb3lhbHR5X2Jwc2AuCkVtaXRzIGEgYHNldGZlZWAgZXZlbnQgd2l0aCB0aGUgb2xkIGFuZCBuZXcgY29tcGxldGUgYEZlZUNvbmZpZ2AuAAAAAAAAEXNldF9mZWVfcmVjaXBpZW50AAAAAAAAAQAAAAAAAAAJcmVjaXBpZW50AAAAAAAD6AAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAAWdDb21wYWN0IHZlcnNpb24gc3RydWN0IHJldHVybmVkIGJ5IFtgVmF1bHRSZWdpc3RyeTo6Y29udHJhY3RfdmVyc2lvbmBdLgoKRGVwbG95bWVudCBzY3JpcHRzIGFuZCB1cGdyYWRlIHRvb2xpbmcgc2hvdWxkIGNhbGwgYGNvbnRyYWN0X3ZlcnNpb25gCmJlZm9yZSBhbmQgYWZ0ZXIgYSByZWRlcGxveSB0byBjb25maXJtIHdoaWNoIGJ1aWxkIGlzIHJ1bm5pbmcgb24tY2hhaW4uCk9ubHkgYHJlc291cmNlX3NjaGVtYV92ZXJzaW9uYCBpcyByZWxldmFudCB0byB3aGV0aGVyIGNhbGxlcnMgbXVzdCB1cGRhdGUKdGhlaXIgYFJlc291cmNlYCBkZWNvZGluZyBsb2dpYzsgYSBgY3JhdGVfdmVyc2lvbmAgYnVtcCBhbG9uZSBpcyBzYWZlLgAAAAAAAAAAD0NvbnRyYWN0VmVyc2lvbgAAAAACAAAAQUNhcmdvIHNlbXZlciBzdHJpbmcgYmFrZWQgaW4gYXQgYnVpbGQgdGltZSAoYENBUkdPX1BLR19WRVJTSU9OYCkuAAAAAAAADWNyYXRlX3ZlcnNpb24AAAAAAAAQAAAAhE9uLWNoYWluIGBSZXNvdXJjZWAgc2NoZW1hIHZlcnNpb24gKGBSRVNPVVJDRV9TQ0hFTUFfVkVSU0lPTmApLgpCdW1wIHRoaXMgb25seSB3aGVuIHRoZSBgUmVzb3VyY2VgIHN0cnVjdCBjaGFuZ2VzIGluIGEgYnJlYWtpbmcgd2F5LgAAABdyZXNvdXJjZV9zY2hlbWFfdmVyc2lvbgAAAAAE",
        "AAAAAAAAAFJGZXRjaCB0aGUgY3VycmVudCBsaWZlY3ljbGUgc3RhdGUgb2YgYSByZXNvdXJjZS4gRXJyb3JzIHdpdGggYE5vdEZvdW5kYCBpZiBhYnNlbnQuAAAAAAASZ2V0X3Jlc291cmNlX3N0YXRlAAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAH0AAAAA1SZXNvdXJjZVN0YXRlAAAAAAAAAw==",
        "AAAAAAAAAMhTdG9yZSB0aGUgaW50ZW5kZWQgbmV0d29yayBpZGVudGlmaWVyIG9uY2UuIFRoZSBzdXBwbGllZCBJRCBtdXN0IG1hdGNoCnRoZSBsZWRnZXIgdGhpcyBjb250cmFjdCBpcyBleGVjdXRpbmcgb24sIHByZXZlbnRpbmcgYSBkZXBsb3ltZW50CnNjcmlwdCBmcm9tIGFjY2lkZW50YWxseSByZWNvcmRpbmcgYSBkaWZmZXJlbnQgU3RlbGxhciBuZXR3b3JrLgAAABJpbml0aWFsaXplX25ldHdvcmsAAAAAAAEAAAAAAAAACm5ldHdvcmtfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAKxOb21pbmF0ZSBhIG5ldyBjb250cmFjdCBhZG1pbi4gT25seSB0aGUgY3VycmVudCBhZG1pbiBtYXkgY2FsbCB0aGlzLgpTZXRzIGBwZW5kaW5nX2FkbWluYC4gVGhlIG5vbWluYXRpb24gZG9lcyBub3QgdGFrZSBlZmZlY3QgdW50aWwKdGhlIHBlbmRpbmcgYWRtaW4gY2FsbHMgYGFjY2VwdF9hZG1pbmAuAAAAEm5vbWluYXRlX25ld19hZG1pbgAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAYtSZWdpc3RlciBhIG5ldyByZXNvdXJjZSB0b2dldGhlciB3aXRoIGFuIGltbXV0YWJsZSBkaWdlc3Qgb2YgaXRzCm9mZi1jaGFpbiBjb250ZW50LiBTdXBwbHlpbmcgYSBoYXNoIGJpbmRzIHRoZSBtZXRhZGF0YSBwb2ludGVyIHRvIHRoaXMKcmVnaXN0cmF0aW9uOiBgdXBkYXRlX21ldGFkYXRhYCBjYW5ub3QgY2hhbmdlIGl0IGFmdGVyd2FyZC4gUGFzc2luZwpgTm9uZWAgcHJlc2VydmVzIHRoZSBtdXRhYmxlIG1ldGFkYXRhIGJlaGF2aW9yIG9mIGByZWdpc3RlcmAuCgpSZWplY3RzIGFuIGVtcHR5IGhhc2ggb3Igb25lIGxvbmdlciB0aGFuIGBNQVhfQ09OVEVOVF9IQVNIX0xFTmAKKGBDb250ZW50SGFzaFRvb0xvbmdgKS4gQWxsIG90aGVyIHZhbGlkYXRpb24gbWF0Y2hlcyBgcmVnaXN0ZXJgLgAAAAAScmVnaXN0ZXJfd2l0aF9oYXNoAAAAAAAGAAAAAAAAAAdjcmVhdG9yAAAAABMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAACG1ldGFkYXRhAAAAEAAAAAAAAAAEdGFncwAAA+oAAAAQAAAAAAAAAAxjb250ZW50X2hhc2gAAAPoAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAcpSZWdpc3RlciBhIG5ldyByZXNvdXJjZSB0b2dldGhlciB3aXRoIGFuIG9wdGlvbmFsIGNvbnRlbnQgaGFzaCBhbmQgYW4Kb3B0aW9uYWwgMzItYnl0ZSBtZW1vIGhhc2guIFRoZSBtZW1vIGhhc2ggaXMgdGhlIHJlZ2lzdHJhdGlvbidzIGxpbmsgdG8KYW4gb2ZmLWNoYWluIHJlY29yZCAodHlwaWNhbGx5IHRoZSBgTUVNT19IQVNIYCBvZiB0aGUgU3RlbGxhcgp0cmFuc2FjdGlvbiB0aGF0IGFubm91bmNlZCBvciBwYWlkIGZvciBpdCkgYW5kIGlzIHdyaXR0ZW4gb25jZSBhdApyZWdpc3RyYXRpb247IG5vdGhpbmcgY2FuIGNoYW5nZSBpdCBhZnRlcndhcmRzLiBSZWFkIGl0IGJhY2sgd2l0aApgZ2V0X21lbW9faGFzaGAuIFdoZW4gcHJlc2VudCBpdCBpcyBhbHNvIGVtaXR0ZWQgaW4gYSBgcmVnbWVtb2AgZXZlbnQuCgpBbGwgb3RoZXIgdmFsaWRhdGlvbiBtYXRjaGVzIGByZWdpc3Rlcl93aXRoX2hhc2hgLgAAAAAAEnJlZ2lzdGVyX3dpdGhfbWVtbwAAAAAABwAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAhtZXRhZGF0YQAAABAAAAAAAAAABHRhZ3MAAAPqAAAAEAAAAAAAAAAMY29udGVudF9oYXNoAAAD6AAAABAAAAAAAAAACW1lbW9faGFzaAAAAAAAA+gAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAk9QZXJtYW5lbnRseSByZXRpcmUgYSByZXNvdXJjZS4gT25seSBhbiBhZG1pbiBtYXkgdG9tYnN0b25lIGl0OyB0aGUKdG9tYnN0b25lZCBzdGF0ZSBoYXMgbm8gb3V0Z29pbmcgdHJhbnNpdGlvbnMuCgpUb21ic3RvbmluZyBwdXJnZXMgdGhlIHJlc291cmNlIGZyb20gZXZlcnkgZGVyaXZlZCBsaXN0aW5nIGluZGV4IHRoZQpjb250cmFjdCBjYW4gcmVhY2ggaW4gYm91bmRlZCBnYXMg4oCUIHRoZSB0YWcgaW5kZXggYW5kIHRoZSBjcmVhdG9yCmluZGV4IOKAlCBzbyBpdCBzdG9wcyBzdXJmYWNpbmcgaW4gYGxpc3RfYnlfdGFnYCwgYGxpc3RfYnlfY3JlYXRvcmAsIGFuZApgY3JlYXRvcl9yZXNvdXJjZV9jb3VudGAuIFRoZSBjYW5vbmljYWwgYFJlc291cmNlYCBlbnRyeSBpcyBsZWZ0IGluCnBsYWNlIGFuZCBzdGF5cyByZWFkYWJsZSB0aHJvdWdoIGBnZXRgIGZvciBhdWRpdCwgYW5kIHRoZSBnbG9iYWwKYEluZGV4YC9gQ291bnRgIHBhaXIgaXMgZGVsaWJlcmF0ZWx5IHVudG91Y2hlZDogYENvdW50YCBpcyBtb25vdG9uaWMKYW5kIGZpbmRpbmcgYSByZXNvdXJjZSdzIHNsb3QgaW4gaXQgd291bGQgY29zdCBhbiB1bmJvdW5kZWQgc2Nhbi4AAAAAEnRvbWJzdG9uZV9yZXNvdXJjZQAAAAAAAgAAAAAAAAACaWQAAAAAABAAAAAAAAAABWFkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAAAAAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAACtJbnB1dCBmb3Igb25lIGl0ZW0gaW4gYSBiYXRjaCBwcmljZSB1cGRhdGUuAAAAAAAAAAAQQmF0Y2hQcmljZVVwZGF0ZQAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAluZXdfcHJpY2UAAAAAAAAL",
        "AAAAAQAAAAAAAAAAAAAAEEZlZUNvbmZpZ1VwZGF0ZWQAAAACAAAAAAAAAApuZXdfY29uZmlnAAAAAAfQAAAACUZlZUNvbmZpZwAAAAAAAAAAAAAKb2xkX2NvbmZpZwAAAAAH0AAAAAxPcHRGZWVDb25maWc=",
        "AAAAAQAAAAAAAAAAAAAAEFZlcmlmaWVyUm90YXRpb24AAAADAAAAAAAAAAZsZWRnZXIAAAAAAAQAAAAAAAAADG5ld192ZXJpZmllcgAAABMAAAAAAAAADG9sZF92ZXJpZmllcgAAABM=",
        "AAAAAAAAALBFeHRlbmQgdGhlIFRUTCBvZiBhIHJlc291cmNlJ3MgcGVyc2lzdGVudCBzdG9yYWdlIGVudHJ5LgoKT25seSB0aGUgcmVzb3VyY2UncyBjdXJyZW50IGNyZWF0b3IgKG93bmVyKSBtYXkgY2FsbCB0aGlzLgpFbWl0cyBhIGAidHRsZXh0ImAgZXZlbnQgd2l0aCB0aGUgYHJlc291cmNlX2lkYCBhcyBwYXlsb2FkLgAAABNleHRlbmRfcmVzb3VyY2VfdHRsAAAAAAIAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAAAAAAATZ2V0X2ZlZV9kZXN0aW5hdGlvbgAAAAAAAAAAAQAAB9AAAAAURmVlRGVzdGluYXRpb25Db25maWc=",
        "AAAAAAAAAQVGZXRjaCB0aGUgbW9zdCByZWNlbnQgcGF5bWVudCByZWNlaXB0IHJlY29yZGVkIGZvcgpgKHJlc291cmNlX2lkLCBwYXllcilgLCByZXNvbHZlZCB0aHJvdWdoIHRoZSBgUGF5bWVudEluZGV4YCBzZWNvbmRhcnkKaW5kZXguIEVycm9ycyBgTm90Rm91bmRgIHdoZW4gdGhhdCBwYWlyIGhhcyBubyByZWNvcmRlZCBwYXltZW50LgpCdW1wcyB0aGUgVFRMIG9mIGJvdGggdGhlIGluZGV4IGVudHJ5IGFuZCB0aGUgcmVjZWlwdCBvbiBhIHN1Y2Nlc3NmdWwKcmVhZC4AAAAAAAATZ2V0X3BheW1lbnRfcmVjZWlwdAAAAAACAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVwYXllcgAAAAAAABMAAAABAAAD6QAAB9AAAAAOUGF5bWVudFJlY2VpcHQAAAAAAAM=",
        "AAAAAAAABABSZWFjdGl2YXRlIGEgcmVzb3VyY2UgdGhhdCB3YXMgcmVzb2x2ZWQgb3V0IG9mIGEgZGlzcHV0ZSAob3Igb3RoZXJ3aXNlCmxlZnQgaW5hY3RpdmUpIGJhY2sgdG8gdGhlIHB1YmxpYyBgTGlzdGVkYCBzdGF0ZS4gT25seSB0aGUgY3JlYXRvciBtYXkKY2FsbCB0aGlzLCBhbmQgb25seSB3aGlsZSB0aGUgcmVzb3VyY2UgaXMgYEZyb3plbmAgb3IgYERlbGlzdGVkYC4KCmBEaXNwdXRlZGAgcmVzb3VyY2VzIGhhdmUgbm8gY3JlYXRvciBleGl0OiBhbiBhZG1pbiBtdXN0IHJlc29sdmUgdGhlCmRpc3B1dGUgZmlyc3QsIGFuZCBgVG9tYnN0b25lZGAgcmVzb3VyY2VzIGFyZSB0ZXJtaW5hbCDigJQgcmVhY3RpdmF0aW9uCmZyb20gZWl0aGVyIGZhaWxzIHdpdGggYEludmFsaWRMaWZlY3ljbGVUcmFuc2l0aW9uYC4KCk1pcnJvcnMgYHNldF9saXN0ZWQoaWQsIHRydWUpYCBmb3IgdGhlIGBEZWxpc3RlZGAgY2FzZSBidXQgaXMgdGhlIG9ubHkKY3JlYXRvciBwYXRoIG91dCBvZiBgRnJvemVuYCwgYW5kIGFsd2F5cyBmbGlwcyB0aGUgYGxpc3RlZGAgcHJvamVjdGlvbgphbmQgbGlzdGVkLWNvdW50IGluZGV4IGJhY2sgdG8gYWN0aXZlLgoKRW1pdHMgYSBgcmVhY3RpdmVgIGV2ZW50IHdob3NlIHRvcGljIGNhcnJpZXMgdGhlIHJlc291cmNlIGBpZGAuCgpFcnJvcnMgZGV0ZXJtaW5pc3RpY2FsbHk6Ci0gW2BFcnJvcjo6VW5hdXRob3JpemVkYF0g4oCUIGNhbGxlciBpcyBub3QgdGhlIHJlc291cmNlIGNyZWF0b3IKLSBbYEVycm9yOjpJbnZhbGlkTGlmZWN5Y2xlVHJhbnNpdGlvbmBdIOKAlCByZXNvdXJjZSBpcyBub3QgYEZyb3plbmAgb3IKYERlbGlzdGVkYCAoZS5nLiBzdGlsbCBgRGlzcHV0ZWRgLCBhbHJlYWR5IGBMaXN0ZWRgLCBvciBgVG9tYnN0b25lZGApCi0gW2BFcnJvcjo6SW52YWxpZFJlc291cmNlSWRgXSDigJQgYGlkYCBmYWlscyBmb3JtYXQgdmFsaWRhdGlvbgotIFtgRXJyb3I6Ok5vdEZvdW5kYF0g4oCUIGBpZGAgaXMgbm90IGEgcmVnaXN0ZXJlZCByZXNvdXJjZQotIFtgRXJyb3I6OkNvbnRyAAAAE3JlYWN0aXZhdGVfcmVzb3VyY2UAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAAAAAAATc2V0X2ZlZV9kZXN0aW5hdGlvbgAAAAABAAAAAAAAAAZjb25maWcAAAAAB9AAAAAURmVlRGVzdGluYXRpb25Db25maWcAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAADRJbnB1dCBmb3IgYSBzaW5nbGUgcmVzb3VyY2UgaW4gYSBiYXRjaCByZWdpc3RyYXRpb24uAAAAAAAAABFCYXRjaFJlZ2lzdGVySXRlbQAAAAAAAAUAAAAAAAAADGNvbnRlbnRfaGFzaAAAA+gAAAAQAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAIbWV0YWRhdGEAAAAQAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAABHRhZ3MAAAPqAAAAEA==",
        "AAAAAAAAAP9OdW1iZXIgb2YgcmVzb3VyY2VzIG93bmVkIGJ5IGBjcmVhdG9yYCB0aGF0IGFyZSBjdXJyZW50bHkgaW4gdGhlCmBMaXN0ZWRgIHN0YXRlLiBUaGUgcGVyLWNyZWF0b3IgY291bnRlcnBhcnQgb2YgYGxpc3RlZF9jb3VudGA6IGl0CmZvbGxvd3MgZXZlcnkgbGlzdGVkLXN0YXRlIHRyYW5zaXRpb24gKGRlbGlzdCwgZnJlZXplLCBkaXNwdXRlLApyZWFjdGl2YXRlLCB0b21ic3RvbmUpIGFuZCBtb3ZlcyBiZXR3ZWVuIG93bmVycyBvbiB0cmFuc2Zlci4AAAAAFGNyZWF0b3JfbGlzdGVkX2NvdW50AAAAAQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAQAAAAQ=",
        "AAAAAAAAAGtSZWFkIHRoZSBvZmYtY2hhaW4gYXR0ZXN0YXRpb24gaGFzaCBmb3IgYSByZXNvdXJjZSwgaWYgb25lIGhhcyBiZWVuIHJlY29yZGVkCnZpYSBgc2V0X3ZlcmlmaWNhdGlvbl9zdGF0dXNgLgAAAAAUZ2V0X2F0dGVzdGF0aW9uX2hhc2gAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPoAAAAEA==",
        "AAAAAAAAAGtGZXRjaCB0aGUgbW9kZXJhdG9yIGRpc3B1dGUgcmVhc29uIGhhc2ggc3RvcmVkIGZvciBhIHJlc291cmNlLgpFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIG5vbmUgaGFzIGJlZW4gc2V0LgAAAAAUZ2V0X2ZsYWdfcmVhc29uX2hhc2gAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAAEAAAAAM=",
        "AAAAAAAAADtGZXRjaCBhIHB1cmNoYXNlIHJlY2VpcHQgYW5jaG9yIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgLgAAAAAUZ2V0X3B1cmNoYXNlX3JlY2VpcHQAAAACAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVidXllcgAAAAAAABMAAAABAAAD6QAAB9AAAAAVUHVyY2hhc2VSZWNlaXB0QW5jaG9yAAAAAAAAAw==",
        "AAAAAAAAAElSZXR1cm4gdGhlIGxlZGdlciBzZXF1ZW5jZSBhdCB3aGljaCB0aGUgcGVuZGluZyBhZG1pbiBub21pbmF0aW9uIGV4cGlyZXMuAAAAAAAAFHBlbmRpbmdfYWRtaW5fZXhwaXJ5AAAAAAAAAAEAAAPoAAAABA==",
        "AAAAAAAAA7tTdG9yZSBhIGhhc2ggb2YgYSBtb2RlcmF0b3IncyBvZmYtY2hhaW4gZGlzcHV0ZSByZWFzb24gd3JpdGV1cCBmb3IgYQpyZXNvdXJjZS4gT25seSBhbiBhZGRyZXNzIGN1cnJlbnRseSBob2xkaW5nIHRoZSBtb2RlcmF0b3Igcm9sZSAoc2VlCmBhZGRfbW9kZXJhdG9yYCkgbWF5IGNhbGwgdGhpcy4KCkluZGVwZW5kZW50IG9mIGBmbGFnX3Jlc291cmNlYCdzIGBGbGFnUmVhc29uYCBjb2RlOiB0aGF0J3MgYSBmaXhlZCwKc21hbGwgZW51bTsgdGhpcyBjYXJyaWVzIGEgZGlnZXN0IG9mIGZyZWUtZm9ybSBvZmYtY2hhaW4gZGV0YWlsIChhCmxvbmdlciB3cml0ZXVwLCBldmlkZW5jZSBsaW5rcywgZXRjLiksIHRoZSBzYW1lIHBhdHRlcm4gYXMKYHNldF90ZXJtc19oYXNoYC4gQ2FsbGluZyB0aGlzIGFnYWluIGZvciB0aGUgc2FtZSByZXNvdXJjZSByZXBsYWNlcwp0aGUgc3RvcmVkIGhhc2guIERvZXMgbm90IHJlcXVpcmUgdGhlIHJlc291cmNlIHRvIGN1cnJlbnRseSBiZQpmbGFnZ2VkLCBzaW5jZSBhIG1vZGVyYXRvciBtYXkgd2FudCB0byBhdHRhY2ggZGV0YWlsIGJlZm9yZSBvciBhZnRlcgpjYWxsaW5nIGBmbGFnX3Jlc291cmNlYC4KCkVtaXRzIGEgYGZsYWdyc25gIGV2ZW50IHdpdGggYChtb2RlcmF0b3IsIHJlYXNvbl9oYXNoKWAuCgpFcnJvcnMgZGV0ZXJtaW5pc3RpY2FsbHk6Ci0gW2BFcnJvcjo6VW5hdXRob3JpemVkYF0g4oCUIGNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSBtb2RlcmF0b3Igcm9sZQotIFtgRXJyb3I6OkludmFsaWRSZXNvdXJjZUlkYF0g4oCUIGBpZGAgZmFpbHMgZm9ybWF0IHZhbGlkYXRpb24KLSBbYEVycm9yOjpOb3RGb3VuZGBdIOKAlCBgaWRgIGlzIG5vdCBhIHJlZ2lzdGVyZWQgcmVzb3VyY2UKLSBbYEVycm9yOjpGbGFnUmVhc29uSGFzaFRvb0xvbmdgXSDigJQgYHJlYXNvbl9oYXNoYCBleGNlZWRzIGBNQVhfRkxBR19SRUFTT05fSEFTSF9MRU5gAAAAABRzZXRfZmxhZ19yZWFzb25faGFzaAAAAAMAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAltb2RlcmF0b3IAAAAAAAATAAAAAAAAAAtyZWFzb25faGFzaAAAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAgAAAIpPbi1jaGFpbiBtaXJyb3Igb2YgdGhlIHNlcnZlcidzIG9mZi1jaGFpbiB2ZXJpZmljYXRpb24gcmVzdWx0LiBTZXR0YWJsZQpvbmx5IGJ5IGFuIGFkZHJlc3MgaG9sZGluZyB0aGUgdmVyaWZpZXIgcm9sZSAoc2VlIGBhZGRfdmVyaWZpZXJgKS4AAAAAAAAAAAASVmVyaWZpY2F0aW9uU3RhdHVzAAAAAAADAAAAAAAAAAAAAAAHUGVuZGluZwAAAAAAAAAAAAAAAAhWZXJpZmllZAAAAAAAAAAAAAAACFJlamVjdGVk",
        "AAAAAAAAAUpTZXQgYSBwZXItcmVzb3VyY2Ugcm95YWx0eSByZWNpcGllbnQgb3ZlcnJpZGUuIE9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwKdGhpcy4gV2hlbiBzZXQsIHJveWFsdGllcyBmb3IgdGhpcyByZXNvdXJjZSB3aWxsIGdvIHRvIHRoaXMgYWRkcmVzcyBpbnN0ZWFkCm9mIHRoZSBnbG9iYWwgYGZlZV9yZWNpcGllbnRgIGZyb20gYEZlZUNvbmZpZ2AuIFNldCB0byBgTm9uZWAgdG8gY2xlYXIgdGhlCm92ZXJyaWRlIGFuZCB1c2UgdGhlIGdsb2JhbCByZWNpcGllbnQuCgpFbWl0cyBhIGBzZXRyb3lhbGAgZXZlbnQgd2l0aCB0aGUgb2xkIGFuZCBuZXcgcmVjaXBpZW50IGFkZHJlc3Nlcy4AAAAAABVzZXRfcm95YWx0eV9yZWNpcGllbnQAAAAAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAJcmVjaXBpZW50AAAAAAAD6AAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAwAAAShXaHkgYW4gYGF0dGVtcHRfYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHRgIGNhbGwgY291bGQgbm90IHdyaXRlIGFuIGFuY2hvci4KClRoZSBkaXNjcmltaW5hbnRzIGFyZSBzdGFibGUg4oCUIGRvIG5vdCByZW51bWJlciBleGlzdGluZyB2YXJpYW50cy4gRWFjaAptYXBzIDE6MSB0byB0aGUgYEVycm9yYCB0aGF0IGBhbmNob3JfcHVyY2hhc2VfcmVjZWlwdGAgd291bGQgaGF2ZSByZXR1cm5lZApmb3IgdGhlIHNhbWUgaW5wdXQsIHNvIGEgY29uc3VtZXIgY2FuIHRyZWF0IHRoZSB0d28gcGF0aHMgaW50ZXJjaGFuZ2VhYmx5LgAAAAAAAAATQW5jaG9yRmFpbHVyZVJlYXNvbgAAAAADAAAAQk5vIHJlc291cmNlIGlzIHJlZ2lzdGVyZWQgdW5kZXIgYHJlc291cmNlX2lkYCAoYEVycm9yOjpOb3RGb3VuZGApLgAAAAAAEFJlc291cmNlTm90Rm91bmQAAAAAAAAATmByZWNlaXB0X2hhc2hgIGlzIGVtcHR5IG9yIGV4Y2VlZHMgYE1BWF9UWF9IQVNIX0xFTmAKKGBFcnJvcjo6SW52YWxpZFR4SGFzaGApLgAAAAAAEkludmFsaWRSZWNlaXB0SGFzaAAAAAAAAQAAAFBBbiBhbmNob3IgYWxyZWFkeSBleGlzdHMgZm9yIGAocmVzb3VyY2VfaWQsIGJ1eWVyKWAKKGBFcnJvcjo6RHVwbGljYXRlUmVjZWlwdGApLgAAABBEdXBsaWNhdGVSZWNlaXB0AAAAAg==",
        "AAAAAQAAAIZSZXN1bHQgb2YgYSBiYXRjaCByZWdpc3RyYXRpb24gYXR0ZW1wdC4gQ29udGFpbnMgc3VjY2Vzc2Z1bGx5IHJlZ2lzdGVyZWQKcmVzb3VyY2UgSURzIGFuZCBhbnkgZXJyb3JzIGVuY291bnRlcmVkICh3aXRoIHRoZWlyIGluZGljZXMpLgAAAAAAAAAAABNCYXRjaFJlZ2lzdGVyUmVzdWx0AAAAAAIAAABTSW5kaWNlcyAoaW50byB0aGUgaW5wdXQgYmF0Y2gpIG9mIGl0ZW1zIHRoYXQgZmFpbGVkLCBwYWlyZWQgd2l0aCB0aGVpciBlcnJvciBjb2Rlcy4AAAAABmZhaWxlZAAAAAAD6gAAA+0AAAACAAAABAAAAAQAAAA6UmVzb3VyY2UgSURzIHRoYXQgd2VyZSBzdWNjZXNzZnVsbHkgcmVnaXN0ZXJlZCAoaW4gb3JkZXIpLgAAAAAACXN1Y2NlZWRlZAAAAAAAA+oAAAAQ",
        "AAAAAQAAAOtFdmVudCBkYXRhIGVtaXR0ZWQgd2hlbiBhIHJlc291cmNlJ3MgbWV0YWRhdGEgcG9pbnRlciBpcyB1cGRhdGVkLgpDYXJyaWVzIHRoZSByZXNvdXJjZSBpZCwgdGhlIHByZXZpb3VzIG1ldGFkYXRhIHBvaW50ZXIsIGFuZCB0aGUgbmV3IG9uZQpzbyB0aGF0IG9mZi1jaGFpbiBpbmRleGVycyBjYW4gYnVpbGQgYSBmdWxsIGF1ZGl0IHRyYWlsIHdpdGhvdXQgcXVlcnlpbmcKaGlzdG9yaWNhbCBsZWRnZXIgc3RhdGUuAAAAAAAAAAATTWV0YWRhdGFVcGRhdGVFdmVudAAAAAADAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAMbmV3X21ldGFkYXRhAAAAEAAAAAAAAAAMb2xkX21ldGFkYXRhAAAAEA==",
        "AAAAAAAAAJ5OdW1iZXIgb2YgcmVzb3VyY2VzIGN1cnJlbnRseSBvd25lZCBieSBgY3JlYXRvcmAgKG1vdmVzIHdpdGgKYHRyYW5zZmVyX293bmVyc2hpcGAvYGFjY2VwdF90cmFuc2ZlcmA7IHVucmVsYXRlZCB0byB0aGUgbW9ub3RvbmljLApuZXZlci1kZWNyZW1lbnRlZCBgY291bnQoKWApLgAAAAAAFmNyZWF0b3JfcmVzb3VyY2VfY291bnQAAAAAAAEAAAAAAAAAB2NyZWF0b3IAAAAAEwAAAAEAAAAE",
        "AAAAAAAAAQZQYWdpbmF0ZWQgbGlzdCBvZiByZXNvdXJjZXMgZmlsdGVyZWQgYnkgYWN0aXZlIG1vZGVyYXRvciBkaXNwdXRlIGZsYWcuCgpgZmxhZ2dlZCA9IHRydWVgIHJldHVybnMgcmVzb3VyY2VzIHdpdGggYERpc3B1dGVGbGFnOjpGbGFnZ2VkKF8pYDsKYGZsYWdnZWQgPSBmYWxzZWAgcmV0dXJucyByZXNvdXJjZXMgd2l0aCBgRGlzcHV0ZUZsYWc6Ok5vRmxhZ2AuCmBzdGFydGAgaXMgYSBnbG9iYWwgY2F0YWxvZyBjdXJzb3IsIG1hdGNoaW5nIGBsaXN0X2xpc3RlZGAuAAAAAAAWbGlzdF9ieV9kaXNwdXRlX3N0YXR1cwAAAAAAAwAAAAAAAAAHZmxhZ2dlZAAAAAABAAAAAAAAAAVzdGFydAAAAAAAAAQAAAAAAAAABWxpbWl0AAAAAAAABAAAAAEAAAPqAAAH0AAAAAhSZXNvdXJjZQ==",
        "AAAAAQAAAAAAAAAAAAAAFEZlZURlc3RpbmF0aW9uQ29uZmlnAAAAAgAAAAAAAAADYnBzAAAAAAQAAAAAAAAAC2Rlc3RpbmF0aW9uAAAAB9AAAAAORmVlRGVzdGluYXRpb24AAA==",
        "AAAAAAAAAPlBbmNob3IgYSBwdXJjaGFzZSByZWNlaXB0IGhhc2ggZm9yIGAocmVzb3VyY2VfaWQsIGJ1eWVyKWAuCgpUaGlzIGlzIGltbXV0YWJsZTogZHVwbGljYXRlIGFuY2hvcnMgZm9yIHRoZSBzYW1lIHBhaXIgZXJyb3Igd2l0aApgRHVwbGljYXRlUmVjZWlwdGAsIHNvIGRvd25zdHJlYW0gc2VydmljZXMgY2FuIHRyZWF0IHRoZSBmaXJzdCBhbmNob3IgYXMKY2Fub25pY2FsLiBUaGUgY2FsbGVyIG11c3QgaG9sZCB0aGUgdmVyaWZpZXIgcm9sZS4AAAAAAAAXYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHQAAAAABAAAAAAAAAAHc2VydmljZQAAAAATAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVidXllcgAAAAAAABMAAAAAAAAADHJlY2VpcHRfaGFzaAAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAVRVcGRhdGUgYSByZXNvdXJjZSdzIG9uLWNoYWluIHZlcmlmaWNhdGlvbiBzdGF0dXMuIE9ubHkgYW4gYWRkcmVzcwpjdXJyZW50bHkgaG9sZGluZyB0aGUgdmVyaWZpZXIgcm9sZSAoc2VlIGBhZGRfdmVyaWZpZXJgKSBtYXkgY2FsbAp0aGlzLiBPbmx5IGBQZW5kaW5nIC0+IFZlcmlmaWVkYCwgYFBlbmRpbmcgLT4gUmVqZWN0ZWRgLApgVmVyaWZpZWQgLT4gUmVqZWN0ZWRgLCBhbmQgYFJlamVjdGVkIC0+IFZlcmlmaWVkYCBhcmUgYWxsb3dlZDsKc2VsZi10cmFuc2l0aW9ucyBhbmQgcmV2ZXJ0aW5nIHRvIGBQZW5kaW5nYCBlcnJvciB3aXRoCmBJbnZhbGlkVmVyaWZpY2F0aW9uVHJhbnNpdGlvbmAuAAAAF3NldF92ZXJpZmljYXRpb25fc3RhdHVzAAAAAAQAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAh2ZXJpZmllcgAAABMAAAAAAAAABnN0YXR1cwAAAAAH0AAAABJWZXJpZmljYXRpb25TdGF0dXMAAAAAAAAAAAAQYXR0ZXN0YXRpb25faGFzaAAAA+gAAAAQAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAQAAAAAAAAAAAAAAFUZlZURlc3RpbmF0aW9uVXBkYXRlZAAAAAAAAAMAAAAAAAAABmxlZGdlcgAAAAAABAAAAAAAAAAPbmV3X2Rlc3RpbmF0aW9uAAAAB9AAAAAURmVlRGVzdGluYXRpb25Db25maWcAAAAAAAAAD29sZF9kZXN0aW5hdGlvbgAAAAfQAAAAFEZlZURlc3RpbmF0aW9uQ29uZmln",
        "AAAAAQAAADZJbW11dGFibGUgb24tY2hhaW4gYW5jaG9yIGZvciBhIHB1cmNoYXNlIHJlY2VpcHQgaGFzaC4AAAAAAAAAAAAVUHVyY2hhc2VSZWNlaXB0QW5jaG9yAAAAAAAABAAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAAAZsZWRnZXIAAAAAAAQAAAAAAAAADHJlY2VpcHRfaGFzaAAAABAAAAAAAAAAC3Jlc291cmNlX2lkAAAAABA=",
        "AAAAAAAAAVRQYWdpbmF0ZWQgbGlzdCBvZiByZXNvdXJjZXMgZmlsdGVyZWQgYnkgdmVyaWZpY2F0aW9uIHN0YXR1cy4KClJldHVybnMgcmVzb3VyY2VzIHdob3NlIGB2ZXJpZmllZGAgZmllbGQgbWF0Y2hlcyBgc3RhdHVzYC4KYGN1cnNvcmAgaXMgYSBnbG9iYWwgY2F0YWxvZyBpbmRleCAoc2FtZSBzZW1hbnRpY3MgYXMgYGxpc3RfcGFnZWApLgpgbGltaXRgIGlzIGNhcHBlZCBhdCAyMC4KUmV0dXJucyBhIGBDYXRhbG9nUGFnZWAgd2l0aCBgaXRlbXNgIChtYXRjaGluZyByZXNvdXJjZXMpIGFuZApgbmV4dF9jdXJzb3JgIChuZXh0IGNhdGFsb2cgcG9zaXRpb24sIG9yIGBOb25lYCBhdCBlbmQtb2YtbGlzdCkuAAAAG2xpc3RfYnlfdmVyaWZpY2F0aW9uX3N0YXR1cwAAAAADAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAASVmVyaWZpY2F0aW9uU3RhdHVzAAAAAAAAAAAABmN1cnNvcgAAAAAABAAAAAAAAAAFbGltaXQAAAAAAAAEAAAAAQAAB9AAAAALQ2F0YWxvZ1BhZ2UA",
        "AAAAAAAAA1dBdHRlbXB0IHRvIGFuY2hvciBhIHB1cmNoYXNlIHJlY2VpcHQsIHJlcG9ydGluZyBhIHJlamVjdGVkIGF0dGVtcHQgYXMKYW4gb24tY2hhaW4gYGFuY2hyZmFpbGAgZXZlbnQgaW5zdGVhZCBvZiByZXZlcnRpbmcuCgpgYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHRgIHJldHVybnMgYW4gYEVycm9yYCB3aGVuIHRoZSBhdHRlbXB0IGlzIG5vdAphbmNob3JhYmxlLCBhbmQgYSBTb3JvYmFuIGVycm9yIHJvbGxzIHRoZSB3aG9sZSBpbnZvY2F0aW9uIGJhY2sg4oCUCmV2ZW50cyBpbmNsdWRlZCDigJQgc28gYSBzZXR0bGVtZW50IHNlcnZpY2UgYmF0Y2hpbmcgbWFueSBhbmNob3JzIGxvc2VzCmJvdGggdGhlIHN1cnZpdmluZyBhbmNob3JzIGFuZCBhbnkgb24tY2hhaW4gdHJhY2Ugb2Ygd2hhdCBmYWlsZWQuIFRoaXMKdmFyaWFudCBrZWVwcyBhdXRob3JpemF0aW9uIHN0cmljdCAoYSBub24tdmVyaWZpZXIgc3RpbGwgcmV2ZXJ0cywgYW5kCnNvIGRvZXMgYSBtYWxmb3JtZWQgYHJlc291cmNlX2lkYCkgYnV0IHR1cm5zIHRoZSB0aHJlZSAqZGF0YSogZmFpbHVyZXMK4oCUIHVua25vd24gcmVzb3VyY2UsIHVudXNhYmxlIHJlY2VpcHQgaGFzaCwgYW5kIGFuIGFscmVhZHktYW5jaG9yZWQKYChyZXNvdXJjZV9pZCwgYnV5ZXIpYCBwYWlyIOKAlCBpbnRvIGFuIFtgQW5jaG9yRmFpbHVyZWBdIGV2ZW50IHBsdXMgYQpgZmFsc2VgIHJldHVybiwgc28gbW9uaXRvcnMgY2FuIHNlZSB0aGUgcmVqZWN0ZWQgYXR0ZW1wdCBhbmQgaXRzCnJlYXNvbiB3aXRob3V0IHJlcGxheWluZyB0aGUgY2FsbGVyJ3MgbG9ncy4KClJldHVybnMgYHRydWVgIGFuZCBlbWl0cyB0aGUgdXN1YWwgYGFuY2hvcmAgZXZlbnQgb24gc3VjY2Vzcy4AAAAAH2F0dGVtcHRfYW5jaG9yX3B1cmNoYXNlX3JlY2VpcHQAAAAABAAAAAAAAAAHc2VydmljZQAAAAATAAAAAAAAAAtyZXNvdXJjZV9pZAAAAAAQAAAAAAAAAAVidXllcgAAAAAAABMAAAAAAAAADHJlY2VpcHRfaGFzaAAAABAAAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAANNPdmVycmlkZSBhIHB1cmNoYXNlIHJlY2VpcHQgYW5jaG9yIGZvciBgKHJlc291cmNlX2lkLCBidXllcilgLgoKVGhpcyBtZXRob2QgYWxsb3dzIGEgdmVyaWZpZXIgdG8gZm9yY2libHkgdXBkYXRlIGFuIGV4aXN0aW5nIHB1cmNoYXNlIHJlY2VpcHQKYW5jaG9yIGZvciBhIGdpdmVuIGJ1eWVyLiBJZiBubyBhbmNob3IgZXhpc3RzLCBpdCByZXR1cm5zIGBOb3RGb3VuZGAuAAAAACBvdmVycmlkZV9wdXJjaGFzZV9yZWNlaXB0X2FuY2hvcgAAAAQAAAAAAAAAB3NlcnZpY2UAAAAAEwAAAAAAAAALcmVzb3VyY2VfaWQAAAAAEAAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAABBuZXdfcmVjZWlwdF9oYXNoAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD" ]),
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
        get_owner: this.txFromJSON<Result<string>>,
        is_paused: this.txFromJSON<boolean>,
        list_page: this.txFromJSON<CatalogPage>,
        set_price: this.txFromJSON<Result<void>>,
        is_settler: this.txFromJSON<boolean>,
        network_id: this.txFromJSON<Result<Buffer>>,
        set_listed: this.txFromJSON<Result<void>>,
        set_paused: this.txFromJSON<Result<void>>,
        add_settler: this.txFromJSON<Result<void>>,
        exists_many: this.txFromJSON<Array<boolean>>,
        get_payment: this.txFromJSON<Result<PaymentReceipt>>,
        is_verifier: this.txFromJSON<boolean>,
        list_by_tag: this.txFromJSON<Array<Resource>>,
        list_listed: this.txFromJSON<Array<Resource>>,
        pause_until: this.txFromJSON<Option<u64>>,
        accept_admin: this.txFromJSON<Result<void>>,
        add_verifier: this.txFromJSON<Result<void>>,
        is_moderator: this.txFromJSON<boolean>,
        listed_count: this.txFromJSON<u32>,
        open_dispute: this.txFromJSON<Result<void>>,
        repair_index: this.txFromJSON<Result<void>>,
        add_moderator: this.txFromJSON<Result<void>>,
        flag_resource: this.txFromJSON<Result<void>>,
        get_memo_hash: this.txFromJSON<Option<Buffer>>,
        pending_admin: this.txFromJSON<Option<string>>,
        registry_info: this.txFromJSON<RegistryInfo>,
        get_fee_config: this.txFromJSON<Option<FeeConfig>>,
        get_owner_many: this.txFromJSON<Result<Array<Option<string>>>>,
        get_terms_hash: this.txFromJSON<Result<string>>,
        record_payment: this.txFromJSON<Result<void>>,
        register_batch: this.txFromJSON<Result<BatchRegisterResult>>,
        remove_settler: this.txFromJSON<Result<void>>,
        settle_payment: this.txFromJSON<Result<void>>,
        set_fee_config: this.txFromJSON<Result<void>>,
        set_price_many: this.txFromJSON<Result<void>>,
        set_terms_hash: this.txFromJSON<Result<void>>,
        accept_transfer: this.txFromJSON<Result<void>>,
        cancel_transfer: this.txFromJSON<Result<void>>,
        freeze_metadata: this.txFromJSON<Result<void>>,
        freeze_resource: this.txFromJSON<Result<void>>,
        list_by_creator: this.txFromJSON<Array<Resource>>,
        remove_verifier: this.txFromJSON<Result<void>>,
        resolve_dispute: this.txFromJSON<Result<void>>,
        rotate_verifier: this.txFromJSON<Result<void>>,
        unflag_resource: this.txFromJSON<Result<void>>,
        update_metadata: this.txFromJSON<Result<void>>,
        contract_version: this.txFromJSON<ContractVersion>,
        emergency_delist: this.txFromJSON<Result<void>>,
        propose_transfer: this.txFromJSON<Result<void>>,
        remove_moderator: this.txFromJSON<Result<void>>,
        repair_tag_index: this.txFromJSON<Result<void>>,
        set_paused_until: this.txFromJSON<Result<void>>,
        set_fee_recipient: this.txFromJSON<Result<void>>,
        get_resource_state: this.txFromJSON<Result<ResourceState>>,
        initialize_network: this.txFromJSON<Result<void>>,
        nominate_new_admin: this.txFromJSON<Result<void>>,
        register_with_hash: this.txFromJSON<Result<void>>,
        register_with_memo: this.txFromJSON<Result<void>>,
        tombstone_resource: this.txFromJSON<Result<void>>,
        transfer_ownership: this.txFromJSON<Result<void>>,
        extend_resource_ttl: this.txFromJSON<Result<void>>,
        get_fee_destination: this.txFromJSON<FeeDestinationConfig>,
        get_payment_receipt: this.txFromJSON<Result<PaymentReceipt>>,
        reactivate_resource: this.txFromJSON<Result<void>>,
        set_fee_destination: this.txFromJSON<Result<void>>,
        creator_listed_count: this.txFromJSON<u32>,
        get_attestation_hash: this.txFromJSON<Option<string>>,
        get_flag_reason_hash: this.txFromJSON<Result<string>>,
        get_purchase_receipt: this.txFromJSON<Result<PurchaseReceiptAnchor>>,
        pending_admin_expiry: this.txFromJSON<Option<u32>>,
        set_flag_reason_hash: this.txFromJSON<Result<void>>,
        set_royalty_recipient: this.txFromJSON<Result<void>>,
        creator_resource_count: this.txFromJSON<u32>,
        list_by_dispute_status: this.txFromJSON<Array<Resource>>,
        anchor_purchase_receipt: this.txFromJSON<Result<void>>,
        set_verification_status: this.txFromJSON<Result<void>>,
        list_by_verification_status: this.txFromJSON<CatalogPage>,
        attempt_anchor_purchase_receipt: this.txFromJSON<Result<boolean>>,
        override_purchase_receipt_anchor: this.txFromJSON<Result<void>>
  }
}