/**
 * Read-only wallet allowance summary (#1052).
 *
 * These tests exercise the pure builder: what is counted as pending spend, how
 * the remaining allowance is derived, and that every monetary value carries the
 * USDC asset and x402 network it belongs to.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_AUTO_PAY_USDC, readPaymentCeiling } from "./paymentCeiling.js";
import type { PurchaseReceipt } from "./purchaseHistory.js";
import {
  buildWalletAllowanceSummary,
  formatWalletAllowanceSummary,
  type WalletAllowanceInput,
} from "./walletAllowance.js";

const ASSET = {
  code: "USDC" as const,
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  decimals: 7,
};
const NETWORK = "stellar:testnet";

function receipt(overrides: Partial<PurchaseReceipt> = {}): PurchaseReceipt {
  return {
    resourceId: "res-001",
    amount: "1.5",
    network: NETWORK,
    txHash: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    receiptRef: null,
    profile: "default",
    ...overrides,
  };
}

function input(overrides: Partial<WalletAllowanceInput> = {}): WalletAllowanceInput {
  return {
    profile: "default",
    address: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
    network: NETWORK,
    networkPassphrase: "Test SDF Network ; September 2015",
    asset: ASSET,
    balance: { amount: "10.0000000", status: "funded", source: "horizon" },
    pendingReceipts: [],
    ceiling: readPaymentCeiling({}),
    ...overrides,
  };
}

describe("readPaymentCeiling", () => {
  it("reports the documented default without claiming it was configured", () => {
    expect(readPaymentCeiling({})).toEqual({
      amount: DEFAULT_MAX_AUTO_PAY_USDC,
      stroops: 100_000_000n,
      source: "default",
      configured: false,
    });
  });

  it("reports the configured value and its source", () => {
    expect(readPaymentCeiling({ MINDVAULT_MAX_AUTO_PAY_USDC: "2.5" })).toMatchObject({
      amount: "2.5",
      stroops: 25_000_000n,
      source: "MINDVAULT_MAX_AUTO_PAY_USDC",
      configured: true,
    });
  });

  it("rejects a malformed ceiling the same way the payment guard does", () => {
    expect(() => readPaymentCeiling({ MINDVAULT_MAX_AUTO_PAY_USDC: "abc" })).toThrow(
      /MINDVAULT_MAX_AUTO_PAY_USDC/,
    );
  });
});

describe("buildWalletAllowanceSummary", () => {
  it("labels the balance with asset and network identity", () => {
    const summary = buildWalletAllowanceSummary(input());

    expect(summary.balance).toMatchObject({
      amount: "10.0000000",
      asset: ASSET,
      network: NETWORK,
      estimate: false,
      status: "funded",
      source: "horizon",
    });
    expect(summary.asset).toEqual(ASSET);
    expect(summary.network).toBe(NETWORK);
  });

  it("sums only pending receipts for the active network", () => {
    const summary = buildWalletAllowanceSummary(
      input({
        pendingReceipts: [
          receipt({ resourceId: "pending-1", amount: "1.5" }),
          receipt({ resourceId: "pending-2", amount: "2.25", network: "stellar:pubnet" }),
          receipt({ resourceId: "settled", amount: "9", txHash: "a".repeat(64) }),
        ],
      }),
    );

    expect(summary.estimatedPendingSpend.amount).toBe("1.5000000");
    expect(summary.estimatedPendingSpend.count).toBe(1);
    expect(summary.estimatedPendingSpend.estimate).toBe(true);
    expect(summary.estimatedPendingSpend.purchases.map((p) => p.resourceId)).toEqual([
      "pending-1",
    ]);
    expect(summary.estimatedPendingSpend.purchases[0]).toMatchObject({
      asset: ASSET,
      network: NETWORK,
      estimate: true,
      status: "pending",
    });
  });

  it("derives the remaining allowance from balance, pending spend, and ceiling", () => {
    const summary = buildWalletAllowanceSummary(
      input({
        pendingReceipts: [receipt({ amount: "1.5" })],
        ceiling: readPaymentCeiling({ MINDVAULT_MAX_AUTO_PAY_USDC: "3" }),
      }),
    );

    expect(summary.balance.amount).toBe("10.0000000");
    expect(summary.estimatedPendingSpend.amount).toBe("1.5000000");
    expect(summary.paymentCeiling).toMatchObject({
      amount: "3",
      asset: ASSET,
      network: NETWORK,
      estimate: false,
      source: "MINDVAULT_MAX_AUTO_PAY_USDC",
      configured: true,
    });
    // min(ceiling 3, balance 10 - pending 1.5 = 8.5)
    expect(summary.estimatedRemainingAllowance.amount).toBe("3.0000000");
    expect(summary.estimatedRemainingAllowance.estimate).toBe(true);
    expect(summary.estimatedRemainingAllowance.asset).toEqual(ASSET);
    expect(summary.estimatedRemainingAllowance.network).toBe(NETWORK);
  });

  it("never reports a negative remaining allowance", () => {
    const summary = buildWalletAllowanceSummary(
      input({
        balance: { amount: "1.0000000", status: "funded", source: "horizon" },
        pendingReceipts: [receipt({ amount: "2.5" })],
      }),
    );

    expect(summary.estimatedRemainingAllowance.amount).toBe("0.0000000");
  });

  it("excludes an unreadable receipt amount from the estimate and says so", () => {
    const summary = buildWalletAllowanceSummary(
      input({
        pendingReceipts: [
          receipt({ resourceId: "good", amount: "2" }),
          receipt({ resourceId: "bad", amount: "not-a-number" }),
        ],
      }),
    );

    expect(summary.estimatedPendingSpend.amount).toBe("2.0000000");
    expect(summary.estimatedPendingSpend.count).toBe(2);
    expect(summary.notes.join("\n")).toContain("could not be read");
  });

  it("states that pending spend is an estimate that may already be on-chain", () => {
    const summary = buildWalletAllowanceSummary(
      input({ pendingReceipts: [receipt({ amount: "1" })] }),
    );

    expect(summary.notes.join("\n")).toContain("estimated from local receipts");
    expect(summary.notes.join("\n")).toContain("may already be reflected");
    expect(summary.message).toContain("estimated");
    expect(summary.readOnly).toBe(true);
  });

  it("renders every amount with the network and marks the estimates", () => {
    const summary = buildWalletAllowanceSummary(
      input({ pendingReceipts: [receipt({ amount: "1" })] }),
    );
    const text = formatWalletAllowanceSummary(summary);

    expect(text).toContain(`USDC balance: 10 USDC · ${NETWORK}`);
    expect(text).toContain(`Estimated pending spend: 1 USDC · ${NETWORK} (estimate;`);
    expect(text).toContain(`Configured payment ceiling: 10 USDC · ${NETWORK}`);
    expect(text).toContain(`Estimated remaining allowance: 9 USDC · ${NETWORK} (estimate;`);
    expect(text).toContain("No signing, transfer, or payment was performed");
  });
});
