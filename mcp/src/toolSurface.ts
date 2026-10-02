/**
 * The advertised tool surface — what ListTools returns (#596).
 *
 * `tools.ts` says of itself that it is "the single source of truth for the tool
 * surface advertised to agent clients", and `scripts/generate-tool-docs.ts`
 * builds `docs/mcp-tool-reference.md` on that promise. It was not true: the
 * ListTools handler in `index.ts` carried its own ~490-line literal copy of the
 * list, and the two drifted apart in every direction at once —
 *
 *   - Six implemented, documented, validated tools (`mindvault_update_metadata`,
 *     `mindvault_set_price`, `mindvault_transfer_ownership`,
 *     `mindvault_set_listed`, `mindvault_export_receipts`,
 *     `mindvault_recover_catalog_cache`) were missing from the copy, so no
 *     agent could discover them.
 *   - `mindvault_publish_status` and `mindvault_purchase_history` existed only
 *     in the copy, so the generated reference page never mentioned them.
 *   - The copy's schemas for `mindvault_register`, `mindvault_publish`,
 *     `mindvault_buy` and others had lost their per-field descriptions and
 *     examples, and `mindvault_publish`/`mindvault_buy` no longer advertised
 *     `dryRun` or `maxAutoPayUsdc` at all.
 *
 * Deriving the surface here makes the promise structural instead of
 * aspirational: there is one list, and `listToolsContract.test.ts` checks it
 * against the three other places a tool has to be registered (the argument
 * validator, the dispatch switch, and the annotation/output-schema maps).
 *
 * Two filters sit between the definitions and the wire, and both are deliberate:
 * tools with no handler are withheld, and read-only mode narrows the surface to
 * browsing (#593).
 */

import { filterToolsForReadOnlyMode } from "./readOnlyMode.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tools.js";

/**
 * Tools that are defined and validated but have no dispatch handler.
 *
 * This is a ledger of known gaps, not a place to park new tools.
 * `listToolsContract.test.ts` asserts it names exactly the tools that are
 * missing a handler, so every new definition must be either implemented or
 * explicitly withheld.
 */
export const TOOLS_WITHOUT_HANDLERS: readonly string[] = [];

const WITHOUT_HANDLERS: ReadonlySet<string> = new Set(TOOLS_WITHOUT_HANDLERS);

/**
 * The tool definitions this build can actually serve, before any environment
 * filtering. Ordering follows `TOOL_DEFINITIONS` so ListTools stays stable
 * across calls and diffs stay readable.
 */
export function servableToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((tool) => !WITHOUT_HANDLERS.has(tool.name));
}

/** One tool exactly as it goes out over ListTools. */
export interface AdvertisedToolDescriptor {
  name: string;
  description: string;
  inputSchema: ToolDefinition["inputSchema"];
  annotations: ToolDefinition["annotations"];
  outputSchema?: Record<string, unknown>;
}

/**
 * Build the ListTools payload for an environment.
 *
 * `outputSchema` is omitted rather than set to `undefined` for tools that
 * declare none: MCP treats an absent key and a null-valued one differently, and
 * `toolSchemaSnapshots.test.ts` pins the distinction.
 */
export function advertisedTools(env: NodeJS.ProcessEnv = process.env): AdvertisedToolDescriptor[] {
  return filterToolsForReadOnlyMode(servableToolDefinitions(), env).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  }));
}

/** Look up one definition by name, or `undefined` when there is none. */
export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

/** The output schema advertised for a tool, or `undefined` when it declares none. */
export function outputSchemaFor(name: string): Record<string, unknown> | undefined {
  return toolDefinition(name)?.outputSchema;
}

/** Whether a tool declares structured output. */
export function hasOutputSchema(name: string): boolean {
  return outputSchemaFor(name) !== undefined;
}
