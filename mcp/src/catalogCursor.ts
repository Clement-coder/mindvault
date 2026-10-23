import type { CatalogCacheContext } from "./catalogCache.js";
import type { CatalogFilters } from "./catalogFilters.js";

export interface CatalogCursorPayload {
  version: 1;
  offset: number;
  fingerprint: string;
  context: CatalogCacheContext;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function catalogFilterFingerprint(filters: CatalogFilters): string {
  const { cursor: _cursor, bypassCache: _bypassCache, offset: _offset, ...rest } = filters;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export function createCatalogCursor(
  offset: number,
  filters: CatalogFilters,
  context: CatalogCacheContext,
): string {
  return encode({
    version: 1,
    offset,
    fingerprint: catalogFilterFingerprint(filters),
    context,
  } satisfies CatalogCursorPayload);
}

export function resolveCatalogCursor(
  cursor: string,
  filters: CatalogFilters,
  context: CatalogCacheContext,
): { ok: true; offset: number } | { ok: false; error: string } {
  try {
    const payload = decode(cursor) as Partial<CatalogCursorPayload>;
    const offset = payload.offset;
    if (
      payload.version !== 1 ||
      !Number.isInteger(offset) ||
      offset === undefined ||
      offset < 0 ||
      payload.fingerprint !== catalogFilterFingerprint(filters) ||
      JSON.stringify(payload.context) !== JSON.stringify(context)
    ) {
      return {
        ok: false,
        error:
          "Invalid or stale catalog cursor. Start a new browse or search for the active profile and filters.",
      };
    }
    return { ok: true, offset: offset as number };
  } catch {
    return {
      ok: false,
      error:
        "Invalid catalog cursor. Start a new browse or search for the active profile and filters.",
    };
  }
}
