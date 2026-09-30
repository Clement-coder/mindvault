/**
 * Sanitized debug bundle export (#675).
 *
 * When an agent or operator reports a problem, the useful facts are scattered:
 * which network and URLs the server resolved, what the startup diagnostics
 * said, whether the install checks pass, which profiles exist, the state-file
 * mode, the metrics counters, whether the catalog cache is fresh, and what the
 * last few audit-log entries recorded. Collecting them by hand means pasting
 * an environment dump into a ticket, which is exactly how secret keys leak.
 *
 * `mindvault_debug_bundle` gathers all of that into one schema-versioned
 * document that is safe to attach to a bug report by construction:
 *
 *   - Profiles are summarised as address plus flags; secret keys and publisher
 *     API keys are never read into the bundle.
 *   - Environment variables are limited to the MindVault, Stellar and network
 *     settings the server reads, and any whose name suggests a credential is
 *     masked. Public keys and contract ids are kept, since a bundle without
 *     them cannot explain a network or registry mismatch.
 *   - Audit-log entries are already redacted when written; the tail is read
 *     from the end of the file only and passed through the secret-key redactor
 *     again.
 *   - A final pass over the serialised document removes anything shaped like
 *     a Stellar secret key, whatever section it came from.
 *
 * The builder is pure (`buildDebugBundle` takes everything it reports as
 * input) so the sanitisation rules are unit-testable without a file system or
 * a running server; `debugBundleTool` is the thin entry point that collects
 * the inputs from the runtime.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

import { resolveRotationConfig } from "./auditLogRotation.js";
import { isAuditLogEnabled } from "./auditLog.js";
import { catalogCacheLabel, getCatalogCacheConfig, getCatalogSnapshot } from "./catalogCache.js";
import { buildConfig, type McpConfig } from "./config.js";
import { collectStartupDiagnostics, redactSecrets, type StartupDiagnostic } from "./diagnostics.js";
import { readOnlyModeEnabled } from "./readOnlyMode.js";
import { verifyInstall, type InstallCheck } from "./verifyInstall.js";
import { checkStatePermissions, type StatePermissionResult } from "./stateBackup.js";
import {
  DEBUG_BUNDLE_DEFAULT_AUDIT_LINES,
  DEBUG_BUNDLE_MAX_AUDIT_LINES,
  DEBUG_BUNDLE_SCHEMA,
  SERVER_VERSION,
} from "./debugBundleSchema.js";

export {
  DEBUG_BUNDLE_DEFAULT_AUDIT_LINES,
  DEBUG_BUNDLE_MAX_AUDIT_LINES,
  DEBUG_BUNDLE_OUTPUT_SCHEMA,
  DEBUG_BUNDLE_SCHEMA,
} from "./debugBundleSchema.js";
import type { MetricsSnapshot } from "./metrics.js";
import type { WalletProfile } from "./profiles.js";
import { activeProfileName, metrics, MOCK, profiles, STATE_DIR, STATE_FILE } from "./runtime.js";

/** How much of the end of the audit log is read to find the tail. */
const AUDIT_TAIL_READ_BYTES = 256 * 1024;

/** The value that replaces anything the bundle refuses to carry. */
export const REDACTED = "[REDACTED]";

/**
 * Environment variables the server reads, by prefix or exact name. Nothing
 * outside this set is reported, so an unrelated `AWS_SECRET_ACCESS_KEY` in the
 * parent shell never reaches the bundle even in masked form.
 */
const ENV_PREFIXES = ["MINDVAULT_", "STELLAR_", "SOROBAN_", "HORIZON_", "VAULT_REGISTRY_"];
const ENV_EXACT = new Set(["NETWORK", "SPONSORED_ACCOUNT_URL", "USDC_CONTRACT_ID", "NODE_ENV"]);

/** Variable names that carry a credential, whatever their value looks like. */
const SECRET_NAME = /SECRET|KEY|TOKEN|PASS|PRIVATE|CREDENTIAL|SIGNING/i;

/** Stellar secret keys: 'S' + 55 base32 characters. */
const STELLAR_SECRET_KEY = /S[A-Z2-7]{55}/g;

export interface DebugBundleOptions {
  /** Audit-log entries to include, newest last. 0 disables the section. */
  auditLogLines: number;
  /** Whether to include the (masked) environment section. */
  includeEnvironment: boolean;
}

export interface ProfileSummary {
  name: string;
  active: boolean;
  hasWallet: boolean;
  /** The wallet's public key; never its secret. */
  publicKey: string | null;
  hasApiKey: boolean;
}

export interface AuditLogTail {
  enabled: boolean;
  /** Configured file path, or null when only stderr logging is in use. */
  filePath: string | null;
  exists: boolean;
  /** Entries requested by the caller. */
  requested: number;
  /** Parsed JSONL entries, oldest first. Unparseable lines are kept as `{ raw }`. */
  entries: Array<Record<string, unknown>>;
}

export interface CatalogCacheStatus {
  ttlMs: number;
  maxAgeMs: number;
  snapshot: {
    present: boolean;
    savedAt: string | null;
    resourceCount: number;
    label: string | null;
  };
}

/** Everything the bundle reports, gathered by the caller. */
export interface DebugBundleInput {
  env: NodeJS.ProcessEnv;
  now: Date;
  serverVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  mock: boolean;
  readOnly: boolean;
  config: McpConfig;
  diagnostics: readonly StartupDiagnostic[];
  installChecks: readonly InstallCheck[];
  installOk: boolean;
  profiles: Record<string, WalletProfile>;
  activeProfile: string;
  stateDir: string;
  stateFile: string;
  statePermissions: StatePermissionResult;
  metrics: MetricsSnapshot;
  catalogCache: CatalogCacheStatus;
  auditLog: AuditLogTail;
}

export interface DebugBundle {
  schema: typeof DEBUG_BUNDLE_SCHEMA;
  generatedAt: string;
  sanitized: {
    /** Masked environment variable names, so a reader knows what was withheld. */
    maskedEnvironment: string[];
    /** The rules applied, for a reader who wants to know what cannot be here. */
    rules: string[];
  };
  runtime: {
    serverVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    mockMode: boolean;
    readOnlyMode: boolean;
  };
  config: {
    stellarNetwork: string;
    x402Network: string;
    baseUrl: string;
    registryContractId: string;
    registryNetworkPassphrase: string;
    sponsoredAccountUrl: string;
    horizonUrl: string;
    sorobanRpcUrl: string;
  };
  environment: Record<string, string> | null;
  diagnostics: StartupDiagnostic[];
  install: { ok: boolean; checks: InstallCheck[] };
  profiles: { active: string; entries: ProfileSummary[] };
  state: { dir: string; file: string; permissions: StatePermissionResult };
  metrics: MetricsSnapshot;
  catalogCache: CatalogCacheStatus;
  auditLog: AuditLogTail;
}

const SANITIZATION_RULES = [
  "Wallet secret keys and publisher API keys are never read into the bundle; profiles carry the public key only.",
  "Only MindVault, Stellar, network and registry environment variables are listed; names that look like credentials are masked.",
  "Audit-log entries are the already-redacted lines the server wrote, read from the end of the file only.",
  "Anything shaped like a Stellar secret key is replaced wherever it appears in the serialised document.",
];

/** Keep the MindVault-related variables, masking any whose name looks like a credential. */
export function sanitizeEnvironment(env: NodeJS.ProcessEnv): {
  environment: Record<string, string>;
  masked: string[];
} {
  const environment: Record<string, string> = {};
  const masked: string[] = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined) continue;
    if (!ENV_EXACT.has(name) && !ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (SECRET_NAME.test(name)) {
      environment[name] = REDACTED;
      masked.push(name);
    } else {
      environment[name] = redactSecrets(value);
    }
  }
  return { environment, masked };
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

/**
 * Parse the last `count` JSONL lines of an audit log, oldest first. Every
 * line goes through the secret-key redactor before parsing; a line that is
 * not JSON is kept verbatim (redacted) under `raw` rather than dropped, since
 * a corrupted log is itself a diagnostic.
 */
export function parseAuditTail(text: string, count: number): Array<Record<string, unknown>> {
  if (count <= 0) return [];
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-count).map((line) => {
    const safe = redactSecrets(line);
    try {
      const parsed = JSON.parse(safe);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { raw: safe };
    } catch {
      return { raw: safe };
    }
  });
}

/** Read at most the last `AUDIT_TAIL_READ_BYTES` of a file as UTF-8. */
function readFileTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, AUDIT_TAIL_READ_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf-8");
    // A window that starts mid-line would yield one truncated first entry.
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** Collect the audit-log tail from the configured file, if any. */
export function collectAuditTail(env: NodeJS.ProcessEnv, count: number): AuditLogTail {
  const rotation = resolveRotationConfig(env);
  const filePath = rotation?.path ?? null;
  const exists = filePath !== null && existsSync(filePath);
  return {
    enabled: isAuditLogEnabled(),
    filePath,
    exists,
    requested: count,
    entries: exists && count > 0 ? parseAuditTail(readFileTail(filePath), count) : [],
  };
}

/** Catalog cache configuration plus what the in-memory snapshot holds. */
export function collectCatalogCacheStatus(now: Date): CatalogCacheStatus {
  const config = getCatalogCacheConfig();
  const snapshot = getCatalogSnapshot(now.getTime());
  return {
    ttlMs: config.ttlMs,
    maxAgeMs: config.maxAgeMs,
    snapshot: {
      present: snapshot !== null,
      savedAt: snapshot ? new Date(snapshot.savedAtMs).toISOString() : null,
      resourceCount: snapshot ? snapshot.resources.length : 0,
      label: snapshot ? catalogCacheLabel(snapshot.savedAtMs, now.getTime()) : null,
    },
  };
}

/**
 * Assemble the bundle from already-gathered inputs and apply the final
 * secret-key sweep over the serialised document. Pure and deterministic for a
 * fixed input.
 */
export function buildDebugBundle(
  input: DebugBundleInput,
  options: DebugBundleOptions,
): DebugBundle {
  const { environment, masked } = sanitizeEnvironment(input.env);
  const bundle: DebugBundle = {
    schema: DEBUG_BUNDLE_SCHEMA,
    generatedAt: input.now.toISOString(),
    sanitized: { maskedEnvironment: masked, rules: SANITIZATION_RULES },
    runtime: {
      serverVersion: input.serverVersion,
      nodeVersion: input.nodeVersion,
      platform: input.platform,
      arch: input.arch,
      mockMode: input.mock,
      readOnlyMode: input.readOnly,
    },
    config: {
      stellarNetwork: input.config.stellarNetwork,
      x402Network: input.config.x402Network,
      baseUrl: input.config.baseUrl,
      registryContractId: input.config.registryContractId,
      registryNetworkPassphrase: input.config.registryNetworkPassphrase,
      sponsoredAccountUrl: input.config.sponsoredAccountUrl,
      horizonUrl: input.config.horizonUrl,
      sorobanRpcUrl: input.config.sorobanRpcUrl,
    },
    environment: options.includeEnvironment ? environment : null,
    diagnostics: [...input.diagnostics],
    install: { ok: input.installOk, checks: [...input.installChecks] },
    profiles: {
      active: input.activeProfile,
      entries: summarizeProfiles(input.profiles, input.activeProfile),
    },
    state: { dir: input.stateDir, file: input.stateFile, permissions: input.statePermissions },
    metrics: input.metrics,
    catalogCache: input.catalogCache,
    auditLog: {
      ...input.auditLog,
      entries:
        options.auditLogLines > 0 ? input.auditLog.entries.slice(-options.auditLogLines) : [],
      requested: options.auditLogLines,
    },
  };
  // Belt and braces: whatever a section carried, nothing shaped like a secret
  // key survives serialisation.
  return JSON.parse(JSON.stringify(bundle).replace(STELLAR_SECRET_KEY, "S***REDACTED***"));
}

/** Read and bound the tool arguments; the validator has already typed them. */
export function normalizeDebugBundleOptions(args?: Record<string, unknown>): DebugBundleOptions {
  const rawLines = args?.auditLogLines;
  const auditLogLines =
    typeof rawLines === "number" && Number.isInteger(rawLines)
      ? Math.max(0, Math.min(DEBUG_BUNDLE_MAX_AUDIT_LINES, rawLines))
      : DEBUG_BUNDLE_DEFAULT_AUDIT_LINES;
  const includeEnvironment = args?.includeEnvironment !== false;
  return { auditLogLines, includeEnvironment };
}

/** Tool entrypoint: gather the inputs from the running server and return JSON. */
export function debugBundleTool(args?: Record<string, unknown>, now: Date = new Date()): string {
  const options = normalizeDebugBundleOptions(args);
  const env = process.env;
  const install = verifyInstall(env);
  const bundle = buildDebugBundle(
    {
      env,
      now,
      serverVersion: SERVER_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      mock: MOCK,
      readOnly: readOnlyModeEnabled(env),
      config: buildConfig(env),
      diagnostics: collectStartupDiagnostics(env),
      installChecks: install.checks,
      installOk: install.ok,
      profiles,
      activeProfile: activeProfileName,
      stateDir: STATE_DIR,
      stateFile: STATE_FILE,
      statePermissions: checkStatePermissions(),
      metrics: metrics.snapshot(),
      catalogCache: collectCatalogCacheStatus(now),
      auditLog: collectAuditTail(env, options.auditLogLines),
    },
    options,
  );
  return JSON.stringify(bundle, null, 2);
}
