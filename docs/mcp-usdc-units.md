# MCP USDC Units

Every USDC amount in the MCP server is in one of two encodings, and neither
carries its unit:

| Source                       | Encoding                      | `1 USDC` looks like |
| ---------------------------- | ----------------------------- | ------------------- |
| Horizon (`/accounts/:id`)    | decimal string                | `"1.0000000"`       |
| Soroban / the vault registry | i128 **stroops** (7 decimals) | `10000000n`         |

They differ by 10<sup>7</sup>. A value from one substituted for the other
type-checks, formats, and compares without complaint — and means ten million
times more or less than it should. The dangerous direction is quiet: a stroop
count read as a decimal balance reports a wallet as richly funded and waves an
unaffordable payment through.

Source: [`mcp/src/usdcAmount.ts`](../mcp/src/usdcAmount.ts).

## One conversion, tagged at the boundary

The factor is defined once (`STROOPS_PER_USDC`) and every amount that crosses a
service boundary is tagged with the encoding it arrived in:

```ts
normalizeUsdcBalance({ source: "horizon", balance: "12.5" }); // "12.5000000"
normalizeUsdcBalance({ source: "soroban", stroops: 125000000n }); // "12.5000000"
```

The tag is the safeguard. A reader cannot consume a balance without stating which
encoding it speaks, so a second balance source cannot be wired in on the wrong
scale — the compiler asks which one it is.

## What this replaced

The 10<sup>7</sup> factor used to be written out five times, each with its own
parser and its own idea of what a malformed amount should do:

| Was in              | Now uses                         |
| ------------------- | -------------------------------- |
| `index.ts`          | `stroopsToUsdc`, `usdcToStroops` |
| `tools/registry.ts` | `stroopsToUsdc`                  |
| `tools/publish.ts`  | `usdcToStroops`                  |
| `paymentCeiling.ts` | `usdcToStroops`                  |
| `receipts.ts`       | `sumUsdc`, `trimUsdc`            |

Five copies of a constant is five chances for the sixth caller to pick the wrong
one — which is how a ceiling and the price it guards end up measured on
different scales.

## Malformed amounts are null, never zero

`usdcToStroops` returns `null` for anything it cannot read exactly — including
`"1.00000001"`, which has more precision than Stellar can hold and would
otherwise be rounded into a transaction the agent never approved.

`compareUsdc` returns `null` when either side is unreadable, so a caller cannot
mistake "could not compare" for "not greater than". That distinction is load
bearing: `insufficientFundsMessage` now **blocks** a payment when the balance
cannot be parsed, where a floating-point `NaN` check previously let it through as
though funds were sufficient.

## Failover and units

`rpcFailover` fans a request across several **Soroban RPC** endpoints, which all
speak stroops, so failing over between them cannot change the scale. There is no
Soroban→Horizon balance fallback today: `getBalanceDetails` reads Horizon only.

Issue #838 describes what such a fallback would do if one were added naively —
return a balance off by 10<sup>7</sup>, silently. The tagged boundary above is
what makes adding one safe: a Soroban balance read enters as
`{ source: "soroban", stroops }` and is converted at the edge, or it does not
compile.

## Coverage

- [`mcp/src/usdcAmount.test.ts`](../mcp/src/usdcAmount.test.ts) — the factor,
  both directions, round-tripping, precision limits, and that the same holding
  read from either source normalizes to the same amount
- [`mcp/src/paymentCeiling.test.ts`](../mcp/src/paymentCeiling.test.ts) and
  [`mcp/src/receipts.test.ts`](../mcp/src/receipts.test.ts) — the migrated
  callers, unchanged in behaviour

See also: [mcp-rpc-failover.md](mcp-rpc-failover.md),
[mcp-receipt-export.md](mcp-receipt-export.md).
