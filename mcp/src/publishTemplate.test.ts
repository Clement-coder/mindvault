/**
 * Unit tests for publishTemplate.ts — the template resolution logic that
 * pre-fills metadata pointer, tags, and price for known resource types.
 *
 * Coverage:
 *   1. Template defaults — each known type returns the right defaults
 *   2. Caller overrides — title, price, metadataPointer, tags each win over defaults
 *   3. nextSteps generation — placeholder detection, missing title, all-filled case
 *   4. KNOWN_RESOURCE_TYPES — exported constant is consistent with the map
 */
import { describe, it, expect } from "vitest";
import {
  applyPublishTemplate,
  KNOWN_RESOURCE_TYPES,
  RESOURCE_TYPE_TEMPLATES,
  type KnownResourceType,
} from "./publishTemplate.js";

// ── 1. Template defaults ──────────────────────────────────────────────────────

describe("applyPublishTemplate — defaults", () => {
  it.each(KNOWN_RESOURCE_TYPES as unknown as KnownResourceType[])(
    "returns the correct template defaults for %s",
    (resourceType) => {
      const tpl = RESOURCE_TYPE_TEMPLATES[resourceType];
      const result = applyPublishTemplate({ resourceType });

      expect(result.resourceType).toBe(resourceType);
      expect(result.metadataPointer).toBe(tpl.metadataPointer);
      expect(result.tags).toEqual(tpl.tags);
      expect(result.price).toBe(tpl.suggestedPrice);
      expect(result.description).toBe(tpl.description);
    },
  );

  it("returns an empty string for title when not supplied", () => {
    const result = applyPublishTemplate({ resourceType: "dataset" });
    expect(result.title).toBe("");
  });

  it("returns a non-empty description for every type", () => {
    for (const resourceType of KNOWN_RESOURCE_TYPES) {
      const result = applyPublishTemplate({ resourceType });
      expect(result.description.length).toBeGreaterThan(0);
    }
  });
});

describe("applyPublishTemplate — dataset defaults", () => {
  it("pre-fills sha256 metadata pointer with <HASH> placeholder", () => {
    const result = applyPublishTemplate({ resourceType: "dataset" });
    expect(result.metadataPointer).toBe("sha256:<HASH>");
  });

  it("pre-fills canonical discovery tags", () => {
    const result = applyPublishTemplate({ resourceType: "dataset" });
    expect(result.tags).toContain("dataset");
    expect(result.tags).toContain("data");
  });

  it("suggests a non-zero USDC price", () => {
    const result = applyPublishTemplate({ resourceType: "dataset" });
    expect(parseFloat(result.price)).toBeGreaterThan(0);
  });
});

describe("applyPublishTemplate — model defaults", () => {
  it("pre-fills an ipfs:// metadata pointer (model artifacts are large)", () => {
    const result = applyPublishTemplate({ resourceType: "model" });
    expect(result.metadataPointer).toMatch(/^ipfs:\/\//);
  });

  it("has the highest suggested price among all types", () => {
    const prices = KNOWN_RESOURCE_TYPES.map((t) =>
      parseFloat(RESOURCE_TYPE_TEMPLATES[t].suggestedPrice),
    );
    const modelPrice = parseFloat(RESOURCE_TYPE_TEMPLATES.model.suggestedPrice);
    expect(modelPrice).toBe(Math.max(...prices));
  });
});

// ── 2. Caller overrides ───────────────────────────────────────────────────────

describe("applyPublishTemplate — caller overrides", () => {
  it("uses the caller-supplied title when provided", () => {
    const result = applyPublishTemplate({ resourceType: "code", title: "My Library" });
    expect(result.title).toBe("My Library");
  });

  it("uses the caller-supplied price when provided", () => {
    const result = applyPublishTemplate({ resourceType: "prompt", price: "3.50" });
    expect(result.price).toBe("3.50");
  });

  it("uses the caller-supplied metadataPointer when provided", () => {
    const result = applyPublishTemplate({
      resourceType: "dataset",
      metadataPointer: "ipfs://QmActualHash",
    });
    expect(result.metadataPointer).toBe("ipfs://QmActualHash");
  });

  it("uses the caller-supplied tags (replacing, not merging)", () => {
    const result = applyPublishTemplate({
      resourceType: "dataset",
      tags: ["finance", "time-series"],
    });
    expect(result.tags).toEqual(["finance", "time-series"]);
    // Default "data" tag must not appear — it was replaced.
    expect(result.tags).not.toContain("data");
  });

  it("all overrides can be applied at once", () => {
    const result = applyPublishTemplate({
      resourceType: "model",
      title: "BERT-Tiny",
      price: "15.00",
      metadataPointer: "ar://some-arweave-tx",
      tags: ["nlp", "bert", "embeddings"],
    });
    expect(result.title).toBe("BERT-Tiny");
    expect(result.price).toBe("15.00");
    expect(result.metadataPointer).toBe("ar://some-arweave-tx");
    expect(result.tags).toEqual(["nlp", "bert", "embeddings"]);
  });
});

// ── 3. nextSteps generation ───────────────────────────────────────────────────

describe("applyPublishTemplate — nextSteps", () => {
  it("reports a missing title in nextSteps when no title is supplied", () => {
    const result = applyPublishTemplate({ resourceType: "dataset" });
    const titleHint = result.nextSteps.find((s) => /title/i.test(s));
    expect(titleHint).toBeDefined();
  });

  it("reports a <HASH> placeholder in nextSteps for sha256 types", () => {
    const result = applyPublishTemplate({ resourceType: "code" });
    const placeholderHint = result.nextSteps.find((s) => /<HASH>/.test(s));
    expect(placeholderHint).toBeDefined();
  });

  it("reports a <CID> placeholder in nextSteps for ipfs types", () => {
    const result = applyPublishTemplate({ resourceType: "model" });
    const placeholderHint = result.nextSteps.find((s) => /<CID>/.test(s));
    expect(placeholderHint).toBeDefined();
  });

  it("nextSteps contains an all-filled message when title and pointer are complete", () => {
    const result = applyPublishTemplate({
      resourceType: "prompt",
      title: "My Prompt",
      metadataPointer: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    });
    expect(result.nextSteps.length).toBe(1);
    expect(result.nextSteps[0]).toMatch(/mindvault_publish/);
  });

  it("nextSteps is never empty", () => {
    // Even fully-specified calls give at least the 'proceed' message.
    const result = applyPublishTemplate({
      resourceType: "code",
      title: "Ready",
      metadataPointer: "ipfs://QmReadyHash",
    });
    expect(result.nextSteps.length).toBeGreaterThan(0);
  });

  it("includes both title and pointer hints when both are missing", () => {
    const result = applyPublishTemplate({ resourceType: "dataset" });
    // Must have at least two hints — one for the missing title and one for the placeholder.
    expect(result.nextSteps.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 4. KNOWN_RESOURCE_TYPES ───────────────────────────────────────────────────

describe("KNOWN_RESOURCE_TYPES", () => {
  it("contains exactly the same keys as RESOURCE_TYPE_TEMPLATES", () => {
    expect([...KNOWN_RESOURCE_TYPES].sort()).toEqual(Object.keys(RESOURCE_TYPE_TEMPLATES).sort());
  });

  it("every type produces a valid result from applyPublishTemplate", () => {
    for (const resourceType of KNOWN_RESOURCE_TYPES) {
      const result = applyPublishTemplate({ resourceType });
      expect(result.resourceType).toBe(resourceType);
      expect(Array.isArray(result.tags)).toBe(true);
      expect(result.tags.length).toBeGreaterThan(0);
      expect(result.price).toMatch(/^\d+(\.\d+)?$/);
      expect(result.metadataPointer.length).toBeGreaterThan(0);
      expect(typeof result.description).toBe("string");
      expect(result.description.length).toBeGreaterThan(0);
    }
  });

  it("has four resource types: dataset, code, prompt, model", () => {
    expect([...KNOWN_RESOURCE_TYPES].sort()).toEqual(["code", "dataset", "model", "prompt"]);
  });
});

// ── 5. End-to-end result shape ────────────────────────────────────────────────

describe("applyPublishTemplate — output shape", () => {
  it("result has all required fields", () => {
    const result = applyPublishTemplate({ resourceType: "dataset" });
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "description",
      "metadataPointer",
      "nextSteps",
      "price",
      "resourceType",
      "tags",
      "title",
    ]);
  });

  it("tags is always an array of non-empty strings", () => {
    for (const resourceType of KNOWN_RESOURCE_TYPES) {
      const result = applyPublishTemplate({ resourceType });
      expect(Array.isArray(result.tags)).toBe(true);
      for (const tag of result.tags) {
        expect(typeof tag).toBe("string");
        expect(tag.length).toBeGreaterThan(0);
      }
    }
  });

  it("nextSteps is always an array of non-empty strings", () => {
    const result = applyPublishTemplate({ resourceType: "prompt" });
    expect(Array.isArray(result.nextSteps)).toBe(true);
    for (const step of result.nextSteps) {
      expect(typeof step).toBe("string");
      expect(step.length).toBeGreaterThan(0);
    }
  });
});
