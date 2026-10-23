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

**Failure (thrown):** `{ "content": [{ "type": "text", "text": "Error: …" }], "isError": true }`.
When the failure was classified (network, timeout, payment, …) it also carries
`structuredContent: { "troubleshooting": { "schema": "mindvault.troubleshooting/v1", … } }`.
Soft misses that already return JSON (registry `found: false`) stay successful
results with a payload.

When a structured tool returns prose instead of JSON (insufficient funds,
verification rejected, missing tx hash), the text is unchanged and
`structuredContent` is `{ "status": "text", "message": "<same text>" }`.

## Success and error schemas

Every advertised `outputSchema` covers both results a tool can send (#1062):

```json
{
  "type": "object",
  "anyOf": [
    { "…": "the tool's success schema from outputSchemas.ts" },
    {
      "type": "object",
      "required": ["troubleshooting"],
      "properties": { "troubleshooting": { "…": "mindvault.troubleshooting/v1" } }
    }
  ]
}
```

MCP clients validate `structuredContent` on error results as well as
successes — the TypeScript SDK's `Client.callTool` throws when it does not
match — so a schema that described only success turned every classified
failure into a client-side exception. The error half is
`TOOL_ERROR_OUTPUT_SCHEMA` in [`mcp/src/outputValidation.ts`](../mcp/src/outputValidation.ts);
`successSchemaOf()` recovers the success half.

## Server-side validation

Before a result is sent, the CallTool handler checks it against the tool's
advertised schema with the same Ajv validator the SDK client uses
([`mcp/src/outputValidation.ts`](../mcp/src/outputValidation.ts)). This runs on
success and error results, in the stdio entry point and in servers built with
[`createMindVaultServer`](mcp-server-factory.md).

A result that does not conform is a server bug — an internal contract
mismatch — and is handled so it never reaches a client as an invalid payload:

- **Logged** to stderr at `error` level with the tool name and the schema paths
  that failed (`data/price must be string`). The payload itself is never
  logged — it can carry addresses, receipts or keys — and the message is run
  through secret redaction as well.
- **Sent** as an `isError` result. The handler's text block is kept first (for
  a payment or on-chain mutation it is how the agent learns the operation went
  through), followed by a short note, and `structuredContent` is a
  troubleshooting hint with `source: "mcp"`, `category: "server"` that itself
  validates.

```json
{
  "content": [
    { "type": "text", "text": "<the tool's original text>" },
    {
      "type": "text",
      "text": "Error: internal contract mismatch — mindvault_x returned structured output that does not match its declared schema, so it was withheld. …"
    }
  ],
  "isError": true,
  "structuredContent": {
    "troubleshooting": {
      "schema": "mindvault.troubleshooting/v1",
      "source": "mcp",
      "category": "server",
      "status": null,
      "summary": "Internal contract mismatch: mindvault_x produced a result that does not match its declared output schema.",
      "detail": null,
      "action": "This is a MindVault MCP server bug, not a problem with your arguments. …"
    }
  }
}
```

A success with no `structuredContent` from a tool that declares a schema is a
mismatch too. Results that already conform are sent unchanged.

## Null versus omitted

A field's schema says which of the two a client can see, and handlers follow
it exactly:

- **Required and nullable** (`type: [..., "null"]` and listed in `required`):
  always present. A value the upstream service, the local store, or the
  ledger did not provide is sent as `null`, never left out.
- **Optional** (not in `required`): may be omitted. Omitted means "not
  applicable to this result", for example `lease` on a `mindvault_lease_status`
  miss, or `csv` on a JSON receipt export.

`JSON.stringify` drops a property whose value is `undefined`, so a handler that
copies an optional upstream value straight into a required field silently
omits it, and the output contract above turns the whole result into an error.
Handlers therefore coalesce with `?? null`. Fields this applies to (#1065):

| Tool                         | Fields that are `null`, never omitted                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `mindvault_preview`          | `id`, `title`, `description`, `price` (`null` instead of `"$undefined USDC"`), `type`, `verificationStatus`, `accessUrl`                    |
| `mindvault_purchase_history` | `purchases[].txHash`, `receiptRef`, `explorerUrl`. A stored receipt missing `txHash` or `receiptRef` is kept with `null`, no longer dropped |
| `mindvault_export_receipts`  | `receipts[].title`, `txHash`, `receiptRef`, `explorerUrl`; every key of `filters` when that filter is unset                                 |
| `mindvault_buy`              | `txHash`, `settlement.txHash`, `settlement.status`                                                                                          |
| `mindvault_tx_status`        | `ledgerCloseTime` when the RPC reports no close time                                                                                        |
| `mindvault_debug_bundle`     | `environment` when `includeEnvironment: false`                                                                                              |

The purchase store also keeps its `epoch` when it is rewritten. Before, with
`MINDVAULT_PURCHASES_EPOCH` set, each new receipt was saved without the
epoch, so the next read treated the file as another wallet's history and
dropped every earlier receipt.

[`mcp/src/nullableFields.test.ts`](../mcp/src/nullableFields.test.ts) runs each
of these handlers with the value populated, explicitly `null`, and absent, and
checks the result against the advertised schema and that the field is present.

## Which tools emit a payload

| Group         | Tools                                                                                                                                     | Typical fields                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog       | `browse`, `search`, `batch_catalog_lookup`, `preview_metadata_hash`                                                                       | `items[]` (`id`, `title`, `price`, `description`, `accessUrl`), `notice`, `truncated`; batch adds `requested`, `foundCount`, `missing`; hash preview returns `pointer` + `report` |
| Wallet        | `setup_wallet`, `import_wallet`, `wallet_info`, `use_profile`, `list_profiles`                                                            | `address`, `profile`, balances                                                                                                                                                    |
| JSON handlers | `preview`, `publish`, `buy`, `publish_status`, `purchase_history`, `export_receipts`, registry reads/mutations, `tx_status`, `metrics`, … | existing JSON object, also as `structuredContent`                                                                                                                                 |

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
4. Add a success sample for the tool to `SUCCESS_OUTCOMES` in
   [`mcp/src/toolOutputContract.test.ts`](../mcp/src/toolOutputContract.test.ts) — the
   coverage test fails until you do — and a CallTool check in [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts).
5. Run `pnpm --filter @mindvault/mcp generate-tool-docs` so the Structured
   column stays in sync.

## Tests

- [`mcp/src/toolResult.test.ts`](../mcp/src/toolResult.test.ts) — wrap helper
- [`mcp/src/outputSchemas.test.ts`](../mcp/src/outputSchemas.test.ts) — schema parity
- [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts) — both blocks
  through the SDK, plus text-only and `isError` cases
- [`mcp/src/toolOutputContract.test.ts`](../mcp/src/toolOutputContract.test.ts) —
  a success and an error result for every structured tool validated against
  its advertised schema (real handler output wherever the handler runs
  offline), mismatch logging without payload secrets, and a real SDK client
  receiving a mismatch as a readable error
- [`mcp/src/nullableFields.test.ts`](../mcp/src/nullableFields.test.ts) —
  null, absent, and populated values for every required nullable receipt,
  settlement, preview, and diagnostic field
