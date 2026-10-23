/**
 * Redacted support-bundle export for a single incident (#1038).
 *
 * When a tool call fails, the facts that explain it are scattered: the audit
 * log holds the call's `start`, its network requests, and its `success` or
 * `error`; the profile the call ran under says which wallet and API key were
 * configured; the metrics snapshot says how the server has been behaving; and
 * the network entries carry the request traces. Collecting them by hand means
 * grepping a whole log and pasting the result into a ticket, which is how
 * wallet secrets and unrelated user data leak.
 *
 * `mindvault_support_bundle` gathers only the material that belongs to one
 * incident into one schema-versioned document that is safe to attach. An
 * incident is identified by its correlation ID (#572): every audit entry the
 * server wrote under a tool call carries that ID, so a support bundle is
 * exactly the lines whose `correlationId` equals the requested incident, and
 * nothing else. Anything an unrelated call logged is out of scope by
 * construction.
 *
 * The bundle is safe by construction rather than by pattern matching alone:
 *
 *   - Profiles are summarised as address plus flags; secret keys and publisher
 *     API keys are never read into the bundle.
 *   - Matched audit and network entries are passed through the object redactor,
 *     so credential-named fields are masked and long opaque strings are
 *     stripped even if a caller logged them by mistake.
 *   - A final sweep over the serialised document removes anything shaped like a
 *     Stellar secret key, whatever section it came from.
 *
 * Public keys, contract ids and network ids are kept on purpose: a bundle that
 * hides them cannot show that a wallet is on one network and the registry on
 * another, which is the most common thing a bundle is opened to find.
 *
 * The builder is pure (`buildSupportBundle` takes everything it reports as
 * input) so the scoping and sanitisation rules are unit-testable without a
 * file system or a running server; `supportBundleTool` is the thin entry point
 * that collects the inputs from the runtime.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

import type { AuditLogEntry, NetworkAuditLog } from "./auditLog.js";
import { resolveRotationConfig } from "./auditLogRotation.js";
import { isCorrelationId } from "./correlation.js";
import { redactObject, redactSecrets } from "./redaction.js";
import type { MetricsSnapshot } from "./metrics.js";
import type { WalletProfile } from "./profiles.js";
import { activeProfileName, metrics, profiles } from "./runtime.js";

/** Schema version carried by every bundle. */
export const SUPPORT_BUNDLE_SCHEMA = "mindvault.support-bundle/v1";

/** Default number of matched audit entries the bundle carries. */
export const SUPPORT_BUNDLE_DEFAULT_AUDIT_LINES = 200;

/** Hard ceiling on matched audit entries, whatever the caller asks for. */
export const SUPPORT_BUNDLE_MAX_AUDIT_LINES = 500;

/** How much of the end of the audit log is read to find matching entries. */
const AUDIT_READ_BYTES = 512 * 1024;

/**
 * JSON Schema for the success bundle, advertised as the tool's `outputSchema`.
 *
 * Raw success shape: the caller wraps it with `withToolErrorVariant` before it
 * is advertised, exactly as `mindvault_debug_bundle` is handled.
 */
export const SUPPORT_BUNDLE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: SUPPORT_BUNDLE_SCHEMA },
    generatedAt: { type: "string", description: "ISO-8601 instant the bundle was produced." },
    incidentId: {
      type: "string",
      description: "The correlation ID or event id the bundle was scoped to.",
    },
    incident: {
      type: "object",
      description: "What scoping found: match counts and the covered time range.",
      properties: {
        incidentId: { type: "string" },
        correlationId: { type: "string", description: "The requested id, echoed verbatim." },
        isCorrelationId: {
          type: "boolean",
          description: "True when incidentId has the `mv-…` correlation-id shape.",
        },
        matchedEntries: { type: "integer" },
        matchedNetworkEntries: { type: "integer" },
        firstTimestamp: { type: ["string", "null"] },
        lastTimestamp: { type: ["string", "null"] },
        note: { type: ["string", "null"] },
      },
      required: [
        "incidentId",
        "correlationId",
        "isCorrelationId",
        "matchedEntries",
        "matchedNetworkEntries",
        "firstTimestamp",
        "lastTimestamp",
        "note",
      ],
    },
    logs: {
      type: "object",
      description: "Matched audit-log entries, oldest first, capped at auditLines.",
      properties: {
        requested: { type: "integer" },
        returned: { type: "integer" },
        truncated: { type: "boolean" },
        entries: { type: "array", items: { type: "object" } },
      },
      required: ["requested", "returned", "truncated", "entries"],
    },
    metrics: {
      type: "object",
      description: "The mindvault_metrics snapshot; enabled=false when metrics are off.",
    },
    profiles: {
      type: "object",
      properties: {
        active: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              active: { type: "boolean" },
              hasWallet: { type: "boolean" },
              publicKey: { type: ["string", "null"] },
              hasApiKey: { type: "boolean" },
            },
            required: ["name", "active", "hasWallet", "publicKey", "hasApiKey"],
          },
        },
      },
      required: ["active", "entries"],
    },
    traces: {
      type: "object",
      description: "Matched network-audit entries (request traces), oldest first.",
      properties: {
        returned: { type: "integer" },
        entries: { type: "array", items: { type: "object" } },
      },
      required: ["returned", "entries"],
    },
    redaction: {
      type: "object",
      description: "What was withheld and the rules that decided it.",
      properties: {
        maskedFields: { type: "array", items: { type: "string" } },
        rules: { type: "array", items: { type: "string" } },
      },
      required: ["maskedFields", "rules"],
    },
  },
  required: [
    "schema",
    "generatedAt",
    "incidentId",
    "incident",
    "logs",
    "metrics",
    "profiles",
    "traces",
    "redaction",
  ],
} as const;

/** Address-and-flags view of a profile; no key material is copied. */
export interface ProfileSummary {
  name: string;
  active: boolean;
  hasWallet: boolean;
  /** The wallet's public key; never its secret. */
  publicKey: string | null;
  hasApiKey: boolean;
}

/** The incident material the caller gathered from the runtime. */
export interface SupportBundleInput {
  /** The requested incident scope. Blank values are rejected by the builder. */
  incidentId: string;
  now: Date;
  /** Matched audit-log entries, unscoped: the builder filters by correlationId. */
  auditEntries: readonly AuditLogEntry[];
  /** Matched network-audit entries, unscoped: the builder filters by correlationId. */
  networkEntries?: readonly NetworkAuditLog[];
  metrics: MetricsSnapshot;
  profiles: Record<string, WalletProfile>;
  activeProfile: string;
  /** True when the bounded disk read omitted older audit history. */
  auditTruncated?: boolean;
}

/** Bounds applied to the audit section of the bundle. */
export interface SupportBundleOptions {
  /** Matched audit entries to include. Clamped to 0..SUPPORT_BUNDLE_MAX_AUDIT_LINES. */
  auditLines: number;
}

export interface SupportBundle {
  schema: typeof SUPPORT_BUNDLE_SCHEMA;
  generatedAt: string;
  incidentId: string;
  incident: {
    incidentId: string;
    correlationId: string;
    isCorrelationId: boolean;
    matchedEntries: number;
    matchedNetworkEntries: number;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    note: string | null;
  };
  logs: {
    requested: number;
    returned: number;
    truncated: boolean;
    entries: Array<Record<string, unknown>>;
  };
  metrics: MetricsSnapshot;
  profiles: { active: string; entries: ProfileSummary[] };
  traces: { returned: number; entries: Array<Record<string, unknown>> };
  redaction: { maskedFields: string[]; rules: string[] };
}

/** The rules the bundle applies, stated for a reader who wants to know why. */
const REDACTION_RULES = [
  "Only audit and network entries whose correlationId equals the incident id are included; unrelated calls and users are out of scope.",
  "Wallet secret keys and publisher API keys are never read into the bundle; profiles carry the public key only.",
  "Every matched audit and network entry passes through the object redactor: credential-named fields are masked and long opaque strings are stripped.",
  "Anything shaped like a Stellar secret key is replaced wherever it appears in the serialised document.",
];

/**
 * Normalise the requested audit line count: a non-integer falls back to the
 * default, and an integer is clamped to `0..SUPPORT_BUNDLE_MAX_AUDIT_LINES`.
 * A negative count clamps to 0, which omits the audit section.
 */
function resolveAuditLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return SUPPORT_BUNDLE_DEFAULT_AUDIT_LINES;
  }
  return Math.max(0, Math.min(SUPPORT_BUNDLE_MAX_AUDIT_LINES, value));
}

/** Address-and-flags view of every profile; no key material is copied. */
export function summarizeProfiles(
  all: Record<string, WalletProfile>,
  active: string,
): ProfileSummary[] {
  return Object.keys(all)
    .sort()
    .map((name) => {
      const profile = all[name];
      return {
        name,
        active: name === active,
        hasWallet: !!profile.wallet,
        publicKey: profile.wallet ? profile.wallet.publicKey : null,
        hasApiKey: !!profile.apiKey,
      };
    });
}

/** A timestamp that sorts chronologically, or an empty string when unusable. */
function timestampOf(entry: { timestamp?: unknown }): string {
  return typeof entry.timestamp === "string" ? entry.timestamp : "";
}

/** A correlation id that sorts as a stable tie-breaker. */
function correlationOf(entry: { correlationId?: unknown }): string {
  return typeof entry.correlationId === "string" ? entry.correlationId : "";
}

/** True when an entry carries a network-request shape (`method`/`source`). */
function isNetworkEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.method === "string" || typeof entry.source === "string";
}

/** Bounds applied to the audit section of the bundle. */
export function normalizeSupportBundleOptions(
  args?: Record<string, unknown>,
): SupportBundleOptions {
  return { auditLines: resolveAuditLines(args?.auditLines) };
}

/** Read at most the last `AUDIT_READ_BYTES` of a JSONL file as UTF-8 lines. */
function readAuditLines(path: string): { lines: string[]; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, AUDIT_READ_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf-8");
    // A window that starts mid-line would yield one truncated first line.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    return {
      lines: text.split("\n").filter((line) => line.trim().length > 0),
      truncated: length < size,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Collect the audit log from the configured file, scoped to `incidentId`.
 *
 * Only the last 512 KiB of the file is read, the same bound the debug bundle
 * uses, so a multi-gigabyte log cannot be walked. Each line is redacted before
 * parsing. Returns the matched entries oldest first plus whether the read was
 * truncated by the byte bound.
 */
export function collectIncidentAuditEntries(
  env: NodeJS.ProcessEnv,
  incidentId: string,
): { entries: AuditLogEntry[]; truncated: boolean } {
  const rotation = resolveRotationConfig(env);
  const filePath = rotation?.path ?? null;
  if (filePath === null || !existsSync(filePath)) {
    return { entries: [], truncated: false };
  }
  const { lines, truncated } = readAuditLines(filePath);
  const entries: AuditLogEntry[] = [];
  for (const line of lines) {
    const safe = redactSecrets(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(safe);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const entry = parsed as AuditLogEntry;
    if (entry.correlationId === incidentId) entries.push(entry);
  }
  return { entries, truncated };
}

/**
 * Assemble the bundle from already-gathered inputs. Pure and deterministic for
 * a fixed input: matched entries are sorted by timestamp then correlation id,
 * key order is fixed, and the final secret-key sweep runs over the serialised
 * document.
 *
 * @throws Error when `incidentId` is missing or blank — an explicit incident
 * scope is required, so an unscooped dump is never produced by accident.
 */
export function buildSupportBundle(
  input: SupportBundleInput,
  options?: SupportBundleOptions,
): SupportBundle {
  const incidentId = typeof input.incidentId === "string" ? input.incidentId.trim() : "";
  if (incidentId.length === 0) {
    throw new Error(
      "incidentId is required: pass the correlation id (mv-…) from the failing tool call so the bundle can be scoped to one incident.",
    );
  }

  const auditLines = options
    ? Math.max(0, Math.min(SUPPORT_BUNDLE_MAX_AUDIT_LINES, Math.trunc(options.auditLines)))
    : SUPPORT_BUNDLE_DEFAULT_AUDIT_LINES;

  const matched = (input.auditEntries ?? [])
    .filter((entry) => entry.correlationId === incidentId)
    .sort((a, b) => {
      const byTime = timestampOf(a).localeCompare(timestampOf(b));
      return byTime !== 0 ? byTime : correlationOf(a).localeCompare(correlationOf(b));
    });

  const matchedNetwork = (input.networkEntries ?? []).filter(
    (entry) => entry.correlationId === incidentId,
  );
  // Traces can also arrive as full audit entries that carry a network shape.
  const networkFromAudit = matched.filter((entry) =>
    isNetworkEntry(entry as unknown as Record<string, unknown>),
  );
  const traceSource = matchedNetwork.length > 0 ? matchedNetwork : networkFromAudit;

  const outgoing = auditLines > 0 ? matched.slice(-auditLines) : [];
  const exposed = [...outgoing, ...traceSource] as unknown as Array<Record<string, unknown>>;

  const maskedFields = new Set<string>();
  const collectMasked = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectMasked(item, `${prefix}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child === "[REDACTED]") {
        maskedFields.add(path);
        continue;
      }
      collectMasked(child, path);
    }
  };
  collectMasked(exposed, "");

  const timestamps = matched
    .map(timestampOf)
    .filter((value) => value.length > 0)
    .sort();
  const note =
    matched.length === 0
      ? "No audit entries matched this incident id within the bounded read window."
      : null;

  const bundle: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    generatedAt: input.now.toISOString(),
    incidentId,
    incident: {
      incidentId,
      correlationId: incidentId,
      isCorrelationId: isCorrelationId(incidentId),
      matchedEntries: matched.length,
      matchedNetworkEntries: traceSource.length,
      firstTimestamp: timestamps.length > 0 ? timestamps[0] : null,
      lastTimestamp: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
      note,
    },
    logs: {
      requested: auditLines,
      returned: outgoing.length,
      truncated: input.auditTruncated === true || matched.length > outgoing.length,
      entries: redactObject(outgoing) as unknown as Array<Record<string, unknown>>,
    },
    metrics: input.metrics,
    profiles: {
      active: input.activeProfile,
      entries: summarizeProfiles(input.profiles, input.activeProfile),
    },
    traces: {
      returned: traceSource.length,
      entries: redactObject(traceSource) as unknown as Array<Record<string, unknown>>,
    },
    redaction: { maskedFields: [...maskedFields].sort(), rules: REDACTION_RULES },
  };

  // Belt and braces: whatever a section carried, nothing shaped like a secret
  // key survives serialisation.
  return JSON.parse(JSON.stringify(bundle).replace(/S[A-Z2-7]{55}/g, "S***REDACTED***"));
}

/** Read and bound the tool arguments; the validator has already typed them. */
export function supportBundleTool(args: Record<string, unknown>): string {
  const incidentId = typeof args.incidentId === "string" ? args.incidentId.trim() : "";
  if (incidentId.length === 0) {
    throw new Error(
      "incidentId is required: pass the correlation id (mv-…) from the failing tool call so the bundle can be scoped to one incident.",
    );
  }
  const options = normalizeSupportBundleOptions(args);
  const env = process.env;
  const audit = collectIncidentAuditEntries(env, incidentId);
  const bundle = buildSupportBundle(
    {
      incidentId,
      now: new Date(),
      auditEntries: audit.entries,
      networkEntries: audit.entries as unknown as NetworkAuditLog[],
      metrics: metrics.snapshot(),
      profiles,
      activeProfile: activeProfileName,
      auditTruncated: audit.truncated,
    },
    options,
  );
  return JSON.stringify(bundle, null, 2);
}
