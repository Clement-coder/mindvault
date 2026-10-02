#!/usr/bin/env tsx
/**
 * Generate, or verify, the tool documentation derived from TOOL_DEFINITIONS in
 * src/tools.ts:
 *
 *   docs/mcp-tool-reference.md         grouped reference table
 *   mcp/GENERATED_MCP_TOOL_SUMMARY.md  flat summary shipped with the package
 *
 * The tool descriptions in tools.ts are the single source of truth: they are
 * what agent clients receive via ListTools and what operators need to
 * understand what each tool does. Both files are serialised from that array so
 * the docs cannot drift from the code without a check noticing.
 *
 * Usage:
 *   pnpm --filter @mindvault/mcp generate-tool-docs          # write both files
 *   pnpm --filter @mindvault/mcp check-tool-docs             # exit 1 if either is stale
 *
 * Output is passed through prettier with the repository configuration before
 * it is written or compared, because the commit hook (`lint-staged`) formats
 * every staged Markdown file: comparing against raw output would flag every
 * committed file as stale. The command is idempotent; running it twice
 * produces identical output. Commit the generated files so CI and contributors
 * always have them without running the command first.
 *
 * Freshness is enforced twice: `check-tool-docs` runs as a CI step, and
 * `src/toolDocs.test.ts` asserts the same equality under `pnpm test`. The
 * older heuristics in `src/toolDescriptions.test.ts` (every name and
 * description present, counts match) remain as a readable first line of
 * defence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

import { TOOL_DEFINITIONS } from "../src/tools.js";
import { REGENERATE_COMMAND, TOOL_DOC_TARGETS, toolDocFreshness } from "../src/toolDocs.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const checkOnly = process.argv.includes("--check");

/** Format exactly as `lint-staged` would for this path. */
async function formatForPath(content: string, relativePath: string): Promise<string> {
  const filepath = join(repoRoot, relativePath);
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(content, { ...options, filepath });
}

async function main(): Promise<void> {
  const mode = checkOnly ? "checking" : "generating";
  console.log(`MindVault MCP — ${mode} tool docs (${TOOL_DEFINITIONS.length} tools)`);

  let stale = 0;
  for (const target of TOOL_DOC_TARGETS) {
    const absolute = join(repoRoot, target.relativePath);
    const expected = await formatForPath(target.render(TOOL_DEFINITIONS), target.relativePath);

    if (!checkOnly) {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, expected, "utf-8");
      console.log(`  wrote ${target.relativePath}`);
      continue;
    }

    const committed = existsSync(absolute) ? readFileSync(absolute, "utf-8") : null;
    const freshness = toolDocFreshness(committed, expected);
    if (freshness === "fresh") {
      console.log(`  ✓ ${target.relativePath}`);
    } else {
      stale += 1;
      console.log(`  ✗ ${target.relativePath} is ${freshness}`);
    }
  }

  if (checkOnly) {
    if (stale > 0) {
      console.error(
        `\n${stale} generated tool doc(s) do not match src/tools.ts. Regenerate and commit:\n  ${REGENERATE_COMMAND}`,
      );
      process.exit(1);
    }
    console.log(`\n✓ ${TOOL_DOC_TARGETS.length} generated tool docs are up to date`);
    return;
  }

  console.log(`\n✓ Tool docs written (${TOOL_DEFINITIONS.length} tools)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
