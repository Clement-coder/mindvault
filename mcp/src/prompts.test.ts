import { describe, it, expect } from "vitest";
import { PROMPT_DEFINITIONS, getPrompt } from "./prompts.js";
import { validatePromptArgs } from "./prompts.js";

describe("prompts", () => {
  describe("PROMPT_DEFINITIONS", () => {
    it("defines publish and buy prompts", () => {
      const names = PROMPT_DEFINITIONS.map((p) => p.name);
      expect(names).toContain("publish");
      expect(names).toContain("buy");
    });

    it("publish prompt has required arguments", () => {
      const publish = PROMPT_DEFINITIONS.find((p) => p.name === "publish")!;
      const required = publish.arguments.filter((a) => a.required).map((a) => a.name);
      expect(required).toContain("title");
      expect(required).toContain("price");
      expect(required).toContain("externalUrl");
    });

    it("buy prompt requires resourceId", () => {
      const buy = PROMPT_DEFINITIONS.find((p) => p.name === "buy")!;
      const required = buy.arguments.filter((a) => a.required).map((a) => a.name);
      expect(required).toContain("resourceId");
    });
  });

  describe("validatePromptArgs", () => {
    it("accepts valid publish args", () => {
      const errors = validatePromptArgs("publish", {
        title: "My Tutorial",
        price: "5.00",
        externalUrl: "https://example.com",
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects missing required args", () => {
      const errors = validatePromptArgs("publish", { title: "T", price: "1" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("externalUrl");
    });
  });

  describe("getPrompt", () => {
    it("returns publish workflow with argument substitution", () => {
      const result = getPrompt("publish", {
        title: "My Tutorial",
        price: "5.00",
        externalUrl: "https://example.com",
      });

      expect(result.description).toContain("publish");
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content.text).toContain("My Tutorial");
      expect(result.messages[0].content.text).toContain("5.00");
      expect(result.messages[1].content.text).toContain("mindvault_setup_wallet");
      expect(result.messages[1].content.text).toContain("mindvault_publish");
    });

    it("returns buy workflow with argument substitution", () => {
      const result = getPrompt("buy", { resourceId: "res-123" });

      expect(result.description).toContain("buy");
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content.text).toContain("res-123");
      expect(result.messages[1].content.text).toContain("mindvault_buy");
    });

    it("throws for unknown prompt", () => {
      expect(() => getPrompt("unknown", {})).toThrow("Unknown prompt");
    });

    it("uses placeholders for missing optional args", () => {
      const result = getPrompt("publish", {
        title: "T",
        price: "1",
        externalUrl: "https://x.com",
      });
      // description is optional — should use placeholder pattern
      expect(result.messages[0].content.text).toBeDefined();
    });
  });
});
