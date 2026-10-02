# vault-registry — Client Invocation Examples

This document shows how to invoke the vault-registry Soroban contract from
three common surfaces: the Stellar CLI, the generated TypeScript SDK, and the
Rust test client used in `src/test.rs`.

For the full function reference, error code table, event schema, and constants
see [`contract/README.md`](../../README.md).

---

## Constants quick-reference

| Symbol              | Value                                                      | Notes                                                  |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Testnet contract ID | `CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4` | Soroban testnet                                        |
| Soroban RPC         | `https://soroban-testnet.stellar.org`                      |                                                        |
| 1 USDC              | `10_000_000` base units                                    | `price` field uses 7 decimal places                    |
| 0.10 USDC           | `1_000_000` base units                                     |                                                        |
| Max price           | `1_000_000_000_000_000_000` base units                     | 100 billion USDC (10^18 units at 7 decimals)           |
| Max metadata        | 512 bytes                                                  | Must start with a supported prefix (see below)         |
| Max tags            | 8                                                          | Each max 32 bytes, normalized to lowercase ASCII       |
| Max top tags        | 20                                                         | `top_tags` response cap; counts saturate at `u32::MAX` |

**Metadata pointer prefixes accepted:** `ipfs://`, `ar://`, `https://`,
`http://`, `sha256:`, `sha-256:`, `0x`.

### USDC units

Every USDC amount in this crate — `Resource::price`, `PaymentReceipt::amount`,
royalty and fee amounts — is an integer count of **USDC base units**, at
`USDC_DECIMALS = 7` decimal places. 1 USDC is `10_000_000` base units, the
precision of Stellar's USDC SAC. `USDC_BASE_UNITS_PER_USDC` is the constant the
code uses for the conversion, and `record_payment` compares `amount` against
`price` directly, so the two must be in the same unit — a receipt in a
different decimal scale is rejected with `PaymentAmountMismatch` rather than
silently recorded.

**Do not call these "stroops."** A stroop is 10⁻⁵ **XLM**. USDC shares XLM's
decimal _count_ but not its unit, so dividing a USDC base-unit amount by
10⁵ is a 100x error, and reading it as 6 decimals is a 10x one. The on-chain
integer is unambiguous; only the prose was not, which is what this section
exists to fix. The TypeScript layer still uses `stroopsToUsdc` /
`usdcToStroops` as function names for the same 10⁻⁷ quantity — see
`docs/mcp-usdc-units.md` — but they are USDC base units there too.

### Canonical tag normalization

Tags are the registry's discovery labels. They are normalized to a canonical
form before they are stored or used to build the tag index, so clients never
need to worry about case or surrounding whitespace:

- **Lowercased to ASCII.** `"Dataset"`, `"dataset"` and `"DATASET"` are all the
  same tag; lookup via `list_by_tag` is case-insensitive.
- **ASCII whitespace is trimmed** from both ends. A tag like `" finance "` is
  stored and indexed as `"finance"`.
- **At most 8 tags** per resource (`MAX_TAGS`).
- **Each tag is 1–32 bytes** (`MAX_TAG_LEN`). Empty tags are rejected.
- **Duplicates are rejected in normalized form.** Two distinct inputs that
  normalize to the same value (for example `"ML"` and `"ml"`) would index a
  resource twice under one tag, so `register`/`set_tags` reject them with
  `InvalidTag` rather than allowing a self-duplicate index entry.

When you read a resource back, `resource.tags` already holds the normalized
values, so comparing them against your input string is safe.

### Tag popularity

`top_tags(limit)` returns `TagPopularity { tag, count }` entries sorted by
descending count, with lexicographic tag order for ties. The contract keeps a
per-tag counter and a bounded top-N materialized view. The response is capped
at `TOP_TAGS_CAP` (20), and a zero limit returns an empty result. Counts are
successful registrations carrying the tag at registration time; `set_tags` and
tombstoning do not rewrite the historical signal. Resources already stored when
this feature is installed are not backfilled because their original tags cannot
be reconstructed after `set_tags`; counters cover registrations processed after
introduction. Counters saturate at `u32::MAX`, and failed registrations do not
increment them.

---

## Storage TTL threshold constants

Soroban charges rent for stored data and **archives** any entry whose
time-to-live (TTL) reaches zero. An archived entry is not lost, but it stops
being readable until someone pays to restore it — a registered resource would
simply stop resolving. The registry defends against that by re-extending the
TTL of every entry it touches.

Three constants in [`src/lib.rs`](src/lib.rs) define that policy:

| Constant             | Value     | In time  | Meaning                                                     |
| -------------------- | --------- | -------- | ----------------------------------------------------------- |
| `DAY_IN_LEDGERS`     | `17_280`  | ~1 day   | Ledgers per day at Stellar's ~5-second close time.          |
| `BUMP_AMOUNT`        | `518_400` | ~30 days | The TTL an entry is extended **to** when it is bumped.      |
| `LIFETIME_THRESHOLD` | `501_120` | ~29 days | Bump only once the remaining TTL has fallen **below** this. |

All three are private to the crate — they are policy, not API. Clients read the
resulting TTL from the ledger rather than recomputing it.

### How a bump works

Every storage touch goes through one of two helpers, both of which call
Soroban's `extend_ttl(threshold, extend_to)`:

- `bump_persistent(key)` — for a single persistent entry (a resource, a tag
  index, a creator's resource list, a payment receipt).
- `bump_instance()` — for the contract's instance storage (admin, verifier and
  moderator roles, fee config, network id).

`extend_ttl` is conditional: it extends the entry to `BUMP_AMOUNT` **only if**
the remaining TTL is already below `LIFETIME_THRESHOLD`. Because the two differ
by exactly `DAY_IN_LEDGERS`, an entry written and then read again within the
same day is not re-extended — the bump is a no-op and costs nothing. Past that
first day, any touch resets the entry to a full ~30 days.

### What this means in practice

- **Writes always bump.** `register`, `set_price`, `update_metadata`,
  `set_tags`, `set_listed`, `transfer_ownership`, `record_payment` and the rest
  all extend the entries they write, so an actively-maintained resource is never
  archived.
- **Reads bump too.** `get`, `get_owner`, `exists_many`, `list`, `list_by_tag`
  and `get_payment_receipt` extend the entries they return. A resource that is
  merely popular stays alive without its creator doing anything.
- **A cold resource has ~30 days.** An entry that is neither read nor written
  for `BUMP_AMOUNT` ledgers is archived and stops resolving.
- **A creator can top up on demand.** `extend_resource_ttl(creator, id)` bumps a
  resource's entry without changing it, and emits a `ttlext` event. Only the
  current owner may call it.

### Changing these values

`LIFETIME_THRESHOLD` must stay below `BUMP_AMOUNT`; if they were equal, every
single read would rewrite the TTL and pay rent for no benefit. Raising
`BUMP_AMOUNT` raises the rent each write pays, and both are bounded by the
network's `max_entry_ttl` setting — a bump beyond that ceiling is rejected by
the host, so the contract would stop accepting writes entirely. Change them
together, and re-run `cargo test` in `contract/`: the TTL tests assert the
observed on-ledger TTL against these constants.

---

## Contract version compatibility

The registry reports two independent versions, and they answer different
questions. Read both with one call:

```bash
stellar contract invoke --id $CONTRACT --rpc-url $RPC \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- contract_version
# { "crate_version": "0.0.0", "resource_schema_version": 6 }
```

| Field                     | Source                    | Changes when                                                           |
| ------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `crate_version`           | `CARGO_PKG_VERSION`       | Any release of the crate — including bug fixes and internal refactors. |
| `resource_schema_version` | `RESOURCE_SCHEMA_VERSION` | The on-chain `Resource` struct changes shape.                          |

**Only `resource_schema_version` affects whether your client still decodes
correctly.** A `crate_version` bump on its own is always safe to ignore;
`registry_info` returns the same two values alongside the registry name and the
network id.

`Resource` also carries its own `schema_version` field, so an entry read from
the ledger states the shape it was written in without a second call.

### `Resource` schema history

The recorded schema changes are: **v2** added `tags`, **v4** added
`dispute_flag`, and **v6** added `metadata_frozen_at`. The changes behind v1,
v3 and v5 were never written down. Any future bump should add a row here,
naming the field that changed:

| Schema version | Change                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| 2              | Added `tags` — discovery labels, normalized to lowercase.               |
| 4              | Added `dispute_flag` — moderator dispute state.                         |
| 6              | Current value of `RESOURCE_SCHEMA_VERSION`.                             |
| 6              | Added `metadata_frozen_at`; current value of `RESOURCE_SCHEMA_VERSION`. |

### What is and is not a breaking change

Compatible — deployed clients keep working without changes:

- A new **method** on the contract. Existing calls are unaffected.
- A new **`DataKey` variant**. Existing entries keep their own keys, and nothing
  that reads them changes.
- A new **error code**, appended to the end of the enum. A client that does not
  recognise a code should report it rather than assume a meaning.

Breaking — clients must be updated, and stored state may need migrating:

- **Any change to the fields of `Resource`** — adding, removing, renaming, or
  retyping one. A `#[contracttype]` struct is encoded as a map keyed by field
  name and decoded strictly, so a decoder built for one field set will not read
  a value written with another. This is what `RESOURCE_SCHEMA_VERSION` is for:
  bump it, and regenerate the bindings.
- **Renaming a `DataKey` variant.** Variants are encoded by name, so a rename
  makes every entry written under the old name unreachable — the data is still
  on the ledger, but nothing looks for it any more. The storage-key migration
  tests in [`src/test.rs`](src/test.rs) fail on this deliberately.
- **Reusing an existing error code** for a different condition. Callers that
  branch on the numeric code will silently take the wrong branch.

### Checking compatibility before and after a deploy

Call `contract_version` against the deployed contract before upgrading and
again afterwards. If `resource_schema_version` changed, regenerate the client
bindings (`pnpm contract:bindings`) and update any code that decodes
`Resource` before pointing clients at the new deployment. The full sequence is
in [`docs/contract-upgrade-checklist.md`](../../../docs/contract-upgrade-checklist.md).

---

## Stellar CLI

The CLI is the fastest way to call the contract from a shell script or to
inspect state on testnet. All examples below use the canonical testnet
deployment. Substitute `--source` with your own funded identity.

```bash
# Convenience alias used in all examples below
CONTRACT=CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4
RPC=https://soroban-testnet.stellar.org
```

### Read-only calls (no transaction fee)

```bash
# How many resources are registered?
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- count

# Fetch a single resource by its ID
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- get --id swcn98besxpp6t1u8e77fqz3

# Check whether a resource exists (returns true/false without failing)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- exists --id swcn98besxpp6t1u8e77fqz3

# Fetch just the owner address
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- get_owner --id swcn98besxpp6t1u8e77fqz3

# Fetch several owner addresses in one call
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- get_owner_many --ids '["swcn98besxpp6t1u8e77fqz3","anotherresource"]'

# Registry discovery metadata (name, version, network id)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- registry_info

# Contract version (crate semver + resource schema version)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- contract_version
```

### Paginated listing

```bash
# First page — up to 20 resources, insertion order
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- list --start 0 --limit 20

# list_page — same but also returns next_cursor (None = end of list)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- list_page --cursor 0 --limit 10

# Listed-only resources (skip delisted)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- list_listed --start 0 --limit 20

# Resources owned by a specific creator
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- list_by_creator \
  --creator GB6LGS25QN3DFNXKFWCTKB3FMKZFLW7OIKCX6HJKKIEPV3H2JJKBIMHV \
  --start 0 --limit 20

# Resources tagged "dataset" (tag lookup is case-insensitive)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- list_by_tag --tag dataset --start 0 --limit 20

# Most-used tags by successful registration count
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- top_tags --limit 10

# Resources with an active moderator dispute flag
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- list_by_dispute_status --flagged true --start 0 --limit 20

# One resource's moderation state: dispute flag, reason hash, last moderator
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- flag_details --id swcn98besxpp6t1u8e77fqz3

# How many resources does a creator currently own?
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- creator_resource_count \
  --creator GB6LGS25QN3DFNXKFWCTKB3FMKZFLW7OIKCX6HJKKIEPV3H2JJKBIMHV
```

### Writing (requires a funded identity and network fees)

```bash
# Register a new resource at 1 USDC with IPFS metadata and two tags
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- register \
  --creator $(stellar keys address my-identity) \
  --id swcn98besxpp6t1u8e77fqz3 \
  --price 10000000 \
  --metadata 'ipfs://QmYwAPJzv5CZsnAzt8auV39tMVyQ4cZ3QqcSBuKkP3jRq8' \
  --tags '["dataset","research"]'

# Update the price to 0.50 USDC (5_000_000 base units)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- set_price \
  --id swcn98besxpp6t1u8e77fqz3 \
  --new-price 5000000

# Update the metadata pointer
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- update_metadata \
  --id swcn98besxpp6t1u8e77fqz3 \
  --metadata 'ipfs://QmNewHash'

# Replace discovery tags
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- set_tags \
  --id swcn98besxpp6t1u8e77fqz3 \
  --tags '["finance","api"]'

# Delist a resource from public discovery
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- delist --id swcn98besxpp6t1u8e77fqz3

# Re-list (set_listed accepts any bool)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- set_listed --id swcn98besxpp6t1u8e77fqz3 --listed true

# Permanently freeze the metadata pointer (irreversible)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- freeze_metadata --id swcn98besxpp6t1u8e77fqz3

# The resulting Resource has frozen = true and metadata_frozen_at set to the
# ledger sequence of the successful freeze_metadata call.

# Transfer ownership immediately
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source my-identity \
  -- transfer_ownership \
  --id swcn98besxpp6t1u8e77fqz3 \
  --new-creator GDNNUI6NWUQIGXFBACABSKCV7YKFZQT6XQMWUV2ZQEFVJC7C5N4KBIO

# Two-step transfer: propose then accept (new owner must sign accept_transfer)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source current-owner \
  -- propose_transfer \
  --id swcn98besxpp6t1u8e77fqz3 \
  --new-creator GDNNUI6NWUQIGXFBACABSKCV7YKFZQT6XQMWUV2ZQEFVJC7C5N4KBIO

stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source new-owner \
  -- accept_transfer --id swcn98besxpp6t1u8e77fqz3
```

### Admin bootstrap and verifier role

The very first `nominate_new_admin` call bootstraps the admin directly
(signed by `new_admin` itself, no accept step). Subsequent calls require the
current admin to sign and the nominee must call `accept_admin`.

```bash
# Bootstrap the initial admin (first-ever call — signed by new_admin)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source platform-admin \
  -- nominate_new_admin \
  --new-admin $(stellar keys address platform-admin)

# Rotate admin — nominate a successor (signed by current admin)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source platform-admin \
  -- nominate_new_admin \
  --new-admin GDNEWADMIN...

# Accept the nomination (signed by the pending admin)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source new-admin \
  -- accept_admin --new-admin $(stellar keys address new-admin)

# Grant verifier role (admin only)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source platform-admin \
  -- add_verifier \
  --verifier GDVERIFIER...

# Set on-chain verification status (verifier only)
# Allowed transitions: Pending→Verified, Pending→Rejected, Verified→Rejected, Rejected→Verified
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source verifier-identity \
  -- set_verification_status \
  --id swcn98besxpp6t1u8e77fqz3 \
  --verifier $(stellar keys address verifier-identity) \
  --status Verified

# Check whether an address holds the verifier role
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  -- is_verifier --address GDVERIFIER...

# Revoke verifier role (admin only)
stellar contract invoke \
  --id $CONTRACT --rpc-url $RPC --network-passphrase "Test SDF Network ; September 2015" \
  --source platform-admin \
  -- remove_verifier \
  --verifier GDVERIFIER...
```

---

## TypeScript SDK

The generated bindings live in
[`packages/registry-client/src/generated/index.ts`](../../../packages/registry-client/src/generated/index.ts).
Read-only calls are simulated on-chain (free); write calls must be signed and
submitted with `signAndSend()`.

### Updating Generated Bindings

When the contract interface changes, or when the contract is deployed to a new address, you must update the generated bindings:

- [ ] **Regenerate TypeScript bindings from the new WASM**
  ```bash
  # From the root directory:
  CONTRACT_WASM=contract/target/wasm32v1-none/release/vault_registry.wasm pnpm contract:bindings
  ```
- [ ] **Verify bindings against the deployed contract**
  ```bash
  pnpm --filter @mindvault/registry-client test
  ```
- [ ] **Commit the updated bindings** file (`packages/registry-client/src/generated/index.ts`).

### Setup

```typescript
import { Client as RegistryClient } from "@mindvault/registry-client";

const CONTRACT_ID = "CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4";
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const registry = new RegistryClient({
  contractId: CONTRACT_ID,
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
  // publicKey: "G...", // optional: caller address for auth-required calls
  // signTransaction: ..., // optional: signer function (Freighter, keypair, etc.)
});
```

### Reading contract state

```typescript
// Total registered resources
const countTx = await registry.count();
const total: number = countTx.result;

// Fetch a single resource
const getTx = await registry.get({ id: "swcn98besxpp6t1u8e77fqz3" });
if (getTx.result.isOk()) {
  const resource = getTx.result.unwrap();
  console.log(resource.id, resource.price, resource.metadata, resource.verified);
}

// Check existence without throwing
const existsTx = await registry.exists({ id: "swcn98besxpp6t1u8e77fqz3" });
const found: boolean = existsTx.result;

// Current owner
const ownerTx = await registry.get_owner({ id: "swcn98besxpp6t1u8e77fqz3" });
if (ownerTx.result.isOk()) {
  console.log("Owner:", ownerTx.result.unwrap());
}

// Batch owners for multi-select validation
const ownersTx = await registry.get_owner_many({
  ids: ["swcn98besxpp6t1u8e77fqz3", "anotherresource"],
});
const owners = ownersTx.result; // Array<string | null>

// Registry identity and capabilities
const infoTx = await registry.registry_info();
const info = infoTx.result;
console.log(info.name, info.version, info.resource_schema_version);
```

### Paginated listing

```typescript
// First page in insertion order (up to 20)
const listTx = await registry.list({ start: 0, limit: 20 });
const resources = listTx.result; // Array<Resource>

// list_page — returns items + next_cursor
const pageTx = await registry.list_page({ cursor: 0, limit: 10 });
const page = pageTx.result; // { items: Array<Resource>, next_cursor: number | null }
let cursor: number | null = page.next_cursor;

// Walk all pages
while (cursor !== null) {
  const nextPageTx = await registry.list_page({ cursor, limit: 10 });
  const nextPage = nextPageTx.result;
  // process nextPage.items ...
  cursor = nextPage.next_cursor;
}

// Listed-only resources
const listedTx = await registry.list_listed({ start: 0, limit: 20 });

// Resources owned by a creator
const byCreatorTx = await registry.list_by_creator({
  creator: "GB6LGS25QN3DFNXKFWCTKB3FMKZFLW7OIKCX6HJKKIEPV3H2JJKBIMHV",
  start: 0,
  limit: 20,
});

// Resources tagged "dataset" (normalized to lowercase before lookup)
const byTagTx = await registry.list_by_tag({
  tag: "dataset",
  start: 0,
  limit: 20,
});

// How many resources does a creator currently own?
const countByCreatorTx = await registry.creator_resource_count({
  creator: "GB6LGS25QN3DFNXKFWCTKB3FMKZFLW7OIKCX6HJKKIEPV3H2JJKBIMHV",
});
```

### Registering a resource (write + sign)

`price` is in USDC base units (7 decimal places): 1 USDC = `10_000_000`.

```typescript
// 1 USDC = 10_000_000 base units
const ONE_USDC = BigInt(10_000_000);

const tx = await registry.register({
  creator: "GB6LGS25QN3DFNXKFWCTKB3FMKZFLW7OIKCX6HJKKIEPV3H2JJKBIMHV",
  id: "swcn98besxpp6t1u8e77fqz3", // 1–24 lowercase alphanumeric (cuid2)
  price: ONE_USDC,
  metadata: "ipfs://QmYwAPJzv5CZsnAzt8auV39tMVyQ4cZ3QqcSBuKkP3jRq8",
  tags: ["dataset", "research"], // 0–8 tags, each ≤ 32 bytes; normalized to lowercase
});
await tx.signAndSend();
```

### Mutation examples

```typescript
const id = "swcn98besxpp6t1u8e77fqz3";

// Update price to 0.50 USDC
const priceTx = await registry.set_price({ id, new_price: BigInt(5_000_000) });
await priceTx.signAndSend();

// Update metadata pointer
const metaTx = await registry.update_metadata({
  id,
  metadata: "ipfs://QmNewHashAfterEdit",
});
await metaTx.signAndSend();

// Replace discovery tags
const tagsTx = await registry.set_tags({ id, tags: ["finance", "api"] });
await tagsTx.signAndSend();

// Delist (hide from public catalog)
const delistTx = await registry.delist({ id });
await delistTx.signAndSend();

// Re-list
const relistTx = await registry.set_listed({ id, listed: true });
await relistTx.signAndSend();

// Freeze metadata permanently (irreversible)
const freezeTx = await registry.freeze_metadata({ id });
await freezeTx.signAndSend();

// Transfer ownership immediately
const xferTx = await registry.transfer_ownership({
  id,
  new_creator: "GDNNUI6NWUQIGXFBACABSKCV7YKFZQT6XQMWUV2ZQEFVJC7C5N4KBIO",
});
await xferTx.signAndSend();
```

---

## Rust test client

In `src/test.rs` the SDK client is generated by `soroban-sdk` macros. The
patterns below match the helpers defined at the top of the test file.

```rust
use soroban_sdk::{Env, Address, String, Vec};

// Minimal test setup (see src/test.rs for full setup())
let env = Env::default();
env.mock_all_auths(); // skips real signature verification in tests
let contract_id = env.register(VaultRegistry, ());
let client = VaultRegistryClient::new(&env, &contract_id);
let creator = Address::generate(&env); // random test address

// Helper to build a Vec<String> of tags
fn tags(env: &Env, items: &[&str]) -> Vec<String> {
    let mut v = Vec::new(env);
    for item in items {
        v.push_back(String::from_str(env, item));
    }
    v
}
fn empty_tags(env: &Env) -> Vec<String> { Vec::new(env) }
```

### register + read

```rust
let id = String::from_str(&env, "swcn98besxpp6t1u8e77fqz3");
let metadata = String::from_str(&env, "ipfs://QmYwAPJzv5CZsnAzt8auV39tMVyQ4cZ3QqcSBuKkP3jRq8");

// 1 USDC = 10_000_000 base units
client.register(&creator, &id, &10_000_000i128, &metadata, &tags(&env, &["dataset"]));

assert_eq!(client.count(), 1);
assert!(client.exists(&id));

let resource = client.get(&id);
assert_eq!(resource.creator, creator);
assert_eq!(resource.price, 10_000_000i128);
assert!(resource.listed); // listed by default
assert_eq!(resource.tags.get(0).unwrap(), String::from_str(&env, "dataset"));
```

### Mutating a resource

```rust
// 0.50 USDC
client.set_price(&id, &5_000_000i128);

client.update_metadata(&id, &String::from_str(&env, "ipfs://QmUpdated"));

client.set_tags(&id, &tags(&env, &["finance", "api"]));

client.delist(&id);                          // set_listed(false)
client.set_listed(&id, &true);               // re-list

client.freeze_metadata(&id);                 // irreversible after this
```

### Pagination

```rust
// All resources, first page
let page = client.list(&0u32, &20u32);     // Vec<Resource>, capped at 20

// With cursor — next_cursor is None at end-of-list
let catalog_page = client.list_page(&0u32, &10u32); // CatalogPage
if let Some(next) = catalog_page.next_cursor {
    let second = client.list_page(&next, &10u32);
}

// Listed resources only (skip delisted)
let listed = client.list_listed(&0u32, &20u32);

// By owner
let by_creator = client.list_by_creator(&creator, &0u32, &20u32);

// By tag
let by_tag = client.list_by_tag(&String::from_str(&env, "dataset"), &0u32, &20u32);

let count = client.creator_resource_count(&creator);
```

### Ownership transfer

```rust
let new_owner = Address::generate(&env);

// Immediate transfer (single signature from current creator)
client.transfer_ownership(&id, &new_owner);

// Two-step transfer: propose → accept
let proposed = Address::generate(&env);
client.propose_transfer(&id, &proposed);  // current owner signs
env.mock_all_auths();
client.accept_transfer(&id);              // proposed owner signs

// Cancel a pending proposal (current owner)
client.cancel_transfer(&id);
```

### Admin bootstrap and verifier role

```rust
let admin = Address::generate(&env);
let verifier = Address::generate(&env);

// First call bootstraps admin directly (admin signs)
client.nominate_new_admin(&admin);
assert_eq!(client.admin(), Some(admin.clone()));

// Subsequent rotation: nominate → accept
let new_admin = Address::generate(&env);
client.nominate_new_admin(&new_admin);   // current admin signs
client.accept_admin(&new_admin);         // pending admin signs

// Grant verifier role (admin only)
client.add_verifier(&verifier);
assert!(client.is_verifier(verifier.clone()));

// Set on-chain verification status (verifier only)
// Valid transitions: Pending->Verified, Pending->Rejected, Verified->Rejected, Rejected->Verified
client.set_verification_status(
    &id,
    &verifier,
    &VerificationStatus::Verified,
    &Some(String::from_str(&env, "sha256:abcdef01")),
);

let resource = client.get(&id);
assert_eq!(resource.verified, VerificationStatus::Verified);

// Revoke verifier role
client.remove_verifier(&verifier);
assert!(!client.is_verifier(verifier));
```

### Error handling (fallible variant)

Every write function has a `try_*` variant that returns `Result<Result<T, Error>, ...>`
instead of panicking. Use `try_*` when testing error paths:

```rust
use vault_registry::Error;

// Duplicate registration
let res = client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
assert_eq!(res, Err(Ok(Error::AlreadyRegistered)));

// Invalid price
assert_eq!(
    client.try_register(&creator, &String::from_str(&env, "newid"), &0i128, &metadata, &empty_tags(&env)),
    Err(Ok(Error::InvalidPrice))
);

// Resource not found
assert_eq!(
    client.try_get(&String::from_str(&env, "doesnotexist")),
    Err(Ok(Error::NotFound))
);
```

---

## Price encoding reference

`price` is always in **USDC base units** (7 decimal places, same as the USDC SAC):

| Human amount | Stroops value |
| ------------ | ------------- |
| $0.01 USDC   | `100_000`     |
| $0.05 USDC   | `500_000`     |
| $0.10 USDC   | `1_000_000`   |
| $0.50 USDC   | `5_000_000`   |
| $1.00 USDC   | `10_000_000`  |
| $5.00 USDC   | `50_000_000`  |
| $10.00 USDC  | `100_000_000` |

---

## Resource ID rules

`id` must be 1–24 lowercase letters or digits (`[a-z0-9]`), matching the
cuid2 format used by the MindVault server. The following IDs are reserved and
always rejected: `admin`, `null`, `registry`, `api`, `index`, `root`, `system`
(case-insensitive).
