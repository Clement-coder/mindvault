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
 *     $ jq -c 'select(.correlationId == "mv-1a2b3c-d4e5-k7q2p1")' audit.jsonl
 *
 * Issue #1074 widened the ID with a per-process salt so several MCP servers on
 * one host cannot mint the same ID; see {@link createCorrelationIdGenerator}.
 *
 * The context is an `AsyncLocalStorage`, not a module-level variable. The
 * server handles tool calls concurrently, and a shared mutable "current ID"
 * would attribute one call's network requests to another — which is worse than
 * having no IDs at all, because the log would look correct.
 *
 * ID generation is injectable (clock, randomness, salt) so tests can pin exact
 * IDs, and each generator carries a per-process salt so IDs stay unique when
 * several MCP servers share a host or start at the same instant (#1074).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { threadId } from "node:worker_threads";

/** Prefix, so an ID is recognisable on sight in a mixed log. */
const ID_PREFIX = "mv";

/** Base36 width of the random component that separates same-millisecond calls. */
const RANDOM_LENGTH = 4;

/** Number of values the random component is drawn from: 36**4 = 1,679,616. */
const RANDOM_SPACE = 36 ** RANDOM_LENGTH;

/**
 * Base36 width of the per-generator salt that separates worker processes.
 *
 * The salt is drawn from the CSPRNG and padded to this width, so its character
 * length never reveals how much entropy it carries.
 */
const SALT_LENGTH = 6;

/** Number of values the salt is drawn from: 36**6 = 2,176,782,336. */
const SALT_SPACE = 36 ** SALT_LENGTH;

/**
 * Key under which the ID travels in an MCP result's `_meta`.
 */
export const CORRELATION_META_KEY = "mindvault/correlationId";

/**
 * Storage for the in-flight call's ID.
 *
 * Exported for tests only; use {@link runWithCorrelationId} and
 * {@link currentCorrelationId} rather than touching this directly.
 */
export const correlationStorage = new AsyncLocalStorage<string>();

/**
 * Derive a salt that distinguishes one generator from every other.
 *
 * The salt is what makes IDs collision-resistant *across* processes. Two MCP
 * servers can share a host, start in the same millisecond, and — if their
 * clocks and randomness lined up — mint the same time and random components;
 * only a per-process salt keeps them apart. It is drawn from the CSPRNG, not
 * `Math.random`, so it does not depend on the same draw that the random
 * component consumes, and it is mixed with the pid and worker-thread id so
 * processes that reuse a pid (containers all see pid 1) still diverge.
 *
 * The result is always {@link SALT_LENGTH} base36 digits: the entropy is
 * reduced modulo 36**SALT_LENGTH, so the widening only ever helps.
 */
function newProcessSalt(): string {
  const entropy = randomBytes(4).readUInt32BE(0) % SALT_SPACE;
  const identity = ((process.pid >>> 0) ^ Math.imul(threadId + 1, 0x9e3779b1)) >>> 0;
  return (((entropy ^ identity) >>> 0) % SALT_SPACE).toString(36).padStart(SALT_LENGTH, "0");
}

/** Options for {@link createCorrelationIdGenerator}. */
export interface CorrelationIdGeneratorOptions {
  /** Clock, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Randomness in `[0, 1)`, injectable for tests. Defaults to `Math.random`. */
  random?: () => number;
  /**
   * Base36 salt distinguishing this generator's IDs from every other. Defaults
   * to a fresh CSPRNG/pid/thread-derived salt, so independent generators never
   * collide even when they share a clock and randomness.
   */
  salt?: string;
}

/** Format one ID from its parts. */
function formatCorrelationId(time: number, random: number, salt: string): string {
  const suffix = Math.floor(random * RANDOM_SPACE)
    .toString(36)
    .padStart(RANDOM_LENGTH, "0");
  return `${ID_PREFIX}-${time.toString(36)}-${suffix}-${salt}`;
}

/**
 * Create an independent generator of correlation IDs.
 *
 * Each generator owns its own salt, so two generators handed the *same* clock
 * and the *same* random draw still mint distinct IDs — the case the issue calls
 * out directly: several MCP server processes on one host, started at the same
 * instant. The default {@link newCorrelationId} is such a generator, seeded
 * once per module load (one salt per process).
 *
 * The returned function is deterministic in `(clock, random, salt)`, so tests
 * can pin exact IDs.
 */
export function createCorrelationIdGenerator(
  options: CorrelationIdGeneratorOptions = {},
): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const salt = options.salt ?? newProcessSalt();
  return () => formatCorrelationId(now(), random(), salt);
}

/** The process-wide salt backing {@link newCorrelationId} (one per process). */
const DEFAULT_SALT = newProcessSalt();

/**
 * Mint a correlation ID.
 *
 * Format: `mv-<time>-<random>-<salt>`, all base36 except the prefix. The time
 * component sorts chronologically as a string, so IDs from one session group
 * naturally when a log is sorted; the four-digit random component distinguishes
 * calls that share a millisecond, and the salt distinguishes worker processes.
 *
 * The random component spans 36**4 = 1,679,616 values, sized for real tool
 * calls — each does network I/O, so a handful per millisecond is already an
 * extreme burst. It is not sized for a synthetic loop: 500 IDs minted in one
 * millisecond by a *single* generator collide about 7% of the time. Widening it
 * buys nothing, because the suffix is still deterministic in (clock, random) —
 * so tests can pin exact IDs — and an ID that a test pins must not be silently
 * rewritten. Collision resistance *across* processes is the salt's job instead:
 * a cross-process collision needs both the 36**4 random component and the
 * 36**6 salt to match, about one in 6e15 for a pair minting in the same
 * millisecond.
 *
 * Short on purpose — it is meant to be read aloud, pasted into an issue, and
 * typed into a `grep`.
 */
export function newCorrelationId(
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  return formatCorrelationId(now(), random(), DEFAULT_SALT);
}

/**
 * Whether a string looks like an ID this module minted.
 *
 * The salt segment is optional so IDs minted before #1074 — which had no
 * per-process salt — are still recognised when reading an older log. New IDs
 * always carry it.
 */
export function isCorrelationId(value: unknown): value is string {
  return typeof value === "string" && /^mv-[0-9a-z]+-[0-9a-z]{4}(?:-[0-9a-z]+)?$/.test(value);
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

/**
 * Header carrying the correlation id. Matches the server's `x-request-id`.
 * Kept consistent with `CORRELATION_META_KEY`'s suffix so a request id and a
 * result meta id can be joined in server logs.
 */
export const CORRELATION_HEADER = "x-request-id";

/**
 * A header bag carrying the ambient correlation id.
 *
 * The extra headers are passed through and the id is applied last, so it
 * cannot be shadowed by a caller-supplied value (for example one the x402
 * wrapper set). Outside a tool call there is no ambient id, so the extra
 * headers return unchanged — on the wire that is the same as the `undefined`
 * id this used to put in the bag, because fetch skips undefined header values.
 */
export function correlationHeaders(extra?: Record<string, string>): Record<string, string> {
  const id = currentCorrelationId();
  return id === undefined ? { ...extra } : { ...extra, [CORRELATION_HEADER]: id };
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
