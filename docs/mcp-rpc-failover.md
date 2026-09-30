# MCP Soroban RPC Failover

Issue [#588](https://github.com/mind-vault-1/mindvault/issues/588).

`SOROBAN_RPC_URL` names exactly one endpoint. When that endpoint is down,
rate-limiting, or slow enough to blow the request budget, every on-chain tool
in the server fails — `mindvault_registry_lookup`, `mindvault_tx_status`,
`mindvault_check_consistency` — even though other public providers are serving
the same network perfectly well.

Retries do not help here. The existing retry policy re-sends the same request to
the same dead host; three attempts against an unreachable endpoint is three
times the latency and the same failure.

## Configuration

| Variable                              | Default   | Description                                                      |
| ------------------------------------- | --------- | ---------------------------------------------------------------- |
| `MINDVAULT_SOROBAN_RPC_URLS`          | unset     | Comma- or whitespace-separated endpoints, highest priority first |
| `MINDVAULT_RPC_FAILOVER_COOLDOWN_MS`  | `30000`   | How long a failed endpoint is skipped                            |
| `MINDVAULT_RPC_FAILOVER_MAX_ATTEMPTS` | `0` (all) | Cap on endpoints tried for a single call                         |

```json
{
  "mcpServers": {
    "mindvault": {
      "command": "node",
      "args": ["/absolute/path/to/mindvault/mcp/dist/index.js"],
      "env": {
        "MINDVAULT_SOROBAN_RPC_URLS": "https://soroban-testnet.stellar.org,https://rpc.example.org"
      }
    }
  }
}
```

With nothing configured the behaviour is unchanged: `SOROBAN_RPC_URL` (or the
network preset behind it) becomes a one-endpoint list.

When both are set, the single `SOROBAN_RPC_URL` is promoted to the front of the
list unless it is already there — an operator who pinned a primary and then
added alternates should not silently lose the pin.

## What fails over, and what does not

This is the distinction the whole feature rests on.

| Condition                                             | Behaviour               |
| ----------------------------------------------------- | ----------------------- |
| Connection refused / reset / DNS failure              | Try the next endpoint   |
| Request timeout (`MINDVAULT_SOROBAN_TIMEOUT_MS`)      | Try the next endpoint   |
| HTTP 408, 425, 429, 500, 502, 503, 504                | Try the next endpoint   |
| HTTP 400, 401, 403, 404, 409, 422                     | **Return immediately**  |
| A `SyntaxError`, `RangeError`, or other program error | **Rethrow immediately** |

A 5xx or a dropped connection means _this host cannot answer_ and is worth
asking someone else. A 400 means the **request** is wrong; asking a second host
produces the same 400 more slowly.

## Endpoint health

A failed endpoint is parked, not blacklisted:

- After a failure it is skipped for `MINDVAULT_RPC_FAILOVER_COOLDOWN_MS`.
- After the cooldown it is quietly tried again, so a provider that recovers is
  used without restarting the server.
- An endpoint that answers is un-parked immediately.
- Parked endpoints move to the **end** of the attempt order rather than being
  dropped: if every healthy host fails mid-call, a parked one is still better
  than nothing.
- When every endpoint is parked, the primary is used anyway. Refusing to make a
  call because the whole world was recently unhealthy would turn a transient
  outage into a self-inflicted one.

The order is stable — endpoints are tried in the order configured and the first
healthy one is preferred, not a random or round-robin pick — so the primary
stays the primary and reproducing a problem does not depend on which host a
request happened to land on.

## Checking the active configuration

`describeFailover` renders the chain for `mindvault_network_profile`:

```
https://rpc-a.example → https://rpc-b.example [cooling down] (cooldown=30000ms, maxAttempts=all)
```

## Choosing alternates

- Alternates must serve the **same network**. A mainnet RPC in a testnet list
  produces confidently wrong answers rather than errors; the startup
  cross-check catches `SOROBAN_RPC_URL` but cannot see into the list.
- Put the endpoint with the highest rate limit first. Failover is for outages,
  not for load-spreading — the primary takes essentially all the traffic.
- Two endpoints behind the same provider fail together. Prefer independent
  operators.

## Coverage

- [`mcp/src/rpcFailover.test.ts`](../mcp/src/rpcFailover.test.ts) — endpoint
  parsing, failure classification, cooldown behaviour, and attempt ordering
  against a controllable clock
