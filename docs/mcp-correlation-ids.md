# MCP Correlation IDs

Issue [#572](https://github.com/mind-vault-1/mindvault/issues/572).

The audit log records a tool call as several independent entries: a `start`,
every network request the tool made, and a `success` or `error`. Nothing tied
them together. With one agent making one call at a time you can read the order
and guess; with two concurrent calls, or a log covering a whole session,
"which of these four Horizon requests belonged to the purchase that failed?"
was unanswerable.

Every tool call now runs under a correlation ID.

## Shape

```
mv-1a2b3c4d-e5f6
│  │        └── random, base36, fixed width
│  └── timestamp, base36 — sorts chronologically as a string
└── prefix, so it is recognisable in a mixed log
```

Short on purpose: it is meant to be read aloud, pasted into an issue, and typed
into a `grep`.

## Where it appears

**On every audit entry** produced during the call, including the network
requests made underneath it:

```
$ jq -c 'select(.correlationId == "mv-1a2b3c4d-e5f6")' audit.jsonl
{"timestamp":"…","toolName":"mindvault_buy","status":"start","correlationId":"mv-1a2b3c4d-e5f6"}
{"timestamp":"…","method":"GET","endpoint":"…","source":"api","correlationId":"mv-1a2b3c4d-e5f6"}
{"timestamp":"…","toolName":"mindvault_buy","status":"error","correlationId":"mv-1a2b3c4d-e5f6"}
```

**In the tool result's `_meta`**, under `mindvault/correlationId` — the key MCP
reserves for out-of-band annotation:

```json
{
  "content": [{ "type": "text", "text": "…" }],
  "_meta": { "mindvault/correlationId": "mv-1a2b3c4d-e5f6" }
}
```

It is deliberately **not** appended to the text the agent reads. That would
change every tool's output and put an opaque token in front of the model on
every successful call, for no benefit.

**In the error text**, on failures only:

```
Error: Payment failed: insufficient balance [correlation: mv-1a2b3c4d-e5f6]
```

A failure is the one case where a human is likely to quote the ID back, so it
needs to be somewhere they can see it.

## Concurrency

The ID lives in an `AsyncLocalStorage`, not a module-level variable.

The server handles tool calls concurrently. A shared mutable "current ID" would
attribute one call's network requests to another — producing a log that _looks_
correct, which is worse than having no IDs at all. Each call gets its own
context, and it survives `await` boundaries and nested helpers.

Outside a tool call there is no ID and the field is omitted, rather than filled
with a placeholder. An entry with no ID is honest about not belonging to a
call.

## Using it from a tool

Nothing to do — the server factory mints the ID and audit logging picks it up
from the ambient context. Code that needs it explicitly can ask:

```ts
import { currentCorrelationId } from "./correlation.js";

const id = currentCorrelationId(); // undefined outside a tool call
```

To correlate work that is not a tool call (a background refresh, a startup
check), wrap it:

```ts
import { withNewCorrelationId } from "./correlation.js";

await withNewCorrelationId(async (id) => {
  // every audit entry in here carries `id`
});
```

## Coverage

- [`mcp/src/correlation.test.ts`](../mcp/src/correlation.test.ts) — ID format
  and determinism, context propagation across `await`, isolation between
  concurrent calls, and audit-log stamping
- [`mcp/src/serverFactory.test.ts`](../mcp/src/serverFactory.test.ts) — the ID
  attached to a real MCP result over an in-memory session
