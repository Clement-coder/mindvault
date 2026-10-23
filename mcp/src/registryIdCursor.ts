/**
 * Opaque cursor tokens for the contract's id-indexed listings.
 *
 * The vault registry returns an `IdCursor` — `Start`, `After(position, id,
 * created_at)`, or `End` — from `list_by_creator_page` and
 * `list_by_creator_page_filtered`. That is a contract-internal shape: an agent
 * should not have to know that a cursor is a triple, and it should not be
 * able to hand-edit one. The token below is base64url-encoded JSON, the same
 * shape `catalogCursor.ts` uses for the MindVault API catalog, so a cursor
 * stays opaque, versioned, and self-describing.
 *
 * The token is *not* authenticated: it is a pagination position, not a
 * capability. Editing it only moves the read position.
 */

/** The contract's id cursor, as the generated bindings model it. */
export type IdCursor =
  | { tag: "Start"; values: void }
  | { tag: "After"; values: readonly [number, string, number] }
  | { tag: "End"; values: void };

/** The decoded payload of a cursor token. */
interface IdCursorPayload {
  /** Token format version. Bump when the payload shape changes. */
  v: 1;
  /** `"s"` = start, `"e"` = end, `"a"` = after a specific entry. */
  t: "s" | "e" | "a";
  /** Position of the last entry of the previous page. */
  p?: number;
  /** Id of the last entry of the previous page. */
  i?: string;
  /** Creation ledger of the last entry of the previous page. */
  c?: number;
}

/** Bump when the token format changes, so old tokens are rejected cleanly. */
const CURSOR_VERSION = 1;

function encode(payload: IdCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode(token: string): unknown {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
}

/**
 * Encode a contract cursor as an opaque token.
 *
 * `Start` and `End` are encoded as a one-word payload; `After` carries the
 * triple the contract needs to resume after a specific entry.
 */
export function encodeIdCursor(cursor: IdCursor): string {
  if (cursor.tag === "Start") return encode({ v: CURSOR_VERSION, t: "s" });
  if (cursor.tag === "End") return encode({ v: CURSOR_VERSION, t: "e" });
  const [position, id, createdAt] = cursor.values;
  return encode({ v: CURSOR_VERSION, t: "a", p: position, i: id, c: createdAt });
}

/**
 * Decode a token back into a contract cursor.
 *
 * Returns an error instead of throwing so the handler can turn it into an
 * actionable message: a stale or hand-edited token must not be passed to the
 * contract, which would silently read the wrong position.
 */
export function decodeIdCursor(
  token: string,
): { ok: true; cursor: IdCursor } | { ok: false; error: string } {
  let payload: Partial<IdCursorPayload>;
  try {
    payload = decode(token) as Partial<IdCursorPayload>;
  } catch {
    return {
      ok: false,
      error:
        "Invalid registry cursor. Cursors are opaque tokens returned by a previous call; start a new page instead of editing one.",
    };
  }

  if (payload.v !== CURSOR_VERSION) {
    return {
      ok: false,
      error:
        "Stale registry cursor. The cursor format changed since it was issued; start a new page.",
    };
  }

  if (payload.t === "s") return { ok: true, cursor: { tag: "Start", values: undefined } };
  if (payload.t === "e") return { ok: true, cursor: { tag: "End", values: undefined } };

  if (payload.t === "a") {
    const position = payload.p;
    const id = payload.i;
    const createdAt = payload.c;
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 0 ||
      typeof createdAt !== "number" ||
      !Number.isInteger(createdAt) ||
      createdAt < 0 ||
      typeof id !== "string" ||
      id.length === 0
    ) {
      return {
        ok: false,
        error:
          "Invalid registry cursor. Cursors are opaque tokens returned by a previous call; start a new page instead of editing one.",
      };
    }
    return { ok: true, cursor: { tag: "After", values: [position, id, createdAt] } };
  }

  return {
    ok: false,
    error:
      "Invalid registry cursor. Cursors are opaque tokens returned by a previous call; start a new page instead of editing one.",
  };
}
