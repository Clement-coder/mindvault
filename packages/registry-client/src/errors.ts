/**
 * The vault-registry contract's error codes.
 *
 * The contract declares its error enum with `#[contracterror(export = false)]`
 * (`contract/contracts/vault-registry/src/lib.rs`): the enum carries more than
 * the 50 cases the XDR contract spec allows, so it is not part of the spec
 * and the generated bindings ship no error table. The discriminants are still
 * the on-wire codes a failed invocation returns, so this table mirrors the
 * contract's `ERROR_SCHEMA` and `errors.test.ts` fails when the two drift.
 *
 * Do not edit by hand: change `ERROR_SCHEMA` in the contract and re-run the
 * generator in `errors.test.ts` (or copy the table from the contract).
 */
export const Errors = {
  1: { message: "AlreadyRegistered" },
  2: { message: "NotFound" },
  3: { message: "InvalidPrice" },
  4: { message: "MetadataTooLong" },
  5: { message: "InvalidTag" },
  6: { message: "Unauthorized" },
  7: { message: "PendingAdminNotSet" },
  8: { message: "PendingAdminAlreadySet" },
  9: { message: "SameAdmin" },
  10: { message: "TermsHashTooLong" },
  11: { message: "InvalidResourceId" },
  12: { message: "InvalidMetadataPointer" },
  13: { message: "EmptyMetadata" },
  14: { message: "AlreadyOwner" },
  15: { message: "NoPendingTransfer" },
  16: { message: "ReservedId" },
  17: { message: "PriceExceedsMax" },
  18: { message: "AdminNotSet" },
  19: { message: "NotVerifier" },
  20: { message: "InvalidVerificationTransition" },
  21: { message: "AlreadyFrozen" },
  22: { message: "MetadataFrozen" },
  23: { message: "DuplicateInRepair" },
  24: { message: "InvalidTxHash" },
  25: { message: "InvalidPaymentAmount" },
  26: { message: "NotModerator" },
  27: { message: "AlreadyFlagged" },
  28: { message: "NotFlagged" },
  29: { message: "InvalidLifecycleTransition" },
  30: { message: "ResourceNotMutable" },
  31: { message: "NetworkAlreadyInitialized" },
  32: { message: "NetworkIdMismatch" },
  33: { message: "NetworkNotInitialized" },
  34: { message: "FeeBpsTooHigh" },
  35: { message: "TotalFeeTooHigh" },
  36: { message: "CountOverflow" },
  37: { message: "BatchTooLarge" },
  38: { message: "DuplicateReceipt" },
  39: { message: "FlagReasonHashTooLong" },
  40: { message: "ContractPaused" },
  41: { message: "NotSettler" },
  42: { message: "ReceiptAlreadyExists" },
  43: { message: "InvalidPaymentTransition" },
  44: { message: "InvalidReceiptId" },
  45: { message: "ContentHashTooLong" },
  46: { message: "AttestationHashTooLong" },
  47: { message: "PaymentAmountMismatch" },
  48: { message: "DuplicateTxHash" },
  49: { message: "FeeConfigNotSet" },
  50: { message: "AdminNominationExpired" },
  51: { message: "InvalidMetadataPointers" },
  52: { message: "AdminAlreadySet" },
  53: { message: "RecoveryAdminNotSet" },
  54: { message: "UnsupportedResourceSchema" },
  55: { message: "RevisionOverflow" },
} as const;

/** A vault-registry error code (the on-chain discriminant). */
export type RegistryErrorCode = keyof typeof Errors;

/** The name of a vault-registry error, e.g. `"NotFound"`. */
export type RegistryErrorName = (typeof Errors)[RegistryErrorCode]["message"];

/**
 * The contract's own description for each error code.
 *
 * The third element of the contract's `ERROR_SCHEMA` triples. It is mirrored
 * here for the same reason the names are: the contract's error enum is not
 * spec-exported, so there is no generated table to read at runtime, and an
 * agent that only has the numeric code has no way to learn what the code
 * means. `errors.test.ts` fails when this drifts from the contract.
 */
export const ERROR_DESCRIPTIONS = {
  1: "A resource with the given `id` or the target verifier already exists, or the holder already has a pending or unexpired active lease on the resource (`buy_lease` / `record_lease`).",
  2: "No resource (or terms hash, receipt, or old verifier) matches the given key.",
  3: "Price is `<= 0`, exceeds `MAX_PRICE`, or is not strictly greater than the combined active `platform_fee_bps + royalty_bps` (creator-share invariant).",
  4: "Metadata pointer exceeds `MAX_METADATA_POINTER_LEN` (512 bytes).",
  5: "Tag validation failed (too many tags, empty tag, tag exceeds 32 bytes, or duplicate normalized tag).",
  6: "Caller is unauthorized, including a refund recipient mismatch.",
  7: "No pending admin is set, or caller does not match the pending admin.",
  8: "A pending admin nomination is already active.",
  9: "Nominated new admin is already the current contract admin.",
  10: "Terms hash exceeds `MAX_TERMS_HASH_LEN` (64 bytes).",
  11: "Resource id is empty, exceeds 24 bytes, or contains non-lowercase-alphanumeric characters.",
  12: "Metadata pointer does not start with a supported prefix.",
  13: "Metadata pointer is empty.",
  14: "Proposed/target new owner is already the current owner.",
  15: "No pending transfer exists for this resource.",
  16: "Resource id collides with a reserved word (e.g. `admin`, `registry`).",
  17: "Price exceeds `MAX_PRICE`.",
  18: "`add_verifier`, `remove_verifier`, `rotate_verifier`, or `repair_index` was called before any admin was bootstrapped.",
  19: "`set_verification_status` was called by an address that does not hold the verifier role.",
  20: "The requested `VerificationStatus` transition is not allowed (e.g. same-status no-op, or reverting to `Pending`).",
  21: "`freeze_metadata` was called on a resource whose metadata is already frozen.",
  22: "`update_metadata` was called on a resource whose metadata has been frozen.",
  23: "`repair_index` received a list with duplicate resource ids.",
  24: "A payment or refund `tx_hash` is empty or exceeds `MAX_TX_HASH_LEN` (128 bytes).",
  25: "A payment or refund `amount` is `<= 0`, or a refund window is outside its allowed bounds.",
  26: "Caller does not hold the moderator role.",
  27: "Resource is already flagged as disputed.",
  28: "Resource is not currently flagged as disputed.",
  29: "The requested lifecycle transition is not allowed from the current state.",
  30: "A frozen, disputed, or tombstoned resource cannot be changed by its creator, and a resource that is not `Listed` (delisted, frozen, disputed, or tombstoned) cannot accept a payment (`record_payment`) or a lease (`buy_lease` / `record_lease`).",
  31: "Network identifier has already been initialized for this contract instance.",
  32: "Invocation network identifier does not match configured network ID.",
  33: "Network identifier has not been initialized.",
  34: "A fee or fee-destination basis-point value exceeds its configured ceiling.",
  35: "The combined fee policy or fee-destination split is invalid.",
  36: "The global resource count would overflow `u32`.",
  37: "A bounded batch read was called with more than its documented maximum number of ids.",
  38: "A purchase receipt is already anchored for `(resource_id, buyer)`.",
  39: "`reason_hash` in `set_flag_reason_hash` exceeds `MAX_FLAG_REASON_HASH_LEN` (64 bytes).",
  40: "A state-changing method was called while the registry is paused.",
  41: "Caller does not hold the settler role.",
  42: "A payment or refund receipt is already stored for the supplied id.",
  43: "Payment is not settled, its creator refund deadline has expired, or a payment state transition is not allowed.",
  44: "`receipt_id` is empty or exceeds `MAX_RECEIPT_ID_LEN` (64 bytes).",
  45: "`content_hash` exceeds `MAX_CONTENT_HASH_LEN` (128 bytes).",
  46: "`attestation_hash` exceeds `MAX_ATTESTATION_HASH_LEN` (64 bytes).",
  47: "Payment amount differs from the resource price or cumulative refunds exceed the original payment.",
  48: "A payment or refund receipt already uses the supplied transaction hash (`tx_hash`).",
  49: "`set_fee_recipient` or `set_fee_destination` was called before any fee config was set via `set_fee_config`.",
  50: "The pending admin nomination is missing or has expired.",
  51: "`set_metadata_pointers` received zero, more than `MAX_METADATA_POINTERS`, or duplicate pointers, or an out-of-range `primary` index.",
  52: "`bootstrap_dual_admin` was called after an admin was already set.",
  53: "`recover_admin` was called but no recovery admin is configured.",
  54: "A resource uses a schema version this deployment cannot safely read or upgrade.",
  55: "A listing revision increment would exceed `u32::MAX`; the mutation is rejected without changing resource state.",
} as const;

/**
 * The error name for a code, or `undefined` when the code is unknown.
 *
 * Used to compare a failed invocation's error message against the contract's
 * error names without hardcoding a literal at every call site.
 */
export function registryErrorName(code: number): RegistryErrorName | undefined {
  return (Errors as Record<number, { message: RegistryErrorName }>)[code]?.message;
}

/**
 * The contract's description for a code, or `undefined` when the code is
 * unknown.
 */
export function registryErrorDescription(code: number): string | undefined {
  return (ERROR_DESCRIPTIONS as Record<number, string>)[code];
}

/**
 * The code for an error name, or `undefined` when the name is unknown.
 *
 * The inverse of {@link registryErrorName}, so a caller that only has the
 * name — a failed invocation's error string, for instance — can still reach
 * the description.
 */
export function registryErrorCodeForName(name: string): number | undefined {
  const entry = Object.entries(Errors).find(
    ([, error]) => (error as { message: string }).message === name,
  );
  return entry ? Number(entry[0]) : undefined;
}
