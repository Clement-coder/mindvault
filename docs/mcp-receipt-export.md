# MCP Receipt Export

`mindvault_export_receipts` turns the receipts recorded by `mindvault_buy` into
a **schema-versioned document** — JSON, or RFC 4180 CSV — that an agent can
reconcile against, or a person can file.

Source: [`mcp/src/receipts.ts`](../mcp/src/receipts.ts).

## Export vs. history

[`mindvault_purchase_history`](mcp-quickstart.md) lists what was bought; it is a
browsing aid. An export is a document other systems read, so it adds what a
listing does not have:

|                   | `mindvault_purchase_history` | `mindvault_export_receipts`           |
| ----------------- | ---------------------------- | ------------------------------------- |
| Schema version    | —                            | `mindvault.receipt-export/v1`         |
| Declared currency | —                            | `USDC`, on the envelope and every row |
| Summed total      | —                            | `totalAmount`, exact to the stroop    |
| Date range        | —                            | `since` / `until`                     |
| Explorer links    | —                            | resolved per receipt                  |
| CSV               | —                            | fixed column order                    |
| Structured result | text only                    | `structuredContent` + `outputSchema`  |

Both read the same local store (`~/.mindvault/purchases.json`, or
`MINDVAULT_PURCHASES_FILE`). Neither makes a network call.

## Arguments

| Argument     | Type    | Meaning                                                             |
| ------------ | ------- | ------------------------------------------------------------------- |
| `format`     | enum    | `json` (default), `csv`, or `ndjson`                                |
| `resourceId` | string  | Only receipts for this resource                                     |
| `network`    | string  | Only receipts settled on this x402 network (e.g. `stellar:testnet`) |
| `since`      | string  | Inclusive lower bound, ISO-8601; a bare date means midnight UTC     |
| `until`      | string  | Inclusive upper bound, ISO-8601                                     |
| `limit`      | integer | Max receipts, newest first (1–500)                                  |

Invalid values are rejected before anything is read, with a message naming the
argument — an unknown `format`, an unparseable date, an inverted range, or a
limit outside the supported bounds.

## The envelope

```json
{
  "schema": "mindvault.receipt-export/v1",
  "generatedAt": "2026-08-25T12:00:00.000Z",
  "format": "json",
  "filters": { "resourceId": null, "network": null, "since": null, "until": null, "limit": null },
  "count": 1,
  "totalAmount": "1.5",
  "currency": "USDC",
  "receipts": [
    {
      "resourceId": "mock-1",
      "title": "Intro to Stellar Smart Contracts",
      "amount": "1.5",
      "currency": "USDC",
      "network": "stellar:testnet",
      "purchasedAt": "2026-08-25T11:59:07.000Z",
      "txHash": "abc123",
      "receiptRef": "pay-1",
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123"
    }
  ]
}
```

Missing values are explicit `null`s, never absent keys, so a consumer can read
every field without existence checks. `filters` echoes what the export was
produced with, which makes the document self-describing once it leaves the
session.

`totalAmount` is summed in integer stroops (7 decimal places) rather than
floating point, so an export of `0.1` and `0.2` totals `0.3` — not
`0.30000000000000004`.

## CSV

With `format: "csv"` the same rows are rendered into the envelope's `csv` field:

```csv
resourceId,title,amount,currency,network,purchasedAt,txHash,receiptRef,explorerUrl
mock-1,Intro to Stellar Smart Contracts,1.5,USDC,stellar:testnet,2026-08-25T11:59:07.000Z,abc123,pay-1,https://stellar.expert/explorer/testnet/tx/abc123
```

Column order is fixed and quoting follows RFC 4180 (fields containing a comma,
quote, or newline are wrapped; embedded quotes are doubled), so a title like
`Data, "clean", 2026` survives a round trip through a spreadsheet.

The CSV travels **inside** the envelope rather than replacing it because the
tool declares an `outputSchema`: a tool that declares one must return structured
results conforming to it, so both formats share one shape.

## NDJSON

With `format: "ndjson"` each receipt is serialized as an independent JSON object
on its own line in the envelope's `ndjson` field:

```
{"resourceId":"mock-1","title":"Intro to Stellar Smart Contracts","amount":"1.5","currency":"USDC","network":"stellar:testnet","purchasedAt":"2026-08-25T11:59:07.000Z","txHash":"abc123","receiptRef":"pay-1","explorerUrl":"https://stellar.expert/explorer/testnet/tx/abc123"}
```

An empty export produces an empty string — no trailing newline — consistent with
how tools like `jq --raw-input` and line-oriented processors handle empty
Newline-Delimited JSON files.

NDJSON is designed for accounts with large receipt histories: each line is a
complete, self-contained document that can be streamed or processed one row at a
time without holding the entire array in memory. Unlike the `json` format, a
consumer reading NDJSON does not need to parse the full response before it can
act on the first receipt.

Like CSV, the NDJSON document travels **inside** the envelope rather than
replacing it, so the tool's `outputSchema` describes every format and the server
can return the same object as `structuredContent` regardless of format.

## Structured content

The tool advertises an `outputSchema`, and the server returns the envelope as
`structuredContent` alongside the usual text block:

```json
{
  "content": [{ "type": "text", "text": "{ … }" }],
  "structuredContent": { "schema": "mindvault.receipt-export/v1", "count": 1, … }
}
```

Clients that validate structured results can do so against the advertised
schema; clients that only read text see exactly what they saw before. See the
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
for the structured-content contract.

## Coverage

- [`mcp/src/receipts.test.ts`](../mcp/src/receipts.test.ts) — argument
  normalization, exact totals, CSV quoting, NDJSON line-per-row encoding, date
  bounds, and the advertised schema matching what the tool returns for all three
  formats
- [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts) — the tool
  through `callTool`, including the advertised `outputSchema`
- [`mcp/src/installSmoke.ts`](../mcp/src/installSmoke.ts) — a versioned export is
  part of the fixture-backed install check
