/**
 * MCP `resources` support for the MindVault catalog (#545).
 *
 * The server advertises the `resources` capability alongside `tools` so agents
 * can discover catalog entries with `resources/list` and read their **public**
 * metadata with `resources/read` — without invoking a tool or paying anything.
 *
 * URI contract:
 *
 *   mindvault://resource/<id>
 *
 * `resources/list` maps every catalog entry returned by `GET /resources` to a
 * stable URI. `resources/read` resolves the URI to the entry's public metadata
 * via `GET /resources/<id>/meta` — the same endpoint `mindvault_preview` uses,
 * so gated content (the paid access payload) is never exposed. Unknown URIs,
 * missing entries, and unreachable backends fail with deterministic, agent-safe
 * errors.
 */

import {
  ErrorCode,
  McpError,
  type Resource,
  type TextResourceContents,
} from "@modelcontextprotocol/sdk/types.js";
import { BASE_URL, jsonFetch } from "./runtime.js";
import { mapHttpError, mcpError } from "./errorMapping.js";

/** URI scheme prefix shared by every catalog resource. */
export const CATALOG_RESOURCE_SCHEME = "mindvault";
export const CATALOG_RESOURCE_HOST = "resource";
export const CATALOG_RESOURCE_MIME = "application/json";

/** Stable, deterministic URI for a catalog entry. */
export function catalogResourceUri(resourceId: string): string {
  return `${CATALOG_RESOURCE_SCHEME}://${CATALOG_RESOURCE_HOST}/${resourceId}`;
}

export type ParsedCatalogResourceUri =
  | { ok: true; resourceId: string }
  | { ok: false; reason: string };

/**
 * Parse a `mindvault://resource/<id>` URI. Anything else — a different scheme,
 * host, or a missing id — fails deterministically so `resources/read` can reply
 * with a stable invalid-params error instead of guessing.
 */
export function parseCatalogResourceUri(uri: unknown): ParsedCatalogResourceUri {
  if (typeof uri !== "string" || uri.trim().length === 0) {
    return { ok: false, reason: "Resource URI must be a non-empty string." };
  }
  const prefix = `${CATALOG_RESOURCE_SCHEME}://${CATALOG_RESOURCE_HOST}/`;
  if (!uri.startsWith(prefix)) {
    return {
      ok: false,
      reason: `Unknown resource URI. Expected ${prefix}<id>, e.g. ${catalogResourceUri("cm7x8y9z")}.`,
    };
  }
  const resourceId = uri.slice(prefix.length);
  if (resourceId.length === 0) {
    return {
      ok: false,
      reason: `Resource URI is missing the resource id. Expected ${prefix}<id>.`,
    };
  }
  return { ok: true, resourceId };
}

/**
 * Map a catalog entry (one item from `GET /resources`) to an MCP Resource.
 * Only public, non-gated fields are surfaced; the id is what makes the URI
 * stable across reads.
 */
export function toCatalogResource(entry: unknown): Resource {
  const record = (entry ?? {}) as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : String(record.id ?? "");
  const title = typeof record.title === "string" ? record.title : id;
  const description = typeof record.description === "string" ? record.description : undefined;
  return {
    uri: catalogResourceUri(id),
    name: title || id,
    ...(description ? { description } : {}),
    mimeType: CATALOG_RESOURCE_MIME,
  };
}

/**
 * The public metadata payload served by `resources/read`. Deliberately mirrors
 * `mindvault_preview`: id, title, description, price, type, verification
 * status, and access URL — never the paid content payload.
 */
export function catalogResourceContents(meta: unknown, uri: string): TextResourceContents {
  const r = (meta ?? {}) as Record<string, unknown>;
  return {
    uri,
    mimeType: CATALOG_RESOURCE_MIME,
    text: JSON.stringify(
      {
        id: r.id ?? null,
        title: r.title ?? null,
        description: r.description ?? null,
        price: typeof r.price === "string" ? `$${r.price} USDC` : null,
        resourceType: r.resourceType ?? null,
        verificationStatus: r.verificationStatus ?? null,
        accessUrl: r.accessUrl ?? null,
      },
      null,
      2,
    ),
  };
}

/**
 * Fetch the catalog and map every entry to an MCP Resource. A reachable-but-
 * error response and a transport failure both fail deterministically (the
 * latter via `jsonFetch`'s mapped transport error), so `resources/list` never
 * serves partial or guessed data.
 */
export async function listCatalogResources(): Promise<Resource[]> {
  const res = await jsonFetch(`${BASE_URL}/resources`);
  if (!res.ok) {
    throw mcpError(
      mapHttpError({
        operation: "List catalog resources failed",
        source: "api",
        status: res.status,
        data: res.data,
      }),
    );
  }
  const items = Array.isArray(res.data) ? res.data : [];
  return items.map(toCatalogResource);
}

/**
 * Resolve a `mindvault://resource/<id>` URI to the entry's public metadata.
 *
 * Error contract (deterministic, agent-safe):
 * - malformed/unknown URI        → McpError InvalidParams
 * - id not in the catalog        → McpError InvalidParams ("not found")
 * - other non-OK / transport     → the mapped HTTP/transport error
 */
export async function readCatalogResource(uri: unknown): Promise<TextResourceContents> {
  const parsed = parseCatalogResourceUri(uri);
  if (!parsed.ok) {
    throw new McpError(ErrorCode.InvalidParams, parsed.reason);
  }
  const res = await jsonFetch(`${BASE_URL}/resources/${parsed.resourceId}/meta`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Resource "${parsed.resourceId}" not found. Confirm the id from mindvault_browse or mindvault_search.`,
      );
    }
    throw mcpError(
      mapHttpError({
        operation: "Read catalog resource failed",
        source: "api",
        status: res.status,
        data: res.data,
      }),
    );
  }
  return catalogResourceContents(res.data, catalogResourceUri(parsed.resourceId));
}
