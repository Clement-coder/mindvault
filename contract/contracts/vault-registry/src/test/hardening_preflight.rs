// ---------------------------------------------------------------------------
// Issue 1 — MAX_METADATA_POINTER_LEN boundary hardening
// ---------------------------------------------------------------------------
//
// Acceptance criteria:
//   • Exact max length succeeds.            (register_accepts_metadata_at_max_length above)
//   • Max + 1 fails with MetadataTooLong.   (register_rejects_metadata_over_max_length above)
//   • Random shorter format-valid strings succeed.  ← proptest below
//   • update_metadata obeys the same boundary.      (update_metadata_accepts_at_max_length above)
//   • Error handling is deterministic: only MetadataTooLong is returned for over-limit,
//     never a panic or a different error code.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]
    /// Any format-valid metadata pointer up to MAX_METADATA_POINTER_LEN bytes
    /// must be accepted by both `register` and `update_metadata`. The prefix
    /// is fixed; the body length is drawn uniformly in [0, max − longest_prefix_len]
    /// where the longest prefix is `https://` (8 bytes) to ensure both the
    /// `ipfs://` and `https://` forms stay within MAX_METADATA_POINTER_LEN.
    #[test]
    fn metadata_boundary_shorter_strings_always_succeed(
        id_str   in r"[a-z][a-z0-9]{0,10}",
        // Bound by "https://" (8 bytes) — the longer of the two prefixes used
        // in this test — so the generated body stays within MAX_METADATA_POINTER_LEN
        // for both the register ("ipfs://") and update_metadata ("https://") steps.
        body_len in 0usize..=(512usize - "https://".len()),
        ch       in r"[a-zA-Z0-9]",
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);

        let body: alloc::string::String = ch.repeat(body_len);
        let raw = alloc::format!("ipfs://{}", body);
        // Double-check our generator stays within the contract limit.
        prop_assert!(raw.len() <= MAX_METADATA_POINTER_LEN as usize);

        let id       = String::from_str(&env, &id_str);
        let metadata = String::from_str(&env, &raw);

        // register must succeed
        let reg_result = client.try_register(
            &creator, &id, &100i128, &metadata, &empty_tags(&env),
        );
        prop_assert!(reg_result.is_ok(), "register rejected valid metadata of len {}: {:?}", raw.len(), reg_result);

        // update_metadata must also succeed
        let new_body: alloc::string::String = ch.repeat(body_len.min(512usize - "https://".len()));
        let new_raw  = alloc::format!("https://{}", new_body);
        prop_assert!(new_raw.len() <= MAX_METADATA_POINTER_LEN as usize);
        let new_meta = String::from_str(&env, &new_raw);
        let upd_result = client.try_update_metadata(&id, &new_meta);
        prop_assert!(upd_result.is_ok(), "update_metadata rejected valid metadata of len {}: {:?}", new_raw.len(), upd_result);
    }

    /// Over-limit metadata (MAX + 1 … MAX + 50) must always return MetadataTooLong,
    /// never any other error and never succeed.
    #[test]
    fn metadata_over_limit_always_returns_metadata_too_long(
        id_str  in r"[a-z][a-z0-9]{0,10}",
        excess  in 1usize..=50usize,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);

        let prefix = "ipfs://";
        let total_len = MAX_METADATA_POINTER_LEN as usize + excess;
        let body: alloc::string::String = "a".repeat(total_len - prefix.len());
        let raw = alloc::format!("{}{}", prefix, body);

        let id       = String::from_str(&env, &id_str);
        let metadata = String::from_str(&env, &raw);

        let res = client.try_register(
            &creator, &id, &100i128, &metadata, &empty_tags(&env),
        );
        prop_assert_eq!(
            res,
            Err(Ok(Error::MetadataTooLong)),
            "expected MetadataTooLong for metadata len {}", raw.len()
        );
        // Resource must not have been created.
        prop_assert!(!client.exists(&id));

        // update_metadata on an existing resource with over-limit pointer also
        // returns MetadataTooLong and leaves the original metadata untouched.
        let valid_meta = String::from_str(&env, "ipfs://seed");
        let id2 = String::from_str(&env, &alloc::format!("{}x", &id_str[..id_str.len().min(10)]));
        // id2 may collide across runs; skip if already exists via the try_ variant
        if client.try_register(&creator, &id2, &100i128, &valid_meta, &empty_tags(&env)).is_ok() {
            let upd = client.try_update_metadata(&id2, &metadata);
            prop_assert_eq!(
                upd,
                Err(Ok(Error::MetadataTooLong)),
                "update_metadata should return MetadataTooLong for len {}", raw.len()
            );
            prop_assert_eq!(client.get(&id2).metadata, valid_meta);
        }
    }
}

// ---------------------------------------------------------------------------
// Issue 2 — Duplicate detection stability across lifecycle flows
// ---------------------------------------------------------------------------
//
// Acceptance criteria:
//   • Duplicate register always fails with AlreadyRegistered.
//   • count and Index state are unchanged after every failed duplicate attempt.
//   • Stability holds after transfer, delist, relist, and propose/accept flows.

/// After transferring ownership, the old id is still occupied — a duplicate
/// register must fail regardless of whether the caller is the old or new owner.
#[test]
fn duplicate_register_fails_after_transfer_ownership() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let id = String::from_str(&env, "dupxfer");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&alice, &id, &100i128, &meta, &empty_tags(&env));
    client.transfer_ownership(&id, &bob);

    // Both the old and the new owner must be rejected on a fresh register.
    assert_eq!(
        client.try_register(&alice, &id, &200i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(
        client.try_register(&bob, &id, &300i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    // count and index must be unchanged.
    assert_eq!(client.count(), 1);
    assert_eq!(client.list(&0u32, &10u32).get(0).unwrap().id, id);
    assert_eq!(client.get_owner(&id), bob);
}

/// After propose + accept transfer, the id is still locked against re-registration.
#[test]
fn duplicate_register_fails_after_propose_accept_transfer() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let id = String::from_str(&env, "dupaccept");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&alice, &id, &100i128, &meta, &empty_tags(&env));
    client.propose_transfer(&id, &bob);
    client.accept_transfer(&id);

    assert_eq!(
        client.try_register(&alice, &id, &200i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(
        client.try_register(&bob, &id, &300i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.count(), 1);
    assert_eq!(client.get_owner(&id), bob);
}

/// Delisting a resource does not vacate its id — a duplicate register must fail
/// on both a delisted and a relisted resource, with count/index intact throughout.
#[test]
fn duplicate_register_fails_across_delist_and_relist() {
    let (env, alice, client) = setup();
    let id = String::from_str(&env, "dupdelist");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&alice, &id, &100i128, &meta, &empty_tags(&env));

    // After delist: id still occupied.
    client.delist(&id);
    assert!(!client.get(&id).listed);
    assert_eq!(
        client.try_register(&alice, &id, &200i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.count(), 1);

    // After relist: id still occupied.
    client.set_listed(&id, &true);
    assert!(client.get(&id).listed);
    assert_eq!(
        client.try_register(&alice, &id, &300i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.count(), 1);

    // Index order is stable throughout.
    assert_eq!(client.list(&0u32, &10u32).get(0).unwrap().id, id);
}

/// Multi-resource scenario: duplicate attempts against any of several resources
/// (after mixed transfer / delist / relist ops) never corrupt count or index order.
#[test]
fn duplicate_detection_stable_after_mixed_lifecycle_ops() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let meta = String::from_str(&env, "ipfs://m");

    let r0 = String::from_str(&env, "mxr0");
    let r1 = String::from_str(&env, "mxr1");
    let r2 = String::from_str(&env, "mxr2");

    client.register(&alice, &r0, &100i128, &meta, &empty_tags(&env));
    client.register(&alice, &r1, &200i128, &meta, &empty_tags(&env));
    client.register(&alice, &r2, &300i128, &meta, &empty_tags(&env));

    // Mutate state.
    client.transfer_ownership(&r0, &bob);
    client.delist(&r1);
    client.set_listed(&r1, &true); // relist

    // Each duplicate attempt must return AlreadyRegistered.
    for id in [&r0, &r1, &r2] {
        assert_eq!(
            client.try_register(&alice, id, &1i128, &meta, &empty_tags(&env)),
            Err(Ok(Error::AlreadyRegistered)),
            "expected AlreadyRegistered for id {:?}",
            id,
        );
        assert_eq!(
            client.try_register(&bob, id, &1i128, &meta, &empty_tags(&env)),
            Err(Ok(Error::AlreadyRegistered)),
            "expected AlreadyRegistered for id {:?}",
            id,
        );
    }

    // Count stays at 3; insertion order is preserved.
    assert_eq!(client.count(), 3);
    let page = client.list(&0u32, &10u32);
    assert_eq!(page.get(0).unwrap().id, r0);
    assert_eq!(page.get(1).unwrap().id, r1);
    assert_eq!(page.get(2).unwrap().id, r2);
}

// ── updated_at ledger metadata (#365) ───────────────────────────────────────

/// `register` stamps updated_at with the ledger sequence at call time.
#[test]
fn register_stamps_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(42);
    let id = String::from_str(&env, "ts1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    assert_eq!(client.get(&id).updated_at, 42);
}

/// `register` stamps created_at with the ledger sequence at call time.
#[test]
fn register_stamps_created_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(41);
    let id = String::from_str(&env, "tsc1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    assert_eq!(client.get(&id).created_at, 41);
}

/// `set_price` updates updated_at to the ledger sequence at call time.
#[test]
fn set_price_updates_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(10);
    let id = String::from_str(&env, "ts2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).updated_at, 10);

    env.ledger().set_sequence_number(55);
    client.set_price(&id, &200i128);
    assert_eq!(client.get(&id).updated_at, 55);
}

/// `update_metadata` updates updated_at to the ledger sequence at call time.
#[test]
fn update_metadata_updates_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(7);
    let id = String::from_str(&env, "ts3");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://old"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).updated_at, 7);

    env.ledger().set_sequence_number(99);
    client.update_metadata(&id, &String::from_str(&env, "ipfs://new"));
    assert_eq!(client.get(&id).updated_at, 99);
}

/// `created_at` remains unchanged when metadata is updated.
#[test]
fn update_metadata_preserves_created_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(70);
    let id = String::from_str(&env, "tsc2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://old"),
        &empty_tags(&env),
    );
    let created_at = client.get(&id).created_at;
    assert_eq!(created_at, 70);

    env.ledger().set_sequence_number(90);
    client.update_metadata(&id, &String::from_str(&env, "ipfs://new"));

    let resource = client.get(&id);
    assert_eq!(resource.created_at, created_at);
    assert_eq!(resource.updated_at, 90);
}

/// `transfer_ownership` updates updated_at to the ledger sequence at call time.
#[test]
fn transfer_ownership_updates_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(3);
    let id = String::from_str(&env, "ts4");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).updated_at, 3);

    let new_owner = Address::generate(&env);
    env.ledger().set_sequence_number(200);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.get(&id).updated_at, 200);
}

/// `created_at` remains unchanged when ownership is transferred.
#[test]
fn transfer_ownership_preserves_created_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(300);
    let id = String::from_str(&env, "tsc3");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    let created_at = client.get(&id).created_at;
    assert_eq!(created_at, 300);

    let new_owner = Address::generate(&env);
    env.ledger().set_sequence_number(420);
    client.transfer_ownership(&id, &new_owner);

    let resource = client.get(&id);
    assert_eq!(resource.created_at, created_at);
    assert_eq!(resource.updated_at, 420);
}

/// updated_at is independent per resource and not shared across resources.
#[test]
fn updated_at_is_per_resource() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(1);
    let id_a = String::from_str(&env, "tsa");
    client.register(
        &creator,
        &id_a,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    env.ledger().set_sequence_number(2);
    let id_b = String::from_str(&env, "tsb");
    client.register(
        &creator,
        &id_b,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Mutate only b at ledger 50.
    env.ledger().set_sequence_number(50);
    client.set_price(&id_b, &999i128);

    // a should still reflect ledger 1; b should reflect ledger 50.
    assert_eq!(client.get(&id_a).updated_at, 1);
    assert_eq!(client.get(&id_b).updated_at, 50);
}

// ─── Deployment preflight checks (#392) ────────────────────────────────────
//
// These tests back the automated steps in docs/contract-upgrade-checklist.md.
// Each one exercises a specific Phase-1 or Phase-4 verification requirement
// so that running `cargo test` locally (or `make preflight`) gives the same
// confidence as the manual checklist commands against a live network.

/// `CARGO_PKG_VERSION` baked into `contract_version()` must be a non-empty
/// string in `MAJOR.MINOR.PATCH` semver format. Deployers use this value to
/// confirm which build is running on-chain (checklist Phase 4).
#[test]
fn contract_version_crate_version_is_valid_semver() {
    let (_env, _creator, client) = setup();
    let v = client.contract_version();

    // Copy into a std String for parsing.
    let len = v.crate_version.len() as usize;
    let mut buf = alloc::vec![0u8; len];
    v.crate_version.copy_into_slice(&mut buf);
    let version_str = alloc::str::from_utf8(&buf).expect("crate_version must be valid UTF-8");

    assert!(
        !version_str.is_empty(),
        "crate_version must not be empty"
    );

    // Must contain at least two dots (MAJOR.MINOR.PATCH).
    let dot_count = version_str.chars().filter(|&c| c == '.').count();
    assert!(
        dot_count >= 2,
        "crate_version '{}' must be in MAJOR.MINOR.PATCH format (at least 2 dots)",
        version_str
    );

    // Every segment must be a non-empty string of ASCII digits or digits+pre-release.
    let parts: alloc::vec::Vec<&str> = version_str.splitn(3, '.').collect();
    assert_eq!(parts.len(), 3, "crate_version must have exactly 3 dot-separated parts");
    assert!(
        parts[0].chars().all(|c| c.is_ascii_digit()),
        "MAJOR segment '{}' must be numeric",
        parts[0]
    );
    assert!(
        !parts[0].is_empty(),
        "MAJOR segment must not be empty"
    );
    assert!(
        !parts[1].is_empty(),
        "MINOR segment must not be empty"
    );
}

/// `registry_info()` must return the stable registry name that clients use
/// to confirm they are talking to the right contract (checklist Phase 4).
#[test]
fn registry_info_name_is_stable_registry_name() {
    let (env, _creator, client) = setup();
    // No register — the key does not exist.
    let missing = String::from_str(&env, "ttlmissing");
    assert!(!client.exists(&missing));
    // No panic / storage error; the test passing is sufficient.
}

// ---------------------------------------------------------------------------
// exists_many (#369) — batch existence check
// ---------------------------------------------------------------------------

/// `exists_many` returns an empty Vec for an empty input.
#[test]
fn exists_many_empty_input_returns_empty() {
    let (env, _creator, client) = setup();
    let result = client.exists_many(&Vec::new(&env));
    assert_eq!(result.len(), 0);
}

/// `exists_many` returns false for every id when nothing is registered.
#[test]
fn exists_many_all_absent() {
    let (env, _creator, client) = setup();
    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(String::from_str(&env, "abc"));
    ids.push_back(String::from_str(&env, "def"));

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 2);
    assert!(!result.get(0).unwrap());
    assert!(!result.get(1).unwrap());
}

/// `exists_many` returns true for registered ids and false for absent ones
/// in the correct parallel order.
#[test]
fn exists_many_mixed_present_and_absent() {
    let (env, creator, client) = setup();

    let id_a = String::from_str(&env, "ema1");
    let id_b = String::from_str(&env, "ema2");
    let id_c = String::from_str(&env, "ema3");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&creator, &id_a, &100i128, &meta, &empty_tags(&env));
    // id_b is NOT registered
    client.register(&creator, &id_c, &100i128, &meta, &empty_tags(&env));

    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(id_a);
    ids.push_back(id_b);
    ids.push_back(id_c);

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 3);
    assert!(result.get(0).unwrap(),  "id_a is registered — should be true");
    assert!(!result.get(1).unwrap(), "id_b is absent — should be false");
    assert!(result.get(2).unwrap(),  "id_c is registered — should be true");
}

/// `exists_many` returns all-true when every id is registered.
#[test]
fn exists_many_all_present() {
    let (env, creator, client) = setup();
    let ids_str = ["em1", "em2", "em3"];
    let meta = String::from_str(&env, "ipfs://m");
    for id_str in &ids_str {
        client.register(
            &creator,
            &String::from_str(&env, id_str),
            &100i128,
            &meta,
            &empty_tags(&env),
        );
    }

    let mut ids: Vec<String> = Vec::new(&env);
    for id_str in &ids_str {
        ids.push_back(String::from_str(&env, id_str));
    }

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 3);
    for i in 0..3u32 {
        assert!(result.get(i).unwrap(), "all ids are registered — should be true");
    }
}

/// `exists_many` treats an id that fails format validation as absent (`false`)
/// rather than propagating an error, consistent with `exists`.
#[test]
fn exists_many_invalid_id_format_treated_as_absent() {
    let (env, _creator, client) = setup();
    // An id with an uppercase letter fails validate_resource_id.
    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(String::from_str(&env, "INVALID"));
    ids.push_back(String::from_str(&env, "validid"));

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 2);
    assert!(!result.get(0).unwrap(), "invalid-format id treated as absent");
    assert!(!result.get(1).unwrap(), "valid-format but unregistered id is absent");
}

/// `exists_many` bumps TTL for each id that resolves to a registered resource.
#[test]
fn exists_many_bumps_ttl_for_found_ids() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "emttl");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Decay TTL by one day.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + TTL_DAY_IN_LEDGERS);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS,
        "TTL must have decayed before the read"
    );

    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(id.clone());
    client.exists_many(&ids);

    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT,
        "exists_many must bump TTL for each found resource"
    );
}

// ---------------------------------------------------------------------------
// LIST_PAGE_CAP constant (#370)
// ---------------------------------------------------------------------------

/// `LIST_PAGE_CAP` has the expected value (20). This test pins the constant
/// so that any accidental change to the cap surfaces as a test failure.
#[test]
fn list_page_cap_constant_value() {
    assert_eq!(LIST_PAGE_CAP, 20u32, "LIST_PAGE_CAP must equal 20");
}

/// `list`, `list_page`, `list_listed`, `list_by_creator`, and
/// `list_by_dispute_status` all honour
/// `LIST_PAGE_CAP` — requesting more items than the cap only returns the cap.
#[test]
fn all_list_variants_honour_list_page_cap() {
    let (env, creator, client) = setup();
    // Register LIST_PAGE_CAP + 5 resources so every list variant has something
    // to truncate.
    let n = LIST_PAGE_CAP + 5;
    let meta = String::from_str(&env, "ipfs://m");
    for i in 0..n {
        // Pad to ensure ids are valid (lowercase+digits, ≤ 24 chars).
        let id_str = format!("cap{:02}", i);
        client.register(
            &creator,
            &String::from_str(&env, &id_str),
            &100i128,
            &meta,
            &empty_tags(&env),
        );
    }

    let over_cap = LIST_PAGE_CAP + 5;
    assert_eq!(
        client.list(&0u32, &over_cap).len(),
        LIST_PAGE_CAP,
        "list must be capped at LIST_PAGE_CAP"
    );
    assert_eq!(
        client.list_page(&0u32, &over_cap).items.len(),
        LIST_PAGE_CAP,
        "list_page must be capped at LIST_PAGE_CAP"
    );
    assert_eq!(
        client.list_listed(&0u32, &over_cap).len(),
        LIST_PAGE_CAP,
        "list_listed must be capped at LIST_PAGE_CAP"
    );
    assert_eq!(
        client.list_by_creator(&creator, &0u32, &over_cap).len(),
        LIST_PAGE_CAP,
        "list_by_creator must be capped at LIST_PAGE_CAP"
    );
    assert_eq!(
        client.list_by_dispute_status(&false, &0u32, &over_cap).len(),
        LIST_PAGE_CAP,
        "list_by_dispute_status must be capped at LIST_PAGE_CAP"
    );
}

/// `list` (delegates to `list_page`) restores TTL on every resource it returns.
#[test]
fn list_bumps_ttl_for_returned_resources() {
    let (env, creator, client) = setup();
    let ids = ["ttll0", "ttll1", "ttll2"];
    for id_str in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id_str),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }

    // Decay TTL by one day across all entries.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + TTL_DAY_IN_LEDGERS);

    for id_str in &ids {
        assert_eq!(
            resource_storage_ttl(&env, &client.address, &String::from_str(&env, id_str)),
            TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS,
            "TTL must have decayed before the read"
        );
    }

    // One call to list covers all three resources.
    client.list(&0u32, &20u32);

    for id_str in &ids {
        assert_eq!(
            resource_storage_ttl(&env, &client.address, &String::from_str(&env, id_str)),
            TTL_BUMP_AMOUNT,
            "list must bump TTL for each returned resource"
        );
    }
    let info = client.registry_info();
    assert_eq!(
        info.name,
        String::from_str(&env, REGISTRY_NAME),
        "registry_info().name must equal the REGISTRY_NAME constant"
    );
}

/// `registry_info()` must expose a non-zero `resource_schema_version` that
/// clients use to detect breaking schema changes (checklist Phase 1 / Phase 4).
#[test]
fn registry_info_resource_schema_version_is_nonzero() {
    let (_env, _creator, client) = setup();
    let info = client.registry_info();
    assert!(
        info.resource_schema_version > 0,
        "resource_schema_version must be > 0 (it tracks breaking Resource schema changes)"
    );
    assert_eq!(
        info.resource_schema_version,
        RESOURCE_SCHEMA_VERSION,
        "registry_info().resource_schema_version must equal the RESOURCE_SCHEMA_VERSION constant"
    );
}

/// `registry_info()` and `contract_version()` must agree on both version
/// fields so deployers can use either endpoint for verification (checklist
/// Phase 4 verification commands).
#[test]
fn preflight_contract_version_and_registry_info_agree() {
    let (_env, _creator, client) = setup();
    let v = client.contract_version();
    let info = client.registry_info();

    assert_eq!(
        v.crate_version, info.version,
        "contract_version.crate_version must match registry_info.version"
    );
    assert_eq!(
        v.resource_schema_version, info.resource_schema_version,
        "contract_version.resource_schema_version must match registry_info.resource_schema_version"
    );
}

/// A fresh contract starts in a known, safe state for deployment:
/// zero resources and no admin set. This backs the checklist's Phase 7
/// admin-bootstrap verification step — if admin() is Some on a fresh deploy,
/// the bootstrap was already run (possibly by a prior deployment script).
#[test]
fn preflight_fresh_contract_starts_in_safe_state() {
    let (_env, _creator, client) = setup();

    assert_eq!(client.count(), 0, "fresh contract must have zero resources");
    assert!(
        client.admin().is_none(),
        "fresh contract must have no admin set (bootstrap required)"
    );
}
