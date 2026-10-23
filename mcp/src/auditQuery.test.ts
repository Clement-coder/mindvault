import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryAuditLog, MAX_AUDIT_QUERY_BYTES } from "./auditQuery.js";

const dir = mkdtempSync(join(tmpdir(), "mindvault-query-"));
const path = join(dir, "audit.jsonl");
afterEach(() => {
  writeFileSync(path, "");
});

describe("bounded audit queries", () => {
  it("composes time, tool, and outcome filters with stable offsets", () => {
    const events = [
      { timestamp: "2026-01-01T00:00:00Z", toolName: "browse", status: "success" },
      { timestamp: "2026-01-02T00:00:00Z", toolName: "buy", status: "error" },
      { timestamp: "2026-01-03T00:00:00Z", toolName: "browse", status: "error" },
      { timestamp: "2026-01-04T00:00:00Z", toolName: "browse", status: "error" },
    ];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const filters = {
      since: "2026-01-02T00:00:00Z",
      tool: "browse",
      outcome: "error" as const,
      limit: 1,
    };
    const first = queryAuditLog(path, filters);
    expect(first.entries).toEqual([events[2]]);
    expect(first.nextOffset).toBe(1);
    const second = queryAuditLog(path, { ...filters, offset: first.nextOffset! });
    expect(second.entries).toEqual([events[3]]);
    expect(second.nextOffset).toBeNull();
  });

  it("rejects invalid limits and dates", () => {
    writeFileSync(path, "");
    expect(() => queryAuditLog(path, { limit: 501 })).toThrow();
    expect(() => queryAuditLog(path, { offset: -1 })).toThrow();
    expect(() => queryAuditLog(path, { since: "invalid" })).toThrow();
  });

  it("caps bytes and reports omitted history", () => {
    writeFileSync(
      path,
      JSON.stringify({ payload: "x".repeat(MAX_AUDIT_QUERY_BYTES) }) +
        "\n" +
        JSON.stringify({ toolName: "latest", status: "success" }) +
        "\n",
    );
    const result = queryAuditLog(path);
    expect(result.truncated).toBe(true);
    expect(result.scannedBytes).toBeLessThanOrEqual(MAX_AUDIT_QUERY_BYTES);
    expect(result.entries).toEqual([{ toolName: "latest", status: "success" }]);
  });
});
