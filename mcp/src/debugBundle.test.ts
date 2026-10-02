/**
 * Sanitized debug bundle (#675).
 *
 * The bundle exists to be pasted into tickets, so the tests are mostly about
 * what must never be in it: a secret key placed in the environment, in a
 * profile, and in an audit-log line has to be absent from the output, while
 * the public key and contract id that make a bundle useful have to survive.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildConfig } from "./config.js";
import {
  buildDebugBundle,
  collectAuditTail,
  DEBUG_BUNDLE_DEFAULT_AUDIT_LINES,
  DEBUG_BUNDLE_MAX_AUDIT_LINES,
  DEBUG_BUNDLE_OUTPUT_SCHEMA,
  DEBUG_BUNDLE_SCHEMA,
  normalizeDebugBundleOptions,
  parseAuditTail,
  REDACTED,
  sanitizeEnvironment,
  summarizeProfiles,
  type DebugBundleInput,
} from "./debugBundle.js";
import { setAuditLogEnabled } from "./auditLog.js";

const SECRET = "SBSUZLBO4XQZBR2DKQTI2SKGG7YGEFEAYLE4NLIQ6GGGMGEUOJWNDXHE";
const PUBLIC = "GDNKEGATDMCUJWGAJKVCUPOLJUYX6XJMQCWCF2Q3PXLPQBHPAVQ4MX2A";
const CONTRACT = "CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4";

function input(overrides: Partial<DebugBundleInput> = {}): DebugBundleInput {
  const env: NodeJS.ProcessEnv = {
    STELLAR_NETWORK: "testnet",
    VAULT_REGISTRY_CONTRACT_ID: CONTRACT,
    MINDVAULT_AGENT_SECRET: SECRET,
    MINDVAULT_API_KEY: "mv_live_0123456789abcdef0123456789abcdef",
    MINDVAULT_AUDIT_LOG: "1",
    AWS_SECRET_ACCESS_KEY: "unrelated-and-must-not-appear",
    PATH: "/usr/bin",
  };
  return {
    env,
    now: new Date("2026-09-25T12:00:00.000Z"),
    serverVersion: "1.0.0",
    nodeVersion: "v20.11.0",
    platform: "linux",
    arch: "x64",
    mock: true,
    readOnly: false,
    config: buildConfig(env),
    diagnostics: [],
    installChecks: [{ name: "node_version", ok: true, detail: "Node.js v20.11.0 ✓" }],
    installOk: true,
    profiles: {
      default: { wallet: { publicKey: PUBLIC, secretKey: SECRET }, apiKey: "mv_key_abc" },
      empty: {},
    },
    activeProfile: "default",
    stateDir: "/home/agent/.mindvault",
    stateFile: "/home/agent/.mindvault/state.json",
    statePermissions: {
      exists: true,
      mode: "0600",
      expectedMode: "0600",
      isSafe: true,
      message: "ok",
    },
    metrics: {
      enabled: false,
      since: null,
      toolDurationBudgetMs: null,
      totals: { calls: 0, errors: 0, budgetExceeded: 0 },
      payments: { attempts: 0, failures: 0 },
      tools: {},
    },
    catalogCache: {
      ttlMs: 1,
      maxAgeMs: 2,
      snapshot: { present: false, savedAt: null, resourceCount: 0, label: null },
    },
    auditLog: {
      enabled: true,
      filePath: "/tmp/audit.jsonl",
      exists: true,
      requested: 50,
      entries: [
        { toolName: "mindvault_buy", status: "success" },
        { toolName: "mindvault_setup_wallet", details: { leaked: SECRET } },
      ],
    },
    ...overrides,
  };
}

describe("sanitizeEnvironment", () => {
  it("keeps MindVault settings, masks credential-like names, drops everything else", () => {
    const { environment, masked } = sanitizeEnvironment(input().env);

    expect(environment.STELLAR_NETWORK).toBe("testnet");
    expect(environment.VAULT_REGISTRY_CONTRACT_ID).toBe(CONTRACT);
    expect(environment.MINDVAULT_AGENT_SECRET).toBe(REDACTED);
    expect(environment.MINDVAULT_API_KEY).toBe(REDACTED);
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("PATH");
    expect(masked).toEqual(["MINDVAULT_AGENT_SECRET", "MINDVAULT_API_KEY"]);
  });

  it("redacts a secret key that was put in a non-secret variable", () => {
    const { environment } = sanitizeEnvironment({ MINDVAULT_URL: `https://x?${SECRET}` });
    expect(environment.MINDVAULT_URL).not.toContain(SECRET);
    expect(environment.MINDVAULT_URL).toContain("REDACTED");
  });
});

describe("summarizeProfiles", () => {
  it("reports addresses and flags without key material", () => {
    const entries = summarizeProfiles(input().profiles, "default");
    expect(entries).toEqual([
      { name: "default", active: true, hasWallet: true, publicKey: PUBLIC, hasApiKey: true },
      { name: "empty", active: false, hasWallet: false, publicKey: null, hasApiKey: false },
    ]);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    expect(JSON.stringify(entries)).not.toContain("mv_key_abc");
  });
});

describe("parseAuditTail", () => {
  it("returns the last N parsed entries, oldest first, redacting each line", () => {
    const lines = [
      JSON.stringify({ toolName: "a" }),
      "not json at all",
      JSON.stringify({ toolName: "b", secret: SECRET }),
      JSON.stringify({ toolName: "c" }),
    ].join("\n");

    const tail = parseAuditTail(lines + "\n", 3);

    expect(tail.map((e) => e.toolName ?? e.raw)).toEqual(["not json at all", "b", "c"]);
    expect(JSON.stringify(tail)).not.toContain(SECRET);
  });

  it("returns nothing for a zero count", () => {
    expect(parseAuditTail("{}\n", 0)).toEqual([]);
  });
});

describe("collectAuditTail", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    setAuditLogEnabled(false);
  });

  it("reads the configured file's tail and reports absence honestly", () => {
    dir = mkdtempSync(join(tmpdir(), "mindvault-bundle-"));
    const file = join(dir, "audit.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ toolName: "x" })}\n${JSON.stringify({ toolName: "y" })}\n`,
    );
    setAuditLogEnabled(true);

    const present = collectAuditTail({ MINDVAULT_AUDIT_LOG_FILE: file }, 1);
    expect(present).toMatchObject({ enabled: true, filePath: file, exists: true, requested: 1 });
    expect(present.entries).toEqual([{ toolName: "y" }]);

    const missing = collectAuditTail({ MINDVAULT_AUDIT_LOG_FILE: join(dir, "nope.jsonl") }, 5);
    expect(missing.exists).toBe(false);
    expect(missing.entries).toEqual([]);

    const unconfigured = collectAuditTail({}, 5);
    expect(unconfigured.filePath).toBeNull();
    expect(unconfigured.entries).toEqual([]);
  });
});

describe("buildDebugBundle", () => {
  it("never carries the secret placed in env, profile, and audit log; keeps public identifiers", () => {
    const bundle = buildDebugBundle(input(), { auditLogLines: 50, includeEnvironment: true });
    const text = JSON.stringify(bundle);

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("mv_key_abc");
    expect(text).not.toContain("mv_live_");
    expect(text).not.toContain("unrelated-and-must-not-appear");
    expect(text).toContain(PUBLIC);
    expect(text).toContain(CONTRACT);
    expect(bundle.auditLog.entries[1]).toEqual({
      toolName: "mindvault_setup_wallet",
      details: { leaked: "S***REDACTED***" },
    });
  });

  it("is deterministic for a fixed input and matches its advertised schema", () => {
    const a = buildDebugBundle(input(), { auditLogLines: 50, includeEnvironment: true });
    const b = buildDebugBundle(input(), { auditLogLines: 50, includeEnvironment: true });
    expect(a).toEqual(b);
    expect(a.schema).toBe(DEBUG_BUNDLE_SCHEMA);
    expect(a.generatedAt).toBe("2026-09-25T12:00:00.000Z");
    for (const key of DEBUG_BUNDLE_OUTPUT_SCHEMA.required) {
      expect(a, `bundle has ${key}`).toHaveProperty(key);
    }
    expect(a.sanitized.maskedEnvironment).toEqual(["MINDVAULT_AGENT_SECRET", "MINDVAULT_API_KEY"]);
    expect(a.sanitized.rules.length).toBeGreaterThan(0);
  });

  it("honours includeEnvironment=false and the audit line bound", () => {
    const bundle = buildDebugBundle(input(), { auditLogLines: 1, includeEnvironment: false });
    expect(bundle.environment).toBeNull();
    expect(bundle.auditLog.requested).toBe(1);
    expect(bundle.auditLog.entries).toHaveLength(1);
    expect(bundle.auditLog.entries[0].toolName).toBe("mindvault_setup_wallet");

    const none = buildDebugBundle(input(), { auditLogLines: 0, includeEnvironment: true });
    expect(none.auditLog.entries).toEqual([]);
  });
});

describe("normalizeDebugBundleOptions", () => {
  it("defaults, clamps, and reads the flags", () => {
    expect(normalizeDebugBundleOptions()).toEqual({
      auditLogLines: DEBUG_BUNDLE_DEFAULT_AUDIT_LINES,
      includeEnvironment: true,
    });
    expect(normalizeDebugBundleOptions({ auditLogLines: 10_000 }).auditLogLines).toBe(
      DEBUG_BUNDLE_MAX_AUDIT_LINES,
    );
    expect(normalizeDebugBundleOptions({ auditLogLines: -3 }).auditLogLines).toBe(0);
    expect(normalizeDebugBundleOptions({ includeEnvironment: false }).includeEnvironment).toBe(
      false,
    );
  });
});
