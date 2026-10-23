/**
 * Tests for the two on-chain listing tools: `mindvault_registry_creator_page`
 * (#972) and `mindvault_registry_tag_search` (#974).
 *
 * Bootstrap follows index.test.ts rather than the MINDVAULT_MOCK harness: the
 * registry client is replaced with a controllable fake, so the on-chain read
 * is deterministic without a network while everything else — argument
 * validation, dispatch, cursor handling, error mapping, structuredContent
 * wiring — runs for real through the SDK transport.
 *
 * The cursor is the interesting part of both tools: the creator page hands
 * back an opaque token that must decode back into the contract's `IdCursor`,
 * and the tag search hands back a catalog index that must survive a round
 * trip. Both are pinned here, together with the filters the creator page
 * forwards to the contract.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IntegrationHarness } from "./integrationHarness.js";

interface ResourceFixture {
  id: string;
  creator: string;
  price: bigint;
  metadata: string;
  listed: boolean;
  state: { tag: string; values: void };
  tags: string[];
}

/** Controllable registry fake for both listing tools. */
const registryControl = vi.hoisted(() => ({
  creatorArgs: null as unknown,
  tagArgs: null as unknown,
  state: null as
    | null
    | { kind: "ok"; items: unknown[]; nextCursor: unknown }
    | { kind: "contract"; err: Error }
    | { kind: "transport"; err: Error },
}));

vi.mock("@mindvault/registry-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createRegistryClient: () => ({
      list_by_creator_page_filtered: async (args: unknown) => {
        registryControl.creatorArgs = args;
        const s = registryControl.state;
        // A failed simulation throws, the way the SDK reports it.
        if (s?.kind === "transport" || s?.kind === "contract") throw s.err;
        return { result: { items: s?.items ?? [], next_cursor: s?.nextCursor } };
      },
      search_by_tag_prefix: async (args: unknown) => {
        registryControl.tagArgs = args;
        const s = registryControl.state;
        if (s?.kind === "transport" || s?.kind === "contract") throw s.err;
        return { result: { items: s?.items ?? [], next_cursor: s?.nextCursor ?? null } };
      },
    }),
  };
});

// Isolate state persistence from the developer machine and pin the network
// preset before index.js loads.
process.env.STELLAR_NETWORK = "testnet";
const harnessHome = mkdtempSync(join(tmpdir(), "mindvault-mcp-listing-"));
process.env.HOME = harnessHome;
process.env.USERPROFILE = harnessHome;

const { server } = await import("./index.js");
const { startIntegrationHarness, harnessIsToolError, harnessResultText } =
  await import("./integrationHarness.js");
const { decodeIdCursor, encodeIdCursor } = await import("./registryIdCursor.js");

const CREATOR = "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH";

function resource(id: string, overrides: Partial<ResourceFixture> = {}): ResourceFixture {
  return {
    id,
    creator: CREATOR,
    price: 1_500_000n,
    metadata: `Intro to ${id}`,
    listed: true,
    state: { tag: "Listed", values: void 0 },
    tags: ["dataset"],
    ...overrides,
  };
}

function page(items: ResourceFixture[], nextCursor: unknown = { tag: "End", values: void 0 }) {
  registryControl.state = { kind: "ok", items, nextCursor };
}

describe("mindvault_registry_creator_page", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    await harness?.close();
    rmSync(harnessHome, { recursive: true, force: true });
  });

  it("is advertised as a read-only tool with an output schema", async () => {
    const { tools } = await harness.listTools();
    const tool = tools.find((t) => t.name === "mindvault_registry_creator_page") as {
      annotations?: { readOnlyHint?: boolean };
      outputSchema?: unknown;
    };
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  });

  it("requires the creator argument", async () => {
    const result = await harness.callTool("mindvault_registry_creator_page", {});
    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toMatch(/creator is required/i);
  });

  it("asks the contract for the creator's first page", async () => {
    page([resource("res-1")]);
    const result = await harness.callTool("mindvault_registry_creator_page", { creator: CREATOR });
    expect(harnessIsToolError(result)).toBe(false);

    const args = registryControl.creatorArgs as {
      creator: string;
      cursor: { tag: string };
      limit: number;
      listed: unknown;
      state: unknown;
    };
    expect(args.creator).toBe(CREATOR);
    expect(args.cursor.tag).toBe("Start");
    expect(args.limit).toBe(20);
    expect(args.listed).toBeUndefined();
    expect(args.state).toBeUndefined();
  });

  it("summarizes the page and reports a null cursor at the end of the list", async () => {
    page([resource("res-1"), resource("res-2")]);
    const result = await harness.callTool("mindvault_registry_creator_page", { creator: CREATOR });
    const data = JSON.parse(harnessResultText(result));
    expect(data.source).toBe("on-chain");
    expect(data.creator).toBe(CREATOR);
    expect(data.count).toBe(2);
    expect(data.nextCursor).toBeNull();
    expect(data.resources[0]).toMatchObject({
      id: "res-1",
      creator: CREATOR,
      listed: true,
      state: "Listed",
      tags: ["dataset"],
    });
  });

  it("forwards the listing and lifecycle filters to the contract", async () => {
    page([]);
    await harness.callTool("mindvault_registry_creator_page", {
      creator: CREATOR,
      listed: true,
      state: "Frozen",
      limit: 5,
    });
    const args = registryControl.creatorArgs as {
      limit: number;
      listed: unknown;
      state: { tag: string };
    };
    expect(args.limit).toBe(5);
    expect(args.listed).toBe(true);
    expect(args.state.tag).toBe("Frozen");
  });

  it("hands back an opaque cursor that decodes back into the contract cursor", async () => {
    page([resource("res-1")], { tag: "After", values: [7, "res-1", 8] });
    const first = await harness.callTool("mindvault_registry_creator_page", { creator: CREATOR });
    const data = JSON.parse(harnessResultText(first));
    expect(typeof data.nextCursor).toBe("string");
    // Opaque: the token does not read as the contract cursor.
    expect(data.nextCursor).not.toContain("After");

    const decoded = decodeIdCursor(data.nextCursor);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.cursor).toEqual({ tag: "After", values: [7, "res-1", 8] });
    }
  });

  it("sends the decoded cursor back to the contract on the next page", async () => {
    page([resource("res-2")], { tag: "After", values: [7, "res-1", 8] });
    const token = encodeIdCursor({ tag: "After", values: [7, "res-1", 8] } as never);
    await harness.callTool("mindvault_registry_creator_page", { creator: CREATOR, cursor: token });
    const args = registryControl.creatorArgs as { cursor: { tag: string; values: unknown[] } };
    expect(args.cursor.tag).toBe("After");
    expect(args.cursor.values).toEqual([7, "res-1", 8]);
  });

  it("rejects a cursor it cannot decode instead of guessing", async () => {
    const result = await harness.callTool("mindvault_registry_creator_page", {
      creator: CREATOR,
      cursor: "not-a-cursor",
    });
    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toMatch(/cursor/i);
  });

  it("reports a contract failure as a tool error", async () => {
    registryControl.state = { kind: "contract", err: new Error("InvalidResourceId") };
    const result = await harness.callTool("mindvault_registry_creator_page", { creator: CREATOR });
    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toMatch(/InvalidResourceId/);
  });

  it("reports a transport failure as a tool error", async () => {
    registryControl.state = { kind: "transport", err: new Error("socket hang up") };
    const result = await harness.callTool("mindvault_registry_creator_page", { creator: CREATOR });
    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toMatch(/socket hang up/);
  });
});

describe("mindvault_registry_tag_search", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("is advertised as a read-only tool with an output schema", async () => {
    const { tools } = await harness.listTools();
    const tool = tools.find((t) => t.name === "mindvault_registry_tag_search") as {
      annotations?: { readOnlyHint?: boolean };
      outputSchema?: unknown;
    };
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  });

  it("requires the prefix argument", async () => {
    const result = await harness.callTool("mindvault_registry_tag_search", {});
    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toMatch(/prefix is required/i);
  });

  it("asks the contract for the first page of a prefix scan", async () => {
    page([resource("res-1")], null);
    const result = await harness.callTool("mindvault_registry_tag_search", { prefix: "dat" });
    expect(harnessIsToolError(result)).toBe(false);

    const args = registryControl.tagArgs as { prefix: string; cursor: number; limit: number };
    expect(args.prefix).toBe("dat");
    expect(args.cursor).toBe(0);
    expect(args.limit).toBe(20);
  });

  it("summarizes the matches and reports the next catalog index", async () => {
    page([resource("res-1")], 12);
    const result = await harness.callTool("mindvault_registry_tag_search", { prefix: "dat" });
    const data = JSON.parse(harnessResultText(result));
    expect(data.source).toBe("on-chain");
    expect(data.prefix).toBe("dat");
    expect(data.cursor).toBe(0);
    expect(data.count).toBe(1);
    expect(data.nextCursor).toBe(12);
    expect(data.resources[0].id).toBe("res-1");
  });

  it("continues the scan from the cursor the previous page returned", async () => {
    page([], null);
    await harness.callTool("mindvault_registry_tag_search", { prefix: "dat", cursor: 12 });
    const args = registryControl.tagArgs as { cursor: number };
    expect(args.cursor).toBe(12);
  });

  it("reports an empty page with a null cursor", async () => {
    page([], null);
    const result = await harness.callTool("mindvault_registry_tag_search", { prefix: "zzz" });
    const data = JSON.parse(harnessResultText(result));
    expect(data.count).toBe(0);
    expect(data.resources).toEqual([]);
    expect(data.nextCursor).toBeNull();
    expect(data.message).toMatch(/zzz/);
  });

  it("maps a transport failure to a tool error", async () => {
    registryControl.state = { kind: "transport", err: new Error("rpc timeout") };
    const result = await harness.callTool("mindvault_registry_tag_search", { prefix: "dat" });
    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toMatch(/rpc timeout/);
  });
});

describe("the listing tools in mock mode", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("serves the creator's own resources without touching the network", async () => {
    process.env.MINDVAULT_MOCK = "1";
    try {
      const result = await harness.callTool("mindvault_registry_creator_page", {
        creator: CREATOR,
      });
      expect(harnessIsToolError(result)).toBe(false);
      const data = JSON.parse(harnessResultText(result));
      expect(data.source).toBe("on-chain (mock)");
      expect(data.creator).toBe(CREATOR);
      expect(data.count).toBe(1);
      expect(data.resources[0].id).toBe("mock-1");
      expect(data.nextCursor).toBeNull();
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("filters the mock page by listing state", async () => {
    process.env.MINDVAULT_MOCK = "1";
    try {
      const listed = await harness.callTool("mindvault_registry_creator_page", {
        creator: CREATOR,
        listed: true,
      });
      expect(JSON.parse(harnessResultText(listed)).count).toBe(1);

      const unlisted = await harness.callTool("mindvault_registry_creator_page", {
        creator: CREATOR,
        listed: false,
      });
      const data = JSON.parse(harnessResultText(unlisted));
      expect(data.count).toBe(0);
      expect(data.resources).toEqual([]);
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("serves a tag-prefix search from the mock catalog", async () => {
    process.env.MINDVAULT_MOCK = "1";
    try {
      const result = await harness.callTool("mindvault_registry_tag_search", { prefix: "dat" });
      expect(harnessIsToolError(result)).toBe(false);
      const data = JSON.parse(harnessResultText(result));
      expect(data.source).toBe("on-chain (mock)");
      expect(data.count).toBe(1);
      expect(data.resources[0].id).toBe("mock-1");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });

  it("normalizes the prefix the way a tag is normalized", async () => {
    process.env.MINDVAULT_MOCK = "1";
    try {
      const result = await harness.callTool("mindvault_registry_tag_search", {
        prefix: "  DATA  ",
      });
      const data = JSON.parse(harnessResultText(result));
      expect(data.count).toBe(1);
      expect(data.resources[0].id).toBe("mock-1");
    } finally {
      delete process.env.MINDVAULT_MOCK;
    }
  });
});

describe("the registry id cursor", () => {
  it("round-trips a Start cursor", () => {
    const encoded = encodeIdCursor({ tag: "Start", values: void 0 } as never);
    const decoded = decodeIdCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.cursor.tag).toBe("Start");
  });

  it("round-trips an After cursor with its values", () => {
    const encoded = encodeIdCursor({ tag: "After", values: [3, "res-3", 4] } as never);
    const decoded = decodeIdCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.cursor).toEqual({ tag: "After", values: [3, "res-3", 4] });
    }
  });

  it("rejects a token that is not base64url JSON", () => {
    const decoded = decodeIdCursor("not-a-cursor");
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toMatch(/cursor/i);
  });

  it("rejects a token from an unknown version", () => {
    const encoded = Buffer.from(JSON.stringify({ v: 99, t: "Start" })).toString("base64url");
    const decoded = decodeIdCursor(encoded);
    expect(decoded.ok).toBe(false);
  });
});
