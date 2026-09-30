// ─── Tombstone read-behavior documentation tests (#624) ───────────────────
//
// These tests document and enforce the exact read behaviour of the vault-registry
// contract after a resource has been tombstoned by an admin.
//
// What "tombstoning" means for readers
// ─────────────────────────────────────
// When `tombstone_resource(id, admin)` is called the contract:
//
//   1. Sets `resource.state = ResourceState::Tombstoned` and
//      `resource.listed = false` in persistent storage.
//   2. Removes the resource from every *derived* index:
//        • tag index  (`list_by_tag` no longer surfaces it)
//        • creator index (`list_by_creator` / `creator_resource_count` no longer count it)
//   3. Leaves the canonical storage entry intact, so:
//        • `get(id)`   → still returns the full `Resource` (audit trail).
//        • `exists(id)` → still returns `true`.
//        • `list(…)` / `list_page(…)` → still includes the entry (monotonic index).
//        • `get_owner(id)` → still returns the last owner.
//        • `count()` → unchanged (monotonic).
//   4. Blocks all creator-initiated mutations (`ResourceNotMutable`).
//   5. Blocks a second `tombstone_resource` call (`InvalidLifecycleTransition`).
//
// Each behaviour documented above has at least one test below that asserts it
// explicitly so that any future regression is caught immediately.

// ---------------------------------------------------------------------------
// § 1  get(id) — tombstoned resource is still readable
// ---------------------------------------------------------------------------

/// After tombstoning, `get` returns the full resource with
/// `state == Tombstoned` and `listed == false`.
#[test]
fn tombstoned_resource_readable_via_get() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbread01");
    let metadata = soroban_sdk::String::from_str(&env, "ipfs://tombread");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    client.tombstone_resource(&id, &admin);

    let r = client.get(&id);
    assert_eq!(
        r.state,
        ResourceState::Tombstoned,
        "get() must report Tombstoned state"
    );
    assert!(
        !r.listed,
        "tombstoned resource must have listed == false"
    );
    assert_eq!(r.id, id, "id must be preserved");
    assert_eq!(r.metadata, metadata, "metadata must be preserved");
    assert_eq!(r.creator, creator, "creator must be preserved");
}

/// `get` returns all original field values unchanged after tombstoning — only
/// `state` and `listed` change.  Price, tags, and metadata are intact.
#[test]
fn tombstoned_resource_preserves_all_fields() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbread02");
    let metadata = soroban_sdk::String::from_str(&env, "ipfs://fields");
    let t = tags(&env, &["dataset", "archive"]);
    let price = 5_000_000i128;
    client.register(&creator, &id, &price, &metadata, &t);

    let before = client.get(&id);
    client.tombstone_resource(&id, &admin);
    let after = client.get(&id);

    assert_eq!(after.price, before.price, "price must not change");
    assert_eq!(after.metadata, before.metadata, "metadata must not change");
    assert_eq!(after.creator, before.creator, "creator must not change");
    assert_eq!(after.tags, before.tags, "tags must not change");
    assert_eq!(
        after.schema_version, before.schema_version,
        "schema_version must not change"
    );
    // version bumps on every mutation (state transition counts as a mutation)
    assert!(
        after.version > before.version,
        "version counter must increment on tombstone"
    );
}

// ---------------------------------------------------------------------------
// § 2  exists(id) — tombstoned resource still reports as existing
// ---------------------------------------------------------------------------

/// `exists` returns `true` for a tombstoned resource.
#[test]
fn exists_returns_true_for_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbread03");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://exists"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    assert!(
        client.exists(&id),
        "exists() must return true for tombstoned resources"
    );
}

/// `exists_many` still reports `true` for a tombstoned id.
#[test]
fn exists_many_includes_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbread04");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://em"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    let mut ids = soroban_sdk::Vec::new(&env);
    ids.push_back(id.clone());
    let results = client.exists_many(&ids);
    assert_eq!(results.len(), 1);
    assert!(results.get(0).unwrap(), "exists_many must include tombstoned ids");
}

// ---------------------------------------------------------------------------
// § 3  get_owner — ownership is still readable after tombstoning
// ---------------------------------------------------------------------------

/// `get_owner` returns the resource's last owner even after tombstoning.
#[test]
fn get_owner_returns_last_owner_after_tombstone() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbread05");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://own"),
        &empty_tags(&env),
    );

    // Transfer to a new owner then tombstone.
    let new_owner = soroban_sdk::Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.get_owner(&id),
        new_owner,
        "get_owner must return the last owner after tombstone"
    );
}

// ---------------------------------------------------------------------------
// § 4  count() — global count is monotonic after tombstoning
// ---------------------------------------------------------------------------

/// `count()` does not decrease when a resource is tombstoned.
#[test]
fn global_count_is_monotonic_after_tombstone() {
    let (env, creator, admin, client) = setup_with_admin();
    let a = soroban_sdk::String::from_str(&env, "tmbcnt01");
    let b = soroban_sdk::String::from_str(&env, "tmbcnt02");
    let meta = soroban_sdk::String::from_str(&env, "ipfs://c");

    client.register(&creator, &a, &100i128, &meta, &empty_tags(&env));
    client.register(&creator, &b, &200i128, &meta, &empty_tags(&env));
    assert_eq!(client.count(), 2);

    client.tombstone_resource(&a, &admin);

    assert_eq!(
        client.count(),
        2,
        "count() must stay monotonic after tombstone"
    );
}

// ---------------------------------------------------------------------------
// § 5  list / list_page — tombstoned entries remain in the canonical catalog
// ---------------------------------------------------------------------------

/// `list` still returns tombstoned entries (the canonical index is untouched).
#[test]
fn list_includes_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmblist1");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://l"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    let page = client.list(&0u32, &20u32);
    assert_eq!(page.len(), 1, "list must still show tombstoned entries");
    assert_eq!(page.get(0).unwrap().state, ResourceState::Tombstoned);
}

/// `list_page` returns a tombstoned entry with the correct `next_cursor`.
#[test]
fn list_page_includes_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbpage1");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://lp"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    let page = client.list_page(&0u32, &20u32);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items.get(0).unwrap().state, ResourceState::Tombstoned);
    assert_eq!(page.next_cursor, None, "single-item catalog must return no next cursor");
}

/// Mixed catalog: tombstoned entries appear interleaved with live ones in
/// insertion order; `list` never skips them.
#[test]
fn list_preserves_insertion_order_with_tombstoned_entries() {
    let (env, creator, admin, client) = setup_with_admin();
    let meta = soroban_sdk::String::from_str(&env, "ipfs://ord");

    let id_a = soroban_sdk::String::from_str(&env, "tmbord01");
    let id_b = soroban_sdk::String::from_str(&env, "tmbord02");
    let id_c = soroban_sdk::String::from_str(&env, "tmbord03");

    client.register(&creator, &id_a, &100i128, &meta, &empty_tags(&env));
    client.register(&creator, &id_b, &200i128, &meta, &empty_tags(&env));
    client.register(&creator, &id_c, &300i128, &meta, &empty_tags(&env));

    // Tombstone the middle entry.
    client.tombstone_resource(&id_b, &admin);

    let page = client.list(&0u32, &20u32);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().id, id_a);
    assert_eq!(page.get(1).unwrap().id, id_b);
    assert_eq!(page.get(1).unwrap().state, ResourceState::Tombstoned);
    assert_eq!(page.get(2).unwrap().id, id_c);
}

// ---------------------------------------------------------------------------
// § 6  list_by_tag — tombstoned resource NOT in tag index
// ---------------------------------------------------------------------------

/// After tombstoning, the resource no longer surfaces in `list_by_tag` for
/// any tag it had at the time of tombstoning.
#[test]
fn list_by_tag_excludes_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbtag01");
    let t = tags(&env, &["research", "dataset"]);
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://tag"),
        &t,
    );

    assert_eq!(
        client
            .list_by_tag(&soroban_sdk::String::from_str(&env, "research"), &0u32, &20u32)
            .len(),
        1,
        "resource must be discoverable by tag before tombstoning"
    );

    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client
            .list_by_tag(&soroban_sdk::String::from_str(&env, "research"), &0u32, &20u32)
            .len(),
        0,
        "tombstoned resource must not be discoverable by tag"
    );
    assert_eq!(
        client
            .list_by_tag(&soroban_sdk::String::from_str(&env, "dataset"), &0u32, &20u32)
            .len(),
        0,
        "all tags must be purged from the index on tombstone"
    );
}

/// Tombstoning one resource does not disturb tag entries for other resources.
#[test]
fn list_by_tag_keeps_other_resources_intact_after_tombstone() {
    let (env, creator, admin, client) = setup_with_admin();
    let meta = soroban_sdk::String::from_str(&env, "ipfs://t");
    let t = tags(&env, &["shared-tag"]);

    let live = soroban_sdk::String::from_str(&env, "tmbtag02");
    let doomed = soroban_sdk::String::from_str(&env, "tmbtag03");

    client.register(&creator, &live, &100i128, &meta, &t);
    client.register(&creator, &doomed, &200i128, &meta, &t);

    client.tombstone_resource(&doomed, &admin);

    let by_tag = client.list_by_tag(
        &soroban_sdk::String::from_str(&env, "shared-tag"),
        &0u32,
        &20u32,
    );
    assert_eq!(
        by_tag.len(),
        1,
        "only one resource should remain in the tag index"
    );
    assert_eq!(by_tag.get(0).unwrap().id, live);
}

// ---------------------------------------------------------------------------
// § 7  list_by_creator — tombstoned resource NOT in creator index
// ---------------------------------------------------------------------------

/// `list_by_creator` excludes tombstoned resources.
#[test]
fn list_by_creator_excludes_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let meta = soroban_sdk::String::from_str(&env, "ipfs://cr");
    let live = soroban_sdk::String::from_str(&env, "tmbcr001");
    let doomed = soroban_sdk::String::from_str(&env, "tmbcr002");

    client.register(&creator, &live, &100i128, &meta, &empty_tags(&env));
    client.register(&creator, &doomed, &200i128, &meta, &empty_tags(&env));

    client.tombstone_resource(&doomed, &admin);

    let by_creator = client.list_by_creator(&creator, &0u32, &20u32);
    assert_eq!(
        by_creator.len(),
        1,
        "tombstoned resource must not appear in list_by_creator"
    );
    assert_eq!(by_creator.get(0).unwrap().id, live);
}

/// `creator_resource_count` decrements when a resource is tombstoned.
#[test]
fn creator_resource_count_decrements_after_tombstone() {
    let (env, creator, admin, client) = setup_with_admin();
    let meta = soroban_sdk::String::from_str(&env, "ipfs://cnt");
    let a = soroban_sdk::String::from_str(&env, "tmbcnt10");
    let b = soroban_sdk::String::from_str(&env, "tmbcnt11");

    client.register(&creator, &a, &100i128, &meta, &empty_tags(&env));
    client.register(&creator, &b, &200i128, &meta, &empty_tags(&env));
    assert_eq!(client.creator_resource_count(&creator), 2);

    client.tombstone_resource(&a, &admin);

    assert_eq!(
        client.creator_resource_count(&creator),
        1,
        "creator_resource_count must decrement after tombstone"
    );
}

/// `creator_resource_count` saturates at 0 — tombstoning the last resource
/// does not underflow.
#[test]
fn creator_resource_count_saturates_at_zero() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbcnt20");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://sat"),
        &empty_tags(&env),
    );
    assert_eq!(client.creator_resource_count(&creator), 1);

    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.creator_resource_count(&creator),
        0,
        "count must saturate at 0, not underflow"
    );
}

// ---------------------------------------------------------------------------
// § 8  list_listed — tombstoned resource NOT in listed set
// ---------------------------------------------------------------------------

/// `listed_count` decrements when a listed resource is tombstoned.
#[test]
fn listed_count_decrements_after_tombstone() {
    let (env, creator, admin, client) = setup_with_admin();
    let meta = soroban_sdk::String::from_str(&env, "ipfs://lc");
    let id = soroban_sdk::String::from_str(&env, "tmblstd1");

    client.register(&creator, &id, &100i128, &meta, &empty_tags(&env));
    let before = client.listed_count();
    assert_eq!(before, 1, "newly registered resource must be listed");

    client.tombstone_resource(&id, &admin);

    assert!(
        client.listed_count() < before,
        "listed_count must decrease after tombstone"
    );
}

/// `list_listed` does not include tombstoned resources.
#[test]
fn list_listed_excludes_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let meta = soroban_sdk::String::from_str(&env, "ipfs://ll");
    let live = soroban_sdk::String::from_str(&env, "tmblstd2");
    let doomed = soroban_sdk::String::from_str(&env, "tmblstd3");

    client.register(&creator, &live, &100i128, &meta, &empty_tags(&env));
    client.register(&creator, &doomed, &200i128, &meta, &empty_tags(&env));

    client.tombstone_resource(&doomed, &admin);

    let listed = client.list_listed(&0u32, &20u32);
    assert_eq!(
        listed.len(),
        1,
        "list_listed must exclude tombstoned resources"
    );
    assert_eq!(listed.get(0).unwrap().id, live);
}

// ---------------------------------------------------------------------------
// § 9  Mutation guards — tombstoned resource blocks all creator mutations
// ---------------------------------------------------------------------------

/// Every creator-gated method returns `ResourceNotMutable` on a tombstoned resource.
#[test]
fn tombstoned_resource_blocks_set_price() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbmut01");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.try_set_price(&id, &999i128),
        Err(Ok(Error::ResourceNotMutable))
    );
}

#[test]
fn tombstoned_resource_blocks_update_metadata() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbmut02");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.try_update_metadata(&id, &soroban_sdk::String::from_str(&env, "ipfs://new")),
        Err(Ok(Error::ResourceNotMutable))
    );
}

#[test]
fn tombstoned_resource_blocks_set_tags() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbmut03");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.try_set_tags(&id, &tags(&env, &["newtag"])),
        Err(Ok(Error::ResourceNotMutable))
    );
}

#[test]
fn tombstoned_resource_blocks_transfer_ownership() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbmut04");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);
    let new_owner = soroban_sdk::Address::generate(&env);

    assert_eq!(
        client.try_transfer_ownership(&id, &new_owner),
        Err(Ok(Error::ResourceNotMutable))
    );
}

/// Re-tombstoning an already-tombstoned resource is an invalid lifecycle
/// transition.
#[test]
fn second_tombstone_returns_invalid_lifecycle_transition() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = soroban_sdk::String::from_str(&env, "tmbmut05");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.try_tombstone_resource(&id, &admin),
        Err(Ok(Error::InvalidLifecycleTransition)),
        "second tombstone call must be rejected"
    );
}

// ---------------------------------------------------------------------------
// § 10  get_many — batch read still returns tombstoned entries
// ---------------------------------------------------------------------------

/// `get_many` returns tombstoned resources alongside live ones.
#[test]
fn get_many_includes_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let meta = soroban_sdk::String::from_str(&env, "ipfs://gm");
    let live = soroban_sdk::String::from_str(&env, "tmbgm001");
    let doomed = soroban_sdk::String::from_str(&env, "tmbgm002");

    client.register(&creator, &live, &100i128, &meta, &empty_tags(&env));
    client.register(&creator, &doomed, &200i128, &meta, &empty_tags(&env));
    client.tombstone_resource(&doomed, &admin);

    let mut ids = soroban_sdk::Vec::new(&env);
    ids.push_back(live.clone());
    ids.push_back(doomed.clone());

    let results = client.get_many(&ids);
    assert_eq!(results.len(), 2);
    // The tombstoned entry is present — callers must inspect `state` to filter.
    let states: soroban_sdk::Vec<ResourceState> = {
        let mut v = soroban_sdk::Vec::new(&env);
        for i in 0..results.len() {
            v.push_back(results.get(i).unwrap().unwrap().state);
        }
        v
    };
    assert!(
        states.contains(ResourceState::Listed),
        "get_many must include the live resource"
    );
    assert!(
        states.contains(ResourceState::Tombstoned),
        "get_many must include the tombstoned resource"
    );
}
