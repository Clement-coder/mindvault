# ADR: Registry-Level Fee / Royalty Configuration

| Field       | Value                                                        |
| ----------- | ------------------------------------------------------------ |
| **Status**  | Accepted                                                     |
| **Date**    | 2026-07-28                                                   |
| **Issue**   | [#386](https://github.com/mind-vault-1/mindvault/issues/386) |
| **Authors** | retkatmun                                                    |

---

## Context

MindVault uses the x402 protocol for resource access payments. USDC flows
directly from buyer to creator; the `vault-registry` contract is the on-chain
source of truth for _what_ exists, _who_ owns it, and _what it costs_ — but it
currently has no concept of a platform fee or creator royalty.

As the platform grows, two operational needs arise:

1. **Platform sustainability** — the platform operator needs a configurable cut
   of each sale to cover infrastructure and curation costs.
2. **Creator royalties** — secondary-market sales (resale of access rights,
   future marketplace integrations) may entitle the original creator to a
   royalty on top of the base price.

Both needs boil down to the same question: _what percentage of each purchase
price is split away from the creator's base payout, and to whom?_

This ADR decides where that configuration lives, what its schema looks like,
how it is validated on-chain, and what invariants the contract enforces.

---

## Decision Drivers

- **Single source of truth.** Off-chain settlement (x402 facilitator, future
  settlement contracts) should be able to read the current split from the
  registry without trusting a separate config API.
- **No custody.** The registry does not hold USDC. It only _describes_ the
  agreed split; the actual movement of funds remains off-chain.
- **Hard bounds enforced on-chain.** The contract must prevent misconfiguration
  that would route more than 50 % of a purchase price away from the creator.
- **Auditability.** Every change to the fee config must be observable on-chain
  via events, so indexers can reconstruct the full history.
- **Minimal surface.** No per-resource overrides in v1. One global config is
  sufficient for the current trust model and can be extended later.

---

## Options Evaluated

### Option A: Off-Chain Config Only

Store fee percentages in server environment variables. Off-chain settlement
reads them from config, not from the chain.

| Dimension        | Assessment                                                  |
| ---------------- | ----------------------------------------------------------- |
| Simplicity       | ✅ Zero contract changes                                    |
| Trust            | ❌ No on-chain verifiability — buyers must trust the server |
| Auditability     | ❌ No on-chain event trail                                  |
| Agent automation | ❌ Agents cannot verify fees without trusting the API       |

**Rejected.** Breaks the "on-chain source of truth" property. Buyers and AI
agents cannot independently verify the fee split.

---

### Option B: Per-Resource Fee Fields on `Resource`

Add `platform_fee_bps` and `royalty_bps` fields to the `Resource` struct so
each creator can set their own fee rate independently.

| Dimension     | Assessment                                                                   |
| ------------- | ---------------------------------------------------------------------------- |
| Flexibility   | ✅ Per-resource granularity                                                  |
| Schema impact | ❌ Adds two fields to every `Resource` (storage cost scales with count)      |
| Complexity    | ❌ Fee bounds must be validated on every `register`/`set_price` call         |
| UX            | ❌ Creator must understand and set fee fields — unexpected default behaviour |
| Current need  | ❌ No current use case requires per-resource fee overrides                   |

**Rejected for v1.** The feature request is for registry-level policy, not
per-resource overrides. This option can be revisited as a future extension
if creator-specified royalties become a product requirement.

---

### Option C: Singleton Registry-Level Config (Chosen)

Store a single `FeeConfig` struct in contract instance storage under a new
`DataKey::FeeConfig` key. Only the admin can set it. All off-chain settlement
reads this one entry.

| Dimension          | Assessment                                                          |
| ------------------ | ------------------------------------------------------------------- |
| On-chain truth     | ✅ Verifiable by anyone who can read the contract                   |
| Auditability       | ✅ `setfee` event carries old and new config                        |
| Storage cost       | ✅ One instance entry — O(1) regardless of resource count           |
| Bounds enforcement | ✅ Hard 50 % ceiling on individual fields and their sum             |
| Flexibility        | ✅ Per-resource overrides can be added later without breaking this  |
| Breaking change    | ✅ None — `Resource` schema unchanged, no existing callers affected |

**Accepted.**

---

## Implementation

### `FeeConfig` struct

```rust
pub struct FeeConfig {
    /// Platform cut in basis points (0–MAX_FEE_BPS).
    pub platform_fee_bps: u32,
    /// Creator royalty in basis points (0–MAX_FEE_BPS).
    pub royalty_bps: u32,
    /// Address to which the platform fee should be routed.
    /// None means no platform fee is collected regardless of platform_fee_bps.
    pub fee_recipient: Option<Address>,
}
```

### Storage key

`DataKey::FeeConfig` — an instance-storage entry (single value, no fan-out).
Instance storage is appropriate because fee config is a registry-global setting
with the same TTL characteristics as `DataKey::Admin`.

### Validation rules (enforced by `set_fee_config`)

| Rule                                           | Error returned    |
| ---------------------------------------------- | ----------------- |
| `platform_fee_bps > MAX_FEE_BPS`               | `FeeBpsTooHigh`   |
| `royalty_bps > MAX_FEE_BPS`                    | `FeeBpsTooHigh`   |
| `platform_fee_bps + royalty_bps > MAX_FEE_BPS` | `TotalFeeTooHigh` |

Individual bounds are checked before the sum so callers receive the more
specific error when a single field is out of range.

`MAX_FEE_BPS = 5_000` (50 %). This ensures a creator always receives at least
50 % of the sale price even in the worst-case configuration.

### Constants

```rust
pub const MAX_FEE_BPS: u32  = 5_000;   // 50 % ceiling
pub const FEE_BPS_DENOM: u32 = 10_000; // basis-point denominator
```

`FEE_BPS_DENOM` is exported so off-chain code that computes
`amount * fee_bps / FEE_BPS_DENOM` can share the denominator constant rather
than hardcoding `10_000`.

### Public API

| Function                 | Auth  | Description                                           |
| ------------------------ | ----- | ----------------------------------------------------- |
| `set_fee_config(config)` | admin | Validate bounds, store config, emit `setfee` event.   |
| `get_fee_config()`       | —     | Return `Option<FeeConfig>` — `None` before first set. |

### Event: `setfee`

```rust
pub struct FeeConfigUpdated {
    pub old_config: Option<FeeConfig>, // None on first set
    pub new_config: FeeConfig,
}
```

Topic: `(symbol_short!("setfee"),)`.
Payload: `FeeConfigUpdated`.

The event carries the complete previous config (not just a diff) so indexers
can reconstruct the full audit trail from events alone.

---

## Consequences

### Positive

- Buyers and AI agents can verify the platform fee split on-chain with a single
  `get_fee_config()` read, without trusting the API.
- The admin can update the fee config at any time; every change is publicly
  logged via the `setfee` event.
- The 50 % hard ceiling is enforced by the contract — no off-chain misconfiguration
  can route more than half of a sale away from the creator.
- Zero impact on existing callers: `Resource` schema unchanged, existing
  `register` / `set_price` / `get` / `list` paths are unmodified.

### Negative / Limitations

- This is a _metadata_ contract — it records the agreed split but does not
  enforce it at settlement time. Off-chain settlement code (x402 facilitator
  or a future settlement contract) is still responsible for reading and applying
  the config when distributing USDC.
- All resources share the same fee config. Per-resource overrides are not
  supported in v1.
- `fee_recipient` is optional; if `None`, the contract does not specify where
  the platform fee goes. Off-chain settlement should treat `None` as "no
  platform fee collected."

### Future extensions

- Per-resource `royalty_bps` override (stored on `Resource`) for creator-set
  royalties — can be added without changing `FeeConfig`.
- A `FeeConfigHistory` query that replays past `setfee` events for the current
  effective config at any given ledger sequence.
- Integration with a settlement contract that reads `get_fee_config()` and
  applies the split atomically in a single Soroban transaction.

---

## Accrued-Fee Guard (#985)

### Problem

Because the registry is a metadata contract (it describes the fee split but
does not custody USDC), the actual token movement happens off-chain via the
x402 facilitator. When `settle_payment` transitions a receipt to `Settled`,
the facilitator has already routed the platform-fee portion to the configured
`fee_recipient`. If the admin then rotates the `fee_recipient` (or changes the
`fee_destination`) _before_ the current recipient has confirmed receipt of
those funds, the accrued fees become unreachable — the old recipient no longer
has a claim, and the new recipient never received them.

### Solution

The contract now **tracks accrued platform fees** in instance storage
(`DataKey::AccruedFees`, an `i128` USDC-stroops counter). Every
`settle_payment` call adds `amount * platform_fee_bps / FEE_BPS_DENOM` to the
counter (only when `platform_fee_bps > 0` and `fee_recipient` is set).

**Guard**: `set_fee_config` (when `fee_recipient` changes), `set_fee_recipient`,
and `set_fee_destination` all call `require_no_unclaimed_fees()` before
mutating state. If `AccruedFees > 0`, the call reverts with `UnclaimedFees`
(error 51).

**Safe migration path**: The admin calls `claim_fees()` to acknowledge that
the current fee recipient has received all outstanding amounts. This resets
`AccruedFees` to 0 and emits a `claimfee` event. After claiming, the
configuration change can proceed.

The read-only `get_accrued_fees()` lets off-chain indexers and the MCP layer
display the outstanding balance so operators know when a claim is needed
before rotating.

### New API

| Function | Auth | Description |
| --- | --- | --- |
| `claim_fees()` | admin | Reset accrued fees to 0, emit `claimfee`, return claimed amount. |
| `get_accrued_fees()` | — | Read the current accrued-fee balance. |

### New error

| Code | Name | Description |
| --- | --- | --- |
| 51 | `UnclaimedFees` | Fee-recipient/destination change blocked because accrued fees > 0. |

### New event

| Topic | Payload | When |
| --- | --- | --- |
| `claimfee` | `FeesClaimed { claimed_amount, remaining_amount }` | `claim_fees()` succeeds |

---

## References

- [Issue #386 — Add royalty or platform fee configuration design](https://github.com/mind-vault-1/mindvault/issues/386)
- `contract/contracts/vault-registry/src/lib.rs` — implementation
- `contract/contracts/vault-registry/src/test.rs` — fee config tests
- `contract/README.md` — updated API reference table
