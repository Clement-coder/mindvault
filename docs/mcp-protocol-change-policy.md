# MCP Protocol Change Policy

This policy applies to changes to the MCP server's client-visible contract:

- advertised tools, their names, descriptions, input schemas, output schemas,
  annotations, and result/error shapes;
- prompts and their arguments or returned messages;
- resources, their URIs, content types, subscriptions, and update notifications;
- protocol capabilities, initialization behavior, and transport behavior.

It does not apply to internal implementation changes that leave those contracts
unchanged. The MCP server currently uses the official TypeScript SDK and exposes
stdio as its package entry point. Its live surface is registered in
[`mcp/src/index.ts`](../mcp/src/index.ts); the reusable server factory is in
[`mcp/src/serverFactory.ts`](../mcp/src/serverFactory.ts).

## Compatibility rules

Treat clients as depending on every field and behavior the server advertises.
Keep compatible changes additive and preserve existing names and meanings.

| Change | Compatibility | Release guidance |
| --- | --- | --- |
| Add an optional tool argument, tool, prompt, or resource | Usually compatible | Document it and cover it in tests. |
| Add an optional output field or a new documented error category | Usually compatible, but validate against clients that enforce schemas | Update output schemas and success/error contract tests. |
| Change a tool's side effects, payment behavior, required confirmation, or meaning | Breaking behavioral change | Update annotations and safety/confirmation tests; treat as major. |
| Rename/remove a tool or resource URI, make an optional argument required, or change a field's type/meaning | Breaking | Treat as major and document migration steps. |
| Change initialization, advertised capabilities, transport, or protocol-version behavior | Potentially breaking | Verify against the relevant MCP specification and supported clients; treat as major if existing clients must change. |

A change is not compatible merely because TypeScript still compiles. MCP clients
consume JSON schemas and annotations at runtime and may reject results that do
not match the advertised contract.

### Example: adding a tool argument

Suppose `mindvault_browse` gains an optional `sort` argument. Keep calls without
that argument valid, advertise its enum in `inputSchema`, validate it in
`mcp/src/validation.ts`, and cover both the omitted and supplied forms in tests.
Update the tool argument guide and generated tool reference, then run:

```bash
pnpm --filter @mindvault/mcp test
pnpm --filter @mindvault/mcp check-tool-docs
pnpm --filter @mindvault/mcp build
pnpm --filter @mindvault/mcp smoke:install
```

If `sort` were required or changed the existing default ordering, that could
break clients or alter results they rely on. Make the compatibility impact
explicit in the release notes and use a major version when clients need to
change.

## Review and verification

For every client-visible protocol change:

1. Identify the affected request/result contract and cite the applicable
   canonical MCP specification section in the PR description or code comments.
2. Update the source definitions and validation together. Keep advertised tool
   schemas, handler results, output schemas, and annotations consistent.
3. Add or update contract tests that exercise the MCP SDK client/server path,
   including an error result when output shape or error behavior changes.
4. Regenerate committed tool documentation when tool names or descriptions
   change, then run `pnpm --filter @mindvault/mcp check-tool-docs`.
5. Run the MCP package tests, build, and install smoke test. For release
   candidates, also run the mock end-to-end smoke test from the
   [publish checklist](mcp-publish-checklist.md).
6. Document whether the change is compatible, any client migration needed, and
   any operational change such as new capabilities, transport requirements,
   payment behavior, or confirmation requirements.

The repository-wide `make validate` also runs `pnpm run docs:links`, which checks
repo-local Markdown links. The PR workflow separately runs the MCP generated-doc
check and install smoke test.

## Canonical references

Use the MCP specification version and section that match the behavior being
changed. MindVault currently relies on the stable 2025-06-18 specification for
tool structured output; the protocol's published specification index is the
source for the current and prior versions.

- [MCP specification](https://modelcontextprotocol.io/specification/)
- [Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [Prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts)
- [Basic lifecycle and initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

For the actual MindVault contracts and workflows, see the
[tool argument contract](mcp-tool-arguments.md),
[tool annotations and side effects](mcp-tool-annotations.md),
[structured output contract](mcp-structured-output.md),
[server architecture](mcp-architecture.md), and
[smoke test guide](mcp-smoke-test.md).
