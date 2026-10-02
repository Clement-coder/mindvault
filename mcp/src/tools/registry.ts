import {
  createRegistryClient,
  Errors as RegistryErrors,
  listResources,
  type Resource,
} from "@mindvault/registry-client";
import {
  BASE_URL,
  HORIZON_URL,
  httpFetch,
  httpRetryOptions,
  _isMock,
  jsonFetch,
  NETWORK,
  REGISTRY_CONTRACT_ID,
  REGISTRY_NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  STELLAR_NETWORK,
  TIMEOUTS,
  USER_AGENT,
  currentWallet,
} from "../runtime.js";
import type { CatalogFilters } from "../catalogFilters.js";
import { mapRegistryError, mapTransportError, mcpError, throwHttpError } from "../errorMapping.js";
import { fetchWithTimeout } from "../httpTimeout.js";
import { withRetry } from "../retry.js";
import { parseMetadataHash } from "../metadataHash.js";
import { mainnetAllowedFromEnv, formatMainnetDiagnostics } from "../mainnetGuardrails.js";
import { mockRegistryCount, mockRegistryList, mockRegistryLookup } from "../mock.js";
import { type AgentWallet } from "../profiles.js";
import { stroopsToUsdc } from "../usdcAmount.js";

export interface BalanceDetails {
  status: "missing" | "no-trustline" | "zero" | "funded";
  xlmBalance: string;
  xlmReserve: string;
  xlmAvailable: string;
  usdcBalance: string;
  message?: string;
}

export async function getBalanceDetails(publicKey: string): Promise<BalanceDetails> {
  let res: Response;
  try {
    res = await withRetry(
      () =>
        fetchWithTimeout(
          httpFetch,
          `${HORIZON_URL}/accounts/${publicKey}`,
          { headers: { "User-Agent": USER_AGENT } },
          "horizon",
          TIMEOUTS.horizon,
        ),
      httpRetryOptions("GET horizon /accounts"),
    );
  } catch (err) {
    throw mcpError(
      mapTransportError({
        operation: "Horizon request failed",
        source: "horizon",
        error: err,
      }),
    );
  }

  if (res.status === 404) {
    return {
      status: "missing",
      xlmBalance: "0",
      xlmReserve: "0",
      xlmAvailable: "0",
      usdcBalance: "0",
      message: `Account ${publicKey} does not exist. Fund it with at least 1 XLM to activate.`,
    };
  }

  if (!res.ok) {
    throwHttpError({
      operation: `Horizon error ${res.status}`,
      source: "horizon",
      status: res.status,
      data: await res.text().catch(() => null),
    });
  }

  const data: any = await res.json();
  const balances: any[] = data.balances ?? [];

  const xlmBalance = balances.find((b: any) => b.asset_type === "native");
  const xlm = xlmBalance?.balance ?? "0";

  const subentryCount = data.subentry_count ?? 0;
  const baseReserve = 0.5;
  const entryReserve = 0.5;
  const reserve = baseReserve + subentryCount * entryReserve;
  const available = Math.max(0, parseFloat(xlm) - reserve);

  const usdcBalance = balances.find(
    (b: any) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC",
  );

  if (!usdcBalance) {
    return {
      status: "no-trustline",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: "0",
      message: `USDC trustline not found. Add a USDC trustline to receive payments.`,
    };
  }

  const usdc = usdcBalance.balance ?? "0";
  const usdcFloat = parseFloat(usdc);

  if (usdcFloat === 0) {
    return {
      status: "zero",
      xlmBalance: xlm,
      xlmReserve: reserve.toFixed(1),
      xlmAvailable: available.toFixed(7),
      usdcBalance: usdc,
      message: `USDC balance is zero. Fund the account to use x402 payments.`,
    };
  }

  return {
    status: "funded",
    xlmBalance: xlm,
    xlmReserve: reserve.toFixed(1),
    xlmAvailable: available.toFixed(7),
    usdcBalance: usdc,
  };
}

export async function getUsdcBalance(publicKey: string): Promise<string> {
  try {
    const details = await getBalanceDetails(publicKey);
    return details.usdcBalance;
  } catch {
    return "0";
  }
}

export async function getAccountBalances(
  publicKey: string,
): Promise<{ usdc: string; native: string; funded: boolean }> {
  const res = await withRetry(
    () =>
      fetchWithTimeout(
        httpFetch,
        `${HORIZON_URL}/accounts/${publicKey}`,
        { headers: { "User-Agent": USER_AGENT } },
        "horizon",
        TIMEOUTS.horizon,
      ),
    httpRetryOptions("GET horizon /accounts"),
  );
  if (!res.ok) return { usdc: "0", native: "0", funded: false };
  const data: any = await res.json();
  const balances: any[] = data.balances ?? [];
  const usdc = balances.find((b) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC");
  const native = balances.find((b) => b.asset_type === "native");
  return { usdc: usdc?.balance ?? "0", native: native?.balance ?? "0", funded: true };
}

export function formatResource(r: any): string {
  const tags = Array.isArray(r.tags) && r.tags.length > 0 ? `\n  Tags: ${r.tags.join(", ")}` : "";
  if (tags) {
    return `[${r.id}] ${r.title} - $${r.price} USDC\n  ${r.description ?? ""}${tags}\n  ${r.accessUrl}`;
  }
  return `[${r.id}] ${r.title} — $${r.price} USDC\n  ${r.description ?? ""}\n  ${r.accessUrl}`;
}

export type SearchFilters = CatalogFilters;

export async function insufficientFundsMessage(
  wallet: AgentWallet,
  amountNeeded: string | number,
  action: string,
): Promise<string | null> {
  const need = typeof amountNeeded === "number" ? amountNeeded : parseFloat(amountNeeded);
  if (!Number.isFinite(need)) return null;
  const balance = await getUsdcBalance(wallet.publicKey);
  const have = parseFloat(balance);
  if (!Number.isFinite(have) || have >= need) return null;
  const shortfall = need - have;
  return [
    `Insufficient USDC to ${action}.`,
    `Amount needed: ${need} USDC`,
    `Current balance: ${have} USDC`,
    `Shortfall: ${shortfall.toFixed(7).replace(/\.?0+$/, "")} USDC`,
    `Fund ${wallet.publicKey} with the shortfall and retry.`,
  ].join("\n");
}

export async function registryLookup(resourceId: string): Promise<string> {
  if (_isMock())
    return mockRegistryLookup(resourceId, REGISTRY_CONTRACT_ID, currentWallet()?.publicKey);
  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
  });

  let tx: Awaited<ReturnType<typeof client.get>>;
  try {
    tx = await client.get({ id: resourceId });
  } catch (err: any) {
    throw mcpError(
      mapTransportError({
        operation: `On-chain lookup failed for resource "${resourceId}" (contract ${REGISTRY_CONTRACT_ID}, RPC ${SOROBAN_RPC_URL})`,
        source: "soroban",
        error: err,
      }),
    );
  }

  const result = tx.result;
  if (result.isErr()) {
    const err = result.unwrapErr();
    if (err.message === RegistryErrors[2].message) {
      return JSON.stringify(
        {
          source: "on-chain",
          found: false,
          resourceId,
          message: `Resource "${resourceId}" is not registered on-chain. It may not have been listed yet or the ID may be incorrect.`,
          next: mapRegistryError({
            operation: "Registry lookup",
            message: err.message,
            notFound: true,
          }).action,
          contract: REGISTRY_CONTRACT_ID,
          network: REGISTRY_NETWORK_PASSPHRASE,
          rpc: SOROBAN_RPC_URL,
        },
        null,
        2,
      );
    }
    throw mcpError(
      mapRegistryError({
        operation: `Contract error for resource "${resourceId}" (contract ${REGISTRY_CONTRACT_ID}, network ${REGISTRY_NETWORK_PASSPHRASE})`,
        message: err.message,
      }),
    );
  }

  const resource = result.unwrap();
  const priceUsdc = stroopsToUsdc(BigInt(resource.price as unknown as bigint));

  return JSON.stringify(
    {
      source: "on-chain",
      found: true,
      id: resource.id,
      creator: resource.creator,
      price: `${priceUsdc} USDC`,
      metadata: resource.metadata,
      listed: resource.listed,
      tags: resource.tags,
      contract: REGISTRY_CONTRACT_ID,
      network: REGISTRY_NETWORK_PASSPHRASE,
      rpc: SOROBAN_RPC_URL,
    },
    null,
    2,
  );
}

export async function registryList(start: number, limit: number): Promise<string> {
  if (_isMock())
    return mockRegistryList(start, limit, REGISTRY_CONTRACT_ID, currentWallet()?.publicKey);

  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
  });

  let resources: Resource[];
  try {
    resources = await listResources(client, start, limit);
  } catch (err: unknown) {
    throw mcpError(
      mapTransportError({
        operation: `On-chain list failed (contract ${REGISTRY_CONTRACT_ID}, RPC ${SOROBAN_RPC_URL}, start ${start}, limit ${limit})`,
        source: "soroban",
        error: err,
      }),
    );
  }

  if (resources.length === 0) {
    const message =
      start === 0
        ? "No resources registered on-chain yet."
        : `No on-chain resources in range [${start}, ${start + limit}). Try a lower start index or call mindvault_registry_info for contract context.`;
    return JSON.stringify(
      {
        source: "on-chain",
        start,
        limit,
        count: 0,
        message,
        resources: [],
        contract: REGISTRY_CONTRACT_ID,
        network: REGISTRY_NETWORK_PASSPHRASE,
        rpc: SOROBAN_RPC_URL,
      },
      null,
      2,
    );
  }

  const items = resources.map((resource) => {
    const priceUsdc = stroopsToUsdc(BigInt(resource.price as unknown as bigint));
    return {
      id: resource.id,
      creator: resource.creator,
      price: `${priceUsdc} USDC`,
      metadata: resource.metadata,
      listed: resource.listed,
      tags: resource.tags,
    };
  });

  return JSON.stringify(
    {
      source: "on-chain",
      start,
      limit,
      count: items.length,
      resources: items,
      contract: REGISTRY_CONTRACT_ID,
      network: REGISTRY_NETWORK_PASSPHRASE,
      rpc: SOROBAN_RPC_URL,
    },
    null,
    2,
  );
}

/**
 * On-chain registry count family — mirrors the contract's count(),
 * listed_count(), and creator_resource_count(creator) read-only calls.
 *
 * @param creator Optional Stellar public key. When supplied, also returns the
 *   number of resources currently owned by that address.
 */
export async function registryCount(creator?: string): Promise<string> {
  if (_isMock()) return mockRegistryCount(creator, REGISTRY_CONTRACT_ID);

  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
  });

  let count: number;
  let listedCount: number;
  let creatorCount: number | null = null;

  try {
    const countTx = await client.count();
    count = Number(countTx.result);
  } catch (err: unknown) {
    throw mcpError(
      mapTransportError({
        operation: `Registry count() failed (contract ${REGISTRY_CONTRACT_ID}, RPC ${SOROBAN_RPC_URL})`,
        source: "soroban",
        error: err,
      }),
    );
  }

  try {
    // listed_count is present in the Rust contract but not yet included in the
    // generated TypeScript bindings; access via `as any` until bindings are
    // regenerated with `pnpm contract:bindings`.
    const listedTx = await (client as any).listed_count();
    listedCount = Number(listedTx.result);
  } catch (err: unknown) {
    throw mcpError(
      mapTransportError({
        operation: `Registry listed_count() failed (contract ${REGISTRY_CONTRACT_ID}, RPC ${SOROBAN_RPC_URL})`,
        source: "soroban",
        error: err,
      }),
    );
  }

  if (creator) {
    try {
      const creatorTx = await (client as any).creator_resource_count({ creator });
      creatorCount = Number(creatorTx.result);
    } catch (err: unknown) {
      throw mcpError(
        mapTransportError({
          operation: `Registry creator_resource_count() failed for "${creator}" (contract ${REGISTRY_CONTRACT_ID}, RPC ${SOROBAN_RPC_URL})`,
          source: "soroban",
          error: err,
        }),
      );
    }
  }

  const payload: {
    source: string;
    count: number;
    listedCount: number;
    creatorCount?: number;
    creator?: string;
    contract: string;
    network: string;
    rpc: string;
  } = {
    source: "on-chain",
    count,
    listedCount,
    contract: REGISTRY_CONTRACT_ID,
    network: REGISTRY_NETWORK_PASSPHRASE,
    rpc: SOROBAN_RPC_URL,
  };

  if (creator != null) {
    payload.creator = creator;
    payload.creatorCount = creatorCount!;
  }

  return JSON.stringify(payload, null, 2);
}

export function registryInfo(): string {
  const info: {
    contractId: string;
    networkPassphrase: string;
    rpcUrl: string;
    network: string;
    x402Network: string;
    resourceFields: (keyof Resource)[];
    mainnetDiagnostics: string;
  } = {
    contractId: REGISTRY_CONTRACT_ID,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    rpcUrl: SOROBAN_RPC_URL,
    network: STELLAR_NETWORK,
    x402Network: NETWORK,
    resourceFields: ["id", "creator", "price", "metadata", "listed"],
    mainnetDiagnostics: formatMainnetDiagnostics({
      stellarNetwork: STELLAR_NETWORK,
      x402Network: NETWORK,
      registryContractId: REGISTRY_CONTRACT_ID,
      allowMainnetEnv: mainnetAllowedFromEnv(),
    }),
  };
  return JSON.stringify(info, null, 2);
}

export async function checkConsistency(
  resourceId: string,
  expectedMetadataHash?: string,
): Promise<string> {
  if (!resourceId) throw new Error("resourceId is required.");
  const expected = expectedMetadataHash
    ? parseMetadataHash(expectedMetadataHash, "expectedMetadataHash").canonical
    : null;

  const apiRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  const apiData = apiRes.ok ? apiRes.data : null;

  let onchainData: any = null;
  let onchainError: string | null = null;
  try {
    const client = createRegistryClient({
      contractId: REGISTRY_CONTRACT_ID,
      rpcUrl: SOROBAN_RPC_URL,
      networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    });
    const tx = await client.get({ id: resourceId });
    if (tx.result.isOk()) {
      onchainData = tx.result.unwrap();
    } else {
      onchainError = tx.result.unwrapErr().message;
    }
  } catch (err: any) {
    onchainError = err.message;
  }

  const report: {
    resourceId: string;
    apiFound: boolean;
    onchainFound: boolean;
    onchainError: string | null;
    matches: Record<string, { api: any; onchain: any }>;
    mismatches: Record<string, { api: any; onchain: any }>;
    missingInApi: string[];
    missingInOnchain: string[];
  } = {
    resourceId,
    apiFound: !!apiData,
    onchainFound: !!onchainData,
    onchainError,
    matches: {},
    mismatches: {},
    missingInApi: [],
    missingInOnchain: [],
  };

  if (!apiData && !onchainData) {
    return JSON.stringify(
      {
        ...report,
        summary: "Resource not found in API catalog or on-chain registry.",
      },
      null,
      2,
    );
  }

  if (!apiData) {
    report.missingInApi = ["id", "title", "price", "metadata", "listed"];
    return JSON.stringify(
      {
        ...report,
        summary: "Resource exists on-chain but not in API catalog.",
      },
      null,
      2,
    );
  }

  if (!onchainData) {
    report.missingInOnchain = ["id", "creator", "price", "metadata", "listed"];
    return JSON.stringify(
      {
        ...report,
        summary: "Resource exists in API catalog but not on-chain registry.",
      },
      null,
      2,
    );
  }

  const priceUsdc = stroopsToUsdc(BigInt(onchainData.price as unknown as bigint));

  const apiPrice = parseFloat(apiData.price || "0");
  const onchainPrice = parseFloat(priceUsdc);
  if (Math.abs(apiPrice - onchainPrice) < 0.0000001) {
    report.matches.price = { api: apiData.price, onchain: priceUsdc };
  } else {
    report.mismatches.price = { api: apiData.price, onchain: priceUsdc };
  }

  if (apiData.verificationStatus === "verified" && onchainData.listed === true) {
    report.matches.listed = { api: "verified", onchain: true };
  } else if (apiData.verificationStatus !== "verified" && onchainData.listed === false) {
    report.matches.listed = { api: apiData.verificationStatus, onchain: false };
  } else {
    report.mismatches.listed = { api: apiData.verificationStatus, onchain: onchainData.listed };
  }

  if (apiData.accessUrl === onchainData.metadata) {
    report.matches.metadata = { api: apiData.accessUrl, onchain: onchainData.metadata };
  } else {
    report.mismatches.metadata = { api: apiData.accessUrl, onchain: onchainData.metadata };
  }

  report.matches.id = { api: apiData.id, onchain: onchainData.id };

  const summary =
    Object.keys(report.mismatches).length === 0
      ? "All compared fields match between API and on-chain registry."
      : `Found ${Object.keys(report.mismatches).length} mismatched field(s).`;

  return JSON.stringify({ ...report, summary }, null, 2);
}

/**
 * Read the open ownership-transfer proposal for a registered resource.
 *
 * The contract stores `DataKey::PendingTransfer(id) -> Address` in persistent
 * storage when `propose_transfer` is called. This function reads that entry
 * directly via the Soroban RPC `getLedgerEntries` method, so it works without
 * signing a transaction. Returns the proposed new-owner address when found, or
 * a clear "not found" payload when no transfer is pending.
 */
export async function pendingTransfer(resourceId: string): Promise<string> {
  if (_isMock()) {
    const { mockPendingTransfer } = await import("../mock.js");
    return mockPendingTransfer(resourceId);
  }

  // First confirm the resource exists on-chain to give a meaningful error.
  const client = createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
  });

  let resourceExists = false;
  try {
    const tx = await client.get({ id: resourceId });
    resourceExists = tx.result.isOk();
  } catch {
    resourceExists = false;
  }

  if (!resourceExists) {
    return JSON.stringify(
      {
        source: "on-chain",
        resourceId,
        found: false,
        proposedNewOwner: null,
        message: `Resource "${resourceId}" is not registered on-chain. Confirm the id from mindvault_browse or mindvault_publish.`,
        contract: REGISTRY_CONTRACT_ID,
        network: REGISTRY_NETWORK_PASSPHRASE,
        rpc: SOROBAN_RPC_URL,
      },
      null,
      2,
    );
  }

  // Build the XDR ledger-key for DataKey::PendingTransfer(id).
  // DataKey is a Soroban-SDK enum; PendingTransfer is variant index 8 (see generated/index.ts DataKey).
  // The XDR representation is a ScVal of type SCV_VEC: [ScVal::Symbol("PendingTransfer"), ScVal::String(id)].
  let proposedNewOwner: string | null = null;
  try {
    const { xdr, Contract } = await import("@stellar/stellar-sdk");
    const contract = new Contract(REGISTRY_CONTRACT_ID);

    // Build ScVal key: Vec[Symbol("PendingTransfer"), String(id)]
    const keyScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("PendingTransfer"),
      xdr.ScVal.scvString(resourceId),
    ]);

    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contract.address().toScAddress(),
        key: keyScVal,
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );

    const keyBase64 = ledgerKey.toXDR("base64");

    const rpcRes = await fetch(SOROBAN_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: { keys: [keyBase64] },
      }),
    });

    if (rpcRes.ok) {
      const rpcData: any = await rpcRes.json();
      const entries: any[] = rpcData?.result?.entries ?? [];
      if (entries.length > 0 && entries[0]?.xdr) {
        const entryXdr = xdr.LedgerEntryData.fromXDR(entries[0].xdr, "base64");
        const dataVal = entryXdr.contractData().val();
        // The stored value is an Address (ScVal::Address).
        if (dataVal.switch().value === xdr.ScValType.scvAddress().value) {
          const addr = dataVal.address();
          // Address can be account or contract; for owner it is always account.
          if (addr.switch().value === xdr.ScAddressType.scAddressTypeAccount().value) {
            const { StrKey } = await import("@stellar/stellar-sdk");
            proposedNewOwner = StrKey.encodeEd25519PublicKey(
              addr.accountId().ed25519(),
            );
          } else {
            // Contract address — encode as C... strkey
            const { StrKey } = await import("@stellar/stellar-sdk");
            proposedNewOwner = StrKey.encodeContract(addr.contractId());
          }
        }
      }
    }
  } catch (err: any) {
    throw mcpError(
      mapTransportError({
        operation: `Pending transfer lookup failed for resource "${resourceId}"`,
        source: "soroban",
        error: err,
      }),
    );
  }

  if (proposedNewOwner === null) {
    return JSON.stringify(
      {
        source: "on-chain",
        resourceId,
        found: false,
        proposedNewOwner: null,
        message: `No pending ownership transfer exists for resource "${resourceId}". Use mindvault_transfer_ownership to propose one.`,
        contract: REGISTRY_CONTRACT_ID,
        network: REGISTRY_NETWORK_PASSPHRASE,
        rpc: SOROBAN_RPC_URL,
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      source: "on-chain",
      resourceId,
      found: true,
      proposedNewOwner,
      message: `A pending ownership transfer exists for resource "${resourceId}". The proposed new owner must call mindvault_accept_transfer to complete it.`,
      contract: REGISTRY_CONTRACT_ID,
      network: REGISTRY_NETWORK_PASSPHRASE,
      rpc: SOROBAN_RPC_URL,
    },
    null,
    2,
  );
}
