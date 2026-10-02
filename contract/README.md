# MindVault Contracts (Soroban)

Soroban smart contracts for MindVault. Today there is one:

## `vault-registry`

An on-chain registry of vault resources. It is the transparent source of truth
for **what** exists in the vault, **who** owns it, and **what it costs** —
anyone can read it directly from the chain without trusting the MindVault API.

Payments themselves do **not** run through this contract. They continue to flow
through x402 and the USDC Stellar Asset Contract (see the root README). The
registry complements that: the server settles payment via x402, and records /
reads the canonical resource entry here.

### Resource type

| Function                                                               | Auth                  | Args                                                                                                                                                                                                                                                                   | Returns                   | Description                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `register(creator, id, price, metadata, tags)`                         | `creator`             | `creator: Address` — the resource owner; `id: String` — unique cuid2 (1–24 bytes); `price: i128` — USDC base units, 7 decimals (`> 0`, `<= MAX_PRICE`); `metadata: String` — pointer (max 512 bytes, non-empty, supported prefix); `tags: Vec<String>` — discovery labels (0–8 items) | `Result<(), Error>`       | Register a new resource. Resources are listed by default.                                                                                                                                                                                         |
| `register_with_hash(creator, id, price, metadata, tags, content_hash)` | `creator`             | `creator: Address`; `id: String`; `price: i128`; `metadata: String`; `tags: Vec<String>`; `content_hash: Option<String>` — optional content hash (max 128 bytes)                                                                                                       | `Result<(), Error>`       | Register a new resource with an optional immutable content hash.                                                                                                                                                                                  |
| `register_with_memo(creator, id, price, metadata, tags, content_hash, memo_hash)` | `creator`             | `creator: Address`; `id: String`; `price: i128`; `metadata: String`; `tags: Vec<String>`; `content_hash: Option<String>`; `memo_hash: Option<BytesN<32>>`                                                                                                              | `Result<(), Error>`       | Register a new resource with an optional content hash and an optional 32-byte memo hash (for example the `MEMO_HASH` of the announcing transaction). The memo hash is written once and has no setter; read it with `get_memo_hash`. Emits `register`, then `regmemo` when a memo hash was given. |
| `register_batch(creator, items)`                                       | `creator`             | `creator: Address`; `items: Vec<BatchRegisterItem>`; max 10 items, each `{ id, price, metadata, tags, content_hash }`                                                                                                                                                  | `Result<BatchRegisterResult, Error>` | Register up to 10 resources in one transaction under one creator. Errors `BatchTooLarge` above the cap; otherwise continues past per-item failures and reports the `succeeded` ids and the `failed` `(index, error_code)` pairs.                  |
| `set_price(id, new_price)`                                             | `creator`             | `id: String`; `new_price: i128` — USDC base units, 7 decimals (`> 0`, `<= MAX_PRICE`)                                                                                                                                                                                                 | `Result<(), Error>`       | Update the resource price.                                                                                                                                                                                                                        |     |
| `set_price_many(creator, updates)`                                     | `creator`             | `creator: Address`; `updates: Vec<BatchPriceUpdate>` — max 10 owned resources                                                                                                                                                                                          | `Result<(), Error>`       | Atomically update multiple prices after one creator authorization. Invalid input leaves all prices unchanged. Emits `setprice` for each changed resource.                                                                                       |
| `update_metadata(id, metadata)`                                        | `creator`             | `id: String`; `metadata: String` — new pointer (max 512 bytes, non-empty, supported prefix)                                                                                                                                                                            | `Result<(), Error>`       | Update the metadata pointer.                                                                                                                                                                                                                      |
| `set_tags(id, tags)`                                                   | `creator`             | `id: String`; `tags: Vec<String>` — replacement discovery labels (0–8 unique normalized items)                                                                                                                                                                         | `Result<(), Error>`       | Replace a resource's discovery tags. Does not touch `metadata`.                                                                                                                                                                                   |
| `transfer_ownership(id, new_creator)`                                  | `creator`             | `id: String`; `new_creator: Address`                                                                                                                                                                                                                                   | `Result<(), Error>`       | Immediately transfer resource ownership. Clears any pending proposed transfer.                                                                                                                                                                    |
| `propose_transfer(id, new_creator)`                                    | `creator`             | `id: String`; `new_creator: Address`                                                                                                                                                                                                                                   | `Result<(), Error>`       | Propose a transfer that `new_creator` must accept.                                                                                                                                                                                                |
| `accept_transfer(id)`                                                  | pending owner         | `id: String`                                                                                                                                                                                                                                                           | `Result<(), Error>`       | Accept a proposed transfer. Only the pending owner may call this.                                                                                                                                                                                 |
| `cancel_transfer(id)`                                                  | `creator`             | `id: String`                                                                                                                                                                                                                                                           | `Result<(), Error>`       | Cancel a proposed transfer.                                                                                                                                                                                                                       |
| `set_listed(id, listed)`                                               | `creator`             | `id: String`; `listed: bool`                                                                                                                                                                                                                                           | `Result<(), Error>`       | Set the listing state (`true` = listed, `false` = delisted).                                                                                                                                                                                      |
| `delist(id)`                                                           | `creator`             | `id: String`                                                                                                                                                                                                                                                           | `Result<(), Error>`       | Convenience; equivalent to `set_listed(id, false)`.                                                                                                                                                                                               |
| `list(start, limit)`                                                   | —                     | `start: u32` — 0‑based index; `limit: u32` — page size (capped at `LIST_PAGE_CAP` = 20)                                                                                                                                                                                | `Vec<Resource>`           | Paginated resource list in insertion order (body only; prefer `list_page` for cursors).                                                                                                                                                           |
| `list_page(cursor, limit)`                                             | —                     | `cursor: u32` — 0‑based catalog index; `limit: u32` — page size (capped at `LIST_PAGE_CAP` = 20)                                                                                                                                                                       | `CatalogPage`             | Paginated page with `items` + `next_cursor` (`None` = end-of-list).                                                                                                                                                                               |
| `list_listed(start, limit)`                                            | —                     | `start: u32`; `limit: u32` (capped at `LIST_PAGE_CAP` = 20)                                                                                                                                                                                                            | `Vec<Resource>`           | Paginated list of **listed-only** resources. Delisted resources are skipped; relisted resources reappear.                                                                                                                                         |
| `list_by_creator(creator, start, limit)`                               | —                     | `creator: Address`; `start: u32`; `limit: u32` (capped at `LIST_PAGE_CAP` = 20)                                                                                                                                                                                        | `Vec<Resource>`           | Paginated list of resources currently owned by `creator`.                                                                                                                                                                                         |
| `list(start, limit)`                                                   | —                     | `start: u32` — 0‑based index; `limit: u32` — page size (capped at 20)                                                                                                                                                                                                  | `Vec<Resource>`           | Paginated resource list in insertion order (body only; prefer `list_page` for cursors).                                                                                                                                                           |
| `list_page(cursor, limit)`                                             | —                     | `cursor: u32` — 0‑based catalog index; `limit: u32` — page size (capped at 20)                                                                                                                                                                                         | `CatalogPage`             | Paginated page with `items` + `next_cursor` (`None` = end-of-list).                                                                                                                                                                               |
| `list_listed(start, limit)`                                            | —                     | `start: u32`; `limit: u32` (capped at 20)                                                                                                                                                                                                                              | `Vec<Resource>`           | Paginated list of **listed-only** resources. Delisted resources are skipped; relisted resources reappear.                                                                                                                                         |
| `list_by_creator(creator, start, limit)`                               | —                     | `creator: Address`; `start: u32`; `limit: u32` (capped at 20)                                                                                                                                                                                                          | `Vec<Resource>`           | Paginated list of resources currently owned by `creator`.                                                                                                                                                                                         |
| `list_by_tag(tag, start, limit)`                                       | —                     | `tag: String` — matched case-insensitively; `start: u32`; `limit: u32` (capped at 20)                                                                                                                                                                                  | `Vec<Resource>`           | Paginated list of resources carrying `tag`, in index insertion order. Tag matching is case-insensitive.                                                                                                                                           |
| `top_tags(limit)`                                                      | —                     | `limit: u32` — capped at `TOP_TAGS_CAP` (20)                                                                                                                                                                                                                           | `Vec<TagPopularity>`      | Return tags ordered by descending successful-registration count, then lexicographically for ties. Counters saturate at `u32::MAX`; tag changes and tombstones do not change historical counts.                                                    |
| `get(id)`                                                              | —                     | `id: String`                                                                                                                                                                                                                                                           | `Result<Resource, Error>` | Read a single resource. Errors `NotFound` if absent.                                                                                                                                                                                              |
| `get_resource_state(id)`                                               | —                     | `id: String`                                                                                                                                                                                                                                                           | `Result<ResourceState, Error>` | Read the current lifecycle state of a resource. Errors `NotFound` if absent.                                                                                                                                                                            |
| `exists(id)`                                                           | —                     | `id: String`                                                                                                                                                                                                                                                           | `bool`                    | Whether a resource is registered.                                                                                                                                                                                                                 |
| `exists_many(ids)`                                                     | —                     | `ids: Vec<String>`                                                                                                                                                                                                                                                     | `Vec<bool>`               | Batch existence check. Returns a `Vec<bool>` parallel to `ids`: `result[i]` is `true` iff `ids[i]` is registered. Invalid-format IDs are treated as absent (`false`). Useful for server-side bulk validation before publishing or reconciliation. |
| `get_owner(id)`                                                        | —                     | `id: String`                                                                                                                                                                                                                                                           | `Result<Address, Error>`  | Fetch the current owner of a resource. Errors `NotFound` if absent.                                                                                                                                                                               |
| `count()`                                                              | —                     | —                                                                                                                                                                                                                                                                      | `u32`                     | Total resources successfully registered (monotonic; never decremented).                                                                                                                                                                           |
| `listed_count()`                                                       | —                     | —                                                                                                                                                                                                                                                                      | `u32`                     | Total number of resources currently in the Listed state.                                                                                                                                                                                          |
| `creator_resource_count(creator)`                                      | —                     | `creator: Address`                                                                                                                                                                                                                                                     | `u32`                     | Resources currently owned by `creator` (moves with ownership transfer, unlike `count()`).                                                                                                                                                         |
| `creator_listed_count(creator)`                                        | —                     | `creator: Address`                                                                                                                                                                                                                                                     | `u32`                     | Number of resources owned by `creator` that are currently `Listed`. Follows every listed-state transition and moves with `transfer_ownership`/`accept_transfer`; the per-creator counterpart of `listed_count`.                                   |
| `registry_info()`                                                      | —                     | —                                                                                                                                                                                                                                                                      | `RegistryInfo`            | Discover this registry's name, version, resource schema version, and network in one read-only call. Always succeeds.                                                                                                                              |
| `admin()`                                                              | —                     | —                                                                                                                                                                                                                                                                      | `Option<Address>`         | Current contract admin address (`None` before any admin is set).                                                                                                                                                                                  |
| `pending_admin()`                                                      | —                     | —                                                                                                                                                                                                                                                                      | `Option<Address>`         | Pending nominated contract admin address.                                                                                                                                                                                                         |
| `pending_admin_expiry()`                                               | —                     | —                                                                                                                                                                                                                                                                      | `Option<u32>`             | Ledger sequence at which the pending admin nomination expires.                                                                                                                                                                                     |
| `nominate_new_admin(new_admin)`                                        | `admin` / `new_admin` | `new_admin: Address`                                                                                                                                                                                                                                                   | `Result<(), Error>`       | Nominate a new contract admin. If no admin is set yet, this call bootstraps the initial admin directly (no accept step).                                                                                                                          |
| `accept_admin(new_admin)`                                              | `pending_admin`       | `new_admin: Address`                                                                                                                                                                                                                                                   | `Result<(), Error>`       | Accept a pending admin nomination and become contract admin.                                                                                                                                                                                      |
| `set_terms_hash(creator, terms_hash)`                                  | `creator`             | `creator: Address`; `terms_hash: String` — max 64 bytes                                                                                                                                                                                                                | `Result<(), Error>`       | Store a hash of accepted marketplace terms for the creator.                                                                                                                                                                                       |
| `get_terms_hash(creator)`                                              | —                     | `creator: Address`                                                                                                                                                                                                                                                     | `Result<String, Error>`   | Fetch a creator's marketplace terms hash. Falls back to the registry-wide terms if no creator-specific entry exists. Errors `NotFound` if neither is set.                                                                                         |
| `set_registry_terms_hash(terms_hash)`                                  | `admin`               | `terms_hash: String` — max 64 bytes                                                                                                                                                                                                                                    | `Result<(), Error>`       | Store the vault's canonical listing terms hash. Used as fallback by `get_terms_hash` when a creator has not set their own terms.                                                                                                                   |

```rust
pub struct Resource {
    pub id: String,        // unique resource ID (1-24 lowercase letters/digits), matches server resource ID
    pub creator: Address,  // current owner's Stellar address
    pub price: i128,       // price in USDC base units (7 decimals)
    pub metadata: String,  // pointer (supported URI or content-hash form), max 512 bytes, non-empty
    pub listed: bool,      // compatibility projection: true exactly when state is Listed
    pub state: ResourceState, // explicit lifecycle state
    pub tags: Vec<String>, // discovery labels (0-8 items, max 32 bytes each)
    pub verified: VerificationStatus, // on-chain mirror of off-chain verification, settable only by a verifier
    pub frozen: bool,      // once true, update_metadata is permanently rejected
    pub metadata_frozen_at: Option<u32>, // ledger sequence when metadata was frozen, None before freeze_metadata
    pub created_at: u32,   // ledger sequence when the resource was first registered (immutable)
    pub updated_at: u32,   // ledger sequence of the last write (register or any mutation)
    pub dispute_flag: DisputeFlag, // NoFlag = no dispute; Flagged(reason) = active moderator flag
    pub schema_version: u32, // on-chain Resource schema version (RESOURCE_SCHEMA_VERSION = 6)
    pub version: u32,      // monotonically increasing version counter incremented on each mutation
    pub content_hash: Option<String>, // optional immutable content hash set at registration
}

pub enum VerificationStatus {
    Pending,
    Verified,
    Rejected,
}

pub enum ResourceState {
    Listed,
    Delisted,
    Frozen,
    Disputed,
    Tombstoned,
}

/// Optional dispute flag stored on a resource. Uses an enum rather than
/// `Option<FlagReason>` to satisfy Soroban's `contracttype` encoding requirements.
pub enum DisputeFlag {
    NoFlag,              // no active dispute flag
    Flagged(FlagReason), // actively flagged with a reason code
}

pub enum FlagReason {
    Spam      = 0,
    Copyright = 1,
    Malicious = 2,
    Other     = 3,
}
}
```

Supported metadata pointer prefixes are `ipfs://`, `ar://`, `https://`, `http://`,
and content-hash forms such as `sha256:`, `sha-256:`, or `0x`.

### Bounded text validation

The contract applies one shared byte-length validator to resource IDs, metadata
pointers, tags, and creator terms hashes. This keeps exact-limit acceptance and
over-limit errors consistent as new text fields are added. The public limits and
error codes are unchanged: IDs are 1–24 bytes, metadata is 1–512 bytes, tags
are 1–32 bytes (up to 8 tags), and terms hashes are at most 64 bytes.

### Catalog page (cursor primitive)

```rust
pub struct CatalogPage {
    pub items: Vec<Resource>,     // this page of resources (insertion order)
    pub next_cursor: Option<u32>, // next catalog index for `list`/`list_page`, or None at end-of-list
}

pub struct TagPopularity {
    pub tag: String,
    pub count: u32,
}
```

Clients should paginate by passing `next_cursor` back as `cursor`/`start` instead of
recomputing offsets from `items.len()`. `list(start, limit)` remains available and
returns only the `items` body for existing callers.

The per-creator and per-tag listings are backed by index vectors that can lose
entries between pages (tombstone, ownership transfer), so their paged variants
use an id-based cursor instead of a position:

```rust
pub enum IdCursor {
    Start,                     // first page
    After(u32, String, u32),   // resume after (position, last_id, created_at) of the last resource returned
    End,                       // end-of-list (returned; passing it back yields an empty page)
}

pub struct IdPage {
    pub items: Vec<Resource>,
    pub next_cursor: IdCursor,
}
```

See [Stable cursors for filtered listings](#stable-cursors-for-filtered-listings).

### Tag popularity

`top_tags(limit)` returns `TagPopularity` entries sorted by descending
successful-registration count, with lexicographic tag order for ties. Tags are
normalized to the same lowercase, trimmed form used by the tag index. The
contract keeps a per-tag `u32` counter and a bounded top-N materialized view;
the response is capped at `TOP_TAGS_CAP` (20), and a zero limit returns an empty
list. Each counter saturates at `u32::MAX`.

Counts represent successful registrations carrying the tag at registration time.
`set_tags` and tombstoning do not rewrite this historical signal, and a failed
registration never changes it. Resources already stored when this feature is
installed are not backfilled, because their original registration-time tags
cannot be reconstructed after `set_tags`; the counters cover registrations
processed after introduction. The derived stats index is not part of the
`Resource` schema, so `RESOURCE_SCHEMA_VERSION` does not change for this feature.

### Fee / royalty configuration

```rust
pub struct FeeConfig {
    pub platform_fee_bps: u32,        // platform cut (0–MAX_FEE_BPS = 5 000 bp)
    pub royalty_bps: u32,             // creator royalty (0–MAX_FEE_BPS = 5 000 bp)
    pub fee_recipient: Option<Address>, // where the remaining platform fee is routed
}

pub enum FeeDestination {
    None,
    Burn,
    Charity(Address),
}

pub struct FeeDestinationConfig {
    pub bps: u32,                     // share of the platform fee (0–10 000 bp)
    pub destination: FeeDestination,
}
```

The registry stores a single `FeeConfig` at registry scope (not per-resource).
The optional fee-destination policy is stored separately under
`DataKey::FeeDestination`, so existing `FeeConfig` values and callers remain
compatible. `bps` is a percentage of the already-computed platform fee, not of
the gross resource price. `None` with zero bps disables the route; `Burn` and
`Charity(address)` require a positive share. A partial route requires a
remaining `fee_recipient`; a 100% route may leave it unset. An active route also
requires a non-zero `platform_fee_bps`.

Settlement uses integer floor rounding:

```
platform_amount = floor(price * platform_fee_bps / 10_000)
destination_amount = floor(platform_amount * fee_destination_bps / 10_000)
fee_recipient_amount = platform_amount - destination_amount
```

`set_fee_destination` is admin-only and emits `setdest` with the old policy,
new policy, and ledger sequence. This event proves the authorized routing
configuration; because the registry is non-custodial, it does not itself move,
burn, or verify USDC. Off-chain settlement must apply the policy and publish
its transaction evidence separately.
`set_fee_config` enforces:

- `platform_fee_bps ≤ MAX_FEE_BPS` (else `FeeBpsTooHigh`)
- `royalty_bps ≤ MAX_FEE_BPS` (else `FeeBpsTooHigh`)
- `platform_fee_bps + royalty_bps ≤ MAX_FEE_BPS` (else `TotalFeeTooHigh`)

`validate_price` (called on every `register` / `set_price` / `set_price_many`) enforces:

- `price > platform_fee_bps + royalty_bps` (else `InvalidPrice`)

This two-layer invariant — a fee ceiling in `set_fee_config` and a price floor in `validate_price` — guarantees the creator always receives a **positive** remainder of at least `MIN_CREATOR_SHARE_BPS` (50 %) on every sale.
The contract does **not** collect fees itself — it stores the agreed split so
off-chain settlement (x402 facilitator, future settlement contracts) can read
and apply it.

See [`docs/adr-fee-config.md`](../docs/adr-fee-config.md) for the full design rationale.

### Methods

| Function                                                                     | Auth                                                     | Args                                                                                                                                                                                                                                                 | Returns                                | Description                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `register(creator, id, price, metadata, tags)`                               | `creator`                                                | `creator: Address`; `id: String` — unique cuid2 (1-24 lowercase letters/digits); `price: i128` — USDC base units (7 decimals), `0 < price <= MAX_PRICE`; `metadata: String` — non-empty pointer (max 512 bytes); `tags: Vec<String>` — max 8 tags, each max 32 bytes | `Result<(), Error>`                    | Register a new resource. Resources are listed by default, start `Pending` verification, and start unfrozen. Reserved IDs (`admin`, `null`, `registry`, `api`, `index`, `root`, `system`, case-insensitive) are rejected.                                                                                 |
| `register_with_hash(creator, id, price, metadata, tags, content_hash)`       | `creator`                                                | `creator: Address`; `id: String`; `price: i128`; `metadata: String`; `tags: Vec<String>`; `content_hash: Option<String>` — max 128 bytes                                                                                                             | `Result<(), Error>`                    | Register a new resource with an optional immutable content hash.                                                                                                                                                                                                                                         |
| `register_with_memo(creator, id, price, metadata, tags, content_hash, memo_hash)` | `creator`                                                | `creator: Address`; `id: String`; `price: i128`; `metadata: String`; `tags: Vec<String>`; `content_hash: Option<String>`; `memo_hash: Option<BytesN<32>>`                                                                                            | `Result<(), Error>`                    | Register a new resource with an optional content hash and an optional 32-byte memo hash (for example the `MEMO_HASH` of the announcing transaction). The memo hash is written once and has no setter; read it with `get_memo_hash`. Emits `register`, then `regmemo` when a memo hash was given.         |
| `register_batch(creator, items)`                                             | `creator`                                                | `creator: Address`; `items: Vec<BatchRegisterItem>`; max 10 items, each `{ id, price, metadata, tags, content_hash }`                                                                                                                                | `Result<BatchRegisterResult, Error>`   | Register up to 10 resources in one transaction under one creator. Errors `BatchTooLarge` above the cap; otherwise continues past per-item failures and reports the `succeeded` ids and the `failed` `(index, error_code)` pairs.                                                                         |
| `set_price(id, new_price)`                                                   | `creator`                                                | `id: String`; `new_price: i128` — `0 < new_price <= MAX_PRICE`                                                                                                                                                                                       | `Result<(), Error>`                    | Update the resource price. Emits `setprice` with the old and new price.                                                                                                                                                                                                                                  |     |
| `set_price_many(creator, updates)`                                           | `creator`                                                | `creator: Address`; `updates: Vec<BatchPriceUpdate>` — max 10 owned resources                                                                                                                                                                    | `Result<(), Error>`                    | Atomically update multiple prices after one creator authorization. Invalid input leaves all prices unchanged. Emits `setprice` for each changed resource.                                                                                       |
| `update_metadata(id, metadata)`                                              | `creator`                                                | `id: String`; `metadata: String` — new pointer (max 512 bytes, non-empty)                                                                                                                                                                            | `Result<(), Error>`                    | Update the metadata pointer. Emits `updmeta` with the old and new pointer. Errors `MetadataFrozen` once `freeze_metadata` has been called.                                                                                                                                                               |
| `freeze_metadata(id)`                                                        | `creator`                                                | `id: String`                                                                                                                                                                                                                                         | `Result<(), Error>`                    | Permanently freeze the metadata pointer — `update_metadata` errors afterward. Irreversible; errors `AlreadyFrozen` if called twice. Price, listing, tags, and ownership stay mutable. Emits `freeze`.                                                                                                    |
| `set_metadata_pointers(id, pointers, primary)` | `creator` | `id: String`, `pointers: Vec<String>`, `primary: u32` | `Result<(), Error>` | Store up to `MAX_METADATA_POINTERS` (4) redundant pointers (e.g. IPFS + Arweave + hosted) with `pointers[primary]` preferred; sets `metadata` to the primary. Errors `InvalidMetadataPointers` / `MetadataFrozen`. Emits `setptrs` (and `updmeta` if the primary changed). `update_metadata` clears the mirror set. |
| `get_metadata_pointers(id)` | — | `id: String` | `Result<MetadataPointers, Error>` | All metadata pointers plus the primary index; falls back to `[metadata]` with primary `0`. |
| `set_tags(id, tags)`                                                         | `creator`                                                | `id: String`; `tags: Vec<String>` — max 8 tags, each max 32 bytes                                                                                                                                                                                    | `Result<(), Error>`                    | Replace discovery tags. Does not touch `metadata`. Emits `settags` with the previous and next tag lists.                                                                                                                                                                                                 |
| `set_royalty_recipient(id, recipient)`                                       | `creator`                                                | `id: String`; `recipient: Option<Address>`                                                                                                                                                                                                           | `Result<(), Error>`                    | Set or clear a per-resource royalty recipient override. Emits `setroyal` with the old and new recipient.                                                                                                                                                                                                |
| `transfer_ownership(id, new_creator)`                                        | `creator`                                                | `id: String`; `new_creator: Address`                                                                                                                                                                                                                 | `Result<(), Error>`                    | Transfer resource ownership immediately. Errors `AlreadyOwner` if `new_creator` already owns it. Clears any pending `propose_transfer` for the resource.                                                                                                                                                 |
| `transfer_ownership_with_terms(id, new_creator, new_terms_hash, reset_attestation)` | `creator`                                       | `id: String`; `new_creator: Address`; `new_terms_hash: Option<String>` — max 64 bytes; `reset_attestation: bool`                                                                                                                                     | `Result<(), Error>`                    | Transfer ownership while optionally binding a new terms hash to the incoming owner and/or clearing the resource's attestation record atomically. Emits `transfer` and `txfrterms`. Errors `AlreadyOwner`, `TermsHashTooLong`, or `ResourceNotMutable`.                                                   |
| `propose_transfer(id, new_creator)`                                          | `creator`                                                | `id: String`; `new_creator: Address`                                                                                                                                                                                                                 | `Result<(), Error>`                    | Propose a two-step transfer; takes effect only once `new_creator` calls `accept_transfer`.                                                                                                                                                                                                               |
| `accept_transfer(id)`                                                        | proposed `new_creator`                                   | `id: String`                                                                                                                                                                                                                                         | `Result<(), Error>`                    | Accept a proposed transfer. Errors `NoPendingTransfer` if none is pending.                                                                                                                                                                                                                               |
| `cancel_transfer(id)`                                                        | `creator`                                                | `id: String`                                                                                                                                                                                                                                         | `Result<(), Error>`                    | Cancel a proposed transfer. Errors `NoPendingTransfer` if none is pending.                                                                                                                                                                                                                               |
| `set_listed(id, listed)`                                                     | `creator`                                                | `id: String`; `listed: bool`                                                                                                                                                                                                                         | `Result<(), Error>`                    | Set the listing state. Emits `setlisted` with `(old_listed, new_listed)`, even on a no-op transition.                                                                                                                                                                                                    |
| `delist(id)`                                                                 | `creator`                                                | `id: String`                                                                                                                                                                                                                                         | `Result<(), Error>`                    | Convenience; equivalent to `set_listed(id, false)`.                                                                                                                                                                                                                                                      |
| `freeze_resource(id)`                                                        | `creator`                                                | `id: String`                                                                                                                                                                                                                                         | `Result<(), Error>`                    | Move a `Listed`/`Delisted` resource to `Frozen`. Only the creator can move it out again, via `reactivate_resource`.                                                                                                                                                                                       |
| `open_dispute(id, admin)`                                                    | `admin`                                                  | `id: String`; `admin: Address`                                                                                                                                                                                                                       | `Result<(), Error>`                    | Place a `Listed`/`Delisted`/`Frozen` resource under a dispute hold.                                                                                                                                                                                                                                      |
| `resolve_dispute(id, admin, state)`                                          | `admin`                                                  | `id: String`; `admin: Address`; `state: ResourceState` — `Listed`, `Delisted`, or `Frozen`                                                                                                                                                           | `Result<(), Error>`                    | Resolve a `Disputed` resource back to an active state.                                                                                                                                                                                                                                                   |
| `emergency_delist(id, admin, reason)`                                       | `admin`                                                  | `id: String`; `admin: Address`; `reason: String` (free-form admin justification)                                                                                                                                                                       | `Result<(), Error>`                    | Immediately move a `Disputed` resource to `Delisted`. Only the current admin may use this emergency path. Emits `emdelist` with `EmergencyDelistEvent { id, admin, reason }`.                                                                                                                           |
| `tombstone_resource(id, admin)`                                              | `admin`                                                  | `id: String`; `admin: Address`                                                                                                                                                                                                                       | `Result<(), Error>`                    | Permanently retire a resource. Terminal state; also purges it from the derived listing indexes.                                                                                                                                                                                                          |
| `reactivate_resource(id)`                                                    | `creator`                                                | `id: String`                                                                                                                                                                                                                                         | `Result<(), Error>`                    | Reactivate a `Frozen`/`Delisted` resource back to `Listed` after its dispute was resolved. Only the creator may call it; `Disputed` and `Tombstoned` resources have no creator exit. Emits `reactive`.                                                                                                   |
| `list(start, limit)`                                                         | —                                                        | `start: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                                                                                                                          | `Vec<Resource>`                        | Paginated resource list in insertion order (items only; prefer `list_page` for cursors).                                                                                                                                                                                                                 |
| `list_page(cursor, limit)`                                                   | —                                                        | `cursor: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                                                                                                                         | `CatalogPage`                          | Paginated page with `items` + `next_cursor`.                                                                                                                                                                                                                                                             |
| `list_listed(start, limit)`                                                  | —                                                        | `start: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                                                                                                                          | `Vec<Resource>`                        | Paginated list of listed-only resources. Delisted resources are skipped; relisted resources reappear.                                                                                                                                                                                                    |
| `list_by_creator(creator, start, limit)`                                     | —                                                        | `creator: Address`; `start: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                                                                                                      | `Vec<Resource>`                        | Paginated list of resources currently owned by `creator`, in registration order.                                                                                                                                                                                                                         |
| `list_by_tag(tag, start, limit)`                                             | —                                                        | `tag: String` (normalized to lowercase); `start: u32`; `limit: u32` — capped at 20                                                                                                                                                                   | `Vec<Resource>`                        | Paginated list of resources carrying `tag`, in tag-index insertion order. The lookup tag is normalized to lowercase before querying. Tombstoned resources are excluded from results. Returns an empty vec for unknown tags (not `NotFound`). Each resource entry read has its TTL bumped.                |
| `list_by_dispute_status(flagged, start, limit)`                              | —                                                        | `flagged: bool`; `start: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                                                                                                         | `Vec<Resource>`                        | Paginated list of resources filtered by whether `dispute_flag` is active, preserving catalog order. Each resource entry read has its TTL bumped.                                                                                                                                                         |
| `list_by_verification_status(status, start, limit)`                          | —                                                        | `status: VerificationStatus`; `start: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                                                                                           | `Vec<Resource>`                        | Paginated list of resources filtered by verification `status` (pending/verified/rejected), preserving catalog order. Each resource entry read has its TTL bumped.                                                                                                                                        |
| `top_tags(limit)`                                                            | —                                                        | `limit: u32` — capped at `TOP_TAGS_CAP` (20)                                                                                                                                                                                                        | `Vec<TagPopularity>`                   | Return the most popular tags sorted by descending use-count, capped at `limit`. Each entry is a `TagPopularity { tag, count }`. Returns an empty vec when no tags have been assigned.                                                                                                                    |
| `list_by_state(state, cursor, limit)`                                        | —                                                        | `state: ResourceState` — one of `Listed`, `Delisted`, `Frozen`, `Disputed`, `Tombstoned`; `cursor: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                              | `CatalogPage`                          | Paginated list of resources whose lifecycle state exactly matches `state`, preserving catalog order. Unlike the boolean `listed` projection, this distinguishes all five states. Returns a `CatalogPage` with `items` and `next_cursor`. Each resource entry read has its TTL bumped.                    |
| `get(id)`                                                                    | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Result<Resource, Error>`              | Read a single resource. Errors `NotFound` if absent.                                                                                                                                                                                                                                                     |
| `get_resource_state(id)`                                                     | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Result<ResourceState, Error>`              | Read the current lifecycle state of a resource. Errors `NotFound` if absent.                                                                                                                                                                                                                                   |
| `get_many(ids)`                                                              | —                                                        | `ids: Vec<String>` — capped at 20                                                                                                                                                                                                                    | `Result<Vec<Option<Resource>>, Error>` | Batch read resources in input order. Missing IDs return `None`; oversized batches error `BatchTooLarge`.                                                                                                                                                                                                 |
| `exists(id)`                                                                 | —                                                        | `id: String`                                                                                                                                                                                                                                         | `bool`                                 | Whether a resource is registered.                                                                                                                                                                                                                                                                        |
| `exists_many(ids)`                                                           | —                                                        | `ids: Vec<String>`                                                                                                                                                                                                                                   | `Vec<bool>`                            | Batch existence check. Returns a `Vec<bool>` parallel to `ids`: `result[i]` is `true` iff `ids[i]` is registered. IDs that fail format validation are treated as absent (`false`). TTL is bumped for every found entry. Useful for server-side bulk validation before publishing or reconciliation.      |
| `get_owner(id)`                                                              | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Result<Address, Error>`               | Fetch the resource's current owner. Errors `NotFound` if absent.                                                                                                                                                                                                                                         |
| `get_owner_many(ids)`                                                        | —                                                        | `ids: Vec<String>` — capped at 20                                                                                                                                                                                                                    | `Result<Vec<Option<Address>>, Error>`  | Batch read resource owners in input order. Missing IDs return `None`; invalid IDs error `InvalidResourceId`; oversized batches error `BatchTooLarge`.                                                                                                                                                   |
| `count()`                                                                    | —                                                        | —                                                                                                                                                                                                                                                    | `u32`                                  | Total resources ever successfully registered (monotonic; not decremented on transfer).                                                                                                                                                                                                                   |
| `listed_count()`                                                             | —                                                        | —                                                                                                                                                                                                                                                    | `u32`                                  | Number of resources currently in the `Listed` state.                                                                                                                                                                                                                                                     |
| `creator_resource_count(creator)`                                            | —                                                        | `creator: Address`                                                                                                                                                                                                                                   | `u32`                                  | Number of resources currently owned by `creator` (moves with `transfer_ownership`/`accept_transfer`, unlike `count`).                                                                                                                                                                                    |
| `creator_listed_count(creator)`                                              | —                                                        | `creator: Address`                                                                                                                                                                                                                                   | `u32`                                  | Number of resources owned by `creator` that are currently `Listed`. Follows every listed-state transition and moves with `transfer_ownership`/`accept_transfer`; the per-creator counterpart of `listed_count`.                                                                                          |
| `creator_earnings_estimate(creator)`                                         | —                                                        | `creator: Address`                                                                                                                                                                                                                                   | `CreatorEarningsEstimate`              | Return the total USDC stroops earned by `creator` across all settled payment receipts, without re-scanning history. Returns `{ creator, total_settled: i128, settled_count: u32 }`. A creator with no settled payments returns zeros — never errors.                                                      |
| `registry_info()`                                                            | —                                                        | —                                                                                                                                                                                                                                                    | `RegistryInfo`                         | Discover the registry name, crate version, resource schema version, and network id.                                                                                                                                                                                                                      |
| `contract_version()`                                                         | —                                                        | —                                                                                                                                                                                                                                                    | `ContractVersion`                      | Return the crate version and resource schema version.                                                                                                                                                                                                                                                    |
| `resource_schema_version()` | — | — | `u32` | Return `RESOURCE_SCHEMA_VERSION` as a bare integer for feature detection without decoding `contract_version`. |
| `admin()`                                                                    | —                                                        | —                                                                                                                                                                                                                                                    | `Option<Address>`                      | Current contract admin address, if any has been set.                                                                                                                                                                                                                                                     |
| `pending_admin()`                                                            | —                                                        | —                                                                                                                                                                                                                                                    | `Option<Address>`                      | Pending nominated admin address, if a nomination is in flight.                                                                                                                                                                                                                                           |
| `pending_admin_expiry()`                                                     | —                                                        | —                                                                                                                                                                                                                                                    | `Option<u32>`                          | Ledger sequence at which the pending admin nomination expires, if one is active.                                                                                                                                                                                                                           |
| `nominate_new_admin(new_admin)`                                              | current `admin` (or `new_admin` for the first-ever call) | `new_admin: Address`                                                                                                                                                                                                                                 | `Result<(), Error>`                    | If no admin is set yet, bootstraps `new_admin` as admin directly. Otherwise nominates `new_admin` as pending admin; takes effect once they call `accept_admin`. Errors `SameAdmin` / `PendingAdminAlreadySet`.                                                                                           |
| `accept_admin(new_admin)`                                                    | pending admin                                            | `new_admin: Address`                                                                                                                                                                                                                                 | `Result<(), Error>`                    | Accept a pending admin nomination. Errors `PendingAdminNotSet` if `new_admin` doesn't match the pending nomination.                                                                                                                                                                                      |
| `bootstrap_dual_admin(admin, recovery_admin)` | `admin` + `recovery_admin` | `admin: Address`, `recovery_admin: Address` | `Result<(), Error>` | Optional dual-key bootstrap: sets the admin and a distinct recovery admin in one call. Only before any admin exists (`AdminAlreadySet`). Emits `setadmin` and `setrecov`. |
| `recovery_admin()` | — | — | `Option<Address>` | The configured recovery admin, if any. |
| `set_recovery_admin(recovery_admin)` | `admin` | `recovery_admin: Option<Address>` | `Result<(), Error>` | Set or clear the recovery admin (must differ from admin). Emits `setrecov`. |
| `recover_admin(new_admin)` | recovery admin | `new_admin: Address` | `Result<(), Error>` | Replace a lost admin key immediately and clear any pending nomination. Errors `RecoveryAdminNotSet` / `SameAdmin`. Emits `recover`. |
| `set_terms_hash(creator, terms_hash)`                                        | `creator`                                                | `creator: Address`; `terms_hash: String` — max 64 bytes                                                                                                                                                                                              | `Result<(), Error>`                    | Store a hash of the creator's accepted marketplace terms.                                                                                                                                                                                                                                                |
| `get_terms_hash(creator)`                                                    | —                                                        | `creator: Address`                                                                                                                                                                                                                                   | `Result<String, Error>`                | Fetch a creator's terms hash. Falls back to the registry-wide terms if no creator-specific entry exists. Errors `NotFound` if neither is set.                                                                                                                                                            |
| `set_registry_terms_hash(terms_hash)`                                        | `admin`                                                  | `terms_hash: String` — max 64 bytes                                                                                                                                                                                                                  | `Result<(), Error>`                    | Store the vault's canonical listing terms hash. Returned by `get_terms_hash` as fallback when a creator has not stored their own terms.                                                                                                                                                                  |
| `get_memo_hash(id)`                                                          | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Option<BytesN<32>>`                   | Fetch the memo hash recorded at registration by `register_with_memo`, or `None` for any other resource.                                                                                                                                                                                                  |
| `set_verification_status(id, verifier, status, attestation_hash)`            | `verifier`                                               | `id: String`; `verifier: Address`; `status: VerificationStatus`; `attestation_hash: Option<String>`                                                                                                                                                  | `Result<(), Error>`                    | Mirror off-chain verification status on-chain. Hashes are stored as `algorithm:digest`; untagged hashes are memoized as `sha256:<digest>`. Emits `verify` with old status, new status, and the stored hash.                                                                                              |
| `get_attestation_hash(id)`                                                   | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Option<String>`                       | Fetch the optional version-tagged off-chain attestation hash recorded for a resource.                                                                                                                                                                                                                    |
| `compute_attestation_hash(id, status, document_hash)` | — | `id: String`, `status: VerificationStatus`, `document_hash: BytesN<32>` | `String` | Pure: returns `sha256:<hex>` of `"mindvault-attestation-v1" \|\| u32_be(len(id)) \|\| id \|\| u32_be(status) \|\| document_hash`, so off-chain clients can recompute the expected attestation hash without trusting a wallet. |
| `verify_attestation_hash(id, status, document_hash)` | — | `id: String`, `status: VerificationStatus`, `document_hash: BytesN<32>` | `bool` | `true` when the resource is in `status` and its stored attestation hash equals `compute_attestation_hash(...)`. |
| `add_verifier(verifier)`                                                     | `admin`                                                  | `verifier: Address`                                                                                                                                                                                                                                  | `Result<(), Error>`                    | Grant the verifier role, authorizing `set_verification_status`. Errors `AdminNotSet` if no admin has been set yet.                                                                                                                                                                                       |
| `remove_verifier(verifier)`                                                  | `admin`                                                  | `verifier: Address`                                                                                                                                                                                                                                  | `Result<(), Error>`                    | Revoke the verifier role.                                                                                                                                                                                                                                                                                |
| `rotate_verifier(old_verifier, new_verifier)`                              | `admin`                                                  | `old_verifier: Address`; `new_verifier: Address`                                                                                                                                                                                                      | `Result<(), Error>`                    | Atomically replace a registered verifier with a new key. Rejects an unregistered old key, an already-registered new key, and same-key rotation. Emits `verrot` with both keys and the ledger sequence.                                                                 |
| `is_verifier(address)`                                                       | —                                                        | `address: Address`                                                                                                                                                                                                                                   | `bool`                                 | Whether `address` currently holds the verifier role.                                                                                                                                                                                                                                                     |
| `get_verifier_status_history(verifier, cursor, limit)`                       | —                                                        | `verifier: Address`; `cursor: u32`; `limit: u32` — capped at `LIST_PAGE_CAP` (20)                                                                                                                                                                   | `VerifierStatusPage`                   | Return a page of verification status changes performed by `verifier`, in chronological order (oldest first). Each entry is a `VerifierStatusEntry { resource_id, old_status, new_status, attestation_hash, ledger }`. Returns an empty page for a verifier with no history — never errors.              |
| `add_moderator(moderator)`                                                   | `admin`                                                  | `moderator: Address`                                                                                                                                                                                                                                 | `Result<(), Error>`                    | Grant the moderator role, authorizing `flag_resource` and `unflag_resource`. Errors `AdminNotSet` if no admin has been set yet.                                                                                                                                                                          |
| `remove_moderator(moderator)`                                                | `admin`                                                  | `moderator: Address`                                                                                                                                                                                                                                 | `Result<(), Error>`                    | Revoke the moderator role.                                                                                                                                                                                                                                                                               |
| `is_moderator(address)`                                                      | —                                                        | `address: Address`                                                                                                                                                                                                                                   | `bool`                                 | Whether `address` currently holds the moderator role.                                                                                                                                                                                                                                                    |
| `flag_resource(id, moderator, reason)`                                       | `moderator`                                              | `id: String`; `moderator: Address`; `reason: FlagReason`                                                                                                                                                                                             | `Result<(), Error>`                    | Set `Resource.dispute_flag` to `Flagged(reason)`. Flagging is informational — it does not delist or delete the resource. Re-flagging an already-flagged resource replaces the reason. Errors `Unauthorized` if caller lacks the moderator role. Emits `flag`.                                            |
| `unflag_resource(id, moderator)`                                             | `moderator`                                              | `id: String`; `moderator: Address`                                                                                                                                                                                                                   | `Result<(), Error>`                    | Clear `Resource.dispute_flag` to `NoFlag`. No-op if the resource is not currently flagged (event still emitted). Errors `Unauthorized` if caller lacks the moderator role. Emits `unflag`.                                                                                                               |
| `set_flag_reason_hash(id, moderator, reason_hash)`                           | `moderator`                                              | `id: String`; `moderator: Address`; `reason_hash: String` — max 64 bytes                                                                                                                                                                             | `Result<(), Error>`                    | Store a hash of a moderator's off-chain dispute reason writeup for the resource, independent of `flag_resource`'s fixed `FlagReason` code. Replaces any existing hash. Errors `Unauthorized` if caller lacks the moderator role. Emits `flagrsn`.                                                        |
| `set_flag_resolution_window(window_ledgers)` | `admin` | `window_ledgers: u32` — `0` disables, max `MAX_FLAG_RESOLUTION_WINDOW` | `Result<(), Error>` | Set how many ledgers a moderator has to resolve a new flag. Errors `InvalidFlagResolutionWindow` above the max. Emits `flagwin`. |
| `flag_resolution_window()` | — | — | `u32` | Configured flag resolution window in ledgers (`0` = no deadline). |
| `get_flag_deadline(id)` | — | `id: String` | `Option<u32>` | Ledger after which the active flag on `id` is overdue; `None` if unflagged or flagged without a window. |
| `is_flag_overdue(id)` | — | `id: String` | `bool` | Whether the active flag on `id` has passed its resolution deadline (escalate to admin). |
| `force_resolve_flag(id, admin)` | `admin` | `id: String`; `admin: Address` | `Result<(), Error>` | Clear an overdue flag a moderator never resolved. Errors `NotFlagged` or `FlagNotOverdue`. Emits `flagfrc` and `unflag`. |
| `get_flag_reason_hash(id)`                                                   | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Result<String, Error>`                | Fetch the moderator dispute reason hash stored for a resource. Errors `NotFound` if absent.                                                                                                                                                                                                              |
| `is_flagged(id)`                                                             | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Result<bool, Error>`                  | Whether the resource currently carries a dispute flag (`dispute_flag` is `Flagged(_)`). Errors `NotFound` for an unknown id. Available while paused.                                                                                                                                                     |
| `flag_details(id)`                                                           | —                                                        | `id: String`                                                                                                                                                                                                                                         | `Result<FlagDetails, Error>`           | One read of a resource's moderation state: `dispute_flag`, `reason_hash` (`None` until `set_flag_reason_hash` is called), and `last_moderator` (whoever last called `flag_resource`, `unflag_resource`, or `set_flag_reason_hash` on it; `None` if no moderator has). Errors `NotFound` for an unknown id. Available while paused. |
| `set_fee_config(config)`                                                     | `admin`                                                  | `config: FeeConfig`                                                                                                                                                                                                                                  | `Result<(), Error>`                    | Store registry fee and royalty basis points. Emits `setfee`.                                                                                                                                                                                                                                             |
| `get_fee_config()`                                                           | —                                                        | —                                                                                                                                                                                                                                                    | `Option<FeeConfig>`                    | Fetch the current registry fee config, if set.                                                                                                                                                                                                                                                           |
| `set_fee_recipient(recipient)`                                                | `admin`                                                  | `recipient: Option<Address>`                                                                                                                                                                                                                        | `Result<(), Error>`                    | Update only the configured fee recipient while preserving existing fee rates. Errors `FeeConfigNotSet` if no config exists. Emits `setfee`.                                                                                                                                                              |
| `set_fee_destination(config)`                                                | `admin`                                                  | `config: FeeDestinationConfig` — `bps` share of the platform fee (0–10 000) and `destination` (`None`, `Burn`, or `Charity(address)`)                                                                                                                       | `Result<(), Error>`                    | Set or clear the burn/charity route without changing the base fee config. Emits `setdest`; the event records policy, not token movement.                                                                                                                                                         |
| `get_fee_destination()`                                                      | —                                                        | —                                                                                                                                                                                                                                                    | `FeeDestinationConfig`                 | Fetch the current fee-destination policy, defaulting to `None` with zero bps.                                                                                                                                                                                                                              |
| `repair_index(ids)`                                                          | `admin`                                                  | `ids: Vec<String>` — authoritative ordered id list                                                                                                                                                                                                   | `Result<(), Error>`                    | Rebuild the pagination index and `Count` from an admin-supplied id list. Rejects duplicates with `DuplicateInRepair`. Emits `reindex`.                                                                                                                                                                   |
| `repair_tag_index(ids)`                                                      | `admin`                                                  | `ids: Vec<String>` — authoritative ordered id list                                                                                                                                                                                                   | `Result<(), Error>`                    | Rebuild tag indexes from registered resources. Emits `retagidx`.                                                                                                                                                                                                                                         |
| `record_payment(settler, receipt_id, resource_id, payer, amount, tx_hash)`   | `settler` + `payer`                                      | `settler: Address` — holder of the settler role; `receipt_id: String` — unique, 1-64 bytes; `resource_id: String`; `payer: Address`; `amount: i128` — `> 0`; `tx_hash: String` — 1-128 bytes                                                         | `Result<(), Error>`                    | Record an x402/Soroban payment receipt in `Escrowed` state and index it under `(resource_id, payer)`. Emits `payment` and a `nomemo` provenance warning — prefer `record_payment_with_memo`.                                                                                                                                                                                   |
| `record_payment_with_memo(settler, receipt_id, resource_id, payer, amount, tx_hash, memo)` | `settler` + `payer` | Same as `record_payment`, plus `memo: String` — the settlement tx `MEMO_TEXT`, must be `mv:<resource_id>` | `Result<(), Error>` | Record a payment receipt whose settlement memo proves which resource was paid for. Errors `InvalidPaymentMemo` on a non-canonical memo. Emits `payment`. |
| `get_payment_memo(receipt_id)` | — | `receipt_id: String` | `Option<String>` | Canonical memo stored for a receipt by `record_payment_with_memo`, or `None`. |
| `settle_payment(settler, receipt_id)`                                        | `settler`                                                | `settler: Address`; `receipt_id: String`                                                                                                                                                                                                             | `Result<(), Error>`                    | Advance a receipt from `Escrowed` to `Settled`. Errors `InvalidPaymentTransition` if it is not escrowed. Emits `settle`.                                                                                                                                                                                 |
| `get_payment(receipt_id)`                                                    | —                                                        | `receipt_id: String`                                                                                                                                                                                                                                 | `Result<PaymentReceipt, Error>`        | Fetch a receipt by id. Errors `NotFound` if absent. Bumps the entry's TTL.                                                                                                                                                                                                                               |
| `get_payment_receipt(resource_id, payer)`                                    | —                                                        | `resource_id: String`; `payer: Address`                                                                                                                                                                                                              | `Result<PaymentReceipt, Error>`        | Fetch the most recent receipt recorded for the pair, via the `PaymentIndex` secondary index. Errors `NotFound` if absent.                                                                                                                                                                                |
| `set_refund_window(admin, window_ledgers)`                                   | current `admin`                                          | `admin: Address`; `window_ledgers: u32` — 1 to `MAX_REFUND_WINDOW_LEDGERS`                                                                                                                                                                            | `Result<(), Error>`                    | Set the creator refund window for payments settled after this call. Existing deadlines are unchanged. Emits `refwin`.                                                                                                                                                                                     |
| `refund_window()`                                                           | —                                                        | —                                                                                                                                                                                                                                                    | `u32`                                  | Read the configured refund window in ledgers; defaults to `DEFAULT_REFUND_WINDOW_LEDGERS` (one day).                                                                                                                                                                                                     |
| `record_creator_refund(creator, refund_id, payment_receipt_id, recipient, amount, tx_hash)` | payment `creator` | `creator: Address`; `refund_id: String`; `payment_receipt_id: String`; `recipient: Address`; `amount: i128`; `tx_hash: String`                                                                                                     | `Result<(), Error>`                    | Record a completed external refund within the payment's deadline. The creator who received the payment must authorize; recipient must be the original payer. Cumulative refunds cannot exceed the payment amount. Emits `refund`.                                                                          |
| `record_admin_refund(admin, refund_id, payment_receipt_id, recipient, amount, tx_hash)` | current `admin`                                           | `admin: Address`; `refund_id: String`; `payment_receipt_id: String`; `recipient: Address`; `amount: i128`; `tx_hash: String`                                                                                                        | `Result<(), Error>`                    | Admin override for recording a refund after the deadline or without creator authorization. Payer and cumulative amount constraints still apply. Emits `refund`.                                                                                                                                           |
| `get_refund(refund_id)`                                                      | —                                                        | `refund_id: String`                                                                                                                                                                                                                                  | `Result<RefundReceipt, Error>`         | Fetch a refund record by its id. Errors `NotFound` if absent.                                                                                                                                                                                                                                              |
| `get_refunded_amount(payment_receipt_id)`                                    | —                                                        | `payment_receipt_id: String`                                                                                                                                                                                                                         | `Result<i128, Error>`                  | Read the cumulative amount recorded as refunded for a payment. Errors `NotFound` if the payment receipt is absent.                                                                                                                                                                                        |
| `get_refund_deadline(payment_receipt_id)`                                     | —                                                        | `payment_receipt_id: String`                                                                                                                                                                                                                         | `Result<u32, Error>`                   | Read the exclusive ledger deadline for creator refunds of a settled payment.                                                                                                                                                                                                                              |
| `anchor_purchase_receipt(service, resource_id, buyer, receipt_hash)`         | `verifier`                                               | `service: Address`; `resource_id: String`; `buyer: Address`; `receipt_hash: String`                                                                                                                                                                  | `Result<(), Error>`                    | Anchor an immutable purchase receipt hash. Duplicate buyer/resource anchors error `DuplicateReceipt`. Emits `anchor`.                                                                                                                                                                                    |
| `attempt_anchor_purchase_receipt(service, resource_id, buyer, receipt_hash)` | `verifier`                                               | `service: Address`; `resource_id: String`; `buyer: Address`; `receipt_hash: String`                                                                                                                                                                  | `Result<bool, Error>`                  | Same anchor, but a rejected attempt emits `anchrfail` and returns `false` instead of reverting. Authorization failures still revert.                                                                                                                                                                     |
| `override_purchase_receipt_anchor(admin, resource_id, buyer, new_receipt_hash)` | `admin`                                                  | `admin: Address`; `resource_id: String`; `buyer: Address`; `new_receipt_hash: String`                                                                                                                                                                | `Result<(), Error>`                    | Override an existing purchase receipt anchor. Errors `NotFound` if it does not exist. Emits `anchor`.                                                                                                                                                                                                  |
| `get_purchase_receipt(resource_id, buyer)`                                   | —                                                        | `resource_id: String`; `buyer: Address`                                                                                                                                                                                                              | `Result<PurchaseReceiptAnchor, Error>` | Fetch a purchase receipt anchor. Errors `NotFound` if absent.                                                                                                                                                                                                                                            |
| `get_anchor_attempts(resource_id, buyer)`                                    | —                                                        | `resource_id: String`; `buyer: Address`                                                                                                                                                                                                              | `Result<AnchorAttempts, Error>`        | Rejected `attempt_anchor_purchase_receipt` count and last-attempt ledger for the pair; both `0` when it was never rejected or its anchor has since been written.                                                                                                                                         |
| `buy_lease(holder, resource_id, tier, amount, tx_hash)`                      | `holder`                                                 | `holder: Address`; `resource_id: String`; `tier: LeaseTier` — `Hour`, `Day`, or `Week`; `amount: i128` — must equal `lease_price(resource_id, tier)`; `tx_hash: String` — 1-128 bytes                                                                 | `Result<Lease, Error>`                 | Record a time-limited access lease in `Pending` state, to be confirmed by `settle_lease`. Requires a `Listed` resource (`ResourceNotMutable`), the exact lease price (`PaymentAmountMismatch`), and no pending or unexpired active lease for the pair (`AlreadyRegistered`). Emits `lease`.                |
| `record_lease(settler, holder, resource_id, tier, amount, tx_hash)`          | `settler` + `holder`                                     | `settler: Address` — holder of the settler role; then as `buy_lease`                                                                                                                                                                                 | `Result<Lease, Error>`                 | Settler-recorded lease: the same checks as `buy_lease`, written directly in `Active` state because the settler has already confirmed the payment. Emits `lease`.                                                                                                                                         |
| `settle_lease(settler, resource_id, holder)`                                 | `settler`                                                | `settler: Address`; `resource_id: String`; `holder: Address`                                                                                                                                                                                         | `Result<Lease, Error>`                 | Advance a `Pending` lease to `Active`. Errors `NotFound` without a lease and `InvalidPaymentTransition` if it is not `Pending`. Emits `leasesetl`.                                                                                                                                                        |
| `revoke_lease(resource_id, holder)`                                          | `creator`                                                | `resource_id: String`; `holder: Address`                                                                                                                                                                                                             | `Result<Lease, Error>`                 | Revoke a `Pending` or `Active` lease; terminal and immediate. Errors `NotFound` without a lease and `InvalidPaymentTransition` if already `Revoked`. Emits `leaserevk`.                                                                                                                                  |
| `get_lease(resource_id, holder)`                                             | —                                                        | `resource_id: String`; `holder: Address`                                                                                                                                                                                                             | `Result<Lease, Error>`                 | Fetch the lease recorded for the pair, whatever its state. Errors `NotFound` if none exists. Bumps the entry's TTL.                                                                                                                                                                                      |
| `lease_is_active(resource_id, holder)`                                       | —                                                        | `resource_id: String`; `holder: Address`                                                                                                                                                                                                             | `bool`                                 | `true` while a lease exists for the pair, is `Active`, and the current ledger is below its `expiry_ledger`. Never errors.                                                                                                                                                                                 |
| `lease_price(resource_id, tier)`                                             | —                                                        | `resource_id: String`; `tier: LeaseTier`                                                                                                                                                                                                             | `Result<i128, Error>`                  | The resource's current price times the tier multiplier (`LEASE_HOUR_MULTIPLIER` 1, `LEASE_DAY_MULTIPLIER` 5, `LEASE_WEEK_MULTIPLIER` 20). Errors `NotFound` for an unknown resource.                                                                                                                     |
| `extend_resource_ttl(creator, resource_id)`                                  | `creator`                                                | `creator: Address`; `resource_id: String`                                                                                                                                                                                                            | `Result<(), Error>`                    | Refresh a resource's persistent storage TTL. Emits `ttlext`.                                                                                                                                                                                                                                             |
| `add_settler(settler)`                                                       | `admin`                                                  | `settler: Address`                                                                                                                                                                                                                                   | `Result<(), Error>`                    | Grant the settler role. Emits `addsettlr`.                                                                                                                                                                                                                                                               |
| `remove_settler(settler)`                                                    | `admin`                                                  | `settler: Address`                                                                                                                                                                                                                                   | `Result<(), Error>`                    | Revoke the settler role. Emits `rmsettlr`.                                                                                                                                                                                                                                                               |
| `is_settler(address)`                                                        | —                                                        | `address: Address`                                                                                                                                                                                                                                   | `bool`                                 | Whether `address` currently holds the settler role.                                                                                                                                                                                                                                                      |
| `set_paused(admin, paused)`                                                  | `admin`                                                  | `admin: Address`; `paused: bool`                                                                                                                                                                                                                     | `Result<(), Error>`                    | Set or clear the emergency pause on all mutations. Emits `pause`.                                                                                                                                                                                                                                        |
| `set_paused_until(admin, pause_until)`                                      | `admin`                                                  | `admin: Address`; `pause_until: u64` — absolute Unix ledger timestamp in seconds                                                                                                                                                                    | `Result<(), Error>`                    | Schedule a pause that automatically resumes at the deadline. Emits `pause` and `pause_until`.                                                                                                                                                                                                            |
| `is_paused()`                                                                | —                                                        | —                                                                                                                                                                                                                                                    | `bool`                                 | Whether the registry is currently paused.                                                                                                                                                                                                                                                                |
| `pause_until()`                                                               | —                                                        | —                                                                                                                                                                                                                                                    | `Option<u64>`                          | The active scheduled pause deadline, if one exists.                                                                                                                                                                                                                                                      |
| `initialize_network(network_id)`                                             | —                                                        | `network_id: BytesN<32>`                                                                                                                                                                                                                             | `Result<(), Error>`                    | Pin the contract to one network passphrase digest. One-shot.                                                                                                                                                                                                                                             |
| `network_id()`                                                               | —                                                        | —                                                                                                                                                                                                                                                    | `Result<BytesN<32>, Error>`            | The configured network id. Errors `NetworkNotInitialized` if unset.                                                                                                                                                                                                                                      |

#### Refund flow

Payment receipts are settled separately from refunds. When a payment settles,
the registry snapshots the current refund window (one day by default) as an
exclusive ledger deadline. The admin can configure a window from 1 ledger to
`MAX_REFUND_WINDOW_LEDGERS` (29 days, leaving a storage-TTL buffer); the change
applies only to future settlements.

After sending USDC back to the buyer outside this non-custodial registry, the
creator who received that payment records the transfer with
`record_creator_refund`, even if the resource has since changed owners. The
recipient must equal the original payment payer, and partial refunds are allowed
as long as their cumulative amount does not exceed the settled payment.
`record_admin_refund` lets the current admin record an override after the
deadline or without creator authorization, but cannot change the recipient or
exceed the original amount.

These methods store the supplied refund transaction hash and emit `refund` for
indexers; they do not custody USDC or verify the hash's transfer contents. The
caller must submit the record only after the external transfer is complete.
This follows the ADR's direct-payment model, where refunds are separate
transactions rather than contract-held escrow.


### Roles

Three roles sit alongside the per-resource `creator` and the pre-existing admin:

- **admin** — set via `nominate_new_admin` (see above). Can grant/revoke or rotate the verifier role (`add_verifier`/`remove_verifier`/`rotate_verifier`), repair the pagination index (`repair_index`) or tag index (`repair_tag_index`), set the registry fee config (`set_fee_config`), configure refund windows, and record admin-override refunds. Cannot mutate any resource's price, metadata, listing, tags, or ownership.
- **verifier** — zero or more addresses granted by the admin. Can call `set_verification_status` and `anchor_purchase_receipt`. Cannot touch price, metadata, listing, tags, ownership, or the admin/verifier role list itself.

### Role management flows

This section documents the end-to-end lifecycle for each role, including edge
cases and error paths. All flows are covered by tests in `src/test.rs`.

#### Admin bootstrap

The very first call to `nominate_new_admin` bootstraps the admin directly:

```
Caller (new_admin) ──nominate_new_admin(A)──► Admin = A
```

- **Auth**: `new_admin` must authorize the call (`require_auth`).
- **Event**: `setadmin` with `new_admin`.
- **No accept step** — the caller becomes admin immediately.

#### Admin transfer (two-step rotation)

Once an admin exists, all subsequent nominations follow a two-step protocol:

```
Admin ──nominate_new_admin(B)──► PendingAdmin = B  (ledger N)
B      ──accept_admin(B)──────► Admin = B, PendingAdmin cleared  (ledger ≥ N + ADMIN_NOMINATION_MIN_GAP)
```

- **Step 1 (nominate)**: Only the current admin may call. Emits `nomadmin`. Errors
  `SameAdmin` if `B` is already the current admin. Errors `PendingAdminAlreadySet`
  if a previous nomination is still pending (no overlapping nominations).
- **Step 2 (accept)**: Only the pending admin may call. Must be submitted at least
  `ADMIN_NOMINATION_MIN_GAP` ledgers (~1 day) after step 1 — this prevents a
  single compromised admin from batching both steps atomically. Errors
  `AdminNominationExpired` if the gap has not yet elapsed or the nomination has
  expired. Errors `PendingAdminNotSet` if the caller does not match the pending
  nomination.

#### Optional dual-key bootstrap

Deployments that need recovery if the sole admin key is lost can bootstrap
with two keys instead of `nominate_new_admin`:

```
Admin + Recovery ──bootstrap_dual_admin(A, R)──► Admin = A, RecoveryAdmin = R
Recovery         ──recover_admin(B)────────────► Admin = B (pending nomination cleared)
```

- Both keys must authorize the bootstrap and must differ. Only valid before any
  admin is set (`AdminAlreadySet`).
- The admin can later change or clear the recovery key with
  `set_recovery_admin`. Emits `setrecov`; recovery emits `recover`.

#### Verifier grant and revoke

Admins control the verifier list:

```
Admin ──add_verifier(V)────► Verifier(V) = true
Admin ──remove_verifier(V)─► Verifier(V) = false
```

- **Auth**: Only the admin may call. Errors `AdminNotSet` if no admin exists.
- **Events**: `addverif` / `rmverif`.
- Multiple verifiers may be active simultaneously.
- `is_verifier(address)` is a public read-only query; no auth required.

#### Verifier key rotation

When a verifier key is compromised, the admin should use one auditable call
instead of an untracked remove-then-add pair:

```
Admin ──rotate_verifier(old_verifier, new_verifier)──► old = false, new = true
```

- **Auth**: Only the current admin may call it, using the same authorization
  check as `add_verifier` and `remove_verifier`; a non-admin caller is rejected
  before any state changes. `AdminNotSet` is returned if no admin exists.
- **Validation**: The old verifier must currently be registered (`NotFound`),
  and the new verifier must be different and unregistered (`AlreadyRegistered`).
  All checks run before either role is changed.
- **Events**: A successful rotation emits `rmverif`, `addverif`, and `verrot`.
  The `verrot` payload is `VerifierRotation { old_verifier, new_verifier,
  ledger }`, where `ledger` is the on-chain ledger sequence.
- **Atomicity**: Soroban commits both role changes and the audit event together;
  any failed validation or authorization reverts the whole call, leaving no
  partial verifier-set change. Routine independent `add_verifier` and
  `remove_verifier` calls remain available but do not emit `verrot`.

#### Verification status update

A verifier transitions a resource's on-chain verification status:

```
Verifier --set_verification_status(id, V, status, attestation_hash)--> Resource.verified = status
```

- **Auth**: The verifier address must authorize.
- **Allowed transitions**: `Pending→Verified`, `Pending→Rejected`,
  `Verified→Rejected`, `Rejected→Verified`.
- **Attestation hashes**: Stored values are version-tagged as
  `algorithm:digest`. Untagged digests are accepted for compatibility and
  stored as `sha256:<digest>`; explicitly tagged values such as
  `poseidon:<digest>` are preserved.
- **Disallowed**: self-transitions, reverting to `Pending`.
- **Errors**: `NotVerifier` (caller has no verifier role or role was revoked),
  `InvalidVerificationTransition`.
- **Event**: `verify` with `(old_status, new_status, attestation_hash)`.

#### Complete flow example

```
1. nominate_new_admin(A)          → Admin = A          (bootstrap)
2. add_verifier(V1)               → V1 is verifier
3. add_verifier(V2)               → V2 is verifier
4. register(creator, "abc", ...)  → Resource "abc", status = Pending
5. V1 set_verification_status("abc", V1, Verified)
                                  → Resource "abc", status = Verified
6. remove_verifier(V1)            → V1 is no longer verifier
7. V1 set_verification_status("abc", V1, Rejected)  → Err(NotVerifier)
8. nominate_new_admin(B)          → PendingAdmin = B
9. B accept_admin(B)              → Admin = B
10. B remove_verifier(V2)         → V2 is no longer verifier
```

### Verifier status query pagination design

The on-chain registry currently exposes `list`, `list_page`, `list_listed`,
and `list_by_creator` for paginated resource queries. A verifier status filter
is a natural addition to let agents and indexers efficiently find resources in
a specific verification state (e.g. all `Pending` resources awaiting review).

#### Proposed interface

```rust
/// Paginated list of resources whose `verified` field matches `status`.
pub fn list_by_verification_status(
    env: Env,
    status: VerificationStatus,
    cursor: u32,
    limit: u32,
) -> CatalogPage
```

- **status**: `Pending`, `Verified`, or `Rejected`.
- **cursor**: 0-based catalog index (same semantics as `list_page`).
- **limit**: page size, capped at 20.
- **Returns**: `CatalogPage { items, next_cursor }`.

#### Design rationale

1. **Mirrors existing pagination pattern** — uses the same cursor/limit
   contract as `list_page` and `list_by_creator`, so clients already know how
   to paginate.
2. **No new storage** — the filter is applied at read time by scanning the
   index. The index already stores all registered resource ids in insertion
   order; verification status is read from each `Resource` entry. For the
   current registry size (<10k resources), a linear scan is acceptable.
3. **If scale demands it** — a secondary index keyed by `(VerificationStatus, u32)`
   can be introduced later without changing the public API, only the
   internal implementation. The `CatalogPage` return type stays the same.
4. **Three-valued filter** — exposing `Pending` is important for verifiers
   who want a review queue. `Verified` and `Rejected` help auditors and
   consumers verify the provenance of listed resources.

#### Implementation notes

- The method iterates the insertion-order index (from `cursor`) and collects
  up to `limit` resources whose `verified` field matches `status`.
- Resources are filtered out of the count — `next_cursor` always reflects the
  absolute catalog position, so successive pages resume correctly.
- No new events are emitted; this is a read-only query.

#### Client usage

```typescript
// Fetch the first page of Pending resources for a review queue.
const page = await client.list_by_verification_status(
  VerificationStatus.Pending,
  0, // cursor
  20, // limit
);

// Fetch next page.
if (page.next_cursor !== null) {
  const next = await client.list_by_verification_status(
    VerificationStatus.Pending,
    page.next_cursor,
    20,
  );
}
```

### Error codes

| Code | Error                           | Description                                                                             |
| ---- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `1` | `AlreadyRegistered` | A resource with the given `id` or the target verifier already exists, or the holder already has a pending or unexpired active lease on the resource (`buy_lease` / `record_lease`). |
| `2`  | `NotFound`                      | No resource (or terms hash, receipt, or old verifier) matches the given key.            |
| `3`  | `InvalidPrice`                  | Price is `<= 0`, exceeds `MAX_PRICE`, or is not strictly greater than the combined active `platform_fee_bps + royalty_bps` (creator-share invariant). |
| `4`  | `MetadataTooLong`               | Metadata pointer exceeds `MAX_METADATA_POINTER_LEN` (512 bytes).                        |
| `5`  | `InvalidTag`                    | Tag validation failed (too many tags, empty/overlong tag, or duplicate normalized tag). |
| `6`  | `Unauthorized`                  | Caller is unauthorized, including a refund recipient mismatch.                           |
| `7`  | `PendingAdminNotSet`            | No pending admin is set, or caller does not match the pending admin.                    |
| `8`  | `PendingAdminAlreadySet`        | A pending admin nomination is already active.                                           |
| `9`  | `SameAdmin`                     | Nominated new admin is already the current contract admin.                              |
| `10` | `TermsHashTooLong`              | Terms hash exceeds `MAX_TERMS_HASH_LEN` (64 bytes).                                     |
| `11` | `InvalidResourceId`             | Resource id is empty or exceeds 24 bytes.                                               |
| `12` | `InvalidMetadataPointer`        | Metadata pointer does not start with a supported prefix.                                |
| `13` | `EmptyMetadata`                 | Metadata pointer is empty.                                                              |
| `14` | `AlreadyOwner`                  | Proposed/target new owner is already the current owner.                                 |
| `15` | `NoPendingTransfer`             | No pending transfer exists for this resource.                                           |
| `16` | `ReservedId`                    | Resource id collides with a reserved word (e.g. `admin`, `registry`).                   |
| `17` | `PriceExceedsMax`               | Price exceeds `MAX_PRICE`.                                                              |
| `18` | `AdminNotSet`                   | No admin has been set yet (`nominate_new_admin` never called), including verifier role operations. |
| `19` | `NotVerifier`                   | Caller does not hold the verifier role.                                                 |
| `20` | `InvalidVerificationTransition` | Verification status transition is not allowed (self-transition or revert to `Pending`). |
| `21` | `AlreadyFrozen`                 | `freeze_metadata` was already called on this resource.                                  |
| `22` | `MetadataFrozen`                | `update_metadata` rejected because the metadata pointer is frozen.                      |
| `23` | `DuplicateInRepair`             | `repair_index` received a duplicate id in the supplied list.                            |
| `24` | `InvalidTxHash`                 | A payment or refund `tx_hash` is empty or exceeds `MAX_TX_HASH_LEN` (128 bytes).         |
| `25` | `InvalidPaymentAmount`          | A payment or refund `amount` is `<= 0`, or a refund window is outside its allowed bounds. |
| `26` | `NotModerator`                  | Caller does not hold the moderator role.                                                |
| `27` | `AlreadyFlagged`                | Resource is already flagged as disputed.                                                |
| `28` | `NotFlagged`                    | Resource is not currently flagged as disputed.                                          |
| `29` | `InvalidLifecycleTransition`    | The requested lifecycle transition is not allowed from the current state.               |
| `30` | `ResourceNotMutable` | A frozen, disputed, or tombstoned resource cannot be changed by its creator, and a resource that is not `Listed` (delisted, frozen, disputed, or tombstoned) cannot accept a payment (`record_payment`) or a lease (`buy_lease` / `record_lease`). |
| `31` | `NetworkAlreadyInitialized`     | Network identifier has already been initialized for this contract instance.             |
| `32` | `NetworkIdMismatch`             | Invocation network identifier does not match configured network ID.                     |
| `33` | `NetworkNotInitialized`         | Network identifier has not been initialized.                                            |
| `34` | `FeeBpsTooHigh`                 | A fee or fee-destination basis-point value exceeds its configured ceiling.              |
| `35` | `TotalFeeTooHigh`               | The combined fee policy or fee-destination split is invalid.                             |
| `36` | `CountOverflow`                 | The global resource count would overflow `u32`.                                         |
| `37` | `BatchTooLarge`                 | `get_many` or `get_owner_many` was called with more than 20 ids.                        |
| `38` | `DuplicateReceipt`              | A purchase receipt is already anchored for `(resource_id, buyer)`.                      |
| `39` | `FlagReasonHashTooLong`         | `reason_hash` in `set_flag_reason_hash` exceeds `MAX_FLAG_REASON_HASH_LEN` (64 bytes).  |
| `40` | `ContractPaused`                | A state-changing method was called while the registry is paused.                        |
| `41` | `NotSettler`                    | Caller does not hold the settler role.                                                  |
| `42` | `ReceiptAlreadyExists`          | A payment or refund receipt is already stored for the supplied id.                       |
| `43` | `InvalidPaymentTransition`      | Payment is not settled, its creator refund deadline expired, or a payment state transition is not allowed. |
| `44` | `InvalidReceiptId`              | `receipt_id` is empty or exceeds `MAX_RECEIPT_ID_LEN` (64 bytes).                       |
| `45` | `ContentHashTooLong`            | `content_hash` exceeds `MAX_CONTENT_HASH_LEN` (128 bytes).                              |
| `46` | `AttestationHashTooLong`        | `attestation_hash` exceeds `MAX_ATTESTATION_HASH_LEN` (64 bytes).                       |
| `47` | `PaymentAmountMismatch`         | Payment amount differs from resource price or cumulative refunds exceed the original payment. |
| `48` | `DuplicateTxHash`               | A payment or refund receipt already uses the supplied transaction hash (`tx_hash`).      |
| `49` | `FeeConfigNotSet`               | `set_fee_recipient` or `set_fee_destination` was called before any fee config was set via `set_fee_config`. |
| `50` | `AdminNominationExpired`        | The pending admin nomination is missing or has expired.                                   |
| `51` | `InvalidMetadataPointers` | `set_metadata_pointers` got an empty, oversized, or duplicate list, or an out-of-range `primary`. |
| `52` | `AdminAlreadySet` | `bootstrap_dual_admin` was called after an admin was already set. |
| `53` | `RecoveryAdminNotSet` | `recover_admin` was called but no recovery admin is configured. |

#### Error budget

This enum is **full**. The protocol caps a contract error enum at 50 cases
(`ScSpecUdtErrorEnumV0.cases` is `VecM<_, 50>`), and codes `1`–`50` are all
allocated, so `#[contracterror]` fails to compile with `LengthExceedsMax` on a
`51` variant. Adding an error code therefore requires retiring an existing one
first, and retiring a code is a breaking change for anything matching on it.

Plan new validation around an existing code where the semantics genuinely fit,
or prefer a behavior that needs no new code (a documented no-op, or folding the
case into a broader existing error) over growing the enum.

### Resource ID format and reserved words

A resource `id` is a short, URL-safe string chosen at registration time. It is
permanent — the same id cannot be reused even after a resource is tombstoned.

**Format rules** (checked by `validate_resource_id`):

- Length: 1 – `MAX_RESOURCE_ID_LEN` (24) bytes (inclusive).
- Allowed characters: ASCII lowercase letters (`a–z`) and ASCII digits (`0–9`).
  Uppercase letters, hyphens, underscores, dots, and all other bytes are
  rejected with `InvalidResourceId`.
- The cuid2 generator (used by the server and MCP layer) produces ids that
  always satisfy these rules.

**Reserved words** (checked by `is_reserved_id`, case-insensitive):

| Reserved word | Reason                                                |
| ------------- | ----------------------------------------------------- |
| `admin`       | Collides with the admin role and admin-endpoint path. |
| `null`        | Ambiguous null/empty sentinel in query parameters.    |
| `registry`    | Matches the contract/registry route prefix.           |
| `api`         | Reserved route prefix for the server API.             |
| `index`       | Conflicts with the root/index route.                  |
| `root`        | Reserved for potential root-level resource routing.   |
| `system`      | Reserved for internal system-level endpoints.         |

An attempt to register any of these words (in any capitalisation, e.g. `Admin`,
`NULL`, `REGISTRY`) returns `ReservedId` (error code 16).

The reserved-word check is separate from `validate_resource_id`: an id can be
well-formed (all lowercase letters/digits, within length) and still be rejected
for colliding with a reserved word. Client code must handle both errors.

### Events

All events use the topic `(symbol, id)` for resource-scoped actions, or
`(symbol,)` (or `(symbol, address)`) for account-scoped actions (admin, terms).
This table is the canonical, human-readable mirror of `EVENT_SCHEMA` in
`src/lib.rs` — the `event_schema_matches_documented_readme_table` and
`full_workflow_emits_exactly_the_documented_events` tests in `src/test.rs` fail
if this table and `EVENT_SCHEMA` (or the contract's actual emissions) drift
apart, so update all three together.

| Event       | Payload                                                                                  | Triggered by                                               |
| ----------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `register`  | `Resource` (full resource record)                                                        | `register()` succeeds                                      |
| `regmemo`   | `memo_hash: BytesN<32>`                                                                  | `register_with_memo()` succeeds with a memo hash           |
| `setprice`  | `PriceUpdated { id, old_price, new_price, updater }`                                     | `set_price()` succeeds                                     |
| `updmeta`   | `MetadataUpdateEvent { id, old_metadata, new_metadata }`                                 | `update_metadata()` succeeds                               |
| `settags`   | `(prev_tags: Vec<String>, next_tags: Vec<String>)`                                       | `set_tags()` succeeds                                      |
| `setroyal`  | `(old_recipient: Option<Address>, new_recipient: Option<Address>)`                       | `set_royalty_recipient()` succeeds                         |
| `transfer`  | `(previous_owner: Address, new_owner: Address)`                                          | `transfer_ownership()` or `accept_transfer()` succeeds     |
| `propose`   | `(owner: Address, proposed: Address)`                                                    | `propose_transfer()` succeeds                              |
| `cancel`    | `owner: Address`                                                                         | `cancel_transfer()` succeeds                               |
| `setlisted` | `(old_listed: bool, new_listed: bool)`                                                   | `set_listed()` (and `delist()`) succeeds                   |
| `emdelist` | `EmergencyDelistEvent { id, admin, reason }`                                             | `emergency_delist()` succeeds                             |
| `setterms`  | `terms_hash: String`                                                                     | `set_terms_hash()` succeeds                                |
| `setregt`   | `terms_hash: String`                                                                     | `set_registry_terms_hash()` succeeds                       |
| `setadmin`  | `new_admin: Address`                                                                     | The first (bootstrap) `nominate_new_admin()` call succeeds |
| `setrecov` | `recovery_admin: Option<Address>` | `bootstrap_dual_admin()` or `set_recovery_admin()` succeeds |
| `recover` | `(old_admin: Address, new_admin: Address)` | `recover_admin()` succeeds |
| `setptrs` | `MetadataPointers { pointers, primary }` (topic carries resource id) | `set_metadata_pointers()` succeeds |
| `nomadmin`  | `new_admin: Address`                                                                     | A subsequent `nominate_new_admin()` call succeeds          |
| `accadmin`  | `new_admin: Address`                                                                     | `accept_admin()` succeeds                                  |
| `netinit`   | `network_id: BytesN<32>`                                                                 | `initialize_network()` succeeds                            |
| `freeze`    | `()`                                                                                     | `freeze_metadata()` succeeds                               |
| `verify`    | `(old_status: VerificationStatus, new_status: VerificationStatus, attestation_hash: Option<String>)` | `set_verification_status()` succeeds                       |
| `addverif` | `RoleChange { admin, target, granted: true }` (topic also carries target) | `add_verifier()` succeeds |
| `rmverif` | `RoleChange { admin, target, granted: false }` (topic also carries target) | `remove_verifier()` succeeds |
| `verrot`    | `VerifierRotation { old_verifier, new_verifier, ledger }`                               | `rotate_verifier()` succeeds                               |
| `reindex`   | `new_count: u32 (topic carries old_count: u32)`                                          | `repair_index()` succeeds                                  |
| `payment`   | `PaymentReceipt { receipt_id, resource_id, payer, amount, state, tx_hash, recorded_at }` | `record_payment()` succeeds                                |
| `settle`    | `PaymentReceipt { receipt_id, resource_id, payer, amount, state, tx_hash, recorded_at }` | `settle_payment()` succeeds                                |
| `addsettlr` | `RoleChange { admin, target, granted: true }` (topic also carries target) | `add_settler()` succeeds |
| `rmsettlr` | `RoleChange { admin, target, granted: false }` (topic also carries target) | `remove_settler()` succeeds |
| `pause`     | `(paused: bool, admin: Address)`                                                         | `set_paused()` succeeds (including no-op transitions)      |
| `pause_until` | `(pause_until: u64, admin: Address)`                                                   | `set_paused_until()` succeeds                              |
| `anchor`    | `PurchaseReceiptAnchor { resource_id, buyer, receipt_hash, ledger }`                     | `anchor_purchase_receipt()` succeeds                       |
| `anchrfail` | `AnchorFailure { resource_id, buyer, receipt_hash, reason, ledger }`                     | `attempt_anchor_purchase_receipt()` rejects an anchor      |
| `addmod` | `RoleChange { admin, target, granted: true }` (topic also carries target) | `add_moderator()` succeeds |
| `rmmod` | `RoleChange { admin, target, granted: false }` (topic also carries target) | `remove_moderator()` succeeds |
| `flag`      | `FlagEvent { id, moderator, reason }`                                                    | `flag_resource()` succeeds                                 |
| `unflag`    | `resource id`                                                                            | `unflag_resource()` succeeds                               |
| `flagrsn`   | `(moderator: Address, reason_hash: String)`                                              | `set_flag_reason_hash()` succeeds                          |
| `flagwin`   | `window_ledgers: u32` | `set_flag_resolution_window()` succeeds |
| `flagfrc`   | `(admin: Address, deadline: u32)` | `force_resolve_flag()` succeeds |
| `nomemo`    | `(receipt_id: String, tx_hash: String)` | `record_payment()` succeeds without a provenance memo |
| `retagidx`  | `new_count: u32`                                                                         | `repair_tag_index()` succeeds                              |
| `reactive`  | `resource id`                                                                             | `reactivate_resource()` succeeds                           |
| `setfee`    | `FeeConfigUpdated { old_config, new_config }`                                            | `set_fee_config()` or `set_fee_recipient()` succeeds       |
| `setdest`   | `FeeDestinationUpdated { old_destination, new_destination, ledger }`                    | `set_fee_destination()` succeeds                          |
| `ttlext`    | `()`                                                                                     | `extend_resource_ttl()` succeeds                           |
| `txfrterms` | `TransferWithTermsEvent { id, previous_owner, new_owner, terms_hash, attestation_reset }` | `transfer_ownership_with_terms()` succeeds                |

The `setlisted` event payload is a two-element tuple `(old_listed, new_listed)` so
listeners can determine the transition direction without querying additional state:

| Transition            | `(old, new)`     |
| --------------------- | ---------------- |
| Delist (was listed)   | `(true, false)`  |
| Relist (was delisted) | `(false, true)`  |
| No-op relist          | `(true, true)`   |
| No-op delist          | `(false, false)` |

Both `set_listed(id, false)` and `delist(id)` produce an identical `setlisted`
event — `delist` is a thin convenience wrapper that calls `set_listed`.
For backwards compatibility, no-op listing calls still emit the corresponding
`setlisted` event but do not count as lifecycle transitions.

An admin emergency delist is **not** a `setlisted` event. It goes through
`emergency_delist(id, admin, reason)` and emits `emdelist` with
`EmergencyDelistEvent { id, admin, reason }`, so an indexer can tell the two
apart by topic alone and attribute the takedown to `admin` with the stated
`reason`. `reason` is free-form and is not length-validated: the caller is the
authenticated current admin, so an oversized value costs that admin their own
transaction fee rather than enabling griefing. Note that a failed
`emergency_delist` (wrong admin, resource not `Disputed`) emits nothing at all.

The `retagidx` event is the audit signal that a `repair_tag_index` run actually
performed work — its payload is the number of ids processed. An empty id list is
a no-op that emits **no** `retagidx` event, so "no event" is an unambiguous "no
repair performed" and must not be read as "the tag index is now empty".

### Resource lifecycle state machine

New resources start in `Listed`. `listed` is maintained as a compatibility
projection and is `true` only in that state. `freeze_metadata()` is independent:
it makes the metadata pointer immutable but does not change `ResourceState`.

```text
Listed <--> Delisted
  |  \       |   \
  |   \      |    \
  v    v     v     v
Frozen ----> Disputed ---> Tombstoned
  ^            |
  |            v
  +------ Listed/Delisted/Frozen
```

| Current state | Allowed next states                            | Authorized actor                                                                         |
| ------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Listed`      | `Delisted`, `Frozen`, `Disputed`, `Tombstoned` | creator for `Delisted`/`Frozen`; admin for `Disputed`/`Tombstoned`                       |
| `Delisted`    | `Listed`, `Frozen`, `Disputed`, `Tombstoned`   | creator for `Listed`/`Frozen`; admin for `Disputed`/`Tombstoned`                         |
| `Frozen`      | `Listed`, `Disputed`, `Tombstoned`             | creator for `Listed` (via `reactivate_resource`); admin for `Disputed`/`Tombstoned`      |
| `Disputed`    | `Listed`, `Delisted`, `Frozen`, `Tombstoned`   | admin                                                                                    |
| `Tombstoned`  | none                                           | —                                                                                        |

Transition matrix:

| From \ To     | `Listed` | `Delisted` | `Frozen` | `Disputed` | `Tombstoned` |
| ------------- | -------- | ---------- | -------- | ---------- | ------------ |
| `Listed`      | no-op via `set_listed(true)` | creator | creator | admin | admin |
| `Delisted`    | creator | no-op via `set_listed(false)` | creator | admin | admin |
| `Frozen`      | creator via `reactivate_resource` | no | no | admin | admin |
| `Disputed`    | admin via `resolve_dispute` | admin via `resolve_dispute` | admin via `resolve_dispute` | no | admin |
| `Tombstoned`  | no | no | no | no | terminal |

Use `set_listed(id, true|false)` for the creator-controlled listed/delisted
transitions and `freeze_resource(id)` to enter `Frozen`. Use
`reactivate_resource(id)` to return a resource that was resolved out of a
dispute (or otherwise left inactive) back to `Listed`. The current admin uses
`open_dispute(id, admin)`, `resolve_dispute(id, admin, state)`, and
`tombstone_resource(id, admin)` for moderation transitions.

`Frozen`, `Disputed`, and `Tombstoned` resources are excluded from
`list_listed`. Tombstoning additionally purges the resource from every derived
listing index the contract can prune in bounded gas:

| Index                               | On tombstone | Effect                                                                     |
| ----------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `TagIndex(tag)`                     | purged       | Drops out of `list_by_tag`.                                                |
| `CreatorResources` / `CreatorCount` | purged       | Drops out of `list_by_creator`; `creator_resource_count` decrements.       |
| `CreatorListedCount`                | decremented  | Only when the resource was `Listed`; `creator_listed_count` drops by one.  |
| `MemoHash(id)`                      | untouched    | `get_memo_hash` keeps returning the registration memo hash for audit.      |
| `Index(u32)` / `Count`              | untouched    | `count()` stays monotonic and `list`/`list_page` remain a full audit view. |
| `Resource(id)`                      | untouched    | Still readable through `get` for audit purposes.                           |

The catalog `Index`/`Count` pair is deliberately left alone: `Count` is
monotonic by design, and locating a resource's slot in the insertion-ordered
index would cost a scan proportional to the catalog size. Use `repair_index`
if that pair ever needs rebuilding. Creator mutations to price, metadata, tags, or ownership fail with
`ResourceNotMutable` in those states. All invalid state changes, including
attempts to exit `Tombstoned` or to reactivate a `Disputed` resource before an
admin resolution, fail with `InvalidLifecycleTransition`.

The `updmeta` event carries structured data so that off-chain indexers can build
a full audit trail without querying historical ledger state:

```rust
pub struct MetadataUpdateEvent {
    pub id: String,           // the resource id
    pub old_metadata: String, // metadata pointer before the update
    pub new_metadata: String, // metadata pointer after the update
}
```

The `settags` event emits both previous and next tags, enabling indexers
to detect tag removals and reconcile state changes without requiring full history
scans.

### Stable cursors for filtered listings

`list_listed`, `list_by_dispute_status`, `list_by_creator`, and `list_by_tag`
return a bare `Vec<Resource>`, which tempts a client into computing the next
`start` as `start + items.len()`. For the filtered catalog scans that count is
wrong whenever a slot was skipped, and for any of them a state change between
two pages (a dispute flag flipping, a resource being delisted) can skip or
repeat an entry. The `*_page` variants fix the cursor domain instead:

| Listing                                       | Cursor                    | Why it is stable                                                                                                                                                                                |
| --------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_page`, `list_listed_page`, `list_by_dispute_status_page`, `list_by_verification_status` | catalog index (`u32`)     | `Index(i)` slots are append-only and never renumbered, so `next_cursor` names a slot, not a count of matches. Each slot is visited once; its state at that moment decides whether it is returned. |
| `list_by_creator_page`, `list_by_tag_page`    | `IdCursor` (id-based)     | The backing vectors shift when an entry is removed. The cursor records the last id returned; resuming re-finds it (or, if it was removed too, the first entry registered after it).              |

A flag that flips between two `list_by_dispute_status_page` calls therefore
lands the resource in at most one of them: the page whose scan reached its
slot while the flag matched. The unpaged functions keep their signatures for
existing callers; document their `start` as a catalog index, never as a match
count.

### Payments require a listed resource

`record_payment` and `record_payment_idempotent` reject a resource that is not
in the `Listed` state with `ResourceNotMutable`: a buyer must not be able to
pay for content the creator has delisted or frozen, or that an admin has put
under dispute or tombstoned. The check runs after the existence check
(`NotFound`) and before the price consistency check. A retry of an already
recorded receipt through `record_payment_idempotent` still returns the stored
receipt after the resource leaves `Listed`: the guard applies to new receipts
only. `buy_lease` and `record_lease` apply the same rule.

### Reporting anchor failures

`anchor_purchase_receipt` returns an `Error` when an anchor cannot be written,
and a Soroban error rolls the whole invocation back — emitted events included.
A settlement service anchoring many receipts in one transaction therefore loses
both the anchors that would have succeeded and any on-chain record of what went
wrong.

`attempt_anchor_purchase_receipt` is the reporting variant. It performs exactly
the same checks, but turns the three _data_ failures into an `anchrfail` event
and a `false` return instead of reverting:

| Rejected because                           | `AnchorFailureReason` | `anchor_purchase_receipt` returns |
| ------------------------------------------ | --------------------- | --------------------------------- |
| No resource registered under `resource_id` | `ResourceNotFound`    | `NotFound`                        |
| `receipt_hash` empty or over 128 bytes     | `InvalidReceiptHash`  | `InvalidTxHash`                   |
| `(resource_id, buyer)` already anchored    | `DuplicateReceipt`    | `DuplicateReceipt`                |

Authorization is never downgraded to an event: a caller without the verifier
role, or one supplying a malformed `resource_id`, still reverts, so an address
that cannot anchor cannot write to the event log either. A rejected attempt
leaves any existing anchor for the pair untouched.

Rejected attempts are counted per `(resource_id, buyer)` in
`DataKey::AnchorAttempts`, readable through `get_anchor_attempts`, so a
settlement job that keeps retrying a permanently failing pair is throttled
instead of re-running the data checks on every ledger:

| Situation                                                              | `AnchorFailureReason` | Effect                                                                              |
| ---------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| Retry fewer than `ANCHOR_RETRY_BACKOFF_LEDGERS` (12) ledgers after the last rejection | `RetryTooSoon`        | `anchrfail`, `false`; nothing written, data checks not run                          |
| `MAX_ANCHOR_ATTEMPTS` (5) rejections accumulated                       | `AttemptsExhausted`   | `anchrfail`, `false`; nothing written, data checks not run                          |
| A data rejection that brings the count to `MAX_ANCHOR_ATTEMPTS`        | (the data reason)     | `anchrfail` plus one `anchrxhst` whose topics name the pair and whose data is the final `AnchorAttempts` |
| An anchor is written for the pair (either entry point)                 | —                     | The pair's attempt history is deleted                                               |

Both throttling reasons exist only on this reporting path;
`AnchorFailureReason::as_error` maps them to `InvalidPaymentTransition` so the
mapping stays total.

```rust
pub struct AnchorAttempts {
    pub attempts: u32,            // rejected attempts so far, never above MAX_ANCHOR_ATTEMPTS
    pub last_attempt_ledger: u32, // ledger of the most recent rejection
}
```

```rust
pub struct AnchorFailure {
    pub resource_id: String,
    pub buyer: Address,
    pub receipt_hash: String,      // the hash that was rejected, not the stored one
    pub reason: AnchorFailureReason,
    pub ledger: u32,               // ledger sequence the attempt was rejected at
}
```

### Time-limited access leases

A lease is the on-chain half of the access-lease design: an entitlement
"`holder` may access `resource_id` until `expiry_ledger`", keyed by
`DataKey::Lease(resource_id, holder)`, with one lease per pair at a time.
Settlement stays off-chain (USDC moves buyer to creator exactly as it does for
per-request purchases); the registry records the window and lets anyone check
it with a single read.

```rust
pub enum LeaseTier { Hour, Day, Week }
pub enum LeaseState { Pending, Active, Revoked }

pub struct Lease {
    pub resource_id: String,
    pub holder: Address,
    pub tier: LeaseTier,
    pub start_ledger: u32,  // ledger the window opened (the recording ledger)
    pub expiry_ledger: u32, // first ledger at which access is gone
    pub amount: i128,       // USDC stroops paid; equals lease_price at recording time
    pub tx_hash: String,    // settlement transaction hash, 1-128 bytes
    pub state: LeaseState,
    pub recorded_at: u32,
}
```

| Tier   | Duration (`LEASE_*_LEDGERS`)    | Price (`lease_price`)  |
| ------ | ------------------------------- | ---------------------- |
| `Hour` | 720 ledgers                     | 1 × per-request price  |
| `Day`  | 17 280 ledgers                  | 5 × per-request price  |
| `Week` | 120 960 ledgers                 | 20 × per-request price |

Two entry points write a lease. `buy_lease` is the holder's own path: it
records the lease as `Pending` with the hash of the USDC transfer the holder
made, and a settler promotes it with `settle_lease` once that transfer is
confirmed. `record_lease` is the settler's path for payments it has already
confirmed (an x402 settlement, for example) and writes the lease `Active`
directly. Both require a `Listed` resource, `amount == lease_price`, and no
pending or unexpired active lease for the pair; an expired or revoked lease
is replaced.

```text
Pending --settle_lease--> Active --(ledger >= expiry_ledger)--> expired
   |                        |
   +------revoke_lease------+--> Revoked (terminal)
```

`lease_is_active` is the read a paywall needs: `true` only while the lease is
`Active` and the current ledger is below `expiry_ledger`. Expiry is purely
ledger-based; nothing renews a lease. The creator revokes with `revoke_lease`,
which takes effect in the same ledger. `get_lease` returns the record in any
state for audit.

### Retry-safe payment recording

`record_payment` keys each receipt by its caller-assigned `receipt_id` and
rejects a second call with the same id as `ReceiptAlreadyExists`. That keeps
receipts unique, but it means a settlement service that retries after a timeout
or a restart cannot tell a duplicate from a payment it already recorded without
first calling `get_payment`.

`record_payment_idempotent` takes the same arguments and runs the same checks
in the same order (settler role and auth, `receipt_id` shape, payer auth,
pause, resource id, amount, `tx_hash` shape), then looks the id up:

| Stored receipt for `receipt_id`                                  | Result                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| None                                                             | Recorded exactly as `record_payment` would; emits `payment`; returns it |
| Same `resource_id`, `payer`, `amount`, and `tx_hash`             | Returns the stored receipt as it is now; no write, no event             |
| Any of `resource_id`, `payer`, `amount`, or `tx_hash` different  | `ReceiptAlreadyExists`                                                  |

A retry is answered from the stored receipt, so it keeps working after the
receipt has been settled (it comes back `Settled`) or the resource's price has
changed since. It is still a write entry point, so it returns `ContractPaused`
while the registry is paused, retry or not. A new `receipt_id` whose `tx_hash`
already backs another receipt errors `DuplicateTxHash`, as with
`record_payment`.

`record_payment` itself is unchanged: callers that want a duplicate id to be an
error keep calling it.

### Moderation state in one read

`flag_details(id)` returns everything a moderation consumer needs in one call,
instead of `get` for the flag, `get_flag_reason_hash` (which errors when no hash
is set), and the `flag` / `unflag` / `flagrsn` event history for who acted.
`is_flagged(id)` answers only whether a flag is active.

```rust
pub struct FlagDetails {
    pub dispute_flag: DisputeFlag,        // NoFlag, or Flagged(reason)
    pub reason_hash: Option<String>,      // set by set_flag_reason_hash; unflagging does not clear it
    pub last_moderator: Option<Address>,  // moderator of the last flag_resource / unflag_resource / set_flag_reason_hash
}
```

`last_moderator` is stored under `DataKey::FlagModerator(id)` and written by
each of those three moderator calls. Rejected calls and creator writes leave it
unchanged. Resources flagged before this key existed report `None` until a
moderator next acts on them. Both reads error `InvalidResourceId` or `NotFound`
like `get`, and stay available while the registry is paused.

### Registry info (discovery)

```rust
pub struct RegistryInfo {
    pub name: String,                  // stable registry name ("mindvault-vault-registry")
    pub version: String,               // contract crate version (Cargo.toml, CARGO_PKG_VERSION)
    pub resource_schema_version: u32,  // version of the on-chain Resource schema
    pub network_id: BytesN<32>,        // env.ledger().network_id() of the ledger this is deployed on
}
```

`registry_info()` lets an agent/client discover which registry it's talking to —
and confirm it's the network it expects — without hardcoding assumptions or a
separate config lookup. It always succeeds; there is no error case.

For feature detection, `resource_schema_version()` returns
`RESOURCE_SCHEMA_VERSION` as a bare `u32`, so clients can gate on
`resource_schema_version() >= N` without decoding `contract_version()` or
`registry_info()`.

### Deployment network guard

| Constant                   | Value                        | Description                                           |
| -------------------------- | ---------------------------- | ----------------------------------------------------- |
| `MAX_METADATA_POINTER_LEN` | `512`                        | Maximum length of the metadata pointer in bytes.      |
| `MAX_TERMS_HASH_LEN`       | `64`                         | Maximum length of the creator terms hash in bytes.    |
| `MAX_TX_HASH_LEN`          | `128`                        | Maximum length of a payment receipt tx hash in bytes. |
| `MAX_PRICE`                | `1_000_000_000_000_000_000`  | Maximum price in USDC base units (100 billion USDC).   |
| `LIST_PAGE_CAP`            | `20`                         | Maximum items returned per page by all `list*` calls. |
| `MAX_ANCHOR_ATTEMPTS`      | `5`                          | Rejected `attempt_anchor_purchase_receipt` calls allowed per `(resource_id, buyer)` before the pair fails fast. |
| `ANCHOR_RETRY_BACKOFF_LEDGERS` | `12`                     | Minimum ledgers between two rejected anchor attempts for the same pair. |
| `LEASE_HOUR_LEDGERS` / `LEASE_DAY_LEDGERS` / `LEASE_WEEK_LEDGERS` | `720` / `17280` / `120960` | Lease duration per `LeaseTier`. |
| `LEASE_HOUR_MULTIPLIER` / `LEASE_DAY_MULTIPLIER` / `LEASE_WEEK_MULTIPLIER` | `1` / `5` / `20` | Lease price multiplier over the per-request price, per `LeaseTier`. |
| `RESOURCE_SCHEMA_VERSION`  | `2`                          | Current `Resource` schema version (tags added in v2). |
| `REGISTRY_NAME`            | `"mindvault-vault-registry"` | Stable name returned by `registry_info()`.            |

Before a deployment is used, call
`initialize_network(env.ledger().network_id())` once. The contract records the
value only when it matches the executing ledger's network ID. This prevents a
deployment script from accidentally configuring a testnet contract with a
mainnet identifier (or the reverse).

- `initialize_network(network_id: BytesN<32>)` returns `NetworkIdMismatch` if
  the supplied ID differs from the current ledger, and
  `NetworkAlreadyInitialized` on any later call.
- `network_id()` returns the stored ID, or `NetworkNotInitialized` until the
  one-time initialization succeeds.

`registry_info().network_id` remains available before initialization as a
read-only observation of the current ledger; use `network_id()` when a client
must require an explicit deployment guard.

### Constants

| Constant                   | Value                        | Description                                                                                                                                  |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_METADATA_POINTER_LEN` | `512`                        | Maximum length of the metadata pointer, in bytes.                                                                                            |
| `MAX_TERMS_HASH_LEN`       | `64`                         | Maximum length of the creator terms hash, in bytes.                                                                                          |
| `MAX_TX_HASH_LEN`          | `128`                        | Maximum length of a payment receipt tx hash, in bytes.                                                                                       |
| `MAX_PRICE`                | `10^18`                      | Maximum price, in USDC base units (7 decimals).                                                                                               |
| `LIST_PAGE_CAP`            | `20`                         | Maximum items returned per page by all `list*` calls.                                                                                        |
| `MAX_ANCHOR_ATTEMPTS`      | `5`                          | Rejected `attempt_anchor_purchase_receipt` calls allowed per `(resource_id, buyer)` before the pair fails fast.                               |
| `ANCHOR_RETRY_BACKOFF_LEDGERS` | `12`                     | Minimum ledgers between two rejected anchor attempts for the same pair.                                                                      |
| `LEASE_HOUR_LEDGERS` / `LEASE_DAY_LEDGERS` / `LEASE_WEEK_LEDGERS` | `720` / `17280` / `120960` | Lease duration per `LeaseTier`.                                                                                          |
| `LEASE_HOUR_MULTIPLIER` / `LEASE_DAY_MULTIPLIER` / `LEASE_WEEK_MULTIPLIER` | `1` / `5` / `20` | Lease price multiplier over the per-request price, per `LeaseTier`.                                                     |
| `RESOURCE_SCHEMA_VERSION`  | `2`                          | Current `Resource` schema version (tags added in v2).                                                                                        |
| `REGISTRY_NAME`            | `"mindvault-vault-registry"` | Stable name returned by `registry_info()`.                                                                                                   |
| Constant                   | Value                        | Description                                                                                                                                  |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_METADATA_POINTER_LEN` | `512`                        | Maximum length of the metadata pointer in bytes.                                                                                             |
| `MAX_TERMS_HASH_LEN`       | `64`                         | Maximum length of the creator terms hash in bytes.                                                                                           |
| `MAX_PRICE`                | `1_000_000_000_000_000_000`  | Maximum price in USDC base units (100 billion USDC).                                                                                          |
| `RESOURCE_SCHEMA_VERSION`  | `6`                          | Current `Resource` schema version (`metadata_frozen_at` added in v6).                                                                        |
| `REGISTRY_NAME`            | `"mindvault-vault-registry"` | Stable name returned by `registry_info()`.                                                                                                   |
| `MAX_FEE_BPS`              | `5_000`                      | Maximum fee in basis points (50 %). Neither `platform_fee_bps` nor `royalty_bps` may exceed this individually, and their sum may not either. |
| `FEE_BPS_DENOM`            | `10_000`                     | Basis-point denominator. `amount * fee_bps / FEE_BPS_DENOM` converts a fee to a USDC base-unit amount.                                          |
| `MAX_FEE_DESTINATION_BPS`  | `10_000`                     | Maximum share of the platform fee routed to a burn or charity destination.                                                                         |
| `MIN_CREATOR_SHARE_BPS`    | `5_000`                      | Minimum creator payout share (50 %). `validate_price` requires `price > platform_fee_bps + royalty_bps`, guaranteeing the creator always receives a positive remainder of at least 50 % of each sale. |
| `ADMIN_NOMINATION_MIN_GAP` | `17_280` (≈1 day)            | Minimum ledger distance between `nominate_new_admin` and `accept_admin`. Prevents a compromised admin from batching both steps in a single transaction. |

`price` is an `i128` in **USDC base units** (7 decimal places, so
`10_000_000` base units = 1 USDC). A USDC base unit is *not* a stroop: a
stroop is 10^-5 XLM, so scaling by 10^5 would be a 100x error. The canonical
conversion factor is `USDC_BASE_UNITS_PER_USDC`.
Examples: `1_000_000` = 0.10 USDC, `10_000_000` = 1.00 USDC, `500_000` = 0.05 USDC.

### WASM size budget

This contract enforces a strictly tracked optimized WASM size budget in CI
(`stellar contract build --optimize`). Currently the limit is **114,688 bytes
(112 KB)**, against a current optimized size of ~107 KB.

The budget has been raised as the surface grew: from a stale 10 KB figure to
28 KB (tags, pagination, admin, terms hashes), to 36 KB (`registry_info`, the
verifier role, the on-chain verification mirror, metadata freeze, index
repair), and to 96 KB for everything that landed after that — the lifecycle
state machine, the moderator role and dispute flags, fee config, the tag index
and its repair, the deployment network guard, payment receipts and the settler
role, purchase receipt anchoring, and the emergency pause. That last raise was
overdue: the crate did not compile for a stretch, so the 36 KB gate could not
be measured against the code it was meant to guard. The raise to 112 KB came
with time-limited access leases, the anchor attempt cap and back-off, and the
cursor-based `*_page` listings: twelve new methods and six new types took the
build from ~91 KB to ~107 KB, almost entirely spec entries and generated XDR
conversions, with the release profile already at `opt-level = "z"`, LTO, one
codegen unit and stripped symbols. If genuine feature
additions push past the current limit, raise `MAX_SIZE` in
`.github/workflows/contract-ci.yml` (and `MAX` in
`contracts/vault-registry/Makefile`) and explain the growth in your PR
description.

### Storage footprint

The WASM budget above covers code size; it says nothing about what the contract
_stores_, which is what Soroban charges rent for. The
`storage_footprint_report` test measures the XDR size of every ledger entry
class the registry writes and fails when one grows past its budget:

```bash
cd contracts/vault-registry && make footprint
```

See [`docs/contract-storage-footprint.md`](../docs/contract-storage-footprint.md)
for the current table, per-operation aggregates, and the procedure for raising
a budget deliberately.

### Emergency pause

The contract supports an admin-controlled emergency pause via `set_paused(admin, bool)`.
`set_paused(admin, true)` creates an indefinite pause, while
`set_paused_until(admin, pause_until)` schedules a pause until an absolute Unix
ledger timestamp in seconds. A deadline at or before the current ledger timestamp
resumes immediately; once the ledger reaches a future deadline, the registry
automatically resumes without a separate transaction.

When paused, every write method (`register`, `set_price`, `update_metadata`,
`freeze_metadata`, `set_verification_status`, `set_tags`, `transfer_ownership`,
`propose_transfer`, `accept_transfer`, `cancel_transfer`, `set_listed`, `delist`,
`repair_index`, `set_terms_hash`, `record_payment`, `record_payment_idempotent`)
returns `Error::ContractPaused` (code `40`) without modifying any state.

Read-only methods (`get`, `exists`, `list*`, `count`, `get_owner`, `registry_info`,
`contract_version`, `get_terms_hash`, `get_payment_receipt`, `is_flagged`,
`flag_details`, `is_paused`, `is_verifier`, `admin`, `pending_admin`) remain
available while paused.

`is_paused()` returns the current effective pause state, and `pause_until()` returns
the active scheduled deadline when one exists. `set_paused` emits a `pause` event
with data `(paused: bool, admin: Address)` on every call, including no-op
transitions. `set_paused_until` additionally emits a `pause_until` event with
data `(pause_until: u64, admin: Address)`.

Only the current admin can call `set_paused`. Errors `AdminNotSet` if no admin
has been set, or `Unauthorized` if the caller does not match the stored admin.

### Generating bindings

The TypeScript client bindings must stay in sync with the contract interface. If you
change the contract signature, regenerate them:

```bash
CONTRACT_WASM=contract/target/wasm32v1-none/release/vault_registry.wasm pnpm contract:bindings
```

> [!IMPORTANT]
> CI strictly enforces binding freshness. If you forget to run this script and commit
> the updated `packages/registry-client/src/generated/index.ts`, the `Contract CI`
> workflow will fail.

### Develop

From the repository root, run the contract tests with:

```bash
cd contract && cargo test
```

The package-level build-and-test command is:

```bash
cd contract/contracts/vault-registry && make test
```

To build the WASM directly:

```bash
cd contract && stellar contract build --manifest-path Cargo.toml
```

### Deploy (testnet)

> [!IMPORTANT]
> Before deploying a new WASM to any network, complete the full
> **[Contract Upgrade Checklist](../docs/contract-upgrade-checklist.md)** — it
> covers build verification, WASM size budget, network identity checks, binding
> regeneration, admin role bootstrap, and post-deploy smoke tests.
> Run `make preflight` from `contract/contracts/vault-registry/` to execute
> all locally-verifiable steps in one command.

```bash
# One-time: create & fund an identity
stellar keys generate deployer --network testnet --fund

stellar contract deploy \
  --wasm target/wasm32v1-none/release/vault_registry.wasm \
  --source deployer \
  --network testnet
```

The command prints the deployed contract ID — wire it into the server config so
the backend can record resources on registration.

### Testnet Deployment

The current canonical testnet deployment:

| Field            | Value                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Contract ID      | `CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4`                                                                  |
| Wasm Hash        | `fa60c0c2086fddf6add8abc7e1b191e1368ed62983f4e967069fc4b4d679c8eb`                                                          |
| Deployer Address | `GDAL5CGX7PU56PS2GJW65JNZSN7VLWI6R7H7E3G2HVS5R6XQQI2NJX34`                                                                  |
| Network          | Stellar Testnet (`Test SDF Network ; September 2015`)                                                                       |
| Soroban RPC      | `https://soroban-testnet.stellar.org`                                                                                       |
| Deployment Date  | 2026-05-27                                                                                                                  |
| Explorer         | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4) |

Set `VAULT_REGISTRY_CONTRACT_ID` and `SOROBAN_RPC_URL` in the server `.env`
(see [`server/.env.example`](../server/.env.example)) so the backend can
record/read resources on this contract.

> [!NOTE]
> This deployment predates `registry_info()`, `creator_resource_count()`,
> `list_by_creator()`, and the two-step admin model. Redeploy and update this
> table's Contract ID / Wasm Hash after shipping those changes to testnet.

### Emergency pause

See [contract-registry-pause-decision.md](../docs/contract-registry-pause-decision.md)
for the original architecture spike. The pause feature is now implemented — see the
**Emergency pause** section above for the full API.

> **Note:** the deployment above predates `tags`, the two-step admin/transfer
> flows, `creator_resource_count`, terms hashes, the verifier role, the
> on-chain verification mirror, metadata freezing, and index repair
> described in this README. Redeploy from current source and update this
> table (plus `VAULT_REGISTRY_CONTRACT_ID` and the generated TS bindings via
> `pnpm contract:bindings`) to pick them up.

### Ideas for contributors

- Optional escrow/refund extension (see the root README's "Not Yet Built").
- Tag-based discovery (`list_by_tag`) — see
  [`docs/tag-index-repair-design.md`](../docs/tag-index-repair-design.md) for
  the repair contract an on-chain tag index must satisfy before it ships.
