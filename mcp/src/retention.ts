/**
 * Configurable retention and size limits for MCP state and audit files —
 * issue #1044.
 *
 * State backups, rotated audit generations and purchase receipts all grow
 * without anyone tending them: a server left running for months accumulates
 * encrypted backups nobody restores, numbered audit generations nobody reads,
 * and receipts for purchases long since settled. This module exposes the
 * bounds as documented environment variables with safe defaults, and applies
 * them with one idempotent pass, {@link applyRetentionPolicies}.
 *
 * Three invariants shape the implementation:
 *
 *   1. The active state file (`~/.mindvault/state.json`, plus its
 *      `.corrupt-*` / `.legacy` siblings) and the live audit log are never
 *      deletion candidates, whatever directory a scan happens to look at.
 *   2. Parsing never throws: an unset or malformed value falls back to the
 *      documented default, so cleanup is always operable. Startup validation
 *      (which rejects invalid values loudly) lives in diagnostics.ts.
 *   3. Deletion order is deterministic — oldest first, ties broken by name —
 *      and boundaries are inclusive: a file exactly at its age limit is kept,
 *      and the count limit keeps the newest N.
 *
 * Every failure is collected into the returned report rather than thrown:
 * cleanup is opportunistic, and a read-only directory must degrade into a
 * noted error, not a crashed server.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  loadPurchaseHistory,
  purchasesFilePath,
  PURCHASE_HISTORY_EPOCH,
  PURCHASE_HISTORY_VERSION,
  type PurchaseHistoryFile,
} from "./purchaseHistory.js";
import { writeAtomically } from "./stateBackup.js";

/** Directory holding the active state file; never scanned for deletion. */
const STATE_DIR = join(homedir(), ".mindvault");

/** Default directory the state-backup prune scans (`state-*.backup` files). */
const DEFAULT_BACKUP_DIR = join(STATE_DIR, "backups");

/** Environment variables controlling retention (#1044). */
export const RETENTION_ENV_VARS = {
  stateBackupMaxAgeDays: "MINDVAULT_STATE_BACKUP_MAX_AGE_DAYS",
  stateBackupMaxFiles: "MINDVAULT_STATE_BACKUP_MAX_FILES",
  stateBackupMaxBytes: "MINDVAULT_STATE_BACKUP_MAX_BYTES",
  auditLogMaxAgeDays: "MINDVAULT_AUDIT_LOG_MAX_AGE_DAYS",
  receiptRetentionDays: "MINDVAULT_RECEIPT_RETENTION_DAYS",
} as const;

/** 30 days: old enough to cover a restore window, short enough to stay small. */
export const DEFAULT_STATE_BACKUP_MAX_AGE_DAYS = 30;

/** Encrypted backups kept besides nothing in particular: 10 by default. */
export const DEFAULT_STATE_BACKUP_MAX_FILES = 10;

/** 50 MiB: room for several encrypted snapshots, bounded enough for laptops. */
export const DEFAULT_STATE_BACKUP_MAX_BYTES = 50 * 1024 * 1024;

/** Rotated audit generations past two weeks are dropped by default. */
export const DEFAULT_AUDIT_LOG_MAX_AGE_DAYS = 14;

/** Receipts are kept for a quarter by default — long enough for disputes. */
export const DEFAULT_RECEIPT_RETENTION_DAYS = 90;

/** A day is the coarsest unit any retention knob measures. */
export const MIN_STATE_BACKUP_MAX_AGE_DAYS = 1;

/** Zero files would delete every backup on each pass; floor is one. */
export const MIN_STATE_BACKUP_MAX_FILES = 1;

/** 10 KiB: below this the cap could not hold a single meaningful snapshot. */
export const MIN_STATE_BACKUP_MAX_BYTES = 10240;

/** Rotated audit generations are never younger than a day. */
export const MIN_AUDIT_LOG_MAX_AGE_DAYS = 1;

/** Receipts are never pruned before they are a day old. */
export const MIN_RECEIPT_RETENTION_DAYS = 1;

/** Milliseconds in a day; every age knob is expressed in days. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Resolved retention settings — always valid numbers, always operable. */
export interface RetentionSettings {
  /** Age limit for `state-*.backup` files, in days. */
  stateBackupMaxAgeDays: number;
  /** Newest N backups kept after the age pass, in files. */
  stateBackupMaxFiles: number;
  /** Total-size ceiling for the backups directory, in bytes. */
  stateBackupMaxBytes: number;
  /** Age limit for rotated audit generations, in days. */
  auditLogMaxAgeDays: number;
  /** Age limit for purchase receipts, in days. */
  receiptRetentionDays: number;
}

/** Result of the state-backup pass. */
export interface BackupsRetentionResult {
  /** `state-*.backup` files examined (protected names excluded). */
  scanned: number;
  /** Backups actually deleted. */
  removed: number;
  /** Bytes freed by the deletions above. */
  bytesFreed: number;
}

/** Result of the rotated-audit pass. */
export interface AuditRetentionResult {
  /** Rotated generations (`.N` suffixes) examined. */
  scanned: number;
  /** Generations actually deleted. */
  removed: number;
}

/** Result of the receipts pass. */
export interface ReceiptsRetentionResult {
  /** Receipts read from the purchases store. */
  scanned: number;
  /** Receipts pruned by age (written back to the store). */
  removed: number;
}

/**
 * Outcome of one cleanup pass. JSON-serializable and stable for identical
 * inputs, so callers can log or diff it directly. Filesystem failures land in
 * `errors` instead of being thrown.
 */
export interface RetentionReport {
  backups: BackupsRetentionResult;
  audit: AuditRetentionResult;
  receipts: ReceiptsRetentionResult;
  /** Per-target failures encountered; empty means a clean pass. */
  errors: string[];
}

/**
 * Parse one positive-integer setting.
 *
 * Unset, empty, non-numeric, fractional or below-minimum input all fall back
 * to `fallback` — the parser is total by design, so a typo can never stop the
 * server or the cleanup pass that reads it.
 */
function parsePositiveInt(raw: string | undefined, fallback: number, minimum: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return parsed;
}

/**
 * Resolve the retention settings from the environment.
 *
 * Unset variables yield the documented defaults; values that are not positive
 * integers at or above their minimums do too (never a throw). Startup
 * diagnostics report such values loudly — see `collectStartupDiagnostics` —
 * while this resolver keeps cleanup runnable regardless.
 */
export function resolveRetentionSettings(env: NodeJS.ProcessEnv = process.env): RetentionSettings {
  return {
    stateBackupMaxAgeDays: parsePositiveInt(
      env[RETENTION_ENV_VARS.stateBackupMaxAgeDays],
      DEFAULT_STATE_BACKUP_MAX_AGE_DAYS,
      MIN_STATE_BACKUP_MAX_AGE_DAYS,
    ),
    stateBackupMaxFiles: parsePositiveInt(
      env[RETENTION_ENV_VARS.stateBackupMaxFiles],
      DEFAULT_STATE_BACKUP_MAX_FILES,
      MIN_STATE_BACKUP_MAX_FILES,
    ),
    stateBackupMaxBytes: parsePositiveInt(
      env[RETENTION_ENV_VARS.stateBackupMaxBytes],
      DEFAULT_STATE_BACKUP_MAX_BYTES,
      MIN_STATE_BACKUP_MAX_BYTES,
    ),
    auditLogMaxAgeDays: parsePositiveInt(
      env[RETENTION_ENV_VARS.auditLogMaxAgeDays],
      DEFAULT_AUDIT_LOG_MAX_AGE_DAYS,
      MIN_AUDIT_LOG_MAX_AGE_DAYS,
    ),
    receiptRetentionDays: parsePositiveInt(
      env[RETENTION_ENV_VARS.receiptRetentionDays],
      DEFAULT_RECEIPT_RETENTION_DAYS,
      MIN_RECEIPT_RETENTION_DAYS,
    ),
  };
}

let backupDirOverride: string | null = null;

/**
 * Test helper: point the state-backup prune at a temp directory (or reset
 * with null). Mirrors `_setPurchasesFilePath` so no test ever needs to touch
 * the real `~/.mindvault`.
 */
export function _setBackupDirForTests(path: string | null): void {
  backupDirOverride = path;
}

/** The directory the state-backup pass scans. */
function backupDir(): string {
  return backupDirOverride ?? DEFAULT_BACKUP_DIR;
}

/**
 * The active state file and its quarantine/legacy siblings — never deletion
 * candidates, whatever directory a scan looks at. Checked before the
 * `state-*.backup` pattern as explicit belt-and-braces: deleting the only
 * copy of a wallet's secrets is the one unrecoverable mistake here.
 */
function isProtectedStateName(name: string): boolean {
  return name === "state.json" || name.includes(".corrupt-") || name.endsWith(".legacy");
}

/** True for `state-*.backup` files — the only backup-prune candidates. */
function isStateBackupFile(name: string): boolean {
  return name.startsWith("state-") && name.endsWith(".backup");
}

/**
 * True for rotated audit generations of `baseName`: `audit.jsonl.1`, `.2`, …
 * The live file itself, temp files and anything with a non-numeric suffix are
 * excluded, so the active log can never match.
 */
function isRotatedAuditFile(baseName: string, name: string): boolean {
  if (!name.startsWith(`${baseName}.`)) return false;
  return /^\d+$/.test(name.slice(baseName.length + 1));
}

/** Oldest first; ties broken by name so equal mtimes prune deterministically. */
function oldestFirst(
  a: { mtime: number; name: string },
  b: { mtime: number; name: string },
): number {
  if (a.mtime !== b.mtime) return a.mtime - b.mtime;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** A filesystem error as a short, throwable-free string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Unlink one file; failures land in `errors` rather than propagating. */
function safeUnlink(path: string, errors: string[]): void {
  try {
    unlinkSync(path);
  } catch (error) {
    errors.push(`Failed to delete ${path}: ${describeError(error)}`);
  }
}

interface BackupCandidate {
  name: string;
  path: string;
  mtime: number;
  size: number;
}

/**
 * Prune the backups directory: age first, then count, then total bytes.
 *
 * Each step operates on the survivors of the previous one, oldest first, so
 * the outcome is a pure function of the directory contents and the settings.
 * Protected names are filtered before anything is counted or considered.
 */
function pruneBackups(settings: RetentionSettings, now: Date, report: RetentionReport): void {
  const directory = backupDir();
  if (!existsSync(directory)) return;

  try {
    const candidates: BackupCandidate[] = [];
    for (const name of readdirSync(directory)) {
      if (isProtectedStateName(name)) continue;
      if (!isStateBackupFile(name)) continue;
      const path = join(directory, name);
      try {
        const stats = statSync(path);
        candidates.push({ name, path, mtime: stats.mtimeMs, size: stats.size });
      } catch (error) {
        report.errors.push(`Failed to inspect state backup ${path}: ${describeError(error)}`);
      }
    }
    report.backups.scanned = candidates.length;
    candidates.sort(oldestFirst);

    const removedPaths = new Set<string>();
    const remove = (candidate: BackupCandidate): boolean => {
      if (removedPaths.has(candidate.path)) return false;
      safeUnlink(candidate.path, report.errors);
      if (existsSync(candidate.path)) return false;
      removedPaths.add(candidate.path);
      report.backups.removed += 1;
      report.backups.bytesFreed += candidate.size;
      return true;
    };

    // 1. Age: strictly older than the limit goes; exactly at the limit stays.
    const maxAgeMs = settings.stateBackupMaxAgeDays * MS_PER_DAY;
    for (const candidate of candidates) {
      if (now.getTime() - candidate.mtime > maxAgeMs) remove(candidate);
    }

    // 2. Count: keep the newest N; with N or fewer survivors, nothing moves.
    const afterAge = candidates.filter((candidate) => !removedPaths.has(candidate.path));
    const excess = Math.max(0, afterAge.length - settings.stateBackupMaxFiles);
    for (const candidate of afterAge.slice(0, excess)) remove(candidate);

    // 3. Total size: drop oldest until the directory is at or under the cap.
    const afterCount = candidates.filter((candidate) => !removedPaths.has(candidate.path));
    let totalBytes = 0;
    for (const candidate of afterCount) totalBytes += candidate.size;
    for (const candidate of afterCount) {
      if (totalBytes <= settings.stateBackupMaxBytes) break;
      if (remove(candidate)) totalBytes -= candidate.size;
    }
  } catch (error) {
    report.errors.push(`Failed to prune state backups: ${describeError(error)}`);
  }
}

/**
 * Prune rotated audit generations past the age limit.
 *
 * Only `.N` suffixes are candidates, so the live audit file is untouchable by
 * construction; the file sink itself keeps its own byte/count rotation
 * (auditLogRotation.ts). No audit file configured means no work.
 */
function pruneAuditGenerations(
  env: NodeJS.ProcessEnv,
  settings: RetentionSettings,
  now: Date,
  report: RetentionReport,
): void {
  const configured = env.MINDVAULT_AUDIT_LOG_FILE?.trim();
  if (!configured) return;

  const directory = dirname(configured);
  if (!existsSync(directory)) return;

  try {
    const baseName = basename(configured);
    const rotated: Array<{ name: string; path: string; mtime: number }> = [];
    for (const name of readdirSync(directory)) {
      if (!isRotatedAuditFile(baseName, name)) continue;
      const path = join(directory, name);
      try {
        const stats = statSync(path);
        rotated.push({ name, path, mtime: stats.mtimeMs });
      } catch (error) {
        report.errors.push(
          `Failed to inspect audit log generation ${path}: ${describeError(error)}`,
        );
      }
    }
    report.audit.scanned = rotated.length;
    rotated.sort(oldestFirst);

    const maxAgeMs = settings.auditLogMaxAgeDays * MS_PER_DAY;
    for (const generation of rotated) {
      if (now.getTime() - generation.mtime > maxAgeMs) {
        safeUnlink(generation.path, report.errors);
        if (!existsSync(generation.path)) report.audit.removed += 1;
      }
    }
  } catch (error) {
    report.errors.push(`Failed to prune audit logs: ${describeError(error)}`);
  }
}

/**
 * Prune receipts older than the retention window from the purchases store.
 *
 * The store is rewritten in one atomic step (temp file + rename via
 * `writeAtomically`), so a crash mid-prune leaves either the old file or the
 * new one — never a half-written JSON document. Receipts whose timestamp
 * cannot be parsed are kept: data loss from a strict reading would be worse
 * than an unbounded record. Nothing to remove means nothing written, so an
 * absent store is never created by a cleanup pass.
 */
function pruneReceipts(settings: RetentionSettings, now: Date, report: RetentionReport): void {
  try {
    const store = loadPurchaseHistory();
    report.receipts.scanned = store.purchases.length;
    if (store.purchases.length === 0) return;

    const cutoff = now.getTime() - settings.receiptRetentionDays * MS_PER_DAY;
    const kept = store.purchases.filter((receipt) => {
      const recorded = Date.parse(receipt.timestamp);
      return !Number.isFinite(recorded) || recorded >= cutoff;
    });
    if (kept.length === store.purchases.length) return;

    const pruned: PurchaseHistoryFile = {
      version: PURCHASE_HISTORY_VERSION,
      epoch: PURCHASE_HISTORY_EPOCH,
      purchases: kept,
    };
    const path = purchasesFilePath();
    writeAtomically(path, JSON.stringify(pruned, null, 2), 0o600);
    report.receipts.removed = store.purchases.length - kept.length;
  } catch (error) {
    report.errors.push(`Failed to prune receipts: ${describeError(error)}`);
  }
}

/**
 * Apply every retention policy once and report what happened.
 *
 * Order is fixed — state backups (age, then count, then bytes), rotated audit
 * generations, receipts — and each pass is independent: a failure in one is
 * recorded in `errors` and never stops the others. `now` is injectable so
 * age boundaries are testable without waiting a month.
 *
 * Never throws, never deletes the active state file or the live audit log,
 * and returns a JSON-serializable report that is stable for identical inputs.
 */
export function applyRetentionPolicies(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): RetentionReport {
  const settings = resolveRetentionSettings(env);
  const report: RetentionReport = {
    backups: { scanned: 0, removed: 0, bytesFreed: 0 },
    audit: { scanned: 0, removed: 0 },
    receipts: { scanned: 0, removed: 0 },
    errors: [],
  };

  pruneBackups(settings, now, report);
  pruneAuditGenerations(env, settings, now, report);
  pruneReceipts(settings, now, report);

  return report;
}
