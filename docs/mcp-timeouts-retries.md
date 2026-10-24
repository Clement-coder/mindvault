# MCP Timeouts and Retries

## Pending Stellar transaction watcher

Pending transaction watching is bounded by a caller timeout and emits progress
with monotonically increasing counters. A terminal transaction event is emitted
once, after which polling stops. Cancellation ends the watcher and releases any
attached subscription cleanup callback.

Every outbound HTTP call the MindVault MCP server makes runs under a deadline,
and idempotent calls retry transient failures with bounded, jittered backoff.

- [Timeouts](#timeouts) — `mcp/src/httpTimeout.ts`
- [Retries](#retries) — `mcp/src/retry.ts`

## Timeouts

Every outbound HTTP call the MindVault MCP server makes runs under a deadline.
Without one, a hung or black-holed connection blocks the tool call forever — and
for a stdio MCP server that means the agent waits indefinitely with nothing to
react to.

Implementation: [`mcp/src/httpTimeout.ts`](../mcp/src/httpTimeout.ts).

### How it works

Each request is issued with an `AbortController`. A timer started alongside the
request aborts it when the budget elapses, which releases the socket rather than
leaving it dangling, and the caller receives a `RequestTimeoutError`.

That error is deliberately distinguishable from a caller-initiated cancellation:
only a budget overrun produces `RequestTimeoutError`. It maps to the `timeout`
category in the [error reference](mcp-error-reference.md), so an agent sees:

```text
MindVault API request failed: Request timed out after 15000ms (http). Raise MINDVAULT_HTTP_TIMEOUT_MS if this endpoint is legitimately slow.
Source: MindVault API · Category: timeout
Next: The request exceeded its configured timeout. Retry, or raise MINDVAULT_HTTP_TIMEOUT_MS for a slow endpoint.
```

If the caller passes its own `AbortSignal`, it is honoured too — aborting either
the caller's signal or the deadline aborts the request.

### Budgets

Budgets differ by service because the work differs: a catalog read should be
quick, while an x402 payment includes on-chain settlement and is legitimately
slow.

| Service   | Env var                        | Default | Covers                                                   |
| --------- | ------------------------------ | ------- | -------------------------------------------------------- |
| `http`    | `MINDVAULT_HTTP_TIMEOUT_MS`    | 15000   | MindVault API and the sponsored-account service          |
| `horizon` | `MINDVAULT_HORIZON_TIMEOUT_MS` | 15000   | Horizon account and balance reads                        |
| `soroban` | `MINDVAULT_SOROBAN_TIMEOUT_MS` | 20000   | Soroban RPC (`mindvault_tx_status`, registry transport)  |
| `payment` | `MINDVAULT_PAYMENT_TIMEOUT_MS` | 45000   | x402 paid fetches for `mindvault_buy` and publish verify |

Rules:

- Values are milliseconds.
- **`0` disables** the deadline for that service.
- A malformed or negative value falls back to the default rather than failing
  startup — a typo must not brick the server.
- Fractional values are floored.

### Checking the active budgets

`mindvault_network_profile` reports them, so an operator diagnosing a slow or
hanging tool does not have to inspect the environment:

```json
{
  "stellarNetwork": "testnet",
  "timeouts": "http=15000ms, horizon=15000ms, soroban=20000ms, payment=45000ms"
}
```

### Tuning

- **Self-hosted or cold-start backend** (a free-tier host can take >15s to wake):
  raise `MINDVAULT_HTTP_TIMEOUT_MS`.
- **Slow or rate-limited RPC provider**: raise `MINDVAULT_SOROBAN_TIMEOUT_MS`.
- **Congested network at settlement time**: raise `MINDVAULT_PAYMENT_TIMEOUT_MS`.
  Do not lower it below the default — aborting mid-settlement gives the agent an
  ambiguous result for a payment that may still land on-chain.

### Per-tool overrides

Budgets are per **service**, which is the right granularity for most
deployments and the wrong one for a few specific tools. `mindvault_publish` and
`mindvault_register_onchain` do markedly more work than a catalog read, yet all
three sit under the same `http` budget. Raising `MINDVAULT_HTTP_TIMEOUT_MS` to
accommodate the slow ones also makes every quick call wait four times as long
before giving up — the opposite of what a deadline is for.

`MINDVAULT_TOOL_TIMEOUTS` overrides the budget for named tools only:

```
MINDVAULT_TOOL_TIMEOUTS="mindvault_publish=120000,mindvault_browse=5000"
```

Every tool not named there keeps its service budget.

| Aspect            | Behaviour                                                                    |
| ----------------- | ---------------------------------------------------------------------------- |
| Format            | `tool=milliseconds`, separated by commas or whitespace                       |
| Tool name         | The `mindvault_` prefix is optional — `publish=120000` works                 |
| `0`               | Disables the deadline for that tool, exactly as it does for a service budget |
| Precedence        | A per-tool override always wins over the service budget                      |
| Duplicate entries | The last one wins, so a list can be built by appending                       |
| Malformed entry   | Reported and skipped; the remaining entries still apply                      |

In a client config:

```json
{
  "mcpServers": {
    "mindvault": {
      "command": "node",
      "args": ["/absolute/path/to/mindvault/mcp/dist/index.js"],
      "env": {
        "MINDVAULT_TOOL_TIMEOUTS": "mindvault_publish=120000,mindvault_buy=90000"
      }
    }
  }
}
```

A malformed entry never stops the server from starting. An MCP server that
refuses to launch over a typo in an optional tuning variable is worse than one
that runs with a default, so `publish=oops,browse=5000` applies the `browse`
override and reports the bad entry.

Note the failure this cannot catch on its own: `mindvault_publsh=120000` parses
perfectly and applies to nothing. Validate override names against the real tool
list (`unknownToolNames`) rather than assuming a parsed entry took effect.

#### Which tools are worth overriding

- **`mindvault_publish` / `mindvault_register_onchain`** — metadata upload plus
  an on-chain registration. Raise these rather than the `http` budget.
- **`mindvault_buy`** — already on the generous `payment` budget; override only
  if your settlement path is unusually slow.
- **`mindvault_browse` / `mindvault_search`** — catalog reads. Lowering these
  makes an unresponsive backend surface quickly instead of stalling the agent.

### Coverage

- [`mcp/src/httpTimeout.test.ts`](../mcp/src/httpTimeout.test.ts) — budget
  resolution and the abort path, driven with fake timers
- [`mcp/src/toolTimeouts.test.ts`](../mcp/src/toolTimeouts.test.ts) — real tools
  failing fast against a deliberately slow (never-answering) fetch
- [`mcp/src/toolTimeoutOverrides.test.ts`](../mcp/src/toolTimeoutOverrides.test.ts)
  — per-tool override parsing, precedence, and malformed-entry handling

## Retries

A single dropped connection or a 503 from a cold-starting backend used to fail a
whole tool call, leaving the agent to decide whether retrying was safe. For reads
it usually is, so idempotent calls now retry automatically.

Implementation: [`mcp/src/retry.ts`](../mcp/src/retry.ts).

### What retries, and what never does

| Call                                                    | Retried | Why                                                   |
| ------------------------------------------------------- | ------- | ----------------------------------------------------- |
| `GET` / `HEAD` on the MindVault API                     | yes     | Safe to replay                                        |
| Horizon account and balance reads                       | yes     | Safe to replay                                        |
| Soroban `getTransaction`                                | yes     | A read, despite being an HTTP POST                    |
| `POST` / `PUT` / `PATCH` / `DELETE` on the API          | **no**  | May create a resource or trigger server-side work     |
| **x402 paid fetches** (`mindvault_buy`, publish verify) | **no**  | A replay could sign and settle a second USDC transfer |

Payments are excluded by construction rather than by a status check: retrying is
opt-in per call site, and the payment path never opts in.

### Policy

| Setting    | Env var                         | Default | Meaning                                     |
| ---------- | ------------------------------- | ------- | ------------------------------------------- |
| attempts   | `MINDVAULT_RETRY_ATTEMPTS`      | 3       | Total attempts including the first          |
| base delay | `MINDVAULT_RETRY_BASE_DELAY_MS` | 250     | Delay before the first retry, then doubling |
| max delay  | `MINDVAULT_RETRY_MAX_DELAY_MS`  | 4000    | Ceiling applied before jitter               |

- **Bounded** — a fixed attempt cap and delay ceiling, so a failing dependency
  degrades into a slightly slower error, never an unbounded stall.
- **Jittered** — delays use _full jitter_, a uniform draw from `[0, capped]`, so
  concurrent agents do not retry in lockstep against a struggling service.
- `MINDVAULT_RETRY_ATTEMPTS=1` disables retrying entirely.
- A malformed value falls back to the default rather than failing startup.

Retried conditions: transport failures (`fetch failed`, `ECONNREFUSED`,
`ECONNRESET`, `ENOTFOUND`, `socket hang up`, …), request timeouts, and HTTP
408, 425, 429, 500, 502, 503, 504. A caller-initiated abort is never retried —
the caller asked to stop. Client errors (400, 401, 402, 403, 404, 409, 422) are
not retried because retrying cannot fix them.

#### Deterministic failures stop at the first attempt

A failure that describes the request itself fails the same way on every
attempt, so retrying it only delays the error by the whole backoff schedule
(and, for a rejected credential, presents it to the API again).
[`isRetryableError`](../mcp/src/retry.ts) decides in this order, and the first
match wins:

| Failure                                                                                                   | Attempts  | Backoff   |
| --------------------------------------------------------------------------------------------------------- | --------- | --------- |
| Caller abort (`AbortError`)                                                                               | 1         | none      |
| Request deadline (`TimeoutError`)                                                                         | all       | jittered  |
| `ToolValidationError`, `UnknownToolError`, `ResponseSizeLimitError`, `SyntaxError` (malformed input/body) | 1         | none      |
| Mapped error with an HTTP status: retryable set above, otherwise not (401/403 → `auth`, 400/422 …)        | by status | by status |
| Mapped `auth`, `validation`, `payment`, `not_found`, `conflict`, `contract` category                      | 1         | none      |
| Mapped `network`, `timeout`, `rate_limit`, `server` category                                              | all       | jittered  |
| Error carrying `status` / `statusCode` / `response.status`                                                | by status | by status |
| Soroban contract or host error (`Error(Contract, #n)`, `Error(Auth, …)`, `HostError`)                     | 1         | none      |
| Socket `errno` code (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, `EPIPE`, …)     | all       | jittered  |
| Transport message (`fetch failed`, `network error`, `socket hang up`, `timed out`) or such a `cause`      | all       | jittered  |
| Anything else                                                                                             | 1         | none      |

The message check is deliberately narrow. It used to match any `network` or
`timeout` substring, so a contract's `NetworkIdMismatch`, a host
`Error(Auth, …)` mentioning the network, or an argument error about a timeout
value was replayed as if the connection had dropped. The category or status of
a mapped error is now checked before its text, so an `auth` failure whose
guidance mentions the network is not retried either.

With the default policy a deterministic failure makes one request and sleeps
not at all; a transient one makes `MINDVAULT_RETRY_ATTEMPTS` requests with the
jittered backoff above. `mcp/src/retryClassification.test.ts` pins both, per
failure kind, and `mcp/src/toolRetries.test.ts` checks the request count per
HTTP status through `mindvault_browse` and `mindvault_tx_status`.

When a server sends `Retry-After`, it is honoured in place of computed backoff,
clamped to the max delay so a mistaken or hostile header cannot stall a call.

#### Retry-After forms and clamping

`Retry-After` arrives in one of two forms and both are understood
([`parseRetryAfterMs`](../mcp/src/retry.ts)):

- **delay-seconds** — a non-negative number of seconds, e.g. `Retry-After: 30`.
- **HTTP-date** — an absolute timestamp, e.g.
  `Retry-After: Thu, 01 Jan 2026 00:00:00 GMT`. A date already in the past
  becomes `0`, so the retry proceeds immediately.

Anything else (a missing header, an empty string, or an unparseable value like
`soon`) is ignored and the caller falls back to computed backoff. The parsed
delay is then clamped to `min(maxDelayMs, deadline)` by
[`retryAfterDelay`](../mcp/src/retry.ts), so a hostile `Retry-After: 999999` or
a date years in the future can only ever hold a call for the configured
maximum — never an unbounded stall.

#### Shared per-origin backoff for parallel calls

A single MCP server can have several tool calls in flight at once. Without
coordination, when one call is told to slow down (`429 Too Many Requests`), an
unrelated call to the same origin keeps retrying into the same window and the
server is hit again by every caller at once.

[`mcp/src/rateLimitCoordinator.ts`](../mcp/src/rateLimitCoordinator.ts) keeps
one shared "not before" deadline per origin:

- A call that sees a `429` records the `Retry-After` delay it was given
  (`noteRateLimit`). A `429` without a `Retry-After` records nothing — the
  caller's own bounded backoff still applies.
- Every call awaits that deadline before its next attempt (`acquire`), via the
  `beforeAttempt` hook in `withRetry`.
- Origins are independent: a backoff on `api.mindvault.io` never blocks a call
  to `horizon.stellar.org`.
- The recorded delay is clamped to a 60s ceiling, and the deadline only ever
  moves forward, so two concurrent `429`s cannot shorten each other's wait.
- `acquire` takes an `AbortSignal` and rejects promptly on cancellation, so a
  wait never outlives the tool call that started it.

### Polling that outlives a failed request

`mindvault_publish_status` with `wait: true` reads `/resources/:id/meta` and
`/resources/:id/verification` on every poll, each with the retry policy above.
When one of them still fails after its last attempt, the poll fails and the tool
returns an error — unless the other endpoint already reported a terminal
`verificationStatus` (`verified`, `rejected`, or `skipped`). Both endpoints
read the same status, and a settled status never returns to `pending`, so that
poll has settled: polling stops there and the snapshot reports the terminal
status. Fields only the failed endpoint carries come back `null` — the
`verification` details when `/verification` failed, `onchainStatus` and
`onchainTxHash` when `/meta` did.

### A submitted transaction that cannot be confirmed

Registry mutations (`mindvault_update_metadata`, `mindvault_set_price`,
`mindvault_transfer_ownership`, `mindvault_set_listed`, `mindvault_accept_transfer`,
`mindvault_cancel_transfer`) and the `register_batch` step of `mindvault_publish_batch`
sign a transaction, submit it with `sendTransaction`, then poll `getTransaction`
until it lands. A submit is never retried. It is not idempotent, and a second
submit would be a second transaction.

All of these mutations go through `signAndSendTracked` (in
[`mcp/src/submittedTransaction.ts`](../mcp/src/submittedTransaction.ts)), which
captures the transaction hash the moment `sendTransaction` returns via the SDK's
`onSubmitted` hook. This is the single entry point for all anchor retry paths:
manual retries (an agent calling the tool again after a failure) and automatic
retries (the SDK's own internal polling) are both bounded by the same submitted-hash
invariant. Neither path can bypass it.

If the poll times out, or the RPC goes away after the network accepted the
transaction, the outcome is unknown but the transaction hash is known. The tool
does not report a failure, because an agent would answer a failure by
submitting again. It returns the hash with a lookup the agent can repeat
safely (#1060):

```json
{
  "status": "submitted",
  "resourceId": "cm7x8y9z",
  "price": "2.5",
  "txHash": "c0ffee…",
  "confirmed": false,
  "reason": "rpc_unavailable",
  "statusLookup": {
    "tool": "mindvault_tx_status",
    "arguments": { "txHash": "c0ffee…" },
    "retryable": true
  },
  "message": "Set price: Transaction c0ffee… was submitted but its status could not be read from the RPC. Do not resubmit — call mindvault_tx_status with this txHash (safe to repeat) until it reports SUCCESS or FAILED."
}
```

- `reason` is `confirmation_timeout` when the poll deadline passed with the
  transaction still `NOT_FOUND`, and `rpc_unavailable` when the RPC failed
  mid-poll.
- `mindvault_publish_batch` returns its usual summary with
  `onchainStatus: "submitted"`, each approved item's `onchainStatus` set to
  `"submitted"`, the `txHash`, and the same `statusLookup`. The items were
  already created and paid for, so they are reported instead of discarded.
- `mindvault_set_tags` is text-only. Its text names the hash and says to check
  it with `mindvault_tx_status`.
- A confirmed transaction still returns `status: "success"`. A transaction the
  network rejected, or an RPC that was down before submit, still fails as
  before. In those cases nothing was submitted, so retrying is safe.

The hash is captured from the SDK's `onSubmitted` hook in
[`mcp/src/submittedTransaction.ts`](../mcp/src/submittedTransaction.ts). The
`status`, `confirmed`, `reason`, `statusLookup`, and `message` fields are part
of the advertised output schemas.

### Observability

Each retry writes one greppable line to stderr:

```text
MindVault MCP: retrying GET /resources — attempt 2/3 failed (HTTP 503); next attempt in 312ms
```

`mindvault_network_profile` reports the active policy:

```json
{ "retries": "attempts=3, baseDelay=250ms, maxDelay=4000ms, jitter=full" }
```

### Coverage

- [`mcp/src/retry.test.ts`](../mcp/src/retry.test.ts) — bounds, backoff, jitter,
  `Retry-After` (both forms, invalid, past, and extreme values), and the
  retry-log format, with sleep and randomness injected
- [`mcp/src/rateLimitCoordinator.test.ts`](../mcp/src/rateLimitCoordinator.test.ts)
  — shared per-origin backoff: parallel `429`s coordinate, the wait is bounded,
  unrelated origins stay unblocked, and cancellation is prompt
- [`mcp/src/toolRetries.test.ts`](../mcp/src/toolRetries.test.ts) — real tools
  recovering from transient failures, and payments issued exactly once
- [`mcp/src/submittedTransaction.test.ts`](../mcp/src/submittedTransaction.test.ts)
  and [`mcp/src/tools/publishBatchUnconfirmed.test.ts`](../mcp/src/tools/publishBatchUnconfirmed.test.ts) —
  RPC loss and poll timeout after submit, run through the SDK's own
  `SentTransaction`, return the hash and a `mindvault_tx_status` lookup
  instead of an error
- [`mcp/src/tools/anchorRetry.test.ts`](../mcp/src/tools/anchorRetry.test.ts) —
  all six single-resource registry mutations (`update_metadata`, `set_price`,
  `transfer_ownership`, `set_listed`, `accept_transfer`, `cancel_transfer`)
  exhausted through both entry points (submitted-but-unconfirmed and confirmed):
  every unconfirmed path returns `status: "submitted"` with the hash and
  `statusLookup`, never resubmits, and the confirmed path returns
  `status: "success"` with `txPhase: "settled"`
- [`mcp/src/publishStatusRetry.test.ts`](../mcp/src/publishStatusRetry.test.ts) —
  `mindvault_publish_status` stopping at a terminal status while a companion
  request exhausts its retries

## Transaction wait policy

A submitted Soroban transaction is not settled the moment the submit call
returns — it still has to be included and committed on-chain. `mindvault_buy`
lets the caller choose how long to wait before it hands back the purchase
summary ([#1058](../mcp/src/settlement.ts)).

| Policy                  | Behaviour                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `return-after-submit`   | Default. Return as soon as the payment response arrives, reporting the tx hash and any status. |
| `wait-for-final-result` | Poll `getTransaction` until the transaction reaches a terminal status or the deadline passes.  |

- Pass `waitPolicy: "wait-for-final-result"`, or the legacy shorthand
  `wait: true`, to poll. `waitPolicy` wins when both are supplied.
- `timeoutMs` (default 60000) and `intervalMs` (default 2000) bound the wait.
  `timeoutMs` is clamped to a hard 300000 ms ceiling, so no caller can ask for
  an unbounded wait.
- Every result carries `txHash` and a `status` — `status` is `null` only when no
  status could be read, never omitted — plus a `waitPolicy` describing which
  behaviour ran and a `cancelled` flag set when an `AbortSignal` ended the wait
  early.
- The wait is cancellable: `pollSettlement` accepts an `AbortSignal` and
  returns a `cancelled` result promptly rather than waiting out the interval.

### Coverage

- [`mcp/src/settlement.test.ts`](../mcp/src/settlement.test.ts) — policy
  normalization, the legacy `wait: true` mapping, the bounded maximum wait,
  cancellation, and the always-present `txHash`/`status` fields.
