/**
 * Time-limited access leases (`mindvault_buy_lease`, `mindvault_lease_status`).
 *
 * A lease is an on-chain entitlement recorded in the `vault-registry`
 * contract: "holder may access resource until expiry_ledger". Buying one from
 * the agent side is two steps, because the registry never custodies funds:
 *
 *   1. pay the creator in USDC (a SAC `transfer`, see ../usdcTransfer.ts);
 *   2. call `buy_lease` with the payment hash, which records the lease as
 *      `Pending` until a settler confirms the transfer with `settle_lease`.
 *
 * `mindvault_lease_status` reads `get_lease` / `lease_is_active` so an agent
 * can check its window before re-buying. Both tools honour mock mode.
 */

import {
  createRegistryClient,
  Errors as RegistryErrors,
  LeaseTier,
  type Lease,
} from "@mindvault/registry-client";
import {
  _isMock,
  NETWORK,
  networkPreset,
  REGISTRY_CONTRACT_ID,
  REGISTRY_NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL,
  requireWallet,
} from "../runtime.js";
import { mapRegistryError, mapTransportError, mcpError } from "../errorMapping.js";
import { assertAutoPaymentWithinCeiling } from "../paymentCeiling.js";
import { recordPurchase } from "../purchaseHistory.js";
import { recordResourceHistory } from "../resourceHistory.js";
import { explorerTxUrl } from "../stellarExplorer.js";
import { stroopsToUsdc } from "../usdcAmount.js";
import { transferUsdc, UsdcTransferError } from "../usdcTransfer.js";
import { mockBuyLease, mockLeaseStatus } from "../mock.js";

export const LEASE_TIER_NAMES = ["hour", "day", "week"] as const;
export type LeaseTierName = (typeof LEASE_TIER_NAMES)[number];

/** Map the tool's lowercase tier name to the contract enum. */
export function leaseTierFromName(name: string): LeaseTier {
  switch (name.toLowerCase()) {
    case "hour":
      return LeaseTier.Hour;
    case "day":
      return LeaseTier.Day;
    case "week":
      return LeaseTier.Week;
    default:
      throw new Error(`Unknown lease tier "${name}". Use one of: ${LEASE_TIER_NAMES.join(", ")}.`);
  }
}

export function leaseTierName(tier: LeaseTier): LeaseTierName {
  return tier === LeaseTier.Week ? "week" : tier === LeaseTier.Day ? "day" : "hour";
}

/** The bindings encode unit enums as `{ tag }` objects; normalize to the tag. */
function leaseStateName(state: Lease["state"]): string {
  return typeof state === "string" ? state : (state as { tag: string }).tag;
}

export interface LeaseView {
  resourceId: string;
  holder: string;
  tier: LeaseTierName;
  state: string;
  startLedger: number;
  expiryLedger: number;
  amountStroops: string;
  amountUsdc: string;
  txHash: string;
  recordedAt: number;
}

export function leaseView(lease: Lease): LeaseView {
  return {
    resourceId: lease.resource_id,
    holder: lease.holder,
    tier: leaseTierName(lease.tier),
    state: leaseStateName(lease.state),
    startLedger: lease.start_ledger,
    expiryLedger: lease.expiry_ledger,
    amountStroops: lease.amount.toString(),
    amountUsdc: stroopsToUsdc(lease.amount),
    txHash: lease.tx_hash,
    recordedAt: lease.recorded_at,
  };
}

function registryClient(publicKey?: string) {
  return createRegistryClient({
    contractId: REGISTRY_CONTRACT_ID,
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    ...(publicKey ? { publicKey } : {}),
  });
}

function isNotFound(message: string): boolean {
  return message === RegistryErrors[2].message;
}

export interface BuyLeaseOptions {
  dryRun?: boolean;
  maxAutoPayUsdc?: string;
  onProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
}

/**
 * Buy a lease on `resourceId` for `tierName`: quote the on-chain lease price,
 * enforce the auto-pay ceiling, pay the creator in USDC, then record the
 * lease with the payment hash. Returns a JSON summary.
 */
export async function buyLease(
  resourceId: string,
  tierName: string,
  options: BuyLeaseOptions = {},
): Promise<string> {
  const tier = leaseTierFromName(tierName);
  if (_isMock()) return mockBuyLease(resourceId, leaseTierName(tier), options.dryRun === true);

  const wallet = requireWallet();
  const client = registryClient(wallet.publicKey);

  await options.onProgress?.(1, 4, "Quoting lease price");
  let resource;
  let priceStroops: bigint;
  try {
    const [resourceTx, priceTx] = await Promise.all([
      client.get({ id: resourceId }),
      client.lease_price({ resource_id: resourceId, tier }),
    ]);
    if (resourceTx.result.isErr()) {
      const err = resourceTx.result.unwrapErr();
      throw mcpError(
        mapRegistryError({
          operation: `Lease quote failed for resource "${resourceId}"`,
          message: err.message,
          notFound: isNotFound(err.message),
        }),
      );
    }
    if (priceTx.result.isErr()) {
      throw mcpError(
        mapRegistryError({
          operation: `Lease quote failed for resource "${resourceId}"`,
          message: priceTx.result.unwrapErr().message,
        }),
      );
    }
    resource = resourceTx.result.unwrap();
    priceStroops = priceTx.result.unwrap();
  } catch (err) {
    if (err instanceof Error && "code" in err) throw err;
    throw mcpError(
      mapTransportError({
        operation: `Lease quote failed for resource "${resourceId}"`,
        source: "soroban",
        error: err,
      }),
    );
  }

  const priceUsdc = stroopsToUsdc(priceStroops);
  const intent = {
    resourceId,
    tier: leaseTierName(tier),
    creator: resource.creator,
    priceStroops: priceStroops.toString(),
    priceUsdc,
    network: NETWORK,
    contract: REGISTRY_CONTRACT_ID,
    usdcContract: networkPreset.usdcSacContractId,
  };
  assertAutoPaymentWithinCeiling({ price: priceUsdc, maxAutoPayUsdc: options.maxAutoPayUsdc });

  if (options.dryRun) {
    return JSON.stringify(
      {
        mode: "dry-run",
        operation: "buy-lease",
        validation: { resourceId: { valid: true }, tier: { valid: true } },
        intentions: intent,
        steps: [
          `Transfer ${priceUsdc} USDC from ${wallet.publicKey} to ${resource.creator}`,
          `Call buy_lease(${resourceId}, ${leaseTierName(tier)}) with the payment hash`,
          "Wait for a settler to confirm the payment (lease_status shows Active)",
        ],
      },
      null,
      2,
    );
  }

  await options.onProgress?.(2, 4, "Paying creator in USDC");
  let payment;
  try {
    payment = await transferUsdc({
      secretKey: wallet.secretKey,
      to: resource.creator,
      amountStroops: priceStroops,
      usdcSacContractId: networkPreset.usdcSacContractId,
      rpcUrl: SOROBAN_RPC_URL,
      networkPassphrase: REGISTRY_NETWORK_PASSPHRASE,
    });
  } catch (err) {
    const detail = err instanceof UsdcTransferError && err.txHash ? ` (tx ${err.txHash})` : "";
    throw mcpError(
      mapTransportError({
        operation: `Lease payment failed for resource "${resourceId}"${detail}`,
        source: "soroban",
        error: err,
      }),
    );
  }

  await options.onProgress?.(3, 4, "Recording lease on-chain");
  let lease: Lease;
  try {
    const tx = await client.buy_lease({
      holder: wallet.publicKey,
      resource_id: resourceId,
      tier,
      amount: priceStroops,
      tx_hash: payment.txHash,
    });
    if (tx.result.isErr()) {
      throw mcpError(
        mapRegistryError({
          operation: `Lease record failed for resource "${resourceId}" after payment ${payment.txHash}`,
          message: tx.result.unwrapErr().message,
        }),
      );
    }
    const { Keypair, Transaction } = await import("@stellar/stellar-sdk");
    const keypair = Keypair.fromSecret(wallet.secretKey);
    const sent = await tx.signAndSend({
      signTransaction: async (xdr: string) => {
        const stellarTx = new Transaction(xdr, REGISTRY_NETWORK_PASSPHRASE);
        stellarTx.sign(keypair);
        return { signedTxXdr: stellarTx.toXDR() };
      },
    });
    lease = sent.result.isOk() ? sent.result.unwrap() : tx.result.unwrap();
  } catch (err) {
    if (err instanceof Error && "code" in err) throw err;
    throw mcpError(
      mapTransportError({
        operation: `Lease record failed for resource "${resourceId}" after payment ${payment.txHash}`,
        source: "soroban",
        error: err,
      }),
    );
  }

  await options.onProgress?.(4, 4, "Recording receipt");
  try {
    recordPurchase({
      resourceId,
      amount: priceUsdc,
      network: NETWORK,
      txHash: payment.txHash,
      receiptRef: `lease:${leaseTierName(tier)}`,
      ...(resource.metadata ? { title: undefined } : {}),
    });
    recordResourceHistory({
      resourceId,
      kind: "purchased",
      actor: wallet.publicKey,
      recipient: resource.creator,
      amount: priceUsdc,
      txHash: payment.txHash,
      network: NETWORK,
    });
  } catch {
    // Local receipt persistence must never mask a completed purchase.
  }

  return JSON.stringify(
    {
      status: "success",
      ...intent,
      paymentTxHash: payment.txHash,
      paymentExplorerUrl: explorerTxUrl(payment.txHash),
      lease: leaseView(lease),
      next: "The lease is Pending until a settler confirms the payment; poll mindvault_lease_status until it reports active.",
    },
    null,
    2,
  );
}

/**
 * Report the lease recorded for `(resourceId, holder)`, defaulting the
 * holder to the agent wallet, and whether it currently grants access.
 */
export async function leaseStatus(resourceId: string, holder?: string): Promise<string> {
  if (_isMock()) return mockLeaseStatus(resourceId, holder ?? "GMOCKHOLDER");
  const who = holder ?? requireWallet().publicKey;
  const client = registryClient();

  let leaseResult;
  let active: boolean;
  try {
    const [leaseTx, activeTx] = await Promise.all([
      client.get_lease({ resource_id: resourceId, holder: who }),
      client.lease_is_active({ resource_id: resourceId, holder: who }),
    ]);
    leaseResult = leaseTx.result;
    active = activeTx.result;
  } catch (err) {
    throw mcpError(
      mapTransportError({
        operation: `Lease lookup failed for resource "${resourceId}"`,
        source: "soroban",
        error: err,
      }),
    );
  }

  const base = {
    source: "on-chain",
    resourceId,
    holder: who,
    contract: REGISTRY_CONTRACT_ID,
    network: REGISTRY_NETWORK_PASSPHRASE,
  };
  if (leaseResult.isErr()) {
    const err = leaseResult.unwrapErr();
    if (isNotFound(err.message)) {
      return JSON.stringify(
        {
          ...base,
          found: false,
          active: false,
          message: `No lease recorded for ${who} on "${resourceId}".`,
        },
        null,
        2,
      );
    }
    throw mcpError(
      mapRegistryError({
        operation: `Lease lookup failed for resource "${resourceId}"`,
        message: err.message,
      }),
    );
  }
  const lease = leaseView(leaseResult.unwrap());
  return JSON.stringify(
    {
      ...base,
      found: true,
      active,
      lease,
      message: active
        ? `Lease active until ledger ${lease.expiryLedger}.`
        : `Lease found but not active (state ${lease.state}, expires at ledger ${lease.expiryLedger}).`,
    },
    null,
    2,
  );
}
