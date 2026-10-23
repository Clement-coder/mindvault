/**
 * Guardrail for automatic x402 payments.
 *
 * Prices are converted to Stellar's 7-decimal stroop precision before
 * comparison so a ceiling never depends on floating-point rounding.
 */

import { usdcToStroops } from "./usdcAmount.js";

export const DEFAULT_MAX_AUTO_PAY_USDC = "10";
export const DEFAULT_MAX_AUTO_FEE_STROOPS = "100000";

/**
 * Amounts are compared in stroops through the shared converter (#838) rather
 * than a local copy of the 10^7 factor, so a ceiling and the price it guards
 * can never be measured on two different scales.
 */
const toStroops = (value: string): bigint | null => usdcToStroops(value);

function configuredCeiling(env: NodeJS.ProcessEnv): { value: string; stroops: bigint } {
  const value = env.MINDVAULT_MAX_AUTO_PAY_USDC ?? DEFAULT_MAX_AUTO_PAY_USDC;
  const stroops = toStroops(value);
  if (stroops === null) {
    throw new Error(
      "MINDVAULT_MAX_AUTO_PAY_USDC must be a non-negative USDC decimal with at most 7 decimal places.",
    );
  }
  return { value, stroops };
}

/** Where the automatic payment ceiling came from. */
export type PaymentCeilingSource = "MINDVAULT_MAX_AUTO_PAY_USDC" | "default";

/** The configured automatic payment ceiling, for read-only summaries (#1052). */
export interface PaymentCeilingReading {
  /** The ceiling as configured, in decimal USDC. */
  amount: string;
  /** The same ceiling in stroops, for exact comparisons. */
  stroops: bigint;
  /** `MINDVAULT_MAX_AUTO_PAY_USDC` when set, otherwise the built-in default. */
  source: PaymentCeilingSource;
  /** True when the value came from the environment rather than the default. */
  configured: boolean;
}

/**
 * Read the same ceiling `assertAutoPaymentWithinCeiling` enforces, without
 * changing any payment behaviour. A malformed value throws the same
 * deterministic error the guard would raise, so a summary can never report a
 * ceiling the guard would not use.
 */
export function readPaymentCeiling(env: NodeJS.ProcessEnv = process.env): PaymentCeilingReading {
  const ceiling = configuredCeiling(env);
  const configured = env.MINDVAULT_MAX_AUTO_PAY_USDC !== undefined;
  return {
    amount: ceiling.value,
    stroops: ceiling.stroops,
    source: configured ? "MINDVAULT_MAX_AUTO_PAY_USDC" : "default",
    configured,
  };
}

/**
 * Prevent an automatic x402 payment above the configured ceiling unless the
 * caller explicitly authorizes a limit that covers the advertised price.
 */
export function assertAutoPaymentWithinCeiling(input: {
  price: unknown;
  maxAutoPayUsdc?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const requiredAmount = typeof input.price === "string" ? input.price : String(input.price ?? "");
  const requiredStroops = toStroops(requiredAmount);
  if (requiredStroops === null) {
    throw new Error(
      "Automatic payment blocked because the resource price is missing or invalid; no x402 payment was submitted.",
    );
  }

  const ceiling = configuredCeiling(input.env ?? process.env);
  if (requiredStroops <= ceiling.stroops) return;

  const overrideStroops =
    input.maxAutoPayUsdc === undefined ? null : toStroops(input.maxAutoPayUsdc);
  if (input.maxAutoPayUsdc !== undefined && overrideStroops === null) {
    throw new Error(
      "maxAutoPayUsdc must be a non-negative USDC decimal with at most 7 decimal places.",
    );
  }
  if (overrideStroops !== null && overrideStroops >= requiredStroops) return;

  throw new Error(
    `Purchase requires ${requiredAmount} USDC, which exceeds the automatic payment ceiling of ${ceiling.value} USDC. ` +
      `To authorize this purchase, call mindvault_buy with maxAutoPayUsdc: "${requiredAmount}" (or a higher amount).`,
  );
}

/**
 * Thrown when the price in the x402 `PAYMENT-REQUIRED` challenge differs from
 * the preview price and the new amount exceeds the ceiling.
 *
 * The buy() flow must catch this before the x402 client signs, return a
 * structured confirmation-needed message to the agent, and never submit the
 * payment.
 */
export class PriceChangedCeilingError extends Error {
  readonly name = "PriceChangedCeilingError";
  readonly previewPrice: string;
  readonly actualPrice: string;
  readonly ceiling: string;

  constructor(previewPrice: string, actualPrice: string, ceiling: string) {
    super(
      `The server's price changed from ${previewPrice} USDC to ${actualPrice} USDC after the preview, ` +
        `which exceeds the automatic payment ceiling of ${ceiling} USDC. ` +
        `To authorize the updated price, call mindvault_buy with maxAutoPayUsdc: "${actualPrice}" (or higher).`,
    );
    this.previewPrice = previewPrice;
    this.actualPrice = actualPrice;
    this.ceiling = ceiling;
  }
}

/**
 * Extract the USDC price from an x402 `PAYMENT-REQUIRED` response header.
 *
 * The header is a base64-encoded JSON object. The x402 spec places the amount
 * inside `schemes[0].details.maxAmountRequired` (stroops as a string) or
 * at the top-level `price` field (USDC decimal). We try both and convert
 * stroops to USDC when necessary.
 *
 * Returns `null` when the header is absent or unparseable — the caller should
 * treat that as "cannot verify; skip the extra check".
 */
export function parsePriceFromPaymentRequired(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue) return null;
  try {
    const raw = Buffer.from(headerValue, "base64").toString("utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Try top-level `price` first (USDC decimal)
    if (typeof parsed.price === "string" && parsed.price.length > 0) {
      return parsed.price;
    }
    if (typeof parsed.price === "number") {
      return String(parsed.price);
    }

    // Dig into schemes[0].details for maxAmountRequired (stroops as string)
    const schemes = parsed.schemes;
    if (Array.isArray(schemes) && schemes.length > 0) {
      const details = (schemes[0] as Record<string, unknown>)?.details as
        | Record<string, unknown>
        | undefined;
      if (details) {
        const raw = details.maxAmountRequired ?? details.amount;
        if (typeof raw === "string" || typeof raw === "number") {
          // Stroops: divide by 10^7 to get USDC
          const stroops = BigInt(String(raw));
          const whole = stroops / 10_000_000n;
          const frac = stroops % 10_000_000n;
          const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
          return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate the x402 challenge price against the auto-pay ceiling. Called when
 * the server returns a 402 — i.e. the *actual* price being charged — so a
 * price change between preview and payment is caught before signing.
 *
 * Throws `PriceChangedCeilingError` when the actual price exceeds the ceiling
 * and was not covered by an explicit `maxAutoPayUsdc` override.
 *
 * No-op when the challenge price cannot be parsed (the x402 client proceeds
 * with whatever price the server declared; the facilitator will reject a
 * mis-signed entry anyway).
 */
export function assertChallengePriceWithinCeiling(input: {
  headerValue: string | null | undefined;
  previewPrice: string;
  maxAutoPayUsdc?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const actualPrice = parsePriceFromPaymentRequired(input.headerValue);
  if (actualPrice === null) return; // unparseable — skip extra check

  // Re-run the standard ceiling check against the challenge price.
  // If it passes (price unchanged or within ceiling), we're done.
  try {
    assertAutoPaymentWithinCeiling({
      price: actualPrice,
      maxAutoPayUsdc: input.maxAutoPayUsdc,
      env: input.env,
    });
  } catch {
    // The challenge price exceeds the ceiling. Build a richer error.
    const ceiling = configuredCeiling(input.env ?? process.env);
    throw new PriceChangedCeilingError(input.previewPrice, actualPrice, ceiling.value);
  }
}

/** Bound sponsored Stellar transaction fees for registry mutations. */
export function assertTransactionFeeWithinCeiling(input: {
  feeStroops: string | number | bigint;
  env?: NodeJS.ProcessEnv;
}): void {
  const raw =
    input.env?.MINDVAULT_MAX_AUTO_FEE_STROOPS ??
    process.env.MINDVAULT_MAX_AUTO_FEE_STROOPS ??
    DEFAULT_MAX_AUTO_FEE_STROOPS;
  if (!/^\d+$/.test(raw))
    throw new Error("MINDVAULT_MAX_AUTO_FEE_STROOPS must be a non-negative integer.");
  const fee = BigInt(String(input.feeStroops));
  const ceiling = BigInt(raw);
  if (fee > ceiling) {
    throw new Error(
      `On-chain mutation fee ${fee} stroops exceeds the automatic fee ceiling of ${ceiling} stroops.`,
    );
  }
}
