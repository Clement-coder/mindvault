/**
 * Tests for local purchase receipt store and mindvault_purchase_history filters.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  _clearPurchases,
  _setPurchasesFilePath,
  formatPurchaseHistory,
  listPurchases,
  normalizePurchaseHistoryFilter,
  purchaseHistoryTool,
  PurchaseHistoryError,
  recordPurchase,
} from "./purchaseHistory.js";

describe("purchaseHistory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mv-purchases-"));
    _setPurchasesFilePath(join(dir, "purchases.json"));
    _clearPurchases();
  });

  afterEach(() => {
    _setPurchasesFilePath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty history when no receipts are stored", () => {
    const listed = listPurchases();
    expect(listed).toEqual([]);
    const formatted = formatPurchaseHistory(listed);
    const parsed = JSON.parse(formatted);
    expect(parsed.count).toBe(0);
    expect(parsed.purchases).toEqual([]);
    expect(parsed.message).toMatch(/No purchase receipts/i);
  });

  it("lists populated history newest-first", () => {
    recordPurchase({
      resourceId: "res-a",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: "tx-a",
      receiptRef: "pay-a",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    recordPurchase({
      resourceId: "res-b",
      amount: "2.50",
      network: "stellar:testnet",
      txHash: "tx-b",
      receiptRef: "pay-b",
      timestamp: "2026-02-01T00:00:00.000Z",
      title: "Dataset B",
    });

    const listed = listPurchases();
    expect(listed).toHaveLength(2);
    expect(listed[0].resourceId).toBe("res-b");
    expect(listed[1].resourceId).toBe("res-a");

    const toolOut = JSON.parse(purchaseHistoryTool({}));
    expect(toolOut.count).toBe(2);
    expect(toolOut.purchases[0].receiptRef).toBe("pay-b");
    expect(toolOut.purchases[0].title).toBe("Dataset B");
  });

  it("filters by resourceId", () => {
    recordPurchase({
      resourceId: "res-a",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: "pay-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    recordPurchase({
      resourceId: "res-b",
      amount: "2.00",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: "pay-2",
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    const filtered = listPurchases({ resourceId: "res-a" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].receiptRef).toBe("pay-1");

    const empty = JSON.parse(purchaseHistoryTool({ resourceId: "missing" }));
    expect(empty.count).toBe(0);
  });

  it("filters by network", () => {
    recordPurchase({
      resourceId: "res-a",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: "t1",
      receiptRef: "p1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    recordPurchase({
      resourceId: "res-a",
      amount: "1.00",
      network: "stellar:pubnet",
      txHash: "t2",
      receiptRef: "p2",
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    const testnet = listPurchases({ network: "stellar:testnet" });
    expect(testnet).toHaveLength(1);
    expect(testnet[0].txHash).toBe("t1");

    const both = listPurchases({ resourceId: "res-a", network: "stellar:pubnet" });
    expect(both).toHaveLength(1);
    expect(both[0].receiptRef).toBe("p2");
  });

  it("searches resource ids and titles case-insensitively and composes with network", () => {
    recordPurchase({
      resourceId: "stellar-guide-v2",
      title: "Soroban Security Handbook",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: null,
    });
    recordPurchase({
      resourceId: "other",
      title: "Soroban Security Handbook",
      amount: "2.00",
      network: "stellar:pubnet",
      txHash: null,
      receiptRef: null,
    });

    expect(listPurchases({ query: "STELLAR-GUIDE" })).toHaveLength(1);
    const result = JSON.parse(
      purchaseHistoryTool({ query: "security handbook", network: "stellar:testnet" }),
    );
    expect(result.count).toBe(1);
    expect(result.purchases[0].resourceId).toBe("stellar-guide-v2");
  });

  it("rejects non-string filters deterministically", () => {
    expect(() => normalizePurchaseHistoryFilter({ resourceId: 123 as unknown as string })).toThrow(
      PurchaseHistoryError,
    );
    expect(() => normalizePurchaseHistoryFilter({ network: true as unknown as string })).toThrow(
      /Invalid network filter/,
    );
    expect(() => normalizePurchaseHistoryFilter({ query: 7 as unknown as string })).toThrow(
      /Invalid query filter/,
    );
  });
});
