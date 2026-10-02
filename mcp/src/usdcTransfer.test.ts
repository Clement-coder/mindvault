import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const getAccount = vi.fn();
  const prepareTransaction = vi.fn();
  const sendTransaction = vi.fn();
  const getTransaction = vi.fn();
  const sign = vi.fn();
  const call = vi.fn((...args: unknown[]) => ({ op: "transfer", args }));
  const addOperation = vi.fn();
  const setTimeout_ = vi.fn();
  const build = vi.fn(() => ({ built: true }));
  const builder = { addOperation, setTimeout: setTimeout_, build };
  addOperation.mockReturnValue(builder);
  setTimeout_.mockReturnValue(builder);
  return {
    getAccount,
    prepareTransaction,
    sendTransaction,
    getTransaction,
    sign,
    call,
    addOperation,
    build,
    serverCtor: vi.fn(),
    contractCtor: vi.fn(),
    builderCtor: vi.fn(),
    builder,
  };
});

vi.mock("@stellar/stellar-sdk", () => {
  class Address {
    constructor(private readonly value: string) {}
    toScVal() {
      return { address: this.value };
    }
  }
  class Contract {
    constructor(id: string) {
      sdk.contractCtor(id);
    }
    call(...args: unknown[]) {
      return sdk.call(...args);
    }
  }
  class TransactionBuilder {
    constructor(account: unknown, opts: unknown) {
      sdk.builderCtor(account, opts);
      return sdk.builder as unknown as TransactionBuilder;
    }
  }
  class Server {
    constructor(url: string, opts: unknown) {
      sdk.serverCtor(url, opts);
    }
    getAccount = sdk.getAccount;
    prepareTransaction = sdk.prepareTransaction;
    sendTransaction = sdk.sendTransaction;
    getTransaction = sdk.getTransaction;
  }
  return {
    Address,
    BASE_FEE: "100",
    Contract,
    Keypair: {
      fromSecret: () => ({ publicKey: () => "GPAYER", secret: () => "S" }),
    },
    TransactionBuilder,
    nativeToScVal: (value: unknown, opts: unknown) => ({ value: String(value), opts }),
    rpc: { Server },
  };
});

import { transferUsdc, UsdcTransferError } from "./usdcTransfer.js";

const input = {
  secretKey: "SSECRET",
  to: "GCREATOR",
  amountStroops: 5_000_000n,
  usdcSacContractId: "CUSDC",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  timeoutMs: 5_000,
  intervalMs: 10,
  sleep: async () => {},
};

describe("transferUsdc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.getAccount.mockResolvedValue({ accountId: () => "GPAYER" });
    sdk.prepareTransaction.mockResolvedValue({ sign: sdk.sign });
    sdk.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "TXHASH" });
    sdk.getTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 4242 });
  });

  it("builds a SAC transfer from the wallet to the creator, signs it and returns the settled hash", async () => {
    const result = await transferUsdc(input);

    expect(result).toEqual({ txHash: "TXHASH", ledger: 4242 });
    expect(sdk.serverCtor).toHaveBeenCalledWith("https://soroban-testnet.stellar.org", {
      allowHttp: false,
    });
    expect(sdk.contractCtor).toHaveBeenCalledWith("CUSDC");
    expect(sdk.call).toHaveBeenCalledWith(
      "transfer",
      { address: "GPAYER" },
      { address: "GCREATOR" },
      { value: "5000000", opts: { type: "i128" } },
    );
    expect(sdk.builderCtor).toHaveBeenCalledWith(expect.anything(), {
      fee: "100",
      networkPassphrase: input.networkPassphrase,
    });
    expect(sdk.prepareTransaction).toHaveBeenCalledWith({ built: true });
    expect(sdk.sign).toHaveBeenCalledTimes(1);
    expect(sdk.getTransaction).toHaveBeenCalledWith("TXHASH");
  });

  it("polls until the transaction settles", async () => {
    sdk.getTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS", ledger: 7 });

    const result = await transferUsdc(input);

    expect(result).toEqual({ txHash: "TXHASH", ledger: 7 });
    expect(sdk.getTransaction).toHaveBeenCalledTimes(3);
  });

  it("rejects a non-positive amount before touching the network", async () => {
    await expect(transferUsdc({ ...input, amountStroops: 0n })).rejects.toThrow(UsdcTransferError);
    expect(sdk.getAccount).not.toHaveBeenCalled();
  });

  it("reports a network rejection without a hash to reconcile", async () => {
    sdk.sendTransaction.mockResolvedValue({ status: "ERROR", hash: "TXHASH" });
    await expect(transferUsdc(input)).rejects.toMatchObject({
      name: "UsdcTransferError",
      txHash: "TXHASH",
      message: expect.stringContaining("rejected"),
    });
    expect(sdk.getTransaction).not.toHaveBeenCalled();
  });

  it("reports an on-chain failure with the hash", async () => {
    sdk.getTransaction.mockResolvedValue({ status: "FAILED" });
    await expect(transferUsdc(input)).rejects.toMatchObject({
      name: "UsdcTransferError",
      txHash: "TXHASH",
      message: expect.stringContaining("failed on-chain"),
    });
  });

  it("gives up after the timeout but keeps the hash for reconciliation", async () => {
    sdk.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (now += 3_000));
    try {
      await expect(transferUsdc(input)).rejects.toMatchObject({
        txHash: "TXHASH",
        message: expect.stringContaining("did not settle"),
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("allows plain-http RPC endpoints for local development", async () => {
    await transferUsdc({ ...input, rpcUrl: "http://localhost:8000/soroban/rpc" });
    expect(sdk.serverCtor).toHaveBeenCalledWith("http://localhost:8000/soroban/rpc", {
      allowHttp: true,
    });
  });
});
