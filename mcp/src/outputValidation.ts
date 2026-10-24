/**
 * Server-side enforcement of advertised tool output schemas (#1062).
 *
 * A tool that declares an `outputSchema` promises that every result's
 * `structuredContent` conforms to it, and MCP clients hold it to that: the
 * SDK's `Client.callTool` validates `structuredContent` — on errors as well as
 * successes — and throws when it does not match, so the agent gets an opaque
 * protocol error instead of the tool's result. A handler that drifted from its
 * schema used to reach the client unchecked.
 *
 * Every result is now checked here, with the same validator the SDK client
 * uses, before it is sent. A mismatch is an internal bug, not a problem with
 * the caller's arguments, so it is:
 *
 *  - logged to stderr with the tool name and the schema paths that failed —
 *    never the payload, which can carry addresses, receipts, or keys;
 *  - returned to the client as an `isError` result whose `structuredContent`
 *    is a troubleshooting hint that does conform, so the client sees a
 *    readable error rather than a validation exception. The handler's text is
 *    kept: it is what the tool would have sent anyway, and for a payment or an
 *    on-chain mutation it is how the agent learns the operation went through.
 *
 * Error results get a schema too. Each advertised `outputSchema` is the
 * tool's success schema OR `TOOL_ERROR_OUTPUT_SCHEMA`, so the troubleshooting
 * hint a failed call carries validates on the client.
 */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";

import { logger } from "./logger.js";
import { redactSecrets } from "./redaction.js";

/** `structuredContent` of a failed tool call: the troubleshooting hint. */
export const TOOL_ERROR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    troubleshooting: {
      type: "object",
      properties: {
        schema: { type: "string", const: "mindvault.troubleshooting/v1" },
        source: { type: "string" },
        category: { type: "string" },
        status: { type: ["integer", "null"] },
        summary: { type: "string" },
        detail: { type: ["string", "null"] },
        action: { type: "string" },
        // The upstream's own request id, when the failure carries one (#1019).
        requestId: { type: ["string", "null"] },
      },
      required: ["schema", "source", "category", "status", "summary", "detail", "action"],
    },
  },
  required: ["troubleshooting"],
} as const;

/**
 * The schema a tool advertises: its success shape, or the error shape a failed
 * call carries. Applied once to every structured tool in `TOOL_DEFINITIONS`.
 */
export function withToolErrorVariant(
  successSchema: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "object", anyOf: [successSchema, TOOL_ERROR_OUTPUT_SCHEMA] };
}

/** The success half of an advertised schema built by `withToolErrorVariant`. */
export function successSchemaOf(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const anyOf = schema?.anyOf as unknown[] | undefined;
  if (Array.isArray(anyOf) && anyOf.length === 2 && anyOf[1] === TOOL_ERROR_OUTPUT_SCHEMA) {
    return anyOf[0] as Record<string, unknown>;
  }
  return schema;
}

const provider = new AjvJsonSchemaValidator();
const compiled = new WeakMap<object, JsonSchemaValidator<unknown>>();

export type OutputCheck = { valid: true } | { valid: false; problems: string };

/**
 * Validate one value against a schema with the SDK's Ajv validator — the one
 * `Client.callTool` applies — so "valid here" means "valid on the client".
 * `problems` names schema paths and rules only; Ajv does not quote the data.
 */
export function checkOutput(schema: Record<string, unknown>, value: unknown): OutputCheck {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = provider.getValidator(schema as JsonSchemaType);
    compiled.set(schema, validate);
  }
  const result = validate(value);
  return result.valid
    ? { valid: true }
    : { valid: false, problems: redactSecrets(result.errorMessage ?? "invalid") };
}

/** The tool result shape the CallTool handlers produce. */
export interface ToolCallResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Why a result failed its tool's contract, or `undefined` when it conforms. */
export function outputContractViolation(
  result: ToolCallResult,
  schema: Record<string, unknown> | undefined,
): string | undefined {
  if (!schema) return undefined;
  if (result.structuredContent === undefined) {
    // A failure may be text-only; a success must carry the declared payload.
    return result.isError ? undefined : "structuredContent is missing";
  }
  const check = checkOutput(schema, result.structuredContent);
  return check.valid ? undefined : check.problems;
}

/** The troubleshooting hint sent in place of a non-conforming payload. */
export function contractMismatchHint(tool: string) {
  return {
    schema: "mindvault.troubleshooting/v1" as const,
    source: "mcp",
    category: "server",
    status: null,
    summary: `Internal contract mismatch: ${tool} produced a result that does not match its declared output schema.`,
    detail: null,
    action:
      "This is a MindVault MCP server bug, not a problem with your arguments. The tool's text result is included unchanged — read it before retrying, and check the status of any payment or transaction it mentions instead of repeating it.",
  };
}

/**
 * Return `result` unchanged when it honours the tool's declared schema;
 * otherwise log the mismatch (tool name and failing schema paths only) and
 * return a conforming `isError` result that keeps the handler's text.
 */
export function enforceOutputContract<R extends ToolCallResult>(
  tool: string,
  result: R,
  schema: Record<string, unknown> | undefined,
  log: (message: string) => void = (message) => logger.error(message),
): ToolCallResult {
  const violation = outputContractViolation(result, schema);
  if (violation === undefined) return result;

  log(
    `MindVault MCP: internal contract mismatch — ${tool} ${result.isError ? "error" : "success"} result does not match its outputSchema: ${violation}. The payload was withheld from structuredContent.`,
  );

  // Spread first so structuredContent below replaces the withheld payload.
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: `Error: internal contract mismatch — ${tool} returned structured output that does not match its declared schema, so it was withheld. The text above is the tool's result.`,
      },
    ],
    isError: true,
    structuredContent: { troubleshooting: contractMismatchHint(tool) },
  };
}
