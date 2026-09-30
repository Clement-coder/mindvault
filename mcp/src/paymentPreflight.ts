/**
 * Payment preflight estimator for the MindVault MCP server.
 *
 * Before an agent signs a buy or verification payment, this estimates whether
 * the selected wallet is actually ready: it compares the wallet's USDC balance
 * against the expected amount, checks the native XLM balance against the reserve
 * and fee buffer a Stellar account needs, and states the likely payment path.
 * The computation is pure (all inputs passed in) so it is deterministic and
 * unit-testable; index.ts gathers the live balances and price and calls in.
 */

/** Recommended minimum native XLM to cover the base reserve plus transaction fees. */
export const MIN_NATIVE_XLM = 0.5;

/** Minimum USDC balance required before a paid tool call is allowed. */
export const MIN_USDC_BALANCE = 0;

export type PreflightOperation = "buy" | "verification";

export interface PaymentPreflightInput {
  operation: PreflightOperation;
  /** Active wallet address, or null when no wallet is configured. */
  walletPublicKey: string | null;
  /** USDC balance as a decimal string (e.g. "12.5"). */
  usdcBalance: string;
  /** Native XLM balance as a decimal string. */
  nativeBalance: string;
  /** Expected payment amount in USDC, or null when it could not be determined. */
  expectedAmount: string | number | null;
  /** x402 network id the payment will be signed for (e.g. "stellar:testnet"). */
  network: string;
  /** Human label for what is being paid for (resource title, "content verification"). */
  label?: string;
}

export interface PaymentPreflightResult {
  operation: PreflightOperation;
  network: string;
  paymentPath: string;
  wallet: string | null;
  label: string | null;
  expectedAmount: string | null;
  usdcBalance: string;
  nativeXlmBalance: string;
  /** True when the wallet appears able to complete the payment. */
  ready: boolean;
  warnings: string[];
  summary: string;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Trim trailing zeros from a fixed-precision amount for readable output. */
function trimAmount(n: number): string {
  return n.toFixed(7).replace(/\.?0+$/, "");
}

/**
 * Estimate readiness for a payment. Never throws — every missing or malformed
 * input becomes a warning so the report is always safe to surface to an agent.
 */
export function buildPaymentPreflight(input: PaymentPreflightInput): PaymentPreflightResult {
  const warnings: string[] = [];
  let ready = true;

  if (!input.walletPublicKey) {
    warnings.push("No wallet configured. Run mindvault_setup_wallet before paying.");
    ready = false;
  }

  const expected = toNumber(input.expectedAmount);
  const usdc = toNumber(input.usdcBalance) ?? 0;
  const native = toNumber(input.nativeBalance) ?? 0;

  if (expected === null) {
    warnings.push(
      "Expected amount could not be determined (resource price or verification fee unavailable). " +
        "Readiness for the USDC amount is unconfirmed.",
    );
    ready = false;
  } else if (usdc < expected) {
    warnings.push(
      `Insufficient USDC: need ${trimAmount(expected)}, have ${trimAmount(usdc)} ` +
        `(shortfall ${trimAmount(expected - usdc)}). Fund the wallet and retry.`,
    );
    ready = false;
  }

  if (native <= 0) {
    warnings.push(
      "Native XLM balance is zero — the account may be unfunded and cannot pay transaction fees " +
        "or meet the base reserve.",
    );
    ready = false;
  } else if (native < MIN_NATIVE_XLM) {
    warnings.push(
      `Low native XLM (${trimAmount(native)}); at least ${MIN_NATIVE_XLM} recommended for the ` +
        "base reserve and transaction fees.",
    );
    ready = false;
  }

  const summary = ready
    ? `Ready to ${input.operation}: wallet has ${trimAmount(usdc)} USDC for the ` +
      `${expected !== null ? trimAmount(expected) : "?"} USDC payment, plus XLM for fees.`
    : `Not ready to ${input.operation}. See warnings.`;

  return {
    operation: input.operation,
    network: input.network,
    paymentPath: `x402 exact payment in USDC on ${input.network}`,
    wallet: input.walletPublicKey,
    label: input.label ?? null,
    expectedAmount: expected !== null ? trimAmount(expected) : null,
    usdcBalance: trimAmount(usdc),
    nativeXlmBalance: trimAmount(native),
    ready,
    warnings,
    summary,
  };
}

/**
 * Guard that blocks a paid tool call when the wallet balance is below the
 * required minimum. Returns null when the balance is sufficient, or an
 * actionable error message describing the shortfall and how to resolve it.
 *
 * This is a pure function — all inputs are passed in — so it is deterministic
 * and unit-testable without network access.
 */
export function assertMinimumBalance(input: {
  usdcBalance: string;
  nativeBalance: string;
  operation: string;
  requiredUsdc?: string;
}): string | null {
  const usdc = parseFloat(input.usdcBalance) || 0;
  const native = parseFloat(input.nativeBalance) || 0;
  const required = input.requiredUsdc ? parseFloat(input.requiredUsdc) || 0 : 0;

  if (native < MIN_NATIVE_XLM) {
    return [
      `Insufficient native XLM to ${input.operation}.`,
      `Current XLM balance: ${trimAmount(native)}`,
      `Required minimum: ${MIN_NATIVE_XLM} XLM (base reserve + fees)`,
      `Fund the wallet with at least ${(MIN_NATIVE_XLM - native).toFixed(1)} XLM and retry.`,
    ].join("\n");
  }

  if (usdc < MIN_USDC_BALANCE) {
    return [
      `Insufficient USDC to ${input.operation}.`,
      `Current USDC balance: ${trimAmount(usdc)}`,
      `Required minimum: ${MIN_USDC_BALANCE} USDC`,
      `Fund the wallet with USDC and retry.`,
    ].join("\n");
  }

  if (required > 0 && usdc < required) {
    return [
      `Insufficient USDC to ${input.operation}.`,
      `Amount needed: ${trimAmount(required)} USDC`,
      `Current balance: ${trimAmount(usdc)} USDC`,
      `Shortfall: ${trimAmount(required - usdc)} USDC`,
      `Fund the wallet with the shortfall and retry.`,
    ].join("\n");
  }

  return null;
}
