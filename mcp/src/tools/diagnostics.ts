import { checkContractBindings } from "@mindvault/registry-client";
import {
  activeProfile,
  activeProfileName,
  BASE_URL,
  HORIZON_URL,
  httpFetch,
  httpRetryOptions,
  _isMock,
  jsonFetch,
  metrics,
  NETWORK,
  networkPreset,
  profiles,
  publisherCredential,
  REGISTRY_CONTRACT_ID,
  REGISTRY_NETWORK_PASSPHRASE,
  requireWallet,
  resolveAgentSecret,
  resolveProfileName,
  RETRY_POLICY,
  saveState,
  setActiveProfileName,
  SOROBAN_RPC_URL,
  STATE_FILE,
  STELLAR_NETWORK,
  TIMEOUTS,
  USER_AGENT,
} from "../runtime.js";
import { describeTimeouts, fetchWithTimeout } from "../httpTimeout.js";
import { describeRetryPolicy, withRetry } from "../retry.js";
import { throwHttpError } from "../errorMapping.js";
import { safeErrorMessage } from "../redaction.js";

export interface DependencyStatus {
  name: string;
  ok: boolean;
  message: string;
}

async function checkDependency(
  name: string,
  url: string,
  init?: RequestInit,
): Promise<DependencyStatus> {
  const initWithUA: RequestInit = {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init?.headers as Record<string, string> | undefined) },
  };
  try {
    const res = await withRetry(
      () => fetchWithTimeout(httpFetch, url, initWithUA, "http", TIMEOUTS.http),
      httpRetryOptions(`health:${name}`),
    );
    if (res.ok) {
      return { name, ok: true, message: `Reachable (HTTP ${res.status})` };
    }
    return { name, ok: false, message: `Returned HTTP ${res.status}` };
  } catch (err) {
    return { name, ok: false, message: `Unreachable: ${safeErrorMessage(err)}` };
  }
}

export async function registryHealth(): Promise<string> {
  const deps: DependencyStatus[] = [];

  deps.push(await checkDependency("MindVault API", `${BASE_URL}/resources`));
  deps.push(await checkDependency("Horizon", `${HORIZON_URL}`));

  deps.push(
    await checkDependency("Soroban RPC", SOROBAN_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork", params: {} }),
    }),
  );

  if (REGISTRY_CONTRACT_ID) {
    deps.push({
      name: "Registry contract",
      ok: true,
      message: `Contract ID: ${REGISTRY_CONTRACT_ID}`,
    });
  } else {
    deps.push({
      name: "Registry contract",
      ok: false,
      message: "VAULT_REGISTRY_CONTRACT_ID is not set.",
    });
  }

  const expectedNetwork = networkPreset.x402Network;
  const currentNetwork = NETWORK;
  if (currentNetwork === expectedNetwork) {
    deps.push({
      name: "x402 network",
      ok: true,
      message: `Aligned: ${currentNetwork}`,
    });
  } else {
    deps.push({
      name: "x402 network",
      ok: false,
      message: `Mismatch: expected ${expectedNetwork}, got ${currentNetwork}.`,
    });
  }

  const allOk = deps.every((d) => d.ok);
  const lines = deps.map((d) => {
    const icon = d.ok ? "✓" : "✗";
    return `${icon} ${d.name}: ${d.message}`;
  });
  lines.unshift(allOk ? "All dependencies healthy." : "Some dependencies are unhealthy.", "");
  return lines.join("\n");
}

export async function importWallet(args: {
  secretKey?: string;
  profile?: string;
  persist?: boolean;
}): Promise<string> {
  const target = resolveProfileName(args.profile);
  const persist = args.persist !== false;

  let secretKey = args.secretKey;
  if (!secretKey) {
    secretKey = resolveAgentSecret();
  }
  if (!secretKey) {
    throw new Error(
      "No secret key provided. Pass secretKey or set MINDVAULT_AGENT_SECRET in the environment.",
    );
  }

  if (!/^S[A-Z2-7]{55}$/.test(secretKey)) {
    throw new Error("Invalid Stellar secret key. Must be S followed by 55 base32 characters.");
  }

  let publicKey: string;
  try {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const keypair = Keypair.fromSecret(secretKey);
    publicKey = keypair.publicKey();
  } catch (err) {
    throw new Error(`Failed to derive public key: ${safeErrorMessage(err)}`);
  }

  if (persist) {
    setActiveProfileName(target);
    activeProfile().wallet = { publicKey, secretKey };
    saveState();
    return [
      `Wallet imported.`,
      `Profile: ${target}`,
      `Address: ${publicKey}`,
      `Wallet persisted to ${STATE_FILE} (mode 0600).`,
    ].join("\n");
  }

  return [
    `Wallet validated (not persisted).`,
    `Address: ${publicKey}`,
    `Pass persist: true to save to the state file.`,
  ].join("\n");
}

export async function rotatePublisherKey(profileArg?: string): Promise<string> {
  const target = resolveProfileName(profileArg);
  const wallet = requireWallet();
  const oldApiKey = profiles[target]?.apiKey;
  if (!oldApiKey) {
    throw new Error(`No publisher API key in profile "${target}". Run mindvault_register first.`);
  }

  const res = await jsonFetch(`${BASE_URL}/publishers/rotate-key`, {
    method: "POST",
    headers: { "x-api-key": oldApiKey },
  });

  if (!res.ok) {
    throwHttpError({
      operation: "Failed to rotate publisher API key",
      source: "api",
      status: res.status,
      data: res.data,
      credential: publisherCredential(target),
    });
  }

  const newApiKey = res.data.apiKey;
  if (typeof newApiKey !== "string" || newApiKey.length === 0) {
    throw new Error("Server returned an empty API key. Contact support.");
  }

  if (!profiles[target]) profiles[target] = {};
  profiles[target].apiKey = newApiKey;
  if (target !== activeProfileName) {
    setActiveProfileName(target);
  }
  saveState();

  return [
    `Publisher API key rotated.`,
    `Profile: ${target}`,
    `Publisher ID: ${res.data.id ?? "(unknown)"}`,
    `New key persisted to ${STATE_FILE} (not shown).`,
    `The old key has been invalidated server-side.`,
  ].join("\n");
}

export function networkProfile(): string {
  const warnings: string[] = [];

  const usdcContractId = process.env.USDC_CONTRACT_ID ?? networkPreset.usdcSacContractId;
  if (
    process.env.USDC_CONTRACT_ID &&
    process.env.USDC_CONTRACT_ID !== networkPreset.usdcSacContractId
  ) {
    warnings.push(
      `USDC_CONTRACT_ID overrides preset (${networkPreset.usdcSacContractId} → ${process.env.USDC_CONTRACT_ID})`,
    );
  }
  if (process.env.SOROBAN_RPC_URL && process.env.SOROBAN_RPC_URL !== networkPreset.sorobanRpcUrl) {
    warnings.push(
      `SOROBAN_RPC_URL overrides preset (${networkPreset.sorobanRpcUrl} → ${process.env.SOROBAN_RPC_URL})`,
    );
  }
  if (process.env.HORIZON_URL && process.env.HORIZON_URL !== networkPreset.horizonUrl) {
    warnings.push(
      `HORIZON_URL overrides preset (${networkPreset.horizonUrl} → ${process.env.HORIZON_URL})`,
    );
  }
  if (
    process.env.VAULT_REGISTRY_CONTRACT_ID &&
    networkPreset.defaultRegistryContractId &&
    process.env.VAULT_REGISTRY_CONTRACT_ID !== networkPreset.defaultRegistryContractId
  ) {
    warnings.push(
      `VAULT_REGISTRY_CONTRACT_ID overrides preset (${networkPreset.defaultRegistryContractId} → ${process.env.VAULT_REGISTRY_CONTRACT_ID})`,
    );
  }
  if (process.env.NETWORK && process.env.NETWORK !== networkPreset.x402Network) {
    warnings.push(
      `NETWORK overrides preset (${networkPreset.x402Network} → ${process.env.NETWORK})`,
    );
  }

  const profile = {
    stellarNetwork: STELLAR_NETWORK,
    x402Network: NETWORK,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    horizonUrl: HORIZON_URL,
    registryContractId: REGISTRY_CONTRACT_ID,
    usdcContractId,
    timeouts: describeTimeouts(TIMEOUTS),
    retries: describeRetryPolicy(RETRY_POLICY),
    warnings,
  };

  return JSON.stringify(profile, null, 2);
}

export async function checkBindings(): Promise<string> {
  if (_isMock()) return "Mock mode: contract binding check skipped (no live RPC).";
  const result = await checkContractBindings({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    network: STELLAR_NETWORK,
  });
  return result.message;
}

export function toolMetrics(reset: boolean): string {
  const snapshot = metrics.snapshot();
  if (reset) metrics.reset();
  if (!snapshot.enabled) {
    return JSON.stringify(
      {
        enabled: false,
        message:
          "Metrics are disabled. Set MINDVAULT_METRICS=1 (or true/yes/on) and restart the server to collect tool-level metrics.",
      },
      null,
      2,
    );
  }
  return JSON.stringify(snapshot, null, 2);
}
