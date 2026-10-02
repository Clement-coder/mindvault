/**
 * ListTools contract drift check (#596).
 *
 * A tool is not one declaration but four, spread across four files:
 *
 *   1. `tools.ts`       — the definition (description, input schema, annotations)
 *   2. `validation.ts`  — the argument spec the dispatcher validates against
 *   3. `index.ts`       — the `case` in the dispatch switch that runs it
 *   4. `outputSchemas.ts` — the structured-output schema, when it declares one
 *
 * Any one can be added without the others, and nothing about adding it fails.
 * The tool is simply broken in a way that only shows up when an agent calls it:
 * undiscoverable, or advertised but unimplemented, or advertised with arguments
 * the validator rejects.
 *
 * Every one of those had happened before this test existed, because the
 * ListTools handler in index.ts carried a hand-maintained copy of (1):
 *
 *   - `mindvault_update_metadata`, `mindvault_set_price`,
 *     `mindvault_transfer_ownership`, `mindvault_set_listed`,
 *     `mindvault_export_receipts` and `mindvault_recover_catalog_cache` were
 *     implemented, validated and documented, but absent from the copy — so no
 *     agent could discover them.
 *   - `mindvault_publish_status` and `mindvault_purchase_history` existed only
 *     in the copy, so `docs/mcp-tool-reference.md` (generated from `tools.ts`)
 *     never listed them.
 *   - `mindvault_reset` advertised a `confirm` argument that `resetGuard` reads
 *     and `TOOL_ARGUMENT_SPECS` did not declare, so every confirmed reset was
 *     rejected as an unknown argument and the tool could never do anything.
 *   - `mindvault_publish` and `mindvault_buy` had quietly stopped advertising
 *     `dryRun` and `maxAutoPayUsdc`.
 *
 * The copy is gone (`toolSurface.ts` derives the response from
 * `TOOL_DEFINITIONS`), which removes the *cause*. These tests cover the
 * *category*: they assert the four declarations agree, against the response a
 * real client gets over a real transport rather than against the arrays that
 * produce it.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAINNET_GATED_TOOLS } from "./mainnetGuardrails.js";
import { paidOperationToolNames } from "./paidOperations.js";
import { TEXT_ONLY_TOOLS } from "./outputSchemas.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { TOOLS_WITHOUT_HANDLERS, servableToolDefinitions } from "./toolSurface.js";
import {
  TOOL_ARGUMENT_SPECS,
  TOOLS_WITHOUT_ARG_VALIDATION,
  type ArgumentSpec,
} from "./validation.js";
import { startIntegrationHarness, type IntegrationHarness } from "./integrationHarness.js";

process.env.MINDVAULT_MOCK = "1";
process.env.STELLAR_NETWORK = "testnet";
const home = mkdtempSync(join(tmpdir(), "mindvault-mcp-contract-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { server, dispatchTool } = await import("./index.js");

/** One tool exactly as a client receives it from ListTools. */
interface WireTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

let harness: IntegrationHarness;
let wireTools: WireTool[];
let byName: Map<string, WireTool>;

beforeAll(async () => {
  harness = await startIntegrationHarness(server);
  wireTools = (await harness.listTools()).tools as WireTool[];
  byName = new Map(wireTools.map((tool) => [tool.name, tool]));
});

afterAll(async () => {
  await harness?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("ListTools ↔ TOOL_DEFINITIONS", () => {
  it("advertises every servable definition, and nothing else", () => {
    expect(wireTools.map((t) => t.name).sort()).toEqual(
      servableToolDefinitions()
        .map((t) => t.name)
        .sort(),
    );
  });

  it("sends each tool's definition verbatim", () => {
    // The whole point of deriving the response: description and schema on the
    // wire are the same objects the generated docs and the snapshots read.
    for (const definition of servableToolDefinitions()) {
      const wire = byName.get(definition.name);
      expect(wire, `${definition.name} is advertised`).toBeDefined();
      expect(wire?.description, `${definition.name} description`).toBe(definition.description);
      expect(wire?.inputSchema, `${definition.name} inputSchema`).toEqual(definition.inputSchema);
      expect(wire?.annotations, `${definition.name} annotations`).toEqual(definition.annotations);
    }
  });

  it("advertises outputSchema exactly when the definition declares one", () => {
    for (const definition of servableToolDefinitions()) {
      const wire = byName.get(definition.name);
      if (definition.outputSchema) {
        expect(wire?.outputSchema, `${definition.name} advertises its output schema`).toEqual(
          definition.outputSchema,
        );
      } else {
        // Absent, not `undefined`: MCP clients distinguish the two, and a tool
        // that grows a null-valued outputSchema fails structured-content checks.
        expect(wire && "outputSchema" in wire, `${definition.name} declares no output schema`).toBe(
          false,
        );
      }
    }
  });

  it("keeps TEXT_ONLY_TOOLS free of a structured-output schema", () => {
    for (const name of TEXT_ONLY_TOOLS) {
      const wire = byName.get(name);
      if (!wire) continue; // withheld tools are covered separately
      expect(wire.outputSchema, `${name} must stay text-only`).toBeUndefined();
    }
  });

  it("returns a stable list across repeated calls", async () => {
    const again = (await harness.listTools()).tools as WireTool[];
    expect(again.map((t) => t.name)).toEqual(wireTools.map((t) => t.name));
  });
});

/**
 * Minimal arguments that satisfy one argument spec.
 *
 * The reachability probes below have to get *past* the validator to learn
 * anything about the dispatch switch: a tool with required arguments called
 * with `{}` fails validation long before the `switch`, so a missing handler
 * would go unnoticed. Building the arguments from the spec rather than
 * hand-listing them per tool means a new required argument does not silently
 * turn these checks back into no-ops.
 */
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
      return ["contract-probe"];
    case "string":
      // `contract-probe` satisfies every string pattern in use (resource ids,
      // profile names, metadata pointers are all covered by the looser ones);
      // the few with a stricter pattern are listed in SAMPLE_OVERRIDES.
      return "contract-probe";
  }
}

/** Specs whose pattern the generic string sample cannot satisfy. */
const SAMPLE_OVERRIDES: Record<string, Record<string, unknown>> = {
  mindvault_register: { email: "probe@example.com" },
  mindvault_publish: { price: "1.00", externalUrl: "https://example.com/probe" },
  mindvault_set_price: { price: "1.00" },
  mindvault_transfer_ownership: {
    newCreator: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
  },
  mindvault_update_metadata: { metadata: "ipfs://QmProbe" },
  mindvault_freeze: { confirm: "freeze_metadata" },
  mindvault_royalty: {
    royaltyRecipient: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
  },
  mindvault_import_wallet: {
    secretKey: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  mindvault_publish_batch: {
    items: [{ title: "Probe Resource", price: "1.00", externalUrl: "https://example.com/probe" }],
  },
};

/** A value satisfying one advertised JSON Schema property. */
function sampleFromSchema(property: unknown): unknown {
  const type = (property as { type?: string } | undefined)?.type;
  if (type === "boolean") return true;
  if (type === "number" || type === "integer") return 1;
  return "contract-probe";
}

/**
 * Arguments that pass validation for `name`, so dispatch reaches the switch.
 *
 * Tools in TOOLS_WITHOUT_ARG_VALIDATION have no spec to read, so their
 * required arguments come from the advertised schema instead — they normalize
 * their own input and raise on a missing field just as the validator would.
 */
function probeArgs(name: string): Record<string, unknown> {
  const overrides = SAMPLE_OVERRIDES[name] ?? {};
  const spec = TOOL_ARGUMENT_SPECS[name];

  if (spec) {
    const args: Record<string, unknown> = {};
    for (const [field, fieldSpec] of Object.entries(spec)) {
      if (fieldSpec.required) args[field] = sampleValue(fieldSpec);
    }
    return { ...args, ...overrides };
  }

  const schema = byName.get(name)?.inputSchema;
  const args: Record<string, unknown> = {};
  for (const field of schema?.required ?? []) {
    args[field] = sampleFromSchema(schema?.properties?.[field]);
  }
  return { ...args, ...overrides };
}

describe("ListTools ↔ the dispatcher", () => {
  /**
   * `Unknown tool: <name>` is what the `default` arm of the dispatch switch
   * raises for a name it has no `case` for. Any other outcome — success, a
   * network failure, a missing wallet — means the tool was reached and failed
   * on its own terms, which is all this check needs to establish.
   */
  async function isReachable(name: string): Promise<boolean> {
    try {
      await dispatchTool(name, probeArgs(name));
      return true;
    } catch (err) {
      const message = (err as Error).message;
      // A validation failure means the probe arguments were wrong, not that the
      // tool is unreachable — fail loudly rather than reporting a false pass.
      if (/not a recognized argument|is required|Invalid arguments/i.test(message)) {
        throw new Error(`probe arguments for ${name} did not validate: ${message}`);
      }
      return !/^Unknown tool:/.test(message);
    }
  }

  it("advertises no tool the dispatcher cannot reach", async () => {
    const unreachable: string[] = [];
    for (const tool of wireTools) {
      if (!(await isReachable(tool.name))) unreachable.push(tool.name);
    }
    expect(unreachable).toEqual([]);
  });

  it("withholds exactly the tools that have no handler", async () => {
    // Both directions. A definition that gains a handler must leave
    // TOOLS_WITHOUT_HANDLERS, and one that loses its handler must not be left
    // advertised — an agent calling an advertised tool and getting
    // `Unknown tool` learns nothing it can act on.
    const withheld: string[] = [];
    for (const definition of TOOL_DEFINITIONS) {
      if (!(await isReachable(definition.name))) withheld.push(definition.name);
    }
    expect(withheld.sort()).toEqual([...TOOLS_WITHOUT_HANDLERS].sort());
    for (const name of TOOLS_WITHOUT_HANDLERS) {
      expect(byName.has(name), `${name} has no handler and must not be advertised`).toBe(false);
    }
  });
});

describe("ListTools ↔ the argument validator", () => {
  it("gives every advertised tool a validation spec, or a declared exemption", () => {
    const exempt = new Set(TOOLS_WITHOUT_ARG_VALIDATION);
    for (const tool of wireTools) {
      if (exempt.has(tool.name)) continue;
      expect(TOOL_ARGUMENT_SPECS, `${tool.name} is advertised but not validated`).toHaveProperty(
        tool.name,
      );
    }
  });

  it("validates no tool that is not advertised", () => {
    // A spec for a tool nobody can call is dead weight that still has to be
    // maintained; more usefully, this catches a tool dropped from the surface
    // while the rest of its wiring stayed behind.
    const advertised = new Set(wireTools.map((t) => t.name));
    const withheld = new Set(TOOLS_WITHOUT_HANDLERS);
    for (const name of Object.keys(TOOL_ARGUMENT_SPECS)) {
      if (withheld.has(name)) continue;
      expect(advertised.has(name), `${name} is validated but not advertised`).toBe(true);
    }
  });

  it("advertises exactly the arguments the validator accepts", () => {
    // The `mindvault_reset.confirm` failure: an argument advertised in the
    // schema and rejected by the validator makes the tool unusable, and an
    // argument the validator accepts but the schema hides is undiscoverable.
    const exempt = new Set(TOOLS_WITHOUT_ARG_VALIDATION);
    for (const tool of wireTools) {
      if (exempt.has(tool.name)) continue;
      const spec = TOOL_ARGUMENT_SPECS[tool.name];
      expect(
        Object.keys(tool.inputSchema?.properties ?? {}).sort(),
        `${tool.name} arguments`,
      ).toEqual(Object.keys(spec).sort());
    }
  });

  it("advertises exactly the arguments the validator requires", () => {
    const exempt = new Set(TOOLS_WITHOUT_ARG_VALIDATION);
    for (const tool of wireTools) {
      if (exempt.has(tool.name)) continue;
      const required = Object.entries(TOOL_ARGUMENT_SPECS[tool.name])
        .filter(([, argSpec]) => argSpec.required)
        .map(([field]) => field);
      expect([...(tool.inputSchema?.required ?? [])].sort(), `${tool.name} required`).toEqual(
        required.sort(),
      );
    }
  });

  it("rejects an unadvertised argument on an advertised tool", async () => {
    // The contract has to hold at call time, not only in the metadata: a
    // schema that lists an argument is a promise the dispatcher honours it.
    await expect(
      dispatchTool("mindvault_registry_lookup", { resourceId: "mock-1", nonsense: true }),
    ).rejects.toThrow(/not a recognized argument/i);
  });

  it("accepts every argument mindvault_reset advertises", async () => {
    // Regression for the drift that made `confirm` unusable: the guard read it,
    // ListTools advertised it, and the validator threw on it.
    const properties = Object.keys(byName.get("mindvault_reset")?.inputSchema?.properties ?? {});
    expect(properties).toContain("confirm");
    await expect(dispatchTool("mindvault_reset", { confirm: true })).resolves.toBeTypeOf("string");
  });
});

describe("ListTools ↔ the guardrails", () => {
  it("gates only tools that exist on the surface", () => {
    const known = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const name of MAINNET_GATED_TOOLS) {
      expect(known.has(name), `mainnet-gated ${name} has no definition`).toBe(true);
    }
    for (const name of paidOperationToolNames()) {
      expect(known.has(name), `paid-gated ${name} has no definition`).toBe(true);
    }
  });

  it("never gates a tool it also advertises as read-only", () => {
    // A read-only tool spends nothing and mutates nothing, so gating one would
    // be a contradiction between the annotation and the guardrail — and agents
    // do plan around `readOnlyHint`.
    const readOnly = new Set(
      wireTools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
    );
    for (const name of [...MAINNET_GATED_TOOLS, ...paidOperationToolNames()]) {
      expect(readOnly.has(name), `${name} is gated but advertised read-only`).toBe(false);
    }
  });

  it("advertises the confirmation argument every gated tool needs", () => {
    for (const name of MAINNET_GATED_TOOLS) {
      const properties = byName.get(name)?.inputSchema?.properties ?? {};
      expect(properties, `${name} advertises confirmMainnet`).toHaveProperty("confirmMainnet");
    }
    for (const name of paidOperationToolNames()) {
      const properties = byName.get(name)?.inputSchema?.properties ?? {};
      expect(properties, `${name} advertises confirmPaid`).toHaveProperty("confirmPaid");
    }
  });
});

describe("advertised annotations", () => {
  it("declares complete annotations on every tool", () => {
    for (const tool of wireTools) {
      expect(typeof tool.annotations?.title, `${tool.name} title`).toBe("string");
      expect(tool.annotations?.title?.length).toBeGreaterThan(0);
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(
        "boolean",
      );
      expect(typeof tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBe(
        "boolean",
      );
    }
  });

  it("never marks a tool both read-only and destructive", () => {
    for (const tool of wireTools) {
      if (tool.annotations?.readOnlyHint) {
        expect(tool.annotations.destructiveHint, `${tool.name}`).toBe(false);
      }
    }
  });

  it("gives every tool a distinct title", () => {
    const titles = wireTools.map((t) => t.annotations?.title);
    expect(new Set(titles).size, "tool titles are shown to users and must disambiguate").toBe(
      titles.length,
    );
  });
});
