/**
 * MCP integration test harness.
 *
 * Wires the real MindVault MCP `Server` to an SDK `Client` over an in-memory
 * transport so tests exercise `listTools` / `callTool` through the request
 * interface — not by calling helper functions directly.
 *
 * External HTTP and registry lookups are expected to be mocked by the caller
 * (typically `MINDVAULT_MOCK=1` before importing `./index.js`, which activates
 * the in-process fixtures in `mock.ts`).
 *
 * Error handling contract (deterministic, agent-safe):
 * - Tool failures return `{ isError: true, content: [{ type: "text", text }] }`
 * - Failure text is always prefixed with `Error:` and never includes secrets
 *   (see `safeErrorMessage` in `redaction.ts`)
 * - Unknown tools produce `Error: Unknown tool: <name>`
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** Flatten MCP tool result text content into a single trimmed string. */
export function harnessResultText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result.content ?? [])
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
}

/** Machine-readable MCP `structuredContent` object, or undefined. */
export function harnessStructuredContent(result: {
  structuredContent?: unknown;
}): Record<string, unknown> | undefined {
  const payload = result.structuredContent;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

/** True when the MCP result is flagged as an error or carries the Error: marker. */
export function harnessIsToolError(result: {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}): boolean {
  if (result.isError) return true;
  return /^Error:/m.test(harnessResultText(result));
}

export interface IntegrationHarness {
  client: Client;
  server: Server;
  /** List tools via the SDK request interface. */
  listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }>;
  /** Call a tool via the SDK request interface. */
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  }>;
  /** List catalog resources via the SDK request interface. */
  listResources(): Promise<{
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  }>;
  /** Read one catalog resource via the SDK request interface. */
  readResource(uri: string): Promise<{
    contents: Array<{ uri: string; text?: string; mimeType?: string; blob?: string }>;
  }>;
  /** Close client and server transports. */
  close(): Promise<void>;
}

/**
 * Connect a linked in-memory client/server pair to the given MindVault MCP
 * server instance (already wired with ListTools / CallTool handlers).
 */
export async function startIntegrationHarness(server: Server): Promise<IntegrationHarness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "mindvault-integration", version: "1.0.0" },
    { capabilities: {} },
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    listTools: () => client.listTools(),
    callTool: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return result as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
        [key: string]: unknown;
      };
    },
    listResources: () => client.listResources(),
    readResource: (uri) => client.readResource({ uri }),
    close: async () => {
      await client.close().catch(() => {});
      // Server.close is optional on some SDK versions; ignore if absent.
      const maybeClose = (server as { close?: () => Promise<void> }).close;
      if (typeof maybeClose === "function") await maybeClose.call(server).catch(() => {});
    },
  };
}
