/**
 * Tests for read-only mode (#593).
 *
 * Two layers, because read-only mode is only useful if both hold:
 *
 *   - the pure decisions in `readOnlyMode.ts` (parsing, classification, the
 *     refusal text), which need no server; and
 *   - the wiring, checked through the SDK client over a real transport, since
 *     a correct decision that the dispatcher never consults protects nothing.
 *
 * The second layer is the one that matters. Narrowing ListTools is a
 * convenience — it keeps an agent from planning around a tool it cannot use —
 * but a client with a cached tool list, or one that simply guesses a name, will
 * still call it. The gate that enforces the mode is the one in dispatch, so
 * these tests call withheld tools directly rather than trusting the listing.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  READ_ONLY_ENV_VAR,
  assertToolAllowedInReadOnlyMode,
  filterToolsForReadOnlyMode,
  formatReadOnlyDiagnostics,
  isReadOnlyTool,
  readOnlyModeEnabled,
  readOnlyRefusalError,
  readOnlyToolNames,
} from "./readOnlyMode.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import {
  harnessIsToolError,
  harnessResultText,
  startIntegrationHarness,
} from "./integrationHarness.js";
import type { IntegrationHarness } from "./integrationHarness.js";

process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const home = mkdtempSync(join(tmpdir(), "mindvault-mcp-readonly-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { server, dispatchTool } = await import("./index.js");

// ── Pure decisions ───────────────────────────────────────────────────────────

describe("readOnlyModeEnabled", () => {
  it("is off when the variable is unset", () => {
    expect(readOnlyModeEnabled({})).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on", " 1 "])("is on for %j", (value) => {
    expect(readOnlyModeEnabled({ [READ_ONLY_ENV_VAR]: value })).toBe(true);
  });

  it.each(["0", "false", "no", "off", ""])("is off for %j", (value) => {
    expect(readOnlyModeEnabled({ [READ_ONLY_ENV_VAR]: value })).toBe(false);
  });

  it("treats an unrecognized value as off rather than guessing", () => {
    // Failing open is the right default *here*: an operator who never meant to
    // enable read-only mode gets exactly the behaviour they had before the
    // variable existed, instead of a server that silently refuses to work.
    expect(readOnlyModeEnabled({ [READ_ONLY_ENV_VAR]: "maybe" })).toBe(false);
  });
});

describe("isReadOnlyTool", () => {
  it("follows the readOnlyHint each tool declares", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(isReadOnlyTool(tool.name), tool.name).toBe(tool.annotations.readOnlyHint);
    }
  });

  it("classifies the catalog browsing tools as read-only", () => {
    for (const name of [
      "mindvault_browse",
      "mindvault_search",
      "mindvault_preview",
      "mindvault_registry_lookup",
      "mindvault_registry_list",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(true);
    }
  });

  it("classifies spending and state-clearing tools as not read-only", () => {
    for (const name of [
      "mindvault_buy",
      "mindvault_publish",
      "mindvault_reset",
      "mindvault_restore_state",
      "mindvault_import_wallet",
      "mindvault_rotate_publisher_key",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(false);
    }
  });

  it("fails closed on an unknown name", () => {
    // A safety boundary must not admit a name it has never heard of.
    expect(isReadOnlyTool("mindvault_not_a_tool")).toBe(false);
  });
});

describe("filterToolsForReadOnlyMode", () => {
  const tools = [{ name: "mindvault_browse" }, { name: "mindvault_buy" }];

  it("passes everything through when the mode is off", () => {
    expect(filterToolsForReadOnlyMode(tools, {})).toEqual(tools);
  });

  it("keeps only read-only tools when the mode is on", () => {
    expect(filterToolsForReadOnlyMode(tools, { [READ_ONLY_ENV_VAR]: "1" })).toEqual([
      { name: "mindvault_browse" },
    ]);
  });

  it("returns a copy rather than the caller's array", () => {
    const result = filterToolsForReadOnlyMode(tools, {});
    expect(result).not.toBe(tools);
  });
});

describe("assertToolAllowedInReadOnlyMode", () => {
  const on = { [READ_ONLY_ENV_VAR]: "1" };

  it("allows anything when the mode is off", () => {
    expect(() => assertToolAllowedInReadOnlyMode("mindvault_buy", {})).not.toThrow();
  });

  it("allows read-only tools when the mode is on", () => {
    expect(() => assertToolAllowedInReadOnlyMode("mindvault_browse", on)).not.toThrow();
  });

  it("refuses mutating tools when the mode is on", () => {
    expect(() => assertToolAllowedInReadOnlyMode("mindvault_buy", on)).toThrow(/Read-only mode/);
  });
});

describe("readOnlyRefusalError", () => {
  const message = readOnlyRefusalError("mindvault_buy").message;

  it("names the tool and the variable that caused the refusal", () => {
    expect(message).toContain("mindvault_buy");
    expect(message).toContain(READ_ONLY_ENV_VAR);
  });

  it("tells the agent what it can still do", () => {
    expect(message).toContain("mindvault_browse");
    expect(message).toContain("mindvault_search");
  });

  it("says the restriction cannot be lifted from a tool call", () => {
    // The distinction from the mainnet guardrail, which *is* per-call
    // overridable. An agent that retries with a confirmation flag here would
    // just fail twice.
    expect(message).toMatch(/no tool argument can override it/i);
  });

  it("is deterministic and leaks nothing", () => {
    expect(readOnlyRefusalError("mindvault_buy").message).toBe(message);
    expect(message).not.toMatch(/\/(home|Users|tmp)\//);
    expect(message).not.toContain("at ");
  });
});

describe("formatReadOnlyDiagnostics", () => {
  it("reports the mode as off and how to turn it on", () => {
    expect(formatReadOnlyDiagnostics({})).toMatch(/off/);
    expect(formatReadOnlyDiagnostics({})).toContain(READ_ONLY_ENV_VAR);
  });

  it("reports the mode as on with the number of tools left", () => {
    const line = formatReadOnlyDiagnostics({ [READ_ONLY_ENV_VAR]: "1" });
    expect(line).toMatch(/ON/);
    expect(line).toContain(String(readOnlyToolNames().length));
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe("read-only mode through the MCP server", () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await startIntegrationHarness(server);
  });

  afterAll(async () => {
    // Also clear it here, not only in afterEach: vitest may place another file
    // in this worker, and a suite that died mid-run would otherwise leak the
    // variable into it.
    delete process.env[READ_ONLY_ENV_VAR];
    await harness?.close();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env[READ_ONLY_ENV_VAR];
  });

  it("advertises the full surface when the mode is off", async () => {
    const { tools } = await harness.listTools();
    expect(tools.some((t) => t.name === "mindvault_buy")).toBe(true);
    expect(tools.some((t) => t.name === "mindvault_browse")).toBe(true);
  });

  it("advertises only read-only tools when the mode is on", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const { tools } = await harness.listTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(isReadOnlyTool(tool.name), `${tool.name} is advertised in read-only mode`).toBe(true);
    }
    expect(tools.some((t) => t.name === "mindvault_browse")).toBe(true);
    expect(tools.some((t) => t.name === "mindvault_buy")).toBe(false);
    expect(tools.some((t) => t.name === "mindvault_reset")).toBe(false);
  });

  it("re-reads the environment on every ListTools call", async () => {
    // The handler is not allowed to snapshot the mode at module load: the
    // listing has to reflect what dispatch will actually enforce.
    const before = (await harness.listTools()).tools.length;
    process.env[READ_ONLY_ENV_VAR] = "1";
    const during = (await harness.listTools()).tools.length;
    delete process.env[READ_ONLY_ENV_VAR];
    const after = (await harness.listTools()).tools.length;

    expect(during).toBeLessThan(before);
    expect(after).toBe(before);
  });

  it("still browses the catalog in read-only mode", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const result = await harness.callTool("mindvault_browse", {});

    expect(harnessIsToolError(result)).toBe(false);
    expect(harnessResultText(result)).toContain("mock-1");
  });

  it("still previews a resource in read-only mode", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const result = await harness.callTool("mindvault_preview", { resourceId: "mock-1" });

    expect(harnessIsToolError(result)).toBe(false);
  });

  it("refuses a withheld tool that a client calls anyway", async () => {
    // The case the ListTools filter cannot cover: a stale tool list, or a
    // client guessing the name. This is the check that makes the mode a
    // guarantee rather than a hint.
    process.env[READ_ONLY_ENV_VAR] = "1";
    const result = await harness.callTool("mindvault_buy", { resourceId: "mock-1" });

    expect(harnessIsToolError(result)).toBe(true);
    expect(harnessResultText(result)).toContain("Read-only mode");
  });

  it("refuses every non-read-only tool, not just the spending ones", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    for (const name of ["mindvault_reset", "mindvault_setup_wallet", "mindvault_restore_state"]) {
      await expect(dispatchTool(name, {}), name).rejects.toThrow(/Read-only mode/);
    }
  });

  it("refuses before validating arguments", async () => {
    // A malformed-arguments error would be misleading when the server was never
    // going to run the tool: the agent would "fix" the arguments and fail again.
    process.env[READ_ONLY_ENV_VAR] = "1";
    await expect(dispatchTool("mindvault_buy", { resourceId: "" })).rejects.toThrow(
      /Read-only mode/,
    );
  });

  it("refuses a dry run too", async () => {
    // A dry run spends nothing, but read-only mode is about what this server is
    // *for*, not about cost — and the paid-operation policy is the guardrail
    // that exempts dry runs.
    process.env[READ_ONLY_ENV_VAR] = "1";
    await expect(
      dispatchTool("mindvault_buy", { resourceId: "mock-1", dryRun: true }),
    ).rejects.toThrow(/Read-only mode/);
  });

  it("restores the full surface once the mode is turned off", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    await expect(dispatchTool("mindvault_reset", {})).rejects.toThrow(/Read-only mode/);

    delete process.env[READ_ONLY_ENV_VAR];
    await expect(dispatchTool("mindvault_reset", {})).resolves.toBeTypeOf("string");
  });
});
