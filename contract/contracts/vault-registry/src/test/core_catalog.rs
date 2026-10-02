fn resource_storage_ttl(env: &Env, contract: &soroban_sdk::Address, id: &String) -> u32 {
    let key = DataKey::Resource(id.clone());
    env.as_contract(contract, || env.storage().persistent().get_ttl(&key))
}

/// Live TTL of the persistent entry that records a proposed owner for `id`.
fn pending_transfer_ttl(env: &Env, contract: &soroban_sdk::Address, id: &String) -> u32 {
    let key = DataKey::PendingTransfer(id.clone());
    env.as_contract(contract, || env.storage().persistent().get_ttl(&key))
}

fn setup<'a>() -> (Env, Address, VaultRegistryClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    (env, creator, client)
}

fn setup_strict_auth<'a>() -> (Env, Address, Address, VaultRegistryClient<'a>, String) {
    let env = Env::default();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let id = String::from_str(&env, "authres");
    client.mock_all_auths().register(
        &owner,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://auth"),
        &empty_tags(&env),
    );
    (env, owner, stranger, client, id)
}

fn empty_tags(env: &Env) -> Vec<String> {
    Vec::new(env)
}

fn tags(env: &Env, items: &[&str]) -> Vec<String> {
    let mut v = Vec::new(env);
    for item in items {
        v.push_back(String::from_str(env, item));
    }
    v
}

#[test]
fn register_then_read() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "swcn98besxpp6t1u8e77fqz3");
    let metadata = String::from_str(&env, "ipfs://QmResourceMetadata");

    client.register(&creator, &id, &1_000_000i128, &metadata, &empty_tags(&env));

    assert_eq!(client.count(), 1);
    assert!(client.exists(&id));

    let r = client.get(&id);
    assert_eq!(r.id, id);
    assert_eq!(r.creator, creator);
    assert_eq!(r.price, 1_000_000i128);
    assert_eq!(r.metadata, metadata);
    assert!(r.listed); // Resources are listed by default
}

#[test]
fn register_event_contains_full_resource_payload() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtres");
    let metadata = String::from_str(&env, "ipfs://evt");
    let price = 1_000_000i128;
    let tags_list = tags(&env, &["tag1"]);

    client.register(&creator, &id, &price, &metadata, &tags_list);

    let all_events = env.events().all();
    let mut found = false;
    for i in 0..all_events.len() {
        let (_, topics, data) = all_events.get(i).unwrap();
        if topics.len() != 2 {
            continue;
        }
        let t0: Symbol =
            <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
                .ok()
                .unwrap();
        if t0 != Symbol::new(&env, "register") {
            continue;
        }
        let event: RegisterEvent =
            <RegisterEvent as TryFromVal<Env, Val>>::try_from_val(&env, &data)
                .ok()
                .unwrap();
        assert_eq!(event.id, id);
        assert_eq!(event.creator, creator);
        assert_eq!(event.price, price);
        assert_eq!(event.metadata, metadata);
        assert!(event.listed);
        assert_eq!(event.tags.len(), 1);
        assert_eq!(event.tags.get(0).unwrap(), String::from_str(&env, "tag1"));
        found = true;
        break;
    }
    assert!(found, "register event not emitted");
}

#[test]
fn count_tracks_multiple_successful_registrations() {
    let (env, creator, client) = setup();
    assert_eq!(client.count(), 0);

    let ids = ["c1", "c2", "c3", "c4"];
    for id in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }
    assert_eq!(client.count(), 4);

    // Failed duplicate must not increment count.
    let dup = String::from_str(&env, "c2");
    assert_eq!(
        client.try_register(
            &creator,
            &dup,
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(client.count(), 4);
}

#[test]
fn duplicate_registration_fails() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "dup");
    let metadata = String::from_str(&env, "ipfs://x");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    let res = client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert_eq!(res, Err(Ok(Error::AlreadyRegistered)));
    assert_eq!(client.count(), 1);
}

#[test]
fn zero_or_negative_price_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "free");
    let metadata = String::from_str(&env, "ipfs://x");

    assert_eq!(
        client.try_register(&creator, &id, &0i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        client.try_register(&creator, &id, &-5i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidPrice))
    );
}

#[test]
fn register_rejects_price_exceeding_max() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "toopricey");
    let metadata = String::from_str(&env, "ipfs://x");
    let over = MAX_PRICE + 1;
    assert_eq!(
        client.try_register(&creator, &id, &over, &metadata, &empty_tags(&env)),
        Err(Ok(Error::PriceExceedsMax))
    );
}

#[test]
fn set_price_rejects_price_exceeding_max() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    let over = MAX_PRICE + 1;
    assert_eq!(
        client.try_set_price(&id, &over),
        Err(Ok(Error::PriceExceedsMax))
    );
}

#[test]
fn maximum_price_accepted() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxprice");
    let metadata = String::from_str(&env, "ipfs://x");
    client.register(&creator, &id, &MAX_PRICE, &metadata, &empty_tags(&env));
    assert_eq!(client.get(&id).price, MAX_PRICE);
}

#[test]
fn invalid_resource_id_rejected() {
    let (env, creator, client) = setup();
    let metadata = String::from_str(&env, "ipfs://x");

    let empty = String::from_str(&env, "");
    assert_eq!(
        client.try_register(&creator, &empty, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidResourceId))
    );

    let overlong = String::from_str(&env, &"a".repeat(25));
    assert_eq!(
        client.try_register(&creator, &overlong, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidResourceId))
    );

    let invalid_chars = String::from_str(&env, "bad-id");
    assert_eq!(
        client.try_register(
            &creator,
            &invalid_chars,
            &100i128,
            &metadata,
            &empty_tags(&env)
        ),
        Err(Ok(Error::InvalidResourceId))
    );
}

#[test]
fn valid_resource_id_is_accepted() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "swcn98besxpp6t1u8e77fqz3");
    let metadata = String::from_str(&env, "ipfs://x");

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert!(client.exists(&id));
}

#[test]
fn resource_id_at_max_length_is_accepted() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "abcdefghijklmnopqrstuvwx"); // 24 bytes

    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://x"),
        &empty_tags(&env),
    );
    assert!(client.exists(&id));
}

#[test]
fn get_missing_fails() {
    let (env, _creator, client) = setup();
    let res = client.try_get(&String::from_str(&env, "nope"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn get_many_preserves_order_and_missing_slots() {
    let (env, creator, client) = setup();
    let id_a = String::from_str(&env, "batcha");
    let id_b = String::from_str(&env, "batchb");
    let missing = String::from_str(&env, "batchmissing");
    client.register(
        &creator,
        &id_a,
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &id_b,
        &200i128,
        &String::from_str(&env, "ipfs://b"),
        &empty_tags(&env),
    );

    let mut ids = Vec::new(&env);
    ids.push_back(id_a.clone());
    ids.push_back(missing);
    ids.push_back(id_b.clone());

    let resources = client.get_many(&ids);
    assert_eq!(resources.len(), 3);
    assert_eq!(resources.get(0).unwrap().unwrap().id, id_a);
    assert!(resources.get(1).unwrap().is_none());
    assert_eq!(resources.get(2).unwrap().unwrap().id, id_b);
}

#[test]
fn get_many_rejects_batches_over_twenty() {
    let (env, _creator, client) = setup();
    let mut ids = Vec::new(&env);
    for i in 0..21 {
        ids.push_back(String::from_str(&env, &format!("batch{i}")));
    }
    assert_eq!(client.try_get_many(&ids), Err(Ok(Error::BatchTooLarge)));
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_set_price() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_price",
        args: (id.clone(), 200i128).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).set_price(&id, &200i128);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_update_metadata() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let metadata = String::from_str(&env, "ipfs://newauth");
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "update_metadata",
        args: (id.clone(), metadata.clone()).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).update_metadata(&id, &metadata);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_set_tags() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let next_tags = tags(&env, &["private"]);
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_tags",
        args: (id.clone(), next_tags.clone()).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).set_tags(&id, &next_tags);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_transfer() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let new_owner = Address::generate(&env);
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "transfer_ownership",
        args: (id.clone(), new_owner.clone()).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client
        .mock_auths(&auths)
        .transfer_ownership(&id, &new_owner);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_set_listed() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_listed",
        args: (id.clone(), false).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).set_listed(&id, &false);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_delist() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "delist",
        args: (id.clone(),).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).delist(&id);
}

#[test]
fn set_price_updates_value() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r1");
    client.register(
        &creator,
        &id,
        &1_000_000i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.set_price(&id, &2_500_000i128);
    assert_eq!(client.get(&id).price, 2_500_000i128);

    assert_eq!(
        client.try_set_price(&id, &0i128),
        Err(Ok(Error::InvalidPrice))
    );
}
#[test]
fn set_price_emits_structured_event() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtr1");
    let initial_price = 1_000_000i128;
    let updated_price = 2_500_000i128;

    client.register(
        &creator,
        &id,
        &initial_price,
        &String::from_str(&env, "ipfs://QmEventTest"),
        &empty_tags(&env),
    );

    client.set_price(&id, &updated_price);

    let payload = find_setprice_event(&env, &client.address).expect("setprice event not found");
    assert_eq!(payload.id, id);
    assert_eq!(payload.old_price, initial_price);
    assert_eq!(payload.new_price, updated_price);
    assert_eq!(payload.updater, creator);
}

#[test]
fn update_metadata_changes_pointer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "https://example.com/old"),
        &empty_tags(&env),
    );

    let new_meta = String::from_str(&env, "ipfs://QmNew");
    client.update_metadata(&id, &new_meta);
    assert_eq!(client.get(&id).metadata, new_meta);
}

#[test]
fn ownership_can_transfer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r3");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.get(&id).creator, new_owner);
}

#[test]
fn transfer_ownership_event_contains_previous_and_new_owner() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtxfer");
    let new_owner = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.transfer_ownership(&id, &new_owner);

    let (prev, new) =
        find_transfer_event(&env, &client.address).expect("transfer event not emitted");
    assert_eq!(prev, creator);
    assert_eq!(new, new_owner);
}

#[test]
fn propose_transfer_event_contains_owner_and_proposed() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtpropose");
    let proposed = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &proposed);

    let (owner, target) =
        find_propose_event(&env, &client.address).expect("propose event not emitted");
    assert_eq!(owner, creator);
    assert_eq!(target, proposed);
}

#[test]
fn accept_transfer_event_contains_previous_and_new_owner() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtaccept");
    let new_owner = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &new_owner);
    env.mock_all_auths();
    client.accept_transfer(&id);

    let (prev, new) =
        find_transfer_event(&env, &client.address).expect("accept transfer event not emitted");
    assert_eq!(prev, creator);
    assert_eq!(new, new_owner);
}

#[test]
fn cancel_transfer_event_contains_owner() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtcancel");
    let proposed = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &proposed);
    client.cancel_transfer(&id);

    let owner = find_cancel_event(&env, &client.address).expect("cancel event not emitted");
    assert_eq!(owner, creator);
}

#[test]
fn set_listed_toggles_listing_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r4");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Initially listed
    assert!(client.get(&id).listed);

    // Delist
    client.set_listed(&id, &false);
    assert!(!client.get(&id).listed);

    // Re-list
    client.set_listed(&id, &true);
    assert!(client.get(&id).listed);
}

#[test]
fn delist_convenience_method() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r5");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Initially listed
    assert!(client.get(&id).listed);

    // Delist using convenience method
    client.delist(&id);
    assert!(!client.get(&id).listed);
}

#[test]
fn set_price_preserves_other_fields() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r7");
    let metadata = String::from_str(&env, "ipfs://QmPreserve");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    client.set_price(&id, &250i128);
    let resource = client.get(&id);

    assert_eq!(resource.price, 250i128);
    assert_eq!(resource.metadata, metadata);
    assert_eq!(resource.creator, creator);
    assert!(resource.listed);
}

#[test]
fn transfer_ownership_keeps_count_and_order() {
    let (env, creator, client) = setup();
    let ids = ["a", "b"];
    for id in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }

    let new_owner = Address::generate(&env);
    let id = String::from_str(&env, "a");
    client.transfer_ownership(&id, &new_owner);

    assert_eq!(client.count(), 2);
    let list = client.list(&0u32, &10u32);
    assert_eq!(list.get(0).unwrap().id, id);
    assert_eq!(list.get(0).unwrap().creator, new_owner);
    assert_eq!(list.get(1).unwrap().id, String::from_str(&env, "b"));
}

#[test]
fn update_metadata_preserves_price_and_creator() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r8");
    let original_metadata = String::from_str(&env, "ipfs://QmOriginal");
    client.register(
        &creator,
        &id,
        &500i128,
        &original_metadata,
        &empty_tags(&env),
    );

    let new_metadata = String::from_str(&env, "ipfs://QmUpdated");
    client.update_metadata(&id, &new_metadata);

    let resource = client.get(&id);
    assert_eq!(resource.metadata, new_metadata);
    assert_eq!(resource.price, 500i128);
    assert_eq!(resource.creator, creator);
}

#[test]
fn get_owner_returns_creator() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ownertest");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let owner = client.get_owner(&id);
    assert_eq!(owner, creator);
}

#[test]
fn get_owner_missing_fails() {
    let (env, _creator, client) = setup();
    let res = client.try_get_owner(&String::from_str(&env, "nope"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn get_owner_after_transfer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ownerxfer");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);

    assert_eq!(client.get_owner(&id), new_owner);
}

#[test]
fn set_listed_requires_creator_auth() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r6");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // This should work fine since we mock all auths
    client.set_listed(&id, &false);
    assert!(!client.get(&id).listed);
}

#[test]
fn set_listed_on_missing_resource_fails() {
    let (env, _creator, client) = setup();
    let id = String::from_str(&env, "missing");

    let res = client.try_set_listed(&id, &false);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// ---------------------------------------------------------------------------
// Event payload tests for set_listed / delist
// ---------------------------------------------------------------------------
//
// In Soroban SDK 22, `env.events().all()` returns only the events emitted
// by the **most recent contract invocation**. Each `client.*()` call clears
// and repopulates the buffer, so we check events immediately after the call
// we care about.
//
// The `setlisted` event schema:
//   topics: (Symbol("setlisted"), id_string)
//   data:   (old_listed: bool, new_listed: bool)

#[test]
fn set_listed_event_emits_old_and_new_state_delist() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evdelist");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Start listed=true; calling set_listed(false) should emit (true, false)
    client.set_listed(&id, &false);

    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );
}

#[test]
fn set_listed_event_emits_old_and_new_state_relist() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evrelist");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Delist, then relist — check both events individually
    client.set_listed(&id, &false);
    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );

    client.set_listed(&id, &true);
    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (false, true).into_val(&env),
            ),
        ]
    );
}

#[test]
fn set_listed_allows_no_op_same_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evnoop");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.set_listed(&id, &true);
    assert_eq!(client.get(&id).state, ResourceState::Listed);
}

#[test]
fn delist_convenience_method_emits_old_and_new_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evdelist2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // delist() delegates to set_listed(false) — must emit (true, false)
    // with the "setlisted" topic symbol (not a separate "delist" topic).
    client.delist(&id);

    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );
}

#[test]
fn set_listed_and_delist_events_are_consistent() {
    // Both paths (set_listed(false) and delist()) must produce the same event
    // shape. This directly tests the acceptance criterion: "Events are
    // consistent for set_listed(false), delist, and relisting."
    let (env, creator, client) = setup();
    let id1 = String::from_str(&env, "evcons1");
    let id2 = String::from_str(&env, "evcons2");

    client.register(
        &creator,
        &id1,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &id2,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Check that set_listed(false) and delist() emit identical (true, false) data.
    client.set_listed(&id1, &false);
    let ev_set_listed = env.events().all();
    assert_eq!(
        ev_set_listed,
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id1.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );

    client.delist(&id2);
    let ev_delist = env.events().all();
    assert_eq!(
        ev_delist,
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id2.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );
}

#[test]
fn list_empty_returns_empty() {
    let (_env, _creator, client) = setup();
    let page = client.list(&0u32, &20u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_returns_all_in_insertion_order() {
    let (env, creator, client) = setup();
    let ids = ["a", "b", "c"];
    for id in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }

    let page = client.list(&0u32, &20u32);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "a"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "b"));
    assert_eq!(page.get(2).unwrap().id, String::from_str(&env, "c"));
}

fn metadata_of_len(env: &Env, len: u32) -> String {
    let prefix = "ipfs://";
    let prefix_len = prefix.len();
    assert!(len >= prefix_len as u32);
    let body_len = len - prefix_len as u32;
    let body = "a".repeat(body_len as usize);
    String::from_str(env, &(prefix.to_string() + &body))
}

#[test]
fn register_accepts_metadata_at_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metamax");
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN);
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert_eq!(client.get(&id).metadata.len(), MAX_METADATA_POINTER_LEN);
}

#[test]
fn register_rejects_metadata_over_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metalong");
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::MetadataTooLong))
    );
    assert!(!client.exists(&id));
}

#[test]
fn update_metadata_accepts_at_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metaupdok");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://short"),
        &empty_tags(&env),
    );
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN);
    client.update_metadata(&id, &metadata);
    assert_eq!(client.get(&id).metadata.len(), MAX_METADATA_POINTER_LEN);
}

#[test]
fn update_metadata_rejects_over_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metaupdbad");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ar://short"),
        &empty_tags(&env),
    );
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    assert_eq!(
        client.try_update_metadata(&id, &metadata),
        Err(Ok(Error::MetadataTooLong))
    );
    assert_eq!(
        client.get(&id).metadata,
        String::from_str(&env, "ar://short")
    );
}

// Empty metadata and single-character metadata (e.g. "a") are both rejected
// by `validate_metadata_pointer` (`EmptyMetadata` / `InvalidMetadataPointer`
// respectively, since "a" matches no supported pointer prefix) — see
// `register_rejects_empty_metadata`, `update_metadata_rejects_empty`, and
// `invalid_metadata_pointer_rejected` below.

fn register_n(env: &Env, creator: &Address, client: &VaultRegistryClient<'_>, ids: &[&str]) {
    for id in ids {
        client.register(
            creator,
            &String::from_str(env, id),
            &100i128,
            &String::from_str(env, "ipfs://m"),
            &empty_tags(env),
        );
    }
}

#[test]
fn list_pagination_first_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let page = client.list(&0u32, &3u32);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "r0"));
    assert_eq!(page.get(2).unwrap().id, String::from_str(&env, "r2"));
}

#[test]
fn list_pagination_second_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let page = client.list(&3u32, &3u32);
    assert_eq!(page.len(), 2); // only r3, r4 remain
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "r3"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "r4"));
}

#[test]
fn list_start_beyond_count_returns_empty() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "x"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let page = client.list(&99u32, &10u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn register_extends_resource_storage_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlregister");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn set_price_reextends_resource_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlprice");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT - DAY_IN_LEDGERS
    );

    client.set_price(&id, &200i128);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn update_metadata_reextends_resource_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlmeta");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "https://example.com/old"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);

    client.update_metadata(&id, &String::from_str(&env, "https://example.com/new"));
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn transfer_ownership_reextends_resource_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlxfer");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn propose_transfer_extends_pending_transfer_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlpending");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);

    let proposed = Address::generate(&env);
    client.propose_transfer(&id, &proposed);
    assert_eq!(
        pending_transfer_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn re_proposing_transfer_continues_to_extend_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlpending2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);

    client.propose_transfer(&id, &Address::generate(&env));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);

    // Proposing again (e.g. to fix a typo in the recipient) must re-bump the
    // pending-transfer entry so the recipient still has a full window in
    // which to accept.
    let proposed = Address::generate(&env);
    client.propose_transfer(&id, &proposed);
    assert_eq!(
        pending_transfer_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn list_limit_capped_at_20() {
    let (env, creator, client) = setup();
    let ids = [
        "i00", "i01", "i02", "i03", "i04", "i05", "i06", "i07", "i08", "i09", "i10", "i11", "i12",
        "i13", "i14", "i15", "i16", "i17", "i18", "i19", "i20", "i21", "i22", "i23", "i24",
    ];
    register_n(&env, &creator, &client, &ids);

    // Requesting 25 items should be silently capped to 20.
    let page = client.list(&0u32, &25u32);
    assert_eq!(page.len(), 20);
}

#[test]
fn list_listed_excludes_delisted() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c"]);

    client.set_listed(&String::from_str(&env, "b"), &false);

    let page = client.list_listed(&0u32, &20u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "a"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "c"));
}

#[test]
fn list_listed_empty_when_no_resources() {
    let (_env, _creator, client) = setup();
    let page = client.list_listed(&0u32, &20u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_listed_relisted_reappears() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b"]);

    client.set_listed(&String::from_str(&env, "b"), &false);
    assert_eq!(client.list_listed(&0u32, &20u32).len(), 1);

    client.set_listed(&String::from_str(&env, "b"), &true);
    assert_eq!(client.list_listed(&0u32, &20u32).len(), 2);
}

#[test]
fn list_listed_pagination_first_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c", "d", "e"]);

    client.set_listed(&String::from_str(&env, "b"), &false);
    client.set_listed(&String::from_str(&env, "d"), &false);

    let page = client.list_listed(&0u32, &2u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "a"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "c"));
}

#[test]
fn list_listed_pagination_second_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c", "d", "e"]);

    client.set_listed(&String::from_str(&env, "b"), &false);

    let page = client.list_listed(&2u32, &2u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "c"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "d"));
}

#[test]
fn list_listed_start_beyond_listed_items_returns_empty() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b"]);

    let page = client.list_listed(&20u32, &10u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_listed_limit_capped_at_20() {
    let (env, creator, client) = setup();
    let ids: [&str; 25] = [
        "i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10", "i11", "i12", "i13",
        "i14", "i15", "i16", "i17", "i18", "i19", "i20", "i21", "i22", "i23", "i24",
    ];
    register_n(&env, &creator, &client, &ids);

    // Delist the last 5 so result length can be reached only by traversing the cap.
    for idx in [20, 21, 22, 23, 24] {
        client.set_listed(&String::from_str(&env, ids[idx]), &false);
    }

    let page = client.list_listed(&0u32, &25u32);
    assert_eq!(page.len(), 20);
}

#[test]
fn list_page_empty_is_end_of_list() {
    let (_env, _creator, client) = setup();
    let page = client.list_page(&0u32, &20u32);
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn list_page_exposes_next_cursor_then_end() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let first = client.list_page(&0u32, &3u32);
    assert_eq!(first.items.len(), 3);
    assert_eq!(first.items.get(0).unwrap().id, String::from_str(&env, "r0"));
    assert_eq!(first.items.get(2).unwrap().id, String::from_str(&env, "r2"));
    assert_eq!(first.next_cursor, Some(3u32));

    let second = client.list_page(&first.next_cursor.unwrap(), &3u32);
    assert_eq!(second.items.len(), 2);
    assert_eq!(
        second.items.get(0).unwrap().id,
        String::from_str(&env, "r3")
    );
    assert_eq!(
        second.items.get(1).unwrap().id,
        String::from_str(&env, "r4")
    );
    assert_eq!(second.next_cursor, None);
}

#[test]
fn list_page_cursor_past_end_is_empty_end_of_list() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "x"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let page = client.list_page(&99u32, &10u32);
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn list_page_exact_page_boundary_is_end_of_list() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c"]);

    let page = client.list_page(&0u32, &3u32);
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn list_delegates_to_list_page_items() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let body = client.list(&0u32, &3u32);
    let page = client.list_page(&0u32, &3u32);
    assert_eq!(body.len(), page.items.len());
    assert_eq!(body.get(0).unwrap().id, page.items.get(0).unwrap().id);
    assert_eq!(body.get(2).unwrap().id, page.items.get(2).unwrap().id);
}

#[test]
fn list_page_limit_capped_at_20_with_next_cursor() {
    let (env, creator, client) = setup();
    let ids = [
        "i00", "i01", "i02", "i03", "i04", "i05", "i06", "i07", "i08", "i09", "i10", "i11", "i12",
        "i13", "i14", "i15", "i16", "i17", "i18", "i19", "i20", "i21", "i22", "i23", "i24",
    ];
    register_n(&env, &creator, &client, &ids);

    let page = client.list_page(&0u32, &25u32);
    assert_eq!(page.items.len(), 20);
    assert_eq!(page.next_cursor, Some(20u32));
}

/// `list_by_creator` silently caps the requested page size at `LIST_PAGE_CAP`
/// (20). Registering 25 resources under a single creator and requesting 25
/// must return exactly 20.
///
/// This mirrors the standalone cap regression tests for `list`, `list_listed`,
/// and `list_page` but exercises the creator-index path specifically.
#[test]
fn list_by_creator_limit_capped_at_20() {
    let (env, creator, client) = setup();
    let ids = [
        "c00", "c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11",
        "c12", "c13", "c14", "c15", "c16", "c17", "c18", "c19", "c20", "c21", "c22", "c23",
        "c24",
    ];
    register_n(&env, &creator, &client, &ids);

    // Requesting 25 items should be silently capped to 20.
    let page = client.list_by_creator(&creator, &0u32, &25u32);
    assert_eq!(page.len(), 20);
}

#[test]
fn register_with_tags_stores_labels() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "tagged");
    let metadata = String::from_str(&env, "ipfs://QmTagged");
    let resource_tags = tags(&env, &["dataset", "research"]);

    client.register(&creator, &id, &100i128, &metadata, &resource_tags);

    let r = client.get(&id);
    assert_eq!(r.metadata, metadata);
    assert_eq!(r.tags.len(), 2);
    assert_eq!(r.tags.get(0).unwrap(), String::from_str(&env, "dataset"));
    assert_eq!(r.tags.get(1).unwrap(), String::from_str(&env, "research"));
}

#[test]
fn set_tags_updates_value_without_touching_metadata() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "tagupdate");
    let metadata = String::from_str(&env, "ipfs://QmKeepMeta");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    let new_tags = tags(&env, &["finance", "api"]);
    client.set_tags(&id, &new_tags);

    let r = client.get(&id);
    assert_eq!(r.metadata, metadata);
    assert_eq!(r.tags.len(), 2);
    assert_eq!(r.tags.get(0).unwrap(), String::from_str(&env, "finance"));
}

#[test]
fn invalid_metadata_pointer_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "badpointer");
    let metadata = String::from_str(&env, "not-a-supported-pointer");

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id));
}

#[test]
fn register_accepts_supported_metadata_schemes() {
    let (env, creator, client) = setup();
    // Every scheme the contract recognises must be accepted on registration.
    let valid = [
        "ipfs://QmVal",
        "ar://abc123",
        "https://example.com/asset",
        "http://example.com/asset",
        "0x7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "sha-256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    ];
    for (i, m) in valid.iter().enumerate() {
        let id = String::from_str(&env, &format!("schm{}", i));
        client.register(
            &creator,
            &id,
            &100i128,
            &String::from_str(&env, m),
            &empty_tags(&env),
        );
        assert_eq!(client.get(&id).metadata, String::from_str(&env, m));
    }
}

#[test]
fn register_rejects_unknown_metadata_schemes() {
    let (env, creator, client) = setup();
    // Unsupported schemes must be rejected even when they look URI-like.
    let invalid = [
        "ftp://example.com/file",
        "file:///etc/passwd",
        "data:text/plain,hello",
        "git://example.com/repo",
        "beanstalk://example.com",
    ];
    for (i, m) in invalid.iter().enumerate() {
        let id = String::from_str(&env, &format!("badschm{}", i));
        assert_eq!(
            client.try_register(
                &creator,
                &id,
                &100i128,
                &String::from_str(&env, m),
                &empty_tags(&env)
            ),
            Err(Ok(Error::InvalidMetadataPointer))
        );
        assert!(!client.exists(&id));
    }
}

#[test]
fn metadata_scheme_matching_is_case_sensitive_and_requires_delimiter() {
    let (env, creator, client) = setup();

    // Scheme matching is byte-exact and lowercase-only, so an uppercase
    // variant of a known scheme is not recognised.
    let id = String::from_str(&env, "uppersl");
    assert_eq!(
        client.try_register(
            &creator,
            &id,
            &100i128,
            &String::from_str(&env, "IPFS://QmVal"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id));

    // A bare scheme with no '://' delimiter is not a recognised pointer.
    let id2 = String::from_str(&env, "noschema");
    assert_eq!(
        client.try_register(
            &creator,
            &id2,
            &100i128,
            &String::from_str(&env, "ipfs"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id2));
}

#[test]
fn invalid_tag_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "badtag");
    let metadata = String::from_str(&env, "ipfs://m");
    let empty = String::from_str(&env, "");
    let mut bad = Vec::new(&env);
    bad.push_back(empty);

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &bad),
        Err(Ok(Error::InvalidTag))
    );
    assert!(!client.exists(&id));

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert_eq!(client.try_set_tags(&id, &bad), Err(Ok(Error::InvalidTag)));
}

#[test]
fn admin_transfer_nominate_then_accept() {
    let (env, _creator, client) = setup();
    let initial_admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    // Set initial admin
    assert_eq!(client.admin(), None);
    client.nominate_new_admin(&initial_admin);
    assert_eq!(client.admin(), Some(initial_admin.clone()));
    assert_eq!(client.pending_admin(), None);

    // Nominate new admin
    client.nominate_new_admin(&new_admin);
    assert_eq!(client.admin(), Some(initial_admin.clone()));
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));

    // Accept admin nomination
    client.accept_admin(&new_admin);
    assert_eq!(client.admin(), Some(new_admin));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn accept_admin_rejects_wrong_caller() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending = Address::generate(&env);
    let wrong = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending);

    assert_eq!(
        client.try_accept_admin(&wrong),
        Err(Ok(Error::PendingAdminNotSet))
    );
    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.pending_admin(), Some(pending));
}

#[test]
fn accept_admin_without_pending_returns_not_set() {
    let (env, _creator, client) = setup();
    let caller = Address::generate(&env);

    assert_eq!(
        client.try_accept_admin(&caller),
        Err(Ok(Error::PendingAdminNotSet))
    );
}

#[test]
fn nominate_new_admin_rejects_same_address() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    client.nominate_new_admin(&admin);
    assert_eq!(
        client.try_nominate_new_admin(&admin),
        Err(Ok(Error::SameAdmin))
    );
}

#[test]
fn nominate_new_admin_rejects_pending_already_set() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending1 = Address::generate(&env);
    let pending2 = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending1);

    assert_eq!(
        client.try_nominate_new_admin(&pending2),
        Err(Ok(Error::PendingAdminAlreadySet))
    );
}
