/**
 * Publish status polling helpers for the MindVault MCP server.
 *
 * After mindvault_publish, agents use mindvault_publish_status to read
 * verificationStatus (pending | verified | rejected | skipped) and on-chain
 * sync fields (onchainStatus, onchainTxHash), optionally waiting until
 * verification settles.
 */

export const VERIFICATION_STATUSES = ["pending", "verified", "rejected", "skipped"] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const ONCHAIN_STATUSES = ["none", "pending", "registered", "failed"] as const;

export type OnchainStatus = (typeof ONCHAIN_STATUSES)[number];

/** Terminal verification states — polling stops when one of these is reached. */
export const SETTLED_VERIFICATION = new Set<VerificationStatus>([
  "verified",
  "rejected",
  "skipped",
]);

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;
export const MAX_POLL_TIMEOUT_MS = 300_000;
export const MIN_POLL_INTERVAL_MS = 200;

export type PublishStatusSnapshot = {
  resourceId: string;
  title: string | null;
  verificationStatus: VerificationStatus | string;
  listed: boolean | null;
  onchainStatus: OnchainStatus | string | null;
  onchainTxHash: string | null;
  contentHash: string | null;
  accessUrl: string | null;
  verification: {
    isOriginal: boolean | null;
    confidence: number | null;
    flags: unknown[];
    checkedAt: string | null;
  } | null;
  polled: boolean;
  attempts: number;
  settled: boolean;
  timedOut: boolean;
  message: string;
};

export type PublishStatusFetch = {
  meta: {
    id?: string;
    title?: string;
    verificationStatus?: string;
    onchainStatus?: string | null;
    onchainTxHash?: string | null;
    contentHash?: string | null;
    accessUrl?: string | null;
    listed?: boolean;
  } | null;
  verification: {
    resourceId?: string;
    title?: string;
    status?: string;
    listed?: boolean;
    verification?: {
      isOriginal?: boolean;
      confidence?: number;
      flags?: unknown[];
      checkedAt?: string;
    } | null;
  } | null;
};

/** One backend response as returned by the MCP server's `jsonFetch`. */
export type PublishStatusResponse = {
  ok: boolean;
  status: number;
  data: any;
};

export function isVerificationSettled(status: string | null | undefined): boolean {
  if (!status) return false;
  return SETTLED_VERIFICATION.has(status as VerificationStatus);
}

function resourceNotFound(resourceId: string): Error {
  return new Error(
    `Resource "${resourceId}" not found. Confirm the id from mindvault_publish or mindvault_browse.`,
  );
}

/**
 * Combine one poll's `/meta` and `/verification` responses into a snapshot.
 *
 * A failed request (after `jsonFetch` has exhausted its retries) fails the
 * poll, except when the other endpoint already reports a terminal
 * verification status. Both endpoints read the same column and a settled
 * status never goes back to pending, so that poll has settled: throwing there
 * discarded a `rejected` the server had already returned and ended a
 * `wait: true` call in an error instead of stopping at the terminal state
 * (#840).
 */
export function publishStatusFromResponses(
  resourceId: string,
  metaRes: PublishStatusResponse,
  verRes: PublishStatusResponse,
): PublishStatusFetch {
  if (metaRes.status === 404 && verRes.status === 404) {
    throw resourceNotFound(resourceId);
  }

  const meta = metaRes.ok ? metaRes.data : null;
  const verification = verRes.ok ? verRes.data : null;
  const settled =
    isVerificationSettled(verification?.status) || isVerificationSettled(meta?.verificationStatus);

  if (!settled && !metaRes.ok && metaRes.status !== 404) {
    throw new Error(
      `Publish status meta failed [${metaRes.status}]: ${JSON.stringify(metaRes.data)}`,
    );
  }
  if (!settled && !verRes.ok && verRes.status !== 404) {
    throw new Error(
      `Publish status verification failed [${verRes.status}]: ${JSON.stringify(verRes.data)}`,
    );
  }
  if (!metaRes.ok && !verRes.ok) {
    throw resourceNotFound(resourceId);
  }

  return { meta, verification };
}

/** The verification status a fetched snapshot reports, defaulting to pending. */
export function currentVerificationStatus(data: PublishStatusFetch): string {
  return data.verification?.status ?? data.meta?.verificationStatus ?? "pending";
}

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
  if (!Number.isFinite(n) || n < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `intervalMs must be a number ≥ ${MIN_POLL_INTERVAL_MS} (ms). Got: ${JSON.stringify(raw)}. Default is ${DEFAULT_POLL_INTERVAL_MS}.`,
    );
  }
  return Math.floor(n);
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
    `wait must be a boolean. Got: ${JSON.stringify(raw)}. Pass wait: true to poll until verification settles.`,
  );
}

export function buildPublishStatusSnapshot(
  resourceId: string,
  data: PublishStatusFetch,
  opts: { polled: boolean; attempts: number; timedOut: boolean },
): PublishStatusSnapshot {
  const meta = data.meta;
  const ver = data.verification;
  const verificationStatus = ver?.status ?? meta?.verificationStatus ?? "pending";
  const settled = isVerificationSettled(verificationStatus);
  const onchainStatus = meta?.onchainStatus ?? null;
  const onchainTxHash = meta?.onchainTxHash ?? null;

  let message: string;
  if (opts.timedOut && !settled) {
    message = `Timed out waiting for verification to settle (last status: ${verificationStatus}). Re-run mindvault_publish_status or increase timeoutMs.`;
  } else if (verificationStatus === "pending") {
    message = "Verification is still pending. Pass wait: true to poll, or re-check shortly.";
  } else if (verificationStatus === "verified") {
    message =
      onchainStatus === "registered"
        ? "Verified and registered on-chain."
        : onchainStatus === "failed"
          ? "Verified, but on-chain registration failed — retry with mindvault_register_onchain."
          : onchainStatus === "pending"
            ? "Verified; on-chain registration is still pending."
            : "Verified. On-chain registration may still be needed — use mindvault_register_onchain if onchainStatus is none/failed.";
  } else if (verificationStatus === "rejected") {
    message = "Verification rejected the resource. It will not be listed for purchase.";
  } else if (verificationStatus === "skipped") {
    message = "Verification was skipped for this resource.";
  } else {
    message = `Current verification status: ${verificationStatus}.`;
  }

  const detail = ver?.verification ?? null;

  return {
    resourceId,
    title: ver?.title ?? meta?.title ?? null,
    verificationStatus,
    listed: ver?.listed ?? meta?.listed ?? null,
    onchainStatus,
    onchainTxHash,
    contentHash: meta?.contentHash ?? null,
    accessUrl: meta?.accessUrl ?? null,
    verification: detail
      ? {
          isOriginal: detail.isOriginal ?? null,
          confidence: detail.confidence ?? null,
          flags: Array.isArray(detail.flags) ? detail.flags : [],
          checkedAt: detail.checkedAt ?? null,
        }
      : null,
    polled: opts.polled,
    attempts: opts.attempts,
    settled,
    timedOut: opts.timedOut,
    message,
  };
}

// ── Streaming progress while waiting for verification ───────────────────────

/** Emits an MCP `notifications/progress` update; a no-op without a progress token. */
export type PublishProgressReporter = (
  progress: number,
  total?: number,
  message?: string,
) => Promise<void>;

/**
 * Best-effort estimate of how many polls a wait window allows, used as the
 * `total` of the emitted progress notifications so clients can render a bar.
 */
export function estimatePollSteps(wait: boolean, timeoutMs: number, intervalMs: number): number {
  if (!wait) return 1;
  const interval = Math.max(intervalMs, MIN_POLL_INTERVAL_MS);
  return Math.max(1, Math.ceil(timeoutMs / interval) + 1);
}

/** Human-readable text attached to a publish-verification progress notification. */
export function publishProgressMessage(input: {
  attempt: number;
  status: string;
  settled: boolean;
  timedOut: boolean;
  wait: boolean;
}): string {
  const polls = `${input.attempt} poll${input.attempt === 1 ? "" : "s"}`;
  if (input.timedOut) {
    return `Timed out after ${polls} — verification still ${input.status}.`;
  }
  if (input.settled) {
    return `Verification ${input.status} after ${polls}.`;
  }
  if (!input.wait) {
    return `Verification ${input.status} — single check, pass wait: true to poll.`;
  }
  return `Verification ${input.status} — poll ${input.attempt}, still waiting.`;
}

export type PollPublishStatusOptions = {
  resourceId: string;
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
  /** Fetches one status snapshot; throws for unknown resources. */
  fetchStatus: (resourceId: string) => Promise<PublishStatusFetch>;
  onProgress?: PublishProgressReporter;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PollPublishStatusResult = {
  data: PublishStatusFetch;
  attempts: number;
  timedOut: boolean;
};

/**
 * Fetch verification status once, or poll until it settles when `wait` is set,
 * streaming a progress notification after every poll.
 *
 * The emitted `progress` value increments once per notification — never
 * repeating or decreasing, as MCP requires — and `total` grows if the poll
 * outlasts the initial estimate.
 */
export async function pollPublishStatus(
  opts: PollPublishStatusOptions,
): Promise<PollPublishStatusResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.wait ? opts.timeoutMs : 0);

  let total = estimatePollSteps(opts.wait, opts.timeoutMs, opts.intervalMs);
  let step = 0;
  let attempts = 0;
  let timedOut = false;

  const report = async (status: string, settled: boolean): Promise<void> => {
    step += 1;
    if (step > total) total = step;
    await opts.onProgress?.(
      step,
      total,
      publishProgressMessage({ attempt: attempts, status, settled, timedOut, wait: opts.wait }),
    );
  };

  // Always fetch at least once, even when not waiting.
  let data = await opts.fetchStatus(opts.resourceId);
  attempts += 1;
  let status = currentVerificationStatus(data);
  await report(status, isVerificationSettled(status));

  while (opts.wait) {
    if (isVerificationSettled(status)) break;
    if (now() >= deadline) {
      timedOut = true;
      await report(status, false);
      break;
    }
    await sleepUntilNextPoll(opts.sleep, opts.intervalMs, deadline - now());
    data = await opts.fetchStatus(opts.resourceId);
    attempts += 1;
    status = currentVerificationStatus(data);
    const settled = isVerificationSettled(status);
    if (!settled && now() >= deadline) timedOut = true;
    await report(status, settled);
    if (settled || timedOut) break;
  }

  return { data, attempts, timedOut };
}

function sleepUntilNextPoll(
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  remainingMs: number,
): Promise<void> {
  return sleep(Math.min(intervalMs, Math.max(0, remainingMs)));
}
