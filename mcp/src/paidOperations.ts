/**
 * Paid-operation confirmation policy (#594).
 *
 * Some MCP tools spend the agent's money. `mindvault_buy` transfers the
 * resource's asking price in USDC; `mindvault_publish` pays the ~$0.10 USDC
 * x402 verification fee. Others spend only network fees, but they still debit
 * the wallet and land an irreversible transaction on-chain.
 *
 * Two guardrails already exist and neither covers this:
 *
 *   - The **mainnet guardrail** (`mainnetGuardrails.ts`) is network-scoped. On
 *     testnet it never fires, so an agent loop that spends in a cycle is only
 *     caught once it is spending real money.
 *   - The **auto-pay ceiling** (`paymentCeiling.ts`) is amount-scoped. It stops
 *     one large purchase; it says nothing about a hundred small ones.
 *
 * This policy is the third axis: *did the caller mean to spend at all?* It is
 * network-independent and amount-independent, so an operator can require an
 * explicit `confirmPaid: true` on every spend regardless of where the agent is
 * pointed or how cheap the resource is.
 *
 *   MINDVAULT_CONFIRM_PAID_OPERATIONS=off   (default — unchanged behaviour)
 *   MINDVAULT_CONFIRM_PAID_OPERATIONS=usdc  (tools that spend USDC)
 *   MINDVAULT_CONFIRM_PAID_OPERATIONS=all   (also tools that spend network fees)
 *
 * The default is `off` on purpose. This is an opt-in belt for operators who
 * want one, not a new obstacle in front of every existing agent — a guardrail
 * that breaks working deployments on upgrade gets switched off wholesale,
 * which is worse than not shipping it.
 *
 * The policy composes with the other two rather than replacing them: a mainnet
 * buy above the ceiling with `MINDVAULT_CONFIRM_PAID_OPERATIONS=usdc` must
 * satisfy all three. Each answers a different question, so each keeps its own
 * error message.
 *
 * This module is pure — it classifies, decides, and formats. `index.ts` calls
 * `assertPaidOperationConfirmed` in the dispatcher.
 */

import { isTruthyConfirm } from "./mainnetGuardrails.js";

/** Environment variable selecting the confirmation policy. */
export const PAID_CONFIRMATION_ENV_VAR = "MINDVAULT_CONFIRM_PAID_OPERATIONS";

/** The tool argument that satisfies the policy for one call. */
export const PAID_CONFIRMATION_ARG = "confirmPaid";

/**
 * How much confirmation the operator wants.
 *
 * - `off`  — none. The mainnet guardrail and the auto-pay ceiling still apply.
 * - `usdc` — tools that move USDC must carry `confirmPaid: true`.
 * - `all`  — additionally, tools that spend Stellar network fees must too.
 */
export type PaidConfirmationPolicy = "off" | "usdc" | "all";

/** The policy in force when {@link PAID_CONFIRMATION_ENV_VAR} is unset. */
export const DEFAULT_PAID_CONFIRMATION_POLICY: PaidConfirmationPolicy = "off";

const POLICIES: readonly PaidConfirmationPolicy[] = ["off", "usdc", "all"];

/**
 * Tools that spend USDC from the agent wallet.
 *
 * `mindvault_publish` pays the x402 verification fee; `mindvault_buy` pays the
 * resource's asking price. Both settle on-chain and neither can be undone.
 * `mindvault_publish_batch` pays one verification fee per item in the batch.
 */
export const USDC_SPENDING_TOOLS = [
  "mindvault_publish",
  "mindvault_publish_batch",
  "mindvault_buy",
] as const;

/**
 * Tools that submit a Stellar transaction and so spend network fees.
 *
 * No USDC leaves the wallet, but XLM does and the on-chain effect is
 * permanent — which is why `all` exists as a distinct step above `usdc`.
 *
 * `mindvault_setup_wallet` is deliberately absent: account creation runs
 * through the sponsored-account service, so the agent's own wallet funds
 * nothing.
 */
export const FEE_SPENDING_TOOLS = [
  "mindvault_register_onchain",
  "mindvault_update_metadata",
  "mindvault_set_price",
  "mindvault_transfer_ownership",
  "mindvault_set_listed",
  "mindvault_freeze",
  "mindvault_royalty",
] as const;

/** What a tool spends, or `null` when it spends nothing. */
export type PaidOperationClass = "usdc" | "fee";

const USDC_SET: ReadonlySet<string> = new Set(USDC_SPENDING_TOOLS);
const FEE_SET: ReadonlySet<string> = new Set(FEE_SPENDING_TOOLS);

/** Classify what a tool spends. `null` for tools that cost nothing. */
export function paidOperationClass(toolName: string): PaidOperationClass | null {
  if (USDC_SET.has(toolName)) return "usdc";
  if (FEE_SET.has(toolName)) return "fee";
  return null;
}

/** Every tool the policy can gate, sorted — used in errors and by tests. */
export function paidOperationToolNames(): string[] {
  return [...USDC_SPENDING_TOOLS, ...FEE_SPENDING_TOOLS].sort();
}

/**
 * Read the policy from the environment.
 *
 * Throws on an unrecognized value rather than falling back to `off`. A typo in
 * a safety setting must not silently disable it — an operator who wrote
 * `MINDVAULT_CONFIRM_PAID_OPERATIONS=true` needs to hear about it at the first
 * paid call, not discover months later that nothing was ever gated. An empty
 * or whitespace-only value reads as unset, which is the shape a shell leaves
 * behind for a variable that was exported but never given a value.
 */
export function resolvePaidConfirmationPolicy(
  env: NodeJS.ProcessEnv = process.env,
): PaidConfirmationPolicy {
  const raw = env[PAID_CONFIRMATION_ENV_VAR];
  if (raw == null || raw.trim() === "") return DEFAULT_PAID_CONFIRMATION_POLICY;

  const value = raw.trim().toLowerCase();
  if ((POLICIES as readonly string[]).includes(value)) return value as PaidConfirmationPolicy;

  throw new Error(
    `${PAID_CONFIRMATION_ENV_VAR} must be one of: ${POLICIES.join(", ")}. ` +
      `Received "${raw}". Unset the variable to use the default (${DEFAULT_PAID_CONFIRMATION_POLICY}).`,
  );
}

/** Whether `policy` requires explicit confirmation for `toolName`. */
export function requiresPaidConfirmation(
  toolName: string,
  policy: PaidConfirmationPolicy,
): boolean {
  const operation = paidOperationClass(toolName);
  if (operation === null) return false;
  if (policy === "off") return false;
  if (policy === "all") return true;
  return operation === "usdc";
}

/** Human phrase for what the tool costs, used in the refusal. */
function describeCost(operation: PaidOperationClass): string {
  return operation === "usdc"
    ? "spends USDC from the agent wallet and settles on-chain"
    : "submits a Stellar transaction and spends network fees";
}

/**
 * Deterministic error when a paid operation is attempted without confirmation.
 *
 * Names the tool, what it costs, and the two ways forward, so an agent can
 * recover without a round trip to its operator. Safe for agent-facing output:
 * no secrets, no paths, no stack traces.
 */
export function paidConfirmationRequiredError(
  toolName: string,
  policy: PaidConfirmationPolicy,
): Error {
  const operation = paidOperationClass(toolName) ?? "fee";
  return new Error(
    [
      `Paid-operation guardrail: "${toolName}" requires explicit confirmation because this server runs with ${PAID_CONFIRMATION_ENV_VAR}=${policy}.`,
      `This tool ${describeCost(operation)}.`,
      `To proceed, pass ${PAID_CONFIRMATION_ARG}: true on this tool call.`,
      `To stop requiring it, restart the server with ${PAID_CONFIRMATION_ENV_VAR}=off.`,
      "Read-only tools and dry runs are never gated.",
    ].join(" "),
  );
}

/**
 * Assert a paid operation may run under the current policy.
 *
 * No-op when the policy is `off`, the tool spends nothing, the call is a dry
 * run, or the caller passed `confirmPaid: true`.
 *
 * Dry runs are exempt because `mindvault_publish`/`mindvault_buy` with
 * `dryRun: true` submit no payment and no transaction — gating them would
 * require confirming a spend in order to find out what the spend would be,
 * which defeats the purpose of having a dry run.
 */
export function assertPaidOperationConfirmed(input: {
  toolName: string;
  args: Record<string, unknown> | undefined;
  /** True when this call was recognized as a dry run by the dispatcher. */
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  const policy = resolvePaidConfirmationPolicy(input.env ?? process.env);
  if (!requiresPaidConfirmation(input.toolName, policy)) return;
  if (input.dryRun) return;
  if (isTruthyConfirm(input.args?.[PAID_CONFIRMATION_ARG])) return;
  throw paidConfirmationRequiredError(input.toolName, policy);
}

/** Compact policy line for operator/agent status output. */
export function formatPaidConfirmationDiagnostics(env: NodeJS.ProcessEnv = process.env): string {
  let policy: PaidConfirmationPolicy;
  try {
    policy = resolvePaidConfirmationPolicy(env);
  } catch (err) {
    return `Paid-operation confirmation: misconfigured — ${(err as Error).message}`;
  }

  switch (policy) {
    case "off":
      return `Paid-operation confirmation: off — set ${PAID_CONFIRMATION_ENV_VAR}=usdc to require ${PAID_CONFIRMATION_ARG} on spends`;
    case "usdc":
      return `Paid-operation confirmation: USDC spends require ${PAID_CONFIRMATION_ARG}: true (${USDC_SPENDING_TOOLS.join(", ")})`;
    case "all":
      return `Paid-operation confirmation: every spend requires ${PAID_CONFIRMATION_ARG}: true (${paidOperationToolNames().join(", ")})`;
  }
}
