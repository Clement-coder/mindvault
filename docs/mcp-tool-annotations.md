# MCP Tool Annotations

Every tool advertised by the MindVault MCP server (the `ListTools` response)
carries MCP [tool annotations](https://modelcontextprotocol.io/specification)
so agent clients can tell at a glance which calls are safe to repeat and which
can destroy local state.

Annotations are **advisory hints only** — a client must never gate a call on
them, and the server never depends on them internally. They exist to give
agents a fast, correct signal before they invoke a tool.

Annotations live in [`mcp/src/tools.ts`](../mcp/src/tools.ts) (`TOOL_DEFINITIONS`),
the single source of truth for the advertised tool surface. The `ListTools`
handler in [`mcp/src/index.ts`](../mcp/src/index.ts) resolves them by name, so
the advertised surface and the definition list cannot drift apart.

## The four fields

| Field             | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `title`           | Human-readable tool title shown in client UIs.                   |
| `readOnlyHint`    | `true` when the tool performs no state changes or side effects.  |
| `destructiveHint` | `true` when the tool can irreversibly destroy local state.       |
| `idempotentHint`  | `true` when repeating the tool with identical arguments is safe. |

## What to expect

- **Read-only tools** (`mindvault_browse`, `mindvault_search`,
  `mindvault_preview`, `mindvault_wallet_info`, registry reads, verifications…)
  set `readOnlyHint: true` and are never `destructiveHint`.
- **Destructive tools** set `destructiveHint: true` and are never
  `readOnlyHint`: `mindvault_reset` and `mindvault_restore_state`; the tools
  that replace a stored wallet secret or API key (`mindvault_setup_wallet`,
  `mindvault_import_wallet`, `mindvault_repair_sponsored_account`,
  `mindvault_register`, `mindvault_rotate_publisher_key`); and
  `mindvault_freeze`, whose on-chain effect cannot be undone.
- **Mutating but non-destructive tools** (publish, buy, register, on-chain
  mutations…) are neither read-only nor destructive; many are not idempotent.
- `mindvault_publish_status` and `mindvault_purchase_history` validate their
  arguments inside the handler, so their annotations are declared alongside the
  advertised surface in `index.ts` rather than in `TOOL_DEFINITIONS`.

## Side-effect inventory

The hints are derived, not chosen. [`mcp/src/toolSideEffects.ts`](../mcp/src/toolSideEffects.ts)
records, per tool and from its handler, the worst case over its arguments of:

| Axis      | Values                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`   | `none`; `memory` (in-process state other calls observe); `write` (adds or updates files under `~/.mindvault`); `overwrite` (can replace or delete stored data) |
| `remote`  | `none`; `api` (a non-idempotent MindVault or sponsored-account request); `chain` (a Stellar transaction signed by the agent wallet)                            |
| `payment` | `none`, `usdc`, or `fee`, the same classes as `paidOperations.ts`                                                                                              |

and, for on-chain changes that can never be undone, `irreversible`. From
that row:

- `readOnlyHint` is `true` exactly when `local`, `remote`, and `payment` are
  all `none`;
- `destructiveHint` is `true` exactly when `local` is `overwrite` or the
  change is `irreversible`;
- `payment` must equal the tool's class in `USDC_SPENDING_TOOLS` /
  `FEE_SPENDING_TOOLS`, so `MINDVAULT_CONFIRM_PAID_OPERATIONS` gates exactly
  the tools that spend;
- a tool with a `chain` effect or any payment must be in
  `MAINNET_GATED_TOOLS`.

Server bookkeeping is not counted: the operator-configured audit log, the
metrics every call increments, and in-memory read caches.

The audit that introduced the inventory (#1063) corrected these:

| Tool                                                                                      | Was                         | Now                           | Why                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `mindvault_backup_state`                                                                  | read-only, idempotent       | not read-only, not idempotent | writes a new encrypted backup file under `~/.mindvault/backups` on every confirmed call |
| `mindvault_recover_catalog_cache`                                                         | not read-only               | read-only                     | the handler only returns guidance; it invalidates and re-fetches nothing                |
| `mindvault_setup_wallet`, `mindvault_import_wallet`, `mindvault_repair_sponsored_account` | not destructive             | destructive                   | each replaces the target profile's wallet secret without a guard                        |
| `mindvault_register`, `mindvault_rotate_publisher_key`                                    | not destructive             | destructive                   | each replaces the stored API key (rotation also revokes the old one server-side)        |
| `mindvault_set_tags`, `mindvault_accept_transfer`, `mindvault_cancel_transfer`            | not paid                    | `fee`                         | each submits a signed registry transaction; `set_tags` already advertised `confirmPaid` |
| `mindvault_terms`                                                                         | not paid, not mainnet-gated | `fee`, mainnet-gated          | `operation: "set"` submits `set_terms_hash`; `"get"` stays exempt from both guardrails  |

Under `MINDVAULT_READ_ONLY=1`, `mindvault_backup_state` is now refused and
`mindvault_recover_catalog_cache` is now available, since read-only mode
follows `readOnlyHint`.

## Tests

- [`mcp/src/toolMetadata.test.ts`](../mcp/src/toolMetadata.test.ts) asserts every
  definition has a title and all four typed fields, and that read-only tools are
  not marked destructive (and vice-versa).
- [`mcp/src/toolSideEffects.test.ts`](../mcp/src/toolSideEffects.test.ts) is the
  contract test for the inventory: every tool has a row, every annotation and
  guardrail list agrees with it, and every tool the inventory calls
  side-effect free is dispatched against a scratch home directory and a
  recording fetch, and fails if it writes a file or makes a non-read request.
- [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts) drives the real
  `ListTools` request through the SDK and asserts every advertised tool carries
  the annotations, including the two handler-validated tools.
