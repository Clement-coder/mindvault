import {
  activeProfile,
  activeProfileName,
  BASE_URL,
  currentApiKey,
  jsonFetch,
  requireWallet,
  resolveProfileName,
  saveState,
  setActiveProfileName,
  sorobanRpcFetch,
  SPONSORED_ACCOUNT_URL,
  STATE_FILE,
} from "../runtime.js";
import { getBalanceDetails } from "./registry.js";
import { mapRegistryError, mappedErrorOf, mcpError, throwHttpError } from "../errorMapping.js";
import {
  SPONSORED_CREATE_PATH,
  mapSponsoredHttpFailure,
  mapSponsoredTransportFailure,
  sanitizeServiceUrl,
} from "../sponsoredDiagnostics.js";
import {
  checkWalletIntegrity,
  sponsoredWalletIntegrityError,
  unownedWalletNote,
  type DerivePublicKey,
} from "../sponsoredWallet.js";
import {
  buildPublishStatusSnapshot,
  normalizeIntervalMs,
  normalizeTimeoutMs,
  normalizeWaitFlag,
  pollPublishStatus,
  publishStatusFromResponses,
  type PublishProgressReporter,
  type PublishStatusFetch,
} from "../publishStatus.js";

export async function txStatus(txHash: string): Promise<string> {
  const hash = (txHash ?? "").trim();
  if (!hash) return "Provide a transaction hash to look up.";
  const res = await sorobanRpcFetch(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: { hash },
      }),
    },
    "POST soroban getTransaction",
  );
  if (!res.ok)
    throwHttpError({
      operation: `Soroban RPC error: ${res.status}`,
      source: "soroban",
      status: res.status,
      data: await res.text().catch(() => null),
    });
  const data: any = await res.json();
  if (data.error)
    throw mcpError(
      mapRegistryError({
        operation: "RPC error",
        message: JSON.stringify(data.error),
        source: "soroban",
      }),
    );
  const tx = data.result;
  if (tx.status === "NOT_FOUND") {
    return JSON.stringify(
      {
        status: "NOT_FOUND",
        hash,
        message:
          "Transaction not found on the configured Soroban RPC. It may be unconfirmed, on a different network, or outside the RPC's retention window.",
        oldestLedger: tx.oldestLedger,
        latestLedger: tx.latestLedger,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      status: tx.status,
      hash,
      ledger: tx.ledger,
      ledgerCloseTime: tx.createdAt ? new Date(tx.createdAt * 1000).toISOString() : null,
      applicationOrder: tx.applicationOrder,
      feeBump: tx.feeBump,
      envelopeXdr: tx.envelopeXdr,
      resultXdr: tx.resultXdr,
      resultMetaXdr: tx.resultMetaXdr,
    },
    null,
    2,
  );
}

function hasPublicErrorDetail(data: unknown): boolean {
  if (typeof data === "string") return data.trim().length > 0;
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  return ["error", "message", "detail", "reason"].some((key) => {
    const value = obj[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function sponsoredAccountErrorData(status: number, data: unknown): unknown {
  if (status >= 500 && !hasPublicErrorDetail(data)) {
    return { message: "internal service error" };
  }
  return data;
}

/** Stellar key derivation for the wallet integrity checks, loaded on demand. */
async function stellarDerivePublicKey(): Promise<DerivePublicKey> {
  const { Keypair } = await import("@stellar/stellar-sdk");
  return (secretKey: string) => Keypair.fromSecret(secretKey).publicKey();
}

export async function setupWallet(profileArg?: string): Promise<string> {
  const target = resolveProfileName(profileArg);
  const operation = "mindvault_setup_wallet failed to create wallet";

  let res: Awaited<ReturnType<typeof jsonFetch>>;
  try {
    res = await jsonFetch(`${SPONSORED_ACCOUNT_URL}${SPONSORED_CREATE_PATH}`, { method: "POST" });
  } catch (err) {
    const mapped = mappedErrorOf(err);
    if (!mapped) throw err;
    throw mcpError(
      mapSponsoredTransportFailure({ operation, serviceUrl: SPONSORED_ACCOUNT_URL, mapped }),
    );
  }

  if (!res.ok) {
    throw mcpError(
      mapSponsoredHttpFailure({
        operation,
        serviceUrl: SPONSORED_ACCOUNT_URL,
        status: res.status,
        data: res.data,
        headers: res.headers,
      }),
    );
  }
  // A 200 is not proof the service completed: a half-finished creation can
  // answer with an address whose secret is missing or belongs to a different
  // account, leaving the agent a funded address it cannot sign for (#839).
  const integrity = checkWalletIntegrity(res.data ?? {}, await stellarDerivePublicKey());
  if (!integrity.ok) {
    throw sponsoredWalletIntegrityError(integrity, sanitizeServiceUrl(SPONSORED_ACCOUNT_URL));
  }

  setActiveProfileName(target);
  activeProfile().wallet = { publicKey: integrity.publicKey, secretKey: integrity.secretKey };
  saveState();
  return [
    `Wallet created.`,
    `Profile: ${target}`,
    `Address: ${integrity.publicKey}`,
    `Wallet persisted to ${STATE_FILE} (mode 0600).`,
  ].join("\n");
}

export async function walletInfo(): Promise<string> {
  const wallet = requireWallet();
  const details = await getBalanceDetails(wallet.publicKey);
  const integrity = checkWalletIntegrity(wallet, await stellarDerivePublicKey());

  const lines = [
    `Profile: ${activeProfileName}`,
    `Address: ${wallet.publicKey}`,
    `XLM Balance: ${details.xlmBalance}`,
    `XLM Reserved: ${details.xlmReserve} (base + subentries)`,
    `XLM Available: ${details.xlmAvailable}`,
    `USDC Balance: ${details.usdcBalance}`,
    `USDC Status: ${details.status}`,
    `Publisher registered: ${currentApiKey() ? "yes" : "no"}`,
  ];

  if (!integrity.ok) {
    // The balance above is real, but this agent cannot sign for the address it
    // belongs to, so never let it read as spendable funds (#839).
    lines.push(`⚠ Keystore: ${unownedWalletNote(integrity)}`);
  }

  if (details.message) {
    lines.push(`Note: ${details.message}`);
  }

  return lines.join("\n");
}

async function fetchPublishStatusData(resourceId: string): Promise<PublishStatusFetch> {
  const metaRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  const verRes = await jsonFetch(`${BASE_URL}/resources/${resourceId}/verification`);
  return publishStatusFromResponses(resourceId, metaRes, verRes);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll verification / on-chain sync status for a published resource.
 *
 * With a client-supplied progress token, every poll streams a
 * notifications/progress update so a `wait: true` call shows movement.
 */
export async function publishStatus(
  args: {
    resourceId?: string;
    wait?: unknown;
    timeoutMs?: unknown;
    intervalMs?: unknown;
  },
  onProgress?: PublishProgressReporter,
): Promise<string> {
  const resourceId = (args.resourceId ?? "").trim();
  if (!resourceId) {
    throw new Error(
      "resourceId is required. Pass the id returned by mindvault_publish (e.g. 'cm7x8y9z').",
    );
  }

  const wait = normalizeWaitFlag(args.wait);
  const timeoutMs = normalizeTimeoutMs(args.timeoutMs);
  const intervalMs = normalizeIntervalMs(args.intervalMs);

  const { data, attempts, timedOut } = await pollPublishStatus({
    resourceId,
    wait,
    timeoutMs,
    intervalMs,
    fetchStatus: fetchPublishStatusData,
    onProgress,
    sleep: sleepMs,
  });

  const snapshot = buildPublishStatusSnapshot(resourceId, data, {
    polled: wait,
    attempts,
    timedOut,
  });
  return JSON.stringify(snapshot, null, 2);
}
