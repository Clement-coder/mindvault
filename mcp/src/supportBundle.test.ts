/**
 * Redacted single-incident support bundle (#1038).
 *
 * The bundle exists to be attached to a support ticket, so the tests are
 * mostly about scope and what must never be in it: an entry for another
 * correlation id has to be absent, a secret key placed in a profile and in an
 * audit-log line has to be absent from the serialised output, and the public
 * key and contract id that make a bundle useful have to survive.
 */
import { describe, expect, it } from "vitest";

import type { AuditLogEntry, NetworkAuditLog } from "./auditLog.js";
import { newCorrelationId } from "./correlation.js";
import { checkOutput } from "./outputValidation.js";
import {
  buildSupportBundle,
  SUPPORT_BUNDLE_MAX_AUDIT_LINES,
  SUPPORT_BUNDLE_OUTPUT_SCHEMA,
  SUPPORT_BUNDLE_SCHEMA,
  normalizeSupportBundleOptions,
  type SupportBundleInput,
} from "./supportBundle.js";

const SECRET = "SBSUZLBO4XQZBR2DKQTI2SKGG7YGEFEAYLE4NLIQ6GGGMGEUOJWNDXHE";
const PUBLIC = "GDNKEGATDMCUJWGAJKVCUPOLJUYX6XJMQCWCF2Q3PXLPQBHPAVQ4MX2A";
const CONTRACT = "CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4";

const INCIDENT = newCorrelationId(
  () => 1_700_000_000_000,
  () => 0.5,
);
const OTHER = newCorrelationId(
  () => 1_700_000_000_000,
  () => 0.25,
);

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: "2026-09-25T12:00:00.000Z",
    correlationId: INCIDENT,
    toolName: "mindvault_buy",
    status: "success",
    ...overrides,
  };
}

function input(overrides: Partial<SupportBundleInput> = {}): SupportBundleInput {
  return {
    incidentId: INCIDENT,
    now: new Date("2026-09-25T12:01:00.000Z"),
    auditEntries: [
      entry({ timestamp: "2026-09-25T12:00:00.000Z", status: "start" }),
      entry({
        timestamp: "2026-09-25T12:00:01.000Z",
        resourceId: CONTRACT,
        details: { leaked: SECRET },
      }),
    ],
    networkEntries: [
      {
        timestamp: "2026-09-25T12:00:01.500Z",
        correlationId: INCIDENT,
        method: "GET",
        endpoint: `https://soroban-testnet.stellar.org/contracts/${CONTRACT}`,
        status: 200,
        duration: 42,
        source: "soroban",
      } as NetworkAuditLog,
    ],
    metrics: {
      enabled: false,
      since: null,
      toolDurationBudgetMs: null,
      totals: { calls: 0, errors: 0, budgetExceeded: 0 },
      payments: { attempts: 0, failures: 0 },
      tools: {},
    },
    profiles: {
      default: { wallet: { publicKey: PUBLIC, secretKey: SECRET }, apiKey: "mv_key_abc" },
      empty: {},
    },
    activeProfile: "default",
    ...overrides,
  };
}

describe("buildSupportBundle scoping", () => {
  it("rejects a missing or blank incidentId", () => {
    expect(() => buildSupportBundle(input({ incidentId: "" }))).toThrow(/incidentId is required/);
    expect(() => buildSupportBundle(input({ incidentId: "   " }))).toThrow(
      /incidentId is required/,
    );
  });

  it("never includes entries for another correlation id", () => {
    const bundle = buildSupportBundle(
      input({
        auditEntries: [
          entry({ correlationId: INCIDENT, toolName: "mine" }),
          entry({ correlationId: OTHER, toolName: "someone-else" }),
        ],
      }),
      { auditLines: 200 },
    );
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("someone-else");
    expect(text).not.toContain(OTHER);
    expect(bundle.incident.matchedEntries).toBe(1);
    expect(bundle.logs.entries).toHaveLength(1);
  });

  it("returns an empty entries array plus a note when nothing matches", () => {
    const bundle = buildSupportBundle(
      input({ auditEntries: [entry({ correlationId: OTHER })], networkEntries: [] }),
      { auditLines: 200 },
    );
    expect(bundle.logs.entries).toEqual([]);
    expect(bundle.incident.matchedEntries).toBe(0);
    expect(bundle.incident.note).not.toBeNull();
    expect(bundle.traces.entries).toEqual([]);
  });
});

describe("buildSupportBundle redaction", () => {
  it("never carries a secret from a profile or an audit line; keeps public identifiers", () => {
    const bundle = buildSupportBundle(input(), { auditLines: 200 });
    const text = JSON.stringify(bundle);

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("mv_key_abc");
    expect(text).toContain(PUBLIC);
    expect(bundle.incident.matchedEntries).toBe(2);
    expect(text).not.toContain(SECRET);
    expect((bundle.logs.entries[1] as { details: unknown }).details).toEqual({
      leaked: "[REDACTED]",
    });
    expect(bundle.redaction.rules.length).toBeGreaterThan(0);
  });
});

describe("buildSupportBundle determinism and bounds", () => {
  it("is deterministic for a fixed input and matches its advertised schema", () => {
    const a = buildSupportBundle(input(), { auditLines: 200 });
    const b = buildSupportBundle(input(), { auditLines: 200 });
    expect(a).toEqual(b);
    expect(a.schema).toBe(SUPPORT_BUNDLE_SCHEMA);
    expect(a.generatedAt).toBe("2026-09-25T12:01:00.000Z");
    for (const key of SUPPORT_BUNDLE_OUTPUT_SCHEMA.required) {
      expect(a, `bundle has ${key}`).toHaveProperty(key);
    }
    expect(
      checkOutput(SUPPORT_BUNDLE_OUTPUT_SCHEMA as unknown as Record<string, unknown>, a),
    ).toEqual({ valid: true });
  });

  it("clamps audit lines to the cap and honours the line bound", () => {
    const many = Array.from({ length: 600 }, (_, n) =>
      entry({
        timestamp: `2026-09-25T12:00:${String(n % 60).padStart(2, "0")}.000Z`,
        toolName: `t${n}`,
      }),
    );
    const clamped = normalizeSupportBundleOptions({ auditLines: 10_000 });
    expect(clamped.auditLines).toBe(SUPPORT_BUNDLE_MAX_AUDIT_LINES);
    expect(normalizeSupportBundleOptions({ auditLines: -5 }).auditLines).toBe(0);
    expect(normalizeSupportBundleOptions({}).auditLines).toBe(200);

    const bounded = buildSupportBundle(input({ auditEntries: many }), { auditLines: 5 });
    expect(bounded.logs.returned).toBe(5);
    expect(bounded.logs.truncated).toBe(true);

    const none = buildSupportBundle(input(), { auditLines: 0 });
    expect(none.logs.entries).toEqual([]);
  });

  it("reports a truncated flag when the disk read omitted older history", () => {
    const bundle = buildSupportBundle(input({ auditTruncated: true }), { auditLines: 200 });
    expect(bundle.logs.truncated).toBe(true);
  });
});
