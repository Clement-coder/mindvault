#!/usr/bin/env tsx
/**
 * Offline fixture generation for the MindVault MCP server.
 *
 * Serialises the in-memory mock data (from `src/mock.ts`) to static JSON files
 * under `fixtures/`. The generated files are the single offline source of truth
 * for every test or script that needs predictable API / registry responses
 * without starting any process or touching the network.
 *
 * Usage:
 *   pnpm --filter @mindvault/mcp generate-fixtures
 *   # or from mcp/
 *   pnpm generate-fixtures
 *
 * The command is idempotent: running it twice produces bit-for-bit identical
 * output. Commit the generated files so CI and contributors always have them
 * without needing to run the command first.
 *
 * Output files:
 *   fixtures/catalog.json          — catalog resources (GET /resources shape)
 *   fixtures/registry.json         — on-chain registry resources (Soroban list shape)
 *   fixtures/agent-status.json     — verification agent status (GET /agent/status shape)
 *   fixtures/horizon-balances.json — Horizon account balances (GET /accounts/:pk shape)
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { MOCK_CATALOG_RESOURCES, MOCK_REGISTRY_RESOURCES } from "../src/mock.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

/** Write a JSON file, creating the directory if it does not exist. */
function writeFixture(name: string, data: unknown): void {
  mkdirSync(fixturesDir, { recursive: true });
  const dest = join(fixturesDir, name);
  writeFileSync(dest, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`  wrote ${dest}`);
}

/**
 * Catalog: the array the mock returns for GET /resources.
 *
 * Includes the Cache-Control metadata the real API sets, so tests that exercise
 * the cache-staleness helper have something plausible to parse.
 */
function catalogFixture(): object {
  return {
    _meta: {
      generatedBy: "scripts/generate-fixtures.ts",
      description:
        "Snapshot of MOCK_CATALOG_RESOURCES — the deterministic catalog the in-process mock serves for GET /resources.",
      cacheControl: "max-age=60",
    },
    resources: MOCK_CATALOG_RESOURCES,
  };
}

/**
 * Registry: the array the mock returns for on-chain registry list() calls.
 *
 * Matches the shape that mockRegistryList() serialises for the base (no active
 * profile) case.
 */
function registryFixture(): object {
  return {
    _meta: {
      generatedBy: "scripts/generate-fixtures.ts",
      description:
        "Snapshot of MOCK_REGISTRY_RESOURCES — the deterministic on-chain list the in-process mock serves for registry_list tool calls.",
    },
    source: "on-chain (mock)",
    start: 0,
    limit: MOCK_REGISTRY_RESOURCES.length,
    count: MOCK_REGISTRY_RESOURCES.length,
    resources: MOCK_REGISTRY_RESOURCES,
    contract: "MOCK_CONTRACT_ID",
  };
}

/**
 * Agent status: the object the mock returns for GET /agent/status.
 *
 * Tests that exercise the pre-publish funds check use this to confirm the
 * mock reports a live, priced verification agent.
 */
function agentStatusFixture(): object {
  return {
    _meta: {
      generatedBy: "scripts/generate-fixtures.ts",
      description: "Snapshot of the mock GET /agent/status response.",
    },
    agent: {
      pricePerVerification: "0.01",
      totalEarnings: "0",
      verifications: 0,
    },
  };
}

/**
 * Horizon balances: the object the mock returns for GET /accounts/:pk.
 *
 * Tests that exercise wallet-balance checks use this to assert the mock
 * reports a funded account with both USDC and native XLM.
 */
function horizonBalancesFixture(): object {
  return {
    _meta: {
      generatedBy: "scripts/generate-fixtures.ts",
      description:
        "Snapshot of the mock Horizon GET /accounts/:pk response — a funded testnet account with USDC and native XLM.",
    },
    balances: [
      { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "1000.0000000" },
      { asset_type: "native", balance: "100.0000000" },
    ],
  };
}

function main(): void {
  console.log("MindVault MCP — generating offline fixtures");

  writeFixture("catalog.json", catalogFixture());
  writeFixture("registry.json", registryFixture());
  writeFixture("agent-status.json", agentStatusFixture());
  writeFixture("horizon-balances.json", horizonBalancesFixture());

  console.log(`\n✓ ${4} fixtures written to ${fixturesDir}`);
}

main();
