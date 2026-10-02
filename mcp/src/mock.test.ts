import { describe, it, expect } from "vitest";
import {
  mockBuyReceipt,
  mockEnabledFromEnv,
  mockSetTags,
  MOCK_CATALOG_RESOURCES,
  MOCK_REGISTRY_RESOURCES,
  mockSetTags,
} from "./mock.js";

describe("mockEnabledFromEnv", () => {
  it("returns true for truthy values", () => {
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "1" })).toBe(true);
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "true" })).toBe(true);
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "yes" })).toBe(true);
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "on" })).toBe(true);
  });

  it("returns false for falsy or missing values", () => {
    expect(mockEnabledFromEnv({})).toBe(false);
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "0" })).toBe(false);
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "false" })).toBe(false);
    expect(mockEnabledFromEnv({ MINDVAULT_MOCK: "" })).toBe(false);
  });
});

describe("mockBuyReceipt", () => {
  it("returns a deterministic receipt for a buy flow", () => {
    const receipt = mockBuyReceipt("mock-1", "1.50");
    expect(receipt).toEqual({
      resourceId: "mock-1",
      amount: "1.50",
      network: "stellar:testnet",
      txHash: "MOCK_TX_BUY_mock-1_1",
      receiptRef: "mock-receipt-mock-1-1",
      purchasedAt: "2026-08-25T12:00:00.000Z",
    });
  });

  it("allows overriding the network", () => {
    const receipt = mockBuyReceipt("mock-2", "0.50", "stellar:pubnet");
    expect(receipt.network).toBe("stellar:pubnet");
    expect(receipt.txHash).toContain("mock-2");
  });

  it("generates unique receipts when using a nonce", () => {
    const nonce = {};
    const r1 = mockBuyReceipt("mock-1", "1.50", "stellar:testnet", nonce);
    const r2 = mockBuyReceipt("mock-1", "1.50", "stellar:testnet", nonce);
    expect(r1.txHash).not.toBe(r2.txHash);
    expect(r1.receiptRef).not.toBe(r2.receiptRef);
  });

  it("generates deterministic receipts without a nonce", () => {
    const r1 = mockBuyReceipt("mock-1", "1.50");
    const r2 = mockBuyReceipt("mock-1", "1.50");
    expect(r1.txHash).toBe(r2.txHash);
    expect(r1.receiptRef).toBe(r2.receiptRef);
  });
});

describe("mockSetTags", () => {
  it("returns a deterministic text-only result", () => {
    const result = mockSetTags("mock-1", ["dataset", "research"]);
    expect(result).toContain('Tags updated for resource "mock-1".');
    expect(result).toContain("Tags: dataset, research");
    expect(result).toContain("MOCK_TX_SET_TAGS_mock-1");
  });
});

describe("MOCK_CATALOG_RESOURCES", () => {
  it("contains seeded resources", () => {
    expect(MOCK_CATALOG_RESOURCES.length).toBeGreaterThan(0);
    for (const r of MOCK_CATALOG_RESOURCES) {
      expect(r.id).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.price).toBeTruthy();
      expect(r.accessUrl).toBeTruthy();
    }
  });
});

describe("MOCK_REGISTRY_RESOURCES", () => {
  it("contains seeded registry resources", () => {
    expect(MOCK_REGISTRY_RESOURCES.length).toBeGreaterThan(0);
    for (const r of MOCK_REGISTRY_RESOURCES) {
      expect(r.id).toBeTruthy();
      expect(r.creator).toBeTruthy();
      expect(r.price).toBeTruthy();
    }
  });
});
