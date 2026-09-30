/**
 * Size-based rotation for the JSONL audit log — issue #592.
 *
 * Audit entries currently go to stderr only, pretty-printed across several
 * lines. That is fine to watch live and useless to keep: whoever runs the
 * server has to capture stderr themselves, and a multi-line object cannot be
 * read back line by line. An agent left running for a week produces a log
 * nobody can grep and nobody bounded.
 *
 * This module adds the durable half. Entries are appended to a file as
 * **JSON Lines** — exactly one compact JSON object per line, so `tail`, `jq -c`
 * and any line-oriented shipper work on it directly — and the file is rotated
 * once it passes a size limit, keeping a fixed number of older generations.
 *
 * Rotation is the boring numbered-suffix scheme, deliberately: `audit.jsonl`
 * becomes `audit.jsonl.1`, `.1` becomes `.2`, and the generation past
 * `maxFiles` is deleted. It is obvious from a directory listing which file is
 * newest, and it needs no index or manifest that could disagree with what is
 * on disk.
 *
 * Everything is synchronous. An audit record that is buffered when the process
 * exits is an audit record that does not exist, and these writes are small and
 * infrequent relative to the network calls they describe.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Environment variables controlling the file sink. */
export const AUDIT_FILE_ENV_VARS = {
  file: "MINDVAULT_AUDIT_LOG_FILE",
  maxBytes: "MINDVAULT_AUDIT_LOG_MAX_BYTES",
  maxFiles: "MINDVAULT_AUDIT_LOG_MAX_FILES",
} as const;

/** 5 MiB: large enough to hold a long session, small enough to open. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Generations kept besides the live file, so 5 files at most by default. */
export const DEFAULT_MAX_FILES = 4;

/** Hard floor on the size limit, so a typo cannot rotate on every line. */
export const MIN_MAX_BYTES = 1024;

export interface RotationConfig {
  /** Absolute or relative path of the live log file. */
  path: string;
  /** Rotate once the live file would exceed this many bytes. */
  maxBytes: number;
  /** How many rotated generations to keep (`.1` … `.maxFiles`). */
  maxFiles: number;
}

/**
 * Resolve the file-sink configuration from the environment.
 *
 * Returns `null` when no path is set — the file sink is opt-in, and stderr
 * logging keeps working on its own.
 *
 * A malformed number falls back to the default rather than failing startup: an
 * audit log is a diagnostic, and a typo in its size limit must not stop the
 * server from serving.
 */
export function resolveRotationConfig(env: NodeJS.ProcessEnv = process.env): RotationConfig | null {
  const path = env[AUDIT_FILE_ENV_VARS.file]?.trim();
  if (!path) return null;

  return {
    path,
    maxBytes: parsePositiveInt(env[AUDIT_FILE_ENV_VARS.maxBytes], DEFAULT_MAX_BYTES, MIN_MAX_BYTES),
    maxFiles: parsePositiveInt(env[AUDIT_FILE_ENV_VARS.maxFiles], DEFAULT_MAX_FILES, 0),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, minimum: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.floor(parsed);
}

/** The path of generation `n` (1 = most recently rotated). */
export function rotatedPath(basePath: string, generation: number): string {
  return `${basePath}.${generation}`;
}

/**
 * Serialise one entry as a JSONL line.
 *
 * Compact, and newlines inside string values are escaped by `JSON.stringify`
 * itself, so one entry can never become two lines — the invariant the whole
 * format rests on.
 */
export function formatJsonl(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * Appends JSONL entries to a file, rotating it by size.
 *
 * The writer tolerates a filesystem that refuses it. A read-only directory or
 * a full disk disables the sink and is reported once through `onError`; it
 * never throws into the caller, because failing a paid tool call over a
 * logging problem trades a small loss for a large one.
 */
export class RotatingJsonlWriter {
  readonly config: RotationConfig;

  private size = 0;
  private ready = false;
  private disabled = false;
  private readonly onError: (error: unknown) => void;

  constructor(config: RotationConfig, onError: (error: unknown) => void = () => {}) {
    this.config = config;
    this.onError = onError;
  }

  /** False once a filesystem error has taken the sink out of service. */
  get enabled(): boolean {
    return !this.disabled;
  }

  /** Bytes currently in the live file, as tracked by this writer. */
  get currentSize(): number {
    return this.size;
  }

  /**
   * Append one entry.
   *
   * Rotation happens *before* the write when the line would push the file past
   * the limit, so the limit is an actual ceiling rather than something the file
   * is allowed to exceed by one entry. A single line larger than the whole
   * budget still gets written — truncating an audit record would be worse than
   * briefly exceeding a size target.
   */
  write(entry: unknown): void {
    if (this.disabled) return;

    const line = formatJsonl(entry);
    const bytes = Buffer.byteLength(line, "utf-8");

    try {
      this.ensureReady();
      if (this.size > 0 && this.size + bytes > this.config.maxBytes) {
        this.rotate();
      }
      appendFileSync(this.config.path, line, { encoding: "utf-8" });
      this.size += bytes;
    } catch (error) {
      // One report, then silence: a broken disk must not turn every
      // subsequent tool call into a second error message.
      this.disabled = true;
      this.onError(error);
    }
  }

  /** Create the directory and adopt the size of any existing log. */
  private ensureReady(): void {
    if (this.ready) return;

    const directory = dirname(this.config.path);
    if (directory && directory !== "." && !existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    // Resuming an existing file rather than truncating it: a restart must not
    // destroy the audit trail of the session before it.
    this.size = existsSync(this.config.path) ? statSync(this.config.path).size : 0;
    this.ready = true;
  }

  /**
   * Shift every generation up by one and free the live path.
   *
   * Walked newest-last so no rename overwrites a file that has not been moved
   * yet. With `maxFiles` of 0 the live file is simply discarded, which is the
   * "keep only what is current" configuration.
   */
  private rotate(): void {
    const { path, maxFiles } = this.config;
    // Rotation is serialized with append: re-stat first so any tail written by a
    // concurrent append is carried into the rotated generation, never truncated (#844).
    this.size = existsSync(path) ? statSync(path).size : 0;

    if (maxFiles <= 0) {
      rmSync(path, { force: true });
      this.size = 0;
      return;
    }

    // The oldest generation falls off the end.
    rmSync(rotatedPath(path, maxFiles), { force: true });

    for (let generation = maxFiles - 1; generation >= 1; generation--) {
      const from = rotatedPath(path, generation);
      if (existsSync(from)) renameSync(from, rotatedPath(path, generation + 1));
    }

    if (existsSync(path)) renameSync(path, rotatedPath(path, 1));
    this.size = 0;
  }
}

/**
 * Build a writer from the environment, or `null` when the sink is not
 * configured.
 */
export function createRotatingWriter(
  env: NodeJS.ProcessEnv = process.env,
  onError?: (error: unknown) => void,
): RotatingJsonlWriter | null {
  const config = resolveRotationConfig(env);
  return config ? new RotatingJsonlWriter(config, onError) : null;
}
