/**
 * The single place USDC amounts change representation (#838).
 *
 * The server reads the same quantity in two incompatible encodings:
 *
 *   - **Horizon** returns a decimal string — `"1000.0000000"` means 1000 USDC.
 *   - **Soroban** returns an i128 in stroops — `10000000n` also means 1 USDC.
 *
 * They differ by 10^7 and neither carries a unit, so a value from one source
 * substituted for the other type-checks, formats, compares, and silently means
 * something ten million times off. The dangerous direction is quiet: a stroop
 * count read as decimal USDC reports a wallet as richly funded and waves an
 * unaffordable payment through.
 *
 * The conversion factor used to be written out in five places — twice in
 * `index.ts`, again in `tools/registry.ts` and `tools/publish.ts`, and once more
 * in `paymentCeiling.ts` and `receipts.ts` — each with its own parser and its
 * own idea of what a malformed value should do. Five copies of a constant is
 * five chances for the sixth caller to pick the wrong one.
 *
 * So conversion lives here, once, and every amount that crosses a service
 * boundary is tagged with the unit it arrived in:
 *
 *     normalizeUsdcBalance({ source: "horizon", balance: "12.5" })      // "12.5"
 *     normalizeUsdcBalance({ source: "soroban", stroops: 125000000n })  // "12.5"
 *
 * A second balance source — a Soroban SAC `balance()` read behind an RPC
 * failover, say — has to say which encoding it speaks to be read at all, so the
 * 10^7 mix-up cannot be introduced by adding one. There is no such fallback
 * today: `getBalanceDetails` reads Horizon only, and `rpcFailover` fans a
 * request across Soroban RPC endpoints, which all speak stroops.
 *
 * Pure: no I/O, no floating point. Every conversion runs through BigInt, so a
 * value never loses precision on the way through.
 */

/** Stellar's fixed precision: 7 decimal places, so 1 USDC = 10,000,000 stroops. */
export const STROOPS_PER_USDC = 10_000_000n;

/** Decimal places carried by a Stellar asset amount. */
export const USDC_DECIMALS = 7;

/** A non-negative decimal amount with at most 7 fractional digits. */
const USDC_DECIMAL_PATTERN = /^\d+(?:\.\d{1,7})?$/;

/** Same, allowing a leading minus — Horizon never sends one, a contract can. */
const SIGNED_DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,7})?$/;

/**
 * Render an integer stroop count as a decimal USDC string.
 *
 * Trailing zeros are kept, matching Horizon's own `"12.5000000"` formatting, so
 * amounts from either source compare as equal strings after normalization.
 */
export function stroopsToUsdc(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const fraction = abs % STROOPS_PER_USDC;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(USDC_DECIMALS, "0")}`;
}

/**
 * Parse a decimal USDC string into stroops, or null when it is not one.
 *
 * Null rather than a throw or a NaN: callers decide whether a malformed amount
 * is a validation error, a skipped row, or a refused payment, and none of them
 * should have to guess at a silent zero.
 */
export function usdcToStroops(
  value: string,
  options: { allowNegative?: boolean } = {},
): bigint | null {
  const text = value.trim();
  const pattern = options.allowNegative ? SIGNED_DECIMAL_PATTERN : USDC_DECIMAL_PATTERN;
  if (!pattern.test(text)) return null;

  const negative = text.startsWith("-");
  const [whole, fractional = ""] = (negative ? text.slice(1) : text).split(".");
  const stroops =
    BigInt(whole) * STROOPS_PER_USDC + BigInt(fractional.padEnd(USDC_DECIMALS, "0") || "0");
  return negative ? -stroops : stroops;
}

/** Whether a string is a well-formed non-negative USDC decimal amount. */
export function isUsdcDecimal(value: unknown): value is string {
  return typeof value === "string" && USDC_DECIMAL_PATTERN.test(value.trim());
}

/**
 * A USDC balance as the service that produced it encoded it.
 *
 * The tag is the point: a reader cannot consume a balance without stating which
 * encoding it is in, so the two can never be swapped by accident.
 */
export type UsdcBalanceReading =
  | { source: "horizon"; balance: string }
  | { source: "soroban"; stroops: bigint };

/**
 * Convert any tagged balance reading into one canonical decimal USDC string.
 *
 * Returns null when a Horizon reading is not a decimal amount — an empty
 * balance field, an error payload that reached this far — so a malformed
 * reading is never silently treated as zero funds.
 */
export function normalizeUsdcBalance(reading: UsdcBalanceReading): string | null {
  if (reading.source === "soroban") return stroopsToUsdc(reading.stroops);
  const stroops = usdcToStroops(reading.balance);
  return stroops === null ? null : stroopsToUsdc(stroops);
}

/**
 * Compare two USDC amounts exactly.
 *
 * Returns null when either side is unparseable, so a caller cannot mistake
 * "could not compare" for "not greater than" — the mistake that turns a failed
 * balance read into an approved payment. Negative when `a < b`, 0 when equal,
 * positive when `a > b`.
 */
export function compareUsdc(a: string, b: string): number | null {
  const left = usdcToStroops(a, { allowNegative: true });
  const right = usdcToStroops(b, { allowNegative: true });
  if (left === null || right === null) return null;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Sum decimal USDC amounts exactly, skipping values that are not amounts. */
export function sumUsdc(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) {
    const stroops = usdcToStroops(value);
    if (stroops !== null) total += stroops;
  }
  return stroopsToUsdc(total);
}

/** Drop trailing fractional zeros for display: `"12.5000000"` → `"12.5"`. */
export function trimUsdc(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
