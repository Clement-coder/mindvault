/**
 * Pagination bounds for on-chain vault-registry list() calls.
 * The contract caps page size at 20 (see contract/contracts/vault-registry).
 */

export const REGISTRY_LIST_DEFAULT_START = 0;
export const REGISTRY_LIST_DEFAULT_LIMIT = 20;
export const REGISTRY_LIST_MAX_LIMIT = 20;

/**
 * The contract's resource lifecycle states, spelled as the MCP exposes them.
 * Mirrors the `ResourceState` enum in the vault-registry contract.
 */
export const REGISTRY_RESOURCE_STATES = [
  "Listed",
  "Delisted",
  "Frozen",
  "Disputed",
  "Tombstoned",
] as const;

/**
 * Longest tag the contract stores (32 characters). A prefix is normalized the
 * same way a tag is, so it cannot be longer than a full tag.
 */
export const REGISTRY_TAG_MAX_LENGTH = 32;

/**
 * Upper bound on an opaque id-cursor token. The token is base64url-encoded
 * JSON carrying one page position, so it stays far below this; the bound only
 * rejects a payload that is not a cursor at all.
 */
export const REGISTRY_CURSOR_MAX_LENGTH = 512;
