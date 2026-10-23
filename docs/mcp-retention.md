# State & Audit Retention

State backups, rotated audit generations and purchase receipts all grow
without anyone tending them. Issue
[#1044](https://github.com/mind-vault-1/mindvault/issues/1044) exposes the
bounds as documented environment variables with safe defaults, so an
unconfigured server is already bounded: 50 MiB / 10 files / 30 days of state
backups, 14 days of rotated audit generations, and 90 days of receipts.

Source: [`mcp/src/retention.ts`](../mcp/src/retention.ts)

## Settings

| Variable                              | Default           | Min   | What it bounds                                                                                |
| ------------------------------------- | ----------------- | ----- | --------------------------------------------------------------------------------------------- |
| `MINDVAULT_STATE_BACKUP_MAX_AGE_DAYS` | 30 (days)         | 1     | Age limit for `~/.mindvault/backups/state-*.backup` files                                     |
| `MINDVAULT_STATE_BACKUP_MAX_FILES`    | 10 (files)        | 1     | Count limit; oldest backups beyond N are deleted                                              |
| `MINDVAULT_STATE_BACKUP_MAX_BYTES`    | 52428800 (50 MiB) | 10240 | Total-size cap for the backups directory; oldest deleted until under cap                      |
| `MINDVAULT_AUDIT_LOG_MAX_AGE_DAYS`    | 14 (days)         | 1     | Age limit for rotated audit generations (`audit.jsonl.1`, `.2`, …); never the live audit file |
| `MINDVAULT_RECEIPT_RETENTION_DAYS`    | 90 (days)         | 1     | Age limit for receipt records in the purchases store; older records are pruned                |

## Cleanup order and boundary semantics

One pass applies every policy, each target independently — a failure in one
is reported and never stops the others:

1. **State backups**, in a fixed order: age first, then count, then total
   bytes. Each step operates on the survivors of the previous one, oldest
   first, ties broken by name, so two runs over the same directory delete the
   same files.
2. **Rotated audit generations** by age only; byte/count rotation of the live
   file stays with
   [`mcp/src/auditLogRotation.ts`](../mcp/src/auditLogRotation.ts).
3. **Receipts** by the recorded purchase timestamp, rewriting the purchases
   store atomically (temp file + rename) so a crash mid-prune leaves either
   the old file or the new one, never a half-written document.

Boundaries:

- **Age** — a file or record _exactly at_ the age limit is **kept**;
  deletion is strictly for items older than the limit.
- **Count** — the newest N backups are kept. With N+1 present the oldest one
  is removed; with exactly N, nothing is removed.
- **Size** — the cap is inclusive: a directory exactly at
  `MINDVAULT_STATE_BACKUP_MAX_BYTES` is left alone; only a directory over the
  cap loses its oldest backups.

## What is never deleted

- **The active state file** — `~/.mindvault/state.json` is never a deletion
  candidate, however old it is.
- **Quarantine and legacy siblings** — `*.corrupt-*` and `*.legacy` files
  written by
  [`mcp/src/stateBackup.ts`](../mcp/src/stateBackup.ts) preserve evidence of
  a crash or migration and are never touched.
- **The live audit log** — only numeric rotated generations (`audit.jsonl.1`,
  `.2`, …) are eligible; the live file `audit.jsonl` itself is excluded by
  construction, even when it is older than the rotation limit.

## Failure handling

`applyRetentionPolicies` never throws. Unreadable directories, undeletable
files and a broken purchases store are collected into the report's `errors`
array (`{ backups, audit, receipts, errors }`), which is JSON-serializable
and stable for identical inputs — safe to log or diff.

Malformed settings behave the same at parse time: `resolveRetentionSettings`
falls back to the documented default rather than failing, so cleanup always
runs on valid numbers.

## Startup validation

Validation is separate and loud: `collectStartupDiagnostics` in
[`mcp/src/diagnostics.ts`](../mcp/src/diagnostics.ts) checks each retention
variable when it is set. A non-numeric or fractional value, or one below the
variable's minimum, produces a diagnostic with severity `error` naming the
variable and an `expected` field describing the valid range. Unset variables
are a no-op — existing startup behavior is unchanged, and a value exactly at
its minimum is accepted.

## Tests

- [`mcp/src/retention.test.ts`](../mcp/src/retention.test.ts) — defaults,
  environment overrides, below-minimum and garbage fallback, age/count/size
  boundaries (exactly-at-limit kept, oldest removed), protection of the active
  state and quarantine/legacy siblings, live-audit-file protection, receipt
  pruning with a still-parseable store, the empty no-op report, error capture
  without throwing, and determinism.
- [`mcp/src/diagnostics.test.ts`](../mcp/src/diagnostics.test.ts),
  [`mcp/src/config.test.ts`](../mcp/src/config.test.ts) and
  [`mcp/src/envReference.test.ts`](../mcp/src/envReference.test.ts) — startup
  validation stays a no-op when the variables are unset, and every variable is
  inventoried with defaults sourced from `retention.ts`.
