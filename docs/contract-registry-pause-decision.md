# Vault registry: emergency pause decision

> **Status: superseded.** The registry now has an admin-controlled emergency
> pause (`set_paused`, `set_paused_until`). The published scope of that pause —
> the method-to-pause matrix — is in
> [`contract/README.md`](../contract/README.md#pause-scope-matrix). This
> document is kept as the original architecture spike for issue #109.

Issue #109 asked whether the `vault-registry` Soroban contract needs an
admin-controlled pause on write paths. This document records the architecture
spike and the decision **not** to implement pause in the contract at this time.

## Trust model (current)

The registry is a **public, creator-scoped catalog**:

- **Reads** (`get`, `exists`, `list`, `count`) are open to anyone — that is the
  product goal (transparent on-chain source of truth).
- **Writes** (`register`, `set_price`, `update_metadata`, `transfer_ownership`,
  `set_listed`, `delist`) require `creator.require_auth()` on the recorded owner.
  There is no platform admin key with override authority on-chain.
- **Payments** run through x402 + USDC SAC; they do not flow through this
  contract. Pausing registry writes would not stop settlement or content
  delivery paths that do not touch the contract.

The server is a convenience layer (unsigned XDR builder, API, reconciliation) but
is not required for reads; creators sign registration and updates directly.

## What pause would add

A typical pause design would introduce:

- Instance storage: `admin: Address`, `paused: bool`
- `init(admin)` or `set_admin` with `require_auth`
- `pause` / `unpause` with `require_auth(admin)`
- `assert!(!paused)` on every write path

That introduces a **new trusted party** (admin) with unilateral ability to freeze
all creator mutations globally. It is appropriate when the contract custodies funds,
enforces compliance gates, or must halt an active exploit in a single shared pool.

## Evaluation

| Criterion                  | Assessment                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Funds at risk in contract  | No — registry stores metadata only                                                                  |
| Need to halt payments      | No — payments are off-contract (x402)                                                               |
| Per-resource abuse         | Handled by creator auth + delist; no global kill switch needed                                      |
| Operational incident       | Worst case: bad entries remain readable; creators can delist; deploy new contract version if needed |
| Backward compatibility     | Admin + pause changes trust assumptions for integrators                                             |
| Complexity / audit surface | Non-trivial for marginal benefit in this trust model                                                |

## Alternatives considered

1. **Creator-only delist** (already shipped): owners can hide listings without
   platform intervention.
2. **Off-chain registry reads during incident**: API can stop building/registering
   txs without a contract upgrade.
3. **New contract deployment**: Stellar upgrades are contract-ID migrations;
   a breaking policy change is clearer as a new deployment than a hidden admin.

## Decision

**Do not implement on-chain pause/unpause** for `vault-registry` v1.

Rationale: the registry is a read-transparent index with per-creator write
authority. A global admin pause adds centralization and integration complexity
without protecting funds or payment flow. Incidents are better handled operationally
(server-side) or via a deliberate contract migration.

## Revisit if

- The contract begins custoding value or enforcing mandatory compliance hooks.
- A single shared admin is explicitly accepted in the product trust model.
- Testnet/mainnet incident data shows write-path abuse that delist cannot contain.
