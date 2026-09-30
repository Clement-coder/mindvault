# x402 Payment Retry Classification

Issue [#583](https://github.com/mind-vault-1/mindvault/issues/583).

[`retry.ts`](../mcp/src/retry.ts) says payments are never retried
automatically, and gives one reason: a retry can sign and settle a second USDC
transfer. That is correct and insufficient. It tells an agent that the _server_
will not retry, and nothing about whether the _agent_ may — which is the
question an agent actually faces when a buy fails.

The answer depends entirely on **how far the payment got**. From outside, the
failures look alike.

## The five stages

| Stage       | Retry          | Double-spend risk | What happened                                                                                          |
| ----------- | -------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `quoted`    | ✅ safe        | no                | The resource returned a 402 challenge quoting a price. Nothing was constructed or signed.              |
| `declined`  | ✅ safe        | no                | The client refused before constructing a payment — ceiling exceeded, wallet underfunded, or no wallet. |
| `signed`    | ⚠️ check first | **yes**           | A payment was signed but not confirmed as submitted.                                                   |
| `submitted` | ⚠️ check first | **yes**           | The payment was submitted and the response was lost.                                                   |
| `settled`   | ❌ never       | **yes**           | The payment succeeded; the failure came afterwards.                                                    |

The boundary that matters is **`signed`**. Before it, no value could have left
the wallet, and an immediate retry costs nothing but time. At or after it,
retrying can pay twice — and _not_ retrying can strand a purchase the user has
already paid for. Neither "always retry" nor "never retry" is correct, which is
why `conditional` exists as a verdict rather than being rounded to one of the
other two.

## Why `signed` is already dangerous

A signed Stellar transaction is a bearer instrument. Anyone holding it can
submit it, and it stays valid until its time bounds expire. "We signed but did
not submit" is therefore not a guarantee that nothing settled — only that _this
client_ did not knowingly submit it.

Treating `signed` as safe is the most tempting mistake here, because the error
usually says something like "payment failed" and no transaction hash was
returned. The absence of a hash is not evidence of absence of a payment.

## Mapping from error codes

Error codes ([mcp-error-codes.md](mcp-error-codes.md)) map onto stages:

| Error code                    | Stage       |
| ----------------------------- | ----------- |
| `MV_PAYMENT_REQUIRED`         | `quoted`    |
| `MV_PAYMENT_CEILING_EXCEEDED` | `declined`  |
| `MV_INSUFFICIENT_FUNDS`       | `declined`  |
| `MV_WALLET_MISSING`           | `declined`  |
| `MV_PAYMENT_REJECTED`         | `submitted` |

`MV_PAYMENT_REJECTED` maps to `submitted` rather than `signed` on purpose. The
payment layer reports a rejection without reliably saying whether the
transaction reached the network, and assuming it did not is the assumption that
pays twice. The pessimistic reading costs one status check; the optimistic one
costs the price of the resource.

Every other error code has **no** stage. A timeout while fetching a catalog
page is not a payment event, and treating it as one would send an agent to
check a transaction that was never made.

## Evidence beats error text

`classifyPaymentFailure` weighs facts before it weighs the error:

1. An explicit `stage` from the caller, when it knows.
2. **An existing local receipt** → `settled`.
3. **A known transaction hash** → `submitted`.
4. Otherwise, the stage implied by the error code.

A hash or a receipt is evidence of an attempt; an error is only ever a report
of a failure. When the two disagree, the evidence wins.

## What an agent should do

**On a `safe` verdict** — retry once the cause is fixed. Raise the auto-pay
ceiling, fund the wallet, or pass `maxAutoPayUsdc`.

**On a `conditional` verdict** — check before retrying:

```
mindvault_purchase_history --resourceId <id>   # did a receipt get written?
mindvault_tx_status --txHash <hash>            # if a hash is known
```

Retry only once the original is confirmed absent. A timeout is not evidence of
failure.

**On an `unsafe` verdict** — the payment succeeded. Re-fetch the resource
rather than paying again, and use `mindvault_purchase_history` to confirm the
receipt was recorded.

## Interaction with automatic retries

The server's own retry policy is unchanged and still excludes payments by
construction: retries are opt-in per call site and the payment path never opts
in. This classification governs what an **agent** may do after a payment
failure surfaces, which is a different decision made with different
information.

## Coverage

- [`mcp/src/paymentRetry.test.ts`](../mcp/src/paymentRetry.test.ts) — stage
  classification, code mapping, evidence precedence, and this page's staleness
  guard
