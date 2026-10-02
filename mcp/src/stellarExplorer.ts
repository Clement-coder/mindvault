/**
 * Stellar Expert explorer links for MCP mutation and payment results.
 *
 * Successful registry mutations and payments carry an on-chain transaction
 * hash; surfacing a network-correct explorer URL alongside it lets an agent (or
 * a human reading the tool output) jump straight to the transaction without
 * hand-assembling a URL or guessing the network segment.
 *
 * The explorer network segment is derived from the same STELLAR_NETWORK env var
 * and network presets the rest of the MCP uses, so links always match the
 * network the server is actually operating on:
 *   - testnet  → https://stellar.expert/explorer/testnet/...
 *   - mainnet  → https://stellar.expert/explorer/public/...
 */

import {
  networks as registryNetworks,
  resolveStellarNetwork,
  type ExplorerNetwork,
} from "@mindvault/registry-client";

/** Explorer segment for the network this server is configured for. */
export function resolveExplorerNetwork(env: NodeJS.ProcessEnv = process.env): ExplorerNetwork {
  return registryNetworks[resolveStellarNetwork(env.STELLAR_NETWORK)].explorerNetwork;
}

/** Base explorer URL for a given network segment. */
function explorerBase(network: ExplorerNetwork, env: NodeJS.ProcessEnv = process.env): string {
  const preset = registryNetworks[resolveStellarNetwork(env.STELLAR_NETWORK)];
  const baseUrl = env.HORIZON_URL?.trim() || preset.explorerBaseUrl;
  return `${baseUrl.replace(/\/+$/, "")}/explorer/${network}`;
}

/**
 * Stellar Expert URL for a transaction hash, or `null` when there is no hash
 * (e.g. a mutation whose on-chain submission failed). Callers spread the result
 * conditionally so failed operations never emit a dead link.
 */
export function explorerTxUrl(
  txHash: string | null | undefined,
  network: ExplorerNetwork = resolveExplorerNetwork(),
): string | null {
  const hash = txHash?.trim();
  if (!hash) return null;
  // X-shard Soroban hashes arrive prefixed; the explorer only knows the raw hash (#847).
  const rawHash = hash.replace(/^soroban:/i, "");
  return `${explorerBase(network)}/tx/${rawHash}`;
}

/** Stellar Expert URL for an account / wallet address (G...). */
export function explorerAccountUrl(
  address: string,
  network: ExplorerNetwork = resolveExplorerNetwork(),
): string {
  return `${explorerBase(network)}/account/${address}`;
}

/** Stellar Expert URL for a Soroban contract id (C...). */
export function explorerContractUrl(
  contractId: string,
  network: ExplorerNetwork = resolveExplorerNetwork(),
): string {
  return `${explorerBase(network)}/contract/${contractId}`;
}
