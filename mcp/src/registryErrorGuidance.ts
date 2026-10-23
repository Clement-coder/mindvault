/**
 * Recovery guidance for the vault-registry's contract error codes — issue #1021.
 *
 * A failed Soroban invocation comes back as a number. `2` means nothing to an
 * agent: it cannot tell "the resource does not exist" from "the caller is not
 * allowed to do this" from "the registry is paused", so it cannot decide
 * whether to look the resource up, ask for a role, or wait and retry.
 *
 * This module answers that question for every code the contract defines:
 *
 *  - the contract's own description (mirrored in `@mindvault/registry-client`,
 *    so it is the same text the contract carries),
 *  - the family the error belongs to,
 *  - whether repeating the identical call can help, and
 *  - the one step that recovers.
 *
 * The retry verdict uses the same three values as the MCP error codes
 * (`safe` / `unsafe` / `conditional`), so an agent that already knows that
 * vocabulary from `MV_*` failures knows it here too.
 *
 * A code this build does not know is never hidden: it comes back with
 * `known: false`, the code as asked, and the list of codes that do exist, so
 * the agent can correct itself instead of guessing.
 */

import {
  ERROR_DESCRIPTIONS,
  Errors,
  registryErrorCodeForName,
  registryErrorDescription,
  registryErrorName,
} from "@mindvault/registry-client";

/** The family a contract error belongs to. */
export type RegistryErrorCategory =
  | "registration"
  | "validation"
  | "authorization"
  | "admin"
  | "payment"
  | "moderation"
  | "network";

/**
 * Whether repeating the identical call can help.
 *
 * - `safe` — repeat freely once the cause is addressed; nothing was written.
 * - `unsafe` — an identical retry fails identically, or the desired state
 *   already holds.
 * - `conditional` — it depends on state the error alone does not reveal: a
 *   role that may be granted, a nomination that may arrive, a pause that may
 *   be lifted.
 */
export type RegistryErrorRetry = "safe" | "unsafe" | "conditional";

/** One error's recovery guidance. */
export interface RegistryErrorGuidance {
  /** The family the error belongs to. */
  category: RegistryErrorCategory;
  /** Whether an identical retry can help. */
  retry: RegistryErrorRetry;
  /** The one step that recovers. */
  nextSteps: string;
}

/**
 * The guidance for every error the contract defines, keyed by error name.
 *
 * The names are the contract's, not this module's, so a lookup by name and a
 * lookup by code land on the same entry.
 */
export const REGISTRY_ERROR_GUIDANCE: Record<string, RegistryErrorGuidance> = {
  AlreadyRegistered: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "The resource id is already taken, or a lease for it already exists. Look the id up " +
      "with mindvault_registry_lookup and use the existing resource, or pick a different id.",
  },
  NotFound: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "No resource matches that id. Verify the id with mindvault_registry_lookup before " +
      "retrying — a typo and an unregistered resource look identical from here.",
  },
  InvalidPrice: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The price must be positive, at most MAX_PRICE, and strictly greater than the combined " +
      "platform fee and royalty. Lower the price or reduce the fee split, then retry.",
  },
  MetadataTooLong: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The metadata pointer exceeds the 512-byte limit. Use a shorter pointer — a compact " +
      "IPFS URI or URL — and retry.",
  },
  InvalidTag: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "Tags must be 1–32 bytes, lowercase, unique after normalization, and at most 8 of " +
      "them. Fix the tag list and retry.",
  },
  Unauthorized: {
    category: "authorization",
    retry: "conditional",
    nextSteps:
      "The caller is not authorized for this resource, or the refund recipient does not " +
      "match. Confirm the signing account owns the resource; if a role is missing, it has " +
      "to be granted before the call can succeed.",
  },
  PendingAdminNotSet: {
    category: "admin",
    retry: "conditional",
    nextSteps:
      "There is no pending admin nomination, or the caller is not the nominated admin. " +
      "Nominate an admin (and call as the nominee) before retrying.",
  },
  PendingAdminAlreadySet: {
    category: "admin",
    retry: "unsafe",
    nextSteps:
      "A pending admin nomination is already active. Complete the pending transfer or let " +
      "it expire before nominating someone else.",
  },
  SameAdmin: {
    category: "admin",
    retry: "unsafe",
    nextSteps: "The nominated admin is already the current admin. Nominate a different address.",
  },
  TermsHashTooLong: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The terms hash exceeds 64 bytes. Pass the 32-byte hash as 64 hex characters, with " +
      "no prefix.",
  },
  InvalidResourceId: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "Resource ids must be 1–24 lowercase letters or digits. Use a conforming id and retry.",
  },
  InvalidMetadataPointer: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The metadata pointer must start with a supported prefix (ipfs://, ar://, https://, or " +
      "a supported digest form). Fix the pointer and retry.",
  },
  EmptyMetadata: {
    category: "validation",
    retry: "unsafe",
    nextSteps: "The metadata pointer is empty. Supply the pointer and retry.",
  },
  AlreadyOwner: {
    category: "registration",
    retry: "unsafe",
    nextSteps: "The proposed owner is already the current owner. Nominate a different address.",
  },
  NoPendingTransfer: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "There is no pending ownership transfer for this resource. Start the transfer before " +
      "accepting it.",
  },
  ReservedId: {
    category: "registration",
    retry: "unsafe",
    nextSteps: "The id collides with a reserved word. Choose a different id and retry.",
  },
  PriceExceedsMax: {
    category: "validation",
    retry: "unsafe",
    nextSteps: "The price exceeds the contract's MAX_PRICE. Lower the price and retry.",
  },
  AdminNotSet: {
    category: "admin",
    retry: "conditional",
    nextSteps:
      "The contract has no admin yet. Bootstrap the admin before calling the verifier or " +
      "repair methods.",
  },
  NotVerifier: {
    category: "authorization",
    retry: "conditional",
    nextSteps:
      "The caller does not hold the verifier role. A verifier has to perform the status " +
      "change, so retrying as the same account will fail identically.",
  },
  InvalidVerificationTransition: {
    category: "moderation",
    retry: "conditional",
    nextSteps:
      "That verification-status transition is not allowed from the current status. Read the " +
      "current status and pick a legal next state — the same call may be legal once the " +
      "status moves.",
  },
  AlreadyFrozen: {
    category: "moderation",
    retry: "unsafe",
    nextSteps:
      "The metadata is already frozen. Frozen metadata cannot be frozen again — read the " +
      "current state instead of retrying.",
  },
  MetadataFrozen: {
    category: "moderation",
    retry: "unsafe",
    nextSteps:
      "The metadata is frozen, so it cannot be updated. Register a new resource rather than " +
      "editing this one.",
  },
  DuplicateInRepair: {
    category: "validation",
    retry: "unsafe",
    nextSteps: "The repair list contains duplicate resource ids. Deduplicate the list and retry.",
  },
  InvalidTxHash: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The transaction hash is empty or longer than 128 bytes. Pass the hash exactly as the " +
      "network returned it.",
  },
  InvalidPaymentAmount: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The amount must be positive and inside the allowed refund window bounds. Fix the " +
      "amount or the window and retry.",
  },
  NotModerator: {
    category: "authorization",
    retry: "conditional",
    nextSteps:
      "The caller does not hold the moderator role. A moderator has to perform this action.",
  },
  AlreadyFlagged: {
    category: "moderation",
    retry: "unsafe",
    nextSteps:
      "The resource is already flagged as disputed. Read its flag state instead of flagging " +
      "it again.",
  },
  NotFlagged: {
    category: "moderation",
    retry: "unsafe",
    nextSteps:
      "The resource is not flagged, so there is nothing to clear. Read its flag state " +
      "instead of retrying.",
  },
  InvalidLifecycleTransition: {
    category: "registration",
    retry: "conditional",
    nextSteps:
      "That lifecycle transition is not allowed from the current state. Read the current " +
      "state and choose a legal transition — the same call may be legal later.",
  },
  ResourceNotMutable: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "The resource is frozen, disputed, tombstoned, or not listed, so it cannot be changed " +
      "and cannot accept a payment or a lease. Use a listed, unfrozen resource.",
  },
  NetworkAlreadyInitialized: {
    category: "network",
    retry: "unsafe",
    nextSteps:
      "The network id is already initialized for this contract instance. Use the network id " +
      "that is already in place.",
  },
  NetworkIdMismatch: {
    category: "network",
    retry: "unsafe",
    nextSteps:
      "The invocation's network id does not match the contract's configured network id. " +
      "Point the client at the network the contract was deployed to.",
  },
  NetworkNotInitialized: {
    category: "network",
    retry: "conditional",
    nextSteps:
      "The network id has not been initialized for this contract instance. Initialize it " +
      "before making state-changing calls.",
  },
  FeeBpsTooHigh: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "A fee or fee-destination basis-point value exceeds its configured ceiling. Lower the " +
      "basis points and retry.",
  },
  TotalFeeTooHigh: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The combined fee policy or fee-destination split is invalid. Keep the total inside " +
      "the ceiling and retry.",
  },
  CountOverflow: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "The global resource count would overflow u32. This deployment cannot register more " +
      "resources; the rejected call changed no state.",
  },
  BatchTooLarge: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The batch exceeds the documented maximum number of ids. Split it into smaller " +
      "batches and retry.",
  },
  DuplicateReceipt: {
    category: "payment",
    retry: "unsafe",
    nextSteps:
      "A purchase receipt is already anchored for this resource and buyer. Look up the " +
      "existing receipt rather than anchoring a second one.",
  },
  FlagReasonHashTooLong: {
    category: "validation",
    retry: "unsafe",
    nextSteps: "The reason hash exceeds 64 bytes. Pass a 32-byte hash as 64 hex characters.",
  },
  ContractPaused: {
    category: "network",
    retry: "conditional",
    nextSteps:
      "The registry is paused, so state-changing calls are refused and nothing was written. " +
      "Wait until it is unpaused and retry — this is the one failure here that a patient " +
      "caller simply waits out.",
  },
  NotSettler: {
    category: "authorization",
    retry: "conditional",
    nextSteps: "The caller does not hold the settler role. A settler has to perform this action.",
  },
  ReceiptAlreadyExists: {
    category: "payment",
    retry: "unsafe",
    nextSteps:
      "A receipt is already stored for that id. Read the existing receipt, or use a fresh " +
      "receipt id.",
  },
  InvalidPaymentTransition: {
    category: "payment",
    retry: "conditional",
    nextSteps:
      "The payment is not settled, its creator refund deadline has expired, or the state " +
      "transition is not allowed. Check the payment's state before retrying.",
  },
  InvalidReceiptId: {
    category: "validation",
    retry: "unsafe",
    nextSteps: "The receipt id is empty or longer than 64 bytes. Use a conforming id.",
  },
  ContentHashTooLong: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The content hash exceeds 128 bytes. Pass the digest in the length the contract " +
      "expects.",
  },
  AttestationHashTooLong: {
    category: "validation",
    retry: "unsafe",
    nextSteps: "The attestation hash exceeds 64 bytes. Pass a 32-byte hash as hex.",
  },
  PaymentAmountMismatch: {
    category: "payment",
    retry: "unsafe",
    nextSteps:
      "The amount differs from the resource price, or the cumulative refunds exceed the " +
      "original payment. Read the price and the recorded payments and reconcile them " +
      "before retrying.",
  },
  DuplicateTxHash: {
    category: "payment",
    retry: "unsafe",
    nextSteps:
      "That transaction hash is already recorded against another receipt. Use the hash of " +
      "the transaction that actually paid.",
  },
  FeeConfigNotSet: {
    category: "admin",
    retry: "conditional",
    nextSteps:
      "No fee config has been set for this contract. Set it before setting the fee " +
      "recipient or destination.",
  },
  AdminNominationExpired: {
    category: "admin",
    retry: "unsafe",
    nextSteps:
      "The pending admin nomination is missing or has expired. Nominate again — the expired " +
      "nomination will never become valid.",
  },
  InvalidMetadataPointers: {
    category: "validation",
    retry: "unsafe",
    nextSteps:
      "The pointer list is empty, longer than the maximum, contains duplicates, or has an " +
      "out-of-range primary index. Fix the list and retry.",
  },
  AdminAlreadySet: {
    category: "admin",
    retry: "unsafe",
    nextSteps:
      "An admin is already set, so it cannot be bootstrapped again. Nominate a new admin " +
      "instead.",
  },
  RecoveryAdminNotSet: {
    category: "admin",
    retry: "conditional",
    nextSteps:
      "No recovery admin is configured for this contract. Configure one before recovering " +
      "the admin.",
  },
  UnsupportedResourceSchema: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "The resource uses a schema version this deployment cannot read or upgrade safely. " +
      "Upgrade the deployment, or work with a resource on a supported schema.",
  },
  RevisionOverflow: {
    category: "registration",
    retry: "unsafe",
    nextSteps:
      "The revision counter would overflow u32, so the mutation was rejected without " +
      "changing any resource state. This deployment cannot accept more updates to that " +
      "resource.",
  },
};

/** Every code this build knows, with its name. */
export function knownRegistryErrors(): { code: number; name: string }[] {
  return Object.entries(Errors)
    .map(([code, error]) => ({ code: Number(code), name: error.message }))
    .sort((a, b) => a.code - b.code);
}

/**
 * The guidance for an error name, or `undefined` when the name is unknown.
 */
export function registryErrorGuidance(name: string): RegistryErrorGuidance | undefined {
  return REGISTRY_ERROR_GUIDANCE[name];
}

/** The explanation a tool call returns. */
export interface RegistryErrorExplanation {
  /** The code that was asked about, when the caller gave one. */
  code: number | null;
  /** The error name, when the code or name is known. */
  name: string | null;
  /** Whether this build knows the code or name. */
  known: boolean;
  /** The contract's own description of the failure. */
  description: string | null;
  /** The family the error belongs to. */
  category: RegistryErrorCategory | null;
  /** Whether an identical retry can help. */
  retry: RegistryErrorRetry | null;
  /** The one step that recovers. */
  nextSteps: string;
  /** The codes that do exist — present only when the input was unknown. */
  knownCodes?: { code: number; name: string }[];
}

/**
 * The next step for a code this build does not know.
 *
 * The code is reported as asked: an unknown code is a fact about the
 * deployment, not a reason to hide the number the caller saw.
 */
function unknownCodeNextSteps(code: number | null): string {
  return (
    `Code ${code ?? "(none)"} is not one of the vault-registry's error codes in this build. ` +
    "It may come from a newer contract, a different contract, or an RPC that wraps the " +
    "failure in its own number. Read the error name from the failed invocation and look " +
    "that up, or compare the contract's error table with knownCodes."
  );
}

/**
 * Explain a contract error code.
 *
 * Either a numeric `code` or an error `name` identifies the failure; giving
 * both is allowed as long as they agree, and an unknown code or name comes
 * back marked `known: false` rather than as an error.
 */
export function explainRegistryError(input: {
  code?: number | null;
  name?: string | null;
}): RegistryErrorExplanation {
  const code = typeof input.code === "number" ? input.code : null;
  const askedName =
    typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : null;

  // A name resolves to its code, so both routes end at the same place.
  const nameCode = askedName !== null ? (registryErrorCodeForName(askedName) ?? null) : null;

  // A code and a name that disagree are a mistake in the call, not a fact
  // about the contract, so neither is silently preferred over the other.
  if (code !== null && askedName !== null && nameCode !== null && nameCode !== code) {
    return {
      code,
      name: askedName,
      known: false,
      description: null,
      category: null,
      retry: null,
      nextSteps:
        `Code ${code} is ${registryErrorName(code) ?? "unknown"} but the name "${askedName}" ` +
        `is code ${nameCode}. Ask for one of the two, not both.`,
    };
  }

  const resolvedCode = code !== null ? code : nameCode;
  const resolvedName = resolvedCode !== null ? (registryErrorName(resolvedCode) ?? null) : null;

  if (resolvedCode === null || resolvedName === null) {
    return {
      code: resolvedCode,
      name: resolvedName,
      known: false,
      description: null,
      category: null,
      retry: null,
      nextSteps: unknownCodeNextSteps(resolvedCode),
      knownCodes: knownRegistryErrors(),
    };
  }

  const guidance = registryErrorGuidance(resolvedName);
  const description = registryErrorDescription(resolvedCode) ?? null;

  return {
    code: resolvedCode,
    name: resolvedName,
    known: true,
    description,
    category: guidance?.category ?? null,
    retry: guidance?.retry ?? null,
    nextSteps:
      guidance?.nextSteps ??
      `${resolvedName} is a vault-registry error. Read the contract's error table for what ` +
        "it rejects, and correct the call before retrying.",
  };
}

/** The number of error codes this build knows. */
export const KNOWN_REGISTRY_ERROR_COUNT = Object.keys(Errors).length;

/** The number of error codes that carry guidance. */
export const GUIDED_REGISTRY_ERROR_COUNT = Object.keys(REGISTRY_ERROR_GUIDANCE).length;

/** The number of error descriptions this build mirrors. */
export const DESCRIBED_REGISTRY_ERROR_COUNT = Object.keys(ERROR_DESCRIPTIONS).length;
