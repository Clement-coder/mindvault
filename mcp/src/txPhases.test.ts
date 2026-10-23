/**
 * Transaction-phase status model (#1056).
 *
 * These tests prove that:
 *   - The four distinct phases exist and are mutually exclusive string literals.
 *   - `txPhaseFields` returns the right shape for each phase.
 *   - `confirmed` is ONLY true at "settled" — never for earlier phases.
 *   - The helper defaults to "settled" (the happy path).
 *   - `submittedUnconfirmedResult` sets `txPhase: "submitted"` and
 *     `confirmed: false`, never "settled".
 *   - A simulated-only result carries `mode: "dry-run"` and no `txPhase`.
 *   - Legacy `status` fields stay present (compatibility).
 */

import { describe, expect, it } from "vitest";
import {
  TX_PHASES,
  TX_PHASE_LABELS,
  SETTLED_TX_PHASE,
  SUBMITTED_TX_PHASE,
  SIMULATED_TX_PHASE,
  INCLUDED_TX_PHASE,
  txPhaseFields,
  type TxPhase,
} from "./txPhases.js";
import {
  SubmittedTransactionUnconfirmed,
  submittedUnconfirmedResult,
} from "./submittedTransaction.js";

const HASH = "deadbeef".padEnd(64, "0");

// ── Phase constant correctness ────────────────────────────────────────────────

describe("TX_PHASES", () => {
  it("lists exactly four phases in order", () => {
    expect(TX_PHASES).toEqual(["simulated", "submitted", "included", "settled"]);
  });

  it("every phase has a human-readable label", () => {
    for (const phase of TX_PHASES) {
      expect(TX_PHASE_LABELS[phase]).toBeTruthy();
    }
  });
});

// ── txPhaseFields ─────────────────────────────────────────────────────────────

describe("txPhaseFields", () => {
  it("defaults to 'settled' — the confirmed happy path", () => {
    const fields = txPhaseFields();
    expect(fields.txPhase).toBe("settled");
    expect(fields.confirmed).toBe(true);
  });

  it("'settled' → confirmed: true", () => {
    const fields = txPhaseFields("settled");
    expect(fields.txPhase).toBe(SETTLED_TX_PHASE);
    expect(fields.confirmed).toBe(true);
  });

  it("'submitted' → confirmed: false", () => {
    const fields = txPhaseFields("submitted");
    expect(fields.txPhase).toBe(SUBMITTED_TX_PHASE);
    expect(fields.confirmed).toBe(false);
  });

  it("'included' → confirmed: false", () => {
    const fields = txPhaseFields("included");
    expect(fields.txPhase).toBe(INCLUDED_TX_PHASE);
    expect(fields.confirmed).toBe(false);
  });

  it("'simulated' → confirmed: false", () => {
    const fields = txPhaseFields("simulated");
    expect(fields.txPhase).toBe(SIMULATED_TX_PHASE);
    expect(fields.confirmed).toBe(false);
  });

  it("confirmed is ONLY true at settled", () => {
    const phases: TxPhase[] = ["simulated", "submitted", "included", "settled"];
    for (const phase of phases) {
      const { confirmed } = txPhaseFields(phase);
      expect(confirmed).toBe(phase === "settled");
    }
  });
});

// ── submittedUnconfirmedResult ─────────────────────────────────────────────────

describe("submittedUnconfirmedResult (submitted phase)", () => {
  const err = new SubmittedTransactionUnconfirmed(HASH, new Error("socket hang up"));

  it("sets txPhase to 'submitted', not 'settled'", () => {
    const result = submittedUnconfirmedResult("Update metadata", "res-1", err);
    expect(result.txPhase).toBe("submitted");
    expect(result.txPhase).not.toBe("settled");
  });

  it("sets confirmed: false", () => {
    const result = submittedUnconfirmedResult("Update metadata", "res-1", err);
    expect(result.confirmed).toBe(false);
  });

  it("sets legacy status: 'submitted' — distinct from 'success'", () => {
    const result = submittedUnconfirmedResult("Update metadata", "res-1", err);
    expect(result.status).toBe("submitted");
    expect(result.status).not.toBe("success");
  });

  it("carries the tx hash and a retryable status lookup", () => {
    const result = submittedUnconfirmedResult("Update metadata", "res-1", err);
    expect(result.txHash).toBe(HASH);
    expect(result.statusLookup).toMatchObject({
      tool: "mindvault_tx_status",
      arguments: { txHash: HASH },
      retryable: true,
    });
  });

  it("includes extra fields passed to it", () => {
    const result = submittedUnconfirmedResult("Set price", "res-2", err, { price: "5.00" });
    expect(result).toMatchObject({ price: "5.00", resourceId: "res-2" });
  });

  it("message tells the agent not to resubmit", () => {
    const result = submittedUnconfirmedResult("Set price", "res-2", err);
    expect(result.message).toMatch(/Do not resubmit/);
    expect(result.message).toMatch(/mindvault_tx_status/);
  });
});

// ── Dry-run results do NOT carry txPhase ─────────────────────────────────────

describe("dry-run mode (simulation only)", () => {
  it("dryRunOnchain result has mode:dry-run and no txPhase", async () => {
    // Import lazily so this file doesn't need a full runtime setup.
    const { dryRunOnchain } = await import("./dryRun.js");
    const result = dryRunOnchain(
      "update-metadata",
      "res-1",
      "testnet",
      "https://example.com",
      true,
      true,
    );
    expect(result.mode).toBe("dry-run");
    expect((result as Record<string, unknown>).txPhase).toBeUndefined();
    expect((result as Record<string, unknown>).confirmed).toBeUndefined();
  });
});

// ── settled result shape (integration with tool output) ───────────────────────

describe("settled result shape (txPhaseFields spread into a mutation result)", () => {
  it("produces the expected object when spread into a success result", () => {
    const settled = {
      status: "success" as const,
      ...txPhaseFields("settled"),
      resourceId: "res-1",
      txHash: HASH,
    };
    expect(settled).toMatchObject({
      status: "success",
      txPhase: "settled",
      confirmed: true,
      resourceId: "res-1",
      txHash: HASH,
    });
  });

  it("legacy 'success' status is preserved alongside txPhase", () => {
    const result = {
      status: "success" as const,
      ...txPhaseFields("settled"),
      txHash: HASH,
    };
    // Both old and new fields present — client compatibility.
    expect(result.status).toBe("success");
    expect(result.txPhase).toBe("settled");
  });
});
