# MCP Wallet Profiles

The MindVault MCP server supports **multiple named wallet profiles** so a single
agent can keep separate identities — for example `testnet` vs `mainnet`, or a
`publisher` identity vs a `buyer` identity. Each profile has its own Stellar
wallet and its own publisher API key. Exactly one profile is **active** at a
time, and every tool operates on the active profile.

Profiles are persisted to `~/.mindvault/state.json` (mode `0600`) and reloaded on
restart. Secret keys are never shown in tool output.

## Tools

| Tool                      | What it does                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mindvault_setup_wallet`  | Create a wallet. Optional `profile` arg creates/switches to that named profile before creating it.                                                                                        |
| `mindvault_use_profile`   | Switch the active profile (`name` required), creating it if it does not exist.                                                                                                            |
| `mindvault_list_profiles` | List all profiles, marking the active one and showing each wallet address and registration state.                                                                                         |
| `mindvault_wallet_info`   | Show the active profile name, wallet address, USDC balance, and whether it is registered.                                                                                                 |
| `mindvault_reset`         | Clear the active profile's credentials, or pass `all=true` to remove every profile and delete state. Requires `confirm=true` — see [Reset confirmation guard](#reset-confirmation-guard). |
| `mindvault_backup_state`  | Export an encrypted backup of `~/.mindvault/state.json` (passphrase min 8 chars). No plaintext secrets in the blob.                                                                       |
| `mindvault_restore_state` | Restore state from a `mindvault_backup_state` blob. Integrity-checked before any write.                                                                                                   |

## Moving environments (backup / restore)

When you need to move an agent between machines, export an encrypted backup on
the source and restore it on the destination. The blob is AES-256-GCM ciphertext
keyed from your passphrase (scrypt); wallet secret keys and API keys never appear
in plaintext. Wrong passphrase or a tampered blob fails the integrity check
before any state is written. Existing `mindvault_reset` behavior is unchanged.

```text
# Source environment
mindvault_backup_state { "passphrase": "your-long-passphrase" }
# → returns a v1:… blob (copy it offline)

# Destination environment
mindvault_restore_state {
  "blob": "v1:…",
  "passphrase": "your-long-passphrase"
}
# → State restored: N profile(s), active "…"
```

Unit coverage: [`mcp/src/stateBackup.test.ts`](../mcp/src/stateBackup.test.ts).

## Wallet integrity

A profile's wallet is only usable if the secret key it stores derives the address
it stores. That is checked at both boundaries where a keypair can enter:

- `mindvault_setup_wallet` verifies the sponsored-account service's response
  before persisting, so a half-completed creation cannot leave a funded address
  the keystore does not own (#839, see
  [mcp-error-reference.md](mcp-error-reference.md#half-completed-creation-839)).
- `mindvault_wallet_info` re-checks the stored keypair and adds a `⚠ Keystore:`
  line — and `ownsAddress: false` in its structured output — when they disagree,
  so a balance for an unsignable address never reads as spendable funds.

`mindvault_import_wallet` derives the address from the secret it is given, so an
imported wallet is consistent by construction.

## Reset confirmation guard

`mindvault_reset` deletes wallet secret keys and publisher API keys. They are
unrecoverable — the wallet secret exists only in `~/.mindvault/state.json` — so
an agent that misreads a prompt must not be able to wipe them in one call.

The tool is therefore two-step. Without a truthy `confirm`, it **changes
nothing** and returns a warning naming exactly what would be removed:

```text
mindvault_reset {}
# → Reset NOT performed — confirmation required.
#   This would permanently remove the active profile "publisher"
#   (wallet secret key + publisher API key).
#   Wallet secret keys cannot be recovered once deleted; back them up first
#   with mindvault_backup_state.
#   State file: ~/.mindvault/state.json
#
#   To proceed, call mindvault_reset again with confirm: true.
```

Passing `confirm: true` performs the reset:

```text
mindvault_reset { "confirm": true }
# → Profile "publisher" cleared (wallet and publisher API key removed).

mindvault_reset { "all": true, "confirm": true }
# → Reset complete. All profiles removed from memory and disk.
```

Notes:

- `confirm` accepts exactly `true`, `1`, `"true"`, `"1"`, and `"yes"`
  (case-insensitive, surrounding space ignored). Anything else — including
  omitting it — is "not confirmed".
- That list is **codified in the guard itself**, not inherited from another
  helper (#836). The server holds more than one notion of "truthy": mock mode
  also accepts `"on"`, and the argument validator coerces its own set of flag
  spellings. Reset is the one confirmation whose false positive cannot be undone,
  so widening it has to be a deliberate edit to `RESET_CONFIRM_STRINGS` in
  [`mcp/src/resetGuard.ts`](../mcp/src/resetGuard.ts) — a test pins the set, and
  relaxing any _other_ truthy vocabulary cannot widen this one by accident.
- The warning is deterministic and never echoes a secret key.
- The guard is independent of the mainnet guardrail: on mainnet a reset needs
  both `confirmMainnet` and `confirm`.
- Back up first with `mindvault_backup_state` if the credentials still matter.

Unit coverage: [`mcp/src/resetGuard.test.ts`](../mcp/src/resetGuard.test.ts) and
[`mcp/src/resetTool.test.ts`](../mcp/src/resetTool.test.ts).

## Example

```text
# Create a dedicated publisher wallet under a named profile
mindvault_setup_wallet { "profile": "publisher" }
mindvault_register     { "name": "Alice", "email": "alice@example.com" }

# Create a separate buyer identity and switch to it
mindvault_setup_wallet { "profile": "buyer" }

# See both identities (the active one is marked with *)
mindvault_list_profiles
#   publisher — GJPUBLISHER..., registered
# * buyer — GJBUYER...

# Switch back to the publisher to list something
mindvault_use_profile  { "name": "publisher" }
mindvault_publish      { "title": "My Dataset", "price": "5", "externalUrl": "https://example.com/data" }
```

## Profile names

Names are 1–64 characters from letters, digits, dot (`.`), dash (`-`), and
underscore (`_`). Invalid names are rejected with a deterministic,
agent-safe error message.

## State migration

Older installs stored a single wallet as `{ wallet, apiKey }` at the top level of
`state.json`. On first load, that state is automatically migrated into a profile
named `default` and re-persisted in the current format:

```json
{
  "version": 1,
  "activeProfile": "default",
  "profiles": {
    "default": { "wallet": { "publicKey": "…", "secretKey": "…" }, "apiKey": "…" }
  }
}
```

No action is required — existing wallets keep working as the `default` profile.
The migration is covered by unit tests in
[`mcp/src/profiles.test.ts`](../mcp/src/profiles.test.ts).

### Migrations can be rolled back

The migration does not destroy the original. Two safety nets cover it:

- Before re-persisting, the un-migrated legacy object is preserved to
  `state.json.legacy` (mode `0600`) next to the state file. If a later version
  of the migration goes wrong, the original `{ wallet, apiKey }` bytes are still
  there to restore from.
- `migrateState` returns the raw legacy input as part of its result (`legacy`),
  so the fold is always reproducible from the exact original and re-running the
  migration is a stable no-op on already-migrated state.

### Corrupted state files are quarantined, not overwritten

A `state.json` that cannot be read, is not valid JSON, or migrates to no
recognizable profile was previously ignored silently — and the next
`saveState()` would overwrite the only copy of whatever was in it. The server
now moves a corrupt file aside to `state.json.corrupt-<timestamp>` (same mode as
the original), logs a diagnostic to stderr telling the operator where the
evidence went, and starts fresh. Nothing is silently discarded and nothing is
overwritten. The quarantine and preservation helpers live in
[`mcp/src/stateBackup.ts`](../mcp/src/stateBackup.ts).

## Mainnet guardrails

When `STELLAR_NETWORK` is `mainnet`, mutation and buy tools require `confirmMainnet: true` (or process env `MINDVAULT_ALLOW_MAINNET=1`). Profile list/switch/info tools are read-only and stay unrestricted. See [mainnet-deployment-checklist.md](./mainnet-deployment-checklist.md#mcp-mainnet-guardrails).
