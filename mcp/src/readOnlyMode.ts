/**
 * Read-only mode for catalog browsing (#593).
 *
 * An agent that only needs to *discover* what is in the vault should not be
 * one malformed plan away from spending USDC, rotating a publisher key, or
 * wiping `~/.mindvault/state.json`. The mainnet guardrail in
 * `mainnetGuardrails.ts` is the wrong instrument for that: it is
 * network-scoped (testnet is wide open) and per-call (`confirmMainnet: true`
 * unlocks it from inside the very tool call you wanted to prevent).
 *
 * Read-only mode is the operator-scoped complement. It is set once, on the
 * server process, and cannot be lifted by a tool argument:
 *
 *   MINDVAULT_READ_ONLY=1
 *
 * With it on, the server is a catalog browser and nothing else. Two things
 * change, and they must change together:
 *
 *   1. **ListTools advertises only read-only tools.** An agent that cannot see
 *      `mindvault_buy` does not plan around it, so the common case never
 *      reaches a refusal at all.
 *   2. **Dispatch refuses the rest.** Advertisement is a hint; a client that
 *      cached an older tool list, or one that simply guesses a name, still
 *      calls it. The gate that matters is the one in the dispatcher.
 *
 * "Read-only" is not a list maintained here — it is
 * `annotations.readOnlyHint` from {@link TOOL_DEFINITIONS}, the same hint
 * ListTools already advertises to clients. A tool added later is gated by
 * whatever it declares about itself, so this module cannot fall out of sync
 * with the tool surface. `listToolsContract.test.ts` pins that relationship.
 */

import { TOOL_DEFINITIONS } from "./tools.js";

/** Environment variable that puts the server into read-only mode. */
export const READ_ONLY_ENV_VAR = "MINDVAULT_READ_ONLY";

/**
 * Truthy forms accepted for {@link READ_ONLY_ENV_VAR}.
 *
 * Deliberately narrow, and deliberately not the `isTruthyConfirm` set from the
 * mainnet guardrail: that one exists to read a *tool argument* leniently.
 * This reads an operator's deployment config, where a value that is neither
 * clearly on nor clearly off is safer treated as off than guessed at — the
 * server then behaves exactly as it did before anyone set the variable.
 */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether the server process is running in read-only mode. */
export function readOnlyModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[READ_ONLY_ENV_VAR];
  if (raw == null) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** Tool names whose definition declares `readOnlyHint: true`. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  TOOL_DEFINITIONS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name),
);

/**
 * Whether a tool is safe to run in read-only mode.
 *
 * An unknown name is **not** read-only. Read-only mode is a safety boundary,
 * so a name this module has never heard of has to fail closed; the dispatcher
 * will reject it as an unknown tool a moment later anyway.
 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

/** Every read-only tool name, sorted — used in the refusal and by tests. */
export function readOnlyToolNames(): string[] {
  return [...READ_ONLY_TOOLS].sort();
}

/**
 * Deterministic refusal for a mutating tool called in read-only mode.
 *
 * Agent-facing, so it says what to do instead rather than only what failed:
 * the browsing tools that *are* available, and the one thing (restarting the
 * server without the variable) that would lift the restriction. No secrets, no
 * paths, no stack traces.
 */
export function readOnlyRefusalError(toolName: string): Error {
  return new Error(
    [
      `Read-only mode: "${toolName}" is disabled because the MCP server was started with ${READ_ONLY_ENV_VAR}.`,
      "This server can browse the catalog but cannot mutate state, spend funds, or change stored credentials.",
      `Available tools: ${readOnlyToolNames().join(", ")}.`,
      `Lifting this requires restarting the server without ${READ_ONLY_ENV_VAR} — no tool argument can override it.`,
    ].join(" "),
  );
}

/**
 * Assert a tool may run under the current read-only setting.
 *
 * No-op when read-only mode is off or the tool is read-only.
 */
export function assertToolAllowedInReadOnlyMode(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!readOnlyModeEnabled(env)) return;
  if (isReadOnlyTool(toolName)) return;
  throw readOnlyRefusalError(toolName);
}

/**
 * Narrow an advertised tool list to what read-only mode permits.
 *
 * Generic over the element type so it applies equally to `ToolDefinition`s and
 * to the shape ListTools actually returns.
 */
export function filterToolsForReadOnlyMode<T extends { name: string }>(
  tools: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  if (!readOnlyModeEnabled(env)) return [...tools];
  return tools.filter((tool) => isReadOnlyTool(tool.name));
}

/** Compact read-only line for operator/agent status output. */
export function formatReadOnlyDiagnostics(env: NodeJS.ProcessEnv = process.env): string {
  return readOnlyModeEnabled(env)
    ? `Read-only mode: ON (${READ_ONLY_ENV_VAR}) — ${READ_ONLY_TOOLS.size} browsing tools advertised, all others refused`
    : `Read-only mode: off — set ${READ_ONLY_ENV_VAR}=1 to restrict this server to catalog browsing`;
}
