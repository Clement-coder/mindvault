# MCP Timeouts and Retries

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
`ENOTFOUND`, …), request timeouts, and HTTP 408, 425, 429, 500, 502, 503, 504.
A caller-initiated abort is never retried — the caller asked to stop. Client
errors (400, 401, 402, 403, 404, 409, 422) are not retried because retrying
cannot fix them.

When a server sends `Retry-After`, it is honoured in place of computed backoff,
clamped to the max delay so a mistaken or hostile header cannot stall a call.

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
  `Retry-After`, and the retry-log format, with sleep and randomness injected
- [`mcp/src/toolRetries.test.ts`](../mcp/src/toolRetries.test.ts) — real tools
  recovering from transient failures, and payments issued exactly once
- [`mcp/src/publishStatusRetry.test.ts`](../mcp/src/publishStatusRetry.test.ts) —
  `mindvault_publish_status` stopping at a terminal status while a companion
  request exhausts its retries
