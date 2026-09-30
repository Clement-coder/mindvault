# MCP Structured Output

Tools with structured results return a **machine-readable JSON object** next to
the existing human-readable text block. Agents can read a resource id, price,
or transaction hash without parsing prose.

Source:

- [`mcp/src/toolResult.ts`](../mcp/src/toolResult.ts) — wraps CallTool results
- [`mcp/src/outputSchemas.ts`](../mcp/src/outputSchemas.ts) — advertised shapes
- [`mcp/src/tools.ts`](../mcp/src/tools.ts) — `outputSchema` on `TOOL_DEFINITIONS`

This follows the MCP 2025-06-18
[structured content](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
contract: a tool that declares `outputSchema` must return conforming
`structuredContent` on success.

## Result contract

**Success, structured tool:**

```json
{
  "content": [{ "type": "text", "text": "…" }],
  "structuredContent": { "id": "mock-1", "price": "1.5" }
}
```

The text block is the same string the tool returned before this change.

**Success, text-only tool:** `{ "content": [{ "type": "text", "text": "…" }] }` —
no `structuredContent`, no `outputSchema`.

**Failure (thrown):** `{ "content": [{ "type": "text", "text": "Error: …" }], "isError": true }` —
no `structuredContent`. Soft misses that already return JSON (registry
`found: false`) stay successful results with a payload.

When a structured tool returns prose instead of JSON (insufficient funds,
verification rejected, missing tx hash), the text is unchanged and
`structuredContent` is `{ "status": "text", "message": "<same text>" }`.

## Which tools emit a payload

| Group         | Tools                                                                                                                                     | Typical fields                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Catalog       | `browse`, `search`, `batch_catalog_lookup`, `preview_metadata_hash`                                                                       | `items[]` (`id`, `title`, `price`, `description`, `accessUrl`), `notice`, `truncated`; batch adds `requested`, `foundCount`, `missing`; hash preview returns `pointer` + `report` |
| Wallet        | `setup_wallet`, `import_wallet`, `wallet_info`, `use_profile`, `list_profiles`                                                            | `address`, `profile`, balances                                                        |
| JSON handlers | `preview`, `publish`, `buy`, `publish_status`, `purchase_history`, `export_receipts`, registry reads/mutations, `tx_status`, `metrics`, … | existing JSON object, also as `structuredContent`                                     |

Text-only: `check_bindings`, `reset`, `backup_state`, `restore_state`,
`verify_install`, `registry_health`, `check_state_permissions`, `register`,
`rotate_publisher_key`, `mindvault_set_tags`.

`mindvault_publish_status` and `mindvault_purchase_history` are advertised in
ListTools with extra schemas (they are not in `TOOL_DEFINITIONS`).

## Adding a schema

1. Define a JSON Schema object in [`mcp/src/outputSchemas.ts`](../mcp/src/outputSchemas.ts)
   with explicit `required` keys. Use `null` for absent values.
2. Attach it as `outputSchema` on the tool in [`mcp/src/tools.ts`](../mcp/src/tools.ts)
   (or `EXTRA_OUTPUT_SCHEMAS` for dispatch-only tools).
3. If the handler text is already `JSON.stringify(...)`, CallTool parses it.
   If the handler returns prose, return `{ text, structured }` from dispatch
   so the text string does not change.
4. Add a schema-parity assertion in [`mcp/src/outputSchemas.test.ts`](../mcp/src/outputSchemas.test.ts)
   and a CallTool check in [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts).
5. Run `pnpm --filter @mindvault/mcp generate-tool-docs` so the Structured
   column stays in sync.

## Tests

- [`mcp/src/toolResult.test.ts`](../mcp/src/toolResult.test.ts) — wrap helper
- [`mcp/src/outputSchemas.test.ts`](../mcp/src/outputSchemas.test.ts) — schema parity
- [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts) — both blocks
  through the SDK, plus text-only and `isError` cases
