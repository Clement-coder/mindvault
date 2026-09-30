/**
 * Generated tool docs stay in step with TOOL_DEFINITIONS (#680).
 *
 * `toolDescriptions.test.ts` checks that every name and description is
 * present. These tests hold the stronger property the CI step enforces: the
 * committed files are byte-for-byte what the generator writes after the
 * repository's prettier pass, so a reordered group, a changed "Structured"
 * column, a dropped tool, or a hand edit all fail here and in CI alike.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";

import {
  GENERATED_MARKER,
  groupOf,
  renderToolReference,
  renderToolSummary,
  TOOL_DOC_TARGETS,
  TOOL_REFERENCE_PATH,
  TOOL_SUMMARY_PATH,
  toolDocFreshness,
} from "./toolDocs.js";
import { TOOL_DEFINITIONS } from "./tools.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function formatted(content: string, relativePath: string): Promise<string> {
  const filepath = join(repoRoot, relativePath);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(content, { ...options, filepath });
}

describe("renderers", () => {
  it("are deterministic", () => {
    expect(renderToolReference(TOOL_DEFINITIONS)).toBe(renderToolReference(TOOL_DEFINITIONS));
    expect(renderToolSummary(TOOL_DEFINITIONS)).toBe(renderToolSummary(TOOL_DEFINITIONS));
  });

  it("list every tool with its exact description", () => {
    const reference = renderToolReference(TOOL_DEFINITIONS);
    const summary = renderToolSummary(TOOL_DEFINITIONS);
    for (const tool of TOOL_DEFINITIONS) {
      expect(reference).toContain(`\`${tool.name}\``);
      expect(summary).toContain(`- \`${tool.name}\`: ${tool.description}`);
    }
    expect(reference).toContain(`**${TOOL_DEFINITIONS.length} tools**`);
    expect(summary).toContain(`(${TOOL_DEFINITIONS.length} tools)`);
  });

  it("mark both files as generated", () => {
    for (const target of TOOL_DOC_TARGETS) {
      expect(target.render(TOOL_DEFINITIONS)).toContain(GENERATED_MARKER);
    }
    expect(TOOL_DOC_TARGETS.map((t) => t.relativePath)).toEqual([
      TOOL_REFERENCE_PATH,
      TOOL_SUMMARY_PATH,
    ]);
  });

  it("place every tool in a named group", () => {
    const ungrouped = TOOL_DEFINITIONS.map((t) => t.name).filter((n) => groupOf(n) === "Other");
    // The catalog-cache recovery tool predates the grouping; nothing newer may
    // land in "Other" unnoticed.
    expect(ungrouped).toEqual(["mindvault_recover_catalog_cache"]);
  });
});

describe("toolDocFreshness", () => {
  it("distinguishes fresh, stale and missing", () => {
    expect(toolDocFreshness("a", "a")).toBe("fresh");
    expect(toolDocFreshness("a", "b")).toBe("stale");
    expect(toolDocFreshness(null, "b")).toBe("missing");
  });
});

describe.each(TOOL_DOC_TARGETS.map((t) => [t.relativePath, t] as const))(
  "%s",
  (relativePath, target) => {
    const absolute = join(repoRoot, relativePath);

    it.skipIf(!existsSync(absolute))(
      "is byte-for-byte what the generator writes (run: pnpm generate-tool-docs)",
      async () => {
        const expected = await formatted(target.render(TOOL_DEFINITIONS), relativePath);
        expect(readFileSync(absolute, "utf-8")).toBe(expected);
      },
    );
  },
);
