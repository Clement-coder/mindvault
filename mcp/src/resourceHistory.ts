import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ResourceHistoryKind = "created" | "purchased" | "transferred" | "price" | "metadata";

export interface ResourceHistoryEvent {
  timestamp: string;
  resourceId: string;
  kind: ResourceHistoryKind;
  actor?: string;
  recipient?: string;
  amount?: string;
  value?: string;
  txHash?: string | null;
  network?: string;
}

export const DEFAULT_RESOURCE_HISTORY_FILE = join(
  homedir(),
  ".mindvault",
  "resource-history.jsonl",
);

export function resourceHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINDVAULT_RESOURCE_HISTORY_FILE?.trim() || DEFAULT_RESOURCE_HISTORY_FILE;
}

export function recordResourceHistory(
  event: Omit<ResourceHistoryEvent, "timestamp"> & { timestamp?: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const path = resourceHistoryPath(env);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString() })}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  } catch {
    // History is diagnostic: a read-only disk must not turn a successful
    // purchase or on-chain mutation into a reported failure.
  }
}

export function readResourceHistory(
  resourceId: string,
  env: NodeJS.ProcessEnv = process.env,
): ResourceHistoryEvent[] {
  const path = resourceHistoryPath(env);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as ResourceHistoryEvent;
        return event.resourceId === resourceId ? [event] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function provenanceChain(resourceId: string): string {
  const events = readResourceHistory(resourceId).filter((event) =>
    ["created", "purchased", "transferred"].includes(event.kind),
  );
  return JSON.stringify({ resourceId, count: events.length, events }, null, 2);
}

export function resourceChangeLog(resourceId: string): string {
  const changes = readResourceHistory(resourceId).filter((event) =>
    ["price", "metadata"].includes(event.kind),
  );
  return JSON.stringify({ resourceId, count: changes.length, changes }, null, 2);
}
