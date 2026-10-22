/**
 * Anchor retry: attempt cap and cooldown invariants (#goal).
 *
 * Every registry mutation that goes through `signAndSendRegistryTx` must
 * obey the same two rules as the batch path:
 *
 *  1. **Attempt cap** — when the transaction is submitted but confirming it
 *     fails, the tool returns a `submitted` result carrying the hash.  It
 *     does NOT resubmit, so a manual or automatic retry cannot pay twice or
 *     create a duplicate on-chain change.
 *
 *  2. **No alternate path bypasses cooldown** — the unconfirmed result always
 *     contains `statusLookup` pointing at `mindvault_tx_status` so agents
 *     know how to poll without re-entering the mutation.
 *
 * The SDK's `SentTransaction` is used directly (not mocked) so the submit +
 * confirmation polling lifecycle runs through the real code path; only the
 * RPC transport is controlled via the `rpc` flag.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Keypair, contract } from "@stellar/stellar-sdk";

import type { SubmissionWatcher } from "../submittedTransaction.js";

// ── RPC control ───────────────────────────────────────────────────────────────

const HASH = "deadbeef".padEnd(64, "0");

const rpc = vi.hoisted(() => ({
  /** true = getTransaction throws after sendTransaction — simulates RPC drop. */
  lostAfterSubmit: true,
}));

const wallet = vi.hoisted(() => ({ publicKey: "", secretKey: "" }));

// ── Runtime mock ──────────────────────────────────────────────────────────────

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    _isMock: () => false,
    requireWallet: () => wallet,
    requireApiKey: () => "api-key",
    REGISTRY_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    REGISTRY_CONTRACT_ID: "CREGISTRY",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  };
});

// ── Registry client mock ──────────────────────────────────────────────────────

/**
 * Build a minimal registry-tx stub whose `signAndSend` runs a real
 * `SentTransaction` lifecycle so the `watcher.onSubmitted` callback fires and
 * the `SubmittedTransactionUnconfirmed` error is raised on RPC failure.
 */
function makeRegistryTx() {
  const server = {
    sendTransaction: async () => ({ status: "PENDING", hash: HASH }),
    getTransaction: async () => {
      if (rpc.lostAfterSubmit) throw new Error("fetch failed: ECONNRESET");
      return { status: "SUCCESS" };
    },
  };
  const assembled = { options: { server, timeoutInSeconds: 1 }, signed: {} };
  return {
    result: {
      isErr: () => false,
      isOk: () => true,
      unwrap: () => undefined,
      unwrapErr: () => undefined,
    },
    signAndSend: (opts: {
      signTransaction: (xdr: string) => Promise<{ signedTxXdr: string }>;
      watcher?: SubmissionWatcher;
    }) => {
      return (new contract.SentTransaction(assembled as any) as any).send(opts.watcher as any);
    },
  };
}

vi.mock("@mindvault/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createRegistryClient: () => ({
      update_metadata: async () => makeRegistryTx(),
      set_price: async () => makeRegistryTx(),
      transfer_ownership: async () => makeRegistryTx(),
      set_listed: async () => makeRegistryTx(),
      accept_transfer: async () => makeRegistryTx(),
      cancel_transfer: async () => makeRegistryTx(),
    }),
    Errors: { 2: { message: "NotFound" } },
  };
});

vi.mock("../mock.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mockUpdateMetadata: vi.fn(),
    mockSetPrice: vi.fn(),
    mockTransferOwnership: vi.fn(),
    mockPublishBatch: vi.fn(),
    mockSetListed: vi.fn(),
    mockAcceptTransfer: vi.fn(),
    mockCancelTransfer: vi.fn(),
  };
});

vi.mock("../paymentCeiling.js", () => ({
  assertTransactionFeeWithinCeiling: () => {},
}));

vi.mock("../onchainPreflight.js", () => ({
  assertOnchainSetupReady: () => {},
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function useWallet() {
  const kp = Keypair.random();
  wallet.publicKey = kp.publicKey();
  wallet.secretKey = kp.secret();
}

const { updateMetadata, setPrice, transferOwnership, setListed, acceptTransfer, cancelTransfer } =
  await import("./publish.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

/**
 * Each row names the mutation, the function under test, and any required
 * extra argument beyond resourceId.
 */
const MUTATIONS: Array<{
  label: string;
  call: () => Promise<string>;
  extraField?: string;
}> = [
  {
    label: "updateMetadata",
    call: () => updateMetadata("res-1", "ipfs://new"),
    extraField: "metadata",
  },
  {
    label: "setPrice",
    call: () => setPrice("res-1", "2.50"),
    extraField: "price",
  },
  {
    label: "transferOwnership",
    call: () => transferOwnership("res-1", "GNEW" + "A".repeat(51)),
    extraField: "newCreator",
  },
  {
    label: "setListed",
    call: () => setListed("res-1", true),
    extraField: "listed",
  },
  {
    label: "acceptTransfer",
    call: () => acceptTransfer("res-1"),
  },
  {
    label: "cancelTransfer",
    call: () => cancelTransfer("res-1"),
  },
];

describe("anchor retry: attempt cap", () => {
  beforeEach(() => {
    useWallet();
    rpc.lostAfterSubmit = true;
  });

  it.each(MUTATIONS)(
    "$label — submitted-but-unconfirmed returns the hash, never resubmits",
    async ({ call }) => {
      const result = JSON.parse(await call());

      // Must report submitted, not success — no resubmit attempted.
      expect(result.status).toBe("submitted");
      expect(result.txPhase).toBe("submitted");
      expect(result.confirmed).toBe(false);
    },
  );

  it.each(MUTATIONS)(
    "$label — unconfirmed result carries the hash so agents can poll",
    async ({ call }) => {
      const result = JSON.parse(await call());

      expect(result.txHash).toBe(HASH);
    },
  );
});

describe("anchor retry: no alternate path bypasses cooldown", () => {
  beforeEach(() => {
    useWallet();
    rpc.lostAfterSubmit = true;
  });

  it.each(MUTATIONS)(
    "$label — statusLookup points to mindvault_tx_status (safe to repeat, no resubmit)",
    async ({ call }) => {
      const result = JSON.parse(await call());

      expect(result.statusLookup).toMatchObject({
        tool: "mindvault_tx_status",
        arguments: { txHash: HASH },
        retryable: true,
      });
    },
  );

  it.each(MUTATIONS)("$label — message tells the agent not to resubmit", async ({ call }) => {
    const result = JSON.parse(await call());

    expect(result.message).toMatch(/Do not resubmit/);
    expect(result.message).toMatch(/mindvault_tx_status/);
  });
});

describe("anchor retry: happy path still works", () => {
  beforeEach(() => {
    useWallet();
    rpc.lostAfterSubmit = false;
  });

  it.each(MUTATIONS)(
    "$label — confirmed transaction returns success with txPhase settled",
    async ({ call }) => {
      const result = JSON.parse(await call());

      expect(result.status).toBe("success");
      expect(result.txPhase).toBe("settled");
      expect(result.confirmed).toBe(true);
      expect(result.txHash).toBe(HASH);
    },
  );
});
