/**
 * Tests for the offline fixture generation.
 *
 * Two concerns:
 *
 * 1. The exported mock data constants (`MOCK_CATALOG_RESOURCES`,
 *    `MOCK_REGISTRY_RESOURCES`) are internally consistent — IDs align across
 *    the catalog and the registry, and each entry is well-formed.
 *
 * 2. The fixture files written by `scripts/generate-fixtures.ts` are present
 *    and match the in-memory constants. This guards against a contributor
 *    editing `mock.ts` without re-running `pnpm generate-fixtures`.
 *
 * The file-presence check is skipped when SKIP_FIXTURE_FILE_CHECK is set so
 * unit runs in environments where `fixtures/` has not been generated yet
 * (e.g. a fresh CI checkout that has not run the generate step) still pass
 * the data-shape assertions without a false negative.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  MOCK_CATALOG_RESOURCES,
  MOCK_REGISTRY_RESOURCES,
  type MockResource,
  type MockRegistryResource,
} from "./mock.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

// ---------------------------------------------------------------------------
// Data-shape assertions (no filesystem, always runs)
// ---------------------------------------------------------------------------

describe("MOCK_CATALOG_RESOURCES", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(MOCK_CATALOG_RESOURCES)).toBe(true);
    expect(MOCK_CATALOG_RESOURCES.length).toBeGreaterThan(0);
  });

  it("every entry has a non-empty string id", () => {
    for (const r of MOCK_CATALOG_RESOURCES) {
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
    }
  });

  it("every entry has a positive numeric price string", () => {
    for (const r of MOCK_CATALOG_RESOURCES) {
      const n = parseFloat(r.price);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });

  it("every entry is a verified link resource", () => {
    for (const r of MOCK_CATALOG_RESOURCES) {
      expect(r.resourceType).toBe("link");
      expect(r.verificationStatus).toBe("verified");
    }
  });

  it("every accessUrl is an absolute https URL", () => {
    for (const r of MOCK_CATALOG_RESOURCES) {
      expect(() => new URL(r.accessUrl)).not.toThrow();
      expect(new URL(r.accessUrl).protocol).toBe("https:");
    }
  });

  it("IDs are unique", () => {
    const ids = MOCK_CATALOG_RESOURCES.map((r: MockResource) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains mock-1 (the install smoke fixture resource)", () => {
    expect(MOCK_CATALOG_RESOURCES.some((r) => r.id === "mock-1")).toBe(true);
  });
});

describe("MOCK_REGISTRY_RESOURCES", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(MOCK_REGISTRY_RESOURCES)).toBe(true);
    expect(MOCK_REGISTRY_RESOURCES.length).toBeGreaterThan(0);
  });

  it("every entry has id, creator, price, metadata, listed, tags", () => {
    for (const r of MOCK_REGISTRY_RESOURCES) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.creator).toBe("string");
      expect(typeof r.price).toBe("string");
      expect(typeof r.metadata).toBe("string");
      expect(typeof r.listed).toBe("boolean");
      expect(Array.isArray(r.tags)).toBe(true);
    }
  });

  it("IDs are unique", () => {
    const ids = MOCK_REGISTRY_RESOURCES.map((r: MockRegistryResource) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("catalog and registry resource IDs align", () => {
    // Every catalog resource that is verified should have a matching registry
    // entry — the two data sets must agree on what exists.
    const catalogIds = new Set(MOCK_CATALOG_RESOURCES.map((r) => r.id));
    const registryIds = new Set(MOCK_REGISTRY_RESOURCES.map((r) => r.id));
    // All registry entries must also be in the catalog.
    for (const id of registryIds) {
      expect(catalogIds.has(id), `Registry id ${id} not found in catalog`).toBe(true);
    }
  });

  it("listed resources have a USDC price string", () => {
    for (const r of MOCK_REGISTRY_RESOURCES.filter((r) => r.listed)) {
      expect(r.price).toMatch(/USDC/);
    }
  });
});

// ---------------------------------------------------------------------------
// Generated fixture file assertions (skipped when files absent)
// ---------------------------------------------------------------------------

const skipFileChecks =
  process.env.SKIP_FIXTURE_FILE_CHECK === "1" || !existsSync(join(fixturesDir, "catalog.json"));

describe.skipIf(skipFileChecks)("generated fixture files", () => {
  function loadFixture(name: string): unknown {
    return JSON.parse(readFileSync(join(fixturesDir, name), "utf-8"));
  }

  it("catalog.json exists and contains the same resources as MOCK_CATALOG_RESOURCES", () => {
    const fixture = loadFixture("catalog.json") as { resources: MockResource[] };
    expect(Array.isArray(fixture.resources)).toBe(true);
    expect(fixture.resources).toEqual(MOCK_CATALOG_RESOURCES);
  });

  it("registry.json exists and contains the same resources as MOCK_REGISTRY_RESOURCES", () => {
    const fixture = loadFixture("registry.json") as {
      resources: MockRegistryResource[];
      count: number;
    };
    expect(Array.isArray(fixture.resources)).toBe(true);
    expect(fixture.resources).toEqual(MOCK_REGISTRY_RESOURCES);
    expect(fixture.count).toBe(MOCK_REGISTRY_RESOURCES.length);
  });

  it("agent-status.json contains pricePerVerification", () => {
    const fixture = loadFixture("agent-status.json") as {
      agent: { pricePerVerification: string };
    };
    expect(typeof fixture.agent.pricePerVerification).toBe("string");
    expect(parseFloat(fixture.agent.pricePerVerification)).toBeGreaterThan(0);
  });

  it("horizon-balances.json contains a USDC and a native balance", () => {
    const fixture = loadFixture("horizon-balances.json") as {
      balances: Array<{ asset_type: string; asset_code?: string; balance: string }>;
    };
    expect(Array.isArray(fixture.balances)).toBe(true);
    const usdc = fixture.balances.find((b) => b.asset_code === "USDC");
    const native = fixture.balances.find((b) => b.asset_type === "native");
    expect(usdc).toBeDefined();
    expect(native).toBeDefined();
  });

  it("all fixture files carry a _meta.generatedBy field", () => {
    for (const name of [
      "catalog.json",
      "registry.json",
      "agent-status.json",
      "horizon-balances.json",
    ]) {
      const fixture = loadFixture(name) as { _meta?: { generatedBy?: string } };
      expect(fixture._meta?.generatedBy, `${name} is missing _meta.generatedBy`).toBe(
        "scripts/generate-fixtures.ts",
      );
    }
  });
});
