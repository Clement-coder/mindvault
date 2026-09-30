// ─── Creator-scoped listed count (#681) ─────────────────────────────────────
//
// `creator_listed_count(creator)` is the per-creator counterpart of
// `listed_count()`: how many of a creator's resources are currently `Listed`.
// It must follow every listed-state transition the contract can make and move
// between owners on transfer, without ever drifting from the resources
// themselves. These tests walk each transition and reconcile the counter
// against `list_by_creator` after every step.

/// Number of `creator`'s resources whose state is `Listed`, computed from the
/// resources themselves rather than the counter under test.
fn listed_by_scan(client: &VaultRegistryClient<'_>, creator: &Address) -> u32 {
    let page = client.list_by_creator(creator, &0u32, &20u32);
    let mut n = 0u32;
    for i in 0..page.len() {
        if page.get(i).unwrap().state == ResourceState::Listed {
            n += 1;
        }
    }
    n
}

fn assert_counts(client: &VaultRegistryClient<'_>, creator: &Address, expected: u32) {
    assert_eq!(client.creator_listed_count(creator), expected);
    assert_eq!(
        client.creator_listed_count(creator),
        listed_by_scan(client, creator),
        "creator_listed_count must agree with the listed resources in list_by_creator"
    );
}

#[test]
fn creator_listed_count_starts_at_zero() {
    let (_env, creator, client) = setup();
    assert_eq!(client.creator_listed_count(&creator), 0);
}

#[test]
fn creator_listed_count_increments_on_register() {
    let (env, creator, client) = setup();
    register_default(&env, &creator, &client, "clcreg1");
    assert_counts(&client, &creator, 1);
    register_default(&env, &creator, &client, "clcreg2");
    assert_counts(&client, &creator, 2);
    assert_eq!(client.listed_count(), 2);
}

#[test]
fn creator_listed_count_counts_each_batch_item_that_registered() {
    let (env, creator, client) = setup();
    let mut items = Vec::new(&env);
    for id in ["clcbatch1", "clcbatch2", "clcbatch1"] {
        items.push_back(BatchRegisterItem {
            id: String::from_str(&env, id),
            price: 100,
            metadata: String::from_str(&env, "ipfs://m"),
            tags: empty_tags(&env),
            content_hash: None,
        });
    }

    let result = client.register_batch(&creator, &items);

    // The duplicate third item fails; only the two registrations count.
    assert_eq!(result.succeeded.len(), 2);
    assert_eq!(result.failed.len(), 1);
    assert_counts(&client, &creator, 2);
}

#[test]
fn creator_listed_count_follows_delist_and_relist() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "clcdelist");

    client.delist(&id);
    assert_counts(&client, &creator, 0);
    assert_eq!(client.creator_resource_count(&creator), 1);

    // The documented no-op path (already delisted) must not go negative.
    client.set_listed(&id, &false);
    assert_counts(&client, &creator, 0);

    client.set_listed(&id, &true);
    assert_counts(&client, &creator, 1);

    // Relisting an already listed resource is a no-op for the count too.
    client.set_listed(&id, &true);
    assert_counts(&client, &creator, 1);
}

#[test]
fn creator_listed_count_follows_freeze_and_reactivate() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "clcfreeze");

    client.freeze_resource(&id);
    assert_counts(&client, &creator, 0);

    client.reactivate_resource(&id);
    assert_counts(&client, &creator, 1);
}

#[test]
fn creator_listed_count_follows_the_dispute_paths() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "clcdispute");

    client.open_dispute(&id, &admin);
    assert_counts(&client, &creator, 0);

    client.resolve_dispute(&id, &admin, &ResourceState::Listed);
    assert_counts(&client, &creator, 1);

    client.open_dispute(&id, &admin);
    client.emergency_delist(&id, &admin);
    assert_counts(&client, &creator, 0);

    client.reactivate_resource(&id);
    assert_counts(&client, &creator, 1);

    client.open_dispute(&id, &admin);
    client.resolve_dispute(&id, &admin, &ResourceState::Frozen);
    assert_counts(&client, &creator, 0);
}

#[test]
fn creator_listed_count_decrements_on_tombstone_only_when_listed() {
    let (env, creator, admin, client) = setup_with_admin();
    let listed = register_default(&env, &creator, &client, "clctomb1");
    let delisted = register_default(&env, &creator, &client, "clctomb2");
    client.delist(&delisted);
    assert_eq!(client.creator_listed_count(&creator), 1);

    client.tombstone_resource(&delisted, &admin);
    assert_eq!(client.creator_listed_count(&creator), 1);
    assert_eq!(client.creator_resource_count(&creator), 1);

    client.tombstone_resource(&listed, &admin);
    assert_eq!(client.creator_listed_count(&creator), 0);
    assert_eq!(client.creator_resource_count(&creator), 0);
    assert_eq!(client.listed_count(), 0);
}

#[test]
fn creator_listed_count_moves_with_transfer_ownership_when_listed() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "clcxfer1");
    let new_owner = Address::generate(&env);

    client.transfer_ownership(&id, &new_owner);

    assert_counts(&client, &creator, 0);
    assert_counts(&client, &new_owner, 1);
    assert_eq!(
        client.listed_count(),
        1,
        "the global count is unchanged by a transfer"
    );
}

#[test]
fn creator_listed_count_moves_with_accept_transfer_when_listed() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "clcxfer2");
    let new_owner = Address::generate(&env);

    client.propose_transfer(&id, &new_owner);
    assert_counts(&client, &creator, 1);
    assert_counts(&client, &new_owner, 0);

    client.accept_transfer(&id);
    assert_counts(&client, &creator, 0);
    assert_counts(&client, &new_owner, 1);
}

#[test]
fn creator_listed_count_does_not_move_a_delisted_resource_on_transfer() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "clcxfer3");
    let new_owner = Address::generate(&env);
    client.delist(&id);

    client.transfer_ownership(&id, &new_owner);

    assert_counts(&client, &creator, 0);
    assert_counts(&client, &new_owner, 0);
    // Ownership moved even though nothing listed did.
    assert_eq!(client.creator_resource_count(&creator), 0);
    assert_eq!(client.creator_resource_count(&new_owner), 1);

    // Relisting after the transfer credits the new owner, not the old one.
    client.set_listed(&id, &true);
    assert_counts(&client, &creator, 0);
    assert_counts(&client, &new_owner, 1);
}

#[test]
fn creator_listed_count_is_independent_per_creator() {
    let (env, creator, client) = setup();
    let other = Address::generate(&env);
    let mine = register_default(&env, &creator, &client, "clcmine");
    register_default(&env, &other, &client, "clctheirs");

    client.delist(&mine);

    assert_counts(&client, &creator, 0);
    assert_counts(&client, &other, 1);
    assert_eq!(client.listed_count(), 1);
}

#[test]
fn creator_listed_count_never_exceeds_creator_resource_count() {
    let (env, creator, admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "clcbound1");
    let b = register_default(&env, &creator, &client, "clcbound2");
    let c = register_default(&env, &creator, &client, "clcbound3");

    client.delist(&a);
    client.freeze_resource(&b);
    client.open_dispute(&c, &admin);
    client.set_listed(&a, &true);
    client.reactivate_resource(&b);
    client.resolve_dispute(&c, &admin, &ResourceState::Delisted);

    let listed = client.creator_listed_count(&creator);
    assert!(listed <= client.creator_resource_count(&creator));
    assert_eq!(listed, 2);
    assert_counts(&client, &creator, 2);
}
