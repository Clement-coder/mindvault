/**
 * Tests for dry-run mode validation and reporting.
 */
import { describe, it, expect } from "vitest";
import { dryRunPublish, dryRunBuy, dryRunOnchain, type DryRunPublishInput } from "./dryRun.js";

describe("dryRunPublish – input validation", () => {
  const baseUrl = "https://example.com";
  const network = "stellar:testnet";

  it("validates title (non-empty, 1-256 chars)", () => {
    const input: DryRunPublishInput = {
      title: "Valid Title",
      price: "5.00",
      externalUrl: "https://example.com/resource",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.title.valid).toBe(true);
  });

  it("rejects empty title", () => {
    const input: DryRunPublishInput = {
      title: "",
      price: "5.00",
      externalUrl: "https://example.com/resource",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.title.valid).toBe(false);
    expect(result.validation.title.error).toContain("non-empty");
  });

  it("rejects title > 256 characters", () => {
    const input: DryRunPublishInput = {
      title: "x".repeat(257),
      price: "5.00",
      externalUrl: "https://example.com/resource",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.title.valid).toBe(false);
    expect(result.validation.title.error).toContain("256");
  });

  it("validates price (decimal string, >= 0, max 2 decimals)", () => {
    const input: DryRunPublishInput = {
      title: "Title",
      price: "10.99",
      externalUrl: "https://example.com/resource",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.price.valid).toBe(true);
  });

  it("rejects invalid price (non-numeric)", () => {
    const input: DryRunPublishInput = {
      title: "Title",
      price: "not-a-price",
      externalUrl: "https://example.com/resource",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.price.valid).toBe(false);
    expect(result.validation.price.error).toContain("valid decimal");
  });

  it("rejects price with > 2 decimal places", () => {
    const input: DryRunPublishInput = {
      title: "Title",
      price: "5.999",
      externalUrl: "https://example.com/resource",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.price.valid).toBe(false);
    expect(result.validation.price.error).toContain("2 decimal");
  });

  it("rejects negative price", () => {
    const input: DryRunPublishInput = {
      title: "Title",
      price: "-5.00",
      externalUrl: "https://example.com/resource",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.price.valid).toBe(false);
  });

  it("validates URL (http/https only)", () => {
    const input: DryRunPublishInput = {
      title: "Title",
      price: "5.00",
      externalUrl: "https://example.com/data.json",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.externalUrl.valid).toBe(true);
  });

  it("rejects non-http URL", () => {
    const input: DryRunPublishInput = {
      title: "Title",
      price: "5.00",
      externalUrl: "ftp://example.com/data",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.externalUrl.valid).toBe(false);
    expect(result.validation.externalUrl.error).toContain("http");
  });

  it("rejects malformed URL", () => {
    const input: DryRunPublishInput = {
      title: "Title",
      price: "5.00",
      externalUrl: "not a url",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.validation.externalUrl.valid).toBe(false);
    expect(result.validation.externalUrl.error).toContain("Invalid");
  });
});

describe("dryRunPublish – result structure", () => {
  const baseUrl = "https://example.com";
  const network = "stellar:testnet";

  it("returns mode and operation in result", () => {
    const input: DryRunPublishInput = {
      title: "Test",
      price: "5.00",
      externalUrl: "https://example.com/data",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.mode).toBe("dry-run");
    expect(result.operation).toBe("publish");
  });

  it("includes network and endpoint in intentions", () => {
    const input: DryRunPublishInput = {
      title: "Test",
      price: "5.00",
      externalUrl: "https://example.com/data",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.intentions.network).toBe(network);
    expect(result.intentions.endpoint).toContain("POST");
    expect(result.intentions.endpoint).toContain("/resources");
  });

  it("shows required wallet state", () => {
    const input: DryRunPublishInput = {
      title: "Test",
      price: "5.00",
      externalUrl: "https://example.com/data",
    };
    const result = dryRunPublish(input, network, baseUrl, false, false);
    expect(result.intentions.requiredWalletState.wallet).toBe(false);
    expect(result.intentions.requiredWalletState.publisherApiKey).toBe(false);
  });

  it("includes ordered step-by-step operations", () => {
    const input: DryRunPublishInput = {
      title: "Test",
      price: "5.00",
      externalUrl: "https://example.com/data",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.steps).toContain("1. Create resource record via POST /resources");
    expect(result.steps).toContain("2. Sign x402 payment for verification (~0.10 USDC)");
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("shows steps only when validation succeeds", () => {
    const input: DryRunPublishInput = {
      title: "",
      price: "invalid",
      externalUrl: "not-a-url",
    };
    const result = dryRunPublish(input, network, baseUrl, true, true);
    expect(result.steps).toContain("Validation failed; see errors above");
  });
});

describe("dryRunBuy – input validation", () => {
  const baseUrl = "https://example.com";
  const network = "stellar:testnet";

  it("validates resource ID (alphanumeric + dash/dot/underscore)", () => {
    const result = dryRunBuy("res-001", network, baseUrl, true);
    expect(result.validation.resourceId.valid).toBe(true);
  });

  it("rejects empty resource ID", () => {
    const result = dryRunBuy("", network, baseUrl, true);
    expect(result.validation.resourceId.valid).toBe(false);
  });

  it("rejects resource ID with invalid characters", () => {
    const result = dryRunBuy("res@001", network, baseUrl, true);
    expect(result.validation.resourceId.valid).toBe(false);
    expect(result.validation.resourceId.error).toContain("only letters");
  });

  it("accepts dots and underscores in resource ID", () => {
    const result = dryRunBuy("res.001_v2", network, baseUrl, true);
    expect(result.validation.resourceId.valid).toBe(true);
  });
});

describe("dryRunBuy – result structure", () => {
  const baseUrl = "https://example.com";
  const network = "stellar:testnet";

  it("returns mode and operation in result", () => {
    const result = dryRunBuy("res-001", network, baseUrl, true);
    expect(result.mode).toBe("dry-run");
    expect(result.operation).toBe("buy");
  });

  it("includes resource ID, network, and endpoint", () => {
    const result = dryRunBuy("res-001", network, baseUrl, true);
    expect(result.resourceId).toBe("res-001");
    expect(result.intentions.network).toBe(network);
    expect(result.intentions.endpoint).toContain("GET");
    expect(result.intentions.endpoint).toContain("/resources/res-001");
  });

  it("shows required wallet state", () => {
    const result = dryRunBuy("res-001", network, baseUrl, false);
    expect(result.intentions.requiredWalletState.wallet).toBe(false);
  });

  it("includes payment steps", () => {
    const result = dryRunBuy("res-001", network, baseUrl, true);
    expect(result.steps).toContain("1. Fetch resource metadata to confirm price");
    expect(result.steps).toContain("2. Verify wallet has sufficient USDC balance");
    expect(result.steps).toContain("3. Create x402 payment authorization (sign payment tx)");
  });
});

describe("dryRunOnchain – input validation", () => {
  const baseUrl = "https://example.com";
  const network = "stellar:testnet";

  it("validates resource ID for on-chain operations", () => {
    const result = dryRunOnchain("register-onchain", "res-001", network, baseUrl, true, true);
    expect(result.validation.resourceId.valid).toBe(true);
  });

  it("rejects invalid resource ID", () => {
    const result = dryRunOnchain("register-onchain", "res@invalid", network, baseUrl, true, true);
    expect(result.validation.resourceId.valid).toBe(false);
  });
});

describe("dryRunOnchain – result structure", () => {
  const baseUrl = "https://example.com";
  const network = "stellar:testnet";

  it("shows operation-specific action text", () => {
    const operations = [
      "register-onchain" as const,
      "update-metadata" as const,
      "set-price" as const,
      "transfer-ownership" as const,
      "set-listed" as const,
    ];

    for (const op of operations) {
      const result = dryRunOnchain(op, "res-001", network, baseUrl, true, true);
      expect(result.operation).toBe(op);
      expect(result.intentions.action).toBeDefined();
      expect(result.intentions.action.length).toBeGreaterThan(0);
    }
  });

  it("includes Soroban contract details", () => {
    const result = dryRunOnchain("register-onchain", "res-001", network, baseUrl, true, true);
    expect(result.intentions.endpoint).toContain("Soroban");
    expect(result.intentions.endpoint).toContain("contract");
  });

  it("shows on-chain transaction steps", () => {
    const result = dryRunOnchain("register-onchain", "res-001", network, baseUrl, true, true);
    expect(result.steps).toContain(
      "1. Fetch resource details (confirm resource exists and you own it)",
    );
    expect(result.steps).toContain("2. Prepare unsigned Soroban transaction via server");
    expect(result.steps).toContain(
      "3. Sign transaction with agent wallet (private key held locally)",
    );
    expect(result.steps).toContain("4. Submit signed transaction via Soroban RPC");
  });
});

describe("dryRunPublish – live fee and balance (new fields)", () => {
  const baseUrl = "https://example.com";
  const network = "stellar:testnet";
  const input: DryRunPublishInput = {
    title: "Test Resource",
    price: "5.00",
    externalUrl: "https://example.com/data",
  };

  it("uses DEFAULT_VERIFICATION_FEE when no live fee provided", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {});
    expect(result.intentions.estimatedVerificationFee).toBe("~0.10");
    expect(result.intentions.verificationFeeSource).toBe("default");
  });

  it("uses live fee from /agent/status when provided", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {
      verificationFee: 0.01,
    });
    expect(result.intentions.estimatedVerificationFee).toBe("0.01");
    expect(result.intentions.verificationFeeSource).toBe("live");
    expect(result.intentions.verificationEndpoint).toContain("/verify-content");
  });

  it("includes usdcBalance from live read when provided", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {
      usdcBalance: "100.50",
    });
    expect(result.intentions.requiredWalletState.usdcBalance).toBe("100.50");
  });

  it("coversVerificationFee is true when balance >= fee", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {
      verificationFee: 10,
      usdcBalance: "100.00",
    });
    expect(result.intentions.requiredWalletState.coversVerificationFee).toBe(true);
  });

  it("coversVerificationFee is false when balance < fee", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {
      verificationFee: 100,
      usdcBalance: "10.00",
    });
    expect(result.intentions.requiredWalletState.coversVerificationFee).toBe(false);
  });

  it("coversVerificationFee is null when no live fee or no balance", () => {
    const r1 = dryRunPublish(input, network, baseUrl, true, true, { usdcBalance: "10.00" });
    expect(r1.intentions.requiredWalletState.coversVerificationFee).toBeNull();

    const r2 = dryRunPublish(input, network, baseUrl, true, true, { verificationFee: 10 });
    expect(r2.intentions.requiredWalletState.coversVerificationFee).toBeNull();

    const r3 = dryRunPublish(input, network, baseUrl, true, true, {});
    expect(r3.intentions.requiredWalletState.coversVerificationFee).toBeNull();
  });

  it("includes warnings when live read failed", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {
      readError: "connection refused",
    });
    expect(result.warnings).toContain(
      "Live fee and balance could not be read: connection refused. Fee shown is the default, not a quote.",
    );
  });

  it("includes warning when fee was not returned by /agent/status", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, { usdcBalance: "100.00" });
    expect(result.warnings).toContain(
      "Verification fee was not returned by /agent/status; the default is shown, not a quote.",
    );
  });

  it("includes warning when balance does not cover fee", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {
      verificationFee: 100,
      usdcBalance: "10.00",
    });
    expect(result.warnings).toContain(
      "Wallet holds 10.00 USDC, which does not cover the 100 USDC verification fee. Publish will create the resource but stop before verification.",
    );
  });

  it("includes warning when balance was read but fee was not", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, { usdcBalance: "100.00" });
    expect(result.warnings).toContain(
      "Balance was read but the fee was not, so affordability could not be determined. Check with mindvault_agent_status.",
    );
  });

  it("includes warning when no publisher API key", () => {
    const result = dryRunPublish(input, network, baseUrl, true, false, {});
    expect(result.warnings).toContain(
      "No publisher API key in the active profile; run mindvault_register first.",
    );
  });

  it("warnings array is present and can be empty", () => {
    const result = dryRunPublish(input, network, baseUrl, true, true, {
      verificationFee: 0.01,
      usdcBalance: "100.00",
    });
    expect(Array.isArray(result.warnings)).toBe(true);
    // With live fee, balance, and api key, no warnings
    const feeWarning = result.warnings.find((w) => w.includes("fee"));
    expect(feeWarning).toBeUndefined();
  });
});
