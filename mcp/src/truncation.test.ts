import { describe, it, expect } from "vitest";
import {
  truncateResponse,
  DEFAULT_RESPONSE_BUDGET_BYTES,
  MAX_TOOL_DESCRIPTION_BYTES,
  assertToolDescriptionSafe,
} from "./truncation.js";
import { TOOL_DEFINITIONS } from "./tools.js";

describe("truncateResponse", () => {
  it("returns text unchanged when under budget", () => {
    const text = "Hello, world!";
    expect(truncateResponse(text)).toBe(text);
  });

  it("truncates text exceeding the budget", () => {
    const text = "A".repeat(1000);
    const result = truncateResponse(text, 200);

    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[Truncated");
  });

  it("never splits a multi-byte character", () => {
    // Each emoji is 4 bytes in UTF-8
    const emoji = "🎉";
    const text = emoji.repeat(100); // 400 bytes
    const result = truncateResponse(text, 100);

    // Should not contain any replacement characters
    expect(result).not.toContain("�");
    expect(result).toContain("[Truncated");
  });

  it("handles CJK characters without splitting", () => {
    // Each CJK char is 3 bytes
    const text = "你好世界".repeat(100); // 1200 bytes
    const result = truncateResponse(text, 100);

    expect(result).not.toContain("�");
    expect(result).toContain("[Truncated");
  });

  it("returns original text when exactly at budget", () => {
    const text = "A".repeat(100);
    const result = truncateResponse(text, 100);
    expect(result).toBe(text);
  });

  it("uses default budget of 32 KiB", () => {
    expect(DEFAULT_RESPONSE_BUDGET_BYTES).toBe(32 * 1024);
  });

  it("handles empty string", () => {
    expect(truncateResponse("")).toBe("");
  });

  it("appends notice explaining how to fetch rest", () => {
    const text = "X".repeat(1000);
    const result = truncateResponse(text, 200);
    expect(result).toContain("Use limit/offset pagination");
  });
});

describe("assertToolDescriptionSafe", () => {
  it("does not throw for a short description", () => {
    expect(() => assertToolDescriptionSafe("mindvault_test", "A short description.")).not.toThrow();
  });

  it("does not throw for a description exactly at the limit", () => {
    const atLimit = "A".repeat(MAX_TOOL_DESCRIPTION_BYTES);
    expect(() => assertToolDescriptionSafe("mindvault_test", atLimit)).not.toThrow();
  });

  it("throws when the description exceeds the limit", () => {
    const tooLong = "A".repeat(MAX_TOOL_DESCRIPTION_BYTES + 1);
    expect(() => assertToolDescriptionSafe("mindvault_toolname", tooLong)).toThrow(
      /mindvault_toolname/,
    );
  });

  it("error message includes byte count and the limit", () => {
    const tooLong = "A".repeat(MAX_TOOL_DESCRIPTION_BYTES + 50);
    let message = "";
    try {
      assertToolDescriptionSafe("mindvault_x", tooLong);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\d+ bytes/);
    expect(message).toMatch(String(MAX_TOOL_DESCRIPTION_BYTES));
  });

  it("every tool definition description is within the safe length limit", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(
        () => assertToolDescriptionSafe(tool.name, tool.description),
        `${tool.name}: description exceeds ${MAX_TOOL_DESCRIPTION_BYTES} bytes — shorten it or move verbose docs to docs/`,
      ).not.toThrow();
    }
  });
});
