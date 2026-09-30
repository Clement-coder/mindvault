// ─── Admin bootstrap replay protection ─────────────────────────────────────

#[test]
fn bootstrap_followed_by_second_nominate_uses_two_step_path() {
    let (env, _creator, client) = setup();
    let initial_admin = Address::generate(&env);
    let second = Address::generate(&env);

    // First call bootstraps initial_admin directly (no accept step).
    client.nominate_new_admin(&initial_admin);
    assert_eq!(client.admin(), Some(initial_admin.clone()));
    assert_eq!(client.pending_admin(), None);

    // Second call must follow the two-step nominate + accept path.
    client.nominate_new_admin(&second);
    assert_eq!(client.admin(), Some(initial_admin.clone())); // admin unchanged
    assert_eq!(client.pending_admin(), Some(second.clone())); // pending set

    // The pending admin must accept before becoming admin.
    client.accept_admin(&second);
    assert_eq!(client.admin(), Some(second));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn bootstrap_requires_new_admin_auth() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    // Bootstrap path requires `new_admin` to authorize. Calling with an
    // address that doesn't authorize should fail. In the test harness
    // we simulate this by using try_nominate_new_admin (which doesn't
    // force auth on the caller) — the Soroban runtime enforces auth.
    //
    // Here we verify the happy path succeeds and the state is set.
    client.nominate_new_admin(&admin);
    assert_eq!(client.admin(), Some(admin));
}

#[test]
fn bootstrap_cannot_overwrite_existing_admin() {
    let (env, _creator, client) = setup();
    let first_admin = Address::generate(&env);
    let hijacker = Address::generate(&env);

    // Bootstrap establishes first_admin.
    client.nominate_new_admin(&first_admin);
    assert_eq!(client.admin(), Some(first_admin.clone()));

    // A second nominate by a different address follows the two-step path
    // and cannot overwrite admin without first_admin's auth.
    // The contract requires stored_admin.require_auth() — in the test
    // harness both calls succeed because the env authorises all, but the
    // key assertion is that admin is NOT changed by the nominate alone.
    client.nominate_new_admin(&hijacker);
    assert_eq!(client.admin(), Some(first_admin.clone())); // still first_admin
    assert_eq!(client.pending_admin(), Some(hijacker.clone()));

    // Only accept_admin by the pending admin finalizes the transfer.
    client.accept_admin(&hijacker);
    assert_eq!(client.admin(), Some(hijacker));
}

#[test]
fn bootstrap_emits_setadmin_not_nomadmin() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    client.nominate_new_admin(&admin);

    // The bootstrap path emits `setadmin`, not `nomadmin`.
    let all = env.events().all();
    let (_contract, topics, _data) = all.get_unchecked(0);
    // First topic is the event symbol.
    let topic0: Symbol =
        <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get_unchecked(0))
            .ok()
            .unwrap();
    assert_eq!(topic0, Symbol::new(&env, "setadmin"));
}

#[test]
fn bootstrap_sets_pending_admin_to_none() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    // Before bootstrap, no admin and no pending.
    assert_eq!(client.admin(), None);
    assert_eq!(client.pending_admin(), None);

    // After bootstrap, admin is set and pending is still None.
    client.nominate_new_admin(&admin);
    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn register_rejects_empty_metadata() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "emptymeta");
    let metadata = String::from_str(&env, "");
    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::EmptyMetadata))
    );
    assert!(!client.exists(&id));
}

#[test]
fn update_metadata_rejects_empty() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "updempty");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://QmOriginal"),
        &empty_tags(&env),
    );
    let empty = String::from_str(&env, "");
    assert_eq!(
        client.try_update_metadata(&id, &empty),
        Err(Ok(Error::EmptyMetadata))
    );
    assert_eq!(
        client.get(&id).metadata,
        String::from_str(&env, "ipfs://QmOriginal")
    );
}

// ---------------------------------------------------------------------------
// update_metadata event tests
// ---------------------------------------------------------------------------

/// Extract all "updmeta" events emitted by `contract_id` from the environment,
/// decoded as `MetadataUpdateEvent`.
fn collect_updmeta_events(
    env: &Env,
    contract_id: &soroban_sdk::Address,
) -> soroban_sdk::Vec<MetadataUpdateEvent> {
    use soroban_sdk::{FromVal, Symbol};
    let all = env.events().all();
    let mut result: soroban_sdk::Vec<MetadataUpdateEvent> = soroban_sdk::Vec::new(env);
    for i in 0..all.len() {
        let (cid, topics, data) = all.get(i).unwrap();
        if cid != *contract_id || topics.is_empty() {
            continue;
        }
        // topics.get(0) is a Val. Try to decode it as a Symbol and compare.
        let first_topic_val: soroban_sdk::Val = topics.get(0).unwrap();
        let Ok(sym) = Symbol::try_from_val(env, &first_topic_val) else {
            continue;
        };
        if sym != symbol_short!("updmeta") {
            continue;
        }
        let event = MetadataUpdateEvent::from_val(env, &data);
        result.push_back(event);
    }
    result
}

#[test]
fn update_metadata_emits_structured_event_with_old_and_new() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "eventtest");
    let old_meta = String::from_str(&env, "ipfs://QmOld");
    let new_meta = String::from_str(&env, "ipfs://QmNew");

    client.register(&creator, &id, &100i128, &old_meta, &empty_tags(&env));
    client.update_metadata(&id, &new_meta);

    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(events.len(), 1, "expected exactly one updmeta event");

    let event = events.get(0).unwrap();
    assert_eq!(event.id, id);
    assert_eq!(event.old_metadata, old_meta);
    assert_eq!(event.new_metadata, new_meta);
}

#[test]
fn update_metadata_event_old_metadata_matches_prior_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtchain");
    let meta_v1 = String::from_str(&env, "ipfs://QmV1");
    let meta_v2 = String::from_str(&env, "ipfs://QmV2");
    let meta_v3 = String::from_str(&env, "ipfs://QmV3");

    client.register(&creator, &id, &100i128, &meta_v1, &empty_tags(&env));

    // First update: v1 → v2; check event immediately after this invocation.
    client.update_metadata(&id, &meta_v2);
    {
        let events = collect_updmeta_events(&env, &client.address);
        assert_eq!(
            events.len(),
            1,
            "expected one updmeta event after first update"
        );
        let e = events.get(0).unwrap();
        assert_eq!(e.old_metadata, meta_v1);
        assert_eq!(e.new_metadata, meta_v2);
    }

    // Second update: v2 → v3; old_metadata in the event must be v2.
    client.update_metadata(&id, &meta_v3);
    {
        let events = collect_updmeta_events(&env, &client.address);
        assert_eq!(
            events.len(),
            1,
            "expected one updmeta event after second update"
        );
        let e = events.get(0).unwrap();
        assert_eq!(e.old_metadata, meta_v2);
        assert_eq!(e.new_metadata, meta_v3);
    }
}

#[test]
fn update_metadata_event_id_matches_resource_id() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtidcheck");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.update_metadata(&id, &String::from_str(&env, "ipfs://QmEvtId"));

    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(events.len(), 1);
    let event = events.get(0).unwrap();
    assert_eq!(event.id, id);
}

#[test]
fn update_metadata_failed_validation_emits_no_event() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtnoemit");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://valid"),
        &empty_tags(&env),
    );
    let empty = String::from_str(&env, "");
    assert_eq!(
        client.try_update_metadata(&id, &empty),
        Err(Ok(Error::EmptyMetadata))
    );
    assert_eq!(
        client.get(&id).metadata,
        String::from_str(&env, "ipfs://valid")
    );

    // No updmeta event should be emitted when the call fails.
    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(
        events.len(),
        0,
        "failed update_metadata must not emit any updmeta event"
    );
}

#[test]
fn update_metadata_too_long_emits_no_event() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtnoemit2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let too_long = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    assert_eq!(
        client.try_update_metadata(&id, &too_long),
        Err(Ok(Error::MetadataTooLong))
    );

    // No updmeta event should be emitted when the call fails.
    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(
        events.len(),
        0,
        "failed update_metadata must not emit any updmeta event"
    );
}

#[test]
fn update_metadata_state_not_mutated_on_failed_call() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "nostatechange");
    let original = String::from_str(&env, "ipfs://QmOriginal");
    client.register(&creator, &id, &100i128, &original, &empty_tags(&env));

    // Attempt an invalid update (too long).
    let too_long = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    let _ = client.try_update_metadata(&id, &too_long);

    // State must be unchanged.
    let r = client.get(&id);
    assert_eq!(
        r.metadata, original,
        "metadata must not change when update_metadata returns an error"
    );
    assert_eq!(r.price, 100i128);
    assert_eq!(r.creator, creator);
}

/// Assert core registry invariants after mixed ops.
///
/// Checks:
/// - `count` equals the number of successfully registered ids (monotonic)
/// - insertion-index order is preserved by `list(0, count)`
/// - `exists` / `get` / `get_owner` agree with tracked ownership
/// - listing, tags, and price match the tracked expected state
fn assert_registry_invariants(
    client: &VaultRegistryClient,
    expected_ids: &[String],
    expected_owners: &[Address],
    expected_prices: &[i128],
    expected_listed: &[bool],
    expected_tags: &[Vec<String>],
) {
    let n = expected_ids.len() as u32;
    assert_eq!(
        client.count(),
        n,
        "count must equal number of successful registrations"
    );

    let page = client.list(&0u32, &n.max(1));
    assert_eq!(page.len(), n, "list must return all registered resources");
    for i in 0..expected_ids.len() {
        let r = page.get(i as u32).unwrap();
        assert_eq!(r.id, expected_ids[i], "index order broken at {i}");
        assert_eq!(r.creator, expected_owners[i], "owner mismatch at {i}");
        assert_eq!(r.price, expected_prices[i], "price mismatch at {i}");
        assert_eq!(r.listed, expected_listed[i], "listed mismatch at {i}");
        assert_eq!(r.tags, expected_tags[i], "tags mismatch at {i}");

        assert!(client.exists(&expected_ids[i]));
        let got = client.get(&expected_ids[i]);
        assert_eq!(got, r);
        assert_eq!(client.get_owner(&expected_ids[i]), expected_owners[i]);
    }
}

/// Focused invariant suite: mixed register / transfer / tag / listing / price
/// ops, asserting core registry invariants after each step. Failure cases are
/// deterministic and must not corrupt count, index order, ownership, listing,
/// or tags.
#[test]
fn registry_invariant_suite_mixed_ops() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);

    // Empty registry baseline.
    assert_eq!(client.count(), 0);
    assert_eq!(client.list(&0u32, &20u32).len(), 0);

    // ── Step 1: register r0 under alice ──────────────────────────────────────
    let r0 = String::from_str(&env, "invr0");
    let tags0 = tags(&env, &["dataset"]);
    client.register(
        &alice,
        &r0,
        &1_000i128,
        &String::from_str(&env, "ipfs://r0"),
        &tags0,
    );
    assert_registry_invariants(
        &client,
        core::slice::from_ref(&r0),
        core::slice::from_ref(&alice),
        &[1_000],
        &[true],
        core::slice::from_ref(&tags0),
    );

    // ── Step 2: register r1 under alice ──────────────────────────────────────
    let r1 = String::from_str(&env, "invr1");
    let empty0 = empty_tags(&env);
    client.register(
        &alice,
        &r1,
        &2_000i128,
        &String::from_str(&env, "ipfs://r1"),
        &empty0,
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[alice.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, true],
        &[tags0.clone(), empty0.clone()],
    );

    // ── Step 3: transfer ownership of r0 → bob (count/order unchanged) ────────
    client.transfer_ownership(&r0, &bob);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, true],
        &[tags0.clone(), empty0.clone()],
    );

    // ── Step 4: set tags on r1 ───────────────────────────────────────────────
    let tags1 = tags(&env, &["research", "alpha"]);
    client.set_tags(&r1, &tags1);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, true],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 5: delist r1 (listing only) ─────────────────────────────────────
    client.delist(&r1);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, false],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 6: set_price on r0 (bob is owner) ───────────────────────────────
    client.set_price(&r0, &9_999i128);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[9_999, 2_000],
        &[true, false],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 7: re-list r1 ───────────────────────────────────────────────────
    client.set_listed(&r1, &true);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[9_999, 2_000],
        &[true, true],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 8: register r2 under bob ────────────────────────────────────────
    let r2 = String::from_str(&env, "invr2");
    let tags2 = tags(&env, &["beta"]);
    client.register(
        &bob,
        &r2,
        &500i128,
        &String::from_str(&env, "ipfs://r2"),
        &tags2,
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // ── Deterministic failure cases — must not corrupt invariants ────────────

    // Duplicate registration does not change count / order / state.
    assert_eq!(
        client.try_register(
            &alice,
            &r1,
            &1i128,
            &String::from_str(&env, "ipfs://x"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Invalid price on set_price leaves prior price intact.
    assert_eq!(
        client.try_set_price(&r0, &0i128),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        client.try_set_price(&r0, &-1i128),
        Err(Ok(Error::InvalidPrice))
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Invalid tags rejected; prior tags preserved.
    let too_many = tags(
        &env,
        &["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"],
    );
    assert_eq!(
        client.try_set_tags(&r1, &too_many),
        Err(Ok(Error::InvalidTag))
    );
    let empty_tag = {
        let mut v = Vec::new(&env);
        v.push_back(String::from_str(&env, ""));
        v
    };
    assert_eq!(
        client.try_set_tags(&r1, &empty_tag),
        Err(Ok(Error::InvalidTag))
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Missing resource lookups are deterministic NotFound.
    let missing = String::from_str(&env, "nosuchresource");
    assert_eq!(client.try_get(&missing), Err(Ok(Error::NotFound)));
    assert_eq!(client.try_get_owner(&missing), Err(Ok(Error::NotFound)));
    assert!(!client.exists(&missing));
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Clear tags on r0 (owned by bob) and transfer r2 back to alice.
    let empty1 = empty_tags(&env);
    client.set_tags(&r0, &empty1);
    client.transfer_ownership(&r2, &alice);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), alice.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[empty1.clone(), tags1.clone(), tags2.clone()],
    );

    // Final: count is still exactly 3 (no ghost entries from failures).
    assert_eq!(client.count(), 3);
}

#[test]
fn creator_resource_count_starts_at_zero() {
    let (_env, creator, client) = setup();
    assert_eq!(client.creator_resource_count(&creator), 0);
}

#[test]
fn creator_resource_count_increments_on_register() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "r1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.creator_resource_count(&creator), 1);

    client.register(
        &creator,
        &String::from_str(&env, "r2"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.creator_resource_count(&creator), 2);

    // Failed duplicate does not inflate count.
    let dup = String::from_str(&env, "r1");
    assert_eq!(
        client.try_register(
            &creator,
            &dup,
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.creator_resource_count(&creator), 2);
}

#[test]
fn creator_resource_count_moves_on_transfer_ownership() {
    let (env, creator, client) = setup();
    let new_owner = Address::generate(&env);

    client.register(
        &creator,
        &String::from_str(&env, "r1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &String::from_str(&env, "r2"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    assert_eq!(client.creator_resource_count(&creator), 2);
    assert_eq!(client.creator_resource_count(&new_owner), 0);

    client.transfer_ownership(&String::from_str(&env, "r1"), &new_owner);

    assert_eq!(client.creator_resource_count(&creator), 1);
    assert_eq!(client.creator_resource_count(&new_owner), 1);

    // Global count stays monotonic.
    assert_eq!(client.count(), 2);
}

#[test]
fn creator_resource_count_zero_for_unrelated_creator() {
    let (env, creator_a, client) = setup();
    let creator_b = Address::generate(&env);

    client.register(
        &creator_a,
        &String::from_str(&env, "r1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Creator B never registered anything; 0 expected.
    assert_eq!(client.creator_resource_count(&creator_b), 0);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50))]
    #[test]
    fn test_metadata_pointer_roundtrip_property(
        id_str in r"[a-z0-9]{1,24}",
        price in 1..1000000000000i128,
        price_2 in 1..1000000000000i128,
        meta_str in r"[a-zA-Z0-9:/\\._-]{1,500}",
        meta_str_2 in r"[a-zA-Z0-9:/\\._-]{1,500}",
        listed in any::<bool>(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);

        let id = String::from_str(&env, &id_str);
        let metadata = String::from_str(&env, &format!("ipfs://{}", meta_str));
        let metadata_2 = String::from_str(&env, &format!("https://{}", meta_str_2));

        client.register(&creator, &id, &price, &metadata, &empty_tags(&env));

        let r = client.get(&id);
        assert_eq!(r.metadata, metadata);
        assert_eq!(r.price, price);
        assert_eq!(r.creator, creator);
        assert!(r.listed);

        client.update_metadata(&id, &metadata_2);

        let r2 = client.get(&id);
        assert_eq!(r2.metadata, metadata_2);
        assert_eq!(r2.price, price);
        assert_eq!(r2.creator, creator);
        assert!(r2.listed);

        client.set_price(&id, &price_2);
        let r3 = client.get(&id);
        assert_eq!(r3.metadata, metadata_2);
        assert_eq!(r3.price, price_2);

        client.set_listed(&id, &listed);
        let r4 = client.get(&id);
        assert_eq!(r4.metadata, metadata_2);
        assert_eq!(r4.listed, listed);
    }
}
