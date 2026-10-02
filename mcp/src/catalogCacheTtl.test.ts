/**
 * Tests for the configurable catalog cache TTL (#573).
 *
 * Two limits with different jobs: past the TTL a snapshot is still served but
 * labelled stale, because offline a day-old catalog beats no catalog; past the
 * max age it is withheld entirely, for the operator who would rather fail than
 * act on outdated pricing.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  CATALOG_CACHE_ENV_VARS,
  CATALOG_CACHE_STALE_AFTER_MS,
  DEFAULT_CATALOG_CACHE_CONFIG,
  _clearCatalogCache,
  catalogCacheLabel,
  configureCatalogCache,
  getCatalogCacheConfig,
  getCatalogSnapshot,
  getPreviewSnapshot,
  initCatalogCache,
  isExpired,
  isStale,
  recordCatalogSnapshot,
  recordPreviewSnapshot,
  resolveCatalogCacheConfig,
} from "./catalogCache.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  _clearCatalogCache();
});

describe("resolveCatalogCacheConfig", () => {
  it("uses the documented defaults", () => {
    expect(resolveCatalogCacheConfig({})).toEqual(DEFAULT_CATALOG_CACHE_CONFIG);
  });

  it("defaults the TTL to the previous hard-coded threshold", () => {
    // #573 made this configurable; unconfigured behaviour must not change.
    expect(resolveCatalogCacheConfig({}).ttlMs).toBe(CATALOG_CACHE_STALE_AFTER_MS);
  });

  it("defaults to never withholding a snapshot", () => {
    expect(resolveCatalogCacheConfig({}).maxAgeMs).toBe(0);
  });

  it("reads the TTL", () => {
    const config = resolveCatalogCacheConfig({ [CATALOG_CACHE_ENV_VARS.ttlMs]: String(HOUR) });

    expect(config.ttlMs).toBe(HOUR);
  });

  it("reads the max age", () => {
    const config = resolveCatalogCacheConfig({
      [CATALOG_CACHE_ENV_VARS.maxAgeMs]: String(2 * DAY),
    });

    expect(config.maxAgeMs).toBe(2 * DAY);
  });

  it("accepts a TTL of zero, meaning always stale", () => {
    const config = resolveCatalogCacheConfig({ [CATALOG_CACHE_ENV_VARS.ttlMs]: "0" });

    expect(config.ttlMs).toBe(0);
  });

  it("truncates a fractional value", () => {
    expect(resolveCatalogCacheConfig({ [CATALOG_CACHE_ENV_VARS.ttlMs]: "1500.9" }).ttlMs).toBe(
      1500,
    );
  });

  it.each(["soon", "-1", "NaN", "1e", ""])("falls back to the default on %s", (raw) => {
    // An offline cache is a resilience feature; a typo in its tuning must not
    // stop the server from serving.
    expect(resolveCatalogCacheConfig({ [CATALOG_CACHE_ENV_VARS.ttlMs]: raw }).ttlMs).toBe(
      CATALOG_CACHE_STALE_AFTER_MS,
    );
  });

  it("pulls the TTL down when max age is stricter", () => {
    // A max age below the staleness threshold would make the TTL unreachable —
    // the snapshot would vanish before it was ever labelled stale.
    const config = resolveCatalogCacheConfig({
      [CATALOG_CACHE_ENV_VARS.ttlMs]: String(DAY),
      [CATALOG_CACHE_ENV_VARS.maxAgeMs]: String(HOUR),
    });

    expect(config).toEqual({ ttlMs: HOUR, maxAgeMs: HOUR });
  });

  it("leaves both alone when max age is the looser of the two", () => {
    const config = resolveCatalogCacheConfig({
      [CATALOG_CACHE_ENV_VARS.ttlMs]: String(HOUR),
      [CATALOG_CACHE_ENV_VARS.maxAgeMs]: String(DAY),
    });

    expect(config).toEqual({ ttlMs: HOUR, maxAgeMs: DAY });
  });
});

describe("initCatalogCache", () => {
  it("applies the environment and returns what it applied", () => {
    const applied = initCatalogCache({ [CATALOG_CACHE_ENV_VARS.ttlMs]: String(HOUR) });

    expect(applied.ttlMs).toBe(HOUR);
    expect(getCatalogCacheConfig().ttlMs).toBe(HOUR);
  });

  it("restores the defaults when the cache is cleared", () => {
    initCatalogCache({ [CATALOG_CACHE_ENV_VARS.ttlMs]: "1" });

    _clearCatalogCache();

    // One test's TTL must not leak into the next.
    expect(getCatalogCacheConfig()).toEqual(DEFAULT_CATALOG_CACHE_CONFIG);
  });

  it("returns a copy, so the caller cannot mutate the active config", () => {
    const config = getCatalogCacheConfig();
    config.ttlMs = 1;

    expect(getCatalogCacheConfig().ttlMs).not.toBe(1);
  });
});

describe("isStale", () => {
  it("is false for a fresh snapshot", () => {
    const now = Date.now();

    expect(isStale(now - HOUR, now)).toBe(false);
  });

  it("is true past the TTL", () => {
    const now = Date.now();

    expect(isStale(now - 2 * DAY, now)).toBe(true);
  });

  it("is false exactly at the TTL", () => {
    const now = Date.now();

    expect(isStale(now - CATALOG_CACHE_STALE_AFTER_MS, now)).toBe(false);
  });

  it("follows a configured TTL", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: 0 });
    const now = Date.now();

    expect(isStale(now - 2 * HOUR, now)).toBe(true);
    expect(isStale(now - HOUR / 2, now)).toBe(false);
  });

  it("treats everything as stale with a TTL of zero", () => {
    configureCatalogCache({ ttlMs: 0, maxAgeMs: 0 });
    const now = Date.now();

    expect(isStale(now - 1, now)).toBe(true);
  });
});

describe("isExpired", () => {
  it("is false by default, however old the snapshot", () => {
    const now = Date.now();

    expect(isExpired(now - 365 * DAY, now)).toBe(false);
  });

  it("is true past a configured max age", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: DAY });
    const now = Date.now();

    expect(isExpired(now - 2 * DAY, now)).toBe(true);
  });

  it("is false exactly at the max age", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: DAY });
    const now = Date.now();

    expect(isExpired(now - DAY, now)).toBe(false);
  });
});

describe("serving the catalog snapshot", () => {
  it("serves a fresh snapshot", () => {
    recordCatalogSnapshot([{ id: "a" }]);

    expect(getCatalogSnapshot()?.resources).toEqual([{ id: "a" }]);
  });

  it("still serves a stale snapshot", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: 0 });
    recordCatalogSnapshot([{ id: "a" }]);

    // Offline, a day-old catalog beats no catalog — it is labelled, not hidden.
    expect(getCatalogSnapshot(Date.now() + 2 * HOUR)).not.toBeNull();
  });

  it("withholds a snapshot past the max age", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: DAY });
    recordCatalogSnapshot([{ id: "a" }]);

    expect(getCatalogSnapshot(Date.now() + 2 * DAY)).toBeNull();
  });

  it("drops the expired snapshot rather than merely hiding it", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: DAY });
    recordCatalogSnapshot([{ id: "a" }]);
    getCatalogSnapshot(Date.now() + 2 * DAY);

    // A later call must not resurrect it, and the memory is released.
    expect(getCatalogSnapshot()).toBeNull();
  });

  it("serves a replacement recorded after an expiry", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: DAY });
    recordCatalogSnapshot([{ id: "old" }]);
    getCatalogSnapshot(Date.now() + 2 * DAY);

    recordCatalogSnapshot([{ id: "new" }]);

    expect(getCatalogSnapshot()?.resources).toEqual([{ id: "new" }]);
  });

  it("returns null when nothing was ever recorded", () => {
    expect(getCatalogSnapshot()).toBeNull();
  });
});

describe("serving preview snapshots", () => {
  it("serves a fresh preview", () => {
    recordPreviewSnapshot("res-1", { title: "A" });

    expect(getPreviewSnapshot("res-1")?.meta).toEqual({ title: "A" });
  });

  it("withholds a preview past the max age", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: DAY });
    recordPreviewSnapshot("res-1", { title: "A" });

    expect(getPreviewSnapshot("res-1", Date.now() + 2 * DAY)).toBeNull();
  });

  it("expires previews independently", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: DAY });
    const now = Date.now();
    recordPreviewSnapshot("old", { title: "old" });

    getPreviewSnapshot("old", now + 2 * DAY);
    recordPreviewSnapshot("new", { title: "new" });

    expect(getPreviewSnapshot("old")).toBeNull();
    expect(getPreviewSnapshot("new")).not.toBeNull();
  });

  it("returns null for an unknown resource", () => {
    expect(getPreviewSnapshot("nope")).toBeNull();
  });
});

describe("catalogCacheLabel", () => {
  it("labels a fresh snapshot without a warning", () => {
    const now = Date.now();

    const label = catalogCacheLabel(now - HOUR, now);

    expect(label).not.toContain("⚠");
    expect(label).toContain("Offline catalog snapshot served");
  });

  it("warns past the TTL", () => {
    const now = Date.now();

    expect(catalogCacheLabel(now - 2 * DAY, now)).toContain("⚠");
  });

  it("follows a configured TTL", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: 0 });
    const now = Date.now();

    // The same age is fresh by default and stale under a one-hour TTL.
    expect(catalogCacheLabel(now - 2 * HOUR, now)).toContain("⚠");
  });

  it("does not warn below a raised TTL", () => {
    configureCatalogCache({ ttlMs: 7 * DAY, maxAgeMs: 0 });
    const now = Date.now();

    expect(catalogCacheLabel(now - 2 * DAY, now)).not.toContain("⚠");
  });

  it("still reports the age when stale", () => {
    configureCatalogCache({ ttlMs: HOUR, maxAgeMs: 0 });
    const now = Date.now();

    expect(catalogCacheLabel(now - 3 * HOUR, now)).toContain("3 hr");
  });
});
