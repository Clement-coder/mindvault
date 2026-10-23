/**
 * Canonical USDC identity verification (#1053).
 *
 * A Stellar asset is identified by the pair (asset_code, asset_issuer), not by
 * the code alone. Anyone can issue a credit_alphanum4 token with the code "USDC"
 * from a throwaway account; without checking the issuer, a counterfeit token
 * would be reported as the same USDC that x402 payments settle in, and an
 * attacker could trick an agent into trusting a worthless balance.
 *
 * This module centralises the identity check: a Horizon balance entry is only
 * the canonical USDC for the selected network when its `asset_code` is "USDC"
 * AND its `asset_issuer` matches the network preset's `usdcClassicIssuer`.
 * The preset is the single source of truth for which issuer address is real on
 * testnet vs. mainnet, so the check is always network-aware.
 *
 * Pure: no I/O, no side effects — just a predicate on a balance object and the
 * issuer string from the runtime preset.
 */

/** The Stellar asset code used by all USDC tokens, real or counterfeit. */
export const USDC_ASSET_CODE = "USDC";

/**
 * Type describing the subset of a Horizon balance entry this module needs.
 * Kept structural so it works with `any` from `res.json()` or typed fixtures.
 */
export interface HorizonBalanceEntry {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
}

/**
 * Determine whether a Horizon balance entry is the canonical USDC for the
 * selected network.
 *
 * Checks `asset_code === "USDC"` AND `asset_issuer === expectedIssuer`. The
 * issuer comes from the {@link NetworkPreset} so the check is correct for
 * whatever network the server is configured against (testnet vs. mainnet).
 *
 * @param balance  A single entry from Horizon's `balances` array.
 * @param expectedIssuer  The canonical USDC classic issuer for the network
 *   (from `networkPreset.usdcClassicIssuer`).
 * @returns `true` only when both code and issuer match.
 */
export function isCanonicalUsdc(balance: HorizonBalanceEntry, expectedIssuer: string): boolean {
  if (!balance) return false;
  if (balance.asset_type !== "credit_alphanum4") return false;
  if (balance.asset_code !== USDC_ASSET_CODE) return false;
  // An entry missing asset_issuer is definitely not canonical — the real USDC
  // issuer is always present in a Horizon /accounts response.
  if (!balance.asset_issuer) return false;
  return balance.asset_issuer === expectedIssuer;
}

/**
 * Find the canonical USDC balance entry in a Horizon balances array.
 *
 * Returns `undefined` when no entry matches both the USDC code and the
 * expected issuer, which means a counterfeit token named "USDC" with a
 * different issuer is never returned.
 *
 * @param balances  The `balances` array from a Horizon account response.
 * @param expectedIssuer  The canonical USDC classic issuer for the network.
 * @returns The matching balance entry, or `undefined`.
 */
export function findCanonicalUsdc(
  balances: readonly HorizonBalanceEntry[],
  expectedIssuer: string,
): HorizonBalanceEntry | undefined {
  return balances.find((b) => isCanonicalUsdc(b, expectedIssuer));
}
