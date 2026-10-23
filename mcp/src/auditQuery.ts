import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { redactObject } from "./redaction.js";

export interface AuditQuery {
  since?: string;
  until?: string;
  tool?: string;
  outcome?: "start" | "success" | "error";
  offset?: number;
  limit?: number;
}
export const MAX_AUDIT_QUERY_BYTES = 1024 * 1024;
export const MAX_AUDIT_QUERY_RESULTS = 500;

/** Query the latest bounded window of a JSONL audit log. */
export function queryAuditLog(path: string, query: AuditQuery = {}) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_QUERY_RESULTS)
    throw new RangeError("Invalid limit");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid offset");
  const since = query.since === undefined ? null : Date.parse(query.since);
  const until = query.until === undefined ? null : Date.parse(query.until);
  if (since !== null && !Number.isFinite(since)) throw new RangeError("Invalid since");
  if (until !== null && !Number.isFinite(until)) throw new RangeError("Invalid until");
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const bytes = Math.min(size, MAX_AUDIT_QUERY_BYTES);
    const start = size - bytes;
    const buffer = Buffer.alloc(bytes);
    let nread = 0;
    while (nread < bytes) {
      const n = readSync(fd, buffer, nread, bytes - nread, start + nread);
      if (n === 0) break;
      nread += n;
    }
    let text = buffer.subarray(0, nread).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    if (!text.endsWith("\n")) text = text.slice(0, text.lastIndexOf("\n") + 1);
    const matches: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const time = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
      if (since !== null && !(time >= since)) continue;
      if (until !== null && !(time <= until)) continue;
      if (query.tool !== undefined && event.toolName !== query.tool) continue;
      if (query.outcome !== undefined && event.status !== query.outcome) continue;
      matches.push(redactObject(event) as Record<string, unknown>);
    }
    const entries = matches.slice(offset, offset + limit);
    return {
      entries,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      truncated: start > 0,
      scannedBytes: nread,
    };
  } finally {
    closeSync(fd);
  }
}
