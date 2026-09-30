/**
 * Mainnet readiness guardrails for the MindVault MCP server.
 *
 * When STELLAR_NETWORK / x402 targets mainnet, mutating tools and buys require
 * an explicit confirmation so agents cannot spend real USDC or mutate mainnet
 * state by accident. Read-only tools are never gated.
 *
 * Confirmation sources (any one is enough):
 *   1. Tool argument `confirmMainnet: true`
 *   2. Env `MINDVAULT_ALLOW_MAINNET=1` (or `true` / `yes`)
 *
 * Errors are deterministic and agent-safe (no secrets, no stack traces).
 *
 * Safer defaults for the env override (#606): the operator-side unlock is
 * parsed through {@link mainnetMutationPolicyFromEnv} rather than a bare
 * truthiness check, and the safe default is formalized as
 * {@link DEFAULT_MAINNET_MUTATION_POLICY} — per-call confirmation. The env
 * var must *deliberately* say so to widen the blast radius:
 *
 *   - unset / empty / `0` / `false` / `no` / `off` ⇒ `per-call-confirm`
 *     (unset and empty behaved this way before; the explicit denials are new
 *     spellings of the same default, so an operator can write intent, and so
 *     a template variable like `$MINDVAULT_ALLOW_MAINNET` left unexpanded
 *     cannot unlock anything)
 *   - any other value — including ones a future contributor might consider
 *     "obviously truthy" — stays on the safe default. A typo in a safety
 *     setting must fail towards *more* confirmation, not less.
 *   - only `1` / `true` / `yes` widen the policy to `allow-all`, exactly as
 *     documented.
 *
 * `mainnetAllowedFromEnv` keeps its previous observable behaviour for every
 * value it accepted before; the policy functions make the default explicit so
 * callers other than the guardrail (diagnostics, docs generators) can report
 * which mode the server is actually in. Startup diagnostics flag an
 * ineffective value — a set variable that unlocks nothing — see
 * `diagnostics.ts`.
 */

/** Tools that mutate state or spend funds — gated on mainnet. */
export const MAINNET_GATED_TOOLS = [
  "mindvault_setup_wallet",
  "mindvault_repair_sponsored_account",
  "mindvault_register",
  "mindvault_publish",
  "mindvault_publish_batch",
  "mindvault_buy",
  "mindvault_register_onchain",
  "mindvault_reset",
  "mindvault_update_metadata",
  "mindvault_set_price",
  "mindvault_transfer_ownership",
  "mindvault_accept_transfer",
  "mindvault_cancel_transfer",
  "mindvault_set_listed",
  "mindvault_freeze",
  "mindvault_royalty",
  "mindvault_set_tags",
] as const;

export type MainnetGatedTool = (typeof MAINNET_GATED_TOOLS)[number];

const GATED_SET: ReadonlySet<string> = new Set(MAINNET_GATED_TOOLS);

/** True when the deployment target is mainnet/pubnet. */
export function isMainnetNetwork(network: string | undefined): boolean {
  if (!network) return false;
  const n = network.trim().toLowerCase();
  return (
    n === "mainnet" ||
    n === "pubnet" ||
    n === "public" ||
    n === "stellar:pubnet" ||
    n === "stellar:mainnet"
  );
}

/** Parse truthy confirmation from a tool arg. */
export function isTruthyConfirm(value: unknown): boolean {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

/**
 * The default mainnet mutation policy, when `MINDVAULT_ALLOW_MAINNET` says
 * nothing (or nothing usable): every gated tool needs `confirmMainnet: true`
 * on the call. Exported so diagnostics and generated references can state the
 * default without restating the logic.
 */
export const DEFAULT_MAINNET_MUTATION_POLICY = "per-call-confirm" as const;

/**
 * How this server process treats mainnet mutations.
 *
 * - `per-call-confirm` — the safe default: every gated tool call must carry
 *   `confirmMainnet: true`.
 * - `allow-all` — the operator opted this process out of per-call
 *   confirmation with `MINDVAULT_ALLOW_MAINNET=1` (or `true` / `yes`). Still
 *   narrower than it sounds: the paid-operation policy and the auto-pay
 *   ceiling continue to apply on top of it.
 */
export type MainnetMutationPolicy = "per-call-confirm" | "allow-all";

/**
 * Read the operator's mainnet mutation policy from the environment.
 *
 * Fail-safe by construction: anything other than an explicit, documented
 * opt-in spelling yields {@link DEFAULT_MAINNET_MUTATION_POLICY}. See the
 * module doc comment for the full value table and the reasoning behind
 * treating explicit denials and unrecognized values identically.
 */
export function mainnetMutationPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MainnetMutationPolicy {
  return unsafeMainnetAllow(env.MINDVAULT_ALLOW_MAINNET)
    ? "allow-all"
    : DEFAULT_MAINNET_MUTATION_POLICY;
}

/**
 * Whether one raw `MINDVAULT_ALLOW_MAINNET` value, on its own, would widen
 * the policy to `allow-all`.
 *
 * Kept separate from {@link mainnetMutationPolicyFromEnv} so the diagnostics
 * can distinguish "the operator asked for the unsafe mode" from "the operator
 * set something that does nothing" — a set-but-ineffective value is worth a
 * warning; an unset one is not.
 */
export function unsafeMainnetAllow(raw: unknown): boolean {
  if (raw == null || raw === "") return false;
  return isTruthyConfirm(raw);
}

/**
 * Whether a raw `MINDVAULT_ALLOW_MAINNET` value explicitly re-affirms the
 * safe default (`0` / `false` / `no` / `off`).
 *
 * These are recognized denials, not typos: an operator (or a deployment
 * template) writing one has stated intent, and the resulting behaviour is
 * exactly the documented default. Startup diagnostics stay quiet about them —
 * unlike an unrecognized value such as `$MINDVAULT_ALLOW_MAINNET` or `on`,
 * which unlocks nothing and is almost certainly a mistake worth flagging.
 */
export function isExplicitMainnetDenial(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return new Set(["0", "false", "no", "off"]).has(raw.trim().toLowerCase());
}

/** Operator env override that unlocks all mainnet mutations for this process. */
export function mainnetAllowedFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return mainnetMutationPolicyFromEnv(env) === "allow-all";
}

/** Whether a tool name is gated on mainnet. */
export function isMainnetGatedTool(toolName: string): boolean {
  return GATED_SET.has(toolName);
}

/**
 * Deterministic error when a mainnet mutation/buy is attempted without confirm.
 * Safe for agent-facing output (no secrets, no internal paths).
 */
export function mainnetConfirmationRequiredError(toolName: string): Error {
  return new Error(
    [
      `Mainnet guardrail: "${toolName}" is blocked on mainnet without explicit confirmation.`,
      "This tool mutates state or spends funds on the public Stellar network.",
      "To proceed, pass confirmMainnet: true on this tool call,",
      "or set MINDVAULT_ALLOW_MAINNET=1 on the MCP server process.",
      "Read-only tools (browse, search, preview, registry_lookup, registry_list, tx_status, …) are unrestricted.",
    ].join(" "),
  );
}

/**
 * Assert a tool may run on the current network.
 * No-op on testnet / non-gated tools / when confirmation is present.
 */
export function assertMainnetMutationAllowed(
  network: string | undefined,
  toolName: string,
  args: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isMainnetNetwork(network)) return;
  if (!isMainnetGatedTool(toolName)) return;
  if (mainnetAllowedFromEnv(env)) return;
  if (isTruthyConfirm(args?.confirmMainnet)) return;
  throw mainnetConfirmationRequiredError(toolName);
}

/** Compact mainnet diagnostics line for operator/agent status output. */
export function formatMainnetDiagnostics(input: {
  stellarNetwork: string;
  x402Network: string;
  registryContractId: string;
  allowMainnetEnv: boolean;
}): string {
  const lines = [
    `Network: ${input.stellarNetwork}`,
    `x402: ${input.x402Network}`,
    `Registry: ${input.registryContractId || "(unset — required on mainnet)"}`,
    `Mainnet mutations: ${
      input.allowMainnetEnv
        ? "allowed via MINDVAULT_ALLOW_MAINNET"
        : "require confirmMainnet: true per call"
    }`,
  ];
  return lines.join("\n");
}

/**
 * Session-level banner explaining the active network and exactly how to
 * confirm a mainnet mutation — meant to be read once at the start of an agent
 * session (see mindvault_mainnet_banner in index.ts, which layers the
 * paid-operation confirmation policy from paidOperations.ts on top of this),
 * not repeated on every diagnostic call the way formatMainnetDiagnostics is.
 */
export function formatMainnetBanner(input: {
  stellarNetwork: string;
  x402Network: string;
  registryContractId: string;
  allowMainnetEnv: boolean;
}): string {
  const gatedList = MAINNET_GATED_TOOLS.join(", ");

  if (!isMainnetNetwork(input.stellarNetwork)) {
    return [
      `MindVault MCP session — network: ${input.stellarNetwork} (${input.x402Network}).`,
      "This is a test network: USDC balances and on-chain writes here are not real funds, and no gas fee is real money.",
      `Registry contract: ${input.registryContractId || "(unset)"}.`,
      `Paid and destructive tools (${gatedList}) still run their full flow end-to-end here, at no financial risk, so testnet is safe to explore freely.`,
    ].join("\n");
  }

  return [
    `⚠ MindVault MCP session — network: ${input.stellarNetwork} (${input.x402Network}). THIS IS MAINNET.`,
    "Every purchase, publish, and on-chain write below spends real USDC and/or a real Stellar network transaction fee. There is no undo.",
    `Registry contract: ${input.registryContractId || "(unset — required before any on-chain call will work)"}.`,
    "",
    `Before any paid or destructive operation (${gatedList}), you must confirm explicitly — one of:`,
    "  • pass confirmMainnet: true on that specific tool call, or",
    "  • set MINDVAULT_ALLOW_MAINNET=1 on the MCP server process, which skips per-call confirmation for the rest of this session.",
    "",
    "Read-only tools (browse, search, preview, registry_lookup, registry_list, tx_status, registry_health, network_profile, …) are never gated and never cost anything.",
  ].join("\n");
}
