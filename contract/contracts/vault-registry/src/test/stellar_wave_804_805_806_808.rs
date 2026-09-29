// Tests for Stellar Wave issues #804, #805, #806, #808
//
// #804 — creator_earnings_estimate: aggregated settled-payment earnings read
// #805 — get_verifier_status_history: paginated verifier status-change history
// #806 — list_by_state: first-class ResourceState paginated query
// #808 — transfer_ownership_with_terms: atomic ownership transfer + terms handoff

// ── Helpers ──────────────────────────────────────────────────────────────────

fn make_settler<'a>(
    env: &Env,
    client: &VaultRegistryClient<'a>,
) -> (Address, Address) {
    let admin = Address::generate(env);
    let settler = Address::generate(env);
    client.nominate_new_admin(&admin);
    client.add_settler(&settler);
    (admin, settler)
}

fn add_verifier_helper<'a>(
    env: &Env,
    client: &VaultRegistryClient<'a>,
) -> Address {
    let admin = Address::generate(env);
    client.nominate_new_admin(&admin);
    let verifier = Address::generate(env);
    client.add_verifier(&verifier);
    verifier
}

// ── Issue #804: creator_earnings_estimate ────────────────────────────────────

#[test]
fn creator_earnings_estimate_returns_zero_for_new_creator() {
    let (env, creator, client) = setup();
    let est = client.creator_earnings_estimate(&creator);
    assert_eq!(est.creator, creator);
    assert_eq!(est.total_settled, 0i128);
    assert_eq!(est.settled_count, 0u32);
}

#[test]
fn creator_earnings_estimate_accumulates_settled_payments() {
    let (env, creator, client) = setup();
    let (_admin, settler) = make_settler(&env, &client);

    let id = String::from_str(&env, "earnres");
    let price = 1_000_000i128;
    client.register(
        &creator,
        &id,
        &price,
        &String::from_str(&env, "ipfs://earn"),
        &empty_tags(&env),
    );

    let payer = Address::generate(&env);

    // Record and settle first payment.
    let r1 = String::from_str(&env, "earn-r1");
    client.record_payment(
        &settler,
        &r1,
        &id,
        &payer,
        &price,
        &String::from_str(&env, "txhash-e1"),
    );
    client.settle_payment(&settler, &r1);

    let est = client.creator_earnings_estimate(&creator);
    assert_eq!(est.total_settled, price);
    assert_eq!(est.settled_count, 1u32);

    // Record and settle second payment.
    let r2 = String::from_str(&env, "earn-r2");
    client.record_payment(
        &settler,
        &r2,
        &id,
        &payer,
        &price,
        &String::from_str(&env, "txhash-e2"),
    );
    client.settle_payment(&settler, &r2);

    let est2 = client.creator_earnings_estimate(&creator);
    assert_eq!(est2.total_settled, price * 2);
    assert_eq!(est2.settled_count, 2u32);
}

#[test]
fn creator_earnings_estimate_only_counts_settled_not_escrowed() {
    let (env, creator, client) = setup();
    let (_admin, settler) = make_settler(&env, &client);

    let id = String::from_str(&env, "earnonly");
    let price = 500_000i128;
    client.register(
        &creator,
        &id,
        &price,
        &String::from_str(&env, "ipfs://earnonly"),
        &empty_tags(&env),
    );

    let payer = Address::generate(&env);

    // Record but do NOT settle — should not affect earnings.
    let r_unsettled = String::from_str(&env, "earn-us");
    client.record_payment(
        &settler,
        &r_unsettled,
        &id,
        &payer,
        &price,
        &String::from_str(&env, "txhash-us"),
    );

    let est = client.creator_earnings_estimate(&creator);
    assert_eq!(est.total_settled, 0i128);
    assert_eq!(est.settled_count, 0u32);
}

#[test]
fn creator_earnings_estimate_is_per_creator() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let (_admin, settler) = make_settler(&env, &client);

    let alice_id = String::from_str(&env, "earnalice");
    let bob_id = String::from_str(&env, "earnbob");
    let price = 1_000_000i128;
    client.register(
        &alice,
        &alice_id,
        &price,
        &String::from_str(&env, "ipfs://alice"),
        &empty_tags(&env),
    );
    client.register(
        &bob,
        &bob_id,
        &price,
        &String::from_str(&env, "ipfs://bob"),
        &empty_tags(&env),
    );

    let payer = Address::generate(&env);

    let ra = String::from_str(&env, "earn-alice-1");
    client.record_payment(
        &settler,
        &ra,
        &alice_id,
        &payer,
        &price,
        &String::from_str(&env, "txhash-a"),
    );
    client.settle_payment(&settler, &ra);

    // Alice's earnings should be updated; Bob's should remain zero.
    let alice_est = client.creator_earnings_estimate(&alice);
    let bob_est = client.creator_earnings_estimate(&bob);
    assert_eq!(alice_est.total_settled, price);
    assert_eq!(alice_est.settled_count, 1u32);
    assert_eq!(bob_est.total_settled, 0i128);
    assert_eq!(bob_est.settled_count, 0u32);
}

// ── Issue #805: get_verifier_status_history ──────────────────────────────────

#[test]
fn verifier_status_history_empty_for_new_verifier() {
    let (env, _creator, client) = setup();
    let verifier = add_verifier_helper(&env, &client);
    let page = client.get_verifier_status_history(&verifier, &0u32, &20u32);
    assert_eq!(page.items.len(), 0u32);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn verifier_status_history_records_each_status_change() {
    let (env, creator, client) = setup();
    let verifier = add_verifier_helper(&env, &client);

    let id = String::from_str(&env, "histres");
    client.register(
        &creator,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://hist"),
        &empty_tags(&env),
    );

    // Pending -> Verified
    client.set_verification_status(
        &id,
        &verifier,
        &VerificationStatus::Verified,
        &Some(String::from_str(&env, "sha256:abc123")),
    );
    // Verified -> Rejected
    client.set_verification_status(
        &id,
        &verifier,
        &VerificationStatus::Rejected,
        &None,
    );

    let page = client.get_verifier_status_history(&verifier, &0u32, &20u32);
    assert_eq!(page.items.len(), 2u32);

    let first = page.items.get(0).unwrap();
    assert_eq!(first.resource_id, id);
    assert_eq!(first.old_status, VerificationStatus::Pending);
    assert_eq!(first.new_status, VerificationStatus::Verified);
    assert!(first.attestation_hash.is_some());

    let second = page.items.get(1).unwrap();
    assert_eq!(second.old_status, VerificationStatus::Verified);
    assert_eq!(second.new_status, VerificationStatus::Rejected);
    assert!(second.attestation_hash.is_none());

    assert_eq!(page.next_cursor, None);
}

#[test]
fn verifier_status_history_paginates_correctly() {
    let (env, creator, client) = setup();
    let verifier = add_verifier_helper(&env, &client);

    // Create multiple resources and set status for each one to build history.
    for i in 0..6u32 {
        let id = String::from_str(&env, &format!("histpg{i:02}"));
        client.register(
            &creator,
            &id,
            &100_000i128,
            &String::from_str(&env, "ipfs://hist"),
            &empty_tags(&env),
        );
        client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    }

    // Page 1: cursor=0, limit=4
    let page1 = client.get_verifier_status_history(&verifier, &0u32, &4u32);
    assert_eq!(page1.items.len(), 4u32);
    assert_eq!(page1.next_cursor, Some(4u32));

    // Page 2: cursor=4, limit=4
    let page2 = client.get_verifier_status_history(&verifier, &4u32, &4u32);
    assert_eq!(page2.items.len(), 2u32);
    assert_eq!(page2.next_cursor, None);
}

#[test]
fn verifier_status_history_is_per_verifier() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    client.nominate_new_admin(&admin);
    let v1 = Address::generate(&env);
    let v2 = Address::generate(&env);
    client.add_verifier(&v1);
    client.add_verifier(&v2);

    let id = String::from_str(&env, "histpervf");
    client.register(
        &creator,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://hist"),
        &empty_tags(&env),
    );

    // Only v1 sets status.
    client.set_verification_status(&id, &v1, &VerificationStatus::Verified, &None);

    let v1_page = client.get_verifier_status_history(&v1, &0u32, &20u32);
    let v2_page = client.get_verifier_status_history(&v2, &0u32, &20u32);
    assert_eq!(v1_page.items.len(), 1u32);
    assert_eq!(v2_page.items.len(), 0u32);
}

// ── Issue #806: list_by_state ─────────────────────────────────────────────────

#[test]
fn list_by_state_returns_empty_on_empty_catalog() {
    let (_env, _creator, client) = setup();
    for state in [
        ResourceState::Listed,
        ResourceState::Delisted,
        ResourceState::Frozen,
        ResourceState::Disputed,
        ResourceState::Tombstoned,
    ] {
        let page = client.list_by_state(&state, &0u32, &20u32);
        assert_eq!(page.items.len(), 0u32, "expected empty for {state:?}");
        assert_eq!(page.next_cursor, None);
    }
}

#[test]
fn list_by_state_distinguishes_all_states() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    client.nominate_new_admin(&admin);

    let listed_id = String::from_str(&env, "stlisted");
    let delisted_id = String::from_str(&env, "stdelstd");
    let frozen_id = String::from_str(&env, "stfroznn");
    let disputed_id = String::from_str(&env, "stdispte");
    let tombstoned_id = String::from_str(&env, "sttombst");

    for id in [
        &listed_id,
        &delisted_id,
        &frozen_id,
        &disputed_id,
        &tombstoned_id,
    ] {
        client.register(
            &creator,
            id,
            &100_000i128,
            &String::from_str(&env, "ipfs://st"),
            &empty_tags(&env),
        );
    }

    // Transition to target states.
    client.delist(&delisted_id);
    client.freeze_resource(&frozen_id);
    client.open_dispute(&disputed_id, &admin);
    client.tombstone_resource(&tombstoned_id, &admin);

    // Each query must return exactly the resource in that state.
    let listed = client.list_by_state(&ResourceState::Listed, &0u32, &20u32);
    let delisted = client.list_by_state(&ResourceState::Delisted, &0u32, &20u32);
    let frozen = client.list_by_state(&ResourceState::Frozen, &0u32, &20u32);
    let disputed = client.list_by_state(&ResourceState::Disputed, &0u32, &20u32);
    let tombstoned = client.list_by_state(&ResourceState::Tombstoned, &0u32, &20u32);

    assert_eq!(listed.items.len(), 1u32);
    assert_eq!(listed.items.get(0).unwrap().id, listed_id);

    assert_eq!(delisted.items.len(), 1u32);
    assert_eq!(delisted.items.get(0).unwrap().id, delisted_id);

    assert_eq!(frozen.items.len(), 1u32);
    assert_eq!(frozen.items.get(0).unwrap().id, frozen_id);

    assert_eq!(disputed.items.len(), 1u32);
    assert_eq!(disputed.items.get(0).unwrap().id, disputed_id);

    assert_eq!(tombstoned.items.len(), 1u32);
    assert_eq!(tombstoned.items.get(0).unwrap().id, tombstoned_id);
}

#[test]
fn list_by_state_paginates_correctly() {
    let (env, creator, client) = setup();

    // Register 5 resources — all start Listed.
    for i in 0..5u32 {
        client.register(
            &creator,
            &String::from_str(&env, &format!("stpg{i:02}")),
            &100_000i128,
            &String::from_str(&env, "ipfs://stpg"),
            &empty_tags(&env),
        );
    }

    let page1 = client.list_by_state(&ResourceState::Listed, &0u32, &3u32);
    assert_eq!(page1.items.len(), 3u32);
    assert_eq!(page1.next_cursor, Some(3u32));

    let page2 = client.list_by_state(&ResourceState::Listed, &3u32, &3u32);
    assert_eq!(page2.items.len(), 2u32);
    assert_eq!(page2.next_cursor, None);
}

#[test]
fn list_by_state_cursor_cap_matches_list_page_cap() {
    let (env, creator, client) = setup();

    for i in 0..25u32 {
        client.register(
            &creator,
            &String::from_str(&env, &format!("stcap{i:02}")),
            &100_000i128,
            &String::from_str(&env, "ipfs://stcap"),
            &empty_tags(&env),
        );
    }

    // Even if limit > LIST_PAGE_CAP, result must be capped at LIST_PAGE_CAP.
    let page = client.list_by_state(&ResourceState::Listed, &0u32, &100u32);
    assert_eq!(page.items.len(), LIST_PAGE_CAP);
}

// ── Issue #808: transfer_ownership_with_terms ─────────────────────────────────

#[test]
fn transfer_ownership_with_terms_transfers_ownership() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);

    let id = String::from_str(&env, "twtres");
    client.register(
        &alice,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twt"),
        &empty_tags(&env),
    );

    client.transfer_ownership_with_terms(&id, &bob, &None, &false);

    let resource = client.get(&id);
    assert_eq!(resource.creator, bob);
}

#[test]
fn transfer_ownership_with_terms_sets_new_owner_terms_hash() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);

    let id = String::from_str(&env, "twtterms");
    client.register(
        &alice,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twtt"),
        &empty_tags(&env),
    );

    let terms = String::from_str(&env, "sha256termsdigest");
    client.transfer_ownership_with_terms(&id, &bob, &Some(terms.clone()), &false);

    // Bob's terms hash should be set.
    let bob_terms = client.get_terms_hash(&bob);
    assert_eq!(bob_terms, terms);
}

#[test]
fn transfer_ownership_with_terms_resets_attestation_when_requested() {
    let (env, creator, client) = setup();
    let new_owner = Address::generate(&env);
    let verifier = add_verifier_helper(&env, &client);

    let id = String::from_str(&env, "twtatt");
    client.register(
        &creator,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twta"),
        &empty_tags(&env),
    );

    // Set an attestation hash.
    client.set_verification_status(
        &id,
        &verifier,
        &VerificationStatus::Verified,
        &Some(String::from_str(&env, "sha256:aaabbbccc")),
    );
    assert!(client.get_attestation_hash(&id).is_some());

    // Transfer with reset_attestation=true — attestation should be cleared.
    client.transfer_ownership_with_terms(&id, &new_owner, &None, &true);
    assert!(client.get_attestation_hash(&id).is_none());
}

#[test]
fn transfer_ownership_with_terms_preserves_attestation_when_not_reset() {
    let (env, creator, client) = setup();
    let new_owner = Address::generate(&env);
    let verifier = add_verifier_helper(&env, &client);

    let id = String::from_str(&env, "twtnoatt");
    client.register(
        &creator,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twtna"),
        &empty_tags(&env),
    );

    client.set_verification_status(
        &id,
        &verifier,
        &VerificationStatus::Verified,
        &Some(String::from_str(&env, "sha256:keepme")),
    );
    assert!(client.get_attestation_hash(&id).is_some());

    // Transfer with reset_attestation=false — attestation should be preserved.
    client.transfer_ownership_with_terms(&id, &new_owner, &None, &false);
    assert!(client.get_attestation_hash(&id).is_some());
}

#[test]
fn transfer_ownership_with_terms_errors_already_owner() {
    let (env, alice, client) = setup();

    let id = String::from_str(&env, "twtdup");
    client.register(
        &alice,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twtd"),
        &empty_tags(&env),
    );

    let res = client.try_transfer_ownership_with_terms(&id, &alice, &None, &false);
    assert_eq!(res, Err(Ok(Error::AlreadyOwner)));
}

#[test]
fn transfer_ownership_with_terms_errors_terms_hash_too_long() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);

    let id = String::from_str(&env, "twtlong");
    client.register(
        &alice,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twtl"),
        &empty_tags(&env),
    );

    // 65 bytes > MAX_TERMS_HASH_LEN (64)
    let too_long = String::from_str(&env, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1");
    let res = client.try_transfer_ownership_with_terms(&id, &bob, &Some(too_long), &false);
    assert_eq!(res, Err(Ok(Error::TermsHashTooLong)));

    // Ownership should NOT have changed.
    assert_eq!(client.get_owner(&id), alice);
}

#[test]
fn transfer_ownership_with_terms_emits_transfer_and_txfrterms_events() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);

    let id = String::from_str(&env, "twtevt");
    client.register(
        &alice,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twte"),
        &empty_tags(&env),
    );

    let terms = String::from_str(&env, "termsdigest");
    client.transfer_ownership_with_terms(&id, &bob, &Some(terms.clone()), &false);

    let all_events = env.events().all();
    let mut saw_transfer = false;
    let mut saw_txfrterms = false;

    for i in 0..all_events.len() {
        let (cid, topics, _data) = all_events.get(i).unwrap();
        if cid != client.address {
            continue;
        }
        if let Ok(sym) = <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap()) {
            if sym == Symbol::new(&env, "transfer") {
                saw_transfer = true;
            }
            if sym == Symbol::new(&env, "txfrterms") {
                saw_txfrterms = true;
            }
        }
    }

    assert!(saw_transfer, "transfer event not emitted");
    assert!(saw_txfrterms, "txfrterms event not emitted");
}

#[test]
fn transfer_ownership_with_terms_clears_pending_transfer() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let charlie = Address::generate(&env);

    let id = String::from_str(&env, "twtpend");
    client.register(
        &alice,
        &id,
        &100_000i128,
        &String::from_str(&env, "ipfs://twtp"),
        &empty_tags(&env),
    );

    // Propose to charlie, then immediately transfer_with_terms to bob.
    client.propose_transfer(&id, &charlie);
    client.transfer_ownership_with_terms(&id, &bob, &None, &false);

    // There should be no pending transfer for charlie anymore.
    // cancel_transfer should error NoPendingTransfer (bob is the new owner).
    let res = client.try_cancel_transfer(&id);
    assert_eq!(res, Err(Ok(Error::NoPendingTransfer)));
}
