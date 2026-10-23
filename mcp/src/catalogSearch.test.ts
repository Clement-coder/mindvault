import { describe, expect, it } from "vitest";
import { normalizeCatalogSearchTerm } from "./catalogSearch.js";

describe("catalog search normalization", () => {
  it("matches composed and decomposed Unicode forms", () => {
    expect(normalizeCatalogSearchTerm("Cafe\u0301  Guide")).toBe("café guide");
    expect(normalizeCatalogSearchTerm("CAFÉ guide")).toBe("café guide");
  });

  it("canonicalizes surrounding and repeated whitespace", () => {
    expect(normalizeCatalogSearchTerm("  Stellar\t\nNetwork  ")).toBe("stellar network");
  });
});
