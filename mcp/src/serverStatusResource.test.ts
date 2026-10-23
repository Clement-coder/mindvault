/**
 * `mindvault://server/status` resource (#1064).
 *
 * The pure builders are checked directly; the resource itself is read through
 * a real MCP client connected to the real stdio server (`index.ts`) over the
 * SDK's in-memory transport, so the list/read/subscribe wiring is exercised
 * end to end. The catalog half of `resources/list` is stubbed: it calls the
 * MindVault API, which is not what these tests are about.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Keypair } from "@stellar/stellar-sdk";

import {
  SERVER_STATUS_SCHEMA,
  SERVER_STATUS_URI,
  buildServerStatus,
  createServerStatusWatcher,
  serverStatusContents,
  toolCapabilityVersion,
  type ServerStatusInput,
} from "./serverStatusResource.js";

vi.mock("./catalogResources.js", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  listCatalogResources: async () => [
    { uri: "mindvault://resource/mock-1", name: "Intro", mimeType: "application/json" },
  ],
}));

process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
delete process.env.MINDVAULT_READ_ONLY;
const home = mkdtempSync(join(tmpdir(), "mindvault-mcp-status-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { server, _resetProfiles } = await import("./index.js");

const TOOLS = [
  { name: "b_tool", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "a_tool", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
];

function input(overrides: Partial<ServerStatusInput> = {}): ServerStatusInput {
  return {
    serverName: "mindvault",
    serverVersion: "1.0.0",
    stellarNetwork: "testnet",
    x402Network: "stellar:testnet",
    registryContractId: "CREGISTRY",
    networkPassphrase: "Test SDF Network ; September 2015",
    tools: TOOLS,
    readOnly: false,
    mock: false,
    walletConfigured: true,
    publisherRegistered: false,
    ...overrides,
  };
}

describe("toolCapabilityVersion", () => {
  it("is stable for the same surface regardless of order", () => {
    expect(toolCapabilityVersion(TOOLS)).toBe(toolCapabilityVersion([...TOOLS].reverse()));
    expect(toolCapabilityVersion(TOOLS)).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("changes when a tool's contract changes, is added, or is removed", () => {
    const base = toolCapabilityVersion(TOOLS);
    const changed = [{ ...TOOLS[0], annotations: { readOnlyHint: false } }, TOOLS[1]];
    expect(toolCapabilityVersion(changed)).not.toBe(base);
    expect(toolCapabilityVersion([TOOLS[0]])).not.toBe(base);
    expect(toolCapabilityVersion([...TOOLS, { name: "c_tool" }])).not.toBe(base);
  });

  it("ignores description wording", () => {
    const described = TOOLS.map((t) => ({ ...t, description: "reworded" }));
    expect(toolCapabilityVersion(described)).toBe(toolCapabilityVersion(TOOLS));
  });
});

describe("buildServerStatus", () => {
  it("reports network, registry, capabilities, and status", () => {
    expect(buildServerStatus(input({ stellarNetwork: "mainnet", mock: true }))).toEqual({
      schema: SERVER_STATUS_SCHEMA,
      server: { name: "mindvault", version: "1.0.0" },
      network: { stellarNetwork: "mainnet", x402Network: "stellar:testnet", mainnet: true },
      registry: { contractId: "CREGISTRY", networkPassphrase: "Test SDF Network ; September 2015" },
      capabilities: { toolCapabilityVersion: toolCapabilityVersion(TOOLS), toolCount: 2 },
      status: { mode: "mock", readOnly: false, walletConfigured: true, publisherRegistered: false },
    });
  });
});

describe("createServerStatusWatcher", () => {
  it("reports a change only to a subscriber, and only when the status changed", () => {
    let network = "testnet";
    const watcher = createServerStatusWatcher(() =>
      serverStatusContents(input({ stellarNetwork: network })),
    );
    const before = watcher.snapshot();
    network = "mainnet";
    expect(watcher.changedSince(before)).toBe(false); // nobody subscribed

    expect(watcher.subscribe("mindvault://resource/x")).toBe(false);
    expect(watcher.subscribe(SERVER_STATUS_URI)).toBe(true);
    expect(watcher.changedSince(before)).toBe(true);
    expect(watcher.changedSince(watcher.snapshot())).toBe(false);

    watcher.unsubscribe(SERVER_STATUS_URI);
    expect(watcher.changedSince(before)).toBe(false);
  });
});

describe("mindvault://server/status through the MCP server", () => {
  let client: Client;
  const updates: string[] = [];

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "status-test", version: "1.0.0" }, { capabilities: {} });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetProfiles();
    updates.length = 0;
  });

  async function readStatus() {
    const { contents } = await client.readResource({ uri: SERVER_STATUS_URI });
    expect(contents).toHaveLength(1);
    expect(contents[0].mimeType).toBe("application/json");
    const raw = String((contents[0] as { text: string }).text);
    return { raw, status: JSON.parse(raw) };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("advertises subscribable resources", () => {
    expect(client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
  });

  it("is listed ahead of the catalog entries", async () => {
    const { resources } = await client.listResources();
    expect(resources[0].uri).toBe(SERVER_STATUS_URI);
    expect(resources.map((r) => r.uri)).toContain("mindvault://resource/mock-1");
  });

  it("reports the active network, registry, and capability version", async () => {
    const { status } = await readStatus();
    const { tools } = await client.listTools();

    expect(status.schema).toBe(SERVER_STATUS_SCHEMA);
    expect(status.network).toEqual({
      stellarNetwork: "testnet",
      x402Network: "stellar:testnet",
      mainnet: false,
    });
    expect(status.registry.contractId).toMatch(/^C[A-Z0-9]+$/);
    expect(status.capabilities).toEqual({
      toolCapabilityVersion: toolCapabilityVersion(tools),
      toolCount: tools.length,
    });
    expect(status.status).toEqual({
      mode: "mock",
      readOnly: false,
      walletConfigured: false,
      publisherRegistered: false,
    });
  });

  it("follows a profile change and never exposes the wallet", async () => {
    const wallet = Keypair.random();
    const imported: any = await client.callTool({
      name: "mindvault_import_wallet",
      arguments: { secretKey: wallet.secret(), profile: "alice.personal", confirm: true },
    });
    expect(imported.isError).toBeFalsy();

    const { raw, status } = await readStatus();
    expect(status.status.walletConfigured).toBe(true);
    expect(raw).not.toContain(wallet.secret());
    expect(raw).not.toContain(wallet.publicKey());
    expect(raw).not.toContain("alice");
    expect(raw).not.toMatch(/https?:\/\//);
  });

  it("follows a network switch and notifies a subscriber", async () => {
    await client.subscribeResource({ uri: SERVER_STATUS_URI });
    try {
      const before = (await readStatus()).status;
      const switched: any = await client.callTool({
        name: "mindvault_switch_network_profile",
        arguments: { name: "mainnet-profile", network: "mainnet" },
      });
      expect(switched.isError).toBeFalsy();
      await tick();

      const after = (await readStatus()).status;
      expect(before.network.mainnet).toBe(false);
      expect(after.network).toEqual({
        stellarNetwork: "mainnet",
        x402Network: "stellar:pubnet",
        mainnet: true,
      });
      expect(after.registry.networkPassphrase).not.toBe(before.registry.networkPassphrase);
      expect(updates).toEqual([SERVER_STATUS_URI]);
    } finally {
      // Leaving mainnet is itself a call made on mainnet, so allow it.
      process.env.MINDVAULT_ALLOW_MAINNET = "1";
      await client.callTool({
        name: "mindvault_switch_network_profile",
        arguments: { name: "default", network: "testnet" },
      });
      delete process.env.MINDVAULT_ALLOW_MAINNET;
      await client.unsubscribeResource({ uri: SERVER_STATUS_URI });
    }
  });

  it("does not notify when a call leaves the status unchanged", async () => {
    await client.subscribeResource({ uri: SERVER_STATUS_URI });
    try {
      await client.callTool({ name: "mindvault_list_profiles", arguments: {} });
      await tick();
      expect(updates).toEqual([]);
    } finally {
      await client.unsubscribeResource({ uri: SERVER_STATUS_URI });
    }
  });

  it("rejects a subscription to a catalog resource", async () => {
    await expect(client.subscribeResource({ uri: "mindvault://resource/mock-1" })).rejects.toThrow(
      /Only mindvault:\/\/server\/status supports subscriptions/,
    );
  });

  it("is read-only: no tool or request can write it", async () => {
    const { tools } = await client.listTools();
    expect(tools.some((t) => /server[_/]status/.test(t.name))).toBe(false);
    // Reading twice with nothing in between returns identical content.
    expect((await readStatus()).raw).toBe((await readStatus()).raw);
  });
});
