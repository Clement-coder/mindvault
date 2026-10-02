# MCP Tool Error Codes

Issue [#580](https://github.com/mind-vault-1/mindvault/issues/580).

[`errorMapping.ts`](../mcp/src/errorMapping.ts) gives every failure a
_category_ — eleven broad buckets, each chosen so it maps to exactly one
recovery action. That is the right shape for "what should the agent do next"
and the wrong shape for everything else.

`payment` covers a 402 price quote, a rejected signature, an exceeded auto-pay
ceiling and an underfunded wallet. `validation` covers a malformed resource id
and a tool that does not exist. An agent branching on the category cannot tell
those apart, a bug report cannot name one, and a dashboard cannot count them.

Every failure now also carries a **code**: a short, stable identifier naming
one specific failure.

## The payload

Failures return `structuredContent` alongside the human-readable text:

```json
{
  "schema": "mindvault.error/v1",
  "code": "MV_PAYMENT_CEILING_EXCEEDED",
  "category": "payment",
  "source": "x402",
  "status": null,
  "retry": "safe",
  "summary": "Purchase failed: price 25 USDC exceeds the auto-pay ceiling",
  "detail": null,
  "action": "No funds moved. Pass maxAutoPayUsdc at least as large as the price, or raise MINDVAULT_MAX_AUTO_PAY_USDC.",
  "correlationId": "mv-1a2b3c4d-e5f6"
}
```

`category` and `action` stay exactly where clients already look for them — this
extends the existing troubleshooting hint rather than replacing it.

The `correlationId` ties the failure to its audit-log lines
([mcp-correlation-ids.md](mcp-correlation-ids.md)).

## Stability

Codes are a contract. They are **additive**: new failures get new codes, and an
existing code never changes meaning. Anything keyed on them — an agent's
branching, a dashboard, a runbook — keeps working across releases.

The `MV_` prefix makes a code recognisable out of context: in a log line, a bug
report, or a client's error handler.

## The catalog

| Code                          | Category     | Retry          | Meaning                                                                                                               |
| ----------------------------- | ------------ | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MV_API_KEY_REVOKED`          | `auth`       | ❌ unsafe      | The stored publisher API key is no longer accepted — revoked, rotated elsewhere, or its publisher record was removed. |
| `MV_ARGUMENT_INVALID`         | `validation` | ❌ unsafe      | The arguments failed validation, locally or at the server.                                                            |
| `MV_AUTH_REJECTED`            | `auth`       | ❌ unsafe      | A credential was presented and the operation was denied.                                                              |
| `MV_AUTH_REQUIRED`            | `auth`       | ❌ unsafe      | The call needs a credential and none was presented.                                                                   |
| `MV_CLOCK_SKEW`               | `auth`       | ✅ safe        | A request signature was rejected because this machine's clock is outside the accepted window.                         |
| `MV_CONFLICT`                 | `conflict`   | ❌ unsafe      | The resource is already in the requested state.                                                                       |
| `MV_CONTRACT_ERROR`           | `contract`   | ❌ unsafe      | The vault-registry contract rejected the call or is not the expected contract.                                        |
| `MV_INSUFFICIENT_FUNDS`       | `payment`    | ✅ safe        | The wallet lacks the USDC or the native XLM reserve needed to pay.                                                    |
| `MV_MAINNET_UNCONFIRMED`      | `validation` | ❌ unsafe      | A mainnet mutation or payment was attempted without explicit confirmation.                                            |
| `MV_NETWORK_UNREACHABLE`      | `network`    | ✅ safe        | The service could not be reached — DNS failure, refused connection, or a dropped socket.                              |
| `MV_NOT_FOUND`                | `not_found`  | ❌ unsafe      | The referenced resource does not exist.                                                                               |
| `MV_PAYMENT_CEILING_EXCEEDED` | `payment`    | ✅ safe        | The price exceeds the configured auto-pay ceiling, so no payment was attempted.                                       |
| `MV_PAYMENT_REJECTED`         | `payment`    | ⚠️ check first | A payment was attempted and did not complete successfully.                                                            |
| `MV_PAYMENT_REQUIRED`         | `payment`    | ✅ safe        | The resource returned an x402 challenge and no payment has been attempted yet.                                        |
| `MV_RATE_LIMITED`             | `rate_limit` | ✅ safe        | The upstream service is throttling this client.                                                                       |
| `MV_STATE_CORRUPT`            | `unknown`    | ❌ unsafe      | The local state file could not be read as valid state.                                                                |
| `MV_STATE_LOCKED`             | `conflict`   | ✅ safe        | Another state-mutating tool call holds the state lock.                                                                |
| `MV_TIMEOUT`                  | `timeout`    | ✅ safe        | The request exceeded its configured deadline.                                                                         |
| `MV_TOOL_UNKNOWN`             | `validation` | ❌ unsafe      | No tool by that name is exposed by this server.                                                                       |
| `MV_UNKNOWN`                  | `unknown`    | ⚠️ check first | The failure did not match any known classification.                                                                   |
| `MV_UPSTREAM_ERROR`           | `server`     | ✅ safe        | The upstream service returned a 5xx.                                                                                  |
| `MV_WALLET_MISSING`           | `payment`    | ❌ unsafe      | The active profile has no wallet configured.                                                                          |

## Retry safety

`retry` is not advice about whether the operation is worth repeating — it is
about whether repeating it is **safe**.

- **safe** — repeat freely once the cause is addressed. Nothing was committed.
- **unsafe** — repeating changes nothing. An identical retry fails identically,
  or the desired state already holds.
- **check first** — the answer depends on state the error alone does not
  reveal. In practice this means a payment that may or may not have settled.

`conditional` is deliberately not collapsed into one of the other two. Rounding
it to "safe" risks a double spend; rounding it to "unsafe" strands a purchase
the user already paid for. See
[mcp-x402-retry-classification.md](mcp-x402-retry-classification.md) for what
to check.

## Classification order

A **local** failure is classified before the HTTP mapping is consulted. An
exceeded ceiling or a missing wallet never reached the network, and reporting
it as a server problem sends the agent to retry something that cannot succeed.

Within the HTTP mapping, a few categories split into more than one code because
the fixes differ:

| Situation                                | Code                  |
| ---------------------------------------- | --------------------- |
| 401 with no credential                   | `MV_AUTH_REQUIRED`    |
| 403 with a credential                    | `MV_AUTH_REJECTED`    |
| 401 with a stored key the server refuses | `MV_API_KEY_REVOKED`  |
| 401 from clock skew                      | `MV_CLOCK_SKEW`       |
| 402 challenge, nothing signed            | `MV_PAYMENT_REQUIRED` |
| Payment attempted and failed             | `MV_PAYMENT_REJECTED` |

The last row is the one that matters most: a bare 402 is the resource stating
its price, not a failed payment. Conflating the two would send an agent to
check a transaction it never made.

## Coverage

- [`mcp/src/errorCodes.test.ts`](../mcp/src/errorCodes.test.ts) — the catalog's
  own invariants, local and HTTP classification, and the failure payload
