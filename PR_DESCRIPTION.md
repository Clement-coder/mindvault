# Harden state persistence against partial writes and leaked secret files

This PR fixes a real data-safety bug in the MindVault MCP state persistence path. The app writes credentials to `~/.mindvault/state.json`, but the old implementation used a direct `writeFileSync()` to the target path. If that write fails mid-flight, the destination can be left truncated, and the next load silently loses wallet and API state.

This change makes persisted state atomic, keeps secrets protected with `0600` permissions, and adds a regression test covering the failure case.

## What changed

### Safe atomic state writes

- Added a helper in `mcp/src/stateBackup.ts` that writes to a same-directory temp file, then renames it over the destination.
- Keeps the file mode at `0600` so wallet secrets and API keys remain owner-only.
- Cleans up the temp file if the rename fails so the live state file is never left partially written.

### Live persistence path updated

- Switched the production state-save logic in:
  - `mcp/src/index.ts`
  - `mcp/src/runtime.ts`
- Both now use the atomic write helper instead of writing directly to `state.json`.

### Regression coverage

- Added tests in `mcp/src/stateBackup.test.ts` covering:
  - temp-file write flow in the same directory
  - permission preservation at `0600`
  - failure case where rename fails and the destination remains intact
  - cleanup of stale temp artifacts

## Why this matters

The state file contains sensitive material:

- wallet secret keys
- publisher API keys

A partial write leaves the state file in a corrupt or truncated state. The previous behavior could silently discard valid credentials after a crash, I/O error, or interrupted write, which is especially risky for agent environments.

This fix is deterministic and safe for issue-driven contributor work: failure cases are isolated, the destination stays valid, and permissions remain tight.

## Verification

Ran the project-proven check:

```bash
cd /home/semi/Documents/Drip/mindvault && corepack pnpm --filter @mindvault/registry-client build && corepack pnpm --filter @mindvault/mcp exec vitest run src/stateBackup.test.ts
```

Result:

- 1 test file passed
- 20 tests passed
- exit code 0

## Files changed

- `mcp/src/stateBackup.ts`
- `mcp/src/index.ts`
- `mcp/src/runtime.ts`
- `mcp/src/stateBackup.test.ts`
- `PR_DESCRIPTION.md`
