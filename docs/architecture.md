# MindVault Architecture

Two distinct concerns sit at the heart of MindVault: **who gets paid and how**, and **who owns what and at what price**. x402 + USDC handles the first. The vault-registry Soroban contract handles the second. Neither depends on the other at runtime, but together they make the system both programmable and trustless.

---

## System Diagram

```
  Creator / AI Agent (publisher)
        │
        │  1. Register resource (signed Soroban tx)
        ▼
┌───────────────────────────┐
│   vault-registry contract │  ← on-chain source of truth
│   (Soroban / Stellar)     │
│                           │
│  Resource {               │
│    id       string        │
│    creator  Address       │  owner, enforced by require_auth
│    price    i128          │  USDC base units (7 decimals)
│    metadata string        │  IPFS URI / content hash
│    listed   bool          │
│    tags     Vec<String>   │  discovery labels
│    verified VerifStatus   │  Pending|Verified|Rejected, set by a verifier
│    frozen   bool          │  once true, metadata is immutable
│  }                        │
│                           │
│  list(start, limit)       │  paginated read — build catalogs
│  get(id)                  │  point read
│  count()                  │  total registrations
│                           │
│  admin (nominate/accept)  │  grants/revokes the verifier role,
│  verifier role            │  repairs the pagination index
└───────────────────────────┘
        │
        │  2. Server reads price + owner from contract
        ▼
┌─────────────────────────────────────────────────┐
│              MindVault Server                   │
│  (Express + @x402/express middleware)           │
│                                                 │
│  GET /resources/:id                             │
│    ├─ no payment header → 402 + payment details │
│    └─ valid payment header → serve content      │
└─────────────────────────────────────────────────┘
        │                         ▲
        │  3. 402 response        │  5. Retry with payment proof
        ▼                         │
  Buyer / AI Agent (consumer)     │
        │                         │
        │  4. Sign USDC transfer  │
        │     on Stellar          │
        ▼                         │
┌────────────────────────┐        │
│   x402 Facilitator     │────────┘
│   (x402.org / Coinbase)│
│                        │
│  verify + settle USDC  │  → USDC goes directly to creator wallet
└────────────────────────┘
```

---

## Payment layer: x402 + USDC

When a buyer (human or AI agent) requests a paywalled resource:

1. The server's `@x402/express` middleware intercepts the request and returns **HTTP 402** with a `PAYMENT-REQUIRED` header. The header is a base64-encoded JSON object containing the price, the creator's Stellar wallet address, the USDC Stellar Asset Contract ID, and the payment scheme.

2. An x402-aware client (browser with Freighter, `@x402/fetch` in Node, or the MCP server) reads the header, constructs a Soroban authorization entry for a USDC transfer from the buyer to the creator, and signs it with the buyer's key.

3. The signed authorization entry is attached to the retry request. The server passes it to the x402 facilitator at `x402.org/facilitator`, which **verifies** the signature and **settles** the USDC transfer on-chain.

4. Once the facilitator confirms settlement, the server delivers the resource. The USDC goes directly to the creator — MindVault takes no cut.

**Key properties of this layer:**

- No accounts, subscriptions, or OAuth flows required — a Stellar keypair is enough.
- The price in the 402 response is read from the vault-registry contract at request time, so the creator can update it on-chain and the paywall reflects it immediately.
- The USDC asset is the Stellar Asset Contract (SAC) wrapping the canonical Circle USDC issuer. Balances are interchangeable between classic Stellar and Soroban.

---

## Registry layer: vault-registry contract

The vault-registry is a Soroban smart contract deployed on Stellar. It is the **single, permissionless source of truth** for:

| Property   | Meaning                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------- |
| `creator`  | Stellar address that owns the resource; the only key allowed to mutate it                 |
| `price`    | Current access price in USDC base units (1 USDC = 10 000 000 base units)                  |
| `metadata` | Content pointer — typically an IPFS URI or SHA-256 content hash                           |
| `listed`   | Whether the resource is publicly discoverable                                             |
| `verified` | On-chain mirror of the server's verification result: `Pending`, `Verified`, or `Rejected` |
| `frozen`   | Once `true`, `metadata` can never be changed again                                        |

Anyone can read this data directly from the Soroban RPC without going through the MindVault API. The `list(start, limit)` method returns pages of resources in insertion order, enabling a full catalog to be built from chain with no off-chain index.

Mutations (`register`, `set_price`, `update_metadata`, `set_tags`, `transfer_ownership`, `set_listed`, `freeze_metadata`) all require the creator's Soroban `require_auth` signature. Attempting to transfer ownership to the current owner is protected against and will return a deterministic error. The server builds unsigned transactions that the creator signs client-side; the platform key never touches a creator's funds or ownership.

**Key properties of this layer:**

- Ownership is on-chain and enforced cryptographically — MindVault cannot reassign a resource without the creator's signature.
- The price the buyer actually pays (read from the contract at 402 time) is the canonical price, not a server-side value that could diverge silently.
- The `metadata` field anchors content integrity: storing a content hash here lets any client verify the delivered bytes against the registry entry. `freeze_metadata` lets a creator make that pointer permanent for marketplaces that need immutability guarantees.

### Roles: admin and verifier

Two roles exist alongside the per-resource `creator`:

- **admin** — set via `nominate_new_admin`/`accept_admin` (a two-step handoff: the current admin nominates a successor, who must accept before the change takes effect). The admin can grant or revoke the **verifier** role and can repair the pagination index (`repair_index`, see [`index-repair.md`](index-repair.md)). The admin cannot touch any resource's price, metadata, listing, tags, or ownership.
- **verifier** — any number of addresses the admin grants via `add_verifier`. A verifier's only privilege is `set_verification_status`, which mirrors the server's AI-originality check result on-chain so any client can filter or audit "verified" resources without trusting the MindVault API. Only `Pending→Verified`, `Pending→Rejected`, `Verified→Rejected`, and `Rejected→Verified` transitions are allowed — self-transitions and reverting to `Pending` are rejected deterministically, and every transition emits both the old and new status.

Both roles are intentionally narrow: neither can move funds, change a resource's price or metadata, or reassign ownership. They only gate the two orthogonal, non-financial concerns of on-chain verification state and index integrity.

---

## How the layers interact

```
vault-registry (chain)
      │
      │  server reads price + creator at 402 time
      │  server writes registration tx (creator-signed)
      │
MindVault server
      │
      │  server verifies payment via x402 facilitator
      │  server delivers content after settlement
      │
x402 facilitator + USDC SAC (chain)
```

The two on-chain components — the registry contract and the USDC SAC — are independent. A resource can exist in the registry with no payment ever having been made, and USDC payments can settle without the registry being involved. The server is what connects them: it reads the registry to build the 402 challenge, and it checks the facilitator's settlement before serving the content.

---

## Shared TypeScript client

The `@mindvault/registry-client` workspace package (`packages/registry-client/`) wraps the auto-generated Soroban bindings in a single stable import. All three consumers — `server/`, `web/`, and `mcp/` — depend on `"@mindvault/registry-client": "workspace:*"`. This ensures every package uses the same generated types and the same network defaults.

After the vault-registry contract is redeployed (e.g., to add the `list` method), regenerate the bindings from the repo root:

```bash
pnpm contract:bindings
```

Commit the updated `packages/registry-client/src/generated/index.ts` so all consumers pick up the new ABI in the same PR.

---

## Further reading

- [x402 protocol spec](https://www.x402.org/)
- [x402 buy/pay sequence diagram](x402-sequence-diagram.md) — step-by-step walkthrough of the payment flow
- [Soroban contract source](../contract/contracts/vault-registry/)
- [Reconciliation runbook](reconciliation.md) — detecting drift between the server DB and the on-chain registry
- [Owner index repair ADR](index-repair.md) — repairing the on-chain pagination index if it drifts from `Resource` storage
- [Tag index repair design](tag-index-repair-design.md) — the repair contract a future on-chain tag index must satisfy
- [Creator-signed registration flow](creator-signed-registration-flow.md)
