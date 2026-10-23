/**
 * Tests for configurable state/audit retention — issue #1044.
 *
 * Two properties carry the feature: the settings fall back to their
 * documented defaults instead of ever throwing, and a cleanup pass never
 * touches the active state file or the live audit log — including at the
 * exact age, count and size boundaries where a permissive comparison would
 * delete one file too early.
 *
 * Every pass runs against mkdtempSync temp directories (backup dir and
 * purchases store are both redirected), so no test can read or delete the
 * real ~/.mindvault.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_AUDIT_LOG_MAX_AGE_DAYS,
  DEFAULT_RECEIPT_RETENTION_DAYS,
  DEFAULT_STATE_BACKUP_MAX_AGE_DAYS,
  DEFAULT_STATE_BACKUP_MAX_BYTES,
  DEFAULT_STATE_BACKUP_MAX_FILES,
  MIN_STATE_BACKUP_MAX_BYTES,
  RETENTION_ENV_VARS,
  _setBackupDirForTests,
  applyRetentionPolicies,
  resolveRetentionSettings,
  type RetentionReport,
} from "./retention.js";
import { _setPurchasesFilePath, loadPurchaseHistory, recordPurchase } from "./purchaseHistory.js";
import { collectStartupDiagnostics, type StartupDiagnostic } from "./diagnostics.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Diagnostics raised for one of the five retention variables. */
function retentionDiagnostics(diagnostics: StartupDiagnostic[]): StartupDiagnostic[] {
  const retentionNames = new Set(Object.values(RETENTION_ENV_VARS));
  return diagnostics.filter((item) => retentionNames.has(item.variable as never));
}

let testDir: string;
let backupDir: string;
let purchasesPath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "mv-retention-"));
  backupDir = join(testDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  purchasesPath = join(testDir, "purchases.json");
  _setBackupDirForTests(backupDir);
  _setPurchasesFilePath(purchasesPath);
});

afterEach(() => {
  _setBackupDirForTests(null);
  _setPurchasesFilePath(null);
  rmSync(testDir, { recursive: true, force: true });
});

/** Create a state backup whose mtime sits exactly at `mtime`. */
function writeBackup(name: string, mtime: Date, content = "backup-bytes"): string {
  const path = join(backupDir, name);
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
  return path;
}

describe("resolveRetentionSettings", () => {
  it("uses the documented defaults when every variable is unset", () => {
    expect(resolveRetentionSettings({})).toEqual({
      stateBackupMaxAgeDays: DEFAULT_STATE_BACKUP_MAX_AGE_DAYS,
      stateBackupMaxFiles: DEFAULT_STATE_BACKUP_MAX_FILES,
      stateBackupMaxBytes: DEFAULT_STATE_BACKUP_MAX_BYTES,
      auditLogMaxAgeDays: DEFAULT_AUDIT_LOG_MAX_AGE_DAYS,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
    });
  });

  it("reads every override from the environment", () => {
    const env = {
      [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "7",
      [RETENTION_ENV_VARS.stateBackupMaxFiles]: "5",
      [RETENTION_ENV_VARS.stateBackupMaxBytes]: "100000",
      [RETENTION_ENV_VARS.auditLogMaxAgeDays]: "3",
      [RETENTION_ENV_VARS.receiptRetentionDays]: "60",
    } as NodeJS.ProcessEnv;

    expect(resolveRetentionSettings(env)).toEqual({
      stateBackupMaxAgeDays: 7,
      stateBackupMaxFiles: 5,
      stateBackupMaxBytes: 100000,
      auditLogMaxAgeDays: 3,
      receiptRetentionDays: 60,
    });
  });

  it("falls back to defaults for values below the documented minimums", () => {
    const env = {
      [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "0",
      [RETENTION_ENV_VARS.stateBackupMaxFiles]: "-1",
      [RETENTION_ENV_VARS.stateBackupMaxBytes]: "5000", // min is 10240
      [RETENTION_ENV_VARS.auditLogMaxAgeDays]: "0",
      [RETENTION_ENV_VARS.receiptRetentionDays]: "0",
    } as NodeJS.ProcessEnv;

    expect(resolveRetentionSettings(env)).toEqual({
      stateBackupMaxAgeDays: DEFAULT_STATE_BACKUP_MAX_AGE_DAYS,
      stateBackupMaxFiles: DEFAULT_STATE_BACKUP_MAX_FILES,
      stateBackupMaxBytes: DEFAULT_STATE_BACKUP_MAX_BYTES,
      auditLogMaxAgeDays: DEFAULT_AUDIT_LOG_MAX_AGE_DAYS,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
    });
  });

  it("never throws on garbage input and still returns defaults", () => {
    const env = {
      [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "abc",
      [RETENTION_ENV_VARS.stateBackupMaxFiles]: "NaN",
      [RETENTION_ENV_VARS.stateBackupMaxBytes]: "1.5",
      [RETENTION_ENV_VARS.auditLogMaxAgeDays]: "ten",
      [RETENTION_ENV_VARS.receiptRetentionDays]: "90d",
    } as NodeJS.ProcessEnv;

    let settings: ReturnType<typeof resolveRetentionSettings> | undefined;
    expect(() => {
      settings = resolveRetentionSettings(env);
    }).not.toThrow();
    expect(settings).toEqual({
      stateBackupMaxAgeDays: DEFAULT_STATE_BACKUP_MAX_AGE_DAYS,
      stateBackupMaxFiles: DEFAULT_STATE_BACKUP_MAX_FILES,
      stateBackupMaxBytes: DEFAULT_STATE_BACKUP_MAX_BYTES,
      auditLogMaxAgeDays: DEFAULT_AUDIT_LOG_MAX_AGE_DAYS,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
    });
  });

  it("accepts a value exactly at each minimum", () => {
    const env = {
      [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "1",
      [RETENTION_ENV_VARS.stateBackupMaxFiles]: "1",
      [RETENTION_ENV_VARS.stateBackupMaxBytes]: String(MIN_STATE_BACKUP_MAX_BYTES),
      [RETENTION_ENV_VARS.auditLogMaxAgeDays]: "1",
      [RETENTION_ENV_VARS.receiptRetentionDays]: "1",
    } as NodeJS.ProcessEnv;

    expect(resolveRetentionSettings(env)).toEqual({
      stateBackupMaxAgeDays: 1,
      stateBackupMaxFiles: 1,
      stateBackupMaxBytes: MIN_STATE_BACKUP_MAX_BYTES,
      auditLogMaxAgeDays: 1,
      receiptRetentionDays: 1,
    });
  });
});

describe("applyRetentionPolicies — state backups", () => {
  it("removes backups strictly older than the age limit and keeps one exactly at it", () => {
    const now = new Date();
    const older = writeBackup("state-older.backup", new Date(now.getTime() - 31 * DAY_MS));
    const atLimit = writeBackup("state-at-limit.backup", new Date(now.getTime() - 30 * DAY_MS));
    const recent = writeBackup("state-recent.backup", now);
    const olderSize = statSync(older).size;

    const report = applyRetentionPolicies(
      { [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "30" },
      now,
    );

    expect(existsSync(older)).toBe(false);
    expect(existsSync(atLimit)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(report.backups).toEqual({ scanned: 3, removed: 1, bytesFreed: olderSize });
    expect(report.errors).toEqual([]);
  });

  it("keeps the newest N and removes only the oldest beyond the count limit", () => {
    const now = new Date();
    const oldest = writeBackup("state-a.backup", new Date(now.getTime() - 3 * DAY_MS));
    const middle = writeBackup("state-b.backup", new Date(now.getTime() - 2 * DAY_MS));
    const newest = writeBackup("state-c.backup", new Date(now.getTime() - DAY_MS));

    const report = applyRetentionPolicies({ [RETENTION_ENV_VARS.stateBackupMaxFiles]: "2" }, now);

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(report.backups.removed).toBe(1);
  });

  it("removes nothing when the count is exactly at the limit", () => {
    const now = new Date();
    const first = writeBackup("state-a.backup", new Date(now.getTime() - 2 * DAY_MS));
    const second = writeBackup("state-b.backup", new Date(now.getTime() - DAY_MS));

    const report = applyRetentionPolicies({ [RETENTION_ENV_VARS.stateBackupMaxFiles]: "2" }, now);

    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(report.backups).toEqual({ scanned: 2, removed: 0, bytesFreed: 0 });
  });

  it("breaks count ties by name so the same file is chosen every run", () => {
    const now = new Date();
    const shared = new Date(now.getTime() - DAY_MS);
    const first = writeBackup("state-a.backup", shared);
    const second = writeBackup("state-b.backup", shared);

    applyRetentionPolicies({ [RETENTION_ENV_VARS.stateBackupMaxFiles]: "1" }, now);

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  });

  it("prunes the oldest backups until the directory fits the size cap", () => {
    const now = new Date();
    const content = "x".repeat(8000);
    const oldest = writeBackup("state-a.backup", new Date(now.getTime() - 3 * DAY_MS), content);
    const middle = writeBackup("state-b.backup", new Date(now.getTime() - 2 * DAY_MS), content);
    const newest = writeBackup("state-c.backup", new Date(now.getTime() - DAY_MS), content);

    // 24000 bytes total against a 10240-byte cap: the two oldest must go.
    const report = applyRetentionPolicies(
      { [RETENTION_ENV_VARS.stateBackupMaxBytes]: String(MIN_STATE_BACKUP_MAX_BYTES) },
      now,
    );

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(report.backups.bytesFreed).toBe(16000);
    const total = statSync(newest).size;
    expect(total).toBeLessThanOrEqual(MIN_STATE_BACKUP_MAX_BYTES);
  });

  it("removes nothing when the directory is exactly at the size cap", () => {
    const now = new Date();
    const content = "y".repeat(MIN_STATE_BACKUP_MAX_BYTES / 2);
    const first = writeBackup("state-a.backup", new Date(now.getTime() - 2 * DAY_MS), content);
    const second = writeBackup("state-b.backup", new Date(now.getTime() - DAY_MS), content);

    const report = applyRetentionPolicies(
      { [RETENTION_ENV_VARS.stateBackupMaxBytes]: String(MIN_STATE_BACKUP_MAX_BYTES) },
      now,
    );

    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(report.backups.removed).toBe(0);
  });

  it("never deletes the active state file or its quarantine/legacy siblings", () => {
    const now = new Date();
    const ancient = new Date(now.getTime() - 1000 * DAY_MS);
    const stateFile = join(backupDir, "state.json");
    const corrupt = join(backupDir, "state.json.corrupt-1699000000000");
    const legacy = join(backupDir, "state.json.legacy");
    for (const path of [stateFile, corrupt, legacy]) {
      writeFileSync(path, "{}");
      utimesSync(path, ancient, ancient);
    }
    const expiredBackup = writeBackup("state-expired.backup", ancient);
    const expiredSize = statSync(expiredBackup).size;

    const report = applyRetentionPolicies({ [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "1" }, now);

    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(corrupt)).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(expiredBackup)).toBe(false);
    expect(report.backups).toEqual({ scanned: 1, removed: 1, bytesFreed: expiredSize });
  });
});

describe("applyRetentionPolicies — audit log", () => {
  it("prunes rotated generations past the age limit but never the live file", () => {
    const now = new Date();
    const dir = join(testDir, "audit");
    mkdirSync(dir, { recursive: true });
    const live = join(dir, "audit.jsonl");
    const expired = `${live}.1`;
    const atLimit = `${live}.2`;
    const recent = `${live}.3`;
    writeFileSync(live, "live\n");
    writeFileSync(expired, "old\n");
    writeFileSync(atLimit, "at-limit\n");
    writeFileSync(recent, "recent\n");
    // The live file is itself far past the limit: age must not matter for it.
    utimesSync(live, new Date(now.getTime() - 90 * DAY_MS), new Date(now.getTime() - 90 * DAY_MS));
    utimesSync(
      expired,
      new Date(now.getTime() - 15 * DAY_MS),
      new Date(now.getTime() - 15 * DAY_MS),
    );
    utimesSync(
      atLimit,
      new Date(now.getTime() - 14 * DAY_MS),
      new Date(now.getTime() - 14 * DAY_MS),
    );
    utimesSync(recent, new Date(now.getTime() - 2 * DAY_MS), new Date(now.getTime() - 2 * DAY_MS));

    const report = applyRetentionPolicies(
      {
        MINDVAULT_AUDIT_LOG_FILE: live,
        [RETENTION_ENV_VARS.auditLogMaxAgeDays]: "14",
      } as NodeJS.ProcessEnv,
      now,
    );

    expect(existsSync(live)).toBe(true);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(atLimit)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(report.audit).toEqual({ scanned: 3, removed: 1 });
    expect(report.errors).toEqual([]);
  });

  it("does nothing when no audit file sink is configured", () => {
    const report = applyRetentionPolicies({}, new Date());
    expect(report.audit).toEqual({ scanned: 0, removed: 0 });
  });
});

describe("applyRetentionPolicies — receipts", () => {
  it("prunes only receipts older than the limit and keeps the file parseable", () => {
    const now = new Date();
    recordPurchase({
      resourceId: "resource.expired",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: null,
      timestamp: new Date(now.getTime() - 91 * DAY_MS).toISOString(),
    });
    recordPurchase({
      resourceId: "resource.at-limit",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: null,
      timestamp: new Date(now.getTime() - 90 * DAY_MS).toISOString(),
    });
    recordPurchase({
      resourceId: "resource.fresh",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: null,
      timestamp: now.toISOString(),
    });

    const report = applyRetentionPolicies({ [RETENTION_ENV_VARS.receiptRetentionDays]: "90" }, now);

    expect(report.receipts).toEqual({ scanned: 3, removed: 1 });
    const store = loadPurchaseHistory();
    expect(store.purchases.map((receipt) => receipt.resourceId).sort()).toEqual([
      "resource.at-limit",
      "resource.fresh",
    ]);
    expect(() => JSON.parse(readFileSync(purchasesPath, "utf-8"))).not.toThrow();
  });

  it("writes nothing when no receipt is old enough", () => {
    const now = new Date();
    recordPurchase({
      resourceId: "resource.fresh",
      amount: "1.00",
      network: "stellar:testnet",
      txHash: null,
      receiptRef: null,
      timestamp: now.toISOString(),
    });
    const before = readFileSync(purchasesPath, "utf-8");

    const report = applyRetentionPolicies({ [RETENTION_ENV_VARS.receiptRetentionDays]: "90" }, now);

    expect(report.receipts).toEqual({ scanned: 1, removed: 0 });
    expect(readFileSync(purchasesPath, "utf-8")).toBe(before);
  });
});

describe("applyRetentionPolicies — general", () => {
  it("returns an empty report when there is nothing to clean", () => {
    const report = applyRetentionPolicies({}, new Date("2026-01-01T00:00:00.000Z"));

    expect(report).toEqual({
      backups: { scanned: 0, removed: 0, bytesFreed: 0 },
      audit: { scanned: 0, removed: 0 },
      receipts: { scanned: 0, removed: 0 },
      errors: [],
    });
  });

  it("captures an unreadable path as an error instead of throwing", () => {
    const notADirectory = join(testDir, "not-a-directory");
    writeFileSync(notADirectory, "x");
    _setBackupDirForTests(notADirectory);

    let report: RetentionReport | undefined;
    expect(() => {
      report = applyRetentionPolicies({}, new Date());
    }).not.toThrow();
    expect(report?.errors.length).toBeGreaterThan(0);
    expect(report?.backups).toEqual({ scanned: 0, removed: 0, bytesFreed: 0 });
  });

  it("produces an identical report for identical inputs", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const env = { [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "10" } as NodeJS.ProcessEnv;

    const first = applyRetentionPolicies(env, now);
    const second = applyRetentionPolicies(env, now);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("startup validation of retention settings", () => {
  it("stays a no-op when every variable is unset", () => {
    const diagnostics = collectStartupDiagnostics({ STELLAR_NETWORK: "testnet" }, true);

    expect(retentionDiagnostics(diagnostics)).toEqual([]);
  });

  it("reports a blocking error with `expected` for non-numeric and below-minimum values", () => {
    const diagnostics = collectStartupDiagnostics(
      {
        STELLAR_NETWORK: "testnet",
        [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "abc",
        [RETENTION_ENV_VARS.stateBackupMaxBytes]: "12",
        [RETENTION_ENV_VARS.receiptRetentionDays]: "0",
      },
      true,
    );

    const retention = retentionDiagnostics(diagnostics);
    expect(retention.map((item) => item.variable).sort()).toEqual([
      RETENTION_ENV_VARS.receiptRetentionDays,
      RETENTION_ENV_VARS.stateBackupMaxAgeDays,
      RETENTION_ENV_VARS.stateBackupMaxBytes,
    ]);
    for (const item of retention) {
      expect(item.severity).toBe("error");
      expect(item.expected).toContain("a positive integer");
      expect(item.message).toContain("Not a valid retention limit");
    }
    expect(
      retention.find((item) => item.variable === RETENTION_ENV_VARS.stateBackupMaxBytes)?.expected,
    ).toBe("a positive integer (minimum 10240 bytes)");
  });

  it("accepts values exactly at their minimums", () => {
    const diagnostics = collectStartupDiagnostics(
      {
        STELLAR_NETWORK: "testnet",
        [RETENTION_ENV_VARS.stateBackupMaxAgeDays]: "1",
        [RETENTION_ENV_VARS.stateBackupMaxFiles]: "1",
        [RETENTION_ENV_VARS.stateBackupMaxBytes]: String(MIN_STATE_BACKUP_MAX_BYTES),
        [RETENTION_ENV_VARS.auditLogMaxAgeDays]: "1",
        [RETENTION_ENV_VARS.receiptRetentionDays]: "1",
      },
      true,
    );

    expect(retentionDiagnostics(diagnostics)).toEqual([]);
  });
});
