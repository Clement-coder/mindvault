/**
 * Progress notification helpers for long-running MCP tools.
 *
 * When a client supplies a progress token via `_meta.progressToken`, the server
 * emits `notifications/progress` at each phase boundary so the client can show
 * a progress indicator. When no token is supplied the helpers are no-ops.
 */
import { type Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";

export type SendNotification = (notification: ServerNotification) => Promise<void>;

export interface ProgressContext {
  /** The client-supplied progress token, if any. */
  token?: string | number;
  /** Sends a notification through the server transport. */
  send: SendNotification;
}

/**
 * Create a progress helper bound to the current request's progress token.
 * Returns a no-op function when `token` is undefined.
 */
export function createProgressEmitter(
  ctx: ProgressContext,
): (progress: number, total?: number, message?: string) => Promise<void> {
  if (ctx.token == null) {
    return async () => {};
  }
  const { token, send } = ctx;
  return async (progress: number, total?: number, message?: string) => {
    const params: Record<string, unknown> = {
      progressToken: token,
      progress,
    };
    if (total != null) params.total = total;
    if (message != null) params.message = message;
    await send({
      method: "notifications/progress",
      params: params as {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      },
    });
  };
}

/** Emits one progress update; returns once the notification has been handed to the transport. */
export type ProgressFn = (progress: number, total?: number, message?: string) => Promise<void>;

/** Progress reporting bound to the lifetime of one tool call. */
export interface RequestProgress {
  /** Forwards to the underlying emitter while the call is running; a no-op after `settle`. */
  emit: ProgressFn;
  /**
   * Wait for every notification already started, then drop any later `emit`.
   * The request handler calls this before it returns the tool result.
   */
  settle: () => Promise<void>;
}

/**
 * Scope a progress emitter to a single tool call so that no notification is
 * sent after the call's result (#841).
 *
 * A progress notification belongs to the request that carried its token. Once
 * the result has gone out, some transports have already closed that request's
 * stream (Streamable HTTP ends the SSE response) and drop a later notification
 * without an error, and the client has stopped tracking the token anyway. So
 * an update must be delivered before the result or not at all:
 *
 *  - `emit` tracks each send, so one started but not awaited — a
 *    fire-and-forget call, or a send still in flight when the tool resolves —
 *    is finished before the result is sent rather than racing it;
 *  - once `settle` runs, `emit` stops sending, so a callback that outlives the
 *    tool cannot write to the transport after the result.
 *
 * A failed send still rejects the `emit` promise the tool awaits, exactly as
 * before; `settle` itself never throws.
 */
export function scopeProgressToRequest(
  emit: (progress: number, total?: number, message?: string) => void | Promise<void>,
): RequestProgress {
  const inFlight = new Set<Promise<void>>();
  let settled = false;

  return {
    emit: (progress, total, message) => {
      if (settled) return Promise.resolve();
      let sent: Promise<void>;
      try {
        sent = Promise.resolve(emit(progress, total, message));
      } catch (err) {
        sent = Promise.reject(err);
      }
      inFlight.add(sent);
      const done = () => {
        inFlight.delete(sent);
      };
      sent.then(done, done);
      return sent;
    },
    settle: async () => {
      settled = true;
      await Promise.allSettled([...inFlight]);
    },
  };
}
