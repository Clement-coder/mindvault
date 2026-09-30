import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_AUTO_PAY_USDC, assertAutoPaymentWithinCeiling, assertTransactionFeeWithinCeiling } from "./paymentCeiling.js";
import { MIN_USDC_BALANCE, MIN_NATIVE_XLM, assertMinimumBalance } from "./paymentPreflight.js";

const env = { MINDVAULT_MAX_AUTO_PAY_USDC: "5" } as NodeJS.ProcessEnv;

describe("automatic x402 payment ceiling", () => {
  it("uses a documented 10 USDC default", () => {
    expect(DEFAULT_MAX_AUTO_PAY_USDC).toBe("10");
  });

  it("allows a payment below the configured ceiling", () => {
    expect(() => assertAutoPaymentWithinCeiling({ price: "4.99", env })).not.toThrow();
  });

  it("allows a payment exactly at the configured ceiling", () => {
    expect(() => assertAutoPaymentWithinCeiling({ price: "5.00", env })).not.toThrow();
  });

  it("blocks a payment above the ceiling until that call explicitly overrides it", () => {
    expect(() => assertAutoPaymentWithinCeiling({ price: "5.01", env })).toThrow(
      'Purchase requires 5.01 USDC, which exceeds the automatic payment ceiling of 5 USDC. To authorize this purchase, call mindvault_buy with maxAutoPayUsdc: "5.01"',
    );
    expect(() =>
      assertAutoPaymentWithinCeiling({ price: "5.01", maxAutoPayUsdc: "5.01", env }),
    ).not.toThrow();
  });
});

describe("transaction fee ceiling", () => {
  it("allows fees at or below the configured ceiling", () => {
    expect(() => assertTransactionFeeWithinCeiling({ feeStroops: "100", env: { MINDVAULT_MAX_AUTO_FEE_STROOPS: "100" } })).not.toThrow();
  });

  it("blocks an oversized registry mutation fee", () => {
    expect(() => assertTransactionFeeWithinCeiling({ feeStroops: "101", env: { MINDVAULT_MAX_AUTO_FEE_STROOPS: "100" } })).toThrow(/exceeds/);
  });
});

describe("minimum balance guard", () => {
  it("uses documented defaults", () => {
    expect(MIN_NATIVE_XLM).toBe(0.5);
    expect(MIN_USDC_BALANCE).toBe(0);
  });

  it("returns null when balance is sufficient", () => {
    expect(
      assertMinimumBalance({
        usdcBalance: "10",
        nativeBalance: "2",
        operation: "buy",
      }),
    ).toBeNull();
  });

  it("returns an error when native XLM is too low", () => {
    const result = assertMinimumBalance({
      usdcBalance: "10",
      nativeBalance: "0.1",
      operation: "buy",
    });
    expect(result).toContain("Insufficient native XLM");
    expect(result).toContain("0.1");
  });

  it("returns an error when USDC balance is below required amount", () => {
    const result = assertMinimumBalance({
      usdcBalance: "1",
      nativeBalance: "2",
      operation: "buy",
      requiredUsdc: "5",
    });
    expect(result).toContain("Insufficient USDC");
    expect(result).toContain("1");
    expect(result).toContain("5");
  });

  it("returns null when USDC balance meets the required amount", () => {
    expect(
      assertMinimumBalance({
        usdcBalance: "5",
        nativeBalance: "2",
        operation: "buy",
        requiredUsdc: "5",
      }),
    ).toBeNull();
  });

  it("returns null when no required amount is specified", () => {
    expect(
      assertMinimumBalance({
        usdcBalance: "0.5",
        nativeBalance: "2",
        operation: "buy",
      }),
    ).toBeNull();
  });
});
