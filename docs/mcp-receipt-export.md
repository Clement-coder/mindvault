# MCP Receipt Export

`mindvault_export_receipts` turns the receipts recorded by `mindvault_buy` into
a **schema-versioned document** — JSON, or RFC 4180 CSV — that an agent can
reconcile against, or a person can file.

Source: [`mcp/src/receipts.ts`](../mcp/src/receipts.ts).

CSV fields beginning with `=`, `+`, `-`, or `@` (including after leading
whitespace) are prefixed with an apostrophe to prevent spreadsheet formula
execution. Embedded CR/LF characters are exported as visible `\\r` and `\\n`
sequences, so a receipt cannot create an extra physical CSV row. NDJSON uses
JSON string escaping for line endings. Both formats preserve valid UTF-8 text.

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
| Field selection   | —                            | `fields`; sensitive fields excluded   |
| Resumable paging  | —                            | `offset` / `nextOffset`               |
| Explorer links    | —                            | resolved per receipt                  |
| CSV               | —                            | fixed column order                    |
| Structured result | text only                    | `structuredContent` + `outputSchema`  |

Both read the same local store (`~/.mindvault/purchases.json`, or
`MINDVAULT_PURCHASES_FILE`). Neither makes a network call.

## Arguments

| Argument           | Type    | Meaning                                                             |
| ------------------ | ------- | ------------------------------------------------------------------- |
| `format`           | enum    | `json` (default), `csv`, or `ndjson`                                |
| `resourceId`       | string  | Only receipts for this resource                                     |
| `network`          | string  | Only receipts settled on this x402 network (e.g. `stellar:testnet`) |
| `since`            | string  | Inclusive lower bound, ISO-8601; a bare date means midnight UTC     |
| `until`            | string  | Inclusive upper bound, ISO-8601                                     |
| `limit`            | integer | Max receipts per page, newest first (1–500)                         |
| `offset`           | integer | Rows to skip from the newest receipt, for resumable paging (≥ 0)    |
| `fields`           | string  | Comma-separated subset of row fields to include, in order           |
| `includeSensitive` | boolean | Keep sensitive fields in the default field set (see below)          |

Invalid values are rejected before anything is read, with a message naming the
argument — an unknown `format`, an unparseable date, an inverted range, a limit
outside the supported bounds, a negative offset, or an unknown field name.

## Field selection

Each row carries a fixed set of fields, and an export includes every one of them
**except the sensitive ones** by default:

| Field         | Sensitive | Notes                                            |
| ------------- | --------- | ------------------------------------------------ |
| `resourceId`  | no        |                                                  |
| `title`       | no        |                                                  |
| `amount`      | no        | Decimal string, e.g. `"1.5"`                     |
| `currency`    | no        | Always `USDC`                                    |
| `network`     | no        | x402 network id                                  |
| `purchasedAt` | no        | ISO-8601 instant                                 |
| `txHash`      | no        | Null when the receipt has no hash                |
| `receiptRef`  | no        | Null when delivery returned no payment id        |
| `explorerUrl` | no        | Null when there is no `txHash`                   |
| `profile`     | **yes**   | Local wallet profile the purchase was made under |

`profile` is excluded by default: a receipt is a document that leaves the
session — pasted into a ticket, committed to a repo, handed to a reconciler —
and the profile is a stable buyer identifier, so exporting it by default would
leak that identity into every reconciliation artifact. To include it, either
name it in `fields` (`fields: "resourceId,profile"`) or pass
`includeSensitive: true` (which adds every sensitive field back to the default
set). Naming a sensitive field in `fields` is itself an explicit opt-in.

`fields` accepts a comma-separated string or an array, and the selection is
echoed in the envelope's `fields` array in the order given. Rows are
projections: a selected field that has no value is an explicit `null`, and a
field that was **not** selected is absent from the row (not `null`). An unknown
field name is rejected with a message listing the known fields. `fields` and
`includeSensitive` apply to all three formats — the CSV header and columns and
the NDJSON keys are exactly the selected fields.

## Resumable pagination

An account with more receipts than `limit` can export them in pages without
losing or repeating a row. The envelope reports:

- `totalMatching` — how many rows the filters match, before pagination;
- `nextOffset` — the value to pass as `offset` on the next call, or `null` when
  this page is the last.

`limit` bounds a single page (1–500), so a client walks a large history by
calling the tool in a loop:

```text
offset = 0
repeat:
  page = mindvault_export_receipts({ limit: 500, offset })
  store(page.receipts)
  offset = page.nextOffset
until offset is null
```

`totalAmount` sums only the rows on the current page, so a totals check should
either sum the stored pages or read `monthlySummaries`. Rows are ordered
newest-first by `purchasedAt`; an `offset` past the end returns an empty,
still-valid page with `nextOffset: null`.

## The envelope

```json
{
  "schema": "mindvault.receipt-export/v1",
  "generatedAt": "2026-08-25T12:00:00.000Z",
  "format": "json",
  "filters": {
    "resourceId": null,
    "network": null,
    "since": null,
    "until": null,
    "limit": null,
    "offset": null,
    "groupBy": null
  },
  "fields": [
    "resourceId",
    "title",
    "amount",
    "currency",
    "network",
    "purchasedAt",
    "txHash",
    "receiptRef",
    "explorerUrl"
  ],
  "count": 1,
  "totalMatching": 1,
  "nextOffset": null,
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

Within each row, missing values are explicit `null`s, never absent keys, so a
consumer can read every selected field without existence checks. (`profile` is
the exception by design: it is absent from a row unless it was selected — see
[Field selection](#field-selection).) `filters` echoes what the export was
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
  bounds, field selection and sensitive-field exclusion, resumable pagination
  (`offset` / `nextOffset`), and the advertised schema matching what the tool
  returns for all three formats
- [`mcp/src/integration.test.ts`](../mcp/src/integration.test.ts) — the tool
  through `callTool`, including the advertised `outputSchema`
- [`mcp/src/installSmoke.ts`](../mcp/src/installSmoke.ts) — a versioned export is
  part of the fixture-backed install check
