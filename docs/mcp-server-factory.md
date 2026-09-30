# MCP Server Factory

Issue [#575](https://github.com/mind-vault-1/mindvault/issues/575).

`index.ts` built its `Server`, registered four request handlers, constructed a
`StdioServerTransport` and connected — all at module scope, guarded by
`if (!process.env.VITEST)`. That guard was the tell: the only way to import the
server without also starting a stdio transport was to pretend to be the test
runner.

`serverFactory.ts` separates the three things that were fused: **building** a
configured server, **connecting** it to a transport, and **shutting it down**.

## Why it matters

| Before                                              | After                                                           |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Only stdio could host the server                    | Any transport the SDK accepts                                   |
| Tests mocked the SDK and never exercised the wiring | Tests drive a real `Server` and `Client` over an in-memory pair |
| Shutdown called `process.exit` unconditionally      | The host decides; `exitOnShutdown` opts into the old behaviour  |
| One instance per process                            | Independent instances can run side by side                      |

## Building

```ts
import { createMindVaultServer } from "./serverFactory.js";

const server = createMindVaultServer({
  listTools: () => advertisedTools,
  dispatchTool: (name, args, onProgress) => dispatchTool(name, args, onProgress),
  listPrompts: () => promptSummaries,
  getPrompt,
  structuredResult,
  formatError: safeErrorMessage,
  errorContent: troubleshootingFor,
  createProgressEmitter: (token, send) => createProgressEmitter({ token, send }),
});
```

`createProgressEmitter` may return the pending send. The factory scopes it to
the call and waits for every send it started before returning the result, and
drops anything emitted later, so no progress notification follows the result
(see [mcp-progress-notifications.md](mcp-progress-notifications.md#delivery-order)).

Construction has **no side effects**. The returned server is inert until
something calls `connect`, which is what makes it usable from a test or an
embedding host without a guard to work around.

Behaviour is injected rather than imported from `index.ts`. Importing the
entrypoint would execute it — the problem this exists to solve.

`listPrompts` and `getPrompt` go together; supplying one without the other
throws at construction rather than failing on the first request. Prompt
capability is advertised only when prompts are supplied.

## Starting

```ts
import { startServer } from "./serverFactory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const running = await startServer(server, new StdioServerTransport(), {
  onShutdown: () => saveState(),
  handleSignals: true,
  exitOnShutdown: true,
});
```

| Option           | Default | Effect                                                                           |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| `onShutdown`     | none    | Runs before close — persist state, flush a log                                   |
| `onExit`         | none    | Runs after close                                                                 |
| `handleSignals`  | `false` | Wire SIGINT/SIGTERM. Off by default — a library must not grab them from its host |
| `exitOnShutdown` | `false` | `process.exit` with the conventional codes (130 on SIGINT)                       |

Transport close, transport error, signals and an explicit `running.shutdown()`
all funnel into one shutdown that runs **at most once**. A transport error
during shutdown would otherwise re-enter and double-run the hooks. A throwing
`onShutdown` hook does not prevent the close.

## Testing against it

The reason this shape is worth having:

```ts
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });

await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const result = await client.callTool({ name: "mindvault_browse", arguments: {} });
```

A real session, no mocked SDK.

## Adding a transport

Nothing in `serverFactory.ts` imports a transport — a test asserts that, since
re-introducing a stdio import would make it transport-agnostic in name only. A
new transport costs a call site:

```ts
const running = await startServer(server, new SSEServerTransport("/messages", res));
```

## Correlation IDs

Every tool call the factory dispatches runs under a fresh correlation ID
(see [mcp-correlation-ids.md](mcp-correlation-ids.md)), stamped on the audit
entries the call produces and attached to the result's `_meta`.

## Coverage

- [`mcp/src/serverFactory.test.ts`](../mcp/src/serverFactory.test.ts) — tools,
  prompts, errors and correlation IDs over a real in-memory MCP session, plus
  the shutdown lifecycle and the transport-independence guard
