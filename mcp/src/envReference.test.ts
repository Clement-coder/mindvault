/**
 * Tests for the env var reference inventory (#599).
 *
 * The inventory in envReference.ts is only useful while it is complete and
 * truthful. These tests hold both ends of that bargain:
 *
 *   1. Completeness — every variable the code reads through a literal
 *      `process.env.X` / `env.X` member access has an entry. Variables read
 *      through bracket access (`env[TIMEOUT_ENV_VARS.http]`) are invisible to
 *      a literal scan by construction; their names live in the very
 *      `*_ENV_VARS` constant objects the code reads, so the reverse check
 *      below verifies them against their stated source module instead.
 *   2. Truthfulness — each entry's default matches the default the owning
 *      module enforces (imported and compared), and enumerated knobs list the
 *      values their parser accepts.
 *   3. Doc staleness — docs/mcp-env-variables.md is generated from the
 *      inventory, so a PR that adds a variable without regenerating the page
 *      fails here (mirroring the mcp-tool-reference.md guard).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_VAR_DOCS, findEnvVarDoc } from "./envReference.js";
import { DEFAULT_MAX_AUTO_PAY_USDC } from "./paymentCeiling.js";
import { DEFAULT_PAID_CONFIRMATION_POLICY } from "./paidOperations.js";
import { DEFAULT_MAINNET_MUTATION_POLICY } from "./mainnetGuardrails.js";
import { DEFAULT_RETRY_POLICY } from "./retry.js";
import { DEFAULT_TIMEOUTS } from "./httpTimeout.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = here;
const docPath = join(here, "..", "..", "docs", "mcp-env-variables.md");

/**
 * Variable names read as literal member accesses anywhere under src/.
 *
 * Test files are skipped: they set variables, they do not document what the
 * server reads.
 */
function variablesReadInCode(): Set<string> {
  const names = new Set<string>();
  const pattern = /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const text = readFileSync(full, "utf-8");
      for (const match of text.matchAll(pattern)) names.add(match[1]);
    }
  };
  walk(srcDir);
  return names;
}

/**
 * Read by the code but not an operator knob: vitest's own marker, set by the
 * test runner to let the server skip fail-fast startup diagnostics.
 */
const NON_OPERATOR_VARS = new Set(["VITEST"]);

describe("env var reference inventory — completeness", () => {
  it("documents every variable the code reads directly", () => {
    const read = variablesReadInCode();
    const documented = new Set(ENV_VAR_DOCS.map((d) => d.name));
    const missing = [...read].filter(
      (name) => !NON_OPERATOR_VARS.has(name) && !documented.has(name) && !findEnvVarDoc(name),
    );
    // findEnvVarDoc resolves concrete per-tool names (e.g.
    // MINDVAULT_RETRY_ATTEMPTS_MINDVAULT_BROWSE) to the <TOOL> pattern row.
    expect(missing, `undocumented variables: ${missing.join(", ")}`).toEqual([]);
  });

  it("every entry is referenced by the source module that states it", () => {
    for (const doc of ENV_VAR_DOCS) {
      if (doc.name.includes("<TOOL>")) continue;
      const moduleFile = join(srcDir, doc.source.replace(/^mcp\/src\//, ""));
      const moduleText = readFileSync(moduleFile, "utf-8");
      expect(
        moduleText,
        `${doc.name} is not referenced anywhere in its stated source ${doc.source}`,
      ).toContain(doc.name);
    }
  });

  it("every entry names a variable and states its source module", () => {
    for (const doc of ENV_VAR_DOCS) {
      expect(doc.name).toMatch(/^[A-Z][A-Z0-9_]*(<TOOL>)?$/);
      expect(doc.description.trim().length).toBeGreaterThan(0);
      expect(doc.default.trim().length).toBeGreaterThan(0);
      expect(doc.source).toMatch(/^mcp\/src\//);
    }
  });

  it("has no duplicate variable names", () => {
    const names = ENV_VAR_DOCS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("env var reference inventory — truthfulness", () => {
  it("sources the mainnet policy default from the guardrail module", () => {
    const doc = findEnvVarDoc("MINDVAULT_ALLOW_MAINNET");
    expect(doc?.default).toBe(DEFAULT_MAINNET_MUTATION_POLICY);
  });

  it("sources the paid-confirmation default from its module", () => {
    const doc = findEnvVarDoc("MINDVAULT_CONFIRM_PAID_OPERATIONS");
    expect(doc?.default).toBe(DEFAULT_PAID_CONFIRMATION_POLICY);
    expect(doc?.values).toContain("off");
    expect(doc?.values).toContain("usdc");
    expect(doc?.values).toContain("all");
  });

  it("sources the auto-pay ceiling from its module", () => {
    const doc = findEnvVarDoc("MINDVAULT_MAX_AUTO_PAY_USDC");
    expect(doc?.default).toContain(DEFAULT_MAX_AUTO_PAY_USDC);
  });

  it("sources the retry policy defaults from their module", () => {
    const doc = findEnvVarDoc("MINDVAULT_RETRY_ATTEMPTS");
    expect(doc?.default).toBe(`${DEFAULT_RETRY_POLICY.attempts}`);
    const base = findEnvVarDoc("MINDVAULT_RETRY_BASE_DELAY_MS");
    expect(base?.default).toBe(`${DEFAULT_RETRY_POLICY.baseDelayMs} (ms)`);
    const max = findEnvVarDoc("MINDVAULT_RETRY_MAX_DELAY_MS");
    expect(max?.default).toBe(`${DEFAULT_RETRY_POLICY.maxDelayMs} (ms)`);
  });

  it("sources the four service timeouts from their module", () => {
    for (const [suffix, service] of [
      ["HTTP", "http"],
      ["HORIZON", "horizon"],
      ["SOROBAN", "soroban"],
      ["PAYMENT", "payment"],
    ] as const) {
      const doc = findEnvVarDoc(`MINDVAULT_${suffix}_TIMEOUT_MS`);
      expect(doc?.default).toBe(`${DEFAULT_TIMEOUTS[service]} (ms)`);
    }
  });

  it("documents the #606 fail-safe value table", () => {
    const doc = findEnvVarDoc("MINDVAULT_ALLOW_MAINNET");
    expect(doc?.values).toEqual([
      "unset/0/false/no/off → per-call-confirm",
      "1/true/yes → allow-all",
    ]);
  });
});

describe("docs/mcp-env-variables.md — staleness guard", () => {
  const docExists = (() => {
    try {
      readFileSync(docPath, "utf-8");
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!docExists)("lists every documented variable", () => {
    const doc = readFileSync(docPath, "utf-8");
    for (const entry of ENV_VAR_DOCS) {
      if (entry.name.includes("<TOOL>")) continue;
      expect(doc, `${entry.name} is missing from the generated page`).toContain(
        `\`${entry.name}\``,
      );
    }
  });

  it.skipIf(!docExists)("states the generated count", () => {
    const doc = readFileSync(docPath, "utf-8");
    expect(doc).toContain(`**${ENV_VAR_DOCS.length} variables** as of last generation.`);
  });
});
