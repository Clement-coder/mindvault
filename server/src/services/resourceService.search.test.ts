import { describe, it, expect, beforeEach, vi } from "vitest";

// Mutable state the db mock serves
let currentRows: unknown[] = [];

const builder = {
  from: () => builder,
  innerJoin: () => builder,
  where: () => builder,
  orderBy: () => Promise.resolve(currentRows),
};

vi.mock("../db/client.js", () => ({
  db: {
    select: () => builder,
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "newId" }]) }) }),
  },
}));

vi.mock("../storage/supabaseStorage.js", () => ({
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../config.js", () => ({ config: { CATALOG_CACHE_TTL_MS: 60_000 } }));

import { listCatalog, __resetCatalogCache } from "./resourceService.js";

describe("catalog search", () => {
  const allResources = [
    {
      id: "1",
      title: "Atlas of Stellar Networks",
      description: "A detailed map of stellar connections",
      price: "5.00",
      resourceType: "file",
      mimeType: "application/pdf",
      publisherName: "Pub1",
      createdAt: new Date("2025-01-01"),
    },
    {
      id: "2",
      title: "Quantum Computing Basics",
      description: "Introduction to quantum algorithms",
      price: "3.00",
      resourceType: "link",
      mimeType: null,
      publisherName: "Pub2",
      createdAt: new Date("2025-02-01"),
    },
    {
      id: "3",
      title: "Stellar Development Guide",
      description: "Build on the Stellar network",
      price: "10.00",
      resourceType: "file",
      mimeType: "text/markdown",
      publisherName: "Pub3",
      createdAt: new Date("2025-03-01"),
    },
    {
      id: "4",
      title: "Machine Learning 101",
      description: "ML fundamentals with Python",
      price: "7.50",
      resourceType: "link",
      mimeType: null,
      publisherName: "Pub4",
      createdAt: new Date("2025-04-01"),
    },
  ];

  beforeEach(() => {
    __resetCatalogCache();
    currentRows = allResources;
  });

  it("returns all resources when no search term is given", async () => {
    const result = await listCatalog();
    expect(result).toHaveLength(4);
  });

  it("filters resources matching the search term in the title", async () => {
    currentRows = allResources.filter((r) => r.title.toLowerCase().includes("stellar"));
    const result = await listCatalog({ search: "Stellar" });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(expect.arrayContaining(["1", "3"]));
  });

  it("filters resources matching the search term in the description", async () => {
    currentRows = allResources.filter((r) =>
      (r.description ?? "").toLowerCase().includes("quantum"),
    );
    const result = await listCatalog({ search: "quantum" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("performs case-insensitive matching", async () => {
    currentRows = allResources.filter((r) => r.title.toLowerCase().includes("stellar"));
    const result = await listCatalog({ search: "stellar" });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(expect.arrayContaining(["1", "3"]));
  });

  it("matches canonically equivalent Unicode search terms", async () => {
    currentRows = [
      {
        ...allResources[0],
        id: "5",
        title: "Café Guide",
        description: "A guide with composed accents",
      },
    ];
    const result = await listCatalog({ search: "Cafe\u0301   guide" });
    expect(result.map((r) => r.id)).toEqual(["5"]);
  });

  it("returns an empty array when no resources match", async () => {
    currentRows = [];
    const result = await listCatalog({ search: "nonexistent" });
    expect(result).toHaveLength(0);
  });
});
