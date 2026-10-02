/**
 * Size limits for catalog resource previews (#582).
 *
 * `mindvault_preview` echoes publisher-supplied metadata straight back to the
 * agent. Titles and descriptions have no upper bound at the source, so a single
 * preview can dominate an agent's context window — the same failure the shared
 * response budget (see truncation.ts) guards against for `browse` and `search`.
 *
 * The preview response is JSON, so the byte-level truncation used elsewhere is
 * not an option: cutting the serialized string leaves the agent with a document
 * it cannot parse. Instead the limit is applied to the *fields* before the
 * document is serialized, which keeps every response valid JSON:
 *
 * 1. Each free-text field is capped at a code-point budget.
 * 2. If the serialized document is still over the byte budget, the free-text
 *    fields are shrunk further (description first, then title) until it fits.
 * 3. Whenever anything was shortened, a `truncated` block names the affected
 *    fields and tells the agent how to get the full value.
 *
 * Identity fields — `id`, `price`, `accessUrl`, `type`, `verificationStatus` —
 * are never shortened. A clipped id or access URL would be worse than useless:
 * the agent would act on a value that looks complete but is not.
 */

/** Environment variable overriding the whole-response byte budget. */
export const PREVIEW_MAX_BYTES_ENV_VAR = "MINDVAULT_PREVIEW_MAX_BYTES";

/** Environment variable overriding the per-field code-point budget. */
export const PREVIEW_FIELD_MAX_CHARS_ENV_VAR = "MINDVAULT_PREVIEW_FIELD_MAX_CHARS";

/** Default byte ceiling for a serialized preview (8 KiB). */
export const DEFAULT_PREVIEW_MAX_BYTES = 8 * 1024;

/** Default code-point ceiling for a single free-text field. */
export const DEFAULT_PREVIEW_FIELD_MAX_CHARS = 1_000;

/**
 * Smallest byte budget that is actually honoured. A configured value below this
 * is raised to it, because the identity fields plus the truncation notice come
 * to roughly half a kilobyte on their own — a preview squeezed below that point
 * carries no usable information and the limit could not be met anyway.
 */
export const MIN_PREVIEW_MAX_BYTES = 1_024;

/** Free-text fields subject to the limits, in the order they are shrunk. */
export const CAPPED_PREVIEW_FIELDS = ["description", "title"] as const;

const TRUNCATION_NOTICE =
  "Preview shortened to fit the response size limit. Buy the resource for the full content, " +
  `or raise ${PREVIEW_MAX_BYTES_ENV_VAR} / ${PREVIEW_FIELD_MAX_CHARS_ENV_VAR}.`;

export interface PreviewLimits {
  /** Byte ceiling for the serialized preview. `0` disables the ceiling. */
  maxBytes: number;
  /** Code-point ceiling for each free-text field. `0` disables the cap. */
  fieldMaxChars: number;
}

/** A budget of 0 (or less) means "no limit", matching the timeout convention. */
export function isPreviewLimitDisabled(limit: number): boolean {
  return !Number.isFinite(limit) || limit <= 0;
}

/**
 * Parse one budget from the environment.
 *
 * A non-numeric or negative value falls back to the default rather than failing
 * the call — a typo in a client config must not break previews. `0` is
 * meaningful and kept: it disables that limit.
 */
function parseLimit(raw: string | undefined, fallback: number, minimum: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  const floored = Math.floor(parsed);
  if (floored === 0) return 0;
  return Math.max(floored, minimum);
}

/** Resolve both budgets from the environment, falling back to the defaults. */
export function resolvePreviewLimits(env: NodeJS.ProcessEnv = process.env): PreviewLimits {
  return {
    maxBytes: parseLimit(
      env[PREVIEW_MAX_BYTES_ENV_VAR],
      DEFAULT_PREVIEW_MAX_BYTES,
      MIN_PREVIEW_MAX_BYTES,
    ),
    fieldMaxChars: parseLimit(
      env[PREVIEW_FIELD_MAX_CHARS_ENV_VAR],
      DEFAULT_PREVIEW_FIELD_MAX_CHARS,
      1,
    ),
  };
}

/** Serialize a preview exactly the way the tool returns it. */
export function serializePreview(preview: Record<string, unknown>): string {
  return JSON.stringify(preview, null, 2);
}

function serializedBytes(preview: Record<string, unknown>): number {
  return new TextEncoder().encode(serializePreview(preview)).length;
}

/**
 * Keep the first `keep` code points of `value`, appending a marker that states
 * how much was dropped. Slicing by code point (not UTF-16 unit) means a
 * surrogate pair — an emoji, say — is never split into a lone half.
 */
function clip(value: string, keep: number, total: number): string {
  const head = Array.from(value).slice(0, keep).join("");
  return `${head}… [truncated: ${keep} of ${total} characters]`;
}

/**
 * Build the preview with each capped field rendered at the given length.
 * A length equal to the field's full size leaves the original value untouched.
 */
function render(
  preview: Record<string, unknown>,
  originals: Map<string, string>,
  lengths: Map<string, number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...preview };
  const truncated: string[] = [];

  for (const [field, value] of originals) {
    const total = Array.from(value).length;
    const keep = lengths.get(field) ?? total;
    if (keep >= total) continue;
    out[field] = clip(value, keep, total);
    truncated.push(field);
  }

  if (truncated.length > 0) {
    out.truncated = { fields: truncated.sort(), notice: TRUNCATION_NOTICE };
  }
  return out;
}

/**
 * Largest length for `field` that keeps the whole document within `maxBytes`,
 * found by binary search over the currently allowed range. Returns 0 when even
 * an empty field is not enough — the caller then moves on to the next field.
 */
function largestFittingLength(
  preview: Record<string, unknown>,
  originals: Map<string, string>,
  lengths: Map<string, number>,
  field: string,
  maxBytes: number,
): number {
  const attempt = (keep: number): boolean => {
    const probe = new Map(lengths);
    probe.set(field, keep);
    return serializedBytes(render(preview, originals, probe)) <= maxBytes;
  };

  let low = 0;
  let high = lengths.get(field) ?? 0;
  if (attempt(high)) return high;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (attempt(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Apply the preview size limits, returning a new object that is safe to
 * serialize with {@link serializePreview}.
 *
 * The input is returned unchanged (as a copy) when it already fits, so previews
 * of ordinary resources carry no extra keys.
 */
export function applyPreviewLimits(
  preview: Record<string, unknown>,
  limits: PreviewLimits = resolvePreviewLimits(),
): Record<string, unknown> {
  const originals = new Map<string, string>();
  for (const field of CAPPED_PREVIEW_FIELDS) {
    const value = preview[field];
    if (typeof value === "string" && value.length > 0) originals.set(field, value);
  }

  // Start from the per-field cap.
  const lengths = new Map<string, number>();
  for (const [field, value] of originals) {
    const total = Array.from(value).length;
    lengths.set(
      field,
      isPreviewLimitDisabled(limits.fieldMaxChars) ? total : Math.min(total, limits.fieldMaxChars),
    );
  }

  let candidate = render(preview, originals, lengths);
  if (isPreviewLimitDisabled(limits.maxBytes)) return candidate;
  if (serializedBytes(candidate) <= limits.maxBytes) return candidate;

  // Still too large: shrink the free-text fields, description first.
  for (const field of CAPPED_PREVIEW_FIELDS) {
    if (!originals.has(field)) continue;
    lengths.set(field, largestFittingLength(preview, originals, lengths, field, limits.maxBytes));
    candidate = render(preview, originals, lengths);
    if (serializedBytes(candidate) <= limits.maxBytes) return candidate;
  }

  // Nothing left to shrink — the identity fields alone exceed the budget. Return
  // the smallest honest preview rather than an unparseable fragment.
  return candidate;
}
