# ADR: Owner Index Repair Strategy

**Status:** Accepted — implemented in `repair_index` (see
[`contract/contracts/vault-registry/src/lib.rs`](../contract/contracts/vault-registry/src/lib.rs)).

## Context

`vault-registry` keeps two kinds of storage:

- **Canonical**: `DataKey::Resource(id) -> Resource`, addressable directly by
  id. This is never touched by anything except `register` and the
  creator-authorized mutation methods (`set_price`, `update_metadata`,
  `set_tags`, `set_listed`, `freeze_metadata`, ownership transfers, and — via
  the verifier role — `set_verification_status`).
- **Derived**: `DataKey::Count -> u32` and `DataKey::Index(u32) -> id`, an
  insertion-ordered array used only so `list`/`list_page`/`list_listed` can
  page through resources without on-chain enumeration (Soroban has no "list
  all keys" primitive). `list_by_creator` has its own, separate derived
  index (`DataKey::CreatorResources`/`CreatorCount`) built the same way and
  subject to the same class of risk, though this ADR focuses on the
  `Index`/`Count` pair since that's what `list`/`count` — the primary
  chain-native catalog primitive — depend on.

`register` writes to both in sequence: it sets `Resource(id)`, then
`Index(count)`, then bumps `Count`. Nothing atomically ties these three
writes together beyond being in the same transaction — if a future migration
changes the indexing scheme, or client code calls into the derived keys
directly, or a code path writes `Resource` without going through `register`,
the two can drift: gaps (`Index(i)` pointing at a deleted/renamed id),
duplicates (two indices pointing at the same id), or an out-of-sync `Count`.
When that happens, `list()`/`list_page()`/`count()` — the only chain-native
way to build a catalog without trusting the server — become wrong or
incomplete, even though every `Resource` entry is still individually correct
and reachable via `get(id)`.

Because Soroban contracts cannot enumerate their own storage keys, the
contract itself has no way to detect "all resource ids that exist" and
rebuild `Index`/`Count` from scratch. Any repair has to be told the correct
id list by something outside the contract.

## Decision

Add a single admin-gated method:

```rust
pub fn repair_index(env: Env, ids: Vec<String>) -> Result<(), Error>
```

- **Authorization**: admin-only, using the same admin established by
  `nominate_new_admin`/`accept_admin` (see
  [`architecture.md`](architecture.md#roles-admin-and-verifier)). Errors
  `AdminNotSet` if no admin has ever been set. `repair_index` cannot be
  called by a verifier — repairing the index is a structural/integrity
  operation, not a content-verification one, so it stays scoped to the same
  role that already governs verifier grants.
- **Input**: an explicit, ordered `Vec<String>` of resource ids, sourced
  off-chain by the operator. In practice this list comes from one of:
  - replaying `register`/`transfer`/`accept_transfer` events from the
    Soroban RPC/indexer,
  - the existing `pnpm reconcile` script's "missing in DB" / "missing
    on-chain" report (see [`reconciliation.md`](reconciliation.md)), cross-
    checked against the DB's own resource list,
  - a last-known-good snapshot of `list`/`list_page` output taken before the
    drift was introduced.
- **Validation**: every id in the input must already exist as a `Resource`
  (`NotFound` otherwise), and the input must not contain duplicates
  (`DuplicateInRepair` otherwise). Validation runs as a first pass over the
  whole input before any storage write, so a bad call fails atomically with
  no partial state change.
- **Effect**: `Index(0..ids.len())` is overwritten to match the given order,
  and `Count` is set to `ids.len()`. `Resource` entries are never read for
  their content, never written, and never deleted — repair only rewrites the
  derived pointers. An id omitted from the repair list simply becomes
  unreachable via `list`/`list_page`/`count` (it stays fully readable via
  `get(id)` and `exists(id)`); this is intentional, since the whole point of
  the derived index is enumeration, not existence.
- **Events**: `("reindex", old_count) -> new_count`, so operators (and
  off-chain audit tooling) can see when and how far a repair moved the count.

### Why this is safe

- **Idempotent**: re-running `repair_index` with the current correct id list
  is a no-op in effect — it just rewrites `Index`/`Count` to what they
  already were.
- **No canonical data loss**: because `Resource` storage is never touched, a
  bad repair (wrong order, wrong subset) can always be corrected by another
  `repair_index` call — nothing is destroyed, only the pagination view
  shifts.
- **Bounded blast radius**: repair cannot register, delete, or mutate a
  resource's price/metadata/tags/verification/ownership. Its only power is
  over the pagination index.
- **No stale-entry cleanup needed**: `list_page` bounds its scan by `Count`
  (`while i < total`), so `Index` slots beyond the new `Count` are simply
  never read again — they don't need to be explicitly cleared for
  correctness.

### What this does not solve

- It does not detect drift automatically. Operators still need to notice a
  problem (e.g. via `pnpm reconcile`, or `count()` disagreeing with an
  independent event replay) and supply the correct id list.
- It does not recover an id that has no surviving off-chain record at all —
  if no event log, DB row, or snapshot remembers a given id, `repair_index`
  can't reconstruct it (though `get(id)` still works if the id string itself
  is known).
- It does not repair the separate `CreatorResources`/`CreatorCount` index
  that backs `list_by_creator`/`creator_resource_count`. If that drifts
  independently, it would need its own repair method following the same
  pattern (admin-gated, authoritative id list, no `Resource` writes) — left
  as a follow-up since nothing currently exercises a path that could corrupt
  it.

## Tests

See `repair_index_*` tests in
[`contract/contracts/vault-registry/src/test.rs`](../contract/contracts/vault-registry/src/test.rs):
rebuilding from an authoritative list (including dropping an id from the
index while it stays readable via `get`), rejecting an unknown id with no
partial write, rejecting duplicate ids, requiring an admin first, and
re-running the current list as a safe no-op.

## Bounded continuation groundwork

The current `repair_index(ids)` remains the compatibility entry point and still
validates and writes the full supplied list in one transaction. The contract
now defines `INDEX_REPAIR_PAGE_CAP`, `IndexRepairProgress`, and
`IndexRepairPage` as the schema foundation for a bounded continuation API.
These types do not yet change runtime behavior or expose a new method. A live
continuation implementation must persist and enforce the returned cursor,
reject out-of-order/replayed pages, preserve duplicate detection across page
boundaries, and keep partially written indexes from appearing complete. Until
those guarantees are implemented, operators should continue using
`repair_index` only when the full list fits within transaction resource limits.
