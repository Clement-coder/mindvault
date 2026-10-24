/**
 * Registry schema version compatibility guard for the MindVault MCP server (#1055).
 *
 * Fail closed when the configured contract exposes a schema version the MCP
 * client does not understand.
 *
 * When the configured vault-registry contract reports an unsupported schema version:
 *  - On-chain mutations are blocked with an actionable compatibility error.
 *  - Read-only diagnostics (mindvault_registry_info, mindvault_registry_health,
 *    mindvault_check_bindings, mindvault_network_profile, etc.) remain operational
 *    so operators and agents can inspect the deployment.
 *  - Existing client compatibility is preserved for supported schema versions (v6 and v7).
 */

import { Client as ContractClient } from "@stellar/stellar-sdk/contract";
import {
  CURRENT_RESOURCE_SCHEMA_VERSION,
  SUPPORTED_RESOURCE_SCHEMA_VERSIONS,
  isSupportedResourceSchemaVersion,
  createRegistryClient,
} from "@mindvault/registry-client";
import { mcpError, type MappedErrorException } from "./errorMapping.js";
import { _isMock } from "./runtime.js";

export {
  CURRENT_RESOURCE_SCHEMA_VERSION,
  SUPPORTED_RESOURCE_SCHEMA_VERSIONS,
  isSupportedResourceSchemaVersion,
};

/** Tools that mutate the on-chain vault-registry contract. */
export const ONCHAIN_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "mindvault_register_onchain",
  "mindvault_update_metadata",
  "mindvault_set_price",
  "mindvault_transfer_ownership",
  "mindvault_accept_transfer",
  "mindvault_cancel_transfer",
  "mindvault_set_listed",
  "mindvault_set_tags",
  "mindvault_freeze",
  "mindvault_royalty",
  "mindvault_publish",
  "mindvault_publish_batch",
  "mindvault_buy_lease",
  "mindvault_terms",
]);

/**
 * Check whether a tool invocation attempts an on-chain mutation.
 * Dry runs and read operations (like mindvault_terms with operation="get")
 * are not mutations and are not blocked by the schema guard.
 */
export function isOnChainMutation(
  name: string,
  rawArgs?: Record<string, unknown>,
): boolean {
  if (!ONCHAIN_MUTATION_TOOLS.has(name)) return false;
  if (name === "mindvault_publish" && rawArgs?.dryRun === true) return false;
  if (name === "mindvault_buy_lease" && rawArgs?.dryRun === true) return false;
  if (name === "mindvault_terms" && rawArgs?.operation === "get") return false;
  return true;
}

export interface DeployedSchemaQuery {
  contractId: string;
  rpcUrl: string;
  networkPassphrase?: string;
}

export interface RegistrySchemaCheckOptions extends DeployedSchemaQuery {
  network?: string;
  fetchContractSchemaVersion?: (query: DeployedSchemaQuery) => Promise<number>;
  supportedVersions?: readonly number[];
}

export interface RegistrySchemaCheckResult {
  ok: boolean;
  status: "supported" | "unsupported" | "error";
  detectedVersion?: number;
  supportedVersions: readonly number[];
  message: string;
}

// In-memory override for testing and mock mode
let schemaVersionOverride: number | null = null;

export function setRegistrySchemaVersionOverride(version: number | null): void {
  schemaVersionOverride = version;
}

// Cache for detected contract schema versions
interface CachedSchema {
  version: number;
  fetchedAt: number;
}
const schemaCache = new Map<string, CachedSchema>();
const CACHE_TTL_MS = 60_000;

export function resetRegistrySchemaCache(): void {
  schemaCache.clear();
  schemaVersionOverride = null;
}

/**
 * Query the deployed contract for its Resource schema version.
 * Tries `contract_version`, then `registry_info`, then `resource_schema_version`.
 */
export async function fetchDeployedResourceSchemaVersion(
  query: DeployedSchemaQuery,
): Promise<number> {
  const client = createRegistryClient({
    contractId: query.contractId,
    rpcUrl: query.rpcUrl,
    networkPassphrase: query.networkPassphrase,
  });

  // 1. Try contract_version()
  try {
    const tx = await client.contract_version();
    if (tx?.result && typeof tx.result.resource_schema_version === "number") {
      return tx.result.resource_schema_version;
    }
  } catch {
    // try fallback
  }

  // 2. Try registry_info()
  try {
    const tx = await client.registry_info();
    if (tx?.result && typeof tx.result.resource_schema_version === "number") {
      return tx.result.resource_schema_version;
    }
  } catch {
    // try fallback
  }

  // 3. Try bare resource_schema_version()
  try {
    const deployed = await ContractClient.from({
      contractId: query.contractId,
      rpcUrl: query.rpcUrl,
      networkPassphrase: query.networkPassphrase ?? "Test SDF Network ; September 2015",
    });
    const method = (deployed as any).resource_schema_version;
    if (typeof method === "function") {
      const tx = await method();
      if (typeof tx?.result === "number") {
        return tx.result;
      }
    }
  } catch {
    // fallback failed
  }

  throw new Error(
    `Failed to query resource schema version from contract ${query.contractId}. Neither contract_version, registry_info, nor resource_schema_version returned a valid version.`,
  );
}

/**
 * Check whether the configured contract exposes a supported schema version.
 */
export async function checkRegistrySchema(
  options: RegistrySchemaCheckOptions,
): Promise<RegistrySchemaCheckResult> {
  const supported = options.supportedVersions ?? SUPPORTED_RESOURCE_SCHEMA_VERSIONS;
  const network = options.network ?? "unknown";

  // Check explicit test override
  if (schemaVersionOverride !== null) {
    const ok = supported.includes(schemaVersionOverride);
    return {
      ok,
      status: ok ? "supported" : "unsupported",
      detectedVersion: schemaVersionOverride,
      supportedVersions: supported,
      message: ok
        ? `Registry schema version ${schemaVersionOverride} is supported.`
        : `Registry schema version ${schemaVersionOverride} is unsupported (supported: ${supported.join(", ")}).`,
    };
  }

  // Check environment variable override (e.g. MINDVAULT_REGISTRY_SCHEMA_VERSION=8)
  const envVal = process.env.MINDVAULT_REGISTRY_SCHEMA_VERSION;
  if (envVal !== undefined && envVal.trim() !== "") {
    const parsed = parseInt(envVal.trim(), 10);
    if (!Number.isNaN(parsed)) {
      const ok = supported.includes(parsed);
      return {
        ok,
        status: ok ? "supported" : "unsupported",
        detectedVersion: parsed,
        supportedVersions: supported,
        message: ok
          ? `Registry schema version ${parsed} is supported.`
          : `Registry schema version ${parsed} is unsupported (supported: ${supported.join(", ")}).`,
      };
    }
  }

  // Mock mode default
  if (_isMock()) {
    return {
      ok: true,
      status: "supported",
      detectedVersion: CURRENT_RESOURCE_SCHEMA_VERSION,
      supportedVersions: supported,
      message: `Mock mode: using registry schema version ${CURRENT_RESOURCE_SCHEMA_VERSION}.`,
    };
  }

  if (!options.contractId) {
    return {
      ok: false,
      status: "error",
      supportedVersions: supported,
      message: "VAULT_REGISTRY_CONTRACT_ID is not set.",
    };
  }

  // Check cache
  const cacheKey = `${options.contractId}:${options.rpcUrl}:${options.networkPassphrase ?? ""}`;
  const cached = schemaCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    const ok = supported.includes(cached.version);
    return {
      ok,
      status: ok ? "supported" : "unsupported",
      detectedVersion: cached.version,
      supportedVersions: supported,
      message: ok
        ? `Registry schema version ${cached.version} is supported.`
        : `Registry schema version ${cached.version} is unsupported (supported: ${supported.join(", ")}).`,
    };
  }

  const fetcher = options.fetchContractSchemaVersion ?? fetchDeployedResourceSchemaVersion;
  let detectedVersion: number;
  try {
    detectedVersion = await fetcher({
      contractId: options.contractId,
      rpcUrl: options.rpcUrl,
      networkPassphrase: options.networkPassphrase,
    });
  } catch (err) {
    return {
      ok: false,
      status: "error",
      supportedVersions: supported,
      message: `Could not verify registry schema version for contract ${options.contractId} on ${network}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  schemaCache.set(cacheKey, { version: detectedVersion, fetchedAt: Date.now() });
  const ok = supported.includes(detectedVersion);
  return {
    ok,
    status: ok ? "supported" : "unsupported",
    detectedVersion,
    supportedVersions: supported,
    message: ok
      ? `Registry schema version ${detectedVersion} is supported.`
      : `Registry schema version ${detectedVersion} is unsupported (supported: ${supported.join(", ")}).`,
  };
}

/**
 * Actionable compatibility error when the contract exposes an unsupported schema version.
 */
export function unsupportedRegistrySchemaError(input: {
  toolName: string;
  contractId: string;
  detectedVersion: number;
  supportedVersions: readonly number[];
  network: string;
}): MappedErrorException {
  const { toolName, contractId, detectedVersion, supportedVersions, network } = input;
  const minSupported = Math.min(...supportedVersions);
  const maxSupported = Math.max(...supportedVersions);

  const direction =
    detectedVersion > maxSupported
      ? `The deployed contract exposes schema version ${detectedVersion}, which is newer than the supported versions (${supportedVersions.join(", ")}). Upgrade @mindvault/mcp and @mindvault/registry-client to support schema version ${detectedVersion}.`
      : `The deployed contract exposes schema version ${detectedVersion}, which is older than the supported versions (${supportedVersions.join(", ")}). Upgrade or redeploy the vault-registry contract to a supported version (${supportedVersions.join(", ")}), or configure VAULT_REGISTRY_CONTRACT_ID to a compatible deployment.`;

  const summary = `Registry schema version ${detectedVersion} is unsupported: "${toolName}" was blocked to prevent data corruption or contract errors.`;
  const detail = `Configured contract ID: ${contractId}. Network: ${network}. Supported schema versions: ${supportedVersions.join(", ")}. Deployed schema version: ${detectedVersion}.`;
  const action = `${direction} Read-only diagnostics (such as mindvault_registry_info and mindvault_check_bindings) remain operational to inspect the environment.`;

  return mcpError({
    source: "registry",
    category: "contract",
    summary,
    detail,
    action,
  });
}

/**
 * Actionable error when the contract schema version cannot be verified (e.g. RPC failure).
 */
export function registrySchemaVerificationError(input: {
  toolName: string;
  contractId: string;
  network: string;
  error: unknown;
}): MappedErrorException {
  const { toolName, contractId, network, error } = input;
  const reason = error instanceof Error ? error.message : String(error);
  return mcpError({
    source: "registry",
    category: "contract",
    summary: `Registry schema check failed: "${toolName}" was not attempted because the contract schema version could not be verified (${reason}).`,
    detail: `Contract: ${contractId} (network: ${network}). The contract may be unreachable, not deployed at this ID, or the Soroban RPC may be down.`,
    action: `Verify connectivity and contract deployment with mindvault_registry_info or mindvault_registry_health before retrying mutations.`,
  });
}

/**
 * Assert that the configured contract exposes a supported schema version before executing a mutation.
 * Fails closed on unsupported versions or verification failures.
 */
export async function assertSupportedRegistrySchema(
  toolName: string,
  options: RegistrySchemaCheckOptions,
): Promise<void> {
  const network = options.network ?? "unknown";
  const result = await checkRegistrySchema(options);

  if (result.status === "unsupported" && result.detectedVersion !== undefined) {
    throw unsupportedRegistrySchemaError({
      toolName,
      contractId: options.contractId,
      detectedVersion: result.detectedVersion,
      supportedVersions: result.supportedVersions,
      network,
    });
  }

  if (result.status === "error") {
    throw registrySchemaVerificationError({
      toolName,
      contractId: options.contractId,
      network,
      error: new Error(result.message),
    });
  }
}
