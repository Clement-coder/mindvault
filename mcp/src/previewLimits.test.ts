/**
 * Tests for catalog resource preview size limits (#582).
 *
 * Two things must hold for every preview, no matter how large the publisher's
 * metadata is: the response stays within the byte budget, and it stays valid
 * JSON. The second is why the shared byte-level truncation is not reused here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  applyPreviewLimits,
  resolvePreviewLimits,
  serializePreview,
  isPreviewLimitDisabled,
  CAPPED_PREVIEW_FIELDS,
  DEFAULT_PREVIEW_MAX_BYTES,
  DEFAULT_PREVIEW_FIELD_MAX_CHARS,
  MIN_PREVIEW_MAX_BYTES,
  PREVIEW_MAX_BYTES_ENV_VAR,
  PREVIEW_FIELD_MAX_CHARS_ENV_VAR,
} from "./previewLimits.js";

const jsonFetch = vi.fn();

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, jsonFetch };
});

const { preview } = await import("./tools/catalog.js");

function samplePreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "res-001",
    title: "Stellar Payments Dataset",
    description: "Ledger-level payment records.",
    price: "$1.5 USDC",
    type: "dataset",
    verificationStatus: "verified",
    accessUrl: "https://example.com/res-001",
    ...overrides,
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("resolvePreviewLimits", () => {
  it("defaults to 8 KiB per response and 1000 characters per field", () => {
    expect(DEFAULT_PREVIEW_MAX_BYTES).toBe(8 * 1024);
    expect(DEFAULT_PREVIEW_FIELD_MAX_CHARS).toBe(1_000);
    expect(resolvePreviewLimits({})).toEqual({
      maxBytes: DEFAULT_PREVIEW_MAX_BYTES,
      fieldMaxChars: DEFAULT_PREVIEW_FIELD_MAX_CHARS,
    });
  });

  it("reads both budgets from the environment", () => {
    expect(
      resolvePreviewLimits({
        [PREVIEW_MAX_BYTES_ENV_VAR]: "2048",
        [PREVIEW_FIELD_MAX_CHARS_ENV_VAR]: "120",
      }),
    ).toEqual({ maxBytes: 2048, fieldMaxChars: 120 });
  });

  it("keeps 0 as an explicit opt-out rather than treating it as unset", () => {
    const limits = resolvePreviewLimits({
      [PREVIEW_MAX_BYTES_ENV_VAR]: "0",
      [PREVIEW_FIELD_MAX_CHARS_ENV_VAR]: "0",
    });
    expect(limits).toEqual({ maxBytes: 0, fieldMaxChars: 0 });
    expect(isPreviewLimitDisabled(limits.maxBytes)).toBe(true);
    expect(isPreviewLimitDisabled(limits.fieldMaxChars)).toBe(true);
  });

  it("falls back to the defaults for garbage and negative values", () => {
    for (const raw of ["", "   ", "abc", "-1", "NaN"]) {
      expect(resolvePreviewLimits({ [PREVIEW_MAX_BYTES_ENV_VAR]: raw }).maxBytes).toBe(
        DEFAULT_PREVIEW_MAX_BYTES,
      );
    }
  });

  it("raises a non-zero byte budget below the floor so identity fields still fit", () => {
    expect(resolvePreviewLimits({ [PREVIEW_MAX_BYTES_ENV_VAR]: "16" }).maxBytes).toBe(
      MIN_PREVIEW_MAX_BYTES,
    );
  });
});

describe("applyPreviewLimits", () => {
  it("leaves an ordinary preview untouched", () => {
    const input = samplePreview();
    const out = applyPreviewLimits(input, { maxBytes: 8192, fieldMaxChars: 1000 });
    expect(out).toEqual(input);
    expect(out.truncated).toBeUndefined();
  });

  it("caps a long description at the per-field budget", () => {
    const out = applyPreviewLimits(samplePreview({ description: "d".repeat(5_000) }), {
      maxBytes: 0,
      fieldMaxChars: 100,
    });

    expect(out.description).toContain("[truncated: 100 of 5000 characters]");
    expect(out.description).toMatch(/^d{100}…/);
    expect(out.truncated).toEqual({
      fields: ["description"],
      notice: expect.stringContaining(PREVIEW_MAX_BYTES_ENV_VAR),
    });
  });

  it("caps every free-text field, not just the description", () => {
    const out = applyPreviewLimits(
      samplePreview({ title: "T".repeat(400), description: "D".repeat(400) }),
      { maxBytes: 0, fieldMaxChars: 50 },
    );

    expect((out.truncated as { fields: string[] }).fields).toEqual(
      [...CAPPED_PREVIEW_FIELDS].sort(),
    );
  });

  it("never shortens the identity fields", () => {
    const out = applyPreviewLimits(samplePreview({ description: "d".repeat(50_000) }), {
      maxBytes: MIN_PREVIEW_MAX_BYTES,
      fieldMaxChars: 10,
    });

    expect(out.id).toBe("res-001");
    expect(out.price).toBe("$1.5 USDC");
    expect(out.accessUrl).toBe("https://example.com/res-001");
    expect(out.type).toBe("dataset");
    expect(out.verificationStatus).toBe("verified");
  });

  it("shrinks past the per-field cap until the whole response fits the byte budget", () => {
    const out = applyPreviewLimits(
      samplePreview({ title: "T".repeat(5_000), description: "D".repeat(5_000) }),
      { maxBytes: 700, fieldMaxChars: 4_000 },
    );

    expect(byteLength(serializePreview(out))).toBeLessThanOrEqual(700);
    expect((out.truncated as { fields: string[] }).fields).toContain("description");
  });

  it("shrinks the description before the title", () => {
    const out = applyPreviewLimits(
      samplePreview({ title: "T".repeat(300), description: "D".repeat(300) }),
      { maxBytes: 600, fieldMaxChars: 300 },
    );

    const keptTitle = String(out.title).replace(/… \[truncated.*/, "").length;
    const keptDescription = String(out.description).replace(/… \[truncated.*/, "").length;
    expect(keptTitle).toBeGreaterThan(keptDescription);
  });

  it("stays valid JSON at every budget", () => {
    for (const maxBytes of [MIN_PREVIEW_MAX_BYTES, 600, 1_024, 8_192]) {
      const out = applyPreviewLimits(
        samplePreview({ title: "T".repeat(20_000), description: "D".repeat(20_000) }),
        { maxBytes, fieldMaxChars: 1_000 },
      );
      const text = serializePreview(out);
      expect(() => JSON.parse(text)).not.toThrow();
      expect(byteLength(text)).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("never splits a multi-byte character", () => {
    const out = applyPreviewLimits(samplePreview({ description: "🎉".repeat(2_000) }), {
      maxBytes: 700,
      fieldMaxChars: 1_000,
    });
    const text = serializePreview(out);

    expect(text).not.toContain("�");
    expect(String(out.description).replace(/… \[truncated.*/, "")).toMatch(/^(🎉)*$/);
    expect(byteLength(text)).toBeLessThanOrEqual(700);
  });

  it("counts CJK text by code point but budgets the response in bytes", () => {
    const out = applyPreviewLimits(samplePreview({ description: "你好世界".repeat(500) }), {
      maxBytes: 0,
      fieldMaxChars: 100,
    });

    expect(String(out.description).replace(/… \[truncated.*/, "")).toHaveLength(100);
    expect(out.description).toContain("[truncated: 100 of 2000 characters]");
  });

  it("applies no limits when both budgets are disabled", () => {
    const input = samplePreview({ description: "d".repeat(100_000) });
    const out = applyPreviewLimits(input, { maxBytes: 0, fieldMaxChars: 0 });

    expect(out).toEqual(input);
    expect(out.truncated).toBeUndefined();
  });

  it("preserves extra keys such as the offline-cache label", () => {
    const out = applyPreviewLimits(
      samplePreview({ description: "d".repeat(5_000), offlineCache: "cached 2 min ago" }),
      { maxBytes: 1_024, fieldMaxChars: 1_000 },
    );

    expect(out.offlineCache).toBe("cached 2 min ago");
  });

  it("does not mutate the caller's object", () => {
    const input = samplePreview({ description: "d".repeat(5_000) });
    applyPreviewLimits(input, { maxBytes: 512, fieldMaxChars: 10 });
    expect(input.description).toHaveLength(5_000);
  });
});

describe("mindvault_preview size limits", () => {
  beforeEach(() => {
    jsonFetch.mockReset();
    delete process.env[PREVIEW_MAX_BYTES_ENV_VAR];
    delete process.env[PREVIEW_FIELD_MAX_CHARS_ENV_VAR];
  });

  function metaResponse(description: string) {
    return {
      ok: true,
      status: 200,
      data: {
        id: "res-001",
        title: "Stellar Payments Dataset",
        description,
        price: "1.5",
        resourceType: "dataset",
        verificationStatus: "verified",
        accessUrl: "https://example.com/res-001",
      },
      headers: {},
    };
  }

  it("returns a small preview verbatim", async () => {
    jsonFetch.mockResolvedValueOnce(metaResponse("Ledger-level payment records."));

    const parsed = JSON.parse(await preview("res-001"));
    expect(parsed.description).toBe("Ledger-level payment records.");
    expect(parsed.truncated).toBeUndefined();
  });

  it("bounds an oversized preview and keeps it parseable", async () => {
    jsonFetch.mockResolvedValueOnce(metaResponse("D".repeat(200_000)));

    const text = await preview("res-001");
    const parsed = JSON.parse(text);

    expect(byteLength(text)).toBeLessThanOrEqual(DEFAULT_PREVIEW_MAX_BYTES);
    expect(parsed.id).toBe("res-001");
    expect(parsed.price).toBe("$1.5 USDC");
    expect(parsed.accessUrl).toBe("https://example.com/res-001");
    expect(parsed.truncated.fields).toEqual(["description"]);
  });

  it("honours the environment overrides", async () => {
    process.env[PREVIEW_FIELD_MAX_CHARS_ENV_VAR] = "25";
    jsonFetch.mockResolvedValueOnce(metaResponse("D".repeat(1_000)));

    const parsed = JSON.parse(await preview("res-001"));
    expect(parsed.description).toBe("D".repeat(25) + "… [truncated: 25 of 1000 characters]");
  });
});
