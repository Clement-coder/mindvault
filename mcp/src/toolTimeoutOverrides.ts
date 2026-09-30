/**
 * Per-tool request timeout overrides — issue #590.
 *
 * `httpTimeout.ts` gives each *service* a budget: `http`, `horizon`, `soroban`,
 * `payment`. That is the right granularity for most deployments and the wrong
 * one for a few specific tools. `mindvault_publish` and
 * `mindvault_register_onchain` do markedly more work than a catalog read, yet
 * both sit under the same `http` budget; raising `MINDVAULT_HTTP_TIMEOUT_MS` to
 * accommodate them also makes every quick call wait four times as long before
 * giving up, which is the opposite of what a deadline is for.
 *
 * One environment variable, `MINDVAULT_TOOL_TIMEOUTS`, carries a list of
 * per-tool overrides:
 *
 *     MINDVAULT_TOOL_TIMEOUTS="mindvault_publish=120000,mindvault_browse=5000"
 *
 * A tool named there uses its own budget; every other tool keeps the service
 * default. The `mindvault_` prefix is optional, so `publish=120000` works too.
 *
 * A single variable rather than one per tool is deliberate: the tool list grows
 * every release, and a scheme that mints a new environment variable per tool
 * cannot be documented, validated, or reviewed. This one can — see
 * `docs/mcp-timeouts-retries.md`.
 *
 * Parsing never throws. A malformed entry is reported and skipped, because an
 * MCP server that refuses to start over a typo in an optional tuning variable
 * is worse than one that runs with a default.
 */

import type { TimeoutBudgets, TimeoutService } from "./httpTimeout.js";

/** Environment variable holding the per-tool override list. */
export const TOOL_TIMEOUTS_ENV_VAR = "MINDVAULT_TOOL_TIMEOUTS";

/** Prefix every MCP tool name carries; optional in the override list. */
const TOOL_PREFIX = "mindvault_";

/** Parsed overrides: fully-qualified tool name -> milliseconds. */
export type ToolTimeoutOverrides = Record<string, number>;

export interface ParsedOverrides {
  overrides: ToolTimeoutOverrides;
  /** Human-readable complaints about entries that were skipped. */
  problems: string[];
}

/** Add the `mindvault_` prefix when the operator left it off. */
export function normalizeToolName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith(TOOL_PREFIX) ? trimmed : `${TOOL_PREFIX}${trimmed}`;
}

/**
 * Parse the override list.
 *
 * Entries are `tool=milliseconds`, separated by commas or whitespace. `0`
 * is kept and means "no deadline for this tool", matching what a service
 * budget of 0 means. A later entry for the same tool wins, so a list can be
 * built by appending.
 */
export function parseToolTimeouts(raw: string | undefined): ParsedOverrides {
  const overrides: ToolTimeoutOverrides = {};
  const problems: string[] = [];

  if (!raw || !raw.trim()) return { overrides, problems };

  for (const part of raw.split(/[,\s]+/)) {
    const entry = part.trim();
    if (!entry) continue;

    const separator = entry.indexOf("=");
    if (separator === -1) {
      problems.push(`"${entry}" is not a tool=milliseconds pair`);
      continue;
    }

    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();

    if (!name) {
      problems.push(`"${entry}" has no tool name`);
      continue;
    }

    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      problems.push(`"${entry}" has a non-numeric or negative timeout`);
      continue;
    }

    overrides[normalizeToolName(name)] = Math.floor(milliseconds);
  }

  return { overrides, problems };
}

/** Read and parse the overrides from the environment. */
export function resolveToolTimeouts(env: NodeJS.ProcessEnv = process.env): ParsedOverrides {
  return parseToolTimeouts(env[TOOL_TIMEOUTS_ENV_VAR]);
}

/**
 * The budget a given tool should run under.
 *
 * Falls back to the service budget when the tool has no override, so a call
 * site can ask unconditionally.
 */
export function timeoutForTool(
  toolName: string | undefined,
  service: TimeoutService,
  budgets: TimeoutBudgets,
  overrides: ToolTimeoutOverrides,
): number {
  if (toolName) {
    const override = overrides[normalizeToolName(toolName)];
    if (override !== undefined) return override;
  }
  return budgets[service];
}

/** Whether a tool's budget comes from an override rather than its service. */
export function hasOverride(
  toolName: string | undefined,
  overrides: ToolTimeoutOverrides,
): boolean {
  return toolName !== undefined && normalizeToolName(toolName) in overrides;
}

/**
 * Validate overrides against the tools the server actually exposes.
 *
 * A typo like `mindvault_publsh=120000` parses perfectly and silently applies
 * to nothing — exactly the failure a tuning variable must not have. Call this
 * with the real tool names at startup and surface what comes back.
 */
export function unknownToolNames(
  overrides: ToolTimeoutOverrides,
  knownToolNames: Iterable<string>,
): string[] {
  const known = new Set(knownToolNames);
  return Object.keys(overrides)
    .filter((name) => !known.has(name))
    .sort();
}

/** Compact, operator-facing summary for the network-profile tool. */
export function describeToolTimeouts(overrides: ToolTimeoutOverrides): string {
  const names = Object.keys(overrides).sort();
  if (names.length === 0) return "none (all tools use their service budget)";
  return names
    .map((name) => `${name}=${overrides[name] === 0 ? "disabled" : `${overrides[name]}ms`}`)
    .join(", ");
}
