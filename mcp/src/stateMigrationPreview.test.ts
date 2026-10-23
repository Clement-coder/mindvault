/**
 * Tests for the state migration preview (#1046).
 *
 * The preview exists so an upgrade never rewrites `state.json` unseen, so the
 * tests pin the three promises it makes: the diff names the migration version
 * and every moved field path, the serialized document never contains a wallet
 * secret or API key, and the apply helper restores the exact prior bytes when
 * a write fails (without letting a restore failure mask the original error).
 * Tool-level coverage drives `migrationPreviewTool` against a temp HOME and
 * byte-compares the state file before and after to prove it is read-only.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkOutput } from "./outputValidation.js";
import { STATE_VERSION } from "./profiles.js";
import {
  applyMigratedState,
  migrationPreviewTool,
  MIGRATION_PREVIEW_OUTPUT_SCHEMA,
  MIGRATION_PREVIEW_SCHEMA,
  previewStateMigration,
} from "./stateMigrationPreview.js";

// Distinctive throwaway strings — never funded, never a real credential.
const SECRET = "SPREVIEWFAKESECRETKEYMUSTNEVERAPPEARXXXXXXXXXXXXXXXXXXXXX";
const PUBLIC = "GPREVIEWFAKEPUBLICADDRESSFORPREVIEWTESTINGXXXXXXXXXXXXXXX";
const API_KEY = "mv_preview_fake_api_key_9876543210";

const STATE_FILE = join("test-home", ".mindvault", "state.json");

const legacyState = {
  wallet: { publicKey: PUBLIC, secretKey: SECRET },
  apiKey: API_KEY,
};

const currentState = {
  version: STATE_VERSION,
  activeProfile: "publisher",
  profiles: {
    publisher: { wallet: { publicKey: PUBLIC, secretKey: SECRET }, apiKey: API_KEY },
    buyer: { wallet: { publicKey: "GBUYER", secretKey: "SBUYER" } },
  },
};

describe("previewStateMigration on legacy single-wallet state", () => {
  const preview = previewStateMigration(legacyState, { stateFile: STATE_FILE });

  it("names the migration version and requires the migration", () => {
    expect(preview.schema).toBe(MIGRATION_PREVIEW_SCHEMA);
    expect(preview.migrationRequired).toBe(true);
    expect(preview.migrationVersion).toBe(String(STATE_VERSION));
    expect(preview.fromVersion).toBe("legacy");
  });

  it("lists every moved field path in deterministic order", () => {
    expect(preview.changedFields.map((change) => change.path)).toEqual([
      "activeProfile",
      "apiKey",
      "profiles.default.apiKey",
      "profiles.default.wallet.publicKey",
      "profiles.default.wallet.secretKey",
      "version",
      "wallet.publicKey",
      "wallet.secretKey",
    ]);
    expect(preview.changedFields).toContainEqual({
      path: "version",
      before: "<absent>",
      after: String(STATE_VERSION),
    });
  });

  it("reports the backup snapshot and restore-on-failure behavior", () => {
    expect(preview.backup).toEqual({
      created: true,
      path: `${STATE_FILE}.legacy`,
      note: expect.stringContaining(`${STATE_FILE}.legacy`),
    });
    expect(preview.restoreOnFailure.supported).toBe(true);
    expect(preview.restoreOnFailure.how).toContain("restores them");
  });

  it("summarises the migration", () => {
    expect(preview.summary).toContain("Migration required");
    expect(preview.summary).toContain("legacy");
    expect(preview.summary).toContain(String(STATE_VERSION));
  });
});

describe("previewStateMigration on current multi-profile state", () => {
  it("requires no migration and reports an empty diff", () => {
    const preview = previewStateMigration(currentState, { stateFile: STATE_FILE });
    expect(preview.migrationRequired).toBe(false);
    expect(preview.changedFields).toEqual([]);
    expect(preview.fromVersion).toBe(String(STATE_VERSION));
    expect(preview.migrationVersion).toBe(String(STATE_VERSION));
    expect(preview.backup.created).toBe(false);
    expect(preview.summary).toContain("No migration required");
  });

  it("is deterministic: two previews deep-equal", () => {
    const a = previewStateMigration(currentState, { stateFile: STATE_FILE });
    const b = previewStateMigration(currentState, { stateFile: STATE_FILE });
    expect(a).toEqual(b);
  });

  it("returns an empty diff for legacy input too when run twice", () => {
    const a = previewStateMigration(legacyState, { stateFile: STATE_FILE });
    const b = previewStateMigration(legacyState, { stateFile: STATE_FILE });
    expect(a).toEqual(b);
  });
});

describe("previewStateMigration redaction", () => {
  it("never includes the wallet secret or API key in the serialized preview", () => {
    const preview = previewStateMigration(legacyState, { stateFile: STATE_FILE });
    const text = JSON.stringify(preview);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(API_KEY);
    // The secret-bearing leaves are still named — just redacted.
    const secretChange = preview.changedFields.find(
      (change) => change.path === "profiles.default.wallet.secretKey",
    );
    expect(secretChange).toEqual({
      path: "profiles.default.wallet.secretKey",
      before: "<absent>",
      after: "[REDACTED]",
    });
  });

  it("never includes secrets from current-format state either", () => {
    const text = JSON.stringify(previewStateMigration(currentState, { stateFile: STATE_FILE }));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(API_KEY);
  });
});

describe("applyMigratedState", () => {
  const priorJson = JSON.stringify(legacyState);

  it("does not call restore when the write succeeds", () => {
    let restored: string | null = null;
    applyMigratedState({
      priorJson,
      write: () => undefined,
      restore: (json) => {
        restored = json;
      },
    });
    expect(restored).toBeNull();
  });

  it("restores the exact prior JSON and rethrows the original error on write failure", () => {
    const writeError = new Error("disk full");
    let restored: string | null = null;
    let caught: unknown = null;
    try {
      applyMigratedState({
        priorJson,
        write: () => {
          throw writeError;
        },
        restore: (json) => {
          restored = json;
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(restored).toBe(priorJson);
    expect(caught).toBe(writeError);
  });

  it("does not let a restore failure mask the original write error", () => {
    const writeError = new Error("disk full");
    let restoreCalls = 0;
    let caught: unknown = null;
    try {
      applyMigratedState({
        priorJson,
        write: () => {
          throw writeError;
        },
        restore: () => {
          restoreCalls += 1;
          throw new Error("restore also failed");
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(restoreCalls).toBe(1);
    expect(caught).toBe(writeError);
  });
});

describe("migrationPreviewTool", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mv-migration-preview-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  function writeStateFile(contents: string): string {
    mkdirSync(join(home, ".mindvault"), { recursive: true });
    const file = join(home, ".mindvault", "state.json");
    writeFileSync(file, contents, { mode: 0o600 });
    return file;
  }

  it("reads the persisted state file and previews the migration without modifying it", () => {
    const file = writeStateFile(JSON.stringify(legacyState, null, 2));
    const before = readFileSync(file, "utf-8");

    const result = migrationPreviewTool();
    const preview = JSON.parse(result) as { [key: string]: unknown };

    expect(preview.migrationRequired).toBe(true);
    expect(preview.migrationVersion).toBe(String(STATE_VERSION));
    expect(preview.fromVersion).toBe("legacy");
    expect(preview.backup).toMatchObject({ created: true, path: `${file}.legacy` });

    // Read-only: no snapshot was created and the state file is byte-identical.
    expect(existsSync(`${file}.legacy`)).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(result).not.toContain(SECRET);
    expect(result).not.toContain(API_KEY);
  });

  it("returns a graceful preview over empty state when the file is missing", () => {
    const preview = JSON.parse(migrationPreviewTool()) as { [key: string]: unknown };
    expect(preview.migrationRequired).toBe(false);
    expect(preview.changedFields).toEqual([]);
    expect(preview.backup.created).toBe(false);
    expect(String(preview.summary)).toContain("No state file");
    expect(existsSync(join(home, ".mindvault"))).toBe(false);
  });

  it("returns a graceful preview when the state file is not valid JSON", () => {
    const file = writeStateFile("{ not json");
    const before = readFileSync(file, "utf-8");
    const preview = JSON.parse(migrationPreviewTool()) as { [key: string]: unknown };
    expect(preview.migrationRequired).toBe(false);
    expect(preview.changedFields).toEqual([]);
    expect(String(preview.summary)).toContain("not valid JSON");
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("matches the advertised output schema for both legacy and empty state", () => {
    writeStateFile(JSON.stringify(legacyState, null, 2));
    const fromFile: unknown = JSON.parse(migrationPreviewTool());
    rmSync(join(home, ".mindvault", "state.json"), { force: true });
    const empty: unknown = JSON.parse(migrationPreviewTool());
    const schema = MIGRATION_PREVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
    expect(checkOutput(schema, fromFile)).toEqual({ valid: true });
    expect(checkOutput(schema, empty)).toEqual({ valid: true });
  });
});

describe("MIGRATION_PREVIEW_OUTPUT_SCHEMA", () => {
  it("covers every required key on a produced preview", () => {
    const preview = previewStateMigration(legacyState, { stateFile: STATE_FILE });
    for (const key of MIGRATION_PREVIEW_OUTPUT_SCHEMA.required) {
      expect(preview, `preview has ${key}`).toHaveProperty(key);
    }
  });
});
