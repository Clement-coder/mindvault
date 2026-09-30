/**
 * Tool result correlation IDs — issue #572.
 *
 * The audit log records a tool call as several independent entries: a `start`,
 * every network request the tool made, and a `success` or `error`. Nothing ties
 * them together. With one agent making one call at a time you can read the
 * order and guess; with two concurrent calls, or a log covering a whole
 * session, you cannot. "Which of these four Horizon requests belonged to the
 * purchase that failed?" is currently unanswerable.
 *
 * A correlation ID is minted per tool call, carried implicitly for the
 * duration of that call, and stamped on every audit entry produced underneath
 * it. The same ID is attached to the tool's MCP result, so a user reporting a
 * problem can quote it and an operator can `grep` straight to the relevant
 * lines:
 *
 *     $ jq -c 'select(.correlationId == "mv-1a2b3c-d4e5")' audit.jsonl
 *
 * The context is an `AsyncLocalStorage`, not a module-level variable. The
 * server handles tool calls concurrently, and a shared mutable "current ID"
 * would attribute one call's network requests to another — which is worse than
 * having no IDs at all, because the log would look correct.
 *
 * ID generation is injectable (clock, randomness) so tests are deterministic.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Prefix, so an ID is recognisable on sight in a mixed log. */
const ID_PREFIX = "mv";

/** Key under which the ID travels in an MCP result's `_meta`. */
export const CORRELATION_META_KEY = "mindvault/correlationId";

/**
 * Storage for the in-flight call's ID.
 *
 * Exported for tests only; use {@link runWithCorrelationId} and
 * {@link currentCorrelationId} rather than touching this directly.
 */
export const correlationStorage = new AsyncLocalStorage<string>();

/**
 * Mint a correlation ID.
 *
 * Format: `mv-<time>-<random>`, both base36. The time component sorts
 * chronologically as a string, so IDs from one session group naturally when a
 * log is sorted; the four-digit random component distinguishes calls that
 * share a millisecond.
 *
 * That suffix spans 36**4 = 1,679,616 values, which is sized for real tool
 * calls — each does network I/O, so a handful per millisecond is already an
 * extreme burst and the collision odds there are far below one in a million.
 * It is not sized for a synthetic loop: 500 IDs minted in a single millisecond
 * collide about 7% of the time. Widening it is possible, but a uniqueness
 * counter is not — `newCorrelationId` is deterministic in (clock, random) on
 * purpose, so that tests can pin exact IDs.
 *
 * Short on purpose — it is meant to be read aloud, pasted into an issue, and
 * typed into a `grep`.
 */
export function newCorrelationId(
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  const time = now().toString(36);
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${ID_PREFIX}-${time}-${suffix}`;
}

/** Whether a string looks like an ID this module minted. */
export function isCorrelationId(value: unknown): value is string {
  return typeof value === "string" && /^mv-[0-9a-z]+-[0-9a-z]{4}$/.test(value);
}

/**
 * Run `fn` with `id` as the ambient correlation ID.
 *
 * Everything awaited inside — including audit logging from nested network
 * calls — sees the same ID. Concurrent calls each get their own context.
 */
export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return correlationStorage.run(id, fn);
}

/**
 * Mint an ID, run `fn` under it, and hand the ID to the callback.
 *
 * The usual entry point at a tool-dispatch site: the caller needs the ID both
 * for the ambient context and to attach to the outgoing result.
 */
export function withNewCorrelationId<T>(fn: (id: string) => T, id: string = newCorrelationId()): T {
  return runWithCorrelationId(id, () => fn(id));
}

/**
 * The in-flight call's ID, or `undefined` outside any tool call.
 *
 * Undefined rather than a placeholder: an entry with no ID is honest about not
 * belonging to a tool call, whereas a made-up one would imply a correlation
 * that does not exist.
 */
export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

/** Shape of an MCP tool result, narrowed to what this module touches. */
export interface ResultWithMeta {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Attach the ID to an MCP tool result.
 *
 * It goes in `_meta`, which the MCP specification reserves for exactly this
 * kind of out-of-band annotation, rather than into the text an agent reads.
 * Appending it to the text would change every tool's output and put an opaque
 * token in front of the model on every successful call.
 *
 * Any `_meta` the result already carries is preserved.
 */
export function attachCorrelationId<T extends ResultWithMeta>(
  result: T,
  id: string | undefined = currentCorrelationId(),
): T {
  if (!id) return result;
  return { ...result, _meta: { ...(result._meta ?? {}), [CORRELATION_META_KEY]: id } };
}

/** Read the ID back off a result, or `undefined` when it carries none. */
export function correlationIdOf(result: ResultWithMeta | null | undefined): string | undefined {
  const value = result?._meta?.[CORRELATION_META_KEY];
  return typeof value === "string" ? value : undefined;
}

/**
 * A one-line suffix for an error message, so the ID reaches the user in the
 * one case where they are likely to report it.
 *
 * Only used on failures. On a successful call the ID is in `_meta` and the
 * agent has no reason to see it.
 */
export function correlationSuffix(id: string | undefined = currentCorrelationId()): string {
  return id ? ` [correlation: ${id}]` : "";
}
