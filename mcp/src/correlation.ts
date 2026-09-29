/**
 * Outbound request correlation for the MindVault MCP server (#849).
 *
 * Every outbound request the MCP server makes — the MindVault API, Horizon,
 * Soroban RPC, the sponsored-account service, and x402 paid fetches — now
 * carries an `x-request-id` header. The API echoes that id back and scopes its
 * request context to it (see `server/src/middleware/requestContext.ts`), so an
 * operator reading the server logs can find every request one MCP tool call
 * produced, even when several tools are in flight at once.
 *
 * The id is bound to the *tool call*, not to the process. A single
 * `mindvault_buy` issues a catalog/meta read and then an x402 payment; both legs
 * carry the same id, so the trace stitches. A later, unrelated tool call opens
 * a fresh scope and can never inherit the previous call's id. Requests made
 * outside any tool call — the startup binding check, for instance — fall back to
 * a lazily created process-wide id so they are stamped too rather than silent.
 *
 * This module is pure apart from the ambient async context, so the behaviour is
 * unit-testable without a network or a live MCP client.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Header carrying the correlation id. Matches the server's `x-request-id`. */
export const CORRELATION_HEADER = "x-request-id";

/**
 * Environment variable that pins the correlation id for the whole process.
 *
 * Set it when one MCP process serves a single agent session and you want every
 * request in that session to share one id in the server logs. Unset (the
 * default), each tool call gets its own id.
 */
export const CORRELATION_ENV_VAR = "MINDVAULT_CORRELATION_ID";

/** Generate a fresh correlation id. */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Resolve the id to use outside any tool-call scope: the configured override
 * when set, otherwise one lazily created process-wide id.
 *
 * Read from `process.env` on every call (not memoized wholesale) so a
 * configuration change takes effect without restarting the module, and so
 * tests can toggle the variable between cases.
 */
let processId: string | null = null;
export function resolveProcessCorrelationId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CORRELATION_ENV_VAR];
  if (configured && configured.trim()) return configured.trim();
  processId ??= newCorrelationId();
  return processId;
}

const scope = new AsyncLocalStorage<string>();

/**
 * The correlation id for the current async scope.
 *
 * Returns the enclosing tool call's id when there is one, and the process-wide
 * fallback otherwise. Never returns an empty string, so every request is
 * stamped.
 */
export function currentCorrelationId(): string {
  return scope.getStore() ?? resolveProcessCorrelationId();
}

/** Run `fn` with `id` as the correlation id for everything it awaits. */
export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return scope.run(id, fn);
}

/** Run `fn` in a fresh correlation scope with a newly generated id. */
export function withNewCorrelationId<T>(fn: () => T): T {
  return scope.run(newCorrelationId(), fn);
}

/**
 * Merge the correlation header into a header bag.
 *
 * The id is applied last so it cannot be shadowed by a caller-supplied value.
 */
export function correlationHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...extra, [CORRELATION_HEADER]: currentCorrelationId() };
}

/** True when a header bag already carries the correlation header, any case. */
function hasCorrelationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === CORRELATION_HEADER);
}

/**
 * Return a `RequestInit` that carries the correlation header.
 *
 * A header the caller already set is left alone: an explicit id (for example
 * one supplied by the x402 wrapper) is more specific than the ambient one.
 */
export function stampCorrelation(init?: RequestInit): RequestInit {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (hasCorrelationHeader(headers)) return { ...init };
  return { ...init, headers: { ...headers, [CORRELATION_HEADER]: currentCorrelationId() } };
}

/**
 * Wrap a fetch so every request it issues carries the correlation header.
 *
 * Used for the x402 paid fetch, where the wrapper issues the request itself
 * (the 402 probe and the paid retry) rather than the caller doing so.
 */
export function withCorrelation(fetchImpl: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(input, stampCorrelation(init))) as typeof fetch;
}
