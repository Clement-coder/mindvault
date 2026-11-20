# Contract Roles and Authorization Matrix

This page describes authorization enforced by the Soroban `vault-registry`
contract. It is separate from MindVault API keys, HTTP authentication, and MCP
confirmation guards. A successful API or MCP request does not replace the
address authorization required by an on-chain contract invocation.

The exhaustive method-by-method matrix is the **Auth** column in
[`contract/README.md`](../contract/README.md). The contract's test-only
`METHOD_SCHEMA` in [`lib.rs`](../contract/contracts/vault-registry/src/lib.rs)
is checked against that table by
[`readme_methods_table_matches_method_schema`](../contract/contracts/vault-registry/src/test.rs).
Use the method table when an operation is not listed below or when a function
is added or changed.

## Authorization model

Soroban `Address::require_auth()` requires the given address to authorize the
contract invocation and its arguments. The contract also checks role membership
or resource ownership where applicable. Role membership alone does not sign a
transaction, and signing does not grant role membership. See the official
[`Address::require_auth` reference](https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Address.html#method.require_auth)
and Stellar's [Sign Soroban XDRs guide](https://developers.stellar.org/docs/build/guides/freighter/sign-soroban-xdrs).

| Principal | How it is established | Authorized operation families |
| --- | --- | --- |
| Resource creator | The `creator` stored on each resource; ownership can change through the transfer methods | Register resources; update their price, metadata, tags, royalty recipient, listing and state; transfer ownership; set creator terms; creator-authorized refunds; revoke a lease; extend resource TTL |
| Admin | Initial admin bootstrap, then two-step nomination and acceptance | Manage roles and governance; pause registry/payment operations; configure registry terms and fees; handle admin-only disputes, emergency actions, refunds and anchor overrides; repair indexes |
| Recovery admin | Optional distinct address configured during dual-key bootstrap or by the admin | Recover a lost admin key with `recover_admin`; it does not inherit normal admin permissions |
| Verifier | Granted or removed by the admin | Set a resource's on-chain verification status; anchor or attempt to anchor purchase receipts |
| Moderator | Granted or removed by the admin | Flag/unflag resources and set a flag reason hash |
| Settler | Granted or removed by the admin | Settle payment and lease records; participate in payment recording with the payer, or lease recording with the holder |
| Pending admin | Named by the current admin; becomes admin only after `accept_admin` succeeds | Accept the pending admin nomination; it has no current admin powers before acceptance |
| Payer / lease holder | Address supplied for the specific payment or lease | Co-authorize payment recording (`payer`) or lease recording/purchase (`holder`) as shown below |

The creator is a per-resource owner, not a globally granted protocol role. Admin,
verifier, moderator, and settler membership can be inspected through the public
role queries and `role_inventory_page`. Multi-member roles have a maximum of 32
active holders; the admin role has one active holder.

## Function-family matrix

| Authorization required | Contract methods and scope |
| --- | --- |
| **Creator** | `register`, `register_with_hash`, `register_with_memo`, `register_batch`; `set_price`, `set_price_many`; `update_metadata`, `update_metadata_many`, `freeze_metadata`, `set_metadata_pointers`, `set_tags`, `set_royalty_recipient`; `set_listed`, `delist`, `freeze_resource`, `reactivate_resource`; `transfer_ownership`, `propose_transfer`, `cancel_transfer`, `transfer_ownership_with_terms`; `migrate_resource`, `set_terms_hash`, `record_creator_refund`, `revoke_lease`, `extend_resource_ttl`. The current creator must authorize resource mutations. |
| **Admin** | `open_dispute`, `resolve_dispute`, `emergency_delist`, `tombstone_resource`; `nominate_new_admin`, `cancel_admin_nomination`, `set_recovery_admin`, `set_paused`, `set_paused_until`, `set_payment_paused`, `set_payment_paused_until`; `add_verifier`, `remove_verifier`, `rotate_verifier`, `add_moderator`, `remove_moderator`, `add_settler`, `remove_settler`; `set_flag_resolution_window`, `force_resolve_flag`, `set_registry_terms_hash`; `set_fee_config`, `set_fee_recipient`, `set_fee_destination`, `claim_fees`, `set_refund_window`; `record_admin_refund`, `override_purchase_receipt_anchor`; `repair_index`, `repair_tag_index`. Each call also applies the method's state and input checks. |
| **Verifier** | `set_verification_status`, `anchor_purchase_receipt`, `attempt_anchor_purchase_receipt` |
| **Moderator** | `flag_resource`, `unflag_resource`, `set_flag_reason_hash` |
| **Settler** | `settle_payment`, `settle_lease` |
| **Settler + payer** | `record_payment`, `record_payment_idempotent`, `record_payment_with_memo` |
| **Settler + holder** | `record_lease` |
| **Holder** | `buy_lease` |
| **Pending admin** | `accept_admin` — the nominated address must match and the nomination must be eligible for acceptance |
| **Recovery admin** | `recover_admin` |
| **Admin + recovery admin** | `bootstrap_dual_admin` — both distinct addresses authorize the initial bootstrap |
| **No address authorization** | Public reads and queries listed with `—` in `contract/README.md`. `initialize_network` is the important write exception: it has no `require_auth`, but can only run once and the supplied network ID must match the executing ledger. |

The `Admin` row summarizes methods governed by the current admin, but
`nominate_new_admin` has a special first-call bootstrap path: the proposed
`new_admin` authorizes that call when no admin exists. `accept_admin` is a
separate call by the pending address. `bootstrap_dual_admin` is an optional
alternative that requires both a distinct admin and recovery address to
authorize before any admin is set. See the
[admin lifecycle](../contract/README.md#role-management-flows) for nomination
delay, expiry, cancellation, and recovery behavior.

## Concrete authorization example

For `set_price(id, new_price)`, the contract loads the resource and calls
`resource.creator.require_auth()`. The current creator must sign the invocation.
An admin signature does not substitute for that creator authorization, and a
verifier role does not grant price-changing rights. Conversely,
`set_verification_status(id, verifier, status, hash)` requires the supplied
`verifier` address to authorize and checks that it currently holds the verifier
role; a resource creator who is not a verifier cannot set the on-chain
verification status.

Batch methods such as `set_price_many(creator, updates)` require the creator to
authorize once, then verify that every resource belongs to that creator before
writing. A failure in any item rejects the atomic batch. Calls requiring two
addresses need authorization from both addresses in the same contract
invocation; one signer cannot act as both the settler and payer/holder unless
the addresses are actually the same and each independent role check also
passes.

## Governance and operational implications

- Admin grants and revocations affect authorization for subsequent calls; they
  do not undo state changes that were already committed. Role changes emit
  grant/revoke events, and `role_inventory_page` provides a bounded read-only
  inventory for deployment audits.
- Verifier rotation is available as one admin-authorized `rotate_verifier`
  call. It validates both addresses before changing membership and emits an
  auditable rotation event.
- The full registry pause (`set_paused`) blocks guarded registry mutations but
  leaves reads available. The payment pause (`set_payment_paused`) blocks
  payment, refund, anchor, and lease operations while allowing catalog
  mutations. These controls are distinct and have separate status queries.
- Admin-only resource actions do not make the admin the resource creator.
  `emergency_delist`, dispute resolution, tombstoning, and refunds have
  separate preconditions and do not grant general creator authority.
- A method marked `—` in the method table means no explicit address
  authorization is required; it does not imply read-only behavior. In
  particular, `initialize_network` is permissionless but one-shot and bound to
  the contract's actual ledger network. Keep its initialization status and
  network ID in deployment verification.

## Canonical references

- [Contract method and error tables](../contract/README.md)
- [Contract authorization schema and implementation](../contract/contracts/vault-registry/src/lib.rs)
- [Authorization tests](../contract/contracts/vault-registry/src/test.rs)
- [Owner index repair](index-repair.md)
- [Contract upgrade checklist](contract-upgrade-checklist.md)
- [Soroban `Address::require_auth`](https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Address.html#method.require_auth)
- [Stellar guide: Sign Soroban XDRs](https://developers.stellar.org/docs/build/guides/freighter/sign-soroban-xdrs)
