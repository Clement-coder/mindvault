/**
 * Contract test: tool annotations and guardrails match handler side effects
 * (#1063).
 *
 * `toolSideEffects.ts` records what each handler does. This suite holds every
 * other claim about side effects to that record, and holds the record to the
 * handlers:
 *
 *  1. Every advertised tool has exactly one row.
 *  2. Its `readOnlyHint` and `destructiveHint` are the ones the row implies.
 *  3. Its paid-operation class (`paidOperations.ts`) is the row's `payment`.
 *  4. Every tool with an on-chain effect or a payment is mainnet-gated.
 *  5. Every tool the row calls side-effect free is dispatched for real, in
 *     mock mode against a scratch home directory with a recording fetch, and
 *     must leave every file untouched and make no request other than a read.
 *
 * (5) is what ties the metadata to behaviour: a handler that grows an indirect
 * write (saving state, writing a backup, appending history, POSTing to the
 * API) fails here even if nobody updates its annotations.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Every request a handler makes, through the mock transport or global fetch. */
interface RecordedRequest {
  url: string;
  method: string;
  rpcMethod?: string;
}
const requests: RecordedRequest[] = [];

function rpcMethodOf(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as { jsonrpc?: unknown; method?: unknown };
    return parsed.jsonrpc === "2.0" && typeof parsed.method === "string"
      ? parsed.method
      : undefined;
  } catch {
    return undefined;
  }
}

function record(input: unknown, init?: RequestInit): void {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  requests.push({ url, method, rpcMethod: rpcMethodOf(init?.body) });
}

vi.mock("./mock.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("./mock.js");
  return {
    ...actual,
    createMockFetch: (...args: Parameters<typeof actual.createMockFetch>) => {
      const inner = actual.createMockFetch(...args);
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        record(input, init);
        return inner(input, init);
      }) as typeof fetch;
    },
  };
});

process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
// SDK clients that bypass fetch (Soroban RPC, Horizon) get a closed local
// port, so a probe fails fast instead of reaching, or waiting on, the network.
process.env.SOROBAN_RPC_URL = "http://127.0.0.1:9";
process.env.HORIZON_URL = "http://127.0.0.1:9";
const home = mkdtempSync(join(tmpdir(), "mindvault-side-effects-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// Anything that escapes the mock transport is recorded and refused, so a
// probe can neither reach a real service nor wait on one.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  record(input, init);
  return new Response(JSON.stringify({ error: "offline in toolSideEffects.test.ts" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { dispatchTool } = await import("./index.js");
const { TOOL_DEFINITIONS } = await import("./tools.js");
const { TOOL_ARGUMENT_SPECS } = await import("./validation.js");
const { MAINNET_GATED_TOOLS } = await import("./mainnetGuardrails.js");
const { paidOperationClass } = await import("./paidOperations.js");
const { TOOL_SIDE_EFFECTS, expectedAnnotationHints, requiresMainnetGate } =
  await import("./toolSideEffects.js");

type ArgumentSpecs = typeof TOOL_ARGUMENT_SPECS;
type ArgumentSpec = ArgumentSpecs[string][string];

/** Soroban JSON-RPC methods that only read. Anything else (sendTransaction) writes. */
const RPC_READS = new Set([
  "getTransaction",
  "getTransactions",
  "simulateTransaction",
  "getLedgerEntries",
  "getLatestLedger",
  "getNetwork",
  "getHealth",
  "getEvents",
  "getFeeStats",
  "getVersionInfo",
]);

function isReadRequest(request: RecordedRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  return request.rpcMethod !== undefined && RPC_READS.has(request.rpcMethod);
}

/** path → size, mtime, and content digest of every file under `root`. */
function snapshotFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        const stat = statSync(path);
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        files.set(relative(root, path), `${stat.size}:${stat.mtimeMs}:${digest}`);
      }
    }
  };
  walk(root);
  return files;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, signature] of after) {
    if (before.get(path) !== signature) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(`${path} (deleted)`);
  }
  return changed.sort();
}

/** Arguments that pass validation, so the probe reaches the handler. */
function sampleValue(spec: ArgumentSpec): unknown {
  switch (spec.kind) {
    case "flag":
      return true;
    case "integer":
      return spec.min ?? 1;
    case "enum":
      return spec.values?.[0] ?? "";
    case "hash":
      return "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    case "tag_array":
      return ["sample"];
    case "string_array":
      return ["mock-1"];
    case "string":
      return "mock-1";
  }
}

/** Per-tool arguments the generic samples cannot satisfy, or that widen the probe. */
const PROBE_OVERRIDES: Record<string, Record<string, unknown>> = {
  mindvault_tx_status: { txHash: "a".repeat(64) },
  mindvault_compare_state_backup: { blob: "not-a-backup", passphrase: "probe-passphrase" },
  mindvault_debug_bundle: { includeEnvironment: true },
  mindvault_publish_status: { resourceId: "mock-1" },
  mindvault_purchase_history: {},
  mindvault_export_receipts: { format: "csv" },
};

function probeArgs(name: string): Record<string, unknown> {
  const spec = TOOL_ARGUMENT_SPECS[name] ?? {};
  const args: Record<string, unknown> = {};
  for (const [field, fieldSpec] of Object.entries(spec)) {
    if (fieldSpec.required) args[field] = sampleValue(fieldSpec);
  }
  return { ...args, ...(PROBE_OVERRIDES[name] ?? {}) };
}

/** Dispatch and observe; a handler error is fine, only side effects matter here. */
async function observe(
  name: string,
  args: Record<string, unknown>,
): Promise<{ files: string[]; writes: RecordedRequest[] }> {
  const before = snapshotFiles(home);
  const start = requests.length;
  try {
    await dispatchTool(name, args);
  } catch {
    // Missing wallet, unreachable service, bad sample id: the call still had
    // every chance to write before it failed.
  }
  return {
    files: changedFiles(before, snapshotFiles(home)),
    writes: requests.slice(start).filter((request) => !isReadRequest(request)),
  };
}

beforeAll(async () => {
  // Probe against populated state, not an empty home: a read that re-saves
  // the state file or touches a store only shows up when there is one.
  await dispatchTool("mindvault_setup_wallet", {});
  expect(existsSync(join(home, ".mindvault"))).toBe(true);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("side-effect inventory covers the surface", () => {
  it("has exactly one row per advertised tool", () => {
    const advertised = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(Object.keys(TOOL_SIDE_EFFECTS).sort()).toEqual(advertised);
  });
});

describe("annotations agree with the side-effect inventory", () => {
  it.each(TOOL_DEFINITIONS.map((t) => [t.name, t] as const))("%s", (name, tool) => {
    const effects = TOOL_SIDE_EFFECTS[name];
    expect(effects, `${name} has a side-effect row`).toBeDefined();
    const expected = expectedAnnotationHints(effects);
    expect(
      {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
      },
      `${name} annotations contradict its side effects ${JSON.stringify(effects)}`,
    ).toEqual(expected);
  });

  it("never advertises a tool that pays as idempotent-and-read-only", () => {
    for (const tool of TOOL_DEFINITIONS) {
      if (TOOL_SIDE_EFFECTS[tool.name]?.payment !== "none") {
        expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
      }
      if (TOOL_SIDE_EFFECTS[tool.name]?.payment === "usdc") {
        // Repeating a USDC spend pays again.
        expect(tool.annotations.idempotentHint, tool.name).toBe(false);
      }
    }
  });
});

describe("guardrails agree with the side-effect inventory", () => {
  it.each(Object.entries(TOOL_SIDE_EFFECTS))("%s payment class", (name, effects) => {
    const declared = paidOperationClass(name) ?? "none";
    expect(declared, `${name} spends ${effects.payment} but is classified ${declared}`).toBe(
      effects.payment,
    );
  });

  it("mainnet-gates every tool that submits a transaction or pays", () => {
    const gated = new Set<string>(MAINNET_GATED_TOOLS);
    const ungated = Object.entries(TOOL_SIDE_EFFECTS)
      .filter(([name, effects]) => requiresMainnetGate(effects) && !gated.has(name))
      .map(([name]) => name);
    expect(ungated).toEqual([]);
  });

  it("only charges for tools that reach the network", () => {
    for (const [name, effects] of Object.entries(TOOL_SIDE_EFFECTS)) {
      if (effects.payment !== "none") expect(effects.remote, name).not.toBe("none");
    }
  });
});

describe("handlers declared side-effect free really are", () => {
  const sideEffectFree = Object.entries(TOOL_SIDE_EFFECTS)
    .filter(([, e]) => e.local === "none" && e.remote === "none" && e.payment === "none")
    .map(([name]) => name);

  it("probes every read-only tool", () => {
    const readOnly = TOOL_DEFINITIONS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(sideEffectFree.sort()).toEqual(readOnly.sort());
  });

  it.each(sideEffectFree)("%s writes no file and makes only read requests", async (name) => {
    const { files, writes } = await observe(name, probeArgs(name));
    expect(files, `${name} changed local files`).toEqual([]);
    expect(writes, `${name} made a non-read request`).toEqual([]);
  });

  it("detects a local write, so the probe is not vacuous", async () => {
    // mindvault_backup_state was advertised read-only while writing this file.
    expect(TOOL_SIDE_EFFECTS.mindvault_backup_state.local).toBe("write");
    const { files } = await observe("mindvault_backup_state", {
      passphrase: "probe-passphrase",
      confirm: true,
    });
    expect(files.some((path) => path.includes("backups"))).toBe(true);
  });

  it("detects a remote write, so the probe is not vacuous", async () => {
    const { writes } = await observe("mindvault_register", {
      name: "Probe",
      email: "probe@example.com",
    });
    expect(writes.length).toBeGreaterThan(0);
  });
});
