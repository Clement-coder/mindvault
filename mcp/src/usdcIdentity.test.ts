/**
 * Tests for canonical USDC identity verification (#1053).
 *
 * Proves that a Horizon balance entry named "USDC" is only treated as the
 * canonical payment asset when its `asset_issuer` matches the network preset,
 * and that a counterfeit entry with the same code but a different issuer is
 * never selected.
 */

import { describe, expect, it } from "vitest";
import {
  findCanonicalUsdc,
  isCanonicalUsdc,
  USDC_ASSET_CODE,
  type HorizonBalanceEntry,
} from "./usdcIdentity.js";

/** Testnet USDC classic issuer from the network preset. */
const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** A counterfeit issuer — same code, wrong issuer. */
const COUNTERFEIT_ISSUER = "GFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

describe("isCanonicalUsdc", () => {
  it("returns true for the canonical testnet USDC balance entry", () => {
    const entry: HorizonBalanceEntry = {
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: TESTNET_USDC_ISSUER,
      balance: "1000.0000000",
    };
    expect(isCanonicalUsdc(entry, TESTNET_USDC_ISSUER)).toBe(true);
  });

  it("returns false for a counterfeit USDC with a different issuer", () => {
    const entry: HorizonBalanceEntry = {
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: COUNTERFEIT_ISSUER,
      balance: "5000.0000000",
    };
    expect(isCanonicalUsdc(entry, TESTNET_USDC_ISSUER)).toBe(false);
  });

  it("returns false when asset_issuer is missing", () => {
    const entry: HorizonBalanceEntry = {
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      balance: "1000.0000000",
    };
    expect(isCanonicalUsdc(entry, TESTNET_USDC_ISSUER)).toBe(false);
  });

  it("returns false for a native (XLM) balance entry", () => {
    const entry: HorizonBalanceEntry = {
      asset_type: "native",
      balance: "100.0000000",
    };
    expect(isCanonicalUsdc(entry, TESTNET_USDC_ISSUER)).toBe(false);
  });

  it("returns false for a credit_alphanum4 asset with a different code", () => {
    const entry: HorizonBalanceEntry = {
      asset_type: "credit_alphanum4",
      asset_code: "EURT",
      asset_issuer: TESTNET_USDC_ISSUER,
      balance: "50.0000000",
    };
    expect(isCanonicalUsdc(entry, TESTNET_USDC_ISSUER)).toBe(false);
  });

  it("returns false for a null or undefined entry", () => {
    expect(isCanonicalUsdc(null as unknown as HorizonBalanceEntry, TESTNET_USDC_ISSUER)).toBe(
      false,
    );
    expect(isCanonicalUsdc(undefined as unknown as HorizonBalanceEntry, TESTNET_USDC_ISSUER)).toBe(
      false,
    );
  });

  it("is network-aware: rejects testnet issuer when configured for mainnet", () => {
    const MAINNET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const entry: HorizonBalanceEntry = {
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: TESTNET_USDC_ISSUER,
      balance: "1000.0000000",
    };
    // Correct code and a real issuer — but the wrong network's issuer.
    expect(isCanonicalUsdc(entry, MAINNET_ISSUER)).toBe(false);
  });
});

describe("findCanonicalUsdc", () => {
  it("finds the canonical USDC among multiple balances", () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: TESTNET_USDC_ISSUER,
        balance: "1000.0000000",
      },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: COUNTERFEIT_ISSUER,
        balance: "5000.0000000",
      },
    ];
    const result = findCanonicalUsdc(balances, TESTNET_USDC_ISSUER);
    expect(result).toBeDefined();
    expect(result!.balance).toBe("1000.0000000");
    expect(result!.asset_issuer).toBe(TESTNET_USDC_ISSUER);
  });

  it("returns undefined when only a counterfeit USDC is present", () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: COUNTERFEIT_ISSUER,
        balance: "5000.0000000",
      },
    ];
    const result = findCanonicalUsdc(balances, TESTNET_USDC_ISSUER);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no USDC is present at all", () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "EURT",
        asset_issuer: "GDVGJKJ6LW2Z4XJ4Z5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5Q5",
        balance: "50.0000000",
      },
    ];
    const result = findCanonicalUsdc(balances, TESTNET_USDC_ISSUER);
    expect(result).toBeUndefined();
  });

  it("returns undefined for an empty balances array", () => {
    const result = findCanonicalUsdc([], TESTNET_USDC_ISSUER);
    expect(result).toBeUndefined();
  });

  it("selects the canonical USDC even when the counterfeit has a larger balance", () => {
    const balances: HorizonBalanceEntry[] = [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: COUNTERFEIT_ISSUER,
        balance: "9999999.0000000",
      },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: TESTNET_USDC_ISSUER,
        balance: "0.50",
      },
      { asset_type: "native", balance: "100.0000000" },
    ];
    const result = findCanonicalUsdc(balances, TESTNET_USDC_ISSUER);
    expect(result).toBeDefined();
    expect(result!.balance).toBe("0.50");
    expect(result!.asset_issuer).toBe(TESTNET_USDC_ISSUER);
  });

  it("handles a balance entry without asset_issuer (legacy/mock format)", () => {
    const balances: HorizonBalanceEntry[] = [
      { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "1000.0000000" },
      { asset_type: "native", balance: "100.0000000" },
    ];
    // Without an asset_issuer field, the entry is not canonical.
    const result = findCanonicalUsdc(balances, TESTNET_USDC_ISSUER);
    expect(result).toBeUndefined();
  });
});

describe("USDC_ASSET_CODE", () => {
  it("is the string 'USDC'", () => {
    expect(USDC_ASSET_CODE).toBe("USDC");
  });
});
