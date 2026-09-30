/**
 * Confirmation guard for the destructive `mindvault_reset` tool.
 *
 * Reset deletes wallet secret keys and publisher API keys from memory and disk.
 * An agent that misreads a prompt can trigger it in a single tool call, and the
 * credentials are unrecoverable (the wallet secret is only ever held here). So
 * the tool is two-step: the first call reports exactly what *would* be removed
 * and changes nothing; only a call carrying an explicit `confirm` performs it.
 *
 * This module is pure — it decides and formats, it never touches the filesystem
 * or process state. `index.ts` gathers the live scope and performs the wipe.
 */

/** A snapshot of what a reset call would destroy, gathered before any mutation. */
export interface ResetScope {
  /** True when the call targets every profile and the state file itself. */
  all: boolean;
  /** Name of the currently active profile. */
  activeProfile: string;
  /** Every known profile name (used to describe an `all` reset). */
  profileNames: string[];
  /** Whether the active profile currently holds a wallet secret key. */
  hasWallet: boolean;
  /** Whether the active profile currently holds a publisher API key. */
  hasApiKey: boolean;
  /** Absolute path of the persisted state file. */
  stateFile: string;
}

/**
 * The complete set of string spellings that confirm a reset.
 *
 * Frozen and compared case-insensitively after trimming. This list is the
 * whole vocabulary: a value not in it is not a confirmation, whatever else in
 * the server might consider it truthy.
 */
export const RESET_CONFIRM_STRINGS = Object.freeze(["true", "1", "yes"] as const);

/** The non-string values that confirm a reset. */
export const RESET_CONFIRM_LITERALS = Object.freeze([true, 1] as const);

/**
 * Whether a reset call carries explicit confirmation.
 *
 * The accepted vocabulary is spelled out here rather than delegated to the
 * mainnet guardrail's `isTruthyConfirm`, even though the two sets are identical
 * today. The server already carries more than one notion of "truthy" — mock
 * mode additionally accepts `"on"`, and the argument validator coerces its own
 * set of flag spellings — and reset is the one tool whose false positive is
 * unrecoverable: it deletes wallet secret keys, and with `all` it deletes every
 * profile and the state file.
 *
 * Sharing a widening helper means a change made for a reversible confirmation
 * silently widens this one too, and an agent that meant something else by a
 * newly-truthy value wipes a keystore it believed it was only inspecting. So
 * the vocabulary is pinned here and in `resetGuard.test.ts`: widening reset has
 * to be an explicit edit to this list, reviewed on its own terms.
 *
 * Everything else — a missing argument, an unlisted string, any object — reads
 * as "not confirmed".
 */
export function isResetConfirmed(value: unknown): boolean {
  if (typeof value === "boolean" || typeof value === "number") {
    return (RESET_CONFIRM_LITERALS as readonly unknown[]).includes(value);
  }
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (RESET_CONFIRM_STRINGS as readonly string[]).includes(normalized);
}

/** Human description of what the reset would clear, used in the warning. */
function describeTarget(scope: ResetScope): string {
  if (scope.all) {
    const count = scope.profileNames.length;
    const names = count > 0 ? [...scope.profileNames].sort().join(", ") : "(none)";
    return `ALL ${count} profile(s) [${names}] and the state file itself`;
  }
  const credentials = [
    scope.hasWallet ? "wallet secret key" : null,
    scope.hasApiKey ? "publisher API key" : null,
  ].filter(Boolean);
  const held = credentials.length > 0 ? credentials.join(" + ") : "no stored credentials";
  return `the active profile "${scope.activeProfile}" (${held})`;
}

/**
 * The warning returned when reset is called without confirmation.
 *
 * Deterministic: the same scope always produces the same text, and producing it
 * has no side effects — nothing is cleared from memory or disk.
 */
export function formatResetPreview(scope: ResetScope): string {
  return [
    `Reset NOT performed — confirmation required.`,
    `This would permanently remove ${describeTarget(scope)}.`,
    `Wallet secret keys cannot be recovered once deleted; back them up first with mindvault_backup_state.`,
    `State file: ${scope.stateFile}`,
    ``,
    `To proceed, call mindvault_reset again with confirm: true` +
      `${scope.all ? " and all: true" : ""}.`,
  ].join("\n");
}
