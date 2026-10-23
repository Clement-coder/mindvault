/**
 * State migration preview for saved wallet profiles (#1046).
 *
 * Loading a legacy `state.json` folds the old single-wallet format into the
 * multi-profile format and re-persists it. The rewrite is already safe — the
 * apply path preserves the pre-migration bytes to `state.json.legacy` — but
 * before an upgrade an operator wants to see the rewrite rather than trust it:
 * which stored fields move where, whether a backup snapshot will be created,
 * and what restores the prior state if applying fails.
 *
 * `mindvault_migration_preview` answers exactly those questions, read-only.
 * It runs the same `migrateState` the apply path uses, diffs the stored value
 * against the migrated result as a deterministic depth-first walk, and
 * reports the difference as sorted field paths. Every leaf value passes
 * through `redactObject` keyed by its field name, so `secretKey` and `apiKey`
 * material is replaced by `[REDACTED]` by name (not only by value pattern),
 * and objects/arrays are summarised as presence/type markers. A preview that
 * leaked a Stellar secret would defeat its own purpose, so the serialized
 * document never contains one.
 *
 * The builder is pure (`previewStateMigration` takes the state to inspect as
 * input), so the diff and redaction rules are unit-testable without a file
 * system; `migrationPreviewTool` is the thin entry point that reads the state
 * file and never writes. `applyMigratedState` is the apply-path counterpart:
 * given the prior file bytes and write/restore callbacks it runs the write
 * and, if that fails, restores the prior state before rethrowing, so the
 * lead can wire the load path in `index.ts` to it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { migrateState, STATE_VERSION } from "./profiles.js";
import { redactObject } from "./redaction.js";

/** Discriminator for the preview document; versioned for future formats. */
export const MIGRATION_PREVIEW_SCHEMA = "mindvault.migration-preview/v1";

/** Marker used in `changedFields` when a key is missing on one side. */
const ABSENT = "<absent>";
/** Marker used instead of the contents of a changed object or array. */
const OBJECT_MARKER = "<object>";
const ARRAY_MARKER = "<array>";

/**
 * One changed field: a dot-delimited path and redacted before/after values.
 * `before`/`after` are always strings — either the redacted scalar or one of
 * the presence/type markers above — so a diff entry can never carry key
 * material even if a later format adds exotic value types.
 */
export interface MigrationPreviewFieldChange {
  path: string;
  before: string;
  after: string;
}

/** The full read-only preview document returned by the tool. */
export interface MigrationPreview {
  schema: typeof MIGRATION_PREVIEW_SCHEMA;
  /** Target state schema version (`STATE_VERSION`), as a string. */
  migrationVersion: string;
  /** The stored `version` field, or `"legacy"` for pre-version state. */
  fromVersion: string;
  /** True when loading the stored state would re-persist it. */
  migrationRequired: boolean;
  /** Deterministically sorted field-level diff; empty when nothing changes. */
  changedFields: MigrationPreviewFieldChange[];
  /** Whether applying the migration snapshots the pre-migration state. */
  backup: { created: boolean; path: string; note: string };
  /** Whether the apply path can restore the prior state on a failed write. */
  restoreOnFailure: { supported: boolean; how: string };
  summary: string;
}

export interface MigrationPreviewOptions {
  /**
   * The state file whose `.legacy` snapshot path the preview should report.
   * Defaults to `~/.mindvault/state.json`, resolved at call time.
   */
  stateFile?: string;
}

/**
 * The persisted state file this preview reads.
 *
 * `stateBackup.ts` keeps its `STATE_FILE` constant private, so the path is
 * derived the same way here. Resolved at call time (not module load) so tests
 * can point `HOME`/`USERPROFILE` at a temp directory before invoking the tool.
 */
function defaultStateFile(): string {
  return join(homedir(), ".mindvault", "state.json");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural equality for JSON-shaped values; order-insensitive on keys. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return deepEqual(aKeys, bKeys) && aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Render one side of a changed field as a redacted string.
 *
 * Absent keys become a presence marker and objects/arrays become type markers
 * — a preview only needs to know the shape moved, never its contents. Scalars
 * pass through `redactObject` wrapped in an object keyed by the field's own
 * last path segment, so both layers apply: name-based redaction replaces a
 * `secretKey` or `apiKey` value with `[REDACTED]` regardless of length, and
 * the value-pattern pass catches anything that still looks like a secret.
 */
function describeSide(path: string, value: unknown): string {
  if (value === undefined) return ABSENT;
  if (Array.isArray(value)) return ARRAY_MARKER;
  if (value !== null && typeof value === "object") return OBJECT_MARKER;
  const key = path.slice(path.lastIndexOf(".") + 1);
  const wrapped = redactObject({ [key]: value });
  const safe = wrapped[key];
  if (safe === null) return "null";
  return String(safe);
}

function fieldChange(path: string, before: unknown, after: unknown): MigrationPreviewFieldChange {
  return {
    path: path === "" ? "(root)" : path,
    before: describeSide(path, before),
    after: describeSide(path, after),
  };
}

/**
 * Depth-first diff of `before` vs `after`, emitting one entry per changed
 * leaf. Matching subtrees are skipped whole; a subtree present on only one
 * side is walked down to its leaves, so the legacy top-level `wallet` shows
 * up as both `wallet.secretKey` and `profiles.default.wallet.secretKey`
 * rather than one opaque object diff. Added/removed leaves and type changes
 * emit a single entry with presence/type markers. Paths are collected in
 * sorted key order and the result is sorted again by path, so the output is
 * byte-for-byte deterministic for a given input.
 */
function collectDiff(
  path: string,
  before: unknown,
  after: unknown,
  out: MigrationPreviewFieldChange[],
): void {
  if (deepEqual(before, after)) return;

  const beforeRecord = isPlainRecord(before);
  const afterRecord = isPlainRecord(after);

  if (beforeRecord && afterRecord) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      collectDiff(path === "" ? key : `${path}.${key}`, before[key], after[key], out);
    }
    return;
  }

  if (beforeRecord && after === undefined) {
    const keys = Object.keys(before).sort();
    if (keys.length > 0) {
      for (const key of keys) {
        collectDiff(path === "" ? key : `${path}.${key}`, before[key], undefined, out);
      }
      return;
    }
  }

  if (afterRecord && before === undefined) {
    const keys = Object.keys(after).sort();
    if (keys.length > 0) {
      for (const key of keys) {
        collectDiff(path === "" ? key : `${path}.${key}`, undefined, after[key], out);
      }
      return;
    }
  }

  out.push(fieldChange(path, before, after));
}

/** Sorted, redacted field-level diff between the stored and migrated state. */
function diffFields(before: unknown, after: unknown): MigrationPreviewFieldChange[] {
  const out: MigrationPreviewFieldChange[] = [];
  collectDiff("", before, after, out);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The stored `version` field as a string, or `"legacy"` when absent/unusable. */
function readFromVersion(rawState: unknown): string {
  if (!isPlainRecord(rawState)) return "legacy";
  const { version } = rawState;
  if (typeof version === "number" && Number.isFinite(version)) return String(version);
  if (typeof version === "string" && version.length > 0) return version;
  return "legacy";
}

const RESTORE_HOW =
  "The apply path keeps the prior state file bytes and restores them, then rethrows, " +
  "if writing the migrated state fails; the preserved state.json.legacy snapshot " +
  "(when created) remains as a manual rollback source.";

/**
 * Build the read-only migration preview for a stored state value.
 *
 * Runs `migrateState` on `rawState` — the same function the load path uses —
 * and reports what applying that migration would do. When no migration is
 * required, `changedFields` is empty by construction: the load path only
 * re-persists migrated state, so a non-migrating state is never rewritten and
 * the diff exists only to explain a real migration. Pure and deterministic:
 * the same input yields deep-equal previews.
 */
export function previewStateMigration(
  rawState: unknown,
  options: MigrationPreviewOptions = {},
): MigrationPreview {
  const stateFile = options.stateFile ?? defaultStateFile();
  const legacyPath = `${stateFile}.legacy`;
  const { state, migrated } = migrateState(rawState);

  const migrationVersion = String(STATE_VERSION);
  const fromVersion = readFromVersion(rawState);
  const migrationRequired = migrated;
  const changedFields = migrated ? diffFields(rawState, state) : [];

  const backup = migrationRequired
    ? {
        created: true,
        path: legacyPath,
        note:
          `Applying the migration preserves the pre-migration state to ${legacyPath} ` +
          "(mode 0600) before the migrated state is written.",
      }
    : {
        created: false,
        path: legacyPath,
        note: "No migration is required, so no pre-migration snapshot will be created.",
      };

  const summary = migrationRequired
    ? `Migration required: stored state will move from version "${fromVersion}" to version ` +
      `"${migrationVersion}"; ${changedFields.length} field(s) will change.`
    : `No migration required: stored state is already at version "${migrationVersion}"; ` +
      "no fields will change.";

  return {
    schema: MIGRATION_PREVIEW_SCHEMA,
    migrationVersion,
    fromVersion,
    migrationRequired,
    changedFields,
    backup,
    restoreOnFailure: { supported: true, how: RESTORE_HOW },
    summary,
  };
}

/**
 * Apply a migration write with restore-on-failure.
 *
 * Runs `write()`. If it throws, runs `restore(priorJson)` with the exact
 * prior state bytes and then rethrows the original write error. A failure
 * inside `restore` is swallowed so it can never mask the write error the
 * caller needs to see; the preserved `state.json.legacy` snapshot remains the
 * manual rollback source in that case. Used by the state load path so a
 * failed rewrite leaves the previous state file intact.
 */
export function applyMigratedState(input: {
  /** The exact bytes read from the state file before the migration write. */
  priorJson: string;
  /** Persists the migrated state; may throw. */
  write: () => void;
  /** Restores the prior state from the saved bytes; may throw. */
  restore: (priorJson: string) => void;
}): void {
  try {
    input.write();
  } catch (writeError) {
    try {
      input.restore(input.priorJson);
    } catch {
      // Deliberately ignored: masking the write error would hide the real
      // failure, and the preserved legacy snapshot is the fallback rollback.
    }
    throw writeError;
  }
}

/**
 * Tool entry point: read the persisted state file and return the preview as
 * formatted JSON. Takes no arguments and is strictly read-only — it never
 * writes, moves, or quarantines anything, and never creates the `.legacy`
 * snapshot it reports on. A missing or unparseable state file yields a
 * graceful preview over empty state (`migrationRequired: false`) with a note
 * appended to the summary.
 */
export function migrationPreviewTool(args?: Record<string, unknown>): string {
  void args; // Zero-input tool; the signature exists for the dispatcher.
  const stateFile = defaultStateFile();
  let rawState: unknown = {};
  let note: string | null = null;

  if (!existsSync(stateFile)) {
    note = `No state file found at ${stateFile}; previewing an empty state.`;
  } else {
    try {
      rawState = JSON.parse(readFileSync(stateFile, "utf-8"));
    } catch {
      note = `State file at ${stateFile} is unreadable or not valid JSON; previewing an empty state.`;
    }
  }

  const preview = previewStateMigration(rawState, { stateFile });
  if (note !== null) preview.summary = `${preview.summary} ${note}`;
  return JSON.stringify(preview, null, 2);
}

/**
 * Raw success JSON Schema for the tool's `structuredContent`. Not wrapped
 * with `withToolErrorVariant` — the lead wraps it when wiring `tools.ts` and
 * `validation.ts`.
 */
export const MIGRATION_PREVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    schema: { type: "string", const: MIGRATION_PREVIEW_SCHEMA },
    migrationVersion: {
      type: "string",
      description: "The target state schema version (STATE_VERSION) the stored state migrates to.",
    },
    fromVersion: {
      type: "string",
      description: 'The stored version field, or "legacy" for pre-version state.',
    },
    migrationRequired: {
      type: "boolean",
      description: "True when loading the stored state would re-persist it in the current format.",
    },
    changedFields: {
      type: "array",
      description:
        "Deterministically sorted field-level diff between the stored state and the migrated " +
        "result. Values are redacted scalars or presence/type markers; secrets never appear.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Dot-delimited field path." },
          before: { type: "string" },
          after: { type: "string" },
        },
        required: ["path", "before", "after"],
      },
    },
    backup: {
      type: "object",
      description: "Whether applying the migration will snapshot the pre-migration state.",
      properties: {
        created: { type: "boolean" },
        path: { type: "string" },
        note: { type: "string" },
      },
      required: ["created", "path", "note"],
    },
    restoreOnFailure: {
      type: "object",
      description: "Whether the apply path can restore the prior state when the write fails.",
      properties: {
        supported: { type: "boolean" },
        how: { type: "string" },
      },
      required: ["supported", "how"],
    },
    summary: { type: "string" },
  },
  required: [
    "schema",
    "migrationVersion",
    "fromVersion",
    "migrationRequired",
    "changedFields",
    "backup",
    "restoreOnFailure",
    "summary",
  ],
} as const;
