/**
 * Machine-readable inventory of the MCP server's environment variables (#599).
 *
 * Every operator-facing knob lives in `src/` as a named constant or a parse
 * function whose default is enforced in code — but before this module the only
 * way to know that was to read the source. This file is the single place where
 * a variable's name, default, and accepted values are stated *once*, next to
 * the code that reads it, so a docs page and a test can be generated from it
 * instead of maintained by hand and drifting.
 *
 * Consumers:
 *
 *   - `scripts/generate-env-reference.ts` renders `docs/mcp-env-variables.md`.
 *     The generated page carries the same staleness guard contract as the
 *     tool reference (see `envReference.test.ts`): a variable added to the
 *     code without an entry here fails CI, and so does an entry nothing
 *     reads.
 *
 * Defaults are sourced from the owning module's exported constants where one
 * exists (`DEFAULT_RETRY_POLICY`, `DEFAULT_TIMEOUTS`, …) so a default that
 * changes in code changes the generated reference in the same PR.
 */

import { DEFAULT_MAX_AUTO_PAY_USDC } from "./paymentCeiling.js";
import { DEFAULT_PAID_CONFIRMATION_POLICY } from "./paidOperations.js";
import { DEFAULT_MAINNET_MUTATION_POLICY } from "./mainnetGuardrails.js";
import { DEFAULT_RETRY_POLICY } from "./retry.js";
import { DEFAULT_TIMEOUTS, DEFAULT_USER_AGENT } from "./httpTimeout.js";
import { DEFAULT_PREVIEW_MAX_BYTES, DEFAULT_PREVIEW_FIELD_MAX_CHARS } from "./previewLimits.js";
import { DEFAULT_TOOL_DURATION_BUDGET_MS } from "./metrics.js";
import { DEFAULT_COOLDOWN_MS, DEFAULT_MAX_ATTEMPTS } from "./rpcFailover.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from "./auditLogRotation.js";
import { DEFAULT_CATALOG_CACHE_CONFIG } from "./catalogCache.js";

/** One environment variable, as an operator reads it in a reference page. */
export interface EnvVarDoc {
  /** Variable name exactly as the code reads it (case-sensitive). */
  name: string;
  /** What it controls, in one operator-facing sentence. */
  description: string;
  /** The effective default when unset, stated the way the code applies it. */
  default: string;
  /**
   * Accepted values when the variable is an enumerated knob; omitted for
   * free-form variables.
   */
  values?: readonly string[];
  /** The module that reads the variable, so operators can trace behaviour. */
  source: string;
}

/**
 * The inventory.
 *
 * Kept in table order by functional group (network → guardrails → catalog →
 * timeouts → operations), matching how docs/environment-variables.md already
 * groups them. Each entry imports its default from the module that enforces
 * it — literals appear only where the owning module does not export a
 * constant (yet).
 */
export const ENV_VAR_DOCS: EnvVarDoc[] = [
  // ── Network & endpoints ────────────────────────────────────────────────────
  {
    name: "STELLAR_NETWORK",
    description:
      "Deployment target for the MCP server. Selects the registry-client network preset (RPC and Horizon URLs, passphrase, USDC contract).",
    default: "testnet",
    values: ["testnet", "mainnet", "pubnet", "public"],
    source: "mcp/src/config.ts",
  },
  {
    name: "MINDVAULT_URL",
    description: "Base URL of the MindVault API the catalog tools browse and buy from.",
    default: "the built-in production default (see mcp/src/config.ts)",
    source: "mcp/src/config.ts",
  },
  {
    name: "VAULT_REGISTRY_CONTRACT_ID",
    description:
      "Vault-registry Soroban contract id used for on-chain lookups and mutations. Falls back to the network preset's canonical deployment.",
    default: "the network preset's default contract id (empty when the preset defines none)",
    source: "mcp/src/config.ts",
  },
  {
    name: "NETWORK",
    description:
      "x402 payment network id. Defaults to the preset for the selected Stellar network.",
    default: "the preset's x402 network (stellar:testnet or stellar:pubnet)",
    values: ["stellar:testnet", "stellar:pubnet"],
    source: "mcp/src/config.ts",
  },
  {
    name: "SPONSORED_ACCOUNT_URL",
    description: "Sponsored-account service used for wallet creation without agent funds.",
    default: "the built-in production default (see mcp/src/config.ts)",
    source: "mcp/src/config.ts",
  },
  {
    name: "USDC_CONTRACT_ID",
    description:
      "Overrides the USDC token contract for buy/settlement flows. Defaults to the network preset's canonical USDC SAC id; a non-preset override is reported as a startup warning.",
    default: "the network preset's USDC SAC contract id",
    source: "mcp/src/index.ts",
  },
  {
    name: "HORIZON_URL",
    description: "Horizon endpoint for balance and account reads. Falls back to the preset.",
    default: "the network preset's Horizon URL",
    source: "mcp/src/config.ts",
  },
  {
    name: "SOROBAN_RPC_URL",
    description: "Soroban RPC endpoint for on-chain calls. Falls back to the preset.",
    default: "the network preset's Soroban RPC URL",
    source: "mcp/src/config.ts",
  },
  {
    name: "MINDVAULT_SOROBAN_RPC_URLS",
    description:
      "Comma-separated failover list of Soroban RPC endpoints in priority order. Overrides SOROBAN_RPC_URL when set.",
    default: "unset — single endpoint from SOROBAN_RPC_URL / the preset",
    source: "mcp/src/rpcFailover.ts",
  },
  {
    name: "MINDVAULT_RPC_FAILOVER_COOLDOWN_MS",
    description:
      "How long a failed Soroban endpoint is skipped before it is retried.",
    default: `${DEFAULT_COOLDOWN_MS} (ms)`,
    source: "mcp/src/rpcFailover.ts",
  },
  {
    name: "MINDVAULT_RPC_FAILOVER_MAX_ATTEMPTS",
    description:
      "Endpoint tries per call during failover. 0 tries every configured endpoint.",
    default: `${DEFAULT_MAX_ATTEMPTS} (unlimited)`,
    source: "mcp/src/rpcFailover.ts",
  },

  // ── Guardrails & policies ──────────────────────────────────────────────────
  {
    name: "MINDVAULT_ALLOW_MAINNET",
    description:
      "Operator-side unlock for mainnet mutations. Parsed fail-safe: only the documented opt-in spellings widen the policy, anything else — including an unexpanded template placeholder — keeps per-call confirmation (#606). A set-but-ineffective value raises a startup warning.",
    default: DEFAULT_MAINNET_MUTATION_POLICY,
    values: [
      "unset/0/false/no/off → per-call-confirm",
      "1/true/yes → allow-all",
    ],
    source: "mcp/src/mainnetGuardrails.ts",
  },
  {
    name: "MINDVAULT_READ_ONLY",
    description:
      "Restrict the server to read-only tools. Only tools whose definition declares readOnlyHint are advertised, and the dispatcher refuses every other tool even for clients holding a cached tool list.",
    default: "unset (full surface)",
    values: ["1", "true", "yes", "on"],
    source: "mcp/src/readOnlyMode.ts",
  },
  {
    name: "MINDVAULT_CONFIRM_PAID_OPERATIONS",
    description:
      "Require an explicit confirmPaid: true before tools spend from the agent wallet, independently of network. An unrecognized value is an error, not a fallback to off.",
    default: DEFAULT_PAID_CONFIRMATION_POLICY,
    values: ["off", "usdc", "all"],
    source: "mcp/src/paidOperations.ts",
  },
  {
    name: "MINDVAULT_MAX_AUTO_PAY_USDC",
    description:
      "Ceiling for the automatic x402 settlement inside mindvault_buy. A purchase above the ceiling needs a per-call maxAutoPayUsdc at least equal to the price.",
    default: `${DEFAULT_MAX_AUTO_PAY_USDC} USDC`,
    source: "mcp/src/paymentCeiling.ts",
  },

  // ── Catalog & cache ────────────────────────────────────────────────────────
  {
    name: "MINDVAULT_CATALOG_CACHE_TTL_MS",
    description:
      "Age at which an offline catalog snapshot is served with a staleness warning instead of silently.",
    default: `${DEFAULT_CATALOG_CACHE_CONFIG.ttlMs} (ms)`,
    source: "mcp/src/catalogCache.ts",
  },
  {
    name: "MINDVAULT_CATALOG_CACHE_MAX_AGE_MS",
    description:
      "Age past which an offline snapshot is withheld entirely. 0 keeps the pre-#573 behaviour of always serving, labelled when old. Clamped up to the TTL when set lower.",
    default: `${DEFAULT_CATALOG_CACHE_CONFIG.maxAgeMs} (never withhold)`,
    source: "mcp/src/catalogCache.ts",
  },
  {
    name: "MINDVAULT_PREVIEW_MAX_BYTES",
    description:
      "Byte ceiling for a serialized mindvault_preview response; 0 disables. Values below the 1024 floor are raised to it.",
    default: `${DEFAULT_PREVIEW_MAX_BYTES} (bytes)`,
    source: "mcp/src/previewLimits.ts",
  },
  {
    name: "MINDVAULT_PREVIEW_FIELD_MAX_CHARS",
    description:
      "Character ceiling for each free-text preview field (title, description); 0 disables.",
    default: `${DEFAULT_PREVIEW_FIELD_MAX_CHARS} (chars)`,
    source: "mcp/src/previewLimits.ts",
  },
  {
    name: "MINDVAULT_PURCHASES_FILE",
    description: "Path of the purchase-receipt file mindvault_buy appends to.",
    default: "~/.mindvault/purchases.json",
    source: "mcp/src/purchaseHistory.ts",
  },

  // ── Timeouts & retries ─────────────────────────────────────────────────────
  {
    name: "MINDVAULT_HTTP_TIMEOUT_MS",
    description: "Request deadline for the MindVault API and sponsored-account service. 0 disables.",
    default: `${DEFAULT_TIMEOUTS.http} (ms)`,
    source: "mcp/src/httpTimeout.ts",
  },
  {
    name: "MINDVAULT_HORIZON_TIMEOUT_MS",
    description: "Request deadline for Horizon balance/account reads. 0 disables.",
    default: `${DEFAULT_TIMEOUTS.horizon} (ms)`,
    source: "mcp/src/httpTimeout.ts",
  },
  {
    name: "MINDVAULT_SOROBAN_TIMEOUT_MS",
    description: "Request deadline for Soroban RPC calls. 0 disables.",
    default: `${DEFAULT_TIMEOUTS.soroban} (ms)`,
    source: "mcp/src/httpTimeout.ts",
  },
  {
    name: "MINDVAULT_PAYMENT_TIMEOUT_MS",
    description:
      "Request deadline for x402 paid fetches, which include on-chain settlement. 0 disables.",
    default: `${DEFAULT_TIMEOUTS.payment} (ms)`,
    source: "mcp/src/httpTimeout.ts",
  },
  {
    name: "MINDVAULT_TOOL_TIMEOUTS",
    description:
      "Per-tool timeout overrides as a comma/space-separated list of tool=milliseconds entries. The mindvault_ prefix is optional; 0 removes the deadline for that tool.",
    default: "unset — every tool uses its service budget",
    source: "mcp/src/toolTimeoutOverrides.ts",
  },
  {
    name: "MINDVAULT_TOOL_DURATION_BUDGET_MS",
    description:
      "Duration budget a tool call should finish within; exceeded calls are counted by the metrics recorder.",
    default: `${DEFAULT_TOOL_DURATION_BUDGET_MS} (ms)`,
    source: "mcp/src/metrics.ts",
  },
  {
    name: "MINDVAULT_RETRY_ATTEMPTS",
    description:
      "Total attempts (including the first) for idempotent calls. 1 disables retrying. Never applies to payments.",
    default: `${DEFAULT_RETRY_POLICY.attempts}`,
    source: "mcp/src/retry.ts",
  },
  {
    name: "MINDVAULT_RETRY_BASE_DELAY_MS",
    description: "Backoff delay before the first retry; doubles each attempt.",
    default: `${DEFAULT_RETRY_POLICY.baseDelayMs} (ms)`,
    source: "mcp/src/retry.ts",
  },
  {
    name: "MINDVAULT_RETRY_MAX_DELAY_MS",
    description: "Ceiling on the exponential backoff delay before jitter is applied.",
    default: `${DEFAULT_RETRY_POLICY.maxDelayMs} (ms)`,
    source: "mcp/src/retry.ts",
  },
  {
    name: "MINDVAULT_RETRY_ATTEMPTS_<TOOL>",
    description:
      "Per-tool retry overrides, derived from the global names by suffixing the uppercased tool name — e.g. MINDVAULT_RETRY_ATTEMPTS_MINDVAULT_BROWSE=5 for mindvault_browse.",
    default: "unset — the global retry policy applies",
    source: "mcp/src/retry.ts",
  },

  // ── Observability & mode ───────────────────────────────────────────────────
  {
    name: "MINDVAULT_METRICS",
    description:
      "Opt-in per-tool metrics (call/error counts, durations, budget overruns). Output contains tool names and counts only.",
    default: "unset (disabled)",
    values: ["1", "true", "yes", "on"],
    source: "mcp/src/metrics.ts",
  },
  {
    name: "MINDVAULT_AUDIT_LOG",
    description:
      "Enable audit logging of tool calls to stderr. Exactly \"1\" enables; other spellings do not.",
    default: "unset (disabled)",
    values: ["1"],
    source: "mcp/src/auditLog.ts",
  },
  {
    name: "MINDVAULT_AUDIT_LOG_FILE",
    description:
      "Append audit entries to this file as JSON Lines (in addition to stderr), with size-based rotation.",
    default: "unset — file sink off, stderr only",
    source: "mcp/src/auditLogRotation.ts",
  },
  {
    name: "MINDVAULT_AUDIT_LOG_MAX_BYTES",
    description: "Rotate the audit log file once it would exceed this size. Floor of 1024 bytes.",
    default: `${DEFAULT_MAX_BYTES} (bytes)`,
    source: "mcp/src/auditLogRotation.ts",
  },
  {
    name: "MINDVAULT_AUDIT_LOG_MAX_FILES",
    description: "Rotated audit-log generations kept besides the live file.",
    default: `${DEFAULT_MAX_FILES} (files)`,
    source: "mcp/src/auditLogRotation.ts",
  },
  {
    name: "MINDVAULT_USER_AGENT",
    description: "User-Agent header sent on outbound API calls.",
    default: DEFAULT_USER_AGENT,
    source: "mcp/src/httpTimeout.ts",
  },
  {
    name: "MINDVAULT_AGENT_SECRET",
    description:
      "Stellar secret key used to derive the agent wallet when none is configured in the active profile. Prefer mindvault_setup_wallet; a secret in an environment variable is a last resort and never logged.",
    default: "unset — the active profile's wallet is used",
    source: "mcp/src/runtime.ts",
  },
  {
    name: "MINDVAULT_MOCK",
    description:
      "Contributor mock mode: every outbound HTTP call and on-chain lookup is replaced with deterministic in-memory responses. Development and tests only — never for production.",
    default: "unset (live mode)",
    values: ["1", "true", "yes", "on"],
    source: "mcp/src/mock.ts",
  },
];

/**
 * Lookup by variable name. Pattern-shaped entries (the per-tool retry
 * override) are matched by prefix so a generated reference can resolve a
 * concrete name back to its documented row.
 */
export function findEnvVarDoc(name: string): EnvVarDoc | undefined {
  const exact = ENV_VAR_DOCS.find((doc) => doc.name === name);
  if (exact) return exact;
  return ENV_VAR_DOCS.find(
    (doc) => doc.name.includes("<TOOL>") && name.startsWith(doc.name.replace("<TOOL>", "")),
  );
}
