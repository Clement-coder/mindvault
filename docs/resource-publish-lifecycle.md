# Resource Publish Lifecycle

This guide documents the current MindVault resource lifecycle from the first publisher API call through verification, listing, on-chain registration, x402 purchase, and buyer receipt handling.

It is written for both web contributors and MCP contributors, and it uses the same state names the server stores in the database and returns from the API.

## Shared state model

Three fields define the lifecycle:

| Field                | Values                                       | Meaning                                                                                    |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `verificationStatus` | `pending`, `verified`, `rejected`, `skipped` | Off-chain content review state. New resources start at `pending`.                          |
| `listed`             | `true`, `false`                              | Whether the resource is in the public catalog and can be discovered from `GET /resources`. |
| `onchainStatus`      | `none`, `pending`, `registered`, `failed`    | Soroban registry registration state. New resources start at `none`.                        |

Notes:

- `verificationStatus = "skipped"` exists in the enum but is not set by the publish flow shown here.
- `listed` is separate from `onchainStatus`. Verification can list a resource before on-chain registration succeeds.
- `onchainTxHash` is only populated after a successful registration submission.

## 1. Publisher registration

Both web and MCP flows start by creating a publisher:

`POST /publishers`

The response returns:

- `id`
- `walletAddress`
- `apiKey` (shown once)

That `apiKey` is then used for owner-only resource endpoints such as `POST /resources`, `GET /resources/:id/register/prepare`, and `POST /resources/:id/register`.

## 2. Resource creation

Resources are created with:

- `POST /resources` with `multipart/form-data` for file uploads
- `POST /resources` with JSON for link resources

Two creation paths exist in the service layer:

- `createFileResource(...)`
- `createLinkResource(...)`

Immediately after a successful create, the resource state is:

| Field                | Value            |
| -------------------- | ---------------- |
| `resourceType`       | `file` or `link` |
| `verificationStatus` | `pending`        |
| `listed`             | `false`          |
| `onchainStatus`      | `none`           |

The response also includes the paywalled `accessUrl`.

For file resources, the row is inserted first and then `storagePath` is filled in after the upload succeeds.

### Failure and retry paths

- `400` if the request body is invalid.
- `401` if the API key is missing or invalid.
- `429` if publish rate limits fire.
- If the client sends `Idempotency-Key`, the server stores the first completed result per publisher and replays it on retries.
- If the same idempotency key is already in flight, the server returns `409`.

If creation succeeds but verification never happens, the resource remains private in practice: `verificationStatus = "pending"`, `listed = false`, `onchainStatus = "none"`.

## 3. Verification payment and status update

Verification is a separate paid step:

`POST /verify-content`

This endpoint is x402-protected. The normal sequence is:

1. Client calls `POST /verify-content`.
2. Server returns HTTP `402` with payment instructions.
3. Client signs the Stellar USDC payment and retries with `X-Payment`.
4. Server runs the originality check.
5. If `resourceId` was supplied, the server inserts a row in `verifications` and updates the matching resource.

When verification completes for a resource:

- If the content is accepted:
  - `verificationStatus = "verified"`
  - `verificationId` is set
  - `listed = true`
- If the content is rejected:
  - `verificationStatus = "rejected"`
  - `verificationId` is set
  - `listed = false`

`onchainStatus` is unchanged by verification.

### Failure and retry paths

- If the x402 payment never settles, the resource row is unchanged. It stays `pending` and unlisted.
- `429` can be returned by verify rate limiting.
- Verification can be retried for the same resource by calling `POST /verify-content` again with the same `resourceId` once the wallet is funded and the client can complete payment.

To inspect the result:

`GET /resources/:id/verification`

This returns the canonical verification view, including:

- `status`
- `listed`
- `verification.isOriginal`
- `verification.confidence`
- `verification.flags`
- `verification.checkedAt`

## 4. Listing and preview behavior

After verification, two public read paths matter:

- `GET /resources` returns only resources where `listed = true`.
- `GET /resources/:id/meta` returns preview metadata including `verificationStatus`, `onchainStatus`, and `contentHash`.

That means:

- approval makes the resource discoverable in the public catalog
- rejection keeps it out of the catalog
- preview metadata is broader than catalog listing and should not be treated as proof that a resource is buyable

### Content integrity anchor

At publish time the server computes a SHA-256 `contentHash` over the canonical content (the URL for link resources, the title + file bytes for file resources — see `server/src/utils/crypto.ts`). This hash is the off-chain content integrity anchor and is embedded in the on-chain registry `metadata` JSON when the resource is registered.

`GET /resources/:id/meta` now exposes `contentHash` (nullable). The web preview surfaces it under **Content integrity**:

- When a hash is present, the UI shows the SHA-256 anchor and, for registered resources, links to the registration transaction on Stellar Explorer so anyone can confirm the anchor was committed on-chain.
- When no hash is available, the UI shows "No integrity anchor available for this resource" and makes **no** claim of verification.

The anchor identifies the exact content recorded at registration. It is not a live re-verification of delivered bytes — file bytes are only delivered after payment, so the preview deliberately does not imply that the delivered content has been re-hashed and checked.

## 5. On-chain registration

On-chain registration is a separate owner action and requires the resource to already be verified.

### Browser/web flow

The browser flow is:

1. `GET /resources/:id/register/prepare`
2. Browser wallet signs the returned `unsignedXdr`
3. `POST /resources/:id/register` with `signedXdr`

Important detail: the prepare endpoint is a `GET` in the current API and does not mutate database state.

### MCP flow

The current `mindvault_publish` tool does three steps in order:

1. create the resource
2. pay for verification
3. best-effort call `POST /resources/:id/register`

Today that MCP call does not expose a dedicated prepare/sign/retry register tool. It relies on the legacy server-signed branch of `POST /resources/:id/register` by omitting `signedXdr`.

### Registration state transitions

Preconditions enforced by both register endpoints:

- owner must match the authenticated publisher
- `verificationStatus` must already be `verified`

`GET /resources/:id/register/prepare` returns `409` if the resource is already registered.

`POST /resources/:id/register` behaves like this:

- if `onchainStatus = "registered"`, return `409`
- if `onchainStatus = "pending"`, return `409`
- if `onchainStatus = "none"` or `onchainStatus = "failed"`, continue
- before submission, set `onchainStatus = "pending"`
- on success, set:
  - `onchainStatus = "registered"`
  - `onchainTxHash = <tx hash>`
- on failed submission or failed confirmation, set:
  - `onchainStatus = "failed"`

The retry path is:

`failed -> pending -> registered|failed`

### Failure and retry paths

- `400` if the resource is not verified.
- `403` if the publisher does not own the resource.
- `404` if the resource does not exist.
- `409` if registration is already `pending` or already `registered`.
- `500` if prepare cannot build the unsigned transaction.
- `502` if submit fails or transaction confirmation times out in the current submit helper.

Note: Certain route-like or system resource IDs (such as `admin`, `null`, `registry`, `api`, `index`, `root`, `system`) are reserved by the on-chain contract. Registration attempts using these IDs (case-insensitive) will fail deterministically at the contract level.

One important implementation detail: registration failure does not clear `listed`. The resource can stay listed while `onchainStatus = "failed"`.

## 6. Purchase via x402

The buyer access path is:

`GET /resources/:id`

This route is protected by the dynamic x402 paywall.

The current server behavior is:

1. Load the resource row.
2. Return `404` if the resource does not exist.
3. Return `404` if `listed = false`.
4. Look up the resource on-chain to validate price and creator data before serving payment instructions.
5. If unpaid, return HTTP `402` with `PAYMENT-REQUIRED`.
6. If the client retries with valid payment proof, deliver the resource and record a payment row.

### Current purchase preconditions

The paywall currently performs an on-chain lookup before it will serve the paid resource flow. In practice, that means purchase depends on a readable on-chain record, not only on `listed = true`.

Current failure paths from the paywall are:

- `503` with `error: "chain_unavailable"` if the on-chain lookup fails or the resource is missing on-chain
- `409` with `error: "price_mismatch"` if the DB price and the on-chain price differ

This is important for contributors: a resource can be listed in the DB while still not purchasable if registration failed or chain state drifted.

### Payment recording and receipts

After a successful paid retry, the server inserts a `payments` row with:

- `resourceId`
- `payerAddress`
- `recipientAddress`
- `amount`
- `paidAt`

Delivery differs by resource type:

- Link resource:
  - response body includes `url`
  - response body includes `receipt.paymentId`, `amount`, `currency`, `paidTo`, `paidAt`
- File resource:
  - file bytes are streamed back
  - receipt metadata is returned in headers:
    - `X-Payment-Id`
    - `X-Payment-Amount`
    - `X-Payment-Recipient`

### Failure and retry paths

- If the buyer wallet is under-funded or signs invalid payment data, the client stays in the x402 challenge/retry loop until payment can settle.
- If the paywall returns `503 chain_unavailable`, fix the registration or RPC problem before retrying.
- If the paywall returns `409 price_mismatch`, reconcile DB and registry state before retrying.

## 7. State snapshots

| Lifecycle point         | `verificationStatus` | `listed` | `onchainStatus` |
| ----------------------- | -------------------- | -------- | --------------- |
| just created            | `pending`            | `false`  | `none`          |
| verification accepted   | `verified`           | `true`   | `none`          |
| verification rejected   | `rejected`           | `false`  | `none`          |
| registration submitted  | `verified`           | `true`   | `pending`       |
| registration confirmed  | `verified`           | `true`   | `registered`    |
| registration failed     | `verified`           | `true`   | `failed`        |
| owner delisted resource | unchanged            | `false`  | unchanged       |

## 8. Contributor takeaways

For web contributors:

- the owner-signing path is `GET /resources/:id/register/prepare` -> wallet signature -> `POST /resources/:id/register`
- verification and registration are separate concerns
- catalog visibility comes from `listed`, not from `onchainStatus`

For MCP contributors:

- `mindvault_publish` is a convenience wrapper around create -> verify -> best-effort register
- `mindvault_publish_status` polls `verificationStatus` (`pending` | `verified` | `rejected` | `skipped`) and on-chain sync fields (`onchainStatus`, `onchainTxHash`); pass `wait: true` to poll until verification settles
- a `wait: true` call streams one MCP `notifications/progress` update per poll when the client supplies a progress token — see [mcp-progress-notifications.md](mcp-progress-notifications.md)
- `mindvault_register_onchain` retries on-chain registration when the publish-time register step fails
- if registration fails, contributors should expect a resource that may be verified and listed but still blocked at purchase time by the current paywall behavior

Related docs:

- [creator-signed-registration-flow.md](creator-signed-registration-flow.md)
- [mcp-progress-notifications.md](mcp-progress-notifications.md)
- [mcp-quickstart.md](mcp-quickstart.md)
- [x402-payment-troubleshooting.md](x402-payment-troubleshooting.md)
- [reconciliation.md](reconciliation.md)
