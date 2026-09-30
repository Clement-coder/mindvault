/**
 * Unit tests for MCP tool result wrapping (#553).
 */
import { describe, expect, it } from "vitest";
import { normalizeToolResult, parseStructuredObject, textFallback } from "./toolResult.js";

describe("parseStructuredObject", () => {
  it("returns a JSON object", () => {
    expect(parseStructuredObject('{"id":"res-1"}')).toEqual({ id: "res-1" });
  });

  it("ignores arrays and scalars", () => {
    expect(parseStructuredObject("[1,2]")).toBeUndefined();
    expect(parseStructuredObject('"hello"')).toBeUndefined();
  });

  it("does not throw on invalid JSON", () => {
    expect(parseStructuredObject("Wallet created.")).toBeUndefined();
    expect(parseStructuredObject("{")).toBeUndefined();
  });
});

describe("normalizeToolResult", () => {
  const withSchema = (name: string) => name === "mindvault_preview";
  const none = () => false;

  it("attaches structuredContent when the text is a JSON object and the tool has a schema", () => {
    const result = normalizeToolResult(
      "mindvault_preview",
      JSON.stringify({ id: "res-1", price: "$1.50 USDC" }, null, 2),
      withSchema,
    );
    expect(result.content[0].text).toContain('"id": "res-1"');
    expect(result.structuredContent).toEqual({ id: "res-1", price: "$1.50 USDC" });
  });

  it("uses an explicit sidecar without changing the text", () => {
    const text = "[res-1] Intro — $1.5 USDC\n  A guide\n  https://example.com";
    const result = normalizeToolResult(
      "mindvault_browse",
      { text, structured: { items: [{ id: "res-1" }], notice: null, truncated: false } },
      (name) => name === "mindvault_browse",
    );
    expect(result.content[0].text).toBe(text);
    expect(result.structuredContent).toEqual({
      items: [{ id: "res-1" }],
      notice: null,
      truncated: false,
    });
  });

  it("omits structuredContent for text-only tools", () => {
    const result = normalizeToolResult("mindvault_verify_install", "Install looks good.", none);
    expect(result.content[0].text).toBe("Install looks good.");
    expect(result.structuredContent).toBeUndefined();
  });

  it("uses a text fallback when a schema tool returns prose", () => {
    const text = "Provide a transaction hash to look up.";
    const result = normalizeToolResult("mindvault_preview", text, withSchema);
    expect(result.content[0].text).toBe(text);
    expect(result.structuredContent).toEqual(textFallback(text));
  });
});
