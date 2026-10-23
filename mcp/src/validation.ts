/**
 * Argument validation for the MindVault MCP tool surface.
 *
 * Every tool used to read its arguments straight off an untyped `any` bag
 * (`args.resourceId as string`), so a missing, misspelled, or wrongly-typed
 * argument travelled deep into the tool before failing — as an HTTP 400, a
 * malformed URL, or (worse) silently, by dropping an argument the agent
 * believed it had passed. This module validates the whole bag up front,
 * against one declarative spec per tool, and produces a single deterministic
 * error listing every problem.
 *
 * Design rules:
 *
 *   - Specs are data (`TOOL_ARGUMENT_SPECS`), not code, and cover every tool
 *     advertised in `TOOL_DEFINITIONS`. A test enforces both directions so a
 *     new tool cannot ship without validation.
 *   - Validation is strict: unknown argument names are rejected rather than
 *     ignored, so a typo is reported instead of silently changing behavior.
 *   - Errors are deterministic: issues are reported in spec order with stable
 *     codes and messages, so the same bad call always yields the same text.
 *   - Errors are agent-safe: they name the field, the reason, and the expected
 *     shape. Rejected values are never echoed back, so a mistyped passphrase
 *     or secret key cannot leak into a transcript.
 *   - Values are normalized on the way out: strings are trimmed, flags are
 *     coerced to booleans, digests are canonicalized.
 *
 * The module is pure — no I/O, no globals — so it is unit-testable on its own.
 */

import { parseMetadataHash, MetadataHashError, METADATA_HASH_FORMAT_HINT } from "./metadataHash.js";
import {
  isBlockedAddress,
  isBlockedHostname,
  isHostAllowlisted,
  parseUrlAllowlist,
} from "./outboundUrl.js";
import { CATALOG_MAX_LIMIT, CATALOG_SORT_VALUES } from "./catalogFilters.js";
import {
  REGISTRY_CURSOR_MAX_LENGTH,
  REGISTRY_LIST_MAX_LIMIT,
  REGISTRY_RESOURCE_STATES,
  REGISTRY_TAG_MAX_LENGTH,
} from "./registryPagination.js";
import { RECEIPT_EXPORT_MAX_LIMIT, RECEIPT_ROW_FIELDS } from "./receipts.js";
import { DEBUG_BUNDLE_MAX_AUDIT_LINES } from "./debugBundleSchema.js";
import { SUPPORT_BUNDLE_MAX_AUDIT_LINES } from "./supportBundle.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import {
  MAX_SETTLEMENT_TIMEOUT_MS,
  MIN_SETTLEMENT_INTERVAL_MS,
  TRANSACTION_WAIT_POLICIES,
} from "./settlement.js";
import { StrKey } from "@stellar/stellar-sdk";

// ── Spec model ────────────────────────────────────────────────────────────────

/**
 * Argument kinds.
 *
 * - `string`    — free text, trimmed; optional pattern/length constraints
 * - `enum`      — one of a fixed set of literals
 * - `flag`      — boolean, also accepting the unambiguous string/number spellings
 *                 MCP clients commonly send (`"true"`, `"1"`, `"yes"`, `0`, …)
 * - `hash`      — a metadata digest in the fixed format (see metadataHash.ts),
 *                 normalized to its canonical `"<algorithm>:<hex>"` form
 * - `url`       — an absolute `http(s)` URL whose host is not a loopback,
 *                 link-local, private, or otherwise reserved address (see
 *                 outboundUrl.ts). The container host is checked here; the
 *                 DNS-rebinding check runs on the live fetch path, not in this
 *                 pure validator.
 * - `tag_array` — array of discovery tags for set_tags; normalized to lowercase,
 *                 validated against on-chain constraints (≤8 entries, each 1–32 chars,
 *                 only `[a-z0-9_-]`). Accepts a comma-separated string as well.
 * - `string_array` — array of free-text strings (e.g. batch resource ids),
 *                 normalized per entry (trimmed, empty entries dropped) with a
 *                 bounded length. Unlike `tag_array` entries keep their case
 *                 and duplicates — they are data selectors, not on-chain tags.
 *                 Accepts a comma-separated string as well.
 *
 * Normalization guidance for tag_array:
 *   - Tags are lowercased before the on-chain call so "Finance" and "finance"
 *     are the same tag on-chain.
 *   - Duplicate tags (after lowercasing) are silently deduplicated.
 *   - Leading/trailing whitespace is stripped from each tag.
 *   - An empty array (`[]`) is valid and clears all tags from the resource.
 */
export type ArgumentKind =
  | "string"
  | "enum"
  | "flag"
  | "hash"
  | "stellar_address"
  | "stellar_secret"
  | "tag_array"
  | "string_array"
  | "url"
  | "integer";

export interface ArgumentSpec {
  kind: ArgumentKind;
  required?: boolean;
  /** Inclusive minimum — `integer` only. */
  min?: number;
  /** Inclusive maximum — `integer` only. */
  max?: number;
  /** Allowed literals — `enum` only. */
  values?: readonly string[];
  /** Minimum length after trimming — `string` only (default 1 when required). */
  minLength?: number;
  /** Maximum length after trimming — `string` only. */
  maxLength?: number;
  /** Shape the value must match — `string` only. */
  pattern?: RegExp;
  /** Human-readable description of `pattern`, used in the error message. */
  patternHint?: string;
  /**
   * Keep the canonical hex-only form of a digest instead of the
   * `"<algorithm>:<hex>"` spelling — `hash` only. Used where a downstream
   * service expects a bare digest (e.g. a Stellar transaction hash).
   */
  bareHex?: boolean;
  /**
   * When set, an `http(s)` value's host is additionally checked against the
   * local/reserved-address guard — `string` only. Used for the metadata
   * pointer, which may be `ipfs://`, `ar://`, a digest, or an `http(s)` URL;
   * only the URL form carries a host to check.
   */
  rejectLocalHost?: boolean;
}

export type ToolArgumentSpec = Record<string, ArgumentSpec>;

// ── Shared field shapes ───────────────────────────────────────────────────────

/**
 * Resource ids are interpolated directly into API paths, so they are
 * restricted to characters that cannot alter the request path.
 */
const RESOURCE_ID: ArgumentSpec = {
  kind: "string",
  required: true,
  maxLength: 128,
  pattern: /^[A-Za-z0-9._-]+$/,
  patternHint: "letters, digits, dot, dash, or underscore (max 128 chars)",
};

const ON_CHAIN_RESOURCE_ID: ArgumentSpec = {
  kind: "string",
  required: true,
  maxLength: 24,
  pattern: /^[a-z0-9]+$/,
  patternHint: "1–24 lowercase letters or digits",
};

/** Same rules as profiles.isValidProfileName, expressed as a spec. */
const PROFILE_NAME: ArgumentSpec = {
  kind: "string",
  maxLength: 64,
  pattern: /^[A-Za-z0-9._-]+$/,
  patternHint: "letters, digits, dot, dash, or underscore (1–64 chars)",
};

/** Decimal USDC amount as a string, e.g. "5", "0.50". */
const USDC_AMOUNT: ArgumentSpec = {
  kind: "string",
  maxLength: 32,
  pattern: /^\d+(\.\d+)?$/,
  patternHint: 'a non-negative decimal amount in USDC, e.g. "5.00"',
};

/**
 * Batch-size ceiling for tools that take a list of resource ids in one call.
 *
 * Bounded so one call cannot fan out into an unbounded number of downstream
 * lookups: 25 ids is comfortably above what an agent gathers from a single
 * browse/search page (the API caps page size far below this) and small enough
 * that the aggregate response still fits the truncation budget.
 */
export const BATCH_LOOKUP_MAX_IDS = 25;

/** Confirmation flag for mainnet mutations (see mainnetGuardrails.ts). */
const CONFIRM_MAINNET: ArgumentSpec = { kind: "flag" };

/** Confirmation flag for paid operations (see paidOperations.ts). */
const CONFIRM_PAID: ArgumentSpec = { kind: "flag" };

/** Preview flag: publish/buy report what they would do without paying. */
const DRY_RUN: ArgumentSpec = { kind: "flag" };

/**
 * Stellar Ed25519 public key (G… 56 chars).
 *
 * Uses the `stellar_address` kind so that both the StrKey format and the
 * CRC-16 checksum are verified locally before any Horizon or Soroban RPC
 * request is made. A key that passes the character-set regex but fails the
 * checksum will be caught here and reported with a field-specific error.
 */
const STELLAR_ADDRESS: ArgumentSpec = {
  kind: "stellar_address",
};

/** Metadata pointer (max 512 chars, supported prefix). */
const METADATA_POINTER: ArgumentSpec = {
  kind: "string",
  required: true,
  minLength: 1,
  maxLength: 512,
  pattern: /^(ipfs:\/\/|ar:\/\/|https?:\/\/|sha256:|sha-256:|0x)/i,
  patternHint:
    "a valid metadata pointer starting with ipfs://, ar://, http(s)://, sha256:, sha-256:, or 0x (max 512 chars)",
  // http(s) pointers are later dereferenced like any other outbound URL, so
  // their host faces the same local/reserved-address guard (#1078).
  rejectLocalHost: true,
};

const ATTESTATION_HASH: ArgumentSpec = { kind: "string", required: true, maxLength: 64 };

/** Backup passphrases must survive a round-trip through stateBackup.ts. */
const PASSPHRASE: ArgumentSpec = { kind: "string", required: true, minLength: 8, maxLength: 512 };

/**
 * Catalog filters shared by mindvault_browse and mindvault_search.
 *
 * The two tools advertise one schema (`catalogFilterInputProperties`) and hand
 * their arguments to the same parser, so they validate against one spec as
 * well — otherwise an argument the schema advertises (`sort` was the first) is
 * rejected here as unknown before the parser ever sees it.
 *
 * Values are re-checked by `parseCatalogFilters`, which produces the friendlier
 * message; this layer's job is to accept the right argument *names* and reject
 * the obviously wrong shapes.
 */
const CATALOG_FILTER_ARGS: ToolArgumentSpec = {
  query: { kind: "string", maxLength: 256 },
  minPrice: USDC_AMOUNT,
  maxPrice: USDC_AMOUNT,
  verificationStatus: {
    kind: "enum",
    values: ["pending", "verified", "rejected", "skipped"],
  },
  resourceType: { kind: "enum", values: ["file", "link"] },
  owner: { kind: "string", maxLength: 128 },
  sort: { kind: "enum", values: CATALOG_SORT_VALUES },
  limit: { kind: "integer", min: 1, max: CATALOG_MAX_LIMIT },
  offset: { kind: "integer", min: 0 },
  tags: { kind: "string", maxLength: 256 },
  listed: { kind: "flag" },
  cursor: { kind: "string", maxLength: 4096 },
  bypassCache: { kind: "flag" },
};

// ── Per-tool specs ────────────────────────────────────────────────────────────

/**
 * Tools that parse their own arguments instead of going through
 * {@link TOOL_ARGUMENT_SPECS}.
 *
 * Both normalize in their own module — `publishStatus.ts` clamps `timeoutMs`
 * to a maximum and floors `intervalMs` at a minimum, and both raise messages
 * their own suites pin. Running the generic validator first would reject
 * values those functions deliberately accept and clamp, so the exemption is
 * real rather than an oversight.
 *
 * It is a closed list, not a category: `listToolsContract.test.ts` asserts
 * every other advertised tool has a spec, so a new tool cannot join this set
 * by accident.
 */
export const TOOLS_WITHOUT_ARG_VALIDATION: readonly string[] = [
  "mindvault_publish_status",
  // items is an array of objects — the generic validator handles only flat
  // string/flag/hash/integer/enum/tag_array fields. Argument shape is enforced
  // by the input schema in tools.ts and validated inline in the dispatch handler.
  "mindvault_publish_batch",
];

/**
 * The validation contract for every public tool. Key order is the order in
 * which problems are reported, which keeps multi-issue errors deterministic.
 */
export const TOOL_ARGUMENT_SPECS: Record<string, ToolArgumentSpec> = {
  mindvault_setup_wallet: { profile: PROFILE_NAME, confirmMainnet: CONFIRM_MAINNET },
  mindvault_repair_sponsored_account: {
    secretKey: {
      kind: "stellar_secret",
      required: true,
    },
    profile: PROFILE_NAME,
    confirmMainnet: CONFIRM_MAINNET,
  },
  mindvault_wallet_info: {},
  mindvault_wallet_allowance: {},
  mindvault_use_profile: { name: { ...PROFILE_NAME, required: true } },
  mindvault_switch_network_profile: {
    name: { ...PROFILE_NAME, required: true },
    network: { kind: "enum", values: ["testnet", "mainnet"], required: true },
  },
  mindvault_list_profiles: {},
  mindvault_export_profiles: {},
  mindvault_import_profiles: {
    data: { kind: "string", required: true, maxLength: 1_048_576 },
  },
  mindvault_browse: { ...CATALOG_FILTER_ARGS },
  mindvault_search: { ...CATALOG_FILTER_ARGS },
  mindvault_preview: { resourceId: RESOURCE_ID, bypassCache: { kind: "flag" } },
  mindvault_register: {
    name: { kind: "string", required: true, maxLength: 128 },
    email: {
      kind: "string",
      required: true,
      maxLength: 254,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      patternHint: "an email address, e.g. agent@example.com",
    },
    walletAddress: STELLAR_ADDRESS,
    confirmMainnet: CONFIRM_MAINNET,
  },
  mindvault_publish: {
    title: { kind: "string", required: true, maxLength: 256 },
    description: { kind: "string", maxLength: 2048 },
    price: { ...USDC_AMOUNT, required: true },
    externalUrl: {
      kind: "url",
      required: true,
      maxLength: 2048,
      pattern: /^https?:\/\/[^\s]+$/,
      patternHint: "an http(s) URL, e.g. https://example.com/data.json",
    },
    dryRun: DRY_RUN,
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_buy: {
    resourceId: RESOURCE_ID,
    dryRun: DRY_RUN,
    maxAutoPayUsdc: { ...USDC_AMOUNT, required: false },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
    wait: { kind: "flag" },
    waitPolicy: { kind: "enum", values: TRANSACTION_WAIT_POLICIES },
    timeoutMs: {
      kind: "integer",
      min: 0,
      max: MAX_SETTLEMENT_TIMEOUT_MS,
    },
    intervalMs: { kind: "integer", min: MIN_SETTLEMENT_INTERVAL_MS },
  },
  mindvault_export_receipts: {
    format: { kind: "enum", values: ["json", "csv", "ndjson"] },
    resourceId: { ...RESOURCE_ID, required: false },
    network: { kind: "string", maxLength: 64 },
    since: { kind: "string", maxLength: 64 },
    until: { kind: "string", maxLength: 64 },
    limit: { kind: "integer", min: 1, max: RECEIPT_EXPORT_MAX_LIMIT },
    offset: { kind: "integer", min: 0 },
    fields: {
      kind: "string_array",
      pattern: new RegExp(`^(${RECEIPT_ROW_FIELDS.join("|")})$`),
      patternHint: `a known receipt field (${RECEIPT_ROW_FIELDS.join(", ")})`,
    },
    includeSensitive: { kind: "flag" },
    groupBy: { kind: "enum", values: ["month"] },
  },
  mindvault_register_onchain: {
    resourceId: RESOURCE_ID,
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_buy_lease: {
    resourceId: RESOURCE_ID,
    tier: { kind: "enum", required: true, values: ["hour", "day", "week"] },
    dryRun: DRY_RUN,
    maxAutoPayUsdc: { kind: "string", maxLength: 32 },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_lease_status: {
    resourceId: RESOURCE_ID,
    holder: STELLAR_ADDRESS,
  },
  mindvault_agent_status: {},
  mindvault_registry_info: {},
  mindvault_terms: {
    operation: { kind: "enum", required: true, values: ["get", "set"] },
    creator: STELLAR_ADDRESS,
    termsHash: { kind: "string", maxLength: 64 },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_network_profile: {},
  mindvault_check_bindings: {},
  mindvault_check_consistency: {
    resourceId: RESOURCE_ID,
    expectedMetadataHash: { kind: "hash" },
  },
  mindvault_metadata_diff: {
    resourceId: RESOURCE_ID,
  },
  mindvault_verify_attestation: {
    resourceId: ON_CHAIN_RESOURCE_ID,
    attestationHash: ATTESTATION_HASH,
  },
  mindvault_registry_lookup: { resourceId: RESOURCE_ID },
  mindvault_explain_error_code: {
    // Exactly one of the two identifies the error. The spec marks neither as
    // required because the pair is an exclusive choice, and the validator's
    // "required" flag cannot express "one of"; the handler rejects a call
    // that gives neither or both.
    code: { kind: "integer", min: 0, max: 65535 },
    name: {
      kind: "string",
      maxLength: 64,
      pattern: /^[A-Za-z][A-Za-z0-9]*$/,
      patternHint: "an error name such as NotFound",
    },
  },
  mindvault_registry_list: {
    start: { kind: "integer", min: 0 },
    limit: { kind: "integer", min: 1, max: REGISTRY_LIST_MAX_LIMIT },
  },
  mindvault_registry_count: {
    creator: { kind: "string" },
  },
  mindvault_registry_creator_page: {
    creator: { ...STELLAR_ADDRESS, required: true },
    cursor: { kind: "string", maxLength: REGISTRY_CURSOR_MAX_LENGTH },
    limit: { kind: "integer", min: 1, max: REGISTRY_LIST_MAX_LIMIT },
    listed: { kind: "flag" },
    state: { kind: "enum", values: REGISTRY_RESOURCE_STATES },
  },
  mindvault_registry_tag_search: {
    prefix: { kind: "string", required: true, minLength: 1, maxLength: REGISTRY_TAG_MAX_LENGTH },
    cursor: { kind: "integer", min: 0 },
    limit: { kind: "integer", min: 1, max: REGISTRY_LIST_MAX_LIMIT },
  },
  mindvault_tx_status: { txHash: { kind: "hash", required: true, bareHex: true } },
  // `confirm` is what resetGuard.isResetConfirmed reads. It was advertised in
  // ListTools and absent here, so every confirmed reset failed validation as an
  // unknown argument and the tool was permanently stuck in preview mode (#596).
  mindvault_reset: {
    confirm: { kind: "flag" },
    all: { kind: "flag" },
    confirmMainnet: CONFIRM_MAINNET,
  },
  mindvault_backup_state: { passphrase: PASSPHRASE, confirm: { kind: "flag" } },
  mindvault_compare_state_backup: {
    blob: { kind: "string", required: true, maxLength: 1_048_576 },
    passphrase: PASSPHRASE,
  },
  mindvault_resource_provenance: { resourceId: RESOURCE_ID },
  mindvault_resource_change_log: { resourceId: RESOURCE_ID },
  mindvault_restore_state: {
    blob: { kind: "string", required: true, maxLength: 1_048_576 },
    passphrase: PASSPHRASE,
  },
  mindvault_metrics: {
    reset: { kind: "flag" },
    format: { kind: "enum", values: ["json", "otlp"] },
  },
  mindvault_debug_bundle: {
    auditLogLines: { kind: "integer", min: 0, max: DEBUG_BUNDLE_MAX_AUDIT_LINES },
    includeEnvironment: { kind: "flag" },
  },
  mindvault_onchain_preflight: {
    requestedSchemaVersion: { kind: "integer", min: 0 },
  },
  mindvault_migration_preview: {},
  mindvault_support_bundle: {
    incidentId: { kind: "string", required: true, minLength: 1, maxLength: 128 },
    auditLines: { kind: "integer", min: 0, max: SUPPORT_BUNDLE_MAX_AUDIT_LINES },
  },
  mindvault_set_tags: {
    resourceId: RESOURCE_ID,
    tags: { kind: "tag_array", required: true },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_update_metadata: {
    resourceId: RESOURCE_ID,
    metadata: METADATA_POINTER,
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_set_price: {
    resourceId: RESOURCE_ID,
    price: { ...USDC_AMOUNT, required: true },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_transfer_ownership: {
    resourceId: RESOURCE_ID,
    newCreator: { ...STELLAR_ADDRESS, required: true },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_accept_transfer: {
    resourceId: RESOURCE_ID,
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_cancel_transfer: {
    resourceId: RESOURCE_ID,
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_pending_transfer: {
    resourceId: RESOURCE_ID,
  },
  mindvault_set_listed: {
    resourceId: RESOURCE_ID,
    listed: { kind: "flag", required: true },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_freeze: {
    resourceId: RESOURCE_ID,
    confirm: {
      kind: "string",
      required: true,
      pattern: /^freeze_metadata$/,
      patternHint: 'the exact string "freeze_metadata"',
    },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_fee_config: {},
  mindvault_royalty: {
    resourceId: RESOURCE_ID,
    royaltyRecipient: STELLAR_ADDRESS,
    clear: { kind: "flag" },
    confirmMainnet: CONFIRM_MAINNET,
    confirmPaid: CONFIRM_PAID,
  },
  mindvault_check_state_permissions: {},
  mindvault_registry_health: {},
  mindvault_rpc_health: {},
  mindvault_prewarm_catalog: {},
  mindvault_client_config: {
    client: {
      kind: "enum",
      values: ["claude-code", "claude-desktop", "codex", "cursor", "vscode", "windsurf"],
    },
  },
  mindvault_mainnet_banner: {},
  mindvault_import_wallet: {
    secretKey: {
      kind: "stellar_secret",
    },
    profile: PROFILE_NAME,
    confirm: { kind: "flag" },
    confirmMainnet: CONFIRM_MAINNET,
  },
  mindvault_rotate_publisher_key: {
    profile: PROFILE_NAME,
    confirmMainnet: CONFIRM_MAINNET,
  },
  mindvault_verify_install: {},
  mindvault_recover_catalog_cache: {},
  mindvault_wallet_balances: {},
  mindvault_server_endpoints: {},
};

// ── Errors ────────────────────────────────────────────────────────────────────

/** Stable issue identifiers. Safe for clients to branch on. */
export type ValidationIssueCode =
  | "not_an_object"
  | "unknown_argument"
  | "missing_required"
  | "wrong_type"
  | "empty_string"
  | "too_short"
  | "too_long"
  | "pattern_mismatch"
  | "not_in_enum"
  | "invalid_hash"
  | "invalid_stellar_address"
  | "invalid_stellar_secret"
  | "invalid_tag_array"
  | "invalid_string_array"
  | "blocked_url";

export interface ValidationIssue {
  field: string;
  code: ValidationIssueCode;
  message: string;
}

/** Raised when a tool is called with arguments that fail its spec. */
export class ToolValidationError extends Error {
  readonly tool: string;
  readonly issues: ValidationIssue[];

  constructor(tool: string, issues: ValidationIssue[]) {
    super(`Invalid arguments for ${tool}: ${issues.map((i) => i.message).join(" ")}`);
    this.name = "ToolValidationError";
    this.tool = tool;
    this.issues = issues;
  }
}

/** Raised when a call names a tool this server does not expose. */
export class UnknownToolError extends Error {
  readonly tool: string;

  constructor(tool: string) {
    super(
      `Unknown tool: ${tool}. Available tools: ${Object.keys(TOOL_ARGUMENT_SPECS).sort().join(", ")}.`,
    );
    this.name = "UnknownToolError";
    this.tool = tool;
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

const TRUE_STRINGS = new Set(["true", "1", "yes", "on"]);
const FALSE_STRINGS = new Set(["false", "0", "no", "off"]);

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Describe a spec's expected shape for an error message. Never includes values. */
function expectation(spec: ArgumentSpec): string {
  switch (spec.kind) {
    case "enum":
      return `one of: ${(spec.values ?? []).join(", ")}`;
    case "flag":
      return "a boolean (true/false)";
    case "hash":
      return METADATA_HASH_FORMAT_HINT;
    case "url":
      return (
        spec.patternHint ??
        "an http(s) URL whose host is a public address (not loopback, link-local, or private)"
      );
    case "tag_array":
      return "an array of 0–8 tag strings (each 1–32 chars, lowercase letters/digits/hyphens/underscores)";
    case "string_array": {
      const parts: string[] = ["an array of strings"];
      if (spec.minLength !== undefined || spec.maxLength !== undefined) {
        parts.push(`of ${spec.minLength ?? 0}–${spec.maxLength ?? "unbounded"} entries`);
      }
      return parts.join(" ");
    }
    case "integer": {
      const parts: string[] = ["an integer"];
      if (spec.min !== undefined) parts.push(`≥ ${spec.min}`);
      if (spec.max !== undefined) parts.push(`≤ ${spec.max}`);
      return parts.join(" ");
    }
    case "string": {
      if (spec.patternHint) return spec.patternHint;
      if (spec.maxLength) return `a string of up to ${spec.maxLength} characters`;
      return "a string";
    }
    case "stellar_address":
      return "a Stellar public key (G…)";
    case "stellar_secret":
      return "a Stellar secret seed (S…)";
  }
}

// On-chain tag constraints (must mirror contract/contracts/vault-registry/src/lib.rs).
const MAX_TAGS = 8;
const MAX_TAG_LEN = 32;
const TAG_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Validate and normalize a tag_array argument.
 *
 * Normalization applied before on-chain call:
 *   - Each tag is trimmed and lowercased.
 *   - Duplicate tags (after normalization) are removed.
 *   - An empty array is accepted (clears all tags on the resource).
 *
 * Rejection criteria (deterministic, documented):
 *   - Not an array (or comma-separated string that cannot be parsed).
 *   - More than MAX_TAGS (8) entries after dedup.
 *   - Any tag empty or longer than MAX_TAG_LEN (32) chars after trimming.
 *   - Any tag containing characters outside `[a-z0-9_-]` after lowercasing.
 */
function validateTagArray(
  field: string,
  value: unknown,
  issues: ValidationIssue[],
): string[] | undefined {
  let raw: string[];

  if (Array.isArray(value)) {
    if (!value.every((t) => typeof t === "string")) {
      issues.push({
        field,
        code: "invalid_tag_array",
        message: `${field} must be an array of strings; one or more entries are not strings.`,
      });
      return undefined;
    }
    raw = value as string[];
  } else if (typeof value === "string") {
    // Accept comma-separated strings for convenience (mirrors catalogFilters.ts).
    raw = value.split(",").filter((t) => t.trim().length > 0);
  } else {
    issues.push({
      field,
      code: "invalid_tag_array",
      message: `${field} must be an array of tag strings or a comma-separated string; received ${typeName(value)}.`,
    });
    return undefined;
  }

  // Normalize: trim + lowercase, then deduplicate.
  const normalized = [...new Set(raw.map((t) => t.trim().toLowerCase()))].filter(
    (t) => t.length > 0,
  );

  if (normalized.length > MAX_TAGS) {
    issues.push({
      field,
      code: "invalid_tag_array",
      message: `${field} must contain at most ${MAX_TAGS} tags; received ${normalized.length} (after deduplication).`,
    });
    return undefined;
  }

  for (const tag of normalized) {
    if (tag.length > MAX_TAG_LEN) {
      issues.push({
        field,
        code: "invalid_tag_array",
        message: `${field} contains a tag that exceeds ${MAX_TAG_LEN} characters. Each tag must be 1–${MAX_TAG_LEN} chars.`,
      });
      return undefined;
    }
    if (!TAG_PATTERN.test(tag)) {
      issues.push({
        field,
        code: "invalid_tag_array",
        message: `${field} contains an invalid tag. Tags must use only lowercase letters, digits, hyphens, or underscores.`,
      });
      return undefined;
    }
  }

  return normalized;
}

/**
 * Validate and normalize a string_array argument (batch resource ids, #608).
 *
 * Mirrors how the catalog treats ids in single-resource tools: each entry is
 * trimmed, empty entries are dropped, and one malformed entry is reported as
 * `invalid_string_array` with its 1-based position so an agent can fix it
 * without guessing which of a long list was the problem. Entries keep their
 * case and duplicates — unlike `tag_array` these are data selectors, not
 * on-chain tags.
 *
 * Accepts a comma-separated string for the same reason `tag_array` does: MCP
 * clients that render arrays as flat text are common enough that rejecting
 * the shape outright would make the tool unusable from those clients.
 */
function validateStringArray(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): string[] | undefined {
  let raw: string[];

  if (Array.isArray(value)) {
    if (!value.every((t) => typeof t === "string")) {
      issues.push({
        field,
        code: "invalid_string_array",
        message: `${field} must be an array of strings; one or more entries are not strings.`,
      });
      return undefined;
    }
    raw = value as string[];
  } else if (typeof value === "string") {
    // Accept comma-separated strings for convenience (mirrors tag_array).
    raw = value.split(",").filter((t) => t.trim().length > 0);
  } else {
    issues.push({
      field,
      code: "invalid_string_array",
      message: `${field} must be an array of strings or a comma-separated string; received ${typeName(value)}.`,
    });
    return undefined;
  }

  // Normalize per entry: trim, drop empties. Case and duplicates are kept.
  const normalized = raw.map((t) => t.trim()).filter((t) => t.length > 0);

  const min = spec.minLength ?? 0;
  const max = spec.maxLength;
  if (normalized.length < min) {
    issues.push({
      field,
      code: "invalid_string_array",
      message: `${field} must contain at least ${min} entr${min === 1 ? "y" : "ies"}; received ${normalized.length} (after trimming).`,
    });
    return undefined;
  }
  if (max !== undefined && normalized.length > max) {
    issues.push({
      field,
      code: "invalid_string_array",
      message: `${field} must contain at most ${max} entries; received ${normalized.length}. Split the batch into smaller calls.`,
    });
    return undefined;
  }

  for (let i = 0; i < normalized.length; i++) {
    const entry = normalized[i];
    if (spec.pattern && !spec.pattern.test(entry)) {
      issues.push({
        field,
        code: "invalid_string_array",
        message: `${field}[${i + 1}] is malformed. Each entry must be ${spec.patternHint ?? "a valid entry"}.`,
      });
      return undefined;
    }
  }
  return normalized;
}

/**
 * Validate a Stellar Ed25519 public key (stellar_address kind).
 *
 * StrKey.isValidEd25519PublicKey performs both a format check and a CRC-16
 * checksum verification, so a key that passes the character-set regex but has
 * a bad checksum (e.g. a single transposed character) is caught here rather
 * than reaching Horizon or Soroban RPC where it would produce a confusing
 * network error. The rejected value is never echoed back.
 */
function validateStellarAddress(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): string | undefined {
  if (typeof value !== "string") {
    issues.push({
      field,
      code: "wrong_type",
      message: `${field} must be a string; received ${typeName(value)}.`,
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push({
      field,
      code: "empty_string",
      message: `${field} must not be empty. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }

  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    issues.push({
      field,
      code: "invalid_stellar_address",
      message: `${field} is not a valid Stellar public key. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }

  return trimmed;
}

/**
 * Validate a Stellar Ed25519 secret seed (stellar_secret kind).
 *
 * StrKey.isValidEd25519SecretSeed performs both a format check and a CRC-16
 * checksum verification. The rejected value is never echoed back to prevent
 * secret leakage in agent transcripts.
 */
function validateStellarSecret(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): string | undefined {
  if (typeof value !== "string") {
    issues.push({
      field,
      code: "wrong_type",
      message: `${field} must be a string; received ${typeName(value)}.`,
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push({
      field,
      code: "empty_string",
      message: `${field} must not be empty. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }

  if (!StrKey.isValidEd25519SecretSeed(trimmed)) {
    issues.push({
      field,
      code: "invalid_stellar_secret",
      message: `${field} is not a valid Stellar secret key. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }

  return trimmed;
}

function validateFlag(
  field: string,
  value: unknown,
  issues: ValidationIssue[],
): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(normalized)) return true;
    if (FALSE_STRINGS.has(normalized)) return false;
  }
  issues.push({
    field,
    code: "wrong_type",
    message: `${field} must be a boolean (true/false); received ${typeName(value)}.`,
  });
  return undefined;
}

function validateString(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): string | undefined {
  if (typeof value !== "string") {
    issues.push({
      field,
      code: "wrong_type",
      message: `${field} must be a string; received ${typeName(value)}.`,
    });
    return undefined;
  }

  const trimmed = value.trim();
  const minLength = spec.minLength ?? 1;

  if (trimmed.length === 0) {
    issues.push({
      field,
      code: "empty_string",
      message: `${field} must not be empty. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }
  if (trimmed.length < minLength) {
    issues.push({
      field,
      code: "too_short",
      message: `${field} must be at least ${minLength} characters.`,
    });
    return undefined;
  }
  if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
    issues.push({
      field,
      code: "too_long",
      message: `${field} must be at most ${spec.maxLength} characters; received ${trimmed.length}.`,
    });
    return undefined;
  }
  if (spec.pattern && !spec.pattern.test(trimmed)) {
    issues.push({
      field,
      code: "pattern_mismatch",
      message: `${field} is malformed. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }
  if (spec.rejectLocalHost && /^https?:\/\//i.test(trimmed)) {
    let host: string;
    try {
      host = new URL(trimmed).hostname;
    } catch {
      issues.push({
        field,
        code: "pattern_mismatch",
        message: `${field} is not a valid http(s) URL.`,
      });
      return undefined;
    }
    const hostIssue = hostSafetyIssue(host, field);
    if (hostIssue) {
      issues.push(hostIssue);
      return undefined;
    }
  }
  return trimmed;
}

function validateEnum(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): string | undefined {
  const values = spec.values ?? [];
  if (typeof value !== "string") {
    issues.push({
      field,
      code: "wrong_type",
      message: `${field} must be a string; received ${typeName(value)}.`,
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (!values.includes(trimmed)) {
    issues.push({
      field,
      code: "not_in_enum",
      message: `${field} must be ${expectation(spec)}.`,
    });
    return undefined;
  }
  return trimmed;
}

function validateInteger(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): number | undefined {
  let n: number;
  if (typeof value === "number" && Number.isInteger(value)) {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed)) {
      issues.push({
        field,
        code: "wrong_type",
        message: `${field} must be ${expectation(spec)}; received ${typeName(value)}.`,
      });
      return undefined;
    }
    n = parsed;
  } else {
    issues.push({
      field,
      code: "wrong_type",
      message: `${field} must be ${expectation(spec)}; received ${typeName(value)}.`,
    });
    return undefined;
  }

  const min = spec.min ?? Number.MIN_SAFE_INTEGER;
  const max = spec.max ?? Number.MAX_SAFE_INTEGER;
  if (n < min) {
    issues.push({
      field,
      code: "too_short",
      message: `${field} must be at least ${min}.`,
    });
    return undefined;
  }
  if (n > max) {
    issues.push({
      field,
      code: "too_long",
      message: `${field} must be at most ${max}.`,
    });
    return undefined;
  }
  return n;
}

function validateHash(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): string | undefined {
  try {
    const parsed = parseMetadataHash(value, field);
    return spec.bareHex ? parsed.hex : parsed.canonical;
  } catch (err) {
    issues.push({
      field,
      code: "invalid_hash",
      message:
        err instanceof MetadataHashError ? err.message : `${field} is not a valid digest value.`,
    });
    return undefined;
  }
}

/**
 * Validate an `http(s)` URL whose host must not be local or reserved (#1078).
 *
 * This is the pure half of the outbound-URL guard in `outboundUrl.ts`: it
 * enforces the scheme, rejects literal IP and structurally-local hostnames,
 * and honours `MINDVAULT_URL_ALLOWLIST`. It never touches DNS — a named host
 * that resolves to a private address is caught on the live fetch path
 * (`resolveOutboundUrl` with a resolver), not here, because argument
 * validation must stay free of I/O.
 */
function validateUrl(
  field: string,
  value: unknown,
  spec: ArgumentSpec,
  issues: ValidationIssue[],
): string | undefined {
  if (typeof value !== "string") {
    issues.push({
      field,
      code: "wrong_type",
      message: `${field} must be a string; received ${typeName(value)}.`,
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push({
      field,
      code: "missing_required",
      message: `${field} must be a non-empty URL.`,
    });
    return undefined;
  }
  if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
    issues.push({
      field,
      code: "too_long",
      message: `${field} must be at most ${spec.maxLength} characters; received ${trimmed.length}.`,
    });
    return undefined;
  }
  if (spec.pattern && !spec.pattern.test(trimmed)) {
    issues.push({
      field,
      code: "pattern_mismatch",
      message: `${field} is malformed. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    issues.push({
      field,
      code: "pattern_mismatch",
      message: `${field} is not a valid absolute URL. Expected ${expectation(spec)}.`,
    });
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.push({
      field,
      code: "pattern_mismatch",
      message: `${field} must use the http or https scheme.`,
    });
    return undefined;
  }

  const host = parsed.hostname;
  const hostIssue = hostSafetyIssue(host, field);
  if (hostIssue) {
    issues.push(hostIssue);
    return undefined;
  }

  return trimmed;
}

/**
 * Reject a host that is local or a blocked address, unless the operator has
 * allowlisted it. Returns the issue to record, or null when the host is fine.
 */
function hostSafetyIssue(host: string, field: string): ValidationIssue | null {
  const allowlist = parseUrlAllowlist(process.env.MINDVAULT_URL_ALLOWLIST);
  if (isHostAllowlisted(host, allowlist)) return null;
  if (isBlockedHostname(host)) {
    return {
      field,
      code: "blocked_url",
      message: `${field} host is a local or reserved name and cannot be used as an outbound URL.`,
    };
  }
  const hostLiteral = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const isLiteral = hostLiteral.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostLiteral);
  if (isLiteral && isBlockedAddress(hostLiteral)) {
    return {
      field,
      code: "blocked_url",
      message: `${field} host is a private, loopback, or reserved address and cannot be used as an outbound URL.`,
    };
  }
  return null;
}

/** Validated, normalized arguments for a tool call. */
export type ValidatedArgs = Record<string, string | boolean | string[] | number>;

/**
 * Validate and normalize a tool call's arguments.
 *
 * @throws {UnknownToolError}    when the tool is not part of the surface
 * @throws {ToolValidationError} when any argument fails its spec
 */
export function validateToolArgs(tool: string, rawArgs: unknown): ValidatedArgs {
  const spec = TOOL_ARGUMENT_SPECS[tool];
  if (!spec) throw new UnknownToolError(tool);

  const issues: ValidationIssue[] = [];
  const args = rawArgs ?? {};

  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ToolValidationError(tool, [
      {
        field: "arguments",
        code: "not_an_object",
        message: `arguments must be a JSON object; received ${typeName(rawArgs)}.`,
      },
    ]);
  }

  const provided = args as Record<string, unknown>;
  const known = new Set(Object.keys(spec));
  const out: ValidatedArgs = {};

  // Unknown arguments first: a typo is more useful reported than ignored.
  for (const field of Object.keys(provided)) {
    if (!known.has(field)) {
      const accepted = Object.keys(spec);
      issues.push({
        field,
        code: "unknown_argument",
        message:
          `${field} is not a recognized argument for ${tool}. ` +
          (accepted.length > 0
            ? `Accepted arguments: ${accepted.join(", ")}.`
            : "This tool takes no arguments."),
      });
    }
  }

  for (const [field, fieldSpec] of Object.entries(spec)) {
    const value = provided[field];

    if (value === undefined || value === null) {
      if (fieldSpec.required) {
        issues.push({
          field,
          code: "missing_required",
          message: `${field} is required. Expected ${expectation(fieldSpec)}.`,
        });
      }
      continue;
    }

    switch (fieldSpec.kind) {
      case "flag": {
        const flag = validateFlag(field, value, issues);
        if (flag !== undefined) out[field] = flag;
        break;
      }
      case "enum": {
        const literal = validateEnum(field, value, fieldSpec, issues);
        if (literal !== undefined) out[field] = literal;
        break;
      }
      case "hash": {
        const hash = validateHash(field, value, fieldSpec, issues);
        if (hash !== undefined) out[field] = hash;
        break;
      }
      case "stellar_address": {
        const addr = validateStellarAddress(field, value, fieldSpec, issues);
        if (addr !== undefined) out[field] = addr;
        break;
      }
      case "stellar_secret": {
        const secret = validateStellarSecret(field, value, fieldSpec, issues);
        if (secret !== undefined) out[field] = secret;
        break;
      }
      case "integer": {
        const num = validateInteger(field, value, fieldSpec, issues);
        if (num !== undefined) out[field] = num;
        break;
      }
      case "string": {
        const text = validateString(field, value, fieldSpec, issues);
        if (text !== undefined) out[field] = text;
        break;
      }
      case "url": {
        const link = validateUrl(field, value, fieldSpec, issues);
        if (link !== undefined) out[field] = link;
        break;
      }
      case "tag_array": {
        const tagArr = validateTagArray(field, value, issues);
        if (tagArr !== undefined) out[field] = tagArr;
        break;
      }
      case "string_array": {
        const strArr = validateStringArray(field, value, fieldSpec, issues);
        if (strArr !== undefined) out[field] = strArr;
        break;
      }
    }
  }

  if (issues.length > 0) throw new ToolValidationError(tool, issues);
  return out;
}

/** Read a validated string argument. Required fields are guaranteed present. */
export function requiredString(args: ValidatedArgs, field: string): string {
  const value = args[field];
  if (typeof value !== "string") {
    throw new Error(`Internal validation error: ${field} was not validated as a string.`);
  }
  return value;
}

/** Read an optional validated string argument. */
export function optionalString(args: ValidatedArgs, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" ? value : undefined;
}

/** Read a validated flag, defaulting to false when the caller omitted it. */
export function flag(args: ValidatedArgs, field: string): boolean {
  return args[field] === true;
}

/**
 * Read an optional validated flag, keeping "absent" distinct from `false`.
 *
 * A filter argument that was not sent must reach the contract as `None`, not
 * as `Some(false)`: the two mean "no filter" and "filter on false".
 */
export function optionalFlag(args: ValidatedArgs, field: string): boolean | undefined {
  return typeof args[field] === "boolean" ? (args[field] as boolean) : undefined;
}

/** Read an optional validated integer, defaulting when the caller omitted it. */
export function optionalInt(args: ValidatedArgs, field: string, defaultValue: number): number {
  const value = args[field];
  return typeof value === "number" ? value : defaultValue;
}

/** Tool names advertised by this server, sorted. */
export function knownToolNames(): string[] {
  return TOOL_DEFINITIONS.map((tool) => tool.name).sort();
}

/** Read a validated tag array argument. Required tag_array fields are guaranteed present. */
export function requiredTagArray(args: ValidatedArgs, field: string): string[] {
  const value = args[field];
  if (!Array.isArray(value)) {
    throw new Error(`Internal validation error: ${field} was not validated as a tag_array.`);
  }
  return value as string[];
}

/** Read a validated string array argument. Required string_array fields are guaranteed present. */
export function requiredStringArray(args: ValidatedArgs, field: string): string[] {
  const value = args[field];
  if (!Array.isArray(value)) {
    throw new Error(`Internal validation error: ${field} was not validated as a string_array.`);
  }
  return value as string[];
}
