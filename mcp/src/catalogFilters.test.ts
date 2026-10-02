import { describe, it, expect } from "vitest";
import {
  applyCatalogSort,
  applyClientCatalogFilters,
  buildCatalogQueryString,
  CATALOG_SORT_VALUES,
  describeCatalogFilters,
  parseCatalogFilters,
} from "./catalogFilters.js";

describe("parseCatalogFilters", () => {
  it("accepts an empty object for browse (no criteria required)", () => {
    const parsed = parseCatalogFilters({});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.filters).toEqual({});
  });

  it("requires criteria for search", () => {
    const parsed = parseCatalogFilters({}, { requireCriteria: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBe("Provide a search query or at least one catalog filter.");
    }
  });

  it("parses the full filter set including tags and listed", () => {
    const parsed = parseCatalogFilters(
      {
        query: "  Stellar  ",
        minPrice: "0.50",
        maxPrice: "5.00",
        verificationStatus: "verified",
        resourceType: "link",
        owner: "Alice",
        sort: "price_asc",
        limit: "20",
        offset: "0",
        tags: "dataset, research",
        listed: "true",
      },
      { requireCriteria: true },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.filters).toEqual({
        query: "Stellar",
        minPrice: "0.50",
        maxPrice: "5.00",
        verificationStatus: "verified",
        resourceType: "link",
        owner: "Alice",
        sort: "price_asc",
        limit: 20,
        offset: 0,
        tags: ["dataset", "research"],
        listed: true,
      });
    }
  });

  it("rejects minPrice greater than maxPrice", () => {
    const parsed = parseCatalogFilters({ minPrice: "5", maxPrice: "1" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("minPrice cannot be greater than maxPrice");
  });

  it("rejects invalid verificationStatus", () => {
    const parsed = parseCatalogFilters({ verificationStatus: "bogus" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("verificationStatus");
  });

  it("rejects invalid listed values", () => {
    const parsed = parseCatalogFilters({ listed: "maybe" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("listed");
  });

  it("allows filter-only search without a query", () => {
    const parsed = parseCatalogFilters(
      { resourceType: "link", listed: true },
      { requireCriteria: true },
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("buildCatalogQueryString", () => {
  it("forwards server-supported params and omits tags/listed/skipped", () => {
    const qs = buildCatalogQueryString({
      query: "dataset",
      minPrice: "0.10",
      maxPrice: "1.00",
      verificationStatus: "skipped",
      resourceType: "link",
      owner: "Alice",
      sort: "title",
      limit: 10,
      offset: 5,
      tags: ["dataset"],
      listed: true,
    });
    const params = new URLSearchParams(qs);
    expect(params.get("search")).toBe("dataset");
    expect(params.get("minPrice")).toBe("0.10");
    expect(params.get("maxPrice")).toBe("1.00");
    expect(params.get("verificationStatus")).toBeNull();
    expect(params.get("resourceType")).toBe("link");
    expect(params.get("owner")).toBe("Alice");
    expect(params.get("sort")).toBe("title");
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("5");
    expect(params.has("tags")).toBe(false);
    expect(params.has("listed")).toBe(false);
  });
});

describe("applyClientCatalogFilters", () => {
  const rows = [
    {
      id: "1",
      title: "Stellar dataset",
      description: "research",
      tags: ["dataset", "stellar"],
      listed: true,
      verificationStatus: "verified",
    },
    {
      id: "2",
      title: "Hidden notes",
      description: "private",
      tags: ["notes"],
      listed: false,
      verificationStatus: "skipped",
    },
  ];

  it("filters by tags (all must match)", () => {
    const result = applyClientCatalogFilters(rows, { tags: ["dataset", "stellar"] });
    expect(result.map((r) => r.id)).toEqual(["1"]);
  });

  it("excludes tombstoned/delisted entries when filtering by tag", () => {
    // A stale cache snapshot may contain a resource that was tombstoned on-chain
    // (listed=false). It must not surface in a tag-based query even if its tags
    // still match.
    const withTombstoned = [
      ...rows,
      {
        id: "3",
        title: "Dead entry",
        description: "",
        tags: ["dataset", "stellar"],
        listed: false,
        verificationStatus: "verified",
      },
    ];
    const result = applyClientCatalogFilters(withTombstoned, { tags: ["dataset", "stellar"] });
    expect(result.map((r) => r.id)).toEqual(["1"]);
  });

  it("returns unlisted entries when listed=false is explicitly requested alongside tags", () => {
    const withUnlisted = [
      ...rows,
      {
        id: "3",
        title: "Unlisted entry",
        description: "",
        tags: ["notes"],
        listed: false,
        verificationStatus: "verified",
      },
    ];
    const result = applyClientCatalogFilters(withUnlisted, { tags: ["notes"], listed: false });
    expect(result.map((r) => r.id)).toEqual(["2", "3"]);
  });

  it("filters by listed state", () => {
    expect(applyClientCatalogFilters(rows, { listed: false }).map((r) => r.id)).toEqual(["2"]);
  });

  it("filters verificationStatus=skipped client-side", () => {
    expect(
      applyClientCatalogFilters(rows, { verificationStatus: "skipped" }).map((r) => r.id),
    ).toEqual(["2"]);
  });
});

describe("describeCatalogFilters", () => {
  it("includes tags and listed in the description", () => {
    expect(
      describeCatalogFilters({
        query: "x",
        tags: ["a"],
        listed: true,
      }),
    ).toContain("tags [a]");
  });
});

describe("catalog sort options", () => {
  const rows = [
    { id: "b", title: "Beta", price: "2.00", createdAt: "2026-08-02T00:00:00.000Z" },
    { id: "a", title: "Alpha", price: "10.00", createdAt: "2026-08-03T00:00:00.000Z" },
    { id: "c", title: "Gamma", price: "0.50", createdAt: "2026-08-01T00:00:00.000Z" },
  ];

  it("accepts every sort the catalog API supports", () => {
    for (const sort of CATALOG_SORT_VALUES) {
      const parsed = parseCatalogFilters({ sort });
      expect(parsed.ok, `sort=${sort}`).toBe(true);
      if (parsed.ok) expect(parsed.filters.sort).toBe(sort);
    }
  });

  it("rejects an unknown sort with the accepted values", () => {
    const parsed = parseCatalogFilters({ sort: "cheapest" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("newest, price_asc, price_desc, title");
  });

  it("forwards sort to GET /resources", () => {
    expect(buildCatalogQueryString({ sort: "price_desc" })).toBe("sort=price_desc");
  });

  it("orders by price ascending, comparing numerically not lexically", () => {
    // "10.00" < "2.00" as strings — a string sort would put Alpha first.
    expect(applyCatalogSort(rows, "price_asc").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("orders by price descending", () => {
    expect(applyCatalogSort(rows, "price_desc").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("orders by title", () => {
    expect(applyCatalogSort(rows, "title").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("orders newest first when every row carries a timestamp", () => {
    expect(applyCatalogSort(rows, "newest").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves the server order alone when timestamps are missing", () => {
    const untimed = rows.map(({ createdAt: _createdAt, ...rest }) => rest);
    expect(applyCatalogSort(untimed, "newest").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("returns the input untouched when no sort is requested", () => {
    expect(applyCatalogSort(rows, undefined)).toBe(rows);
  });

  it("does not mutate the caller's array", () => {
    const input = [...rows];
    applyCatalogSort(input, "price_asc");
    expect(input.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts rows with unparseable prices last, keeping their relative order", () => {
    const priced = [
      { id: "x", title: "X", price: "" },
      { id: "y", title: "Y", price: "1" },
      { id: "z", title: "Z", price: "n/a" },
    ];
    expect(applyCatalogSort(priced, "price_asc").map((r) => r.id)).toEqual(["y", "x", "z"]);
  });
});
