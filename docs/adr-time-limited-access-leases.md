# ADR: Time-Limited Access Leases for MindVault

| Field       | Value                                                        |
| ----------- | ------------------------------------------------------------ |
| **Status**  | Proposed                                                     |
| **Date**    | 2026-06-25                                                   |
| **Issue**   | [#179](https://github.com/mind-vault-1/mindvault/issues/179) |
| **Authors** | thefifthdev                                                  |

---

## Context

MindVault charges for resource access **per request**. Every `GET /resources/:id` runs through the `dynamicPaywall` middleware (`server/src/middleware/dynamicPaywall.ts`), which returns an HTTP 402, the buyer signs a USDC authorization, and the server settles via the x402 facilitator before delivering the resource. USDC moves **directly from buyer to creator** — MindVault never custodies funds and keeps no per-buyer access state. The `README.md` "What Is Not Yet Built" list explicitly calls this out: _"Recurring access or time-limited leases (currently per-request)."_

This is simple and trustless, but it is a poor fit for two real usage patterns:

- **Repeat human access.** A buyer who wants to read a resource several times over a day pays every time.
- **AI-agent workloads.** An agent polling or re-fetching a dataset across a task pays per call, which is both expensive and slow (a 402 round-trip and a signature per request).

A **time-limited access lease** lets a buyer pay once for _windowed_ access (e.g. 24 hours of unlimited reads of a resource) instead of paying per request. This ADR is a **design spike**: it defines lease semantics, evaluates where lease state should live (on-chain, off-chain, or hybrid), identifies the API and paywall changes required, describes the migration path from per-request access, and lists follow-up implementation issues. **No implementation is included.**

---

## Current Payment Flow

```
Buyer → GET /resources/:id → dynamicPaywall → 402 (price, payTo=creator)
Buyer → sign USDC auth entry → retry with X-Payment header
Server → paymentMiddleware → facilitator.verify() → facilitator.settle() → USDC: buyer → creator
Server → record payments row → deliver resource (link url or file stream)
```

**Key properties** (see `server/src/middleware/dynamicPaywall.ts` and `server/src/routes/resources.ts:191-251`):

- No intermediary custody — USDC goes directly to the creator wallet.
- Price is validated against the on-chain `vault-registry` contract before charging.
- Settlement is atomic and final; one payment buys exactly one delivery.
- The server is **stateless for access** — it writes a `payments` audit row but never grants a reusable, time-bounded entitlement.

The on-chain `vault-registry` contract (`contract/contracts/vault-registry/src/lib.rs`) is a **metadata/ownership registry only** — it has no concept of buyers, access, or expiry. It does, however, already manage time-bounded persistent state via TTL bumps (`DAY_IN_LEDGERS`, `BUMP_AMOUNT`, ~30-day extends), which is a useful precedent for any expiry mechanism.

---

## Lease Semantics

A lease is an entitlement: _"address `X` may access resource `R` until time `T`."_ The spike fixes the following semantics regardless of where state is stored.

**Creation**

- A buyer (human or agent) requests a lease for a resource for a chosen duration (e.g. 1h / 24h / 7d), bounded by a per-resource policy.
- Price is `base_price × duration_multiplier`, with the base price still read from the `vault-registry` (same validation path the paywall already uses). The duration tiers and multipliers are creator-configurable, defaulting to a platform policy.
- Payment uses the **existing x402 `exact` scheme** — the only change is what the payment buys (a window) rather than a single delivery. USDC still settles buyer → creator directly.
- On successful settlement the server records a lease keyed by `(resourceId, holderAddress)` with `expiresAt`.

**Validation**

- On each `GET /resources/:id`, the paywall first checks for an **active, non-revoked lease** for the caller's address. If one exists, access is granted with **no 402** and no new payment.
- Caller identity is the Stellar address. For agents this is their wallet; the request must prove control of that address. Two practical options: (a) reuse the x402 `X-Payment`/auth proof as an identity signal, or (b) issue a short opaque **lease token** at creation that the client presents on subsequent reads (simpler, avoids a signature per read). The spike recommends (b) — see Recommendation.
- If no active lease exists, the paywall falls back to the **current per-request 402 flow** unchanged.

**Expiry**

- A lease is valid while `now < expiresAt`. Expiry is purely time-based; no renewal is automatic. Expired leases stop granting access immediately and are swept by a background worker (mirroring the existing `server/src/workers/retryPendingWorker.ts` pattern).
- Off-chain, `expiresAt` is a timestamp column; on-chain, expiry is expressed in ledger sequence numbers (as the registry's TTL logic already does).

**Revocation**

- The **creator** may revoke active leases on their resource (e.g. content withdrawn, abuse). The buyer keeps no refund right by default (consistent with [the refund ADR](adr-refund-escrow-mechanism.md), which handles disputes separately).
- The **platform** may revoke for policy/abuse.
- Revocation sets `revokedAt`; validation treats a revoked lease as inactive even before `expiresAt`. Revocation must be cheap and immediate — a strong argument for off-chain or hybrid state (an on-chain-only lease cannot be revoked without a contract write per lease).

---

## Options Evaluated

The core decision is **where lease state lives**. Semantics above are identical across options; only enforcement, cost, and trust differ.

### Option A: Off-Chain Lease Table (server-authoritative)

**How it works:** Leases are rows in Postgres. Payment settles via x402 exactly as today; the server records the lease and a lease token, and the paywall checks the table before charging.

```
Buyer → POST /resources/:id/leases { duration } → 402 (price × multiplier)
Buyer → sign USDC auth → retry → settle (buyer → creator)
Server → INSERT lease(resourceId, holder, expiresAt, token)
Buyer → GET /resources/:id  (Authorization: Lease <token>)
Server → paywall: active lease? → deliver, no 402
```

**DB schema (sketch):**

```sql
CREATE TABLE leases (
  id             TEXT PRIMARY KEY,
  resource_id    TEXT NOT NULL REFERENCES resources(id),
  holder_address TEXT NOT NULL,
  token_hash     TEXT NOT NULL,          -- sha256 of opaque lease token
  amount         TEXT NOT NULL,
  payment_tx     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX leases_lookup ON leases (resource_id, holder_address);
```

| Dimension       | Assessment                                                          |
| --------------- | ------------------------------------------------------------------- |
| Buyer/agent UX  | ✅ Best — one payment, then plain GETs with a token                 |
| Revocation      | ✅ Immediate — a single UPDATE                                      |
| Implementation  | ✅ Low — new table, route, middleware branch; no contract work      |
| Trustlessness   | ❌ Server is authoritative; a client cannot verify a lease on-chain |
| Stellar/Soroban | ✅ No contract changes                                              |

**x402 implications:** Zero changes to the settlement path — the lease purchase is just an x402 payment whose receipt the server interprets as a window rather than a single delivery.

---

### Option B: On-Chain Lease Contract (trustless)

**How it works:** Deploy a `vault-leases` Soroban contract. A lease purchase calls the contract, which records `(resource_id, holder) → expiry_ledger` in persistent storage. Anyone — including a third-party gateway — can verify a lease directly from Soroban RPC.

**Contract interface (sketch):**

```rust
pub fn buy_lease(env: Env, holder: Address, resource_id: String, ledgers: u32) // holder.require_auth()
pub fn is_active(env: Env, holder: Address, resource_id: String) -> bool
pub fn revoke(env: Env, creator: Address, resource_id: String, holder: Address) // creator.require_auth()
pub fn get_lease(env: Env, holder: Address, resource_id: String) -> LeaseState
```

```
DEPOSITED(expiry_ledger) → (ledger > expiry) → EXPIRED
DEPOSITED → (creator revoke) → REVOKED
```

| Dimension       | Assessment                                                                      |
| --------------- | ------------------------------------------------------------------------------- |
| Buyer/agent UX  | ⚠️ Each lease purchase is a contract invocation                                 |
| Revocation      | ⚠️ Possible but costs a contract write per revoke                               |
| Implementation  | ❌ High — new contract, USDC SAC integration, TTL/expiry, tests                 |
| Trustlessness   | ✅ Maximum — verifiable without trusting the MindVault server                   |
| Stellar/Soroban | ⚠️ Persistent-storage TTL management; USDC settlement into/through the contract |

**Stellar/Soroban constraints:**

- Expiry is naturally expressed in ledger sequences; reuse the registry's `extend_ttl` precedent.
- Routing USDC through the contract requires it to hold a USDC trustline (SAC balance) or to verify a direct buyer→creator transfer, the same tension surfaced in the [refund/escrow ADR](adr-refund-escrow-mechanism.md) Option B.
- `require_auth` cleanly enforces "only holder buys" and "only creator revokes."

---

### Option C: Hybrid — Off-Chain Leases with Optional On-Chain Anchor

**How it works:** Start with Option A's off-chain table as the source of truth for enforcement, but **anchor** a lease commitment (a hash of `(resource_id, holder, expiry)`) into the on-chain registry `metadata` or an events log at purchase time. The server enforces; the chain provides an auditable, tamper-evident record.

| Dimension       | Assessment                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| Buyer/agent UX  | ✅ Same as Option A for reads                                                |
| Revocation      | ✅ Immediate off-chain; anchor is advisory                                   |
| Implementation  | ⚠️ Medium — Option A plus an anchoring step                                  |
| Trustlessness   | ⚠️ Partial — verifiable that a lease existed, not that it is currently valid |
| Stellar/Soroban | ✅ Minimal — reuses existing registry write paths                            |

**x402 implications:** Same as Option A; the anchor is an extra, non-blocking write.

---

## Comparison Matrix

| Criterion                 | A: Off-Chain | B: On-Chain | C: Hybrid |
| ------------------------- | :----------: | :---------: | :-------: |
| Agent/buyer read UX       |      ✅      |     ⚠️      |    ✅     |
| Immediate revocation      |      ✅      |     ⚠️      |    ✅     |
| Implementation complexity |      ✅      |     ❌      |    ⚠️     |
| On-chain changes          |      ✅      |     ❌      |    ⚠️     |
| x402 compatibility        |      ✅      |     ⚠️      |    ✅     |
| Trustlessness             |      ❌      |     ✅      |    ⚠️     |
| Cost per lease            |      ✅      |     ❌      |    ⚠️     |

---

## Recommendation

**Short-term (next milestone): Option A — Off-Chain Lease Table.**

It delivers the actual user value (pay once, read many within a window) with the lowest risk:

- **Zero changes** to the x402 settlement path or the Soroban contracts.
- Best UX for the primary beneficiary — AI agents — because subsequent reads are plain GETs with a lease token, no signature or 402 per call.
- Immediate, cheap revocation for creators and platform.
- Implementable entirely inside the `server` package.

Use an **opaque lease token** (returned once at purchase, stored hashed) for read-time identity rather than requiring a fresh signature per read — this is what makes the agent workflow cheap.

**Medium-term (future milestone): Option C — add an on-chain anchor.**

Once leases are proven, anchoring lease commitments on-chain gives buyers and third-party gateways an auditable record without paying the full cost of Option B. A move to fully on-chain leases (Option B) is only justified if a trustless third-party access gateway becomes a requirement.

---

## Migration Path from Per-Request Access

Leases are **additive and backward-compatible** — per-request access remains the default and is never removed.

1. **Ship dormant.** Add the `leases` table and routes behind a feature flag / per-resource opt-in. With no leases issued, behavior is identical to today.
2. **Paywall short-circuit.** `dynamicPaywall` gains a single pre-check: _if the caller holds an active, non-revoked lease, skip the 402 and deliver._ Otherwise the existing per-request flow runs unchanged — so a resource with no lease support, or a caller with no lease, behaves exactly as before.
3. **Opt-in per resource.** Creators enable lease tiers per resource; resources without tiers stay per-request only.
4. **Clients upgrade lazily.** Existing buyers and agents keep using per-request access; only clients that call the new lease endpoint get windowed access. No breaking change to `GET /resources/:id`.
5. **Observability.** Reuse the `payments` audit trail; lease purchases also write a `payments` row so existing analytics keep working, plus a `leases` row for entitlement.

Rollback is trivial: disable the flag / remove lease tiers and the paywall pre-check finds no active leases, reverting to pure per-request behavior.

---

## Recommended Follow-Up Issues

1. **`feat: add leases table and lease purchase API (Option A)`**
   - Add a `leases` table via a Drizzle migration in `server/drizzle/`.
   - Add `POST /resources/:id/leases` (x402-priced by duration) and `GET /resources/:id/leases/me` in a new `server/src/routes/leases.ts`, registered in `server/src/app.ts`.
   - Add a `leaseService` in `server/src/services/` and request schemas in `server/src/schemas/requests.ts`.

2. **`feat: lease-aware paywall short-circuit`**
   - Extend `server/src/middleware/dynamicPaywall.ts` to grant access on a valid lease token before issuing a 402, with the existing per-request flow as fallback.
   - Define the opaque lease-token format and the `Authorization: Lease <token>` read path.

3. **`feat: lease expiry sweeper + creator revocation`**
   - Background worker to mark expired leases (mirror `server/src/workers/retryPendingWorker.ts`).
   - `POST /resources/:id/leases/:holder/revoke` (creator-auth) and platform revocation.

4. **`feat: MCP lease tools`**
   - Add `mindvault_buy_lease` and `mindvault_lease_status` to `mcp/src/index.ts` and the README tool table, so agents can buy windowed access.

5. **`docs: document access leases`**
   - Update `README.md` (move leases out of "What Is Not Yet Built"), `docs/api-examples.md`, and `docs/x402-sequence-diagram.md` with the lease flow.

6. **`spike: on-chain lease anchor (Option C)`**
   - Design the anchor payload and the registry/events write path; evaluate promotion to a full `vault-leases` contract (Option B).

---

## Implementation status

The on-chain half of Option C now exists in `vault-registry` (see
[`contract/README.md`](../contract/README.md#time-limited-access-leases)): a
`Lease` record per `(resource_id, holder)` with `start_ledger`,
`expiry_ledger`, `tier` and `state`, written by `buy_lease` (holder, `Pending`)
or `record_lease` (settler, `Active`), promoted by `settle_lease`, revoked by
the creator with `revoke_lease`, and read with `get_lease`, `lease_is_active`
and `lease_price`. Tier durations and price multipliers are platform defaults
(`LEASE_*_LEDGERS`, `LEASE_*_MULTIPLIER`); creator-configurable tiers remain a
follow-up. The MCP server buys and inspects leases with `mindvault_buy_lease`
and `mindvault_lease_status`: the agent pays the creator in USDC directly, then
records the lease on-chain with the payment hash. The off-chain lease table,
the paywall short-circuit and the expiry sweeper (follow-ups 1 to 3) are still
open.

## References

- [x402 protocol spec](https://www.x402.org/)
- [x402 payment sequence diagram](x402-sequence-diagram.md)
- [Refund and escrow ADR](adr-refund-escrow-mechanism.md)
- [MindVault architecture](architecture.md)
- [Resource publish lifecycle](resource-publish-lifecycle.md)
- [dynamic paywall middleware](../server/src/middleware/dynamicPaywall.ts)
- [vault-registry contract source](../contract/contracts/vault-registry/src/lib.rs)
- [Soroban SDK — persisting data](https://soroban.stellar.org/docs/learn/persisting-data)
