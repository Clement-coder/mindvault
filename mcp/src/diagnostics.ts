/**
 * Startup configuration diagnostics for the MindVault MCP server.
 *
 * Collects every problem with the server's environment in a single pass — rather
 * than failing on the first one — so an operator sees the full list of what to
 * fix. Each diagnostic names the exact environment variable and the value it
 * expects. The module is pure (no I/O, no process.exit) so it is deterministic
 * and unit-testable; index.ts decides how to report and whether to exit.
 *
 * Secrets are never echoed: any value that looks like a Stellar secret key or a
 * long opaque token is redacted before it appears in a message, so a diagnostic
 * report is always safe to show in issue-driven contributor work.
 */

import {
  networks as registryNetworks,
  normalizeX402Network,
  parseStellarNetwork,
  resolveStellarNetwork,
  validateNetworkConfig,
} from "@mindvault/registry-client";
import {
  isExplicitMainnetDenial,
  unsafeMainnetAllow,
} from "./mainnetGuardrails.js";

export type DiagnosticSeverity = "error" | "warning";

export interface StartupDiagnostic {
  /** The environment variable the problem relates to. */
  variable: string;
  severity: DiagnosticSeverity;
  /** Human-readable description of what is wrong. */
  message: string;
  /** What a valid value looks like, when it can be stated concisely. */
  expected?: string;
}

/** Values accepted (case-insensitively) as booleans for MINDVAULT_METRICS. */
const BOOLEAN_VALUES = new Set(["1", "0", "true", "false", "yes", "no", "on", "off"]);

/** Stellar secret keys: 'S' + 55 base32 chars. Redacted so they never leak. */
const STELLAR_SECRET_KEY = /\bS[A-Z2-7]{55}\b/g;

/**
 * Mask anything that looks like a secret in free text. Currently Stellar secret
 * keys; kept as a single helper so every message passes through one redactor.
 */
export function redactSecrets(text: string): string {
  return text.replace(STELLAR_SECRET_KEY, "S***REDACTED***");
}

/** True when a string parses as an absolute http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Inspect the given environment and return every configuration problem found.
 * An empty array means the configuration is internally consistent. Errors are
 * blocking (the server should exit); warnings are advisory (safe to continue).
 *
 * `hasGlobalFetch` defaults to a live check of the ambient `fetch`, but is
 * overridable so the missing-runtime-fetch diagnostic below stays unit-testable
 * without deleting the real global.
 */
export function collectStartupDiagnostics(
  env: NodeJS.ProcessEnv,
  hasGlobalFetch: boolean = typeof fetch === "function",
): StartupDiagnostic[] {
  const diagnostics: StartupDiagnostic[] = [];

  // Every outbound call (MindVault API, Horizon, Soroban RPC, x402 payments)
  // goes through the global `fetch`. Node <20, or an unusual runtime that never
  // shipped one, would otherwise fail deep inside the first tool call with a
  // bare `ReferenceError: fetch is not defined` — surface it here instead, at
  // startup, with a fix an operator can act on.
  if (!hasGlobalFetch) {
    diagnostics.push({
      variable: "globalThis.fetch",
      severity: "error",
      message: "No global `fetch` is available in this JavaScript runtime.",
      expected: "Node.js >=20 (ships a global fetch), or another runtime that provides one",
    });
  }

  // STELLAR_NETWORK — an unrecognized value silently defaults to testnet, which
  // is surprising, so surface it as a warning rather than letting it pass.
  const rawNetwork = env.STELLAR_NETWORK;
  if (typeof rawNetwork === "string" && rawNetwork.trim() && !parseStellarNetwork(rawNetwork)) {
    diagnostics.push({
      variable: "STELLAR_NETWORK",
      severity: "warning",
      message: `Unrecognized value ${JSON.stringify(rawNetwork)}; defaulting to testnet.`,
      expected: "testnet or mainnet",
    });
  }

  const stellarNetwork = resolveStellarNetwork(rawNetwork);
  const preset = registryNetworks[stellarNetwork];

  // Reuse the shared network-consistency checks (NETWORK, RPC, Horizon, USDC,
  // registry cross-network) so the MCP server and other consumers agree.
  const sorobanRpcUrl = env.SOROBAN_RPC_URL ?? preset.sorobanRpcUrl;
  const horizonUrl = env.HORIZON_URL ?? preset.horizonUrl;
  const networkIssues = validateNetworkConfig({
    stellarNetwork,
    x402Network: normalizeX402Network(env.NETWORK ?? preset.x402Network),
    // Let the URL validation below report malformed overrides directly instead
    // of also producing a misleading network-mismatch diagnostic.
    sorobanRpcUrl: isHttpUrl(sorobanRpcUrl) ? sorobanRpcUrl : preset.sorobanRpcUrl,
    horizonUrl: isHttpUrl(horizonUrl) ? horizonUrl : preset.horizonUrl,
    usdcSacContractId: env.USDC_CONTRACT_ID ?? preset.usdcSacContractId,
    registryContractId:
      env.VAULT_REGISTRY_CONTRACT_ID ?? preset.defaultRegistryContractId ?? undefined,
  });
  for (const issue of networkIssues) {
    // A mismatch between NETWORK (x402 payment network) and STELLAR_NETWORK
    // (Soroban/Horizon target) is a warning: the server can still start, but
    // payments will likely be rejected by the x402 facilitator because the
    // signed auth entries will reference the wrong network. All other
    // cross-network issues (wrong RPC endpoint, wrong USDC contract, wrong
    // registry contract ID) are blocking errors because they will cause
    // every Soroban call to fail immediately.
    const severity: DiagnosticSeverity = issue.field === "NETWORK" ? "warning" : "error";
    diagnostics.push({
      variable: issue.field,
      severity,
      message: redactSecrets(issue.message),
    });
  }

  // VAULT_REGISTRY_CONTRACT_ID — required when the network has no default
  // (mainnet). Testnet ships a default, so this only bites mainnet operators.
  const registryContractId =
    env.VAULT_REGISTRY_CONTRACT_ID ?? preset.defaultRegistryContractId ?? "";
  if (!registryContractId) {
    diagnostics.push({
      variable: "VAULT_REGISTRY_CONTRACT_ID",
      severity: "error",
      message: `Required for ${stellarNetwork}: deploy vault-registry and set its contract ID.`,
      expected: "a deployed vault-registry contract ID (starts with C)",
    });
  }

  // URL-shaped variables must be absolute http(s) URLs when set.
  for (const variable of [
    "MINDVAULT_URL",
    "SPONSORED_ACCOUNT_URL",
    "HORIZON_URL",
    "SOROBAN_RPC_URL",
  ] as const) {
    const value = env[variable];
    if (typeof value === "string" && value.trim() && !isHttpUrl(value)) {
      diagnostics.push({
        variable,
        severity: "error",
        message: `Not a valid URL: ${JSON.stringify(redactSecrets(value))}.`,
        expected: "an absolute http(s) URL (e.g. https://mindvault.example.com)",
      });
    }
  }

  // MINDVAULT_METRICS is opt-in; a value that is neither truthy nor falsy is
  // almost certainly a mistake (metrics silently stay off).
  const metrics = env.MINDVAULT_METRICS;
  if (
    typeof metrics === "string" &&
    metrics.trim() &&
    !BOOLEAN_VALUES.has(metrics.trim().toLowerCase())
  ) {
    diagnostics.push({
      variable: "MINDVAULT_METRICS",
      severity: "warning",
      message: `Unrecognized value ${JSON.stringify(metrics)}; metrics stay disabled.`,
      expected: "1/true/yes/on to enable, or leave unset",
    });
  }

  // MINDVAULT_ALLOW_MAINNET (#606) — the mainnet guardrail parses this value
  // fail-safe: only 1/true/yes widen the mutation policy, everything else
  // keeps per-call confirmation. A set value that unlocks nothing is therefore
  // harmless but almost certainly unintended — a bare "$MINDVAULT_ALLOW_MAINNET"
  // template placeholder left unexpanded, `on`/`enabled` from another config
  // dialect, or a plain typo. Silently doing nothing is the confusing kind of
  // safe; say so at startup. Explicit denials (0/false/no/off) re-affirm the
  // default on purpose and stay quiet. A warning, not an error: the fallback
  // is exactly the safe default, so there is nothing to fix before starting.
  const allowMainnet = env.MINDVAULT_ALLOW_MAINNET;
  if (
    typeof allowMainnet === "string" &&
    allowMainnet.trim() !== "" &&
    !unsafeMainnetAllow(allowMainnet) &&
    !isExplicitMainnetDenial(allowMainnet)
  ) {
    diagnostics.push({
      variable: "MINDVAULT_ALLOW_MAINNET",
      severity: "warning",
      message: `Value ${JSON.stringify(allowMainnet)} does not unlock mainnet mutations; per-call confirmMainnet remains required.`,
      expected:
        "unset for per-call confirmation, 1/true/yes to allow gated tools without confirmMainnet, or 0/false/no/off to deny explicitly",
    });
  }

  return diagnostics;
}

/** Whether any diagnostic is severe enough to stop the server from starting. */
export function hasBlockingDiagnostics(diagnostics: StartupDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/**
 * Render diagnostics as a deterministic, multi-line report grouped by severity.
 * Ordering follows the input, so callers get stable output for a given env.
 */
export function formatDiagnostics(diagnostics: StartupDiagnostic[]): string {
  if (diagnostics.length === 0) return "MindVault MCP: configuration OK.";

  const lines: string[] = [];
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  const render = (d: StartupDiagnostic): string => {
    const expected = d.expected ? ` (expected: ${d.expected})` : "";
    return `  - ${d.variable}: ${d.message}${expected}`;
  };

  if (errors.length > 0) {
    lines.push(`MindVault MCP: ${errors.length} configuration error(s):`);
    lines.push(...errors.map(render));
  }
  if (warnings.length > 0) {
    lines.push(`MindVault MCP: ${warnings.length} configuration warning(s):`);
    lines.push(...warnings.map(render));
  }
  return lines.join("\n");
}
