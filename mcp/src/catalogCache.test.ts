import { describe, it, expect, beforeEach } from "vitest";
import {
  recordCatalogSnapshot,
  getCatalogSnapshot,
  recordPreviewSnapshot,
  getPreviewSnapshot,
  catalogCacheLabel,
  _clearCatalogCache,
  CATALOG_CACHE_STALE_AFTER_MS,
} from "./catalogCache.js";

beforeEach(() => {
  _clearCatalogCache();
});

describe("catalog snapshot (#556)", () => {
  it("records and returns the last successful catalog read", () => {
    const resources = [
      { id: "a", title: "Alpha" },
      { id: "b", title: "Beta" },
    ];
    recordCatalogSnapshot(resources);

    const snapshot = getCatalogSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.resources).toEqual(resources);
    expect(snapshot!.savedAtMs).toBeGreaterThan(0);
  });

  it("returns a copy so the caller cannot mutate the cache", () => {
    recordCatalogSnapshot([{ id: "a", title: "Alpha" }]);
    const first = getCatalogSnapshot()!;
    const second = getCatalogSnapshot()!;
    expect(first).not.toBe(second);
    expect(first.resources).not.toBe(second.resources);
  });

  it("returns null before anything has been cached (no-cache path)", () => {
    expect(getCatalogSnapshot()).toBeNull();
  });

  it("overwrites the previous catalog read with the latest one", () => {
    recordCatalogSnapshot([{ id: "a" }]);
    recordCatalogSnapshot([{ id: "b" }, { id: "c" }]);
    expect(getCatalogSnapshot()!.resources).toEqual([{ id: "b" }, { id: "c" }]);
  });
});

describe("preview snapshot (#556)", () => {
  it("records and returns a per-resource preview meta", () => {
    recordPreviewSnapshot("res-1", { title: "Alpha", price: "5" });
    const snap = getPreviewSnapshot("res-1");
    expect(snap).not.toBeNull();
    expect(snap!.meta).toEqual({ title: "Alpha", price: "5" });
  });

  it("returns null for a resource that was never previewed", () => {
    expect(getPreviewSnapshot("res-missing")).toBeNull();
  });

  it("keeps previews for different resources independent", () => {
    recordPreviewSnapshot("res-1", { title: "Alpha" });
    recordPreviewSnapshot("res-2", { title: "Beta" });
    expect(getPreviewSnapshot("res-1")!.meta).toEqual({ title: "Alpha" });
    expect(getPreviewSnapshot("res-2")!.meta).toEqual({ title: "Beta" });
  });
});

describe("catalogCacheLabel (#556)", () => {
  it("labels a fresh snapshot with its age", () => {
    const now = 1_000_000;
    const label = catalogCacheLabel(now - 5 * 60_000, now); // 5 min old
    expect(label).toContain("cached 5 min ago");
    expect(label).toContain("Offline catalog snapshot served");
    expect(label).not.toContain("stale");
  });

  it("warns on a stale snapshot and points to the on-chain lookup", () => {
    const now = 1_000_000;
    const label = catalogCacheLabel(now - CATALOG_CACHE_STALE_AFTER_MS - 60_000, now);
    expect(label).toContain("stale");
    expect(label).toContain("mindvault_registry_lookup");
  });

  it("labels a snapshot exactly at the fresh/stale boundary as fresh", () => {
    const now = 1_000_000;
    const label = catalogCacheLabel(now - CATALOG_CACHE_STALE_AFTER_MS, now);
    expect(label).not.toContain("stale");
  });
});

describe("catalogCacheLabel reasons (#837)", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("defaults to unreachable when no reason is given", () => {
    expect(catalogCacheLabel(now - 60_000, now)).toContain("catalog API unreachable");
  });

  it("names the status when the catalog answered but could not serve", () => {
    const label = catalogCacheLabel(now - 60_000, now, { kind: "status", status: 503 });
    expect(label).toContain("catalog API returned HTTP 503");
    expect(label).not.toContain("unreachable");
  });

  it("keeps the staleness warning alongside the reason", () => {
    const label = catalogCacheLabel(now - CATALOG_CACHE_STALE_AFTER_MS - 60_000, now, {
      kind: "status",
      status: 502,
    });
    expect(label).toContain("HTTP 502");
    expect(label).toContain("stale");
    expect(label).toContain("mindvault_registry_lookup");
  });
});
