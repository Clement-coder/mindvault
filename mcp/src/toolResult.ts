/**
 * MCP tool result helpers (#553).
 *
 * Handlers still produce a human-readable text block. Tools that advertise an
 * `outputSchema` also return the same data as `structuredContent` so an agent
 * can read an id, price, or tx hash without parsing prose.
 *
 * Failures stay on the CallTool `catch` path (`isError: true`, no payload).
 */

export type ToolOutcome = string | { text: string; structured?: Record<string, unknown> };

export interface CallToolSuccess {
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
}

/** Parse handler text as a JSON object. Arrays and scalars are ignored. */
export function parseStructuredObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fallback payload when a tool declares `outputSchema` but the handler text is
 * not JSON (insufficient funds, verification rejected, missing tx hash, …).
 * The text block is unchanged; agents still get a stable object.
 */
export function textFallback(text: string): Record<string, unknown> {
  return { status: "text", message: text };
}

export function outcomeText(outcome: ToolOutcome): string {
  return typeof outcome === "string" ? outcome : outcome.text;
}

/**
 * Attach `structuredContent` when a sidecar is provided, when the text is a
 * JSON object, or (for tools with an advertised schema) as a text fallback.
 * Tools without a schema stay text-only.
 */
export function normalizeToolResult(
  name: string,
  outcome: ToolOutcome,
  hasOutputSchema: (tool: string) => boolean,
): CallToolSuccess {
  const text = outcomeText(outcome);
  const explicit = typeof outcome === "string" ? undefined : outcome.structured;
  const parsed = explicit ?? parseStructuredObject(text);
  const structured = parsed ?? (hasOutputSchema(name) ? textFallback(text) : undefined);

  return structured
    ? { content: [{ type: "text", text }], structuredContent: structured }
    : { content: [{ type: "text", text }] };
}
