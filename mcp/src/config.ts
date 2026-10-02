/**
 * Resolved runtime configuration for the MindVault MCP server.
 *
 * Network selection, service URLs, and the vault-registry contract id used to be
 * computed as top-level `const` side effects in index.ts, interleaved with two
 * `process.exit(1)` calls from the startup diagnostics. That made the config
 * path impossible to exercise from a unit test without spawning a process.
 *
 * This module is pure. `buildConfig` turns an environment into a typed,
 * frozen `McpConfig` and never throws. `resolveConfig` layers the startup
 * diagnostics on top and returns a result object — `{ ok: true, ... }` for a
 * usable environment or `{ ok: false, report, ... }` for one that should stop
 * the server — instead of calling `process.exit`. The entrypoint keeps the
 * fail-fast behaviour and the exact operator-facing messages; it just decides
 * *when* to exit rather than having module load decide for it.
 *
 * Every value falls back to a network preset or a documented default, so a
 * minimal environment still produces a complete config (validation then reports
 * whatever is missing or inconsistent).
 */

import {
  networks as registryNetworks,
  normalizeX402Network,
  resolveStellarNetwork,
  X402_NETWORK_IDS,
  type NetworkPreset,
  type StellarDeploymentNetwork,
} from "@mindvault/registry-client";
import {
  collectStartupDiagnostics,
  formatDiagnostics,
  hasBlockingDiagnostics,
  type StartupDiagnostic,
} from "./diagnostics.js";

/** MindVault API base URL used when `MINDVAULT_URL` is unset. */
export const DEFAULT_MINDVAULT_URL = "https://mindvault-hyr3.onrender.com";

/** Sponsored-account service URL used when `SPONSORED_ACCOUNT_URL` is unset. */
export const DEFAULT_SPONSORED_ACCOUNT_URL = "https://stellar-sponsored-agent-account.onrender.com";

/** The canonical x402 network identifiers (`stellar:testnet` / `stellar:pubnet`). */
export type X402NetworkId = (typeof X402_NETWORK_IDS)[keyof typeof X402_NETWORK_IDS];

/**
 * Fully resolved configuration. Every field is populated: env var when set,
 * otherwise the preset for the selected Stellar network, otherwise a default.
 */
export interface McpConfig {
  /** `testnet` or `mainnet`, from `STELLAR_NETWORK` (unrecognized ⇒ `testnet`). */
  readonly stellarNetwork: StellarDeploymentNetwork;
  /** The registry-client preset for `stellarNetwork` (RPC/Horizon/USDC/passphrase). */
  readonly networkPreset: NetworkPreset;
  /** x402 payment network, from `NETWORK` or the preset, normalized. */
  readonly x402Network: X402NetworkId;
  /** MindVault API base URL (`MINDVAULT_URL`). */
  readonly baseUrl: string;
  /** vault-registry contract id (`VAULT_REGISTRY_CONTRACT_ID` or preset default; `""` when neither). */
  readonly registryContractId: string;
  /** Stellar network passphrase for the selected network. */
  readonly registryNetworkPassphrase: string;
  /** Sponsored-account service URL (`SPONSORED_ACCOUNT_URL`). */
  readonly sponsoredAccountUrl: string;
  /** Horizon base URL (`HORIZON_URL` or preset). */
  readonly horizonUrl: string;
  /** Soroban RPC URL (`SOROBAN_RPC_URL` or preset). */
  readonly sorobanRpcUrl: string;
  /**
   * Platform (vault operator) wallet address, from `PLATFORM_WALLET_ADDRESS`.
   * Used by `mindvault_wallet_balances` to report the platform balance next to
   * the agent wallets. `null` when not configured. This is the MCP-side twin of
   * the server's `PAY_TO`: it names the wallet that receives publisher payouts.
   */
  readonly platformWalletAddress: string | null;
}

/**
 * Resolve the typed configuration from an environment. Pure and total: it never
 * throws and never exits. An empty environment yields the testnet preset with
 * every default filled in. Validation is a separate concern — see
 * {@link resolveConfig}.
 */
export function buildConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const stellarNetwork = resolveStellarNetwork(env.STELLAR_NETWORK);
  const networkPreset = registryNetworks[stellarNetwork];

  return Object.freeze({
    stellarNetwork,
    networkPreset,
    x402Network: normalizeX402Network(env.NETWORK ?? networkPreset.x402Network) as X402NetworkId,
    baseUrl: env.MINDVAULT_URL ?? DEFAULT_MINDVAULT_URL,
    registryContractId:
      env.VAULT_REGISTRY_CONTRACT_ID ?? networkPreset.defaultRegistryContractId ?? "",
    registryNetworkPassphrase: networkPreset.networkPassphrase,
    sponsoredAccountUrl: env.SPONSORED_ACCOUNT_URL ?? DEFAULT_SPONSORED_ACCOUNT_URL,
    horizonUrl: env.HORIZON_URL ?? networkPreset.horizonUrl,
    sorobanRpcUrl: env.SOROBAN_RPC_URL ?? networkPreset.sorobanRpcUrl,
    platformWalletAddress: env.PLATFORM_WALLET_ADDRESS?.trim()
      ? env.PLATFORM_WALLET_ADDRESS.trim()
      : null,
  });
}

/**
 * The outcome of resolving and validating the environment.
 *
 * `config` is present on both branches so callers that intentionally bypass
 * fail-fast (the test runner, mock mode) can still use a complete config even
 * when the environment has blocking problems — mirroring the previous
 * behaviour, where the config `const`s were always computed and only the
 * `process.exit` was skipped.
 *
 * - `ok: true`  — no error-severity diagnostic. `report` is a warnings-only
 *   summary when there are advisory warnings, otherwise `null`.
 * - `ok: false` — at least one blocking diagnostic. `report` is the full
 *   formatted diagnostics block (always a non-empty string) and the caller
 *   should print it and exit non-zero.
 */
export type ConfigResolution =
  | {
      readonly ok: true;
      readonly config: McpConfig;
      readonly diagnostics: readonly StartupDiagnostic[];
      readonly report: string | null;
    }
  | {
      readonly ok: false;
      readonly config: McpConfig;
      readonly diagnostics: readonly StartupDiagnostic[];
      readonly report: string;
    };

/**
 * Resolve the config and run startup diagnostics against the same environment.
 *
 * This is the tested replacement for the top-level diagnostics block that used
 * to call `process.exit(1)` during module load. It performs no I/O and never
 * exits; the entrypoint inspects `ok` / `report` and decides what to do.
 *
 * `hasGlobalFetch` is forwarded to {@link collectStartupDiagnostics} so the
 * missing-runtime-fetch check stays testable without deleting the real global.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  hasGlobalFetch: boolean = typeof fetch === "function",
): ConfigResolution {
  const config = buildConfig(env);
  const diagnostics = collectStartupDiagnostics(env, hasGlobalFetch);

  if (hasBlockingDiagnostics(diagnostics)) {
    return { ok: false, config, diagnostics, report: formatDiagnostics(diagnostics) };
  }
  return {
    ok: true,
    config,
    diagnostics,
    report: diagnostics.length > 0 ? formatDiagnostics(diagnostics) : null,
  };
}
