/**
 * Snapshot tests for MCP tool metadata (the ListTools response).
 *
 * Verifies that the tool list exposed to agent clients stays deterministic and
 * complete. Snapshots capture the shape of the most commonly used tools
 * (mindvault_search, mindvault_publish) to prevent regressions when updating
 * descriptions or examples.
 *
 * Full ListTools coverage through the SDK lives in `integration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./tools.js";
import { catalogFilterInputProperties } from "./catalogFilters.js";
import { TEXT_ONLY_TOOLS } from "./outputSchemas.js";

describe("MCP tool metadata", () => {
  it("all tools have required fields", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^mindvault_/);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("every tool declares MCP annotations with a title (#552)", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const annotations = tool.annotations;
      expect(annotations, `tool ${tool.name} has annotations`).toBeDefined();
      expect(typeof annotations.title, `tool ${tool.name} has a title`).toBe("string");
      expect(annotations.title.length).toBeGreaterThan(0);
      expect(typeof annotations.readOnlyHint).toBe("boolean");
      expect(typeof annotations.destructiveHint).toBe("boolean");
      expect(typeof annotations.idempotentHint).toBe("boolean");
    }
  });

  it("read-only tools are not marked destructive (#552)", () => {
    const readOnlyTools = TOOL_DEFINITIONS.filter((tool) => tool.annotations.readOnlyHint);
    expect(readOnlyTools.length).toBeGreaterThan(0);
    for (const tool of readOnlyTools) {
      expect(
        tool.annotations.destructiveHint,
        `read-only tool ${tool.name} is not destructive`,
      ).toBe(false);
    }
  });

  it("destructive tools are not marked read-only (#552)", () => {
    const destructiveTools = TOOL_DEFINITIONS.filter((tool) => tool.annotations.destructiveHint);
    expect(destructiveTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["mindvault_reset", "mindvault_restore_state"]),
    );
    for (const tool of destructiveTools) {
      expect(tool.annotations.readOnlyHint, `destructive tool ${tool.name} is not read-only`).toBe(
        false,
      );
    }
  });

  it("exposes the expected tool surface", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toMatchSnapshot();
  });

  it("mindvault_search inputSchema", () => {
    const searchSchema = {
      type: "object",
      properties: { ...catalogFilterInputProperties },
      required: [],
    };

    expect(searchSchema).toMatchSnapshot();
  });

  it("structured tools declare outputSchema and text-only tools do not (#553)", () => {
    for (const tool of TOOL_DEFINITIONS) {
      if ((TEXT_ONLY_TOOLS as readonly string[]).includes(tool.name)) {
        expect(tool.outputSchema, `${tool.name} should stay text-only`).toBeUndefined();
      } else {
        expect(tool.outputSchema, `${tool.name} should advertise outputSchema`).toBeDefined();
      }
    }
  });

  it("mindvault_publish inputSchema", () => {
    // Snapshot the definition itself, not a copy of it: a hand-written literal
    // drifts from the real schema and then snapshots its own drift.
    const publish = TOOL_DEFINITIONS.find((t) => t.name === "mindvault_publish");
    expect(publish?.inputSchema).toMatchSnapshot();
  });
});
