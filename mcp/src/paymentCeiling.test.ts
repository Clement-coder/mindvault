import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AUTO_PAY_USDC,
  assertAutoPaymentWithinCeiling,
  assertTransactionFeeWithinCeiling,
  assertChallengePriceWithinCeiling,
  parsePriceFromPaymentRequired,
  PriceChangedCeilingError,
} from "./paymentCeiling.js";
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
    expect(() =>
      assertTransactionFeeWithinCeiling({
        feeStroops: "100",
        env: { MINDVAULT_MAX_AUTO_FEE_STROOPS: "100" },
      }),
    ).not.toThrow();
  });

  it("blocks an oversized registry mutation fee", () => {
    expect(() =>
      assertTransactionFeeWithinCeiling({
        feeStroops: "101",
        env: { MINDVAULT_MAX_AUTO_FEE_STROOPS: "100" },
      }),
    ).toThrow(/exceeds/);
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

// ── #1025: Ceiling recomputation after server price changes ──────────────────

/** Encode an object the same way @x402/express emits PAYMENT-REQUIRED. */
function encodePaymentRequired(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("parsePriceFromPaymentRequired", () => {
  it("extracts a top-level string price", () => {
    const header = encodePaymentRequired({ price: "7.50", payTo: "GA..." });
    expect(parsePriceFromPaymentRequired(header)).toBe("7.50");
  });

  it("extracts a top-level numeric price", () => {
    const header = encodePaymentRequired({ price: 3, payTo: "GA..." });
    expect(parsePriceFromPaymentRequired(header)).toBe("3");
  });

  it("extracts maxAmountRequired from schemes array (stroops)", () => {
    // 5 USDC = 50_000_000 stroops
    const header = encodePaymentRequired({
      schemes: [{ details: { maxAmountRequired: "50000000" } }],
    });
    expect(parsePriceFromPaymentRequired(header)).toBe("5");
  });

  it("handles fractional stroops correctly", () => {
    // 1.5 USDC = 15_000_000 stroops
    const header = encodePaymentRequired({
      schemes: [{ details: { maxAmountRequired: "15000000" } }],
    });
    expect(parsePriceFromPaymentRequired(header)).toBe("1.5");
  });

  it("returns null for absent header", () => {
    expect(parsePriceFromPaymentRequired(null)).toBeNull();
    expect(parsePriceFromPaymentRequired(undefined)).toBeNull();
    expect(parsePriceFromPaymentRequired("")).toBeNull();
  });

  it("returns null for unparseable base64", () => {
    expect(parsePriceFromPaymentRequired("not-valid-base64!!!")).toBeNull();
  });

  it("returns null when JSON parses but has no price field", () => {
    const header = encodePaymentRequired({ payTo: "GA..." });
    expect(parsePriceFromPaymentRequired(header)).toBeNull();
  });
});

describe("assertChallengePriceWithinCeiling (#1025)", () => {
  const env5 = { MINDVAULT_MAX_AUTO_PAY_USDC: "5" } as NodeJS.ProcessEnv;

  it("passes when the challenge price is within the ceiling", () => {
    const header = encodePaymentRequired({ price: "4.99" });
    expect(() =>
      assertChallengePriceWithinCeiling({ headerValue: header, previewPrice: "4.99", env: env5 }),
    ).not.toThrow();
  });

  it("passes when the challenge price equals the ceiling exactly", () => {
    const header = encodePaymentRequired({ price: "5.00" });
    expect(() =>
      assertChallengePriceWithinCeiling({ headerValue: header, previewPrice: "5.00", env: env5 }),
    ).not.toThrow();
  });

  it("throws PriceChangedCeilingError when challenge price exceeds ceiling", () => {
    // Preview was within ceiling (3 USDC), but server now charges 6 USDC
    const header = encodePaymentRequired({ price: "6.00" });
    expect(() =>
      assertChallengePriceWithinCeiling({ headerValue: header, previewPrice: "3.00", env: env5 }),
    ).toThrow(PriceChangedCeilingError);
  });

  it("error message includes preview price, actual price, and ceiling", () => {
    const header = encodePaymentRequired({ price: "6.00" });
    let thrown: unknown;
    try {
      assertChallengePriceWithinCeiling({ headerValue: header, previewPrice: "3.00", env: env5 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PriceChangedCeilingError);
    const e = thrown as PriceChangedCeilingError;
    expect(e.previewPrice).toBe("3.00");
    expect(e.actualPrice).toBe("6.00");
    expect(e.ceiling).toBe("5");
    expect(e.message).toContain("3.00 USDC");
    expect(e.message).toContain("6.00 USDC");
    expect(e.message).toContain("5 USDC");
    expect(e.message).toContain("maxAutoPayUsdc");
  });

  it("passes when maxAutoPayUsdc covers the new challenge price", () => {
    const header = encodePaymentRequired({ price: "6.00" });
    expect(() =>
      assertChallengePriceWithinCeiling({
        headerValue: header,
        previewPrice: "3.00",
        maxAutoPayUsdc: "6.00",
        env: env5,
      }),
    ).not.toThrow();
  });

  it("is a no-op when the header is absent (cannot verify, skip check)", () => {
    expect(() =>
      assertChallengePriceWithinCeiling({ headerValue: null, previewPrice: "3.00", env: env5 }),
    ).not.toThrow();
  });

  it("is a no-op when the header is unparseable", () => {
    expect(() =>
      assertChallengePriceWithinCeiling({
        headerValue: "garbage!!!",
        previewPrice: "3.00",
        env: env5,
      }),
    ).not.toThrow();
  });
});
