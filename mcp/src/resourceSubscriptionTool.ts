/**
 * Resource subscription tool for monitoring price and status changes.
 *
 * Agents use mindvault_subscribe_resource to monitor a resource's price,
 * verification status, and listing state. The tool polls at intervals and
 * emits progress notifications when changes are detected.
 */

import { BASE_URL, jsonFetch } from "./runtime.js";
import {
  pollResourceSubscription,
  type ResourceSubscriptionPollResult,
} from "./resourceSubscription.js";
import { mapHttpError, mcpError, throwHttpError } from "./errorMapping.js";

export type ResourceSubscriptionSnapshot = {
  resourceId: string;
  title: string | null;
  price: string;
  verificationStatus: string;
  listed: boolean;
  changes: ResourceChange[];
  polled: boolean;
  attempts: number;
  settled: boolean;
  timedOut: boolean;
  message: string;
};

export type ResourceChange = {
  field: "price" | "verificationStatus" | "listed";
  oldValue: string | boolean;
  newValue: string | boolean;
  detectedAt: number;
};

export type ResourceFetchData = {
  id?: string;
  title?: string;
  price?: string;
  verificationStatus?: string;
  listed?: boolean;
  accessUrl?: string;
};

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 120_000;
export const MAX_POLL_TIMEOUT_MS = 600_000;
export const MIN_POLL_INTERVAL_MS = 1_000;

export function normalizeTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_POLL_TIMEOUT_MS;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `timeoutMs must be a non-negative number (ms). Got: ${JSON.stringify(raw)}. Default is ${DEFAULT_POLL_TIMEOUT_MS}.`,
    );
  }
  return Math.min(Math.floor(n), MAX_POLL_TIMEOUT_MS);
}

export function normalizeIntervalMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_POLL_INTERVAL_MS;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw new Error(
      `intervalMs must be a number. Got: ${JSON.stringify(raw)}. Default is ${DEFAULT_POLL_INTERVAL_MS}.`,
    );
  }
  return Math.max(Math.floor(n), MIN_POLL_INTERVAL_MS);
}

export function normalizeWaitFlag(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  throw new Error(
    `wait must be a boolean. Got: ${JSON.stringify(raw)}. Pass wait: true to poll for changes.`,
  );
}

async function fetchResourceData(resourceId: string): Promise<ResourceFetchData> {
  const res = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  if (!res.ok) {
    throwHttpError({
      operation: "Resource fetch failed",
      source: "api",
      status: res.status,
      data: res.data,
    });
  }
  return res.data;
}

export type ResourceSubscriptionOptions = {
  resourceId: string;
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};

export type ResourceProgressReporter = (
  progress: number,
  total?: number,
  message?: string,
) => Promise<void>;

export async function subscribeResource(
  opts: ResourceSubscriptionOptions,
  onProgress?: ResourceProgressReporter,
): Promise<ResourceSubscriptionSnapshot> {
  const now = opts.now ?? Date.now;
  const startedAt = now();

  let previousData: ResourceFetchData | null = null;
  const changes: ResourceChange[] = [];
  let total = opts.wait ? Math.ceil(opts.timeoutMs / opts.intervalMs) + 1 : 1;
  let step = 0;
  let fetchCount = 0;

  const report = async (message: string): Promise<void> => {
    step += 1;
    if (step > total) total = step;
    await onProgress?.(step, total, message);
  };

  const result: ResourceSubscriptionPollResult<ResourceFetchData> = await pollResourceSubscription({
    fetch: async () => {
      fetchCount += 1;
      const data = await fetchResourceData(opts.resourceId);

      // Detect changes
      let changeDetected = false;
      if (previousData) {
        if (previousData.price !== data.price) {
          changes.push({
            field: "price",
            oldValue: previousData.price ?? "unknown",
            newValue: data.price ?? "unknown",
            detectedAt: now(),
          });
          changeDetected = true;
        }
        if (previousData.verificationStatus !== data.verificationStatus) {
          changes.push({
            field: "verificationStatus",
            oldValue: previousData.verificationStatus ?? "unknown",
            newValue: data.verificationStatus ?? "unknown",
            detectedAt: now(),
          });
          changeDetected = true;
        }
        if (previousData.listed !== data.listed) {
          changes.push({
            field: "listed",
            oldValue: previousData.listed ?? false,
            newValue: data.listed ?? false,
            detectedAt: now(),
          });
          changeDetected = true;
        }
      }

      // Emit progress notification for each poll
      if (changeDetected) {
        const changeMessages = changes
          .map((c) => `${c.field}: ${c.oldValue} → ${c.newValue}`)
          .join(", ");
        await report(`Changes detected: ${changeMessages}`);
      } else {
        await report(`No changes detected (poll ${fetchCount})`);
      }

      previousData = data;
      return data;
    },
    isSettled: () => false, // Never settle - keep polling for changes
    intervalMs: opts.intervalMs,
    timeoutMs: opts.wait ? opts.timeoutMs : 0,
    sleep: opts.sleep,
    now,
  });

  const finalData = result.snapshot;
  const elapsedMs = now() - startedAt;

  let message: string;
  if (result.timedOut) {
    message = `Subscription timed out after ${elapsedMs}ms. Detected ${changes.length} change(s).`;
  } else if (!opts.wait) {
    message = `Single check completed. No polling. Detected ${changes.length} change(s) from initial state.`;
  } else {
    message = `Monitoring completed after ${elapsedMs}ms. Detected ${changes.length} change(s).`;
  }

  return {
    resourceId: opts.resourceId,
    title: finalData.title ?? null,
    price: finalData.price ?? "unknown",
    verificationStatus: finalData.verificationStatus ?? "unknown",
    listed: finalData.listed ?? false,
    changes,
    polled: opts.wait,
    attempts: result.attempts,
    settled: result.settled,
    timedOut: result.timedOut,
    message,
  };
}
