/**
 * Offline read-only cache for catalog tools (#556).
 *
 * `browse`, `search`, and `preview` normally depend on the MindVault catalog
 * API. When that service is unreachable (a transport-level failure — DNS,
 * refused connection, or timeout), these tools fall back to the last snapshot
 * captured from a successful read, clearly labelled with the age of the
 * snapshot. Mutating and payment tools never consult this cache.
 *
 * The cache is held in memory for the lifetime of the MCP server process — the
 * same scope as the profile state — so it is available for later offline calls
 * without persisting data to disk. There is deliberately no filesystem use:
 * that keeps the failure "no cache present" deterministic and independent of
 * anything left behind by an earlier run.
 */

export interface CatalogSnapshot {
  resources: unknown[];
  savedAtMs: number;
}

export interface PreviewSnapshot {
  meta: unknown;
  savedAtMs: number;
}

/**
 * Default age at which a snapshot is labelled "stale" rather than "fresh".
 *
 * Kept as the default for the configurable TTL added in #573; existing
 * importers keep the constant they had.
 */
export const CATALOG_CACHE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Environment variables controlling cache lifetime (#573). */
export const CATALOG_CACHE_ENV_VARS = {
  /** Age at which a snapshot starts being served with a staleness warning. */
  ttlMs: "MINDVAULT_CATALOG_CACHE_TTL_MS",
  /** Age past which a snapshot is not served at all. 0 disables the limit. */
  maxAgeMs: "MINDVAULT_CATALOG_CACHE_MAX_AGE_MS",
} as const;

/**
 * How long a snapshot stays useful.
 *
 * Two limits rather than one, because "stale" and "useless" are different
 * questions. Past `ttlMs` a snapshot is still served — offline, a day-old
 * catalog beats no catalog — but carries a warning. Past `maxAgeMs` it is
 * withheld entirely, which is what an operator wants when acting on outdated
 * pricing is worse than failing.
 *
 * `maxAgeMs` of 0 means "never withhold", preserving the behaviour before
 * #573: always serve, label when old.
 */
export interface CatalogCacheConfig {
  ttlMs: number;
  maxAgeMs: number;
}

export const DEFAULT_CATALOG_CACHE_CONFIG: CatalogCacheConfig = {
  ttlMs: CATALOG_CACHE_STALE_AFTER_MS,
  maxAgeMs: 0,
};

/**
 * Parse one duration from the environment.
 *
 * A malformed or negative value falls back to the default rather than failing
 * startup: an offline cache is a resilience feature, and a typo in its tuning
 * must not stop the server from serving.
 */
function parseDuration(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/** Resolve the cache lifetime from the environment. */
export function resolveCatalogCacheConfig(
  env: NodeJS.ProcessEnv = process.env,
): CatalogCacheConfig {
  const ttlMs = parseDuration(
    env[CATALOG_CACHE_ENV_VARS.ttlMs],
    DEFAULT_CATALOG_CACHE_CONFIG.ttlMs,
  );
  const maxAgeMs = parseDuration(
    env[CATALOG_CACHE_ENV_VARS.maxAgeMs],
    DEFAULT_CATALOG_CACHE_CONFIG.maxAgeMs,
  );

  // A max age below the staleness threshold would mean a snapshot is withheld
  // before it is ever labelled stale, making ttlMs unreachable. Honour the
  // stricter intent by pulling ttl down rather than silently ignoring one.
  return maxAgeMs > 0 && maxAgeMs < ttlMs ? { ttlMs: maxAgeMs, maxAgeMs } : { ttlMs, maxAgeMs };
}

let config: CatalogCacheConfig = { ...DEFAULT_CATALOG_CACHE_CONFIG };
let catalog: CatalogSnapshot | null = null;
let previews: Record<string, PreviewSnapshot> = {};

/** Apply a cache lifetime. Called once at startup from the environment. */
export function configureCatalogCache(next: CatalogCacheConfig): void {
  config = { ...next };
}

/** Load the lifetime from the environment. */
export function initCatalogCache(env: NodeJS.ProcessEnv = process.env): CatalogCacheConfig {
  configureCatalogCache(resolveCatalogCacheConfig(env));
  return getCatalogCacheConfig();
}

/** The active cache lifetime. */
export function getCatalogCacheConfig(): CatalogCacheConfig {
  return { ...config };
}

/** Whether a snapshot taken at `savedAtMs` is too old to serve at all. */
export function isExpired(savedAtMs: number, nowMs: number = Date.now()): boolean {
  if (config.maxAgeMs <= 0) return false;
  return nowMs - savedAtMs > config.maxAgeMs;
}

/** Whether a snapshot is past its TTL and should carry a staleness warning. */
export function isStale(savedAtMs: number, nowMs: number = Date.now()): boolean {
  return Math.max(0, nowMs - savedAtMs) > config.ttlMs;
}

/** Record a successful catalog read. The raw resource array is snapshotted. */
export function recordCatalogSnapshot(resources: unknown[]): void {
  catalog = { resources, savedAtMs: Date.now() };
}

/**
 * The latest catalog snapshot, or null when none has ever been captured — or
 * when the one held is past `maxAgeMs` (#573).
 *
 * An expired snapshot is dropped rather than merely hidden, so the memory is
 * released and a later call cannot resurrect it.
 */
export function getCatalogSnapshot(nowMs: number = Date.now()): CatalogSnapshot | null {
  if (!catalog) return null;
  if (isExpired(catalog.savedAtMs, nowMs)) {
    catalog = null;
    return null;
  }
  return { savedAtMs: catalog.savedAtMs, resources: [...catalog.resources] };
}

/** Record a successful preview read for a resource id. */
export function recordPreviewSnapshot(resourceId: string, meta: unknown): void {
  previews[resourceId] = { meta, savedAtMs: Date.now() };
}

/**
 * The latest preview snapshot for a resource id, or null when absent or past
 * `maxAgeMs` (#573).
 */
export function getPreviewSnapshot(
  resourceId: string,
  nowMs: number = Date.now(),
): PreviewSnapshot | null {
  const snap = previews[resourceId];
  if (!snap) return null;
  if (isExpired(snap.savedAtMs, nowMs)) {
    delete previews[resourceId];
    return null;
  }
  return { meta: snap.meta, savedAtMs: snap.savedAtMs };
}

function describeAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.round(hours / 24);
  return `${days} day`;
}

/**
 * Why the live catalog could not be read, so the snapshot label can say so.
 *
 * "Unreachable" and "the API answered HTTP 503" are different facts, and an
 * operator reading a tool transcript needs the real one: the first points at
 * the network, the second at the service. The label used to assert the first
 * for both (#837).
 */
export type CatalogFallbackReason = { kind: "unreachable" } | { kind: "status"; status: number };

/** Render the cause clause used in the snapshot label. */
function describeReason(reason: CatalogFallbackReason | undefined): string {
  if (reason?.kind === "status") return `catalog API returned HTTP ${reason.status}`;
  return "catalog API unreachable";
}

/**
 * Agent-facing label describing the served snapshot, its age, and why the live
 * read failed. "Fresh" snapshots are served normally; "stale" ones carry a
 * warning to re-check on-chain when freshness matters, mirroring the
 * cacheStaleness guidance.
 */
export function catalogCacheLabel(
  savedAtMs: number,
  nowMs: number = Date.now(),
  reason?: CatalogFallbackReason,
): string {
  const ageMs = Math.max(0, nowMs - savedAtMs);
  const age = describeAge(ageMs);
  if (ageMs <= config.ttlMs) {
    return `Offline catalog snapshot served (cached ${age} ago) — ${describeReason(reason)}.`;
  }
  return (
    `⚠ Offline catalog snapshot served (cached ${age} ago) — ${describeReason(reason)}; ` +
    `stale, results may be outdated. ` +
    `Confirm a specific resource on-chain with mindvault_registry_lookup when freshness matters.`
  );
}

/**
 * Test-only: clear the in-memory snapshots so the "no cache" path is testable.
 * Also restores the default lifetime, so one test's TTL cannot leak into the
 * next.
 */
export function _clearCatalogCache(): void {
  catalog = null;
  previews = {};
  config = { ...DEFAULT_CATALOG_CACHE_CONFIG };
}
