/**
 * Shared catalog filter parsing for mindvault_browse and mindvault_search.
 * Keeps MCP query params aligned with GET /resources (server catalogQuerySchema)
 * and adds tags + listed for client-side parity with on-chain / meta fields.
 */

export const CATALOG_SORT_VALUES = ["newest", "price_asc", "price_desc", "title"] as const;
export type CatalogSort = (typeof CATALOG_SORT_VALUES)[number];

export const CATALOG_DEFAULT_LIMIT = 20;
export const CATALOG_MAX_LIMIT = 100;

const PRICE_RE = /^\d+(\.\d+)?$/;

export interface CatalogFilters {
  query?: string;
  minPrice?: string;
  maxPrice?: string;
  verificationStatus?: "pending" | "verified" | "rejected" | "skipped";
  resourceType?: "file" | "link";
  owner?: string;
  sort?: CatalogSort;
  limit?: number;
  offset?: number;
  /** Discovery tags; matched client-side (all tags must be present). */
  tags?: string[];
  /** Listing state; matched client-side when present on results. */
  listed?: boolean;
}

export type ParseCatalogFiltersResult =
  | { ok: true; filters: CatalogFilters }
  | { ok: false; error: string };

function parseListed(value: unknown): boolean | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  return "invalid";
}

function parseTags(value: unknown): string[] | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    if (!value.every((t) => typeof t === "string")) return "invalid";
    const tags = value.map((t) => t.trim()).filter(Boolean);
    return tags.length > 0 ? tags : undefined;
  }
  if (typeof value === "string") {
    const tags = value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return tags.length > 0 ? tags : undefined;
  }
  return "invalid";
}

function parseLimit(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > CATALOG_MAX_LIMIT) return "invalid";
  return n;
}

function parseOffset(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0) return "invalid";
  return n;
}

/**
 * Parse and validate catalog filters from MCP tool arguments.
 * @param requireCriteria When true (search), require a query or at least one filter.
 */
export function parseCatalogFilters(
  args: unknown,
  options: { requireCriteria?: boolean } = {},
): ParseCatalogFiltersResult {
  const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  // Accept legacy `search` alias for the same keyword field.
  const searchAlias = typeof raw.search === "string" ? raw.search.trim() : "";
  const keyword = query || searchAlias;

  const minPrice = typeof raw.minPrice === "string" ? raw.minPrice.trim() : "";
  const maxPrice = typeof raw.maxPrice === "string" ? raw.maxPrice.trim() : "";

  if (minPrice && !PRICE_RE.test(minPrice)) {
    return {
      ok: false,
      error: "Invalid minPrice: must be a non-negative number string (e.g. '0.50').",
    };
  }
  if (maxPrice && !PRICE_RE.test(maxPrice)) {
    return {
      ok: false,
      error: "Invalid maxPrice: must be a non-negative number string (e.g. '5.00').",
    };
  }
  if (minPrice && maxPrice && parseFloat(minPrice) > parseFloat(maxPrice)) {
    return { ok: false, error: "Invalid price range: minPrice cannot be greater than maxPrice." };
  }

  let verificationStatus: CatalogFilters["verificationStatus"];
  if (
    raw.verificationStatus !== undefined &&
    raw.verificationStatus !== null &&
    raw.verificationStatus !== ""
  ) {
    if (
      raw.verificationStatus === "pending" ||
      raw.verificationStatus === "verified" ||
      raw.verificationStatus === "rejected" ||
      raw.verificationStatus === "skipped"
    ) {
      verificationStatus = raw.verificationStatus;
    } else {
      return {
        ok: false,
        error: "Invalid verificationStatus: must be one of pending, verified, rejected, skipped.",
      };
    }
  }

  let resourceType: CatalogFilters["resourceType"];
  if (raw.resourceType !== undefined && raw.resourceType !== null && raw.resourceType !== "") {
    if (raw.resourceType === "file" || raw.resourceType === "link") {
      resourceType = raw.resourceType;
    } else {
      return { ok: false, error: "Invalid resourceType: must be 'file' or 'link'." };
    }
  }

  const owner = typeof raw.owner === "string" ? raw.owner.trim() : "";

  let sort: CatalogSort | undefined;
  if (raw.sort !== undefined && raw.sort !== null && raw.sort !== "") {
    if ((CATALOG_SORT_VALUES as readonly string[]).includes(String(raw.sort))) {
      sort = raw.sort as CatalogSort;
    } else {
      return {
        ok: false,
        error: `Invalid sort: must be one of ${CATALOG_SORT_VALUES.join(", ")}.`,
      };
    }
  }

  const limit = parseLimit(raw.limit);
  if (limit === "invalid") {
    return {
      ok: false,
      error: `Invalid limit: must be an integer between 1 and ${CATALOG_MAX_LIMIT}.`,
    };
  }

  const offset = parseOffset(raw.offset);
  if (offset === "invalid") {
    return { ok: false, error: "Invalid offset: must be a non-negative integer." };
  }

  const tags = parseTags(raw.tags);
  if (tags === "invalid") {
    return {
      ok: false,
      error: "Invalid tags: provide a comma-separated string or an array of strings.",
    };
  }

  const listed = parseListed(raw.listed);
  if (listed === "invalid") {
    return {
      ok: false,
      error: "Invalid listed: must be a boolean (true/false) or 'true'/'false'.",
    };
  }

  const filters: CatalogFilters = {
    query: keyword || undefined,
    minPrice: minPrice || undefined,
    maxPrice: maxPrice || undefined,
    verificationStatus,
    resourceType,
    owner: owner || undefined,
    sort,
    limit,
    offset,
    tags,
    listed,
  };

  if (options.requireCriteria) {
    const hasCriteria = Boolean(
      filters.query ||
      filters.minPrice ||
      filters.maxPrice ||
      filters.verificationStatus ||
      filters.resourceType ||
      filters.owner ||
      filters.sort ||
      filters.limit !== undefined ||
      filters.offset !== undefined ||
      (filters.tags && filters.tags.length > 0) ||
      filters.listed !== undefined,
    );
    if (!hasCriteria) {
      return {
        ok: false,
        error: "Provide a search query or at least one catalog filter.",
      };
    }
  }

  return { ok: true, filters };
}

/** Build GET /resources query string from filters (server-supported params only). */
export function buildCatalogQueryString(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set("search", filters.query);
  if (filters.minPrice) params.set("minPrice", filters.minPrice);
  if (filters.maxPrice) params.set("maxPrice", filters.maxPrice);
  // Server schema accepts verified|pending|rejected only — apply skipped client-side.
  if (filters.verificationStatus && filters.verificationStatus !== "skipped") {
    params.set("verificationStatus", filters.verificationStatus);
  }
  if (filters.resourceType) params.set("resourceType", filters.resourceType);
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  return params.toString();
}

export function describeCatalogFilters(filters: CatalogFilters): string {
  const parts: string[] = [];
  if (filters.query) parts.push(`query "${filters.query}"`);
  if (filters.minPrice) parts.push(`min $${filters.minPrice}`);
  if (filters.maxPrice) parts.push(`max $${filters.maxPrice}`);
  if (filters.verificationStatus) parts.push(`status ${filters.verificationStatus}`);
  if (filters.resourceType) parts.push(`type ${filters.resourceType}`);
  if (filters.owner) parts.push(`owner "${filters.owner}"`);
  if (filters.sort) parts.push(`sort ${filters.sort}`);
  if (filters.limit !== undefined) parts.push(`limit ${filters.limit}`);
  if (filters.offset !== undefined) parts.push(`offset ${filters.offset}`);
  if (filters.tags?.length) parts.push(`tags [${filters.tags.join(", ")}]`);
  if (filters.listed !== undefined) parts.push(`listed ${filters.listed}`);
  if (parts.length === 0) return "the catalog";
  if (parts.length === 1 && filters.query && !filters.minPrice && !filters.maxPrice) {
    return `"${filters.query}"`;
  }
  return parts.join(", ");
}

function normalizeTagList(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
}

/**
 * Client-side filters for fields the public catalog API does not accept
 * (tags, listed, verificationStatus=skipped) plus keyword matching for tests.
 */
export function applyClientCatalogFilters<T extends Record<string, unknown>>(
  items: T[],
  filters: CatalogFilters,
): T[] {
  const q = filters.query?.toLowerCase();
  const wantedTags = filters.tags?.map((t) => t.toLowerCase()) ?? [];
  const skippedOnly = filters.verificationStatus === "skipped";

  return items.filter((r) => {
    if (q) {
      const hay = `${r.title ?? ""} ${r.description ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (skippedOnly && r.verificationStatus !== "skipped") return false;

    // The server's public catalog only returns listed=true resources. When a
    // resource is tombstoned or delisted its `listed` flag is set to false and
    // it is removed from the live catalog. Stale cache snapshots may still
    // carry such entries, so we always exclude them from tag-based results
    // unless the caller explicitly requested unlisted items (filters.listed ===
    // false). This mirrors the server-side WHERE listed = true guard and fixes
    // tombstoned resources leaking through tag queries.
    const isListed = typeof r.listed === "boolean" ? r.listed : true;
    if (filters.listed !== undefined) {
      if (isListed !== filters.listed) return false;
    } else if (wantedTags.length > 0 && !isListed) {
      // When filtering by tag without an explicit listed filter, tombstoned /
      // delisted entries must not surface — they are dead catalog entries.
      return false;
    }

    if (wantedTags.length > 0) {
      const have = normalizeTagList(r.tags);
      if (!wantedTags.every((t) => have.includes(t))) return false;
    }
    return true;
  });
}

/** Numeric price of a catalog row; NaN prices sort last. */
function priceOf(row: Record<string, unknown>): number {
  const value = parseFloat(String(row.price ?? ""));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/** Creation timestamp as epoch ms; rows without one keep their incoming order. */
function createdAtOf(row: Record<string, unknown>): number | null {
  const raw = row.createdAt ?? row.created_at;
  if (raw === undefined || raw === null) return null;
  const ms = new Date(String(raw)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Order catalog rows client-side.
 *
 * `sort` is forwarded to GET /resources, which orders the page before applying
 * limit/offset — so against the live backend this is a no-op that re-confirms
 * the order. It matters for backends that ignore the parameter (the mock
 * fixtures, older deployments): the agent still gets the order it asked for
 * instead of silently unsorted results.
 *
 * The sort is stable, so rows the comparator considers equal keep the order the
 * server returned them in.
 */
export function applyCatalogSort<T extends Record<string, unknown>>(
  items: T[],
  sort: CatalogSort | undefined,
): T[] {
  if (!sort) return items;
  const sorted = [...items];
  switch (sort) {
    case "price_asc":
      sorted.sort((a, b) => priceOf(a) - priceOf(b));
      break;
    case "price_desc":
      sorted.sort((a, b) => priceOf(b) - priceOf(a));
      break;
    case "title":
      sorted.sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
      break;
    case "newest":
      // Only reorder when every row carries a usable timestamp; a partial sort
      // would shuffle rows for no reason.
      if (sorted.every((r) => createdAtOf(r) !== null)) {
        sorted.sort((a, b) => (createdAtOf(b) as number) - (createdAtOf(a) as number));
      }
      break;
  }
  return sorted;
}

/** Shared JSON Schema properties for browse/search tool inputSchema. */
export const catalogFilterInputProperties = {
  query: {
    type: "string",
    description:
      "Keyword(s) to match against resource title or description. Examples: 'Stellar tutorial', 'Soroban smart contracts', 'DeFi guide'",
    examples: ["Stellar tutorial", "Soroban smart contracts", "DeFi guide"],
  },
  minPrice: {
    type: "string",
    description:
      "Minimum USDC price to include (decimal string). Example: '5.00' includes resources priced 5 USDC and above.",
    examples: ["5.00", "10.50", "0.50"],
  },
  maxPrice: {
    type: "string",
    description:
      "Maximum USDC price to include (decimal string). Example: '20.00' excludes resources priced above 20 USDC.",
    examples: ["20.00", "15.99", "100.00"],
  },
  verificationStatus: {
    type: "string",
    enum: ["pending", "verified", "rejected", "skipped"],
    description:
      "Filter by verification status. 'verified' = passed AI originality check, 'pending' = awaiting verification, 'rejected' = failed check, 'skipped' = verification skipped.",
    examples: ["verified"],
  },
  resourceType: {
    type: "string",
    enum: ["file", "link"],
    description:
      "Filter by resource type. 'file' = downloadable file (PDF, ebook, etc.), 'link' = external URL to web content.",
    examples: ["link", "file"],
  },
  owner: {
    type: "string",
    description:
      "Filter by publisher name or wallet address (case-insensitive substring). Example: 'Alice' or a G... Stellar address.",
    examples: ["Alice", "GB6LGS25..."],
  },
  sort: {
    type: "string",
    enum: [...CATALOG_SORT_VALUES],
    description: "Sort order for results. Defaults to newest when omitted.",
    examples: ["newest", "price_asc", "price_desc", "title"],
  },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: CATALOG_MAX_LIMIT,
    description: `Max number of resources to return (1–${CATALOG_MAX_LIMIT}, server default ${CATALOG_DEFAULT_LIMIT}).`,
    examples: [20, 50],
  },
  offset: {
    type: "integer",
    minimum: 0,
    description: "Number of resources to skip for pagination.",
    examples: [0, 20],
  },
  tags: {
    type: "string",
    description:
      "Comma-separated discovery tags; resources must include all listed tags (matched client-side against tag fields on results). Example: 'dataset,research'.",
    examples: ["dataset", "dataset,research"],
  },
  listed: {
    type: "boolean",
    description:
      "Filter by listing state. The public catalog is listed=true only; listed=false yields no public catalog matches (use mindvault_registry_lookup for a specific resource).",
    examples: [true, false],
  },
} as const;
