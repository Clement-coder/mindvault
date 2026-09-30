/**
 * Contributor-friendly mock mode for the MindVault MCP server.
 *
 * Enabled with MINDVAULT_MOCK=1, this replaces every outbound HTTP call and the
 * on-chain registry lookup with deterministic, in-memory responses, so a
 * contributor can run and exercise the server — browse, preview, wallet setup,
 * publish/buy, registry lookups — with no live backend, no funded wallet, and no
 * network access.
 *
 * The module is self-contained: `createMockFetch()` returns a drop-in for the
 * global `fetch` (routed by URL path, mirroring scripts/mock-server.ts), and
 * `mockRegistryLookup()` stands in for the Soroban registry client. Nothing here
 * touches the filesystem or the network, so it stays deterministic and testable.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { explorerTxUrl } from "./stellarExplorer.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Mock mode is opt-in: enabled only when MINDVAULT_MOCK is a truthy string. */
export function mockEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MINDVAULT_MOCK;
  return typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase());
}

export interface MockResource {
  id: string;
  title: string;
  description: string;
  price: string;
  resourceType: "link";
  verificationStatus: "verified";
  accessUrl: string;
}

export interface MockRegistryResource {
  id: string;
  creator: string;
  price: string;
  metadata: string;
  listed: boolean;
  tags: string[];
}

/**
 * Catalog resources seeded into the in-memory mock. Exported so the fixture
 * generation script (`scripts/generate-fixtures.ts`) can serialise them to
 * `fixtures/` without duplicating the source data.
 */
export const MOCK_CATALOG_RESOURCES: MockResource[] = [
  {
    id: "mock-1",
    title: "Intro to Stellar Smart Contracts",
    description: "A beginner guide to Soroban.",
    price: "1.5",
    resourceType: "link",
    verificationStatus: "verified",
    accessUrl: "https://example.com/mock-1",
  },
  {
    id: "mock-2",
    title: "x402 Payments Cheat Sheet",
    description: "Pay-per-use HTTP flows with USDC.",
    price: "0.5",
    resourceType: "link",
    verificationStatus: "verified",
    accessUrl: "https://example.com/mock-2",
  },
];

/** Two seeded resources so browse/preview/registry return content out of the box. */
function seedResources(): Map<string, MockResource> {
  const resources = new Map<string, MockResource>();
  for (const r of MOCK_CATALOG_RESOURCES) resources.set(r.id, r);
  return resources;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function parseJson(body: string): any {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/**
 * Normalize the two shapes a caller may use into url/method/body.
 *
 * The x402 payment wrapper re-issues the paid retry as a `Request` object
 * rather than (url, init), so reading the method and body off `init` alone
 * would see every paid call as a bodyless GET.
 */
async function normalizeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ url: string; method: string; body: string }> {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  const method = (
    init?.method ??
    (isRequest ? (input as Request).method : undefined) ??
    "GET"
  ).toUpperCase();

  let body = "";
  if (typeof init?.body === "string") body = init.body;
  else if (isRequest) body = await (input as Request).clone().text();

  return { url, method, body };
}

/**
 * Build a deterministic `fetch` replacement. State (created resources) lives in
 * the closure so a single mock instance behaves like one running server across
 * calls. Paid endpoints return 200 directly, so the x402 wrapper passes through
 * without a payment challenge — exactly as scripts/mock-server.ts does.
 */
export function createMockFetch(
  getActivePublicKey?: () => string | undefined | null,
): typeof fetch {
  const resources = seedResources();
  let counter = 0;

  const ensureProfileFixture = () => {
    const pk = getActivePublicKey?.();
    if (pk && !resources.has("mock-profile")) {
      resources.set("mock-profile", {
        id: "mock-profile",
        title: "Your Profile Fixture",
        description: "A mock resource owned by the active profile.",
        price: "2.5",
        resourceType: "link",
        verificationStatus: "verified",
        accessUrl: "https://example.com/mock-profile",
      });
    }
    return pk;
  };

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { url, method, body: rawBody } = await normalizeRequest(input, init);
    const { pathname } = new URL(url);

    ensureProfileFixture();

    // Sponsored-account service: mint a real (random) keypair so the server can
    // build an x402 signer without hitting the chain.
    if (method === "POST" && pathname === "/create") {
      const kp = Keypair.random();
      return json({ publicKey: kp.publicKey(), secretKey: kp.secret() });
    }

    // Horizon: report a healthy USDC + native balance so funds checks pass.
    if (method === "GET" && pathname.startsWith("/accounts/")) {
      return json({
        balances: [
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "1000.0000000" },
          { asset_type: "native", balance: "100.0000000" },
        ],
      });
    }

    // Soroban RPC (POST JSON-RPC): answer getTransaction with SUCCESS.
    if (method === "POST" && isSorobanRpc(rawBody)) {
      return json({ jsonrpc: "2.0", id: 1, result: { status: "SUCCESS", latestLedger: 1000 } });
    }

    // Publisher registration.
    if (method === "POST" && pathname === "/publishers") {
      return json({ id: "mock-pub-1", apiKey: "mock-api-key" });
    }

    // Verification agent status (drives the pre-publish funds check).
    if (method === "GET" && pathname === "/agent/status") {
      return json({
        agent: { pricePerVerification: "0.01", totalEarnings: "0", verifications: 0 },
      });
    }

    // Paid content verification. 200 ⇒ x402 wrapper passes through.
    if (method === "POST" && pathname === "/verify-content") {
      return json({ isOriginal: true, flags: [] });
    }

    // Resource collection: browse (GET) / create (POST).
    if (pathname === "/resources") {
      if (method === "GET") {
        // Advertise a fresh cache so the browse staleness check has metadata.
        return json([...resources.values()], 200, {
          "Cache-Control": "max-age=60",
          Age: "0",
          Date: new Date().toUTCString(),
        });
      }
      if (method === "POST") {
        const body = parseJson(rawBody);
        counter += 1;
        const id = `mock-new-${counter}`;
        const resource: MockResource = {
          id,
          title: typeof body.title === "string" ? body.title : "Untitled",
          description: typeof body.description === "string" ? body.description : "",
          price: typeof body.price === "string" ? body.price : "0",
          resourceType: "link",
          verificationStatus: "verified",
          accessUrl: `https://example.com/${id}`,
        };
        resources.set(id, resource);
        return json(resource, 201);
      }
    }

    // Per-resource routes: /resources/:id[/meta|/register].
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "resources" && parts.length >= 2) {
      const id = parts[1];
      const sub = parts[2];
      const resource = resources.get(id);

      if (sub === "register" && method === "POST") {
        return json({ onchainStatus: "registered", onchainTxHash: `MOCK_TX_${id}` });
      }
      if (sub === "meta" && method === "GET") {
        return resource
          ? json({
              ...resource,
              onchainStatus: "registered",
              onchainTxHash: `MOCK_TX_${id}`,
              contentHash: `mock-hash-${id}`,
              listed: resource.verificationStatus === "verified",
            })
          : json({ error: "not found" }, 404);
      }
      if (sub === "verification" && method === "GET") {
        return resource
          ? json({
              resourceId: resource.id,
              title: resource.title,
              status: resource.verificationStatus,
              listed: resource.verificationStatus === "verified",
              verification:
                resource.verificationStatus === "verified"
                  ? {
                      isOriginal: true,
                      confidence: 0.95,
                      flags: [],
                      checkedAt: new Date().toISOString(),
                    }
                  : null,
            })
          : json({ error: "not found" }, 404);
      }
      if (sub === undefined && method === "GET") {
        return resource
          ? json({ ...resource, content: `Mock content for ${id}` })
          : json({ error: "not found" }, 404);
      }
    }

    return json({ error: `no mock route for ${method} ${pathname}` }, 404);
  };

  return mockFetch as typeof fetch;
}

/** True when the request body is a Soroban JSON-RPC call (used to route txStatus). */
function isSorobanRpc(body: string): boolean {
  const parsed = parseJson(body);
  return parsed?.jsonrpc === "2.0" && typeof parsed?.method === "string";
}

export function mockRegistryLookup(
  resourceId: string,
  contractId: string,
  activePublicKey?: string | null,
): string {
  const seeded: Record<string, { creator: string; price: string; metadata: string }> = {
    "mock-1": { creator: "GMOCKCREATOR1", price: "1.5000000", metadata: "Intro to Stellar" },
    "mock-2": { creator: "GMOCKCREATOR2", price: "0.5000000", metadata: "x402 Cheat Sheet" },
  };
  if (activePublicKey) {
    seeded["mock-profile"] = {
      creator: activePublicKey,
      price: "2.5000000",
      metadata: "Your Profile Fixture",
    };
  }
  const hit = seeded[resourceId];
  if (!hit) {
    return JSON.stringify(
      {
        source: "on-chain (mock)",
        found: false,
        resourceId,
        message: `Resource "${resourceId}" is not registered on-chain (mock mode).`,
        contract: contractId,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      source: "on-chain (mock)",
      found: true,
      id: resourceId,
      creator: hit.creator,
      price: `${hit.price} USDC`,
      metadata: hit.metadata,
      listed: true,
      tags: [],
      contract: contractId,
    },
    null,
    2,
  );
}

export function mockVerifyAttestation(
  resourceId: string,
  expectedAttestationHash: string,
  contractId: string,
): string {
  const registeredAttestationHash = resourceId === "mock1" ? "mock-attestation-1" : null;
  const matches =
    registeredAttestationHash !== null && registeredAttestationHash === expectedAttestationHash;
  return JSON.stringify(
    {
      source: "on-chain (mock)",
      resourceId,
      expectedAttestationHash,
      registeredAttestationHash,
      matches,
      verified: matches,
      summary: matches
        ? "Attestation hash matches the value registered on-chain."
        : registeredAttestationHash === null
          ? "No attestation hash is registered for this resource in mock mode."
          : "The supplied attestation hash does not match the value registered on-chain.",
      contract: contractId,
    },
    null,
    2,
  );
}

export function mockUpdateMetadata(resourceId: string, metadata: string): string {
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      metadata,
      txHash: `MOCK_TX_UPDATE_META_${resourceId}`,
      explorerUrl: explorerTxUrl(`MOCK_TX_UPDATE_META_${resourceId}`),
      source: "on-chain (mock)",
    },
    null,
    2,
  );
}

export function mockSetPrice(resourceId: string, price: string): string {
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      price,
      txHash: `MOCK_TX_SET_PRICE_${resourceId}`,
      explorerUrl: explorerTxUrl(`MOCK_TX_SET_PRICE_${resourceId}`),
      source: "on-chain (mock)",
    },
    null,
    2,
  );
}

export function mockTransferOwnership(resourceId: string, newCreator: string): string {
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      newCreator,
      txHash: `MOCK_TX_TRANSFER_${resourceId}`,
      explorerUrl: explorerTxUrl(`MOCK_TX_TRANSFER_${resourceId}`),
      source: "on-chain (mock)",
    },
    null,
    2,
  );
}

export function mockAcceptTransfer(resourceId: string): string {
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      txHash: `MOCK_TX_ACCEPT_TRANSFER_${resourceId}`,
      explorerUrl: explorerTxUrl(`MOCK_TX_ACCEPT_TRANSFER_${resourceId}`),
      source: "on-chain (mock)",
    },
    null,
    2,
  );
}

export function mockCancelTransfer(resourceId: string): string {
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      txHash: `MOCK_TX_CANCEL_TRANSFER_${resourceId}`,
      explorerUrl: explorerTxUrl(`MOCK_TX_CANCEL_TRANSFER_${resourceId}`),
      source: "on-chain (mock)",
    },
    null,
    2,
  );
}

export function mockPendingTransfer(resourceId: string): string {
  // Deterministic mock: derive a stable proposed-owner address from the resource id.
  const mockProposedOwner = Keypair.fromRawEd25519Seed(
    Buffer.from(
      `mock-proposed-owner-${resourceId}`.padEnd(32, "\0").slice(0, 32),
      "utf8",
    ),
  ).publicKey();

  return JSON.stringify(
    {
      source: "on-chain (mock)",
      resourceId,
      found: true,
      proposedNewOwner: mockProposedOwner,
      message: `A pending ownership transfer exists for resource "${resourceId}".`,
      contract: "MOCK_CONTRACT_ID",
      network: "Test SDF Network ; September 2015",
      rpc: "https://soroban-testnet.stellar.org",
    },
    null,
    2,
  );
}

export function mockSetListed(resourceId: string, listed: boolean): string {
  return JSON.stringify(
    {
      status: "success",
      resourceId,
      listed,
      txHash: `MOCK_TX_SET_LISTED_${resourceId}`,
      explorerUrl: explorerTxUrl(`MOCK_TX_SET_LISTED_${resourceId}`),
      source: "on-chain (mock)",
    },
    null,
    2,
  );
}

export function mockSetTags(resourceId: string, tags: string[]): string {
  const txHash = `MOCK_TX_SET_TAGS_${resourceId}`;
  return [
    `Tags updated for resource "${resourceId}".`,
    `Tags: ${tags.length > 0 ? tags.join(", ") : "(none)"}`,
    `Tx hash: ${txHash}`,
    `Explorer: ${explorerTxUrl(txHash)}`,
    "Source: on-chain (mock)",
  ].join("\n");
}

/**
 * Deterministic mock for batch publish. Returns a summary that mirrors the
 * real `publishBatch` output with all items approved and registered on-chain.
 */
export function mockPublishBatch(
  items: Array<{ title: string; description?: string; price: string; externalUrl: string }>,
): string {
  const itemResults = items.map((item, i) => ({
    index: i,
    title: item.title,
    id: `mock-batch-${i + 1}`,
    verificationStatus: "approved" as const,
    onchainStatus: "registered",
  }));
  return JSON.stringify(
    {
      requested: items.length,
      verified: items.length,
      rejected: 0,
      errored: 0,
      onchainStatus: "registered",
      txHash: `MOCK_TX_BATCH_REGISTER`,
      items: itemResults,
      source: "on-chain (mock)",
    },
    null,
    2,
  );
}

/**
 * Deterministic mock receipt for buy flows. Returns a purchase receipt object
 * that mirrors the shape of a real x402 payment receipt, with deterministic
 * fields so tests can assert on exact values.
 */
export interface MockBuyReceipt {
  resourceId: string;
  amount: string;
  network: string;
  txHash: string;
  receiptRef: string;
  purchasedAt: string;
}

const MOCK_BUY_COUNTER = new WeakMap<object, number>();

export function mockBuyReceipt(
  resourceId: string,
  amount: string,
  network: string = "stellar:testnet",
  nonce?: object,
): MockBuyReceipt {
  const counter = nonce
    ? ((MOCK_BUY_COUNTER.get(nonce) ?? 0) + 1,
      MOCK_BUY_COUNTER.set(nonce, (MOCK_BUY_COUNTER.get(nonce) ?? 0) + 1),
      MOCK_BUY_COUNTER.get(nonce)!)
    : 1;
  return {
    resourceId,
    amount,
    network,
    txHash: `MOCK_TX_BUY_${resourceId}_${counter}`,
    receiptRef: `mock-receipt-${resourceId}-${counter}`,
    purchasedAt: "2026-08-25T12:00:00.000Z",
  };
}

/**
 * On-chain registry resources seeded into the mock. Exported so the fixture
 * generation script can serialise them alongside the catalog fixtures.
 */
export const MOCK_REGISTRY_RESOURCES: MockRegistryResource[] = [
  {
    id: "mock-1",
    creator: "GMOCKCREATOR1",
    price: "1.5000000 USDC",
    metadata: "Intro to Stellar",
    listed: true,
    tags: [],
  },
  {
    id: "mock-2",
    creator: "GMOCKCREATOR2",
    price: "0.5000000 USDC",
    metadata: "x402 Cheat Sheet",
    listed: true,
    tags: [],
  },
];

/**
 * Stand-in for on-chain registry list(). Paginates the same seeded rows as lookup.
 */
export function mockRegistryList(
  start: number,
  limit: number,
  contractId: string,
  activePublicKey?: string | null,
): string {
  const allResources = [...MOCK_REGISTRY_RESOURCES];
  if (activePublicKey) {
    allResources.push({
      id: "mock-profile",
      creator: activePublicKey,
      price: "2.5000000 USDC",
      metadata: "Your Profile Fixture",
      listed: true,
      tags: [],
    });
  }
  const slice = allResources.slice(start, start + limit);
  if (slice.length === 0) {
    const message =
      start === 0 && allResources.length === 0
        ? "No resources registered on-chain yet (mock mode)."
        : `No on-chain resources in range [${start}, ${start + limit}) (mock mode). Try a lower start index.`;
    return JSON.stringify(
      {
        source: "on-chain (mock)",
        start,
        limit,
        count: 0,
        message,
        resources: [],
        contract: contractId,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      source: "on-chain (mock)",
      start,
      limit,
      count: slice.length,
      resources: slice,
      contract: contractId,
    },
    null,
    2,
  );
}

/**
 * Stand-in for the on-chain count()/listed_count()/creator_resource_count()
 * trio. Derives values from the same MOCK_REGISTRY_RESOURCES seed so the
 * numbers stay consistent with mockRegistryList.
 */
export function mockRegistryCount(creator: string | undefined, contractId: string): string {
  const all = MOCK_REGISTRY_RESOURCES;
  const count = all.length;
  const listedCount = all.filter((r) => r.listed).length;

  const payload: {
    source: string;
    count: number;
    listedCount: number;
    creatorCount?: number;
    creator?: string;
    contract: string;
  } = {
    source: "on-chain (mock)",
    count,
    listedCount,
    contract: contractId,
  };

  if (creator != null) {
    payload.creator = creator;
    payload.creatorCount = all.filter((r) => r.creator === creator).length;
  }

  return JSON.stringify(payload, null, 2);
}
