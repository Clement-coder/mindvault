/**
 * On-chain preflight for the MindVault MCP server (#1054).
 *
 * Before an agent enables or exercises the on-chain MCP tools, three things
 * must line up locally: the configured vault-registry contract ID, the Stellar
 * network (and its x402 twin), and the resource schema version the caller
 * intends to use. Misconfiguration here used to surface only as an opaque
 * Soroban failure deep inside the first mutation. This module answers "is the
 * on-chain setup coherent?" up front, with an actionable remediation per
 * mismatch.
 *
 * Design constraints (mirroring verifyInstall.ts and diagnostics.ts):
 *   - Read-only and purely local: no I/O, no network, no process.exit — the
 *     deployed contract is never probed. Live reachability remains the job of
 *     `mindvault_registry_health` and `mindvault_check_bindings`.
 *   - {@link runOnchainPreflight} is a pure builder: every value arrives via
 *     the input object (env-derived by the caller), so it never reads
 *     `process.env` and is unit-testable with crafted inputs. It never throws.
 *   - {@link onchainPreflightTool} is the thin handler wrapper: it collects
 *     the current config with `buildConfig(process.env)` and returns the
 *     result as pretty-printed JSON.
 *   - {@link assertOnchainSetupReady} is the reusable gate: publish/register
 *     flows call it before committing to on-chain work so a malformed or
 *     missing contract ID (or an unrecognized network) fails fast with an
 *     actionable message instead of a distant RPC error.
 *
 * Check severity:
 *   - `fail` — the configuration is wrong and on-chain tools will not work.
 *   - `warn` — advisory (e.g. preset default in use, x402 mismatch that the
 *     server tolerates at startup, mainnet readiness note).
 *   - `pass` — nothing to fix.
 * `ready` is true when no check has `fail` status.
 */

import {
  inferNetworkFromX402,
  networks as registryNetworks,
  normalizeX402Network,
  parseStellarNetwork,
  X402_NETWORK_IDS,
  type StellarDeploymentNetwork,
} from "@mindvault/registry-client";
import { buildConfig } from "./config.js";
import { formatMainnetDiagnostics, mainnetAllowedFromEnv } from "./mainnetGuardrails.js";

/** Envelope discriminator for the preflight result payload. */
export const ONCHAIN_PREFLIGHT_SCHEMA = "mindvault.onchain-preflight/v1";

/**
 * Resource schema versions the installed vault-registry contract accepts.
 *
 * Source of truth: `contract/contracts/vault-registry/src/lib.rs` —
 * `RESOURCE_SCHEMA_VERSION = 7` (line 101) and
 * `PREVIOUS_RESOURCE_SCHEMA_VERSION = 6` (line 103). `resource_schema_version`
 * (lib.rs 5351) accepts a resource whose `schema_version` equals either value,
 * so the supported set is {6, 7}. The generated registry-client bindings
 * (`packages/registry-client/src/generated/index.ts`) expose the schema
 * version only as a per-record field, not as an exported constant, so the
 * values are mirrored here; update this list when the contract bumps
 * `RESOURCE_SCHEMA_VERSION` and drops the previous version.
 */
export const SUPPORTED_RESOURCE_SCHEMA_VERSIONS: readonly number[] = [6, 7];

/** StrKey contract ID format: 'C' followed by 55 base32 characters. */
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * Check names that {@link assertOnchainSetupReady} treats as locally fatal.
 * An x402/stellar mismatch is a `fail` in the report (payments will likely be
 * rejected by the facilitator) but is deliberately excluded here: the server
 * starts and non-payment tools work, exactly like the startup diagnostics,
 * which keep that mismatch at warning severity.
 */
const FATAL_CHECK_NAMES: ReadonlySet<string> = new Set(["contract_id", "stellar_network"]);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Severity of one preflight check. */
export type PreflightCheckStatus = "pass" | "warn" | "fail";

/** One local check outcome, in a stable order. */
export interface OnchainPreflightCheck {
  /** Short identifier, e.g. `contract_id`. */
  name: string;
  /** Severity: `pass`, `warn` (advisory), or `fail` (blocking). */
  status: PreflightCheckStatus;
  /** What was found — safe for agent-facing output (no secrets). */
  detail: string;
  /** How to fix it; empty string when the check passed. */
  remediation: string;
}

/** Where the configured contract ID came from. */
export type ContractIdSource = "env" | "preset" | "none";

/** Env-derived values the pure builder operates on. */
export interface OnchainPreflightInput {
  /**
   * Registry contract ID after resolution: `VAULT_REGISTRY_CONTRACT_ID` when
   * set, otherwise the network preset's default, otherwise `""`.
   */
  contractId: string;
  /**
   * Which source supplied `contractId`. Defaults to `"env"` when a non-empty
   * id is present and `"none"` when it is empty.
   */
  contractIdSource?: ContractIdSource;
  /**
   * Resolved Stellar deployment network (`testnet` or `mainnet`) — the value
   * `resolveStellarNetwork` produced, i.e. after alias/fallback handling.
   */
  stellarNetwork: string;
  /**
   * Raw `STELLAR_NETWORK` env value, when set. An unrecognized value is
   * surfaced as a check failure even though resolution silently falls back to
   * testnet (same reasoning as the startup diagnostics).
   */
  rawStellarNetwork?: string | null;
  /** x402 payment network id (`stellar:testnet` / `stellar:pubnet`). */
  x402Network: string;
  /** Stellar network passphrase for the selected network. */
  networkPassphrase: string;
  /**
   * Resource schema version the caller intends to use, when relevant.
   * `null`/omitted reports the supported set without a verdict.
   */
  requestedSchemaVersion?: number | null;
  /**
   * Whether `MINDVAULT_ALLOW_MAINNET` widens the mainnet mutation policy —
   * folded into the mainnet readiness note. Defaults to `false`.
   */
  allowMainnetEnv?: boolean;
}

/** Resolved network facts echoed in the result. */
export interface OnchainPreflightNetworkInfo {
  stellarNetwork: string;
  x402Network: string;
  networkPassphrase: string;
}

/** Resolved contract facts echoed in the result. */
export interface OnchainPreflightContractInfo {
  contractId: string;
  status: "ok" | "missing" | "malformed";
  note: string;
}

/** Schema-version facts echoed in the result. */
export interface OnchainPreflightSchemaVersions {
  supported: number[];
  requested: number | null;
  status: PreflightCheckStatus;
}

/** The full preflight result — the payload of `mindvault_onchain_preflight`. */
export interface OnchainPreflightResult {
  schema: typeof ONCHAIN_PREFLIGHT_SCHEMA;
  /** True when no check has `fail` status. */
  ready: boolean;
  network: OnchainPreflightNetworkInfo;
  contract: OnchainPreflightContractInfo;
  schemaVersions: OnchainPreflightSchemaVersions;
  checks: OnchainPreflightCheck[];
  /** One entry per non-pass check: `name: detail — remediation`. */
  mismatches: string[];
  /** Multi-line human-readable summary, safe to surface to an agent. */
  summary: string;
}

/**
 * Raw success JSON Schema for the preflight result. Deliberately NOT wrapped
 * with `withToolErrorVariant` — the lead wraps it when registering the tool.
 */
export const ONCHAIN_PREFLIGHT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: ONCHAIN_PREFLIGHT_SCHEMA },
    ready: { type: "boolean" },
    network: {
      type: "object",
      properties: {
        stellarNetwork: { type: "string" },
        x402Network: { type: "string" },
        networkPassphrase: { type: "string" },
      },
      required: ["stellarNetwork", "x402Network", "networkPassphrase"],
    },
    contract: {
      type: "object",
      properties: {
        contractId: { type: "string" },
        status: { type: "string", enum: ["ok", "missing", "malformed"] },
        note: { type: "string" },
      },
      required: ["contractId", "status", "note"],
    },
    schemaVersions: {
      type: "object",
      properties: {
        supported: { type: "array", items: { type: "integer" } },
        requested: { type: ["integer", "null"] },
        status: { type: "string", enum: ["pass", "warn", "fail"] },
      },
      required: ["supported", "requested", "status"],
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: ["pass", "warn", "fail"] },
          detail: { type: "string" },
          remediation: { type: "string" },
        },
        required: ["name", "status", "detail", "remediation"],
      },
    },
    mismatches: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: [
    "schema",
    "ready",
    "network",
    "contract",
    "schemaVersions",
    "checks",
    "mismatches",
    "summary",
  ],
} as const;

// ── Pure builder ──────────────────────────────────────────────────────────────

/**
 * Run the on-chain preflight against env-derived values. Pure, read-only,
 * synchronous, and total: it never throws, whatever the input, and never
 * touches the network or the filesystem.
 */
export function runOnchainPreflight(input: OnchainPreflightInput): OnchainPreflightResult {
  const checks: OnchainPreflightCheck[] = [];

  const rawContractId = typeof input.contractId === "string" ? input.contractId.trim() : "";
  const stellarRaw = typeof input.rawStellarNetwork === "string" ? input.rawStellarNetwork : null;
  const x402Raw = typeof input.x402Network === "string" ? input.x402Network : "";

  // ── Check 1: STELLAR_NETWORK is recognized ────────────────────────────────
  const parsedFromRaw = stellarRaw !== null ? parseStellarNetwork(stellarRaw) : undefined;
  const stellarValue = typeof input.stellarNetwork === "string" ? input.stellarNetwork : "";
  const parsedStellar: StellarDeploymentNetwork | undefined =
    parsedFromRaw ?? parseStellarNetwork(stellarValue);

  if (stellarRaw !== null && stellarRaw.trim() !== "" && !parsedFromRaw) {
    checks.push({
      name: "stellar_network",
      status: "fail",
      detail: `STELLAR_NETWORK ${JSON.stringify(stellarRaw)} is not recognized; it silently defaults to testnet.`,
      remediation: 'Set STELLAR_NETWORK to "testnet" or "mainnet" (aliases: pubnet, public).',
    });
  } else if (!parsedStellar) {
    checks.push({
      name: "stellar_network",
      status: "fail",
      detail: `Resolved network ${JSON.stringify(stellarValue)} is not a known Stellar deployment network.`,
      remediation: 'Use "testnet" or "mainnet" as the deployment network.',
    });
  } else {
    checks.push({
      name: "stellar_network",
      status: "pass",
      detail:
        stellarRaw !== null && stellarRaw.trim() !== ""
          ? `STELLAR_NETWORK: ${parsedFromRaw} (${JSON.stringify(stellarRaw)})`
          : `STELLAR_NETWORK: unset (defaults to ${parsedStellar})`,
      remediation: "",
    });
  }

  // The effective network every later check reasons about; resolution always
  // lands somewhere usable (testnet fallback), so downstream checks still run.
  const effectiveNetwork: StellarDeploymentNetwork = parsedStellar ?? "testnet";

  // ── Check 2: x402 NETWORK aligned with the Stellar network ────────────────
  const normalizedX402 = normalizeX402Network(x402Raw);
  const inferredFromX402 = inferNetworkFromX402(normalizedX402);
  const expectedX402 = registryNetworks[effectiveNetwork].x402Network;
  if (!inferredFromX402) {
    checks.push({
      name: "x402_network",
      status: "fail",
      detail: `Unsupported x402 network ${JSON.stringify(x402Raw)}.`,
      remediation: `Set NETWORK to "${X402_NETWORK_IDS.testnet}" or "${X402_NETWORK_IDS.mainnet}".`,
    });
  } else if (inferredFromX402 !== effectiveNetwork) {
    checks.push({
      name: "x402_network",
      status: "fail",
      detail: `NETWORK=${normalizedX402} does not match STELLAR_NETWORK=${effectiveNetwork}; x402 payments will be rejected on the wrong network.`,
      remediation: `Set NETWORK="${expectedX402}" to match STELLAR_NETWORK=${effectiveNetwork}, or unset it to use the preset default.`,
    });
  } else {
    checks.push({
      name: "x402_network",
      status: "pass",
      detail: `NETWORK: ${normalizedX402} (aligned with ${effectiveNetwork})`,
      remediation: "",
    });
  }

  // ── Check 3: contract ID present and well-formed ──────────────────────────
  const source: ContractIdSource = input.contractIdSource ?? (rawContractId ? "env" : "none");
  let contractStatus: OnchainPreflightContractInfo["status"];
  let contractNote: string;
  if (!rawContractId) {
    contractStatus = "missing";
    contractNote = `No vault-registry contract ID configured for ${effectiveNetwork}.`;
    checks.push({
      name: "contract_id",
      status: "fail",
      detail: contractNote,
      remediation:
        "Deploy the vault-registry contract and set VAULT_REGISTRY_CONTRACT_ID to its contract ID (C followed by 55 base32 characters).",
    });
  } else if (!CONTRACT_ID_PATTERN.test(rawContractId)) {
    contractStatus = "malformed";
    contractNote = `Contract ID ${JSON.stringify(rawContractId)} does not look like a Stellar contract ID.`;
    checks.push({
      name: "contract_id",
      status: "fail",
      detail: contractNote,
      remediation:
        "Set VAULT_REGISTRY_CONTRACT_ID to a deployed vault-registry contract ID (C followed by 55 base32 characters).",
    });
  } else if (source === "preset") {
    contractStatus = "ok";
    contractNote = `Using the ${effectiveNetwork} preset default contract ID (VAULT_REGISTRY_CONTRACT_ID unset).`;
    checks.push({
      name: "contract_id",
      status: "warn",
      detail: contractNote,
      remediation: `Set VAULT_REGISTRY_CONTRACT_ID to your own ${effectiveNetwork} vault-registry deployment to override the preset default.`,
    });
  } else {
    contractStatus = "ok";
    contractNote =
      source === "env"
        ? "Using VAULT_REGISTRY_CONTRACT_ID from the environment."
        : "Contract ID configured.";
    checks.push({
      name: "contract_id",
      status: "pass",
      detail: `Contract ID: ${rawContractId} (${source === "env" ? "VAULT_REGISTRY_CONTRACT_ID" : source})`,
      remediation: "",
    });
  }

  // ── Check 4: requested resource schema version ────────────────────────────
  const supported = [...SUPPORTED_RESOURCE_SCHEMA_VERSIONS];
  const requestedRaw = input.requestedSchemaVersion;
  let requested: number | null = null;
  let schemaStatus: PreflightCheckStatus;
  if (requestedRaw === null || requestedRaw === undefined) {
    requested = null;
    schemaStatus = "pass";
    checks.push({
      name: "resource_schema_version",
      status: "pass",
      detail: `No schema version requested; the installed contract supports [${supported.join(", ")}].`,
      remediation: "",
    });
  } else if (typeof requestedRaw !== "number" || !Number.isInteger(requestedRaw)) {
    schemaStatus = "fail";
    checks.push({
      name: "resource_schema_version",
      status: "fail",
      detail: `requestedSchemaVersion ${JSON.stringify(requestedRaw)} is not an integer.`,
      remediation: `Pass an integer from the supported set [${supported.join(", ")}], or omit it.`,
    });
  } else {
    requested = requestedRaw;
    if (supported.includes(requestedRaw)) {
      schemaStatus = "pass";
      checks.push({
        name: "resource_schema_version",
        status: "pass",
        detail: `Requested schema version ${requestedRaw} is supported (supported: [${supported.join(", ")}]).`,
        remediation: "",
      });
    } else {
      schemaStatus = "fail";
      checks.push({
        name: "resource_schema_version",
        status: "fail",
        detail: `Requested schema version ${requestedRaw} is not in the supported set [${supported.join(", ")}].`,
        remediation: `Use one of [${supported.join(", ")}], or omit requestedSchemaVersion to accept the contract's current version.`,
      });
    }
  }

  // ── Check 5: mainnet readiness note (warn at most; read-only stays free) ──
  if (effectiveNetwork === "mainnet") {
    const allowMainnetEnv = input.allowMainnetEnv === true;
    checks.push({
      name: "mainnet_readiness",
      status: "warn",
      detail: formatMainnetDiagnostics({
        stellarNetwork: effectiveNetwork,
        x402Network: inferredFromX402 ?? normalizedX402,
        registryContractId: rawContractId,
        allowMainnetEnv,
      }),
      remediation:
        "Every mainnet mutation still requires confirmMainnet: true per call (or MINDVAULT_ALLOW_MAINNET=1 on the MCP server process). On-chain writes spend real USDC/fees; there is no undo.",
    });
  }

  // ── Envelope ──────────────────────────────────────────────────────────────
  const ready = checks.every((c) => c.status !== "fail");
  const mismatches = checks
    .filter((c) => c.status !== "pass")
    .map((c) =>
      c.remediation ? `${c.name}: ${c.detail} — ${c.remediation}` : `${c.name}: ${c.detail}`,
    );

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const summaryLines: string[] = [];
  summaryLines.push(
    ready
      ? `On-chain preflight ready (${effectiveNetwork}, contract ${rawContractId || "(unset)"}).`
      : `On-chain preflight found ${failed.length} blocking issue(s).`,
  );
  for (const check of checks) {
    const marker = check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "FAIL";
    summaryLines.push(`  ${marker}  ${check.name}: ${check.detail}`);
  }
  if (!ready || warned.length > 0) {
    summaryLines.push(
      failed.length > 0
        ? `Fix the FAIL items above (with their remediation), then run the preflight again.`
        : `Warnings are advisory; the on-chain tools remain usable.`,
    );
  }

  return {
    schema: ONCHAIN_PREFLIGHT_SCHEMA,
    ready,
    network: {
      stellarNetwork: effectiveNetwork,
      x402Network: inferredFromX402 ? normalizedX402 : x402Raw,
      networkPassphrase: typeof input.networkPassphrase === "string" ? input.networkPassphrase : "",
    },
    contract: {
      contractId: rawContractId,
      status: contractStatus,
      note: contractNote,
    },
    schemaVersions: {
      supported,
      requested,
      status: schemaStatus,
    },
    checks,
    mismatches,
    summary: summaryLines.join("\n"),
  };
}

// ── Reusable gate for publish/register flows ──────────────────────────────────

/**
 * Run the preflight against the given environment and throw when a
 * locally fatal check fails (malformed/missing contract ID, unrecognized
 * `STELLAR_NETWORK`). A pass or warn-only result is a no-op, so flows call
 * this unconditionally before committing to on-chain work.
 *
 * The thrown message lists each fatal mismatch with its remediation and points
 * at `mindvault_onchain_preflight` for the full read-only report.
 */
export function assertOnchainSetupReady(env: NodeJS.ProcessEnv = process.env): void {
  const result = runOnchainPreflight(inputFromEnv(env));
  const fatal = result.checks.filter((c) => c.status === "fail" && FATAL_CHECK_NAMES.has(c.name));
  if (fatal.length === 0) return;
  const lines = [
    `On-chain setup preflight failed — ${fatal.length} blocking issue(s) with ${result.network.stellarNetwork}:`,
  ];
  for (const check of fatal) {
    lines.push(`  - ${check.name}: ${check.detail}`);
    if (check.remediation) lines.push(`    Fix: ${check.remediation}`);
  }
  lines.push("Run mindvault_onchain_preflight for the full read-only report.");
  throw new Error(lines.join("\n"));
}

// ── Env collection + tool handler ─────────────────────────────────────────────

/** Build the pure-builder input from an environment via `buildConfig`. */
function inputFromEnv(env: NodeJS.ProcessEnv): OnchainPreflightInput {
  const config = buildConfig(env);
  const contractIdSource: ContractIdSource = env.VAULT_REGISTRY_CONTRACT_ID
    ? "env"
    : config.registryContractId
      ? "preset"
      : "none";
  return {
    contractId: config.registryContractId,
    contractIdSource,
    stellarNetwork: config.stellarNetwork,
    rawStellarNetwork: env.STELLAR_NETWORK ?? null,
    x402Network: config.x402Network,
    networkPassphrase: config.registryNetworkPassphrase,
    requestedSchemaVersion: null,
    allowMainnetEnv: mainnetAllowedFromEnv(env),
  };
}

/**
 * Tool handler for `mindvault_onchain_preflight` (#1054). Read-only and
 * offline: it collects the current config with `buildConfig(process.env)` and
 * returns the preflight result as pretty-printed JSON.
 *
 * Arguments: optional `requestedSchemaVersion` (integer). A non-integer value
 * throws a clear validation error before any check runs.
 */
export function onchainPreflightTool(args: Record<string, unknown>): string {
  const rawRequested = args.requestedSchemaVersion;
  let requestedSchemaVersion: number | null = null;
  if (rawRequested !== undefined && rawRequested !== null) {
    if (typeof rawRequested !== "number" || !Number.isInteger(rawRequested)) {
      throw new Error(
        `requestedSchemaVersion must be an integer from the supported set [${SUPPORTED_RESOURCE_SCHEMA_VERSIONS.join(", ")}]. Got: ${JSON.stringify(rawRequested)}.`,
      );
    }
    requestedSchemaVersion = rawRequested;
  }
  const input = inputFromEnv(process.env);
  return JSON.stringify(runOnchainPreflight({ ...input, requestedSchemaVersion }), null, 2);
}
