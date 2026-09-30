import { existsSync, unlinkSync } from "fs";
import {
  activeProfile,
  applyRestoredState,
  currentResetScope,
  profiles,
  saveState,
  setActiveProfileName,
  setProfiles,
  STATE_FILE,
  activeProfileName,
  NETWORK,
} from "../runtime.js";
import { DEFAULT_PROFILE, isValidProfileName } from "../profiles.js";
import {
  checkStatePermissions,
  exportStateFile,
  restoreState as restoreStateFromBackup,
} from "../stateBackup.js";
import { formatResetPreview, isResetConfirmed } from "../resetGuard.js";

export function backupState(passphrase: string, confirm: unknown = false): string {
  if (!isResetConfirmed(confirm)) {
    return [
      "Backup NOT performed — confirmation required.",
      "This will export every wallet secret key and publisher API key in encrypted form.",
      "Keep the passphrase separate from the backup file.",
      "To proceed, call mindvault_backup_state again with confirm: true.",
    ].join("\n");
  }
  const path = exportStateFile(passphrase);
  return [
    "Encrypted state backup written.",
    `File: ${path}`,
    "The file is mode 0600 and contains no plaintext secrets.",
    "Restore it with mindvault_restore_state using the file contents as blob and the same passphrase.",
  ].join("\n");
}

export function restoreStateTool(blob: string, passphrase: string): string {
  return restoreStateFromBackup(blob, passphrase, applyRestoredState, { expectedNetwork: NETWORK });
}

export function resetState(all: boolean, confirm: unknown = false): string {
  if (!isResetConfirmed(confirm)) return formatResetPreview(currentResetScope(all));

  if (all) {
    setProfiles({});
    setActiveProfileName(DEFAULT_PROFILE);
    try {
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    } catch (err) {
      return `All profiles cleared from memory. Warning: could not delete state file (${STATE_FILE}): ${err}`;
    }
    return `Reset complete. All profiles removed from memory and disk.\nState file: ${STATE_FILE}`;
  }

  const name = activeProfileName;
  delete profiles[name];
  saveState();
  return [
    `Profile "${name}" cleared (wallet and publisher API key removed).`,
    `Remaining profiles: ${Object.keys(profiles).length}.`,
    `State file: ${STATE_FILE}`,
  ].join("\n");
}

export function useProfile(nameArg: string): string {
  if (!isValidProfileName(nameArg)) {
    throw new Error(
      `Invalid profile name. Use 1–64 characters from letters, digits, dot, dash, or underscore.`,
    );
  }
  setActiveProfileName(nameArg);
  const profile = activeProfile();
  saveState();
  if (profile.wallet) {
    return [
      `Active profile: ${nameArg}`,
      `Address: ${profile.wallet.publicKey}`,
      `Publisher registered: ${profile.apiKey ? "yes" : "no"}`,
    ].join("\n");
  }
  return `Active profile: ${nameArg}\nNo wallet in this profile yet. Run mindvault_setup_wallet to create one.`;
}

export function listProfiles(): string {
  const names = Object.keys(profiles).sort();
  if (names.length === 0) {
    return `No profiles yet. Run mindvault_setup_wallet to create one (default profile: "${DEFAULT_PROFILE}").`;
  }
  const lines = names.map((name) => {
    const profile = profiles[name];
    const marker = name === activeProfileName ? "*" : " ";
    const address = profile.wallet ? profile.wallet.publicKey : "(no wallet)";
    const registered = profile.apiKey ? ", registered" : "";
    return `${marker} ${name} — ${address}${registered}`;
  });
  return [`Profiles (* = active):`, ...lines].join("\n");
}

export function checkStatePermissionsTool(): string {
  const result = checkStatePermissions();
  const lines = [
    `State file: ${STATE_FILE}`,
    `Exists: ${result.exists}`,
    result.mode ? `Current mode: ${result.mode}` : null,
    `Expected mode: ${result.expectedMode}`,
    `Safe: ${result.isSafe ? "yes" : "no"}`,
    "",
    result.message,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}
