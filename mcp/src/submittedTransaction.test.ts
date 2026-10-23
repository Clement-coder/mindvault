/**
 * A submitted transaction keeps its hash when confirming it fails (#1060).
 *
 * The RPC is simulated, the Stellar SDK is not: every case runs the SDK's own
 * `SentTransaction.send` — the code behind `signAndSend` — against a stub RPC
 * that accepts the transaction and then loses `getTransaction`, so the
 * `onSubmitted` timing is exactly what production sees. The registry
 * mutations are then driven through `index.ts` with a registry client whose
 * transactions submit through that same path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  contract,
} from "@stellar/stellar-sdk";

import { outputContractViolation } from "./outputValidation.js";
import {
  SubmittedTransactionUnconfirmed,
  signAndSendTracked,
  submittedUnconfirmedResult,
  type SubmissionWatcher,
} from "./submittedTransaction.js";

const HASH = "c0ffee".padEnd(64, "0");

type RpcBehaviour = "confirms" | "lost-after-submit" | "never-confirms" | "rejects" | "down";

/** A Soroban RPC stub whose `getTransaction` behaves as `rpc.mode` says. */
const rpc = vi.hoisted(() => ({ mode: "confirms" as RpcBehaviour, sent: 0 }));

function stubServer() {
  return {
    sendTransaction: async () => {
      if (rpc.mode === "down") throw new Error("connect ECONNREFUSED soroban-rpc");
      rpc.sent += 1;
      return rpc.mode === "rejects"
        ? { status: "ERROR", hash: HASH, errorResult: undefined }
        : { status: "PENDING", hash: HASH };
    },
    getTransaction: async () => {
      if (rpc.mode === "lost-after-submit") throw new Error("fetch failed: socket hang up");
      if (rpc.mode === "never-confirms") return { status: "NOT_FOUND" };
      return { status: "SUCCESS", returnValue: undefined };
    },
  };
}

/**
 * What `AssembledTransaction.signAndSend` does after signing: hand the
 * transaction to the SDK's `SentTransaction`, which submits and then polls.
 */
function sdkSend(watcher?: SubmissionWatcher) {
  const assembled = {
    options: { server: stubServer(), timeoutInSeconds: 1, parseResultXdr: () => undefined },
    signed: {},
  };
  return (new contract.SentTransaction(assembled as any) as any).send(watcher as any);
}

/** A real, signable transaction for the registry client fake to hand out. */
function unsignedXdr(): string {
  const source = new Account(Keypair.random().publicKey(), "1");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build()
    .toXDR();
}

/** The assembled transaction a registry client call returns. */
function assembledTx() {
  return {
    result: { isErr: () => false, unwrap: () => undefined },
    signAndSend: async (opts: {
      signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>;
      watcher?: SubmissionWatcher;
    }) => {
      await opts.signTransaction(unsignedXdr());
      return sdkSend(opts.watcher);
    },
  };
}

vi.mock("@mindvault/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createRegistryClient: () => ({
      update_metadata: async () => assembledTx(),
      set_price: async () => assembledTx(),
      transfer_ownership: async () => assembledTx(),
      set_listed: async () => assembledTx(),
      set_tags: async () => assembledTx(),
    }),
  };
});

process.env.STELLAR_NETWORK = "testnet";
delete process.env.MINDVAULT_MOCK;
const home = mkdtempSync(join(tmpdir(), "mindvault-mcp-submitted-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const index = await import("./index.js");
const { TOOL_DEFINITIONS } = await import("./tools.js");

afterAll(() => {
  index._setAgentWallet(null);
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rpc.mode = "confirms";
  rpc.sent = 0;
});

describe("signAndSendTracked with the SDK's SentTransaction", () => {
  it("returns the hash when the transaction confirms", async () => {
    const { txHash } = await signAndSendTracked((watcher) => sdkSend(watcher));
    expect(txHash).toBe(HASH);
  });

  it("keeps the hash when the RPC is lost after submit", async () => {
    rpc.mode = "lost-after-submit";
    const err = await signAndSendTracked((watcher) => sdkSend(watcher)).catch((e) => e);

    expect(err).toBeInstanceOf(SubmittedTransactionUnconfirmed);
    expect(err.txHash).toBe(HASH);
    expect(err.reason).toBe("rpc_unavailable");
    expect(err.cause.message).toMatch(/socket hang up/);
  });

  it("keeps the hash when polling times out", async () => {
    rpc.mode = "never-confirms";
    const err = await signAndSendTracked((watcher) => sdkSend(watcher)).catch((e) => e);

    expect(err).toBeInstanceOf(SubmittedTransactionUnconfirmed);
    expect(err.txHash).toBe(HASH);
    expect(err.reason).toBe("confirmation_timeout");
  }, 10_000);

  it("rethrows unchanged when the network rejected the transaction", async () => {
    rpc.mode = "rejects";
    const err = await signAndSendTracked((watcher) => sdkSend(watcher)).catch((e) => e);
    expect(err).not.toBeInstanceOf(SubmittedTransactionUnconfirmed);
    expect(err.message).toMatch(/Sending the transaction to the network failed/);
  });

  it("rethrows unchanged when the RPC was down before submit", async () => {
    rpc.mode = "down";
    const err = await signAndSendTracked((watcher) => sdkSend(watcher)).catch((e) => e);
    expect(err).not.toBeInstanceOf(SubmittedTransactionUnconfirmed);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });
});

describe("submittedUnconfirmedResult", () => {
  it("carries the hash and a repeatable status lookup", () => {
    const result = submittedUnconfirmedResult(
      "Set price",
      "res-1",
      new SubmittedTransactionUnconfirmed(HASH, new Error("socket hang up")),
      { price: "2" },
    );
    expect(result).toMatchObject({
      status: "submitted",
      resourceId: "res-1",
      price: "2",
      txHash: HASH,
      confirmed: false,
      reason: "rpc_unavailable",
      statusLookup: { tool: "mindvault_tx_status", arguments: { txHash: HASH }, retryable: true },
    });
    expect(result.message).toMatch(/Do not resubmit/);
  });
});

describe("registry mutations after RPC loss", () => {
  beforeEach(() => {
    index._setAgentWallet({
      publicKey: Keypair.random().publicKey(),
      secretKey: Keypair.random().secret(),
    });
  });

  const schemaFor = (tool: string) => TOOL_DEFINITIONS.find((t) => t.name === tool)!.outputSchema;

  const CASES: [string, string, () => Promise<string>, Record<string, unknown>][] = [
    [
      "mindvault_update_metadata",
      "Update metadata",
      () => index.updateMetadata("res-1", "ipfs://meta"),
      { metadata: "ipfs://meta" },
    ],
    ["mindvault_set_price", "Set price", () => index.setPrice("res-1", "2.5"), { price: "2.5" }],
    [
      "mindvault_transfer_ownership",
      "Transfer ownership",
      () => index.transferOwnership("res-1", Keypair.random().publicKey()),
      {},
    ],
    [
      "mindvault_set_listed",
      "Set listed",
      () => index.setListed("res-1", false),
      { listed: false },
    ],
  ];

  it.each(CASES)(
    "%s returns the submitted hash and a status lookup",
    async (tool, label, run, fields) => {
      rpc.mode = "lost-after-submit";
      const result = JSON.parse(await run());

      expect(rpc.sent).toBe(1);
      expect(result).toMatchObject({
        status: "submitted",
        // #1056: submitted-but-unconfirmed path must report txPhase:"submitted", not "settled".
        txPhase: "submitted",
        resourceId: "res-1",
        ...fields,
        txHash: HASH,
        confirmed: false,
        statusLookup: { tool: "mindvault_tx_status", arguments: { txHash: HASH }, retryable: true },
      });
      expect(result.message).toContain(label);
      // The payload honours the tool's advertised output schema (#1062).
      expect(
        outputContractViolation(
          { content: [{ type: "text", text: "" }], structuredContent: result },
          schemaFor(tool),
        ),
      ).toBeUndefined();
    },
  );

  it.each(CASES)(
    "%s still reports success when the transaction confirms",
    async (_tool, _l, run) => {
      const result = JSON.parse(await run());
      expect(result.status).toBe("success");
      // #1056: confirmed settlement must report txPhase:"settled" and confirmed:true.
      expect(result.txPhase).toBe("settled");
      expect(result.confirmed).toBe(true);
      expect(result.txHash).toBe(HASH);
      expect(result.statusLookup).toBeUndefined();
    },
  );

  it.each(CASES)(
    "%s still fails when the RPC was down before submit",
    async (_tool, label, run) => {
      rpc.mode = "down";
      await expect(run()).rejects.toThrow(new RegExp(`${label} submission failed`));
    },
  );

  it("mindvault_set_tags names the hash and how to check it", async () => {
    rpc.mode = "lost-after-submit";
    const text = await index.setTags("res-1", ["ai"]);
    expect(text).toContain(`Tx hash: ${HASH}`);
    expect(text).toMatch(/not confirmed/);
    expect(text).toMatch(/mindvault_tx_status/);
  });
});
