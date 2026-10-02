/**
 * Typed wrapper for MindVault API responses.
 *
 * `jsonFetch` returns `ApiResponse<any>` for backwards compatibility with
 * existing callers that access `data` directly. Callers that want compile-time
 * narrowing can narrow with `isApiOk()` or `unwrapOk()` to get `ApiOk<T>`.
 */

/** A successful API response with a known payload shape. */
export interface ApiOk<T> {
  readonly ok: true;
  readonly status: number;
  readonly data: T;
  readonly headers: Record<string, string>;
}

/** A non-ok API response whose body shape is not guaranteed. */
export interface ApiErr {
  readonly ok: false;
  readonly status: number;
  readonly data: unknown;
  readonly headers: Record<string, string>;
}

/** Discriminated union over the `ok` field — the central API response type. */
export type ApiResponse<T> = ApiOk<T> | ApiErr;

/** Type guard: true when the response carried an ok status. */
export function isApiOk<T>(res: ApiResponse<T>): res is ApiOk<T> {
  return res.ok;
}

/**
 * Unwrap a successful response or throw a plain Error with the status.
 *
 * Use this after a call when you expect the response to always be ok and want
 * to surface failures as exceptions rather than branching.
 */
export function unwrapOk<T>(res: ApiResponse<T>): T {
  if (res.ok) return res.data;
  throw new Error(`API request failed with status ${res.status}`);
}

/**
 * Map a non-ok response into the shape expected by `throwHttpError` /
 * `mapHttpError` from errorMapping.ts.
 *
 * ```ts
 * if (!res.ok) throwHttpError(mapApiError(res, "Publish failed", "api"));
 * ```
 */
export function mapApiError(
  res: ApiErr,
  operation: string,
  source: "api" | "x402" | "horizon" | "soroban" | "registry" | "sponsored",
): { operation: string; source: typeof source; status: number; data: unknown } {
  return { operation, source, status: res.status, data: res.data };
}
