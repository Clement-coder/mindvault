# MCP Progress Notifications

Some MindVault tools take long enough that an agent client looks hung while it
waits. Those tools stream MCP `notifications/progress` updates so the client can
render a progress indicator instead of a blank spinner.

## How a client opts in

Progress is opt-in per request. A client that wants updates sends a progress
token in the request metadata:

```json
{
  "method": "tools/call",
  "params": {
    "name": "mindvault_publish_status",
    "arguments": { "resourceId": "cm7x8y9z", "wait": true },
    "_meta": { "progressToken": "publish-1" }
  }
}
```

The server then emits notifications carrying that token:

```json
{
  "method": "notifications/progress",
  "params": {
    "progressToken": "publish-1",
    "progress": 2,
    "total": 31,
    "message": "Verification pending — poll 2, still waiting."
  }
}
```

Without a `progressToken` the tool behaves exactly as before — no notifications
are sent, and the final result is unchanged. `progress` increases with every
notification, as the MCP spec requires.

## Delivery order

Every progress notification for a call is sent **before** that call's result,
and none is sent after it. A notification belongs to the request that carried
its token: once the result is out, some transports have already closed that
request's stream (Streamable HTTP ends the SSE response) and drop a later
notification without an error, and the client has stopped listening for the
token. An update that arrived after the result would never be shown, so a long
publish would look hung right up to its result.

The server enforces this per call with `scopeProgressToRequest` in
[`mcp/src/progress.ts`](../mcp/src/progress.ts). Before the tool result is
returned — success or error — the call handler waits for any notification still
being written, then closes the scope, so an update a tool emits afterwards (a
fire-and-forget call, or a callback that outlives the tool) is dropped instead
of reaching the transport. Both the stdio entry point and servers built with
[`createMindVaultServer`](mcp-server-factory.md) do this.

## Publish verification (`mindvault_publish_status`)

Verification is asynchronous: a freshly published resource starts at
`verificationStatus: "pending"` and settles to `verified`, `rejected`, or
`skipped`. Calling `mindvault_publish_status` with `wait: true` polls until it
settles or `timeoutMs` elapses — the wait that most needs progress feedback.

One notification is emitted per poll:

| Situation                       | Message                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| Still pending, more polls to go | `Verification pending — poll 2, still waiting.`                 |
| Settled                         | `Verification verified after 3 polls.`                          |
| Wait window elapsed             | `Timed out after 5 polls — verification still pending.`         |
| `wait` not set (single check)   | `Verification pending — single check, pass wait: true to poll.` |

`total` is an estimate of how many polls fit in the wait window
(`ceil(timeoutMs / intervalMs) + 1`, so 31 for the defaults of 60000 ms and
2000 ms). If a run needs one more step than estimated — for example the extra
timeout update — `total` grows to match rather than letting `progress` exceed
it.

The final tool result is the usual publish-status snapshot, including
`attempts`, `settled`, and `timedOut`, so a client that ignores notifications
loses no information.

## Other tools that report progress

- `mindvault_buy` — validating the resource, submitting the x402 payment, and
  recording the purchase (4 steps).
- `mindvault_register_onchain` — preparing, signing, and submitting the registry
  transaction (3 steps).

## Related docs

- [resource-publish-lifecycle.md](resource-publish-lifecycle.md)
- [mcp-tool-arguments.md](mcp-tool-arguments.md)
- [mcp-timeouts-retries.md](mcp-timeouts-retries.md)
