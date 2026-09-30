/**
 * Transport-agnostic MCP server factory — issue #575.
 *
 * `index.ts` builds its `Server`, registers four request handlers, constructs a
 * `StdioServerTransport` and connects — all at module scope, guarded by
 * `if (!process.env.VITEST)`. That guard is the tell: the only way to import
 * the server without also starting a stdio transport is to pretend to be the
 * test runner.
 *
 * Consequences, in rough order of annoyance:
 *
 *  - Nothing else can host the server. An HTTP/SSE transport, an in-process
 *    transport for integration tests, or a second instance on a different
 *    profile all need the wiring that only runs under that guard.
 *  - Tests that want a real `Server` get one with no handlers registered, so
 *    they mock the SDK instead of exercising it.
 *  - Shutdown is bound to `process.exit`, which a host embedding the server
 *    cannot use.
 *
 * This module separates the three things that were fused: **building** a
 * configured server, **connecting** it to whatever transport the caller has,
 * and **shutting it down**. Nothing here imports a transport, so a new one
 * costs a call site rather than an edit to the entrypoint.
 *
 * It deliberately takes its behaviour by injection — the tool list, the
 * dispatcher, the prompts — rather than importing them from `index.ts`.
 * Importing the entrypoint would execute it, which is the problem this exists
 * to solve.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { attachCorrelationId, correlationSuffix, withNewCorrelationId } from "./correlation.js";
import { scopeProgressToRequest } from "./progress.js";

/** Anything the MCP SDK will accept in `server.connect`. */
export interface McpTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  close?: () => Promise<void> | void;
  [key: string]: unknown;
}

/** A tool as advertised in ListTools. */
export interface AdvertisedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** A prompt as advertised in ListPrompts. */
export interface AdvertisedPrompt {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
}

/** The result of resolving a prompt. */
export interface ResolvedPrompt {
  description: string;
  messages: unknown[];
}

/**
 * Progress callback handed to a tool that reports incremental progress. It may
 * return the pending send; the factory waits for it before sending the result.
 */
export type ProgressEmitter = (
  progress: number,
  total?: number,
  message?: string,
) => void | Promise<void>;

export interface ServerBehaviour {
  /** Tools to advertise. Called per ListTools so a dynamic surface is possible. */
  listTools: () => AdvertisedTool[];
  /** Run one tool and return its text result. */
  dispatchTool: (
    name: string,
    args: Record<string, unknown>,
    onProgress?: ProgressEmitter,
  ) => Promise<string>;
  /** Prompts to advertise. Omit for a server with none. */
  listPrompts?: () => AdvertisedPrompt[];
  /** Resolve one prompt. Required when `listPrompts` is supplied. */
  getPrompt?: (name: string, args: Record<string, string | undefined>) => ResolvedPrompt;
  /** Build the structured result for a tool, when it declares an output schema. */
  structuredResult?: (name: string, text: string) => Record<string, unknown> | undefined;
  /** Render a failure into agent-facing text. Defaults to the error message. */
  formatError?: (error: unknown) => string;
  /** Extra `structuredContent` to attach to a failure (troubleshooting hints). */
  errorContent?: (error: unknown) => Record<string, unknown> | undefined;
  /** Build a progress emitter from the request's progress token. */
  createProgressEmitter?: (
    token: string | number,
    sendNotification: (notification: unknown) => Promise<void> | void,
  ) => ProgressEmitter;
}

export interface ServerIdentity {
  name: string;
  version: string;
}

export const DEFAULT_IDENTITY: ServerIdentity = { name: "mindvault", version: "1.0.0" };

function defaultFormatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a configured MCP server with no transport attached.
 *
 * The returned server has every request handler registered and is inert until
 * something calls `connect`. That is the whole point: construction has no side
 * effects a test or an embedding host has to work around.
 *
 * Every tool call runs under a fresh correlation ID (#572), which is stamped on
 * the audit entries the call produces and attached to the result's `_meta`.
 */
export function createMindVaultServer(
  behaviour: ServerBehaviour,
  identity: ServerIdentity = DEFAULT_IDENTITY,
): Server {
  if (behaviour.listPrompts && !behaviour.getPrompt) {
    throw new Error("getPrompt is required when listPrompts is supplied");
  }

  const capabilities: Record<string, unknown> = { tools: {} };
  if (behaviour.listPrompts) capabilities.prompts = {};

  const server = new Server({ name: identity.name, version: identity.version }, { capabilities });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: behaviour.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any, extra: any) => {
    const { name, arguments: args = {} } = request.params;

    const token = request.params?._meta?.progressToken;
    // Settled before the result is returned, so a progress notification is
    // never sent after it (#841).
    const progress =
      token != null && behaviour.createProgressEmitter
        ? scopeProgressToRequest(behaviour.createProgressEmitter(token, extra?.sendNotification))
        : undefined;

    return withNewCorrelationId(async (correlationId) => {
      try {
        const text = await behaviour.dispatchTool(name, args, progress?.emit);
        const structured = behaviour.structuredResult?.(name, text);
        return attachCorrelationId(
          {
            content: [{ type: "text", text }],
            ...(structured ? { structuredContent: structured } : {}),
          },
          correlationId,
        );
      } catch (error) {
        const message = (behaviour.formatError ?? defaultFormatError)(error);
        const extraContent = behaviour.errorContent?.(error);
        // The ID goes into the error text as well as `_meta`: a failure is the
        // one case where a human is likely to quote it back.
        return attachCorrelationId(
          {
            content: [
              { type: "text", text: `Error: ${message}${correlationSuffix(correlationId)}` },
            ],
            isError: true,
            ...(extraContent ? { structuredContent: extraContent } : {}),
          },
          correlationId,
        );
      } finally {
        await progress?.settle();
      }
    });
  });

  if (behaviour.listPrompts) {
    const getPrompt = behaviour.getPrompt!;

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: behaviour.listPrompts!(),
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request: any) => {
      const { name, arguments: args = {} } = request.params;
      const resolved = getPrompt(name, args as Record<string, string | undefined>);
      return { description: resolved.description, messages: resolved.messages };
    });
  }

  return server;
}

export interface StartOptions {
  /**
   * Run before the server closes — persisting state, flushing a log.
   * Failures are swallowed: a shutdown hook must not prevent shutdown.
   */
  onShutdown?: (reason: string) => void | Promise<void>;
  /**
   * Called after the server has closed. Defaults to doing nothing, so an
   * embedding host keeps control of its own process. `exitOnShutdown` opts
   * into the entrypoint's `process.exit` behaviour instead.
   */
  onExit?: (reason: string) => void;
  /** Wire SIGINT/SIGTERM to shutdown. Off by default — a library must not. */
  handleSignals?: boolean;
  /** Exit the process once shutdown completes, with the conventional codes. */
  exitOnShutdown?: boolean;
}

/** A running server, with a single idempotent way to stop it. */
export interface RunningServer {
  server: Server;
  transport: McpTransport;
  /** Stop the server. Safe to call repeatedly and from several triggers at once. */
  shutdown: (reason: string) => Promise<void>;
  /** Whether shutdown has been started. */
  readonly stopped: boolean;
}

/**
 * Connect a server to a transport and manage its lifecycle.
 *
 * Transport close/error, signals and an explicit call all funnel into one
 * `shutdown`, which runs at most once — a transport error during shutdown
 * would otherwise re-enter and double-run the hooks.
 */
export async function startServer(
  server: Server,
  transport: McpTransport,
  options: StartOptions = {},
): Promise<RunningServer> {
  let stopped = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (stopped) return;
    stopped = true;

    try {
      await options.onShutdown?.(reason);
    } catch {
      // A failing hook must not prevent the close below.
    }

    try {
      await server.close();
    } catch {
      // Already closed, or the transport is gone. Either way, stop.
    }

    options.onExit?.(reason);
    if (options.exitOnShutdown) {
      process.exit(reason === "SIGINT" ? 130 : 0);
    }
  };

  transport.onclose = () => void shutdown("transport-close");
  transport.onerror = () => void shutdown("transport-error");

  if (options.handleSignals) {
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  }

  await server.connect(transport as never);

  return {
    server,
    transport,
    shutdown,
    get stopped() {
      return stopped;
    },
  };
}

/**
 * Build and start in one call, for a host that has a transport ready.
 *
 * `createMindVaultServer` and `startServer` stay separate underneath, because
 * a test usually wants the server without starting it.
 */
export async function createAndStart(
  behaviour: ServerBehaviour,
  transport: McpTransport,
  options: StartOptions = {},
  identity: ServerIdentity = DEFAULT_IDENTITY,
): Promise<RunningServer> {
  return startServer(createMindVaultServer(behaviour, identity), transport, options);
}
