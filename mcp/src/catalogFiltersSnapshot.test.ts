/**
 * Catalog filter parity snapshot tests.
 *
 * These tests lock in the exact query strings, filter descriptions, and parsed
 * filter objects for every filter the browse/search tools expose. A diff in any
 * snapshot means the agent is sending a different request to GET /resources than
 * it used to — which is either an intentional API change (update the snapshots)
 * or an unintended regression (fix the code).
 *
 * Three layers are covered:
 *
 * 1. buildCatalogQueryString — the literal URL query string forwarded to the
 *    server. Any field rename, omission, or encoding change here breaks
 *    server-side filtering without touching client logic.
 *
 * 2. describeCatalogFilters — the human/agent-readable summary. An agent uses
 *    this to confirm which filters are active; an unexpected change in wording
 *    breaks agent reasoning about its own requests.
 *
 * 3. parseCatalogFilters round-trips — the CatalogFilters object produced from
 *    canonical MCP tool arguments. Captures normalisation, aliasing (search →
 *    query), and the exact accepted values for each field so a refactor that
 *    silently changes which inputs are accepted shows up immediately.
 */
import { describe, it, expect } from "vitest";
import {
  buildCatalogQueryString,
  describeCatalogFilters,
  parseCatalogFilters,
  type CatalogFilters,
} from "./catalogFilters.js";

// ---------------------------------------------------------------------------
// 1. buildCatalogQueryString snapshots
//
// Each case covers a distinct partition of the filter space. Taken together
// they prove every server-supported field appears in the query string under
// its exact expected key, and that client-only fields (tags, listed, skipped)
// are intentionally absent.
// ---------------------------------------------------------------------------

describe("buildCatalogQueryString — snapshots", () => {
  it("empty filters produce an empty string", () => {
    expect(buildCatalogQueryString({})).toMatchSnapshot();
  });

  it("keyword search maps to the 'search' param", () => {
    expect(buildCatalogQueryString({ query: "Stellar tutorial" })).toMatchSnapshot();
  });

  it("price range maps to minPrice and maxPrice params", () => {
    expect(buildCatalogQueryString({ minPrice: "0.50", maxPrice: "5.00" })).toMatchSnapshot();
  });

  it("verified status is forwarded to the server", () => {
    expect(buildCatalogQueryString({ verificationStatus: "verified" })).toMatchSnapshot();
  });

  it("pending status is forwarded to the server", () => {
    expect(buildCatalogQueryString({ verificationStatus: "pending" })).toMatchSnapshot();
  });

  it("rejected status is forwarded to the server", () => {
    expect(buildCatalogQueryString({ verificationStatus: "rejected" })).toMatchSnapshot();
  });

  it("skipped status is NOT forwarded — filtered client-side only", () => {
    // verificationStatus=skipped must never reach the server because the
    // catalog API does not accept it; the MCP filters it client-side.
    const qs = buildCatalogQueryString({ verificationStatus: "skipped" });
    expect(qs).toMatchSnapshot();
    // Belt-and-suspenders: a plain string assertion so a snapshot update is
    // never the only thing that catches this contract breaking.
    expect(qs).not.toContain("verificationStatus");
    expect(qs).not.toContain("skipped");
  });

  it("resourceType maps to the resourceType param", () => {
    expect(buildCatalogQueryString({ resourceType: "link" })).toMatchSnapshot();
    expect(buildCatalogQueryString({ resourceType: "file" })).toMatchSnapshot();
  });

  it("owner maps to the owner param", () => {
    expect(buildCatalogQueryString({ owner: "Alice" })).toMatchSnapshot();
  });

  it("sort maps to the sort param", () => {
    expect(buildCatalogQueryString({ sort: "price_asc" })).toMatchSnapshot();
    expect(buildCatalogQueryString({ sort: "price_desc" })).toMatchSnapshot();
    expect(buildCatalogQueryString({ sort: "title" })).toMatchSnapshot();
    expect(buildCatalogQueryString({ sort: "newest" })).toMatchSnapshot();
  });

  it("limit and offset map to their respective params", () => {
    expect(buildCatalogQueryString({ limit: 10, offset: 20 })).toMatchSnapshot();
  });

  it("tags are NOT forwarded — filtered client-side only", () => {
    const qs = buildCatalogQueryString({ tags: ["dataset", "research"] });
    expect(qs).toMatchSnapshot();
    expect(qs).not.toContain("tags");
  });

  it("listed is NOT forwarded — filtered client-side only", () => {
    const qs = buildCatalogQueryString({ listed: true });
    expect(qs).toMatchSnapshot();
    expect(qs).not.toContain("listed");
  });

  it("full server-supported filter set — all params present, client-only absent", () => {
    const filters: CatalogFilters = {
      query: "Soroban guide",
      minPrice: "1.00",
      maxPrice: "10.00",
      verificationStatus: "verified",
      resourceType: "link",
      owner: "Alice",
      sort: "price_asc",
      limit: 25,
      offset: 50,
      // client-only — must not appear in query string
      tags: ["smart-contracts"],
      listed: true,
    };
    expect(buildCatalogQueryString(filters)).toMatchSnapshot();
  });

  it("full filter set with skipped status — skipped omitted, all others present", () => {
    const filters: CatalogFilters = {
      query: "dataset",
      minPrice: "0.10",
      maxPrice: "1.00",
      verificationStatus: "skipped",
      resourceType: "file",
      owner: "Bob",
      sort: "newest",
      limit: 5,
      offset: 0,
      tags: ["research"],
      listed: false,
    };
    const qs = buildCatalogQueryString(filters);
    expect(qs).toMatchSnapshot();
    expect(qs).not.toContain("skipped");
  });
});

// ---------------------------------------------------------------------------
// 2. describeCatalogFilters snapshots
//
// The description is what agents and the UI show to confirm which filters are
// active. Changes here affect agent reasoning and user-facing copy.
// ---------------------------------------------------------------------------

describe("describeCatalogFilters — snapshots", () => {
  it("empty filters describe as 'the catalog'", () => {
    expect(describeCatalogFilters({})).toMatchSnapshot();
  });

  it("bare keyword shortcut — single query with no other filters", () => {
    // A single bare query uses the short form '"<query>"' not the long form.
    expect(describeCatalogFilters({ query: "Stellar tutorial" })).toMatchSnapshot();
  });

  it("query with at least one other filter uses the long form", () => {
    expect(describeCatalogFilters({ query: "Stellar", minPrice: "1.00" })).toMatchSnapshot();
  });

  it("price range without query", () => {
    expect(describeCatalogFilters({ minPrice: "0.50", maxPrice: "5.00" })).toMatchSnapshot();
  });

  it("verificationStatus labels in description", () => {
    expect(describeCatalogFilters({ verificationStatus: "verified" })).toMatchSnapshot();
    expect(describeCatalogFilters({ verificationStatus: "skipped" })).toMatchSnapshot();
  });

  it("resourceType in description", () => {
    expect(describeCatalogFilters({ resourceType: "file" })).toMatchSnapshot();
  });

  it("sort in description", () => {
    expect(describeCatalogFilters({ sort: "price_asc" })).toMatchSnapshot();
  });

  it("tags appear in description", () => {
    expect(describeCatalogFilters({ tags: ["dataset", "research"] })).toMatchSnapshot();
  });

  it("listed appears in description", () => {
    expect(describeCatalogFilters({ listed: true })).toMatchSnapshot();
    expect(describeCatalogFilters({ listed: false })).toMatchSnapshot();
  });

  it("pagination in description", () => {
    expect(describeCatalogFilters({ limit: 10, offset: 40 })).toMatchSnapshot();
  });

  it("full filter set description", () => {
    expect(
      describeCatalogFilters({
        query: "Soroban",
        minPrice: "1.00",
        maxPrice: "10.00",
        verificationStatus: "verified",
        resourceType: "link",
        owner: "Alice",
        sort: "price_asc",
        limit: 20,
        offset: 0,
        tags: ["smart-contracts", "tutorial"],
        listed: true,
      }),
    ).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// 3. parseCatalogFilters round-trip snapshots
//
// Captures the exact CatalogFilters object that comes out of parse for each
// canonical input shape. Proves normalisation (whitespace trimming, number
// coercion), aliases (search → query), and the full accepted value set for
// each field.
// ---------------------------------------------------------------------------

describe("parseCatalogFilters — round-trip snapshots", () => {
  it("empty object for browse (no criteria required)", () => {
    expect(parseCatalogFilters({})).toMatchSnapshot();
  });

  it("keyword via query field", () => {
    expect(parseCatalogFilters({ query: "  Stellar  " })).toMatchSnapshot();
  });

  it("keyword via legacy search alias", () => {
    // 'search' is an accepted alias for 'query'; both must produce the same
    // filters.query value.
    const viaQuery = parseCatalogFilters({ query: "Stellar" });
    const viaSearch = parseCatalogFilters({ search: "Stellar" });
    expect(viaSearch).toMatchSnapshot();
    if (viaQuery.ok && viaSearch.ok) {
      expect(viaSearch.filters.query).toBe(viaQuery.filters.query);
    }
  });

  it("price filters as strings", () => {
    expect(parseCatalogFilters({ minPrice: "0.50", maxPrice: "5.00" })).toMatchSnapshot();
  });

  it("all four verificationStatus values accepted", () => {
    for (const status of ["pending", "verified", "rejected", "skipped"] as const) {
      expect(parseCatalogFilters({ verificationStatus: status })).toMatchSnapshot();
    }
  });

  it("both resourceType values accepted", () => {
    expect(parseCatalogFilters({ resourceType: "link" })).toMatchSnapshot();
    expect(parseCatalogFilters({ resourceType: "file" })).toMatchSnapshot();
  });

  it("sort — all four values accepted and passed through", () => {
    for (const sort of ["newest", "price_asc", "price_desc", "title"] as const) {
      expect(parseCatalogFilters({ sort })).toMatchSnapshot();
    }
  });

  it("limit and offset coerced from string to integer", () => {
    expect(parseCatalogFilters({ limit: "10", offset: "20" })).toMatchSnapshot();
  });

  it("tags as comma-separated string", () => {
    expect(parseCatalogFilters({ tags: "dataset, research" })).toMatchSnapshot();
  });

  it("tags as array", () => {
    expect(parseCatalogFilters({ tags: ["dataset", "research"] })).toMatchSnapshot();
  });

  it("listed as boolean true/false", () => {
    expect(parseCatalogFilters({ listed: true })).toMatchSnapshot();
    expect(parseCatalogFilters({ listed: false })).toMatchSnapshot();
  });

  it("listed as string 'true'/'false'", () => {
    expect(parseCatalogFilters({ listed: "true" })).toMatchSnapshot();
    expect(parseCatalogFilters({ listed: "false" })).toMatchSnapshot();
  });

  it("full browse filter set — all fields present", () => {
    expect(
      parseCatalogFilters({
        query: "Soroban guide",
        minPrice: "1.00",
        maxPrice: "10.00",
        verificationStatus: "verified",
        resourceType: "link",
        owner: "Alice",
        sort: "price_asc",
        limit: "25",
        offset: "50",
        tags: "smart-contracts, tutorial",
        listed: "true",
      }),
    ).toMatchSnapshot();
  });

  it("requireCriteria=true with a valid filter set", () => {
    expect(parseCatalogFilters({ query: "Stellar" }, { requireCriteria: true })).toMatchSnapshot();
  });

  it("error shape for invalid minPrice", () => {
    expect(parseCatalogFilters({ minPrice: "not-a-number" })).toMatchSnapshot();
  });

  it("error shape for inverted price range", () => {
    expect(parseCatalogFilters({ minPrice: "10", maxPrice: "1" })).toMatchSnapshot();
  });

  it("error shape for invalid verificationStatus", () => {
    expect(parseCatalogFilters({ verificationStatus: "bogus" })).toMatchSnapshot();
  });

  it("error shape for invalid listed value", () => {
    expect(parseCatalogFilters({ listed: "maybe" })).toMatchSnapshot();
  });

  it("error shape for invalid sort value", () => {
    expect(parseCatalogFilters({ sort: "random" })).toMatchSnapshot();
  });

  it("error shape for limit out of range", () => {
    expect(parseCatalogFilters({ limit: 0 })).toMatchSnapshot();
    expect(parseCatalogFilters({ limit: 101 })).toMatchSnapshot();
  });

  it("error shape for negative offset", () => {
    expect(parseCatalogFilters({ offset: -1 })).toMatchSnapshot();
  });

  it("error shape for requireCriteria with no filters", () => {
    expect(parseCatalogFilters({}, { requireCriteria: true })).toMatchSnapshot();
  });
});
