# API Examples

curl examples for all core MindVault API workflows. Replace placeholder values (`<...>`) with real values.

```
BASE=https://mindvault-hyr3.onrender.com   # or http://localhost:4021 for local dev
API_KEY=mv_...                             # from POST /publishers response
RESOURCE_ID=swcn98besxpp6t1u8e77fqz3      # from POST /resources or GET /resources
```

---

## Health Check

```bash
curl -s $BASE/health
```

Expected response:

```json
{ "status": "ok" }
```

---

## Publisher Registration

### Register a publisher

```bash
curl -s -X POST $BASE/publishers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice Creator",
    "email": "alice@example.com",
    "walletAddress": "GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM"
  }' | jq .
```

Expected response (`201 Created`):

```json
{
  "id": "clxyz1234",
  "name": "Alice Creator",
  "email": "alice@example.com",
  "walletAddress": "GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM",
  "apiKey": "mv_abc123...",
  "createdAt": "2026-06-24T13:00:00.000Z"
}
```

> The `apiKey` is returned **once**. Store it — it cannot be retrieved again.

### Look up publisher by wallet address

```bash
curl -s $BASE/publishers/wallet/GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM | jq .
```

### Get own profile (authenticated)

```bash
curl -s $BASE/publishers/me \
  -H "x-api-key: $API_KEY" | jq .
```

### List own resources (authenticated)

```bash
curl -s $BASE/publishers/me/resources \
  -H "x-api-key: $API_KEY" | jq .
```

### Get earnings and analytics (authenticated)

```bash
curl -s $BASE/publishers/me/analytics \
  -H "x-api-key: $API_KEY" | jq .summary
```

### Creator leaderboard (public)

```bash
curl -s $BASE/publishers/leaderboard | jq '.[0:3]'
```

---

## Publishing Resources

### Publish a link resource

```bash
curl -s -X POST $BASE/resources \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "title": "My Research Dataset",
    "description": "Curated dataset of 10k annotated examples.",
    "price": "0.50",
    "externalUrl": "https://your-host.example/dataset.zip"
  }' | jq .
```

Expected response (`201 Created`):

```json
{
  "id": "swcn98besxpp6t1u8e77fqz3",
  "title": "My Research Dataset",
  "description": "Curated dataset of 10k annotated examples.",
  "price": "0.50",
  "resourceType": "link",
  "verificationStatus": "pending",
  "listed": false,
  "createdAt": "2026-06-24T13:05:00.000Z",
  "accessUrl": "https://mindvault-hyr3.onrender.com/resources/swcn98besxpp6t1u8e77fqz3"
}
```

Verification runs asynchronously. Poll `/resources/:id/verification` to check status.

### Publish a file resource

```bash
curl -s -X POST $BASE/resources \
  -H "x-api-key: $API_KEY" \
  -F "title=My Trained Model" \
  -F "description=Fine-tuned classifier, 94% accuracy" \
  -F "price=1.00" \
  -F "file=@/path/to/model.zip" | jq .
```

The file is stored in Supabase Storage. Maximum size is controlled by `MAX_FILE_SIZE_MB` (default 50 MB). Buyers receive a file download after payment.

---

## Browsing the Catalog

```bash
curl -s $BASE/resources | jq '[.[] | {id, title, price, accessUrl}]'
```

Expected response (array):

```json
[
  {
    "id": "swcn98besxpp6t1u8e77fqz3",
    "title": "My Research Dataset",
    "price": "0.50",
    "accessUrl": "https://mindvault-hyr3.onrender.com/resources/swcn98besxpp6t1u8e77fqz3"
  }
]
```

### Searching and filtering

`GET /resources` accepts optional query parameters that narrow the catalog. They can be combined; supported HTTP filters are applied **server-side** before the response is returned. The MCP `mindvault_browse` and `mindvault_search` tools apply `tags` and `listed` client-side after receiving the server results. (The web app's `CatalogSearch` UI and the MCP `mindvault_search` tool send these same server-supported parameters.)

| Parameter            | Type                                               | Effect                                                           |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `search`             | string                                             | Case-insensitive match against resource **title or description** |
| `minPrice`           | number string (e.g. `0.50`)                        | Only resources priced ≥ `minPrice`                               |
| `maxPrice`           | number string                                      | Only resources priced ≤ `maxPrice`                               |
| `verificationStatus` | `verified` \| `pending` \| `rejected`              | Filter by verification status                                    |
| `resourceType`       | `file` \| `link`                                   | Filter by resource type                                          |
| `owner`              | string                                             | Case-insensitive match against publisher name or wallet          |
| `sort`               | `newest` \| `price_asc` \| `price_desc` \| `title` | Sort order (default `newest`)                                    |
| `limit`              | integer 1–100                                      | Page size (default 20)                                           |
| `offset`             | integer ≥ 0                                        | Pagination offset                                                |

The MCP `mindvault_browse` and `mindvault_search` tools forward these same parameters (MCP `query` maps to `search`). They also accept `tags` and `listed`, which are applied client-side for parity with catalog/meta and on-chain fields (the public HTTP schema rejects unknown query params).

Price bounds are compared numerically, so equivalent decimal strings such as `"0.50"` and `"0.5"` match the same USDC prices. MCP tag matching is case-insensitive and requires every requested tag. Because the public catalog contains listed resources only, `listed=true` preserves the public result set and `listed=false` returns no public catalog matches.

```bash
# Verified links priced between 0.10 and 1.00 USDC that mention "dataset"
curl -s "$BASE/resources?search=dataset&verificationStatus=verified&resourceType=link&minPrice=0.10&maxPrice=1.00" \
  | jq '[.[] | {id, title, price, resourceType, verificationStatus}]'
```

Notes and current limitations:

- `minPrice` and `maxPrice` must be non-negative numbers and `minPrice` cannot exceed `maxPrice` (otherwise the request is rejected with `400`).
- Unknown query parameters are rejected (the schema is strict).
- Filtering runs **in memory over the listed set** on each request — there is no full-text/database search index yet, so this is appropriate at the current catalog scale rather than a scalable search backend.
- The web search box is labelled "Search by title…", but the server also matches the description.

---

## Resource Preview

### Get resource metadata (public, no payment)

```bash
curl -s $BASE/resources/$RESOURCE_ID/meta | jq .
```

Expected response:

```json
{
  "id": "swcn98besxpp6t1u8e77fqz3",
  "title": "My Research Dataset",
  "description": "Curated dataset of 10k annotated examples.",
  "price": "0.50",
  "resourceType": "link",
  "verificationStatus": "verified",
  "listed": true,
  "accessUrl": "https://mindvault-hyr3.onrender.com/resources/swcn98besxpp6t1u8e77fqz3"
}
```

---

## Checking Verification Status

```bash
curl -s $BASE/resources/$RESOURCE_ID/verification | jq .
```

Expected response:

```json
{
  "id": "swcn98besxpp6t1u8e77fqz3",
  "verificationStatus": "verified",
  "verificationId": "ver_abc123",
  "isOriginal": true,
  "confidence": 0.95,
  "flags": []
}
```

`verificationStatus` is one of `pending`, `verified`, or `rejected`. A rejected resource is not listed in the catalog.

---

## Accessing a Paywalled Resource

### Inspect the 402 response

```bash
curl -i $BASE/resources/$RESOURCE_ID
```

Expected response:

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6IjEiLCJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJzdGVsbGFyOnRlc3RuZXQiLCJwYXlUbyI6IkdC...
Content-Type: application/json

{"error":"Payment required","amount":"0.50","currency":"USDC","network":"stellar:testnet"}
```

The `PAYMENT-REQUIRED` header is a base64-encoded JSON object containing:

```json
{
  "x402Version": "1",
  "scheme": "exact",
  "network": "stellar:testnet",
  "payTo": "GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "price": "5000000"
}
```

### Decode the payment details

```bash
curl -si $BASE/resources/$RESOURCE_ID \
  | grep PAYMENT-REQUIRED \
  | awk '{print $2}' \
  | base64 -d | jq .
```

### Pay and access (x402 client required)

Human browsers with Freighter/xBull handle payment automatically via the web app. For programmatic access, use an x402-aware client:

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const signer = createEd25519Signer(SECRET_KEY, "stellar:testnet");
const scheme = new ExactStellarScheme(signer);
const client = new x402Client().register("stellar:testnet", scheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch(
  "https://mindvault-hyr3.onrender.com/resources/swcn98besxpp6t1u8e77fqz3",
);
const data = await res.json();
// { url: "https://...", receipt: { paymentId, amount, currency, paidTo, paidAt } }
```

---

## Agent Status

```bash
curl -s $BASE/agent/status | jq '{agent: .agent, stats: .stats}'
```

Expected response:

```json
{
  "agent": {
    "name": "MindVault Verification Agent",
    "walletAddress": "GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM",
    "network": "stellar:testnet",
    "endpoint": "https://mindvault-hyr3.onrender.com/verify-content",
    "pricePerVerification": "0.10",
    "currency": "USDC",
    "status": "active"
  },
  "stats": {
    "totalVerifications": 7,
    "verified": 2,
    "rejected": 5,
    "totalEarned": "0.7000",
    "avgConfidence": "0.82"
  }
}
```

---

## Delist a Resource

```bash
curl -s -X DELETE $BASE/resources/$RESOURCE_ID \
  -H "x-api-key: $API_KEY" | jq .
```

Expected response:

```json
{ "message": "Resource delisted", "id": "swcn98besxpp6t1u8e77fqz3" }
```
