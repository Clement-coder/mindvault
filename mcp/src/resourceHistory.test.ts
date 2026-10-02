import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  provenanceChain,
  readResourceHistory,
  recordResourceHistory,
  resourceChangeLog,
} from "./resourceHistory.js";

describe("resource history", () => {
  it("records and filters provenance and change events in chronological order", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mindvault-history-")), "audit.jsonl");
    process.env.MINDVAULT_RESOURCE_HISTORY_FILE = path;
    recordResourceHistory({
      resourceId: "res-1",
      kind: "price",
      value: "2.00",
      timestamp: "2026-01-03T00:00:00Z",
    });
    recordResourceHistory({
      resourceId: "res-1",
      kind: "created",
      actor: "GOWNER",
      timestamp: "2026-01-01T00:00:00Z",
    });
    recordResourceHistory({
      resourceId: "res-1",
      kind: "purchased",
      actor: "GBUYER",
      amount: "2.00",
      timestamp: "2026-01-02T00:00:00Z",
    });
    recordResourceHistory({ resourceId: "other", kind: "created", actor: "OTHER" });

    expect(readResourceHistory("res-1").map((event) => event.kind)).toEqual([
      "created",
      "purchased",
      "price",
    ]);
    expect(JSON.parse(provenanceChain("res-1")).events).toHaveLength(2);
    expect(JSON.parse(resourceChangeLog("res-1")).changes).toHaveLength(1);
    expect(readFileSync(path, "utf8")).not.toContain("secretKey");
    delete process.env.MINDVAULT_RESOURCE_HISTORY_FILE;
  });

  it("returns empty histories when no audit file exists", () => {
    process.env.MINDVAULT_RESOURCE_HISTORY_FILE = join(tmpdir(), `missing-${Date.now()}.jsonl`);
    expect(JSON.parse(provenanceChain("missing")).events).toEqual([]);
    delete process.env.MINDVAULT_RESOURCE_HISTORY_FILE;
  });
});
