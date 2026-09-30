/**
 * Encrypted local-state backup and restore for the MindVault MCP server.
 *
 * State holds credentials (wallet secret keys, publisher API keys), so a backup
 * must never leak plaintext secrets. This module encrypts the persisted
 * ProfileState with AES-256-GCM, keyed from a caller-supplied passphrase via
 * scrypt. The output is a single base64 string an agent can copy between
 * environments.
 *
 * Integrity is bound to the ciphertext: any tampering or wrong passphrase fails
 * the GCM auth tag before any state is touched, so restoreState is safe to
 * call on untrusted input.
 *
 * Reset behavior is intentionally untouched — this module only adds export/import.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { STATE_VERSION, type ProfileState, type WalletProfile } from "./profiles.js";

const STATE_DIR = join(homedir(), ".mindvault");
const STATE_FILE = join(STATE_DIR, "state.json");
const BACKUP_DIR = join(STATE_DIR, "backups");

// scrypt cost params — tuned for interactive passphrase derivation (not hot path).
// N=2^14 keeps OpenSSL maxmem happy in constrained CI/agent envs.
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 8 * 2;

/** Deterministic, agent-safe error messages (no internal details leaked). */
export class StateBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateBackupError";
  }
}

export interface RestoreStateOptions {
  expectedNetwork?: string;
}

export interface PersistedStateSecretMatch {
  path: string;
  kind: "wallet-secret-key" | "api-key";
}

/**
 * Report secret-bearing fields in an unencrypted persisted-state backup before
 * it is shared. Encrypted `exportState` output is safe to transport instead.
 */
export function scanPersistedStateSecrets(raw: unknown): PersistedStateSecretMatch[] {
  if (!raw || typeof raw !== "object") return [];
  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== "object") return [];

  const matches: PersistedStateSecretMatch[] = [];
  for (const [profileName, value] of Object.entries(profiles as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const profile = value as { apiKey?: unknown; wallet?: { secretKey?: unknown } };
    if (typeof profile.wallet?.secretKey === "string" && profile.wallet.secretKey.length > 0) {
      matches.push({ path: `profiles.${profileName}.wallet.secretKey`, kind: "wallet-secret-key" });
    }
    if (typeof profile.apiKey === "string" && profile.apiKey.length > 0) {
      matches.push({ path: `profiles.${profileName}.apiKey`, kind: "api-key" });
    }
  }
  return matches;
}

/**
 * Read the current persisted state. Returns a normalized ProfileState.
 * Throws a deterministic error when the state file is missing or unreadable.
 */
export function readPersistedState(): ProfileState {
  if (!existsSync(STATE_FILE)) {
    throw new StateBackupError("No state file found. Run mindvault_setup_wallet first.");
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizePersisted(parsed);
  } catch {
    throw new StateBackupError("State file is corrupted and could not be read.");
  }
}

/**
 * Export the current state as an encrypted, base64-encoded string.
 *
 * The output is self-contained: v1:<salt>:<nonce>:<ciphertext+tag>. The
 * passphrase is never stored or logged. Plaintext secrets never appear in the
 * output — only the encrypted profile bytes do.
 */
export function exportState(passphrase: string): string {
  if (!passphrase || passphrase.length < 8) {
    throw new StateBackupError("Passphrase must be at least 8 characters.");
  }
  const state = readPersistedState();
  const payload = JSON.stringify(state);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([ciphertext, tag]);
  return `v1:${salt.toString("base64")}:${nonce.toString("base64")}:${blob.toString("base64")}`;
}

/** Encrypt the current state and write a private recovery file. */
export function exportStateFile(
  passphrase: string,
  now: Date = new Date(),
  directory: string = BACKUP_DIR,
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(directory, `state-${stamp}.backup`);
  writeAtomically(path, `${exportState(passphrase)}\n`, 0o600);
  return path;
}

/**
 * Restore state from an encrypted backup string.
 *
 * Validates the passphrase and integrity (GCM auth tag) before writing anything.
 * On success the in-memory state is replaced and re-persisted (mode 0600).
 * On any failure no state is modified and a deterministic error is thrown.
 */
export function restoreState(
  blob: string,
  passphrase: string,
  write: (state: ProfileState) => void,
  options: RestoreStateOptions = {},
): string {
  if (!passphrase || passphrase.length < 8) {
    throw new StateBackupError("Passphrase must be at least 8 characters.");
  }
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new StateBackupError("Invalid backup format.");
  }
  let salt: Buffer;
  let nonce: Buffer;
  let payload: Buffer;
  try {
    salt = Buffer.from(parts[1], "base64");
    nonce = Buffer.from(parts[2], "base64");
    payload = Buffer.from(parts[3], "base64");
  } catch {
    throw new StateBackupError("Invalid backup encoding.");
  }
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN || payload.length < AUTH_TAG_LEN) {
    throw new StateBackupError("Invalid backup payload.");
  }
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const ciphertext = payload.subarray(0, payload.length - AUTH_TAG_LEN);
  const tag = payload.subarray(payload.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new StateBackupError(
      "Backup integrity check failed (wrong passphrase or tampered data).",
    );
  }
  let state: ProfileState;
  try {
    state = normalizePersisted(JSON.parse(plaintext));
  } catch {
    throw new StateBackupError("Backup contents are not valid state.");
  }
  if (options.expectedNetwork) {
    const mismatched = Object.entries(state.profiles).find(
      ([, profile]) => profile.network && profile.network !== options.expectedNetwork,
    );
    if (mismatched) {
      throw new StateBackupError(
        `Backup belongs to network "${mismatched[1].network}" but the active profile uses "${options.expectedNetwork}".`,
      );
    }
  }
  write(state);
  return `State restored: ${Object.keys(state.profiles).length} profile(s), active "${state.activeProfile}".`;
}

/**
 * Normalize an unknown parsed value into a valid ProfileState, mirroring the
 * rules in profiles.ts (valid profile names, valid wallets, non-empty API
 * keys). Unrecognized fields are dropped so restored state cannot smuggle junk.
 */
function normalizePersisted(raw: unknown): ProfileState {
  if (!raw || typeof raw !== "object") {
    return { version: STATE_VERSION, activeProfile: "default", profiles: {} };
  }
  const obj = raw as Record<string, unknown>;
  const profiles: Record<string, WalletProfile> = {};
  const rawProfiles =
    obj.profiles && typeof obj.profiles === "object"
      ? (obj.profiles as Record<string, unknown>)
      : {};
  for (const [name, value] of Object.entries(rawProfiles)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const profile: WalletProfile = {};
    const w = v.wallet;
    if (w && typeof w === "object") {
      const ww = w as Record<string, unknown>;
      if (
        typeof ww.publicKey === "string" &&
        ww.publicKey.length > 0 &&
        typeof ww.secretKey === "string" &&
        ww.secretKey.length > 0
      ) {
        profile.wallet = { publicKey: ww.publicKey, secretKey: ww.secretKey };
      }
    }
    if (typeof v.apiKey === "string" && v.apiKey.length > 0) profile.apiKey = v.apiKey;
    if (v.network === "testnet" || v.network === "mainnet") profile.network = v.network;
    profiles[name] = profile;
  }
  const requested = typeof obj.activeProfile === "string" ? obj.activeProfile : "default";
  const activeProfile = (requested in profiles ? requested : Object.keys(profiles)[0]) ?? "default";
  return { version: STATE_VERSION, activeProfile, profiles };
}

/**
 * Write bytes to a temp file in the same directory and atomically rename it over
 * the destination to avoid partial writes. The destination is never left half-
 * written when the rename fails, and the file retains the requested mode.
 */
export function writeAtomically(
  filePath: string,
  data: string,
  mode: number,
  ops: Partial<typeof import("fs")> = {},
): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const writeSync = ops.writeFileSync ?? writeFileSync;
  const rename = ops.renameSync ?? renameSync;
  const chmod = ops.chmodSync ?? chmodSync;
  const pathExists = ops.existsSync ?? existsSync;
  const remove = ops.unlinkSync ?? unlinkSync;

  try {
    writeSync(tempPath, data, { mode });
    rename(tempPath, filePath);
    chmod(filePath, mode);
  } catch (err) {
    try {
      if (pathExists(tempPath)) remove(tempPath);
    } catch {
      // ignore cleanup errors; the caller already received the write failure
    }
    throw err;
  }
}

/**
 * Persist a restored ProfileState to disk (mode 0600), mirroring saveState in
 * index.ts. Exposed for testability.
 */
export function persistState(state: ProfileState): void {
  try {
    writeAtomically(STATE_FILE, JSON.stringify(state, null, 2), 0o600);
  } catch (err) {
    throw new StateBackupError(`Failed to persist restored state: ${err}`);
  }
}

/**
 * Preserve an unreadable or structurally invalid state file instead of letting
 * the next `saveState()` overwrite the only copy of it.
 *
 * The corrupted file is moved aside to `<file>.corrupt-<now-ms>` (same owner
 * and mode as the original) so the evidence is never lost and the live path is
 * clean for a fresh start. Returns the quarantine path when it worked and
 * throws otherwise.
 */
export function quarantineStateFile(
  filePath: string = STATE_FILE,
  now: number = Date.now(),
): string {
  const quarantinePath = `${filePath}.corrupt-${now}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    renameSync(filePath, quarantinePath);
    return quarantinePath;
  } catch (err) {
    throw new StateBackupError(`Failed to quarantine corrupted state file: ${err}`);
  }
}

/**
 * Snapshot the pre-migration legacy state before it is re-persisted, so a later
 * migration cannot destroy the only record of the original format.
 *
 * The legacy JSON is written to `<file>.legacy` (mode 0600, like the state file
 * itself). Throws when the snapshot could not be saved so the caller can decide
 * whether to proceed with the migration.
 */
export function preserveLegacyState(raw: unknown, filePath: string = STATE_FILE): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(`${filePath}.legacy`, JSON.stringify(raw, null, 2), { mode: 0o600 });
  } catch (err) {
    throw new StateBackupError(`Failed to preserve legacy state before migration: ${err}`);
  }
}

// ── State file permission checks ────────────────────────────────────────────

export interface StatePermissionResult {
  exists: boolean;
  mode: string | null;
  expectedMode: string;
  isSafe: boolean;
  message: string;
}

/**
 * Format a numeric mode as a 4-digit octal string (e.g. 0o600 → "0600").
 */
function formatMode(mode: number): string {
  return "0" + (mode & 0o7777).toString(8).padStart(3, "0");
}

/**
 * Check the state file's permissions. Returns whether the file exists, its
 * current mode, whether it matches the expected 0600, and an actionable message.
 *
 * The state file contains wallet secret keys and publisher API keys, so it
 * must be mode 0600 (owner read/write only). Broader permissions (e.g. 0644)
 * allow other users on the system to read the secrets.
 */
export function checkStatePermissions(): StatePermissionResult {
  const EXPECTED = 0o600;
  const expectedStr = formatMode(EXPECTED);

  if (!existsSync(STATE_FILE)) {
    return {
      exists: false,
      mode: null,
      expectedMode: expectedStr,
      isSafe: true,
      message: `State file ${STATE_FILE} does not exist. No secrets to protect.`,
    };
  }

  try {
    const stat = statSync(STATE_FILE);
    // stat.mode includes file type bits; mask to permission bits only.
    const permBits = stat.mode & 0o7777;
    const currentStr = formatMode(permBits);
    const isSafe = permBits === EXPECTED;

    if (isSafe) {
      return {
        exists: true,
        mode: currentStr,
        expectedMode: expectedStr,
        isSafe: true,
        message: `State file permissions are safe (${currentStr}).`,
      };
    }

    // Build an actionable warning for unsafe modes.
    const othersRead = (permBits & 0o004) !== 0;
    const groupRead = (permBits & 0o040) !== 0;
    const issues: string[] = [];
    if (othersRead) issues.push("world-readable (other can read)");
    if (groupRead) issues.push("group-readable");
    if ((permBits & 0o002) !== 0) issues.push("world-writable");
    if ((permBits & 0o020) !== 0) issues.push("group-writable");

    return {
      exists: true,
      mode: currentStr,
      expectedMode: expectedStr,
      isSafe: false,
      message: [
        `State file permissions are UNSAFE (${currentStr}): ${issues.join(", ")}.`,
        `Wallet secret keys and API keys may be readable by other users.`,
        `Fix: chmod ${expectedStr} ${STATE_FILE}`,
      ].join("\n"),
    };
  } catch (err) {
    return {
      exists: true,
      mode: null,
      expectedMode: expectedStr,
      isSafe: false,
      message: `Could not read state file permissions: ${err}`,
    };
  }
}
