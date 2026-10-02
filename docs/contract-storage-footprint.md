# Contract storage footprint report

`vault-registry` writes to Soroban's persistent and instance storage on almost
every call. Soroban charges rent per ledger entry and archives entries whose
TTL lapses, so the _shape_ of what the contract stores is an operational cost
that outlives any single transaction — and, unlike WASM size, nothing in CI
measured it.

This report is generated and enforced by the `storage_footprint_report` test in
[`contract/contracts/vault-registry/src/test.rs`](../contract/contracts/vault-registry/src/test.rs).
Contract CI runs the same report explicitly through `make footprint`, so
storage growth fails unless the budget and this report are updated together.

## Running it

```bash
cd contract/contracts/vault-registry && make footprint
# or, from contract/:
cargo test storage_footprint_report -- --nocapture
```

The test builds one registry containing a resource at every documented maximum
(24-byte id, 512-byte metadata pointer, 8 tags of 32 bytes, 128-byte content
hash, `MAX_PRICE`), one ordinary resource, and one instance of every other
entry class the contract can write. It then prints the table below and asserts
each entry stays within its budget.

## What is measured

Each row is the XDR-encoded length of the entry's **key** plus its **value** —
the portion of a ledger entry the contract itself determines. A live ledger
entry carries additional host-side envelope and TTL metadata, so treat these
numbers as a floor for rent estimation and, more usefully, as a stable
baseline for comparing one revision of the contract against another.

## Current footprint

| Entry                      | Map        | Key | Value | Total | Budget |
| -------------------------- | ---------- | --: | ----: | ----: | -----: |
| Resource (max-size)        | persistent |  60 |  1552 |  1612 |   1700 |
| Resource (typical)         | persistent |  48 |   592 |   640 |    640 |
| Index(u32) -> id           | persistent |  36 |    32 |    68 |     96 |
| Count                      | instance   |  28 |     8 |    36 |     48 |
| TagCount (max-size tag)    | instance   |  68 |     8 |    76 |    160 |
| TopTags                    | instance   |  28 |  1772 |  1800 |   2000 |
| CreatorResources           | persistent |  76 |    64 |   140 |    160 |
| CreatorCount               | instance   |  72 |     8 |    80 |     96 |
| TagIndex (max-size tag)    | persistent |  68 |    44 |   112 |    160 |
| CreatorTerms               | persistent |  72 |    72 |   144 |    200 |
| PaymentReceipt             | persistent | 108 |   496 |   604 |    640 |
| PaymentIndex -> receipt id | persistent | 104 |    72 |   176 |    240 |
| PurchaseReceipt (anchor)   | persistent | 108 |   300 |   408 |    480 |
| AnchorAttempts             | persistent | 108 |    72 |   180 |    200 |
| Lease (max-size)           | persistent | 100 |   460 |   560 |    640 |
| FlagReasonHash             | persistent |  68 |    72 |   140 |    200 |
| FlagModerator              | persistent |  68 |    40 |   108 |    160 |
| AttestationHash            | persistent |  56 |    80 |   136 |    160 |
| FeeConfig                  | instance   |  32 |   136 |   168 |    192 |
| FeeDestination             | instance   |  36 |    76 |   112 |    192 |
| Admin                      | instance   |  28 |    40 |    68 |     80 |
| Verifier grant             | instance   |  68 |     8 |    76 |     96 |
| Moderator grant            | instance   |  72 |     8 |    80 |     96 |
| Settler grant              | instance   |  68 |     8 |    76 |     96 |
| Paused flag                | instance   |  28 |     8 |    36 |     48 |
| Pause deadline             | instance   |  32 |    12 |    44 |     64 |

Aggregates, which are the numbers that scale with usage:

| Operation                                                                          | Bytes | Budget |
| ---------------------------------------------------------------------------------- | ----: | -----: |
| One max-size registration (`Resource` + `Index` + one `TagIndex` + one `TagCount`) |  1868 |   1900 |
| One payment (`PaymentReceipt` + `PaymentIndex`)                                    |   780 |    850 |

A registration with all 8 tags writes 8 `TagIndex` and 8 `TagCount` entries, one
per tag, plus the `CreatorResources` and `CreatorCount` updates — the aggregate
above counts one of each so the per-tag cost stays visible. `TopTags` is a
shared bounded view and is not included in the per-registration aggregate.

## Notes on individual entries

- **`AnchorAttempts`** is written only when `attempt_anchor_purchase_receipt`
  rejects an anchor, holds two `u32`s, and is deleted as soon as an anchor is
  written for the pair, so it never outlives a successful settlement.
- **`Lease (max-size)`** is one time-limited access lease keyed by
  `(resource_id, holder)`. The 128-byte `tx_hash` dominates the value; a
  holder holds at most one lease per resource, and a new purchase overwrites
  an expired or revoked one rather than adding an entry.

- **`Resource`** dominates the per-registration cost, and `metadata` (up to 512
  bytes) dominates `Resource`. Storing a content pointer rather than content is
  what keeps this bounded; raising `MAX_METADATA_POINTER_LEN` moves this row
  roughly one-for-one.
- **`CreatorResources` and `TagIndex`** hold `Vec<String>` collections, so they
  grow with membership rather than having a fixed maximum. The rows above are
  measured at this fixture's cardinality (two resources for the creator, one
  resource per tag); read them as a per-member baseline. Each additional member
  adds roughly one id's worth of bytes.
- **Instance entries** (`Count`, `CreatorCount`, `FeeConfig`, `FeeDestination`, `Admin`, and the
  three role grants) share the contract's instance TTL, so they are bumped
  together and never archive independently. They are all small; `CreatorCount`
  is the only one that grows with the number of distinct creators.
- **`FlagModerator`** holds a single `Address`: the moderator whose
  `flag_resource`, `unflag_resource`, or `set_flag_reason_hash` came last,
  read back by `flag_details`. It is one entry per moderated resource and is
  overwritten in place, so it never grows.
- **`DataKey::DisputeFlag` is never written.** The dispute flag lives on the
  `Resource` struct (see `flag_resource`), so the key exists in the `DataKey`
  enum without a corresponding entry.
- **Tombstoning** frees the `TagIndex` and `CreatorResources` membership for a
  resource (see the lifecycle section of
  [`contract/README.md`](../contract/README.md)), but deliberately leaves
  `Resource`, `Index`, and `Count` in place for auditability — a retired
  resource keeps its ~1.5 KB `Resource` entry.

## Changing the numbers

The budgets are deliberately close to the measured values (roughly 10 %
headroom), so a change that widens a stored struct fails the test rather than
quietly raising rent. When growth is intended:

1. Run the report and read the new numbers.
2. Raise the affected budget in `storage_footprint_report`.
3. Update the tables in this document to match.

Related: [`contract-upgrade-checklist.md`](contract-upgrade-checklist.md) for
the deployment steps a storage-shape change implies, and the WASM size budget
in
[`contract/contracts/vault-registry/Makefile`](../contract/contracts/vault-registry/Makefile),
which covers code size rather than storage.
