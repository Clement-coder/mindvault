/**
 * Direct USDC transfer from the agent wallet to a creator, used to pay for a
 * time-limited access lease (`mindvault_buy_lease`).
 *
 * Per-request purchases settle through x402, where the server issues a 402
 * and the facilitator moves the funds. A lease is bought against the
 * `vault-registry` contract instead, so the agent pays the creator itself:
 * one `transfer` invocation on the network's USDC Stellar Asset Contract,
 * signed by the wallet, submitted through Soroban RPC and polled until it
 * lands. The resulting transaction hash is what `buy_lease` records on-chain.
 *
 * Kept free of MCP runtime state so it can be unit-tested with a mocked SDK.
 */

export interface UsdcTransferInput {
  /** Secret key of the paying wallet. */
  secretKey: string;
  /** Recipient Stellar address (the resource creator). */
  to: string;
  /** Amount in USDC stroops (7 decimals). */
  amountStroops: bigint;
  /** USDC Stellar Asset Contract id for the network. */
  usdcSacContractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** How long to wait for the transaction to settle. Default 60 000 ms. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 2 000 ms. */
  intervalMs?: number;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface UsdcTransferResult {
  txHash: string;
  /** Ledger the transfer was included in, when the RPC reported it. */
  ledger: number | null;
}

export class UsdcTransferError extends Error {
  constructor(
    message: string,
    public readonly txHash: string | null = null,
  ) {
    super(message);
    this.name = "UsdcTransferError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transfer `amountStroops` USDC from the wallet to `to` and wait for the
 * transaction to settle. Throws `UsdcTransferError` when the transfer is
 * rejected, fails on-chain, or does not settle within `timeoutMs`; the error
 * carries the hash whenever the transaction was submitted, so a caller can
 * reconcile a late settlement instead of paying twice.
 */
export async function transferUsdc(input: UsdcTransferInput): Promise<UsdcTransferResult> {
  if (input.amountStroops <= 0n) {
    throw new UsdcTransferError("USDC transfer amount must be positive.");
  }
  const { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } =
    await import("@stellar/stellar-sdk");

  const keypair = Keypair.fromSecret(input.secretKey);
  const server = new rpc.Server(input.rpcUrl, {
    allowHttp: input.rpcUrl.startsWith("http://"),
  });

  const account = await server.getAccount(keypair.publicKey());
  const usdc = new Contract(input.usdcSacContractId);
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(
      usdc.call(
        "transfer",
        new Address(keypair.publicKey()).toScVal(),
        new Address(input.to).toScVal(),
        nativeToScVal(input.amountStroops, { type: "i128" }),
      ),
    )
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(built);
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new UsdcTransferError(
      `USDC transfer was rejected by the network (status ERROR${
        sent.errorResult ? `: ${sent.errorResult.toXDR("base64")}` : ""
      }).`,
      sent.hash ?? null,
    );
  }
  const txHash = sent.hash;

  const sleep = input.sleep ?? defaultSleep;
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (;;) {
    const status = await server.getTransaction(txHash);
    if (status.status === "SUCCESS") {
      return { txHash, ledger: typeof status.ledger === "number" ? status.ledger : null };
    }
    if (status.status === "FAILED") {
      throw new UsdcTransferError(`USDC transfer ${txHash} failed on-chain.`, txHash);
    }
    if (Date.now() >= deadline) {
      throw new UsdcTransferError(
        `USDC transfer ${txHash} was submitted but did not settle within ${
          input.timeoutMs ?? DEFAULT_TIMEOUT_MS
        } ms; check the transaction before buying again.`,
        txHash,
      );
    }
    await sleep(intervalMs);
  }
}
