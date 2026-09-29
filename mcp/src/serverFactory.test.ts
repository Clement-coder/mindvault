/**
 * Tests for the transport-agnostic server factory (#575).
 *
 * These drive a **real** MCP session: a real `Server` built by the factory,
 * connected to a real `Client` over the SDK's in-memory transport pair. No
 * mocked SDK. That is the point of the issue — the previous arrangement made
 * the server unreachable without a stdio transport, so tests mocked the SDK
 * and never exercised the wiring they were supposedly covering.
 */
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  CORRELATION_META_KEY,
  isCorrelationId,
  runWithCorrelationId,
  currentCorrelationId,
} from "./correlation.js";
import {
  DEFAULT_IDENTITY,
  createAndStart,
  createMindVaultServer,
  startServer,
  type McpTransport,
  type ServerBehaviour,
} from "./serverFactory.js";
import { createProgressEmitter, type SendNotification } from "./progress.js";

const TOOL = {
  name: "mindvault_echo",
  description: "Echo the text back.",
  inputSchema: {
    type: "object" as const,
    properties: { text: { type: "string", description: "Text to echo." } },
    required: ["text"],
  },
};

function behaviour(overrides: Partial<ServerBehaviour> = {}): ServerBehaviour {
  return {
    listTools: () => [TOOL],
    dispatchTool: async (_name, args) => `echo: ${String(args.text ?? "")}`,
    ...overrides,
  };
}

/** Build a server and connect a real client to it over an in-memory pair. */
async function connectClient(server: ReturnType<typeof createMindVaultServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, serverTransport };
}

/** A transport stub for lifecycle tests, with no session behind it. */
function fakeTransport(): McpTransport & { closed: boolean; start: () => Promise<void> } {
  return {
    closed: false,
    start: async () => {},
    send: async () => {},
    close: async function (this: any) {
      this.closed = true;
    },
  } as never;
}

describe("createMindVaultServer", () => {
  it("builds a server without touching a transport", () => {
    // Construction with no side effects is the whole point: no stdio, no
    // process.env.VITEST guard to work around.
    expect(() => createMindVaultServer(behaviour())).not.toThrow();
  });

  it("uses the default identity", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    expect(client.getServerVersion()).toMatchObject(DEFAULT_IDENTITY);
  });

  it("accepts a custom identity", async () => {
    const server = createMindVaultServer(behaviour(), { name: "other", version: "9.9.9" });
    const { client } = await connectClient(server);

    expect(client.getServerVersion()).toMatchObject({ name: "other", version: "9.9.9" });
  });

  it("rejects prompts without a resolver", () => {
    expect(() => createMindVaultServer(behaviour({ listPrompts: () => [] }))).toThrow(
      /getPrompt is required/,
    );
  });

  it("declares prompt capability only when prompts are supplied", async () => {
    const withPrompts = createMindVaultServer(
      behaviour({
        listPrompts: () => [{ name: "p", description: "d", arguments: [] }],
        getPrompt: () => ({ description: "d", messages: [] }),
      }),
    );
    const { client } = await connectClient(withPrompts);

    expect(await client.listPrompts()).toMatchObject({ prompts: [{ name: "p" }] });
  });
});

describe("tools over a real session", () => {
  it("advertises the tool list", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["mindvault_echo"]);
  });

  it("calls listTools per request, so the surface can be dynamic", async () => {
    const listTools = vi.fn().mockReturnValue([TOOL]);
    const { client } = await connectClient(createMindVaultServer(behaviour({ listTools })));

    await client.listTools();
    await client.listTools();

    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("dispatches a call and returns its text", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    const result: any = await client.callTool({
      name: "mindvault_echo",
      arguments: { text: "hi" },
    });

    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
  });

  it("passes the tool name and arguments through", async () => {
    const dispatchTool = vi.fn().mockResolvedValue("ok");
    const { client } = await connectClient(createMindVaultServer(behaviour({ dispatchTool })));

    await client.callTool({ name: "mindvault_echo", arguments: { text: "x", n: 1 } });

    expect(dispatchTool).toHaveBeenCalledWith("mindvault_echo", { text: "x", n: 1 }, undefined);
  });

  it("attaches structured content when the behaviour supplies it", async () => {
    const { client } = await connectClient(
      createMindVaultServer(behaviour({ structuredResult: () => ({ parsed: true }) })),
    );

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(result.structuredContent).toEqual({ parsed: true });
  });

  it("omits structured content when there is none", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(result.structuredContent).toBeUndefined();
  });
});

describe("errors", () => {
  const failing = () =>
    behaviour({
      dispatchTool: async () => {
        throw new Error("tool exploded");
      },
    });

  it("returns a tool error rather than failing the request", async () => {
    const { client } = await connectClient(createMindVaultServer(failing()));

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    // isError, not a protocol-level failure: the agent gets to read and react.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("tool exploded");
  });

  it("uses a custom error formatter", async () => {
    const { client } = await connectClient(
      createMindVaultServer({ ...failing(), formatError: () => "redacted" }),
    );

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(result.content[0].text).toContain("redacted");
  });

  it("attaches troubleshooting content when supplied", async () => {
    const { client } = await connectClient(
      createMindVaultServer({ ...failing(), errorContent: () => ({ hint: "check the network" }) }),
    );

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(result.structuredContent).toEqual({ hint: "check the network" });
  });

  it("handles a thrown non-Error", async () => {
    const { client } = await connectClient(
      createMindVaultServer(
        behaviour({
          dispatchTool: async () => {
            throw "a string";
          },
        }),
      ),
    );

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(result.content[0].text).toContain("a string");
  });
});

describe("progress notifications (#841)", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Every message the server writes, in order: `progress:<message>` or `result`. */
  function recordServerOutput(serverTransport: InMemoryTransport): string[] {
    const written: string[] = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message: any, options?: any) => {
      if (message.method === "notifications/progress") {
        written.push(`progress:${message.params.message}`);
      } else if ("result" in message) {
        written.push("result");
      }
      return send(message, options);
    };
    return written;
  }

  /**
   * The production emitter over a transport whose writes complete a moment
   * later, as a Streamable HTTP event store or a busy socket does.
   */
  const slowProgressEmitter = (token: string | number, send: (n: unknown) => unknown) =>
    createProgressEmitter({
      token,
      send: (async (notification) => {
        await pause(20);
        await send(notification);
      }) as SendNotification,
    });

  async function callWithProgress(dispatchTool: ServerBehaviour["dispatchTool"]) {
    const { client, serverTransport } = await connectClient(
      createMindVaultServer(
        behaviour({ dispatchTool, createProgressEmitter: slowProgressEmitter }),
      ),
    );
    const written = recordServerOutput(serverTransport);
    const clientErrors: Error[] = [];
    client.onerror = (err) => clientErrors.push(err);
    const received: string[] = [];

    const result: any = await client.callTool(
      { name: "mindvault_echo", arguments: {} },
      undefined,
      { onprogress: (p) => received.push(String(p.message)) },
    );
    // Give anything scheduled after the result time to reach the wire.
    await pause(60);

    return { result, written, received, clientErrors };
  }

  it("emits no progress notification after the tool result is returned", async () => {
    const { result, written, received, clientErrors } = await callWithProgress(
      async (_name, _args, onProgress) => {
        // Neither update is awaited: one is still in flight when the tool
        // returns, the other is scheduled to fire after it has.
        void onProgress?.(1, 2, "working");
        setTimeout(() => void onProgress?.(2, 2, "late"), 0);
        return "done";
      },
    );

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(written).toEqual(["progress:working", "result"]);
    expect(received).toEqual(["working"]);
    expect(clientErrors).toEqual([]);
  });

  it("delivers awaited progress ahead of the result", async () => {
    const { written, received } = await callWithProgress(async (_name, _args, onProgress) => {
      await onProgress?.(1, 2, "first");
      await onProgress?.(2, 2, "second");
      return "done";
    });

    expect(written).toEqual(["progress:first", "progress:second", "result"]);
    expect(received).toEqual(["first", "second"]);
  });

  it("settles pending progress before returning a tool error", async () => {
    const { result, written } = await callWithProgress(async (_name, _args, onProgress) => {
      void onProgress?.(1, 1, "about to fail");
      throw new Error("tool exploded");
    });

    expect(result.isError).toBe(true);
    expect(written).toEqual(["progress:about to fail", "result"]);
  });
});

describe("correlation IDs (#572)", () => {
  it("attaches an id to a successful result", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(isCorrelationId(result._meta?.[CORRELATION_META_KEY])).toBe(true);
  });

  it("makes the id visible to the tool while it runs", async () => {
    let seen: string | undefined;
    const { client } = await connectClient(
      createMindVaultServer(
        behaviour({
          dispatchTool: async () => {
            seen = currentCorrelationId();
            return "ok";
          },
        }),
      ),
    );

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    // The same id the result carries, so an audit line and a user report match.
    expect(seen).toBe(result._meta?.[CORRELATION_META_KEY]);
  });

  it("gives each call its own id", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    const first: any = await client.callTool({ name: "mindvault_echo", arguments: {} });
    const second: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(first._meta[CORRELATION_META_KEY]).not.toBe(second._meta[CORRELATION_META_KEY]);
  });

  it("puts the id in the error text as well", async () => {
    const { client } = await connectClient(
      createMindVaultServer(
        behaviour({
          dispatchTool: async () => {
            throw new Error("nope");
          },
        }),
      ),
    );

    const result: any = await client.callTool({ name: "mindvault_echo", arguments: {} });

    // A failure is the one case where a human is likely to quote it back.
    expect(result.content[0].text).toContain(result._meta[CORRELATION_META_KEY]);
  });

  it("does not inherit an outer id", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    const result: any = await runWithCorrelationId("mv-outer-0001", () =>
      client.callTool({ name: "mindvault_echo", arguments: {} }),
    );

    expect(result._meta[CORRELATION_META_KEY]).not.toBe("mv-outer-0001");
  });
});

describe("prompts", () => {
  const withPrompts = () =>
    behaviour({
      listPrompts: () => [
        {
          name: "publish_flow",
          description: "Walk through publishing.",
          arguments: [{ name: "title", description: "Resource title", required: true }],
        },
      ],
      getPrompt: (name, args) => ({
        description: `prompt ${name}`,
        messages: [{ role: "user", content: { type: "text", text: String(args.title) } }],
      }),
    });

  it("advertises them", async () => {
    const { client } = await connectClient(createMindVaultServer(withPrompts()));

    const { prompts } = await client.listPrompts();

    expect(prompts[0]).toMatchObject({ name: "publish_flow" });
  });

  it("resolves one with its arguments", async () => {
    const { client } = await connectClient(createMindVaultServer(withPrompts()));

    const result: any = await client.getPrompt({
      name: "publish_flow",
      arguments: { title: "My Report" },
    });

    expect(result.description).toBe("prompt publish_flow");
    expect(result.messages[0].content.text).toBe("My Report");
  });

  it("registers no prompt handlers when none are supplied", async () => {
    const { client } = await connectClient(createMindVaultServer(behaviour()));

    await expect(client.listPrompts()).rejects.toThrow();
  });
});

describe("startServer", () => {
  it("connects to the given transport", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();

    const running = await startServer(createMindVaultServer(behaviour()), serverTransport as never);

    expect(running.stopped).toBe(false);
    await running.shutdown("test");
  });

  it("runs the shutdown hook", async () => {
    const onShutdown = vi.fn();
    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport(), {
      onShutdown,
    });

    await running.shutdown("manual");

    expect(onShutdown).toHaveBeenCalledWith("manual");
  });

  it("is idempotent", async () => {
    const onShutdown = vi.fn();
    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport(), {
      onShutdown,
    });

    await running.shutdown("first");
    await running.shutdown("second");

    // A transport error during shutdown would otherwise re-enter and
    // double-run the hooks.
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("reports that it stopped", async () => {
    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport());

    await running.shutdown("manual");

    expect(running.stopped).toBe(true);
  });

  it("shuts down when the transport closes", async () => {
    const onShutdown = vi.fn();
    const transport = fakeTransport();
    await startServer(createMindVaultServer(behaviour()), transport, { onShutdown });

    transport.onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onShutdown).toHaveBeenCalledWith("transport-close");
  });

  it("shuts down on a transport error", async () => {
    const onShutdown = vi.fn();
    const transport = fakeTransport();
    await startServer(createMindVaultServer(behaviour()), transport, { onShutdown });

    transport.onerror?.(new Error("broken pipe"));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onShutdown).toHaveBeenCalledWith("transport-error");
  });

  it("still closes when the shutdown hook throws", async () => {
    const onExit = vi.fn();
    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport(), {
      onShutdown: () => {
        throw new Error("hook failed");
      },
      onExit,
    });

    await running.shutdown("manual");

    // A failing hook must not prevent shutdown.
    expect(onExit).toHaveBeenCalledWith("manual");
  });

  it("does not exit the process by default", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport());

    await running.shutdown("manual");

    // An embedding host keeps control of its own process.
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("exits when asked to", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport(), {
      exitOnShutdown: true,
    });

    await running.shutdown("SIGINT");

    expect(exit).toHaveBeenCalledWith(130);
    exit.mockRestore();
  });

  it("uses exit code 0 for a non-interrupt reason", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport(), {
      exitOnShutdown: true,
    });

    await running.shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it("does not install signal handlers unless asked", async () => {
    const before = process.listenerCount("SIGINT");

    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport());

    // A library that grabs SIGINT from its host is a bad neighbour.
    expect(process.listenerCount("SIGINT")).toBe(before);
    await running.shutdown("manual");
  });

  it("installs signal handlers on request", async () => {
    const before = process.listenerCount("SIGTERM");

    const running = await startServer(createMindVaultServer(behaviour()), fakeTransport(), {
      handleSignals: true,
    });

    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(before);
    await running.shutdown("manual");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });
});

describe("createAndStart", () => {
  it("builds and connects in one call", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1.0.0" }, { capabilities: {} });

    const [running] = await Promise.all([
      createAndStart(behaviour(), serverTransport as never),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    await running.shutdown("test");
  });

  it("exposes the same server and transport it started", async () => {
    const transport = fakeTransport();

    const running = await createAndStart(behaviour(), transport);

    expect(running.transport).toBe(transport);
    expect(running.server).toBeDefined();
    await running.shutdown("test");
  });
});

describe("transport independence", () => {
  it("does not import a transport implementation", async () => {
    const source = await import("node:fs").then(({ readFileSync }) =>
      readFileSync(new URL("./serverFactory.ts", import.meta.url), "utf-8"),
    );

    // Comments stripped: the module docstring discusses stdio at length, and
    // the regression this guards is a real `import`, not a mention.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // Re-introducing a hard dependency on stdio would make the factory
    // transport-agnostic in name only.
    expect(code).not.toContain("StdioServerTransport");
    expect(code).not.toContain("server/stdio.js");
  });

  it("serves two independent instances at once", async () => {
    const first = await connectClient(createMindVaultServer(behaviour()));
    const second = await connectClient(
      createMindVaultServer(behaviour({ dispatchTool: async () => "second" })),
    );

    const a: any = await first.client.callTool({
      name: "mindvault_echo",
      arguments: { text: "1" },
    });
    const b: any = await second.client.callTool({ name: "mindvault_echo", arguments: {} });

    expect(a.content[0].text).toBe("echo: 1");
    expect(b.content[0].text).toBe("second");
  });
});
