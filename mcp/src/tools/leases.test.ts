import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mock: false,
  wallet: { publicKey: "GHOLDER", secretKey: "SHOLDER" } as {
    publicKey: string;
    secretKey: string;
  } | null,
  get: vi.fn(),
  lease_price: vi.fn(),
  buy_lease: vi.fn(),
  get_lease: vi.fn(),
  lease_is_active: vi.fn(),
  createRegistryClient: vi.fn(),
  transferUsdc: vi.fn(),
  recordPurchase: vi.fn(),
  recordResourceHistory: vi.fn(),
}));

vi.mock("@mindvault/registry-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mindvault/registry-client")>()),
  createRegistryClient: (opts: unknown) => {
    state.createRegistryClient(opts);
    return {
      get: state.get,
      lease_price: state.lease_price,
      buy_lease: state.buy_lease,
      get_lease: state.get_lease,
      lease_is_active: state.lease_is_active,
    };
  },
  Errors: { 2: { message: "NotFound" } },
}));

vi.mock("../runtime.js", () => ({
  _isMock: () => state.mock,
  NETWORK: "stellar:testnet",
  networkPreset: { usdcSacContractId: "CUSDC" },
  REGISTRY_CONTRACT_ID: "CREGISTRY",
  REGISTRY_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  requireWallet: () => {
    if (!state.wallet) throw new Error("No wallet in profile. Run mindvault_setup_wallet first.");
    return state.wallet;
  },
}));

vi.mock("../usdcTransfer.js", async () => {
  const actual = await vi.importActual<typeof import("../usdcTransfer.js")>("../usdcTransfer.js");
  return { ...actual, transferUsdc: state.transferUsdc };
});
vi.mock("../purchaseHistory.js", () => ({ recordPurchase: state.recordPurchase }));
vi.mock("../resourceHistory.js", () => ({ recordResourceHistory: state.recordResourceHistory }));
vi.mock("@stellar/stellar-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stellar/stellar-sdk")>()),
  Keypair: { fromSecret: () => ({}) },
  Transaction: class {
    sign() {}
    toXDR() {
      return "SIGNED";
    }
  },
}));

import { buyLease, leaseStatus, leaseTierFromName, leaseView } from "./leases.js";
import { UsdcTransferError } from "../usdcTransfer.js";

const ok = <T>(value: T) => ({
  result: { isErr: () => false, isOk: () => true, unwrap: () => value, unwrapErr: () => undefined },
});
const err = (message: string) => ({
  result: {
    isErr: () => true,
    isOk: () => false,
    unwrap: () => undefined,
    unwrapErr: () => ({ message }),
  },
});
const lease = {
  resource_id: "res1",
  holder: "GHOLDER",
  tier: 1,
  start_ledger: 1000,
  expiry_ledger: 18280,
  amount: 25_000_000n,
  tx_hash: "PAYTX",
  state: { tag: "Pending", values: undefined },
  recorded_at: 1000,
};

describe("lease tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mock = false;
    state.wallet = { publicKey: "GHOLDER", secretKey: "SHOLDER" };
    state.get.mockResolvedValue(
      ok({ id: "res1", creator: "GCREATOR", price: 5_000_000n, metadata: "ipfs://m" }),
    );
    state.lease_price.mockResolvedValue(ok(25_000_000n));
    state.transferUsdc.mockResolvedValue({ txHash: "PAYTX", ledger: 4242 });
    state.buy_lease.mockResolvedValue({
      ...ok(lease),
      signAndSend: vi.fn().mockResolvedValue(ok(lease)),
    });
    state.get_lease.mockResolvedValue(ok(lease));
    state.lease_is_active.mockResolvedValue({ result: false });
  });

  it("maps tier names to the contract enum and back", () => {
    expect(leaseTierFromName("hour")).toBe(0);
    expect(leaseTierFromName("Day")).toBe(1);
    expect(leaseTierFromName("WEEK")).toBe(2);
    expect(() => leaseTierFromName("month")).toThrow(/Unknown lease tier/);
    expect(leaseView(lease as never)).toMatchObject({
      tier: "day",
      state: "Pending",
      amountUsdc: "2.5000000",
      expiryLedger: 18280,
    });
  });

  it("quotes, pays the creator, records the lease with the payment hash and persists a receipt", async () => {
    const progress: string[] = [];
    const out = JSON.parse(
      await buyLease("res1", "day", {
        onProgress: async (_p, _t, message) => {
          progress.push(message ?? "");
        },
      }),
    );

    expect(out).toMatchObject({
      status: "success",
      resourceId: "res1",
      tier: "day",
      creator: "GCREATOR",
      priceUsdc: "2.5000000",
      paymentTxHash: "PAYTX",
      lease: { state: "Pending", txHash: "PAYTX" },
    });
    expect(state.lease_price).toHaveBeenCalledWith({ resource_id: "res1", tier: 1 });
    expect(state.transferUsdc).toHaveBeenCalledWith({
      secretKey: "SHOLDER",
      to: "GCREATOR",
      amountStroops: 25_000_000n,
      usdcSacContractId: "CUSDC",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(state.buy_lease).toHaveBeenCalledWith({
      holder: "GHOLDER",
      resource_id: "res1",
      tier: 1,
      amount: 25_000_000n,
      tx_hash: "PAYTX",
    });
    expect(state.recordPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "res1",
        amount: "2.5000000",
        txHash: "PAYTX",
        receiptRef: "lease:day",
      }),
    );
    expect(state.recordResourceHistory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "purchased", recipient: "GCREATOR", txHash: "PAYTX" }),
    );
    expect(progress).toEqual([
      "Quoting lease price",
      "Paying creator in USDC",
      "Recording lease on-chain",
      "Recording receipt",
    ]);
  });

  it("dry-run quotes and describes the steps without paying or writing", async () => {
    const out = JSON.parse(await buyLease("res1", "week", { dryRun: true }));
    expect(out).toMatchObject({
      mode: "dry-run",
      operation: "buy-lease",
      intentions: { tier: "week" },
    });
    expect(out.steps).toHaveLength(3);
    expect(state.transferUsdc).not.toHaveBeenCalled();
    expect(state.buy_lease).not.toHaveBeenCalled();
  });

  it("refuses to pay above the auto-pay ceiling before any transfer", async () => {
    state.lease_price.mockResolvedValue(ok(500_000_000_000n));
    await expect(buyLease("res1", "week")).rejects.toThrow();
    expect(state.transferUsdc).not.toHaveBeenCalled();
  });

  it("reports an unknown resource without paying", async () => {
    state.get.mockResolvedValue(err("NotFound"));
    await expect(buyLease("nores", "hour")).rejects.toThrow();
    expect(state.transferUsdc).not.toHaveBeenCalled();
  });

  it("surfaces the payment hash when the lease record fails after paying", async () => {
    state.buy_lease.mockResolvedValue(err("AlreadyRegistered"));
    await expect(buyLease("res1", "hour")).rejects.toThrow(/after payment PAYTX/);
    expect(state.recordPurchase).not.toHaveBeenCalled();
  });

  it("keeps the transfer hash in the error when the payment does not settle", async () => {
    state.transferUsdc.mockRejectedValue(new UsdcTransferError("did not settle", "LATE"));
    await expect(buyLease("res1", "hour")).rejects.toThrow(/tx LATE/);
    expect(state.buy_lease).not.toHaveBeenCalled();
  });

  it("requires a wallet", async () => {
    state.wallet = null;
    await expect(buyLease("res1", "hour")).rejects.toThrow(/No wallet/);
  });

  it("reports lease status for the agent wallet by default", async () => {
    state.lease_is_active.mockResolvedValue({ result: true });
    const out = JSON.parse(await leaseStatus("res1"));
    expect(out).toMatchObject({
      found: true,
      active: true,
      holder: "GHOLDER",
      lease: { tier: "day", state: "Pending" },
    });
    expect(state.get_lease).toHaveBeenCalledWith({ resource_id: "res1", holder: "GHOLDER" });
  });

  it("reports a missing lease for an explicit holder", async () => {
    state.get_lease.mockResolvedValue(err("NotFound"));
    const out = JSON.parse(await leaseStatus("res1", "GOTHER"));
    expect(out).toMatchObject({ found: false, active: false, holder: "GOTHER" });
  });

  it("uses deterministic mock responses in mock mode", async () => {
    state.mock = true;
    const bought = JSON.parse(await buyLease("res1", "day"));
    expect(bought).toMatchObject({
      status: "success",
      source: "on-chain (mock)",
      lease: { tier: "day" },
    });
    const missing = JSON.parse(await leaseStatus("res0"));
    expect(missing.found).toBe(false);
    const present = JSON.parse(await leaseStatus("res1"));
    expect(present).toMatchObject({ found: true, active: true });
    expect(state.createRegistryClient).not.toHaveBeenCalled();
  });
});
