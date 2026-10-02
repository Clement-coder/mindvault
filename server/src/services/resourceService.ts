import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources, publishers, verifications } from "../db/schema.js";
import { uploadFile, deleteFile } from "../storage/supabaseStorage.js";
import { hashFileResource, hashLinkResource } from "../utils/crypto.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { config } from "../config.js";

// Short-lived cache for catalog/preview reads (issue #115). These endpoints are
// hit far more often than resources change, so a small TTL cuts repeated DB
// work while keeping newly published/delisted items fresh within seconds.
const CATALOG_KEY = "catalog";
const metaKey = (id: string) => `meta:${id}`;
const readCache = createTtlCache<unknown>({
  defaultTtlMs: config.CATALOG_CACHE_TTL_MS,
  cacheName: "catalog_read",
});

// Per-filter-combination catalog response cache (#316). Keyed by a normalized
// filter/sort/pagination key so identical queries skip the filter/sort/paginate
// recompute entirely. Bounded (FIFO) so high-cardinality inputs (price/search)
// can't grow keys unbounded.
const pageCache = createTtlCache<unknown>({
  defaultTtlMs: config.CATALOG_CACHE_TTL_MS,
  maxSize: config.CATALOG_CACHE_MAX_KEYS,
  cacheName: "catalog_page",
});

// Drop cached reads affected by a write. The catalog (the listed set) and every
// per-filter response are invalidated, since any write can change any filtered
// view; the specific resource's preview is dropped too when known.
function invalidateReads(resourceId?: string): void {
  readCache.delete(CATALOG_KEY);
  pageCache.clear();
  if (resourceId) readCache.delete(metaKey(resourceId));
}

/** Test helper — clear the read caches between cases. */
export function __resetCatalogCache(): void {
  readCache.clear();
  pageCache.clear();
}

export async function createFileResource(data: {
  publisherId: string;
  title: string;
  description?: string;
  price: string;
  walletAddress: string;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
}) {
  const contentHash = hashFileResource(data.fileBuffer, data.title);

  const [resource] = await db
    .insert(resources)
    .values({
      publisherId: data.publisherId,
      title: data.title,
      description: data.description,
      price: data.price,
      walletAddress: data.walletAddress,
      resourceType: "file",
      mimeType: data.mimeType,
      contentHash,
    })
    .returning();

  const storagePath = await uploadFile(resource.id, data.fileBuffer, data.filename, data.mimeType);

  let thumbnailPath: string | undefined;
  if (data.mimeType.startsWith("image/")) {
    try {
      const sharp = (await import("sharp")).default;
      const thumbBuffer = await sharp(data.fileBuffer)
        .resize(400, 400, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      thumbnailPath = await uploadFile(
        resource.id,
        thumbBuffer,
        `thumb_${data.filename.replace(/\.[^.]+$/, "")}.jpg`,
        "image/jpeg",
      );
    } catch {
      // Thumbnail generation is non-blocking; the original upload already succeeded.
    }
  }

  const [updated] = await db
    .update(resources)
    .set({ storagePath, ...(thumbnailPath !== undefined && { thumbnailPath }) })
    .where(eq(resources.id, resource.id))
    .returning();

  invalidateReads(updated.id);
  return updated;
}

export async function createLinkResource(data: {
  publisherId: string;
  title: string;
  description?: string;
  price: string;
  walletAddress: string;
  externalUrl: string;
}) {
  const [resource] = await db
    .insert(resources)
    .values({
      publisherId: data.publisherId,
      title: data.title,
      description: data.description,
      price: data.price,
      walletAddress: data.walletAddress,
      resourceType: "link",
      externalUrl: data.externalUrl,
      contentHash: hashLinkResource(data.externalUrl, data.title),
    })
    .returning();

  invalidateReads(resource.id);
  return resource;
}

export async function getResourceById(id: string) {
  return db
    .select()
    .from(resources)
    .where(eq(resources.id, id))
    .then((rows) => rows[0] ?? null);
}

export async function saveResourceTags(id: string, tags: string[]): Promise<boolean> {
  const [resource] = await db
    .update(resources)
    .set({ tags })
    .where(eq(resources.id, id))
    .returning({ id: resources.id });

  if (!resource) return false;
  invalidateReads(id);
  return true;
}

export type CatalogSort = "newest" | "price_asc" | "price_desc" | "title";

export type CatalogListFilters = {
  verificationStatus?: "verified" | "pending" | "rejected";
  minPrice?: string;
  maxPrice?: string;
  search?: string;
  resourceType?: "file" | "link";
  owner?: string;
  sort?: CatalogSort;
  limit?: number;
  offset?: number;
};

export type CatalogPage<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
};

const CATALOG_DEFAULT_LIMIT = 20;

function sortRows<T extends { price: string; title: string; createdAt: Date | string }>(
  rows: T[],
  sort: CatalogSort,
): T[] {
  // "newest" is the default — handled by ORDER BY created_at DESC in queryCatalog (#287).
  if (sort === "newest" || !sort) return rows;

  const sorted = [...rows];
  switch (sort) {
    case "price_asc":
      sorted.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
      break;
    case "price_desc":
      sorted.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
      break;
    case "title":
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
  }
  return sorted;
}

async function queryCatalog() {
  return db
    .select({
      id: resources.id,
      title: resources.title,
      description: resources.description,
      price: resources.price,
      resourceType: resources.resourceType,
      mimeType: resources.mimeType,
      thumbnailPath: resources.thumbnailPath,
      verificationStatus: resources.verificationStatus,
      publisherName: publishers.name,
      walletAddress: resources.walletAddress,
      tags: resources.tags,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .innerJoin(publishers, eq(resources.publisherId, publishers.id))
    .where(eq(resources.listed, true))
    .orderBy(desc(resources.createdAt));
}

async function getCachedCatalogRows(): Promise<Awaited<ReturnType<typeof queryCatalog>>> {
  const cached = readCache.get(CATALOG_KEY);
  if (cached !== undefined) {
    return cached as Awaited<ReturnType<typeof queryCatalog>>;
  }
  const rows = await queryCatalog();
  readCache.set(CATALOG_KEY, rows);
  return rows;
}

export function applyCatalogFilters<
  T extends {
    title: string;
    description: string | null;
    price: string;
    verificationStatus: string;
    resourceType: string;
    publisherName: string;
    walletAddress: string;
  },
>(rows: T[], filters?: CatalogListFilters): T[] {
  if (!filters) return rows;

  const search = filters.search?.toLowerCase();
  const owner = filters.owner?.toLowerCase();
  // Prices are stored as decimal strings (e.g. "0.50"); compare numerically and
  // inclusively, parsing only at the point of comparison.
  const min = filters.minPrice !== undefined ? parseFloat(filters.minPrice) : undefined;
  const max = filters.maxPrice !== undefined ? parseFloat(filters.maxPrice) : undefined;

  return rows.filter((r) => {
    if (
      search &&
      !(r.title?.toLowerCase().includes(search) || r.description?.toLowerCase().includes(search))
    ) {
      return false;
    }
    if (min !== undefined && parseFloat(r.price) < min) return false;
    if (max !== undefined && parseFloat(r.price) > max) return false;
    if (filters.verificationStatus && r.verificationStatus !== filters.verificationStatus) {
      return false;
    }
    if (filters.resourceType && r.resourceType !== filters.resourceType) return false;
    if (
      owner &&
      !(
        r.publisherName?.toLowerCase().includes(owner) ||
        r.walletAddress?.toLowerCase().includes(owner)
      )
    ) {
      return false;
    }
    return true;
  });
}

// Normalized, order-stable cache key for a filter/sort/pagination combination
// (#316). Undefined fields are omitted and `search` is trimmed/lowercased so
// equivalent queries share an entry; keys are emitted in sorted order for
// determinism. `kind` separates the list vs. count views of the same filters.
function catalogCacheKey(kind: "list" | "count", filters?: CatalogListFilters): string {
  if (!filters) return `${kind}:all`;
  const norm: Record<string, string | number> = {};
  if (filters.verificationStatus) norm.vs = filters.verificationStatus;
  if (filters.minPrice !== undefined) norm.min = filters.minPrice;
  if (filters.maxPrice !== undefined) norm.max = filters.maxPrice;
  if (filters.search) {
    const q = filters.search.trim().toLowerCase();
    if (q) norm.q = q;
  }
  if (filters.resourceType) norm.rt = filters.resourceType;
  if (filters.owner) {
    const o = filters.owner.trim().toLowerCase();
    if (o) norm.owner = o;
  }
  if (filters.sort) norm.sort = filters.sort;
  // Count ignores pagination (#162), so omit limit/offset from the count key so
  // all pages of the same filter share one cached total.
  if (kind === "list") {
    if (filters.limit !== undefined) norm.limit = filters.limit;
    if (filters.offset !== undefined) norm.offset = filters.offset;
  }
  return `${kind}:` + JSON.stringify(norm, Object.keys(norm).sort());
}

// The full listed set is cached once under CATALOG_KEY; on top of that, each
// distinct filter/sort/pagination combination caches its computed response under
// a normalized key (#316) so popular identical queries skip the in-memory
// filter/sort/paginate work entirely. The per-filter cache is bounded (FIFO via
// CATALOG_CACHE_MAX_KEYS) so high-cardinality inputs (price, search) can't grow
// keys without limit, and it is cleared on any resource mutation.
//
// `sort` (#163) and `limit`/`offset` (#162) are applied after filtering, in that
// order, so pagination always walks a stable, sorted sequence. Omitting limit/offset
// preserves the historical "return everything" behavior for existing callers.
export async function listCatalog(
  filters?: CatalogListFilters,
): Promise<Awaited<ReturnType<typeof queryCatalog>>> {
  const cacheKey = catalogCacheKey("list", filters);
  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) {
    return cached as Awaited<ReturnType<typeof queryCatalog>>;
  }

  const rows = await getCachedCatalogRows();
  const filtered = applyCatalogFilters(rows, filters);

  const result = ((): Awaited<ReturnType<typeof queryCatalog>> => {
    if (!filters) return filtered;
    const sorted = filters.sort ? sortRows(filtered, filters.sort) : filtered;
    if (filters.limit === undefined && filters.offset === undefined) return sorted;
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? CATALOG_DEFAULT_LIMIT;
    return sorted.slice(offset, offset + limit);
  })();

  pageCache.set(cacheKey, result);
  return result;
}

/** Total count of listed resources matching `filters`, ignoring limit/offset (#162). */
export async function countCatalog(filters?: CatalogListFilters): Promise<number> {
  const cacheKey = catalogCacheKey("count", filters);
  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return cached as number;

  const rows = await getCachedCatalogRows();
  const total = applyCatalogFilters(rows, filters).length;
  pageCache.set(cacheKey, total);
  return total;
}

async function queryResourceMeta(id: string) {
  return db
    .select({
      id: resources.id,
      title: resources.title,
      description: resources.description,
      price: resources.price,
      resourceType: resources.resourceType,
      mimeType: resources.mimeType,
      verificationStatus: resources.verificationStatus,
      publisherName: publishers.name,
      publisherWallet: resources.walletAddress,
      tags: resources.tags,
      thumbnailPath: resources.thumbnailPath,
      onchainStatus: resources.onchainStatus,
      onchainTxHash: resources.onchainTxHash,
      contentHash: resources.contentHash,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .innerJoin(publishers, eq(resources.publisherId, publishers.id))
    .where(eq(resources.id, id))
    .then((rows) => rows[0] ?? null);
}

export async function getResourceMeta(
  id: string,
): Promise<Awaited<ReturnType<typeof queryResourceMeta>>> {
  const cached = readCache.get(metaKey(id));
  if (cached !== undefined) return cached as Awaited<ReturnType<typeof queryResourceMeta>>;

  const result = await queryResourceMeta(id);
  // Only cache hits; a 404 (null) stays uncached so a freshly created resource
  // becomes visible immediately.
  if (result) readCache.set(metaKey(id), result);
  return result;
}

/**
 * Delist a resource: flip `listed` to false in Postgres, drop stored files, and
 * (issue #218) sync the change on-chain so the vault registry's `listed` flag
 * matches the API.
 *
 * The on-chain delist is best-effort and never blocks the DB delist:
 *  - Resources that were never registered on-chain (`onchainStatus !==
 *    "registered"`) skip the chain call entirely and delist cleanly.
 *  - If the on-chain call fails, the DB delist still stands and the failure is
 *    logged for reconciliation rather than surfaced to the caller.
 *
 * `onChainDelist` is injectable so tests can assert both paths without touching
 * Soroban; it defaults to the real registry-signed delist.
 */
export async function delistResource(
  id: string,
  publisherId: string,
  // Injectable for tests. Left out, it lazily loads the real registry-signed
  // delist; the lazy import keeps `resourceService` free of a load-time Stellar
  // client so unrelated tests don't need to mock the registry.
  onChainDelist?: (resourceId: string) => Promise<{ success: boolean; error?: string }>,
) {
  const [resource] = await db
    .update(resources)
    .set({ listed: false })
    .where(and(eq(resources.id, id), eq(resources.publisherId, publisherId)))
    .returning();

  if (!resource) return null;

  invalidateReads(resource.id);

  if (resource.storagePath) {
    await deleteFile(resource.storagePath);
  }

  if (resource.thumbnailPath) {
    await deleteFile(resource.thumbnailPath);
  }

  // Only registered resources exist on-chain; anything else delists DB-only.
  if (resource.onchainStatus === "registered") {
    const { getLogger } = await import("../lib/logger.js");
    try {
      const delist = onChainDelist ?? (await import("./registryClient.js")).delistOnChain;
      const result = await delist(resource.id);
      if (!result.success) {
        getLogger().warn(
          { event: "delist_onchain_sync", resourceId: resource.id, error: result.error },
          "DB delist succeeded but on-chain delist failed; chain state may be stale",
        );
      }
    } catch (err) {
      getLogger().error(
        { event: "delist_onchain_sync", resourceId: resource.id, err },
        "unexpected error during on-chain delist sync",
      );
    }
  }

  return resource;
}

export async function getVerificationDetails(resourceId: string) {
  const resource = await db
    .select({
      id: resources.id,
      title: resources.title,
      verificationStatus: resources.verificationStatus,
      verificationId: resources.verificationId,
      listed: resources.listed,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .then((rows) => rows[0] ?? null);

  if (!resource) return null;

  let verification = null;
  if (resource.verificationId) {
    verification = await db
      .select()
      .from(verifications)
      .where(eq(verifications.id, resource.verificationId))
      .then((rows) => rows[0] ?? null);
  }

  return {
    resourceId: resource.id,
    title: resource.title,
    status: resource.verificationStatus,
    listed: resource.listed,
    publishedAt: resource.createdAt,
    verification: verification
      ? {
          isOriginal: verification.isOriginal,
          confidence: verification.confidence,
          flags: verification.flags ? JSON.parse(verification.flags) : [],
          checkedAt: verification.checkedAt,
        }
      : null,
  };
}
