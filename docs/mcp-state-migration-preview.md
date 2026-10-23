# State Migration Preview (`mindvault_migration_preview`)

`mindvault_migration_preview` shows what loading a saved wallet-profile state
file would change, before it changes anything. Loading a legacy `state.json`
folds the old single-wallet format into the multi-profile format and
re-persists it; this tool runs the same migration the apply path uses, diffs
the stored value against the migrated result, and reports the difference as
sorted field paths. It is strictly read-only: it never writes, moves, or
quarantines anything, and never creates the `.legacy` snapshot it reports on.

Source: [`mcp/src/stateMigrationPreview.ts`](../mcp/src/stateMigrationPreview.ts).

## Arguments

None. The tool reads the persisted state file (`~/.mindvault/state.json`)
and takes no input.

## What the preview shows

- `fromVersion` — the stored `version` field, or `"legacy"` for pre-version
  state — and the `migrationVersion` the apply path would target.
- `migrationRequired` — true when loading the stored state would re-persist
  it. Already-current state produces an empty `changedFields` by
  construction, because the load path only rewrites migrated state.
- `changedFields` — the field-level diff as dot-delimited paths, sorted
  deterministically. A subtree present on only one side is walked down to its
  leaves, so the legacy top-level `wallet` appears both as
  `wallet.secretKey` and as `profiles.default.wallet.secretKey` rather than
  one opaque object change.
- `backup` — whether applying the migration will snapshot the pre-migration
  state to `<state file>.legacy` (mode `0600`) before the rewritten state is
  written.
- `restoreOnFailure` — whether a failed apply restores the prior state; the
  apply path keeps the prior file bytes, restores them, and rethrows if the
  migrated write fails. The preserved `.legacy` snapshot remains a manual
  rollback source either way.

## Redaction

Every `before`/`after` value passes through the same redaction the rest of
the server applies, keyed by the field's own name: `secretKey` and `apiKey`
material is replaced by `[REDACTED]` by name, not only by value pattern, and
changed objects or arrays are summarised as `<object>`/`<array>` presence
markers. A missing key is reported as `<absent>`. The serialized preview
never contains key material.

## The envelope

```json
{
  "schema": "mindvault.migration-preview/v1",
  "migrationVersion": "1",
  "fromVersion": "legacy",
  "migrationRequired": true,
  "changedFields": [
    { "path": "activeProfile", "before": "<absent>", "after": "default" },
    { "path": "apiKey", "before": "[REDACTED]", "after": "[REDACTED]" },
    { "path": "profiles.default.apiKey", "before": "<absent>", "after": "[REDACTED]" },
    { "path": "profiles.default.wallet.publicKey", "before": "<absent>", "after": "G…" },
    { "path": "profiles.default.wallet.secretKey", "before": "<absent>", "after": "[REDACTED]" },
    { "path": "version", "before": "<absent>", "after": "1" },
    { "path": "wallet.publicKey", "before": "G…", "after": "<absent>" },
    { "path": "wallet.secretKey", "before": "[REDACTED]", "after": "<absent>" }
  ],
  "backup": {
    "created": true,
    "path": "/home/agent/.mindvault/state.json.legacy",
    "note": "Applying the migration preserves the pre-migration state to … (mode 0600) before the migrated state is written."
  },
  "restoreOnFailure": {
    "supported": true,
    "how": "The apply path keeps the prior state file bytes and restores them, then rethrows, if writing the migrated state fails; the preserved state.json.legacy snapshot (when created) remains as a manual rollback source."
  },
  "summary": "Migration required: stored state will move from version \"legacy\" to version \"1\"; 8 field(s) will change."
}
```

A missing or unparseable state file yields a graceful preview over empty
state (`migrationRequired: false`) with a note appended to the summary
rather than an error.

## Tests

`mcp/src/stateMigrationPreview.test.ts` previews a legacy single-wallet
state and asserts the moved field paths, the redacted values, and the backup
and restore contract; verifies determinism across repeated calls; asserts
the serialized output contains no secret-key or API-key material for both
legacy and current states; exercises `applyMigratedState` write/restore
semantics; and calls the tool against a temporary home directory to confirm
it reads but never modifies the state file and never creates a `.legacy`
snapshot.
