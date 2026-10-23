/**
 * Resource schema version constants and validation for the vault-registry contract.
 *
 * `RESOURCE_SCHEMA_VERSION` is an integer bumped whenever the on-chain `Resource`
 * struct changes shape (e.g. fields added, removed, or retyped).
 *
 * Current schema version:
 *   - v7: added `verified` (`VerificationStatus` on-chain verification status).
 *
 * Previously supported schema version:
 *   - v6: added `metadata_frozen_at`.
 *
 * The contract itself supports reading both v7 and v6, upgrading v6 to v7 on write.
 * Clients fail closed when communicating with a contract exposing an unsupported schema version.
 */

/** Current on-chain Resource schema version. */
export const CURRENT_RESOURCE_SCHEMA_VERSION = 7;
export const RESOURCE_SCHEMA_VERSION = 7;

/** Previous supported on-chain Resource schema version. */
export const PREVIOUS_RESOURCE_SCHEMA_VERSION = 6;

/** Supported on-chain Resource schema versions for this client. */
export const SUPPORTED_RESOURCE_SCHEMA_VERSIONS: readonly number[] = [6, 7] as const;

/** Check whether a given schema version is supported by this client. */
export function isSupportedResourceSchemaVersion(version: number): boolean {
  return (SUPPORTED_RESOURCE_SCHEMA_VERSIONS as readonly number[]).includes(version);
}
