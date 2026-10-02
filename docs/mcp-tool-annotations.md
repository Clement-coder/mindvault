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
- **Destructive tools** (`mindvault_reset`, `mindvault_restore_state`) set
  `destructiveHint: true` and are never `readOnlyHint`.
- **Mutating but non-destructive tools** (publish, buy, register, on-chain
  mutations…) are neither read-only nor destructive; many are not idempotent.
- `mindvault_publish_status` and `mindvault_purchase_history` validate their
  arguments inside the handler, so their annotations are declared alongside the
  advertised surface in `index.ts` rather than in `TOOL_DEFINITIONS`.

## Tests

- [`mcp/src/toolMetadata.test.ts`](../mcp/src/toolMetadata.test.ts) asserts every
  definition has a title and all four typed fields, and that read-only tools are
  not marked destructive (and vice-versa).
- [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts) drives the real
  `ListTools` request through the SDK and asserts every advertised tool carries
  the annotations, including the two handler-validated tools.
