/**
 * x402 payment retry classification (#583).
 *
 * The classification decides whether an agent may retry a failed payment. Get
 * it wrong in one direction and the user pays twice; wrong in the other and a
 * purchase they already paid for is abandoned. So the safety verdicts are
 * asserted directly, not just the plumbing around them.
 *
 * The last block keeps `docs/mcp-x402-retry-classification.md` honest — a
 * retry-safety document that drifts from the code is worse than none.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_ERROR_CODES, type ErrorCode } from "./errorCodes.js";
import {
  PAYMENT_STAGES,
  PAYMENT_STAGE_CLASSIFICATION,
  classifyPaymentFailure,
  classifyStage,
  describePaymentRetry,
  isValueAtRisk,
  stageForErrorCode,
  type PaymentStage,
} from "./paymentRetry.js";

const DOC = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "..",
  "docs",
  "mcp-x402-retry-classification.md",
);

describe("the classification table", () => {
  it("covers every stage", () => {
    for (const stage of PAYMENT_STAGES) {
      expect(PAYMENT_STAGE_CLASSIFICATION[stage], `${stage} is unclassified`).toBeDefined();
    }
  });

  it("lists the stages in escalating order of risk", () => {
    const risk = PAYMENT_STAGES.map((stage) => isValueAtRisk(stage));

    // Once value is at risk it stays at risk — a table that flip-flopped
    // would be impossible to reason about.
    expect(risk).toEqual([false, false, true, true, true]);
  });

  it("keys every entry by its own stage", () => {
    for (const [key, entry] of Object.entries(PAYMENT_STAGE_CLASSIFICATION)) {
      expect(entry.stage).toBe(key);
    }
  });

  it("gives every stage a reason and an action", () => {
    for (const stage of PAYMENT_STAGES) {
      const entry = classifyStage(stage);
      expect(entry.reason.length, `${stage} has no reason`).toBeGreaterThan(0);
      expect(entry.action.length, `${stage} has no action`).toBeGreaterThan(0);
    }
  });
});

describe("safety verdicts", () => {
  it("allows retrying a price quote", () => {
    // Nothing was constructed or signed.
    expect(classifyStage("quoted").safety).toBe("safe");
    expect(classifyStage("quoted").doubleSpendRisk).toBe(false);
  });

  it("allows retrying a client-side refusal", () => {
    expect(classifyStage("declined").safety).toBe("safe");
    expect(classifyStage("declined").doubleSpendRisk).toBe(false);
  });

  it("does not treat a signed payment as safe", () => {
    // The most tempting mistake: no tx hash came back, so it looks like
    // nothing happened. A signed Stellar transaction is a bearer instrument.
    expect(classifyStage("signed").safety).toBe("conditional");
    expect(classifyStage("signed").doubleSpendRisk).toBe(true);
  });

  it("does not treat a submitted payment as safe", () => {
    expect(classifyStage("submitted").safety).toBe("conditional");
    expect(classifyStage("submitted").doubleSpendRisk).toBe(true);
  });

  it("forbids retrying a settled payment outright", () => {
    expect(classifyStage("settled").safety).toBe("unsafe");
  });

  it("flags double-spend risk exactly where value is at risk", () => {
    for (const stage of PAYMENT_STAGES) {
      expect(classifyStage(stage).doubleSpendRisk, stage).toBe(isValueAtRisk(stage));
    }
  });

  it("tells the agent what to check on every conditional verdict", () => {
    for (const stage of PAYMENT_STAGES) {
      const entry = classifyStage(stage);
      if (entry.safety !== "conditional") continue;
      // "Maybe" without "check this" is not actionable.
      expect(entry.action, `${stage} does not say what to check`).toMatch(
        /purchase_history|tx_status/,
      );
    }
  });

  it("never tells an agent to retry a stage carrying double-spend risk", () => {
    for (const stage of PAYMENT_STAGES) {
      const entry = classifyStage(stage);
      if (!entry.doubleSpendRisk) continue;
      expect(entry.safety, `${stage} is marked blindly retry-safe`).not.toBe("safe");
    }
  });
});

describe("stageForErrorCode", () => {
  it.each([
    ["MV_PAYMENT_REQUIRED", "quoted"],
    ["MV_PAYMENT_CEILING_EXCEEDED", "declined"],
    ["MV_INSUFFICIENT_FUNDS", "declined"],
    ["MV_WALLET_MISSING", "declined"],
    ["MV_PAYMENT_REJECTED", "submitted"],
  ] as [ErrorCode, PaymentStage][])("maps %s to %s", (code, stage) => {
    expect(stageForErrorCode(code)).toBe(stage);
  });

  it("reads a rejection pessimistically", () => {
    // Assuming it was never submitted is the assumption that pays twice.
    expect(stageForErrorCode("MV_PAYMENT_REJECTED")).toBe("submitted");
    expect(classifyStage(stageForErrorCode("MV_PAYMENT_REJECTED")!).doubleSpendRisk).toBe(true);
  });

  it("gives non-payment codes no stage", () => {
    // A catalog timeout is not a payment event; sending an agent to check a
    // transaction that was never made is noise at best.
    for (const code of ["MV_TIMEOUT", "MV_NOT_FOUND", "MV_RATE_LIMITED", "MV_UNKNOWN"] as const) {
      expect(stageForErrorCode(code), code).toBeNull();
    }
  });

  it("returns a stage or null for every code in the catalog", () => {
    for (const code of ALL_ERROR_CODES) {
      const stage = stageForErrorCode(code);
      expect(stage === null || PAYMENT_STAGES.includes(stage), code).toBe(true);
    }
  });
});

describe("classifyPaymentFailure", () => {
  it("uses an explicit stage above everything else", () => {
    const result = classifyPaymentFailure({ stage: "settled", code: "MV_PAYMENT_REQUIRED" });

    expect(result?.stage).toBe("settled");
  });

  it("treats an existing receipt as proof the payment settled", () => {
    const result = classifyPaymentFailure({ code: "MV_PAYMENT_REJECTED", hasReceipt: true });

    expect(result?.stage).toBe("settled");
    expect(result?.safety).toBe("unsafe");
  });

  it("treats a tx hash as proof of submission", () => {
    const result = classifyPaymentFailure({ code: "MV_PAYMENT_REQUIRED", txHash: "abc123" });

    // Evidence of an attempt beats an error that claims none was made.
    expect(result?.stage).toBe("submitted");
  });

  it("prefers a receipt over a tx hash", () => {
    const result = classifyPaymentFailure({ txHash: "abc123", hasReceipt: true });

    expect(result?.stage).toBe("settled");
  });

  it("falls back to the error code", () => {
    expect(classifyPaymentFailure({ code: "MV_PAYMENT_CEILING_EXCEEDED" })?.stage).toBe("declined");
  });

  it("returns null when there is nothing to go on", () => {
    expect(classifyPaymentFailure({})).toBeNull();
  });

  it("returns null for a non-payment failure", () => {
    expect(classifyPaymentFailure({ code: "MV_TIMEOUT" })).toBeNull();
  });

  it("ignores a null tx hash", () => {
    expect(classifyPaymentFailure({ code: "MV_PAYMENT_REQUIRED", txHash: null })?.stage).toBe(
      "quoted",
    );
  });
});

describe("describePaymentRetry", () => {
  it("leads with the verdict", () => {
    expect(describePaymentRetry(classifyStage("quoted"))).toMatch(/^Safe to retry/);
    expect(describePaymentRetry(classifyStage("submitted"))).toMatch(/^Check before retrying/);
    expect(describePaymentRetry(classifyStage("settled"))).toMatch(/^Do not retry/);
  });

  it("names the stage", () => {
    expect(describePaymentRetry(classifyStage("signed"))).toContain("payment stage: signed");
  });

  it("carries the action through", () => {
    expect(describePaymentRetry(classifyStage("settled"))).toContain(
      classifyStage("settled").action,
    );
  });
});

describe("docs/mcp-x402-retry-classification.md — staleness guard", () => {
  const doc = readFileSync(DOC, "utf-8");

  const docLines = doc.split("\n");

  /** The table row for one stage, tolerating prettier's column padding. */
  const rowFor = (stage: string): string | undefined =>
    docLines.find((line) => new RegExp(`^\\|\\s*\`${stage}\`\\s*\\|`).test(line));

  it("documents every stage", () => {
    for (const stage of PAYMENT_STAGES) {
      expect(doc, `${stage} is not documented`).toContain(`\`${stage}\``);
    }
  });

  it("documents no stage the code does not define", () => {
    // Padding-tolerant: prettier aligns markdown table columns.
    const documented = [...doc.matchAll(/^\|\s*`([a-z]+)`\s*\|/gm)].map((m) => m[1]);

    expect(documented.length).toBeGreaterThan(0);
    for (const stage of documented) {
      expect(PAYMENT_STAGES, `${stage} is documented but not defined`).toContain(stage);
    }
  });

  it("documents every code that maps to a stage", () => {
    for (const code of ALL_ERROR_CODES) {
      if (stageForErrorCode(code) === null) continue;
      expect(doc, `${code} maps to a stage but is not documented`).toContain(code);
    }
  });

  it("states the retry verdict the code actually assigns", () => {
    // The table renders safe/conditional/unsafe as ✅/⚠️/❌.
    const marks: Record<string, string> = { safe: "✅", conditional: "⚠️", unsafe: "❌" };
    for (const stage of PAYMENT_STAGES) {
      const expected = marks[classifyStage(stage).safety];
      const row = rowFor(stage);
      expect(row, `${stage} has no table row`).toBeDefined();
      expect(row, `${stage} documents the wrong verdict`).toContain(expected);
    }
  });

  it("marks double-spend risk consistently with the code", () => {
    for (const stage of PAYMENT_STAGES) {
      const row = rowFor(stage)!;
      const documentsRisk = /\*\*yes\*\*/.test(row);
      expect(documentsRisk, `${stage} row disagrees on double-spend risk`).toBe(
        classifyStage(stage).doubleSpendRisk,
      );
    }
  });

  it("explains why a signed payment is already dangerous", () => {
    // The single most load-bearing paragraph on the page.
    expect(doc).toMatch(/bearer instrument/i);
  });
});
