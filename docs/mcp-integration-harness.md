# MCP Integration Test Harness

Vitest harness that exercises the MindVault MCP server **through the SDK
request interface** (`listTools` / `callTool`) instead of calling exported
helper functions directly.

Source:

- [`mcp/src/integrationHarness.ts`](../mcp/src/integrationHarness.ts) — in-memory
  Client ↔ Server wiring via `InMemoryTransport`
- [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts) — list tools,
  call representative tools, assert deterministic errors

## Running it

```bash
# From the repo root
pnpm --filter @mindvault/mcp test

# Or only the integration suite
pnpm --filter @mindvault/mcp exec vitest run src/integration.test.ts
```

The suite sets `MINDVAULT_MOCK=1` before importing the server so HTTP and
on-chain registry lookups use the deterministic fixtures in
[`mcp/src/mock.ts`](../mcp/src/mock.ts). Agent state is isolated under a temp
`HOME` directory.

## What it covers

| Check           | How                                                                                     |
| --------------- | --------------------------------------------------------------------------------------- |
| Tool listing    | `client.listTools()` over the in-memory transport                                       |
| Catalog tools   | `mindvault_browse`, `mindvault_search`, `mindvault_preview`                             |
| Registry mock   | `mindvault_registry_lookup` (seeded hit + miss), `mindvault_registry_list` (pagination) |
| Wallet setup    | `mindvault_setup_wallet` via mock `/create`                                             |
| Structured JSON | `structuredContent` on catalog, preview, receipts, wallet; absent on text-only tools    |
| Error shape     | Unknown tool + missing wallet                                                           |

## Error handling contract

When a tool throws, the CallTool handler returns a deterministic MCP error
result — not an uncaught transport failure:

1. `isError: true`
2. Text content prefixed with `Error:`
3. Message passed through `safeErrorMessage` (no wallet secrets, API keys, or
   stack traces)

Clients (and this harness) treat either `isError` or a leading `Error:` line as
failure. Soft, non-throwing outcomes (for example registry “not found” JSON)
remain successful tool results with `isError` unset. Thrown failures never
include `structuredContent`. Successful structured tools attach it next to the
text; `harnessStructuredContent()` reads that object.

The message _inside_ that envelope is structured: a summary line, a
machine-readable `Source: … · Category: … · HTTP …` line, and a `Next:` step.
See [mcp-error-reference.md](mcp-error-reference.md) for the source and category
tables.

## Relation to the smoke test

|           | Integration harness         | Smoke test            |
| --------- | --------------------------- | --------------------- |
| Transport | In-memory (Vitest)          | Stdio child process   |
| Scope     | List + representative tools | Full setup → buy flow |
| Runner    | `pnpm test`                 | `pnpm smoke`          |

Use the harness for fast, deterministic CI coverage of the MCP request surface;
use the [smoke test](mcp-smoke-test.md) for an end-to-end agent path.
