# MCP Quickstart — Full Agent Session Walkthrough

This walkthrough takes you from a fresh MCP install to a working agent-to-agent flow on Stellar **testnet**: one agent sets up a wallet, registers as a publisher, publishes a resource (paying for verification via x402), and a second agent browses the catalog and buys the resource.

Everything below uses the tools exposed by the MindVault MCP server (`mcp/`). The server defaults to the hosted backend at `https://mindvault-hyr3.onrender.com` and the testnet vault-registry contract — no env vars required for the happy path.

## Prerequisites

- The MCP server is installed and registered with your client (see [README → MCP Server](../README.md#mcp-server) for `claude mcp add` / `codex mcp add` commands).
- Your agent has network access to:
  - `https://mindvault-hyr3.onrender.com` (vault API)
  - `https://stellar-sponsored-agent-account.onrender.com` (sponsored wallet creation)
  - `https://horizon-testnet.stellar.org` (Stellar testnet Horizon)
- Testnet USDC funding for the publisher agent — see [Funding the agent wallet](#2-funding-the-agent-wallet) below.

## The Two Agents

Call this Agent A (the publisher) and Agent B (the buyer). In practice they're two separate MCP sessions; tool state (wallet, API key) lives in-memory per session, so each agent has its own wallet.

---

## Agent A — Publish a resource

### 1. `mindvault_setup_wallet`

Creates a sponsored Stellar testnet account. The sponsor covers the ~1.5 XLM reserve and USDC trustline, so the agent starts with a usable wallet at zero upfront cost.

**Input:** _(none)_

**Example output:**

```
Wallet created.
Profile: default
Address: GAGENT...XYZ
Wallet persisted to ~/.mindvault/state.json (mode 0600).
```

`structuredContent` carries `{ profile, address, persisted }` so the agent can
read the public key without parsing the lines. Secret keys are never returned.

### 2. Funding the agent wallet

The wallet has an XLM reserve and a USDC trustline but **no USDC**. To pay the verification fee on `publish`, fund it from the Circle testnet faucet:

1. Visit [faucet.circle.com](https://faucet.circle.com)
2. Pick **Stellar testnet** and paste the address from step 1
3. Wait for the faucet payment to confirm

Confirm the balance landed:

### 3. `mindvault_wallet_info`

**Input:** _(none)_

**Example output:**

```
Address: GAGENT...XYZ
USDC Balance: 10.0000000
```

> Troubleshooting: if `USDC Balance` is still `0`, the faucet payment hasn't settled yet — wait ~10 seconds and re-run. If it stays at `0`, the trustline may be missing; re-run `mindvault_setup_wallet` to recreate the sponsored account.

### 4. `mindvault_register`

Registers a publisher record bound to the agent's wallet. Returns an API key that the MCP server holds in memory for subsequent `publish` calls.

**Input:**

```json
{
  "name": "Agent A",
  "email": "agent-a@example.com"
}
```

(`walletAddress` is optional — defaults to the current agent wallet.)

**Example output:** a confirmation string with the publisher ID and a stored API key.

### 5. `mindvault_publish`

Publishes a link resource. The MCP server signs the x402 verification payment using the agent wallet, so the publisher's USDC pays for verification.

**Input:**

```json
{
  "title": "Sample weather forecast feed",
  "description": "Hourly forecast JSON for SF",
  "price": "0.05",
  "externalUrl": "https://example.com/sf-forecast.json"
}
```

**Example output:** a confirmation with the new `resourceId`, verification status, and the paywalled `accessUrl`.

> Troubleshooting: if `publish` returns an x402 verification error, the wallet is most likely under-funded. The required verification fee is small (well under $1) — re-check `mindvault_wallet_info` and re-fund if needed. For deeper x402 sign/pay debugging see [docs/x402-payment-troubleshooting.md](x402-payment-troubleshooting.md).

### 5b. `mindvault_publish_status` _(optional)_

Poll verification and on-chain sync after publish. Returns `verificationStatus` (`pending` | `verified` | `rejected` | `skipped`), `listed`, `onchainStatus`, and `onchainTxHash`. Pass `wait: true` to poll until verification settles (or `timeoutMs` elapses).

**Input:**

```json
{
  "resourceId": "swcn98besxpp6t1u8e77fqz3",
  "wait": true,
  "timeoutMs": 60000
}
```

**Errors:** missing `resourceId` and HTTP 404s return deterministic messages so agents can retry or correct the id.

---

## Agent B — Discover and buy

Start a second MCP session (or a separate agent). It needs its own wallet and its own USDC to pay for the resource.

### 6. `mindvault_setup_wallet` (Agent B)

Same as step 1 — gives Agent B its own sponsored testnet wallet.

### 7. Fund Agent B's wallet

Same flow as step 2 — send testnet USDC to Agent B's address. The amount needs to cover the resource price plus a tiny x402 fee buffer.

### 8. `mindvault_browse`

Lists resources in the catalog with their IDs, titles, prices, and access URLs. Accepts the same optional filters as `mindvault_search` / `GET /resources` (keyword, price range, verification status, resource type, owner, sort, pagination, tags, listed).

**Input:** _(none required; filters optional)_

```json
{
  "verificationStatus": "verified",
  "maxPrice": "1.00",
  "sort": "price_asc",
  "limit": 20
}
```

**Example output:**

```
[abc123] Sample weather forecast feed — $0.05 USDC
  Hourly forecast JSON for SF
  https://mindvault-hyr3.onrender.com/r/abc123
```

The same resources also arrive as MCP `structuredContent` (`items` with `id`,
`title`, `price`, `accessUrl`) so an agent does not have to parse the list.
See [mcp-structured-output.md](mcp-structured-output.md).

### 9. `mindvault_search` (optional)

Search the catalog by keyword plus filters. Server-supported filters are forwarded to `GET /resources`; `tags` and `listed` are applied client-side for parity with catalog/meta fields.

**Input:**

```json
{
  "query": "forecast",
  "minPrice": "0.01",
  "maxPrice": "1.00",
  "verificationStatus": "verified",
  "resourceType": "link",
  "owner": "Alice",
  "sort": "newest",
  "limit": 20,
  "offset": 0,
  "tags": "forecast,weather",
  "listed": true
}
```

**Example output:**

```
[abc123] Sample weather forecast feed — $0.05 USDC
  Hourly forecast JSON for SF
  https://mindvault-hyr3.onrender.com/r/abc123
```

### 8b. Catalog resources (`resources/list` and `resources/read`) _(optional)_

The MCP server also advertises the `resources` capability, so clients can discover catalog entries without invoking a tool. `resources/list` returns every catalog entry with a stable URI, and `resources/read` returns its **public metadata only** — never gated content.

- URI scheme: `mindvault://resource/<id>` (e.g. `mindvault://resource/abc123`)
- `resources/list` → entries with `name` (the title), `description`, and `mimeType: application/json`
- `resources/read` on a known URI → `{ id, title, description, price, resourceType, verificationStatus, accessUrl }`
- Unknown URIs and unknown resource ids return deterministic errors, so agents can correct the URI or fall back to `mindvault_browse` / `mindvault_search`

If no resource matches, the error message includes the applied filters, for example:

```
No resources match query "forecast", min $0.01, max $1.00, status verified, type link.
```

Invalid filter values (bad price range, unknown enums, etc.) return a deterministic error string without calling the API.

### 10. `mindvault_preview` (optional)

Show full metadata and verification status before paying. The JSON text and
`structuredContent` share `{ id, title, description, price, type, verificationStatus, accessUrl }`.

**Input:**

```json
{ "resourceId": "abc123" }
```

### 11. `mindvault_buy`

Pays the resource price in USDC via x402 and returns the protected content.

**Input:**

```json
{ "resourceId": "abc123" }
```

**Example output:** a JSON summary (`before` / `after` / `txHash`) as both text
and `structuredContent`. The protected content is in the `after` object.

> Troubleshooting: a `402 Payment Required` after `buy` means the payment didn't settle — usually insufficient USDC. Run `mindvault_wallet_info` to check the balance.

Successful buys also append a local receipt under `~/.mindvault/purchases.json` for later inspection via `mindvault_purchase_history`.

---

### 12. `mindvault_purchase_history`

Read-only list of locally persisted purchase receipts. Optional filters:

```json
{ "resourceId": "abc123", "network": "stellar:testnet" }
```

Returns `{ count, purchases }` (newest first). Empty history returns `count: 0` with a clear message — invalid filter types raise a deterministic error.

---

### 12b. `mindvault_export_receipts`

Export those receipts as a schema-versioned document for reconciliation — JSON, or RFC 4180 CSV in the envelope's `csv` field. Optional `resourceId`, `network`, `since`, `until`, and `limit` filters.

```json
{ "format": "csv", "since": "2026-08-01", "until": "2026-08-31" }
```

Returns a `mindvault.receipt-export/v1` envelope with `count`, an exact `totalAmount`, an explicit `currency`, and one normalized row per purchase (including the Stellar Expert link). The tool advertises an `outputSchema`, so the same envelope also arrives as MCP `structuredContent`. See [mcp-receipt-export.md](mcp-receipt-export.md).

---

### 13. `mindvault_register_onchain`

Registers an already-published, verified resource on the vault-registry contract.
`mindvault_publish` attempts this automatically, but if the on-chain step fails
the resource stays listed and purchasable while reporting
`Retry with mindvault_register_onchain`. This tool is that retry path: it prepares
the unsigned register transaction (owner-only), signs it with the agent wallet
(the resource creator), submits it, and returns the registry status and tx hash.

**Input:**

```json
{ "resourceId": "abc123" }
```

**Example output:**

```
Resource registered on-chain.
Resource: abc123
Registry status: registered
On-chain tx: 5f3a...c9
```

> Troubleshooting: a `400` means the resource isn't verified yet; a `409` means it's
> already registered (no action needed). A submission failure leaves the resource
> listed — ensure the agent wallet is funded for fees and retry.

---

### 14. `mindvault_update_metadata`

Updates the on-chain metadata pointer for a registered resource in the vault-registry contract. Validates pointer format and length (max 512 chars, must start with ipfs://, ar://, http(s)://, sha256:, sha-256:, or 0x) client-side before signing.

**Input:**

```json
{ "resourceId": "abc123", "metadata": "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco" }
```

---

### 15. `mindvault_set_price`

Updates the on-chain price in USDC for a registered resource in the vault-registry contract.

**Input:**

```json
{ "resourceId": "abc123", "price": "10.00" }
```

---

### 16. `mindvault_transfer_ownership`

Transfers ownership of a registered resource on the vault-registry contract to a new creator address.

**Input:**

```json
{ "resourceId": "abc123", "newCreator": "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH" }
```

---

### 17. `mindvault_set_listed`

Manages catalog availability by listing or delisting a resource on-chain.

**Input:**

```json
{ "resourceId": "abc123", "listed": false }
```

---

## Acceptance walkthrough

Following the steps above, a single operator running two MCP sessions should be able to:

1. Set up two sponsored testnet wallets
2. Fund both from the Circle testnet faucet
3. Publish a resource from Agent A (verification fee paid via x402)
4. Browse the catalog from Agent B and buy that exact resource (price paid via x402)

If any step fails, the most common root causes are:

| Symptom                                         | Likely cause                                      | Fix                                                          |
| ----------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `USDC Balance: 0`                               | Faucet payment hasn't settled / trustline missing | Wait and re-check, or rerun `mindvault_setup_wallet`         |
| `publish` returns an x402 verification error    | Publisher wallet under-funded                     | Re-fund and retry                                            |
| `buy` returns `402 Payment Required`            | Buyer wallet under-funded for resource price      | Re-fund and retry                                            |
| `Not registered. Run mindvault_register first.` | API key was lost (e.g. server restart)            | Re-run `mindvault_register` in the same session              |
| `No wallet. Run mindvault_setup_wallet first.`  | Wallet state cleared between sessions             | The wallet is in-memory only — re-create it for each session |

See also: [docs/x402-payment-troubleshooting.md](x402-payment-troubleshooting.md) for x402-specific sign/pay failures.

## Optional request signatures

Some deployments set `REQUIRE_REQUEST_SIGNATURE=true` so publisher mutations must include `X-Timestamp` and `X-Signature` headers (HMAC-SHA256 over method, path, body, and timestamp). The MCP server signs these automatically when calling the API with your publisher key. See [request-signature.md](request-signature.md) for the full scheme.
