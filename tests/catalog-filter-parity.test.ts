import { describe, expect, it, vi } from "vitest";

vi.mock("../server/src/config.js", () => ({
  config: {
    CATALOG_CACHE_TTL_MS: 60_000,
    CATALOG_CACHE_MAX_KEYS: 100,
  },
}));

vi.mock("../server/src/db/client.js", () => ({
  db: {},
}));

vi.mock("../server/src/storage/supabaseStorage.js", () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import { applyCatalogFilters } from "../server/src/services/resourceService.js";
import { applyClientCatalogFilters } from "../mcp/src/catalogFilters.js";
import {
  catalogFilterParityMcpFilters,
  catalogFilterParityRows,
  catalogFilterParityServerFilters,
  publicCatalogFilterParityRows,
} from "./fixtures/catalog-filter-parity.js";

describe("catalog filter parity", () => {
  it("matches numeric price filtering and case-insensitive tag filtering", () => {
    const serverRows = applyCatalogFilters(
      publicCatalogFilterParityRows,
      catalogFilterParityServerFilters,
    );
    const mcpRows = applyClientCatalogFilters(serverRows, catalogFilterParityMcpFilters);

    expect(serverRows.map((row) => row.id)).toEqual(["price-padded", "price-short"]);
    expect(mcpRows.map((row) => row.id)).toEqual(serverRows.map((row) => row.id));
  });

  it("keeps the public listed boundary consistent with listed=true", () => {
    const serverRows = applyCatalogFilters(
      catalogFilterParityRows.filter((row) => row.listed),
      {},
    );
    const mcpRows = applyClientCatalogFilters(serverRows, { listed: true });

    expect(mcpRows.map((row) => row.id)).toEqual(serverRows.map((row) => row.id));
    expect(mcpRows.every((row) => row.listed)).toBe(true);
  });

  it("returns no public catalog matches for listed=false", () => {
    const serverRows = applyCatalogFilters(publicCatalogFilterParityRows, {});
    const mcpRows = applyClientCatalogFilters(serverRows, { listed: false });

    expect(mcpRows).toEqual([]);
  });

  it("preserves the shared USDC catalog assumption while comparing result sets", () => {
    const serverRows = applyCatalogFilters(publicCatalogFilterParityRows, {
      minPrice: "0.5",
      maxPrice: "10.00",
    });
    const mcpRows = applyClientCatalogFilters(serverRows, {});

    expect(mcpRows.map((row) => row.id)).toEqual(serverRows.map((row) => row.id));
    expect(new Set(mcpRows.map((row) => row.currency))).toEqual(new Set(["USDC"]));
  });
});
