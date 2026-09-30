/**
 * Tests for the USDC unit boundary (#838).
 *
 * The property that matters is that the two encodings the server reads —
 * Horizon's decimal strings and Soroban's i128 stroops — describe the same
 * quantity after normalization, and that a value which cannot be read comes
 * back as null rather than as zero. A silent zero is what turns a failed
 * balance read into an approved payment.
 */
import { describe, it, expect } from "vitest";
import {
  compareUsdc,
  isUsdcDecimal,
  normalizeUsdcBalance,
  stroopsToUsdc,
  sumUsdc,
  trimUsdc,
  usdcToStroops,
  STROOPS_PER_USDC,
  USDC_DECIMALS,
} from "./usdcAmount.js";

describe("the conversion factor", () => {
  it("is Stellar's 7-decimal precision, stated once", () => {
    expect(STROOPS_PER_USDC).toBe(10_000_000n);
    expect(USDC_DECIMALS).toBe(7);
    expect(10n ** BigInt(USDC_DECIMALS)).toBe(STROOPS_PER_USDC);
  });
});

describe("stroopsToUsdc", () => {
  it("scales by 10^7, not by 10", () => {
    // The mistake in the issue is a balance off by a factor of ten million.
    expect(stroopsToUsdc(10_000_000n)).toBe("1.0000000");
    expect(stroopsToUsdc(1n)).toBe("0.0000001");
    expect(stroopsToUsdc(125_000_000n)).toBe("12.5000000");
  });

  it("renders zero and negative amounts", () => {
    expect(stroopsToUsdc(0n)).toBe("0.0000000");
    expect(stroopsToUsdc(-15_000_000n)).toBe("-1.5000000");
  });

  it("keeps full precision on large balances", () => {
    expect(stroopsToUsdc(123_456_789_012_345n)).toBe("12345678.9012345");
  });
});

describe("usdcToStroops", () => {
  it("parses decimal amounts exactly", () => {
    expect(usdcToStroops("1")).toBe(10_000_000n);
    expect(usdcToStroops("1.0000000")).toBe(10_000_000n);
    expect(usdcToStroops("0.0000001")).toBe(1n);
    expect(usdcToStroops("12.5")).toBe(125_000_000n);
  });

  it("does not lose the cent that floating point loses", () => {
    // 0.1 + 0.2 in IEEE754 is not 0.3; in stroops it is exact.
    expect(usdcToStroops("0.1")! + usdcToStroops("0.2")!).toBe(usdcToStroops("0.3"));
  });

  it("trims surrounding whitespace", () => {
    expect(usdcToStroops("  2.5 ")).toBe(25_000_000n);
  });

  it("returns null rather than a silent zero for values it cannot read", () => {
    for (const bad of ["", " ", "abc", "1.2.3", "1e7", "0x10", "1,5", "NaN", "Infinity", "-"]) {
      expect(usdcToStroops(bad), bad).toBeNull();
    }
  });

  it("rejects more precision than Stellar can hold", () => {
    // Eight decimals cannot be represented; rounding it into a transaction
    // would pay an amount the agent never approved.
    expect(usdcToStroops("1.00000001")).toBeNull();
  });

  it("rejects a negative amount unless the caller allows one", () => {
    expect(usdcToStroops("-1.5")).toBeNull();
    expect(usdcToStroops("-1.5", { allowNegative: true })).toBe(-15_000_000n);
  });

  it("round-trips through stroopsToUsdc", () => {
    for (const value of ["0", "1", "12.5", "0.0000001", "999999.9999999"]) {
      expect(usdcToStroops(stroopsToUsdc(usdcToStroops(value)!))).toBe(usdcToStroops(value));
    }
  });
});

describe("normalizeUsdcBalance", () => {
  it("reads the same balance identically from either source", () => {
    // This is the regression: a Horizon decimal and a Soroban stroop count for
    // the same holding must normalize to the same amount.
    const fromHorizon = normalizeUsdcBalance({ source: "horizon", balance: "12.5" });
    const fromSoroban = normalizeUsdcBalance({ source: "soroban", stroops: 125_000_000n });
    expect(fromHorizon).toBe(fromSoroban);
    expect(fromHorizon).toBe("12.5000000");
  });

  it("does not read a stroop count as a decimal balance", () => {
    // 10_000_000 stroops is 1 USDC. Fed in as a Horizon decimal it is ten
    // million USDC — the silent 10^7 error, made visible by the tag.
    expect(normalizeUsdcBalance({ source: "soroban", stroops: 10_000_000n })).toBe("1.0000000");
    expect(normalizeUsdcBalance({ source: "horizon", balance: "10000000" })).toBe(
      "10000000.0000000",
    );
  });

  it("returns null for a Horizon balance it cannot parse", () => {
    for (const bad of ["", "unavailable", "1e7"]) {
      expect(normalizeUsdcBalance({ source: "horizon", balance: bad }), bad).toBeNull();
    }
  });

  it("accepts a zero balance from either source", () => {
    expect(normalizeUsdcBalance({ source: "horizon", balance: "0" })).toBe("0.0000000");
    expect(normalizeUsdcBalance({ source: "soroban", stroops: 0n })).toBe("0.0000000");
  });
});

describe("compareUsdc", () => {
  it("orders amounts exactly", () => {
    expect(compareUsdc("1.0000000", "1")).toBe(0);
    expect(compareUsdc("0.9999999", "1")).toBe(-1);
    expect(compareUsdc("1.0000001", "1")).toBe(1);
  });

  it("compares across differently formatted equal amounts", () => {
    expect(compareUsdc("12.5", "12.5000000")).toBe(0);
  });

  it("returns null when either side cannot be read", () => {
    // Distinguishing "cannot compare" from "not greater than" is the point: the
    // latter would let an unreadable balance authorize a payment.
    expect(compareUsdc("oops", "1")).toBeNull();
    expect(compareUsdc("1", "oops")).toBeNull();
  });
});

describe("sumUsdc", () => {
  it("adds amounts exactly", () => {
    expect(sumUsdc(["0.1", "0.2"])).toBe("0.3000000");
    expect(sumUsdc([])).toBe("0.0000000");
  });

  it("skips values that are not amounts", () => {
    expect(sumUsdc(["1", "", "not-a-number", "2"])).toBe("3.0000000");
  });
});

describe("trimUsdc", () => {
  it("drops trailing fractional zeros for display", () => {
    expect(trimUsdc("12.5000000")).toBe("12.5");
    expect(trimUsdc("1.0000000")).toBe("1");
    expect(trimUsdc("0.0000000")).toBe("0");
    expect(trimUsdc("100")).toBe("100");
  });
});

describe("isUsdcDecimal", () => {
  it("accepts amounts and rejects everything else", () => {
    expect(isUsdcDecimal("5.00")).toBe(true);
    expect(isUsdcDecimal("0")).toBe(true);
    expect(isUsdcDecimal("5.000000001")).toBe(false);
    expect(isUsdcDecimal(5)).toBe(false);
    expect(isUsdcDecimal(null)).toBe(false);
    expect(isUsdcDecimal(10_000_000n)).toBe(false);
  });
});
