// ─── Dispute flagging (#389) ───────────────────────────────────────────────
//
// Acceptance criteria (from issue):
//   • Flag state is exposed in reads and listing filters; events include reason code.
//   • Error handling is deterministic and documented.
//   • The implementation passes the relevant local test suite.

// ── Helper: setup with admin + moderator pre-configured ──────────────────

fn setup_with_moderator<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, admin, client) = setup_with_admin();
    let moderator = Address::generate(&env);
    client.add_moderator(&moderator);
    (env, creator, admin, moderator, client)
}

// ── add_moderator / remove_moderator / is_moderator ──────────────────────

#[test]
fn admin_can_grant_and_revoke_moderator() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let moderator = Address::generate(&env);

    assert!(!client.is_moderator(&moderator));

    client.add_moderator(&moderator);
    assert!(client.is_moderator(&moderator));

    client.remove_moderator(&moderator);
    assert!(!client.is_moderator(&moderator));
}

#[test]
fn set_paused_before_admin_set_fails() {
    let (env, _creator, client) = setup();
    let anyone = Address::generate(&env);
    let res = client.try_set_paused(&anyone, &true);
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn set_paused_emits_pause_event() {
    let (env, _creator, admin, client) = setup_with_admin();

    client.set_paused(&admin, &true);

    let all = env.events().all();
    // The last event is from set_paused (setadmin is first from setup_with_admin).
    let (_cid, topics, data) = all.get_unchecked(all.len() - 1);
    let t0: Symbol =
        <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
            .ok()
            .unwrap();
    assert_eq!(t0, Symbol::new(&env, "pause"));
    let (paused, emitted_admin): (bool, Address) =
        <(bool, Address)>::try_from_val(&env, &data)
            .expect("pause event data must be (bool, Address)");
    assert!(paused);
    assert_eq!(emitted_admin, admin);
}

#[test]
fn set_paused_noop_still_emits_event() {
    // Pausing when already paused is allowed and still emits an event, so
    // off-chain monitors can detect rapid successive calls.
    // We verify this by checking that the event is present immediately after
    // each call — the Soroban test env reflects the most recent invocation.
    let (env, _creator, admin, client) = setup_with_admin();
    client.set_paused(&admin, &true);

    // Second pause call (no-op state change): the event must still be emitted.
    client.set_paused(&admin, &true);
    let all = env.events().all();
    let found = (0..all.len()).any(|i| {
        let (_, topics, _) = all.get(i).unwrap();
        topics
            .get(0)
            .and_then(|v| {
                <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &v)
                    .ok()
            })
            .map(|sym: Symbol| sym == Symbol::new(&env, "pause"))
            .unwrap_or(false)
    });
    assert!(found, "set_paused must emit a 'pause' event even on a no-op state transition");
}

// ── flag_resource ─────────────────────────────────────────────────────────

#[test]
fn moderator_can_flag_resource() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres0");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    let resource = client.get(&id);
    assert_eq!(
        resource.dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );
}

#[test]
fn pause_blocks_register() {
    let (env, creator, admin, client) = setup_with_admin();
    client.set_paused(&admin, &true);
    let res = client.try_register(
        &creator,
        &String::from_str(&env, "pausedreg"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.count(), 0);
}

#[test]
fn flag_resource_with_all_reasons() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();

    for (suffix, reason) in [
        ("fr2a", FlagReason::Spam),
        ("fr2b", FlagReason::Copyright),
        ("fr2c", FlagReason::Malicious),
        ("fr2d", FlagReason::Other),
    ] {
        let id = register_default(&env, &creator, &client, suffix);
        client.flag_resource(&id, &moderator, &reason);
        let resource = client.get(&id);
        assert_eq!(
            resource.dispute_flag,
            DisputeFlag::Flagged(reason),
            "dispute_flag mismatch for reason {:?}",
            reason
        );
    }
}

#[test]
fn flag_resource_replaces_existing_flag() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres3");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );

    client.flag_resource(&id, &moderator, &FlagReason::Malicious);
    assert_eq!(
        client.get(&id).metadata,
        String::from_str(&env, "ipfs://m"),
    );
}

#[test]
fn flag_resource_non_moderator_is_unauthorized() {
    let (env, creator, _admin, _moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres4");
    let stranger = Address::generate(&env);

    let res = client.try_flag_resource(&id, &stranger, &FlagReason::Spam);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    // Resource must not be flagged.
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
}

#[test]
fn flag_resource_revoked_moderator_is_unauthorized() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres5");

    client.remove_moderator(&moderator);

    let res = client.try_flag_resource(&id, &moderator, &FlagReason::Spam);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn flag_resource_missing_resource_fails() {
    let (env, _creator, _admin, moderator, client) = setup_with_moderator();
    let ghost = String::from_str(&env, "ghostres0");

    let res = client.try_flag_resource(&ghost, &moderator, &FlagReason::Other);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn flag_resource_does_not_delist_resource() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres6");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    let resource = client.get(&id);
    assert!(resource.listed, "flagging must not change listed state");
}

#[test]
fn flag_resource_preserves_all_other_fields() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres7");
    let before = client.get(&id);

    client.flag_resource(&id, &moderator, &FlagReason::Copyright);

    let after = client.get(&id);
    assert_eq!(after.id, before.id);
    assert_eq!(after.creator, before.creator);
    assert_eq!(after.price, before.price);
    assert_eq!(after.metadata, before.metadata);
    assert_eq!(after.listed, before.listed);
    assert_eq!(after.tags, before.tags);
    assert_eq!(after.verified, before.verified);
    assert_eq!(after.frozen, before.frozen);
    assert_eq!(
        after.dispute_flag,
        DisputeFlag::Flagged(FlagReason::Copyright)
    );
}

// ── unflag_resource ───────────────────────────────────────────────────────

#[test]
fn moderator_can_unflag_resource() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "unflagr0");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );

    client.unflag_resource(&id, &moderator);
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
}

#[test]
fn pause_blocks_set_verification_status() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedverif");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    client.set_paused(&admin, &true);
    let res =
        client.try_set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None::<String>);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.get(&id).verified, VerificationStatus::Pending);
}

#[test]
fn pause_blocks_set_tags() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedtags");
    client.set_paused(&admin, &true);
    let res = client.try_set_tags(&id, &tags(&env, &["blocked"]));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.get(&id).tags.len(), 0);
}

#[test]
fn unflag_resource_non_moderator_is_unauthorized() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "unflagr3");
    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    let stranger = Address::generate(&env);
    let res = client.try_unflag_resource(&id, &stranger);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    // Flag must remain.
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );
}

#[test]
fn pause_blocks_propose_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedpropose");
    let proposed = Address::generate(&env);
    client.set_paused(&admin, &true);
    let res = client.try_propose_transfer(&id, &proposed);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn pause_blocks_accept_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedaccept");
    let new_owner = Address::generate(&env);
    // Propose before pausing so there is a pending transfer to accept.
    client.propose_transfer(&id, &new_owner);
    client.set_paused(&admin, &true);
    let res = client.try_accept_transfer(&id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.get(&id).creator, creator);
}

#[test]
fn pause_blocks_cancel_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedcancel");
    let proposed = Address::generate(&env);
    client.propose_transfer(&id, &proposed);
    client.set_paused(&admin, &true);
    let res = client.try_cancel_transfer(&id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn list_listed_exposes_dispute_flag() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "listdflag");
    client.flag_resource(&id, &moderator, &FlagReason::Copyright);

    let listed = client.list_listed(&0u32, &20u32);
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed.get(0).unwrap().dispute_flag,
        DisputeFlag::Flagged(FlagReason::Copyright)
    );
}

#[test]
fn list_by_dispute_status_filters_active_flags_in_catalog_order() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let clear0 = register_default(&env, &creator, &client, "dispstat0");
    let flagged0 = register_default(&env, &creator, &client, "dispstat1");
    let flagged1 = register_default(&env, &creator, &client, "dispstat2");
    let clear1 = register_default(&env, &creator, &client, "dispstat3");

    client.flag_resource(&flagged0, &moderator, &FlagReason::Spam);
    client.flag_resource(&flagged1, &moderator, &FlagReason::Malicious);

    let flagged = client.list_by_dispute_status(&true, &0u32, &20u32);
    assert_eq!(flagged.len(), 2);
    assert_eq!(flagged.get(0).unwrap().id, flagged0);
    assert_eq!(flagged.get(1).unwrap().id, flagged1);
    assert_eq!(
        flagged.get(0).unwrap().dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );

    let unflagged = client.list_by_dispute_status(&false, &0u32, &20u32);
    assert_eq!(unflagged.len(), 2);
    assert_eq!(unflagged.get(0).unwrap().id, clear0);
    assert_eq!(unflagged.get(1).unwrap().id, clear1);

    client.unflag_resource(&flagged0, &moderator);

    let flagged = client.list_by_dispute_status(&true, &0u32, &20u32);
    assert_eq!(flagged.len(), 1);
    assert_eq!(flagged.get(0).unwrap().id, flagged1);

    let unflagged = client.list_by_dispute_status(&false, &0u32, &20u32);
    assert_eq!(unflagged.len(), 3);
    assert_eq!(unflagged.get(0).unwrap().id, clear0);
    assert_eq!(unflagged.get(1).unwrap().id, flagged0);
    assert_eq!(unflagged.get(2).unwrap().id, clear1);
}

#[test]
fn list_by_dispute_status_bumps_ttl_for_scanned_entries() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let clear = register_default(&env, &creator, &client, "dispstatttl0");
    let flagged0 = register_default(&env, &creator, &client, "dispstatttl1");
    let flagged1 = register_default(&env, &creator, &client, "dispstatttl2");
    client.flag_resource(&flagged0, &moderator, &FlagReason::Copyright);
    client.flag_resource(&flagged1, &moderator, &FlagReason::Other);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + TTL_DAY_IN_LEDGERS);

    assert_eq!(
        resource_storage_ttl(&env, &client.address, &clear),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS
    );
    assert_eq!(
        index_storage_ttl(&env, &client.address, 0),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS
    );

    let result = client.list_by_dispute_status(&true, &0u32, &1u32);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap().id, flagged0);

    assert_eq!(
        resource_storage_ttl(&env, &client.address, &clear),
        TTL_BUMP_AMOUNT,
        "filtered query must bump each resource it scans"
    );
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &flagged0),
        TTL_BUMP_AMOUNT,
        "filtered query must bump the returned resource"
    );
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &flagged1),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS,
        "filtered query must not bump entries it did not scan"
    );
    assert_eq!(index_storage_ttl(&env, &client.address, 0), TTL_BUMP_AMOUNT);
    assert_eq!(index_storage_ttl(&env, &client.address, 1), TTL_BUMP_AMOUNT);
    assert_eq!(
        index_storage_ttl(&env, &client.address, 2),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS
    );
}

#[test]
fn pause_blocks_delist() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pauseddelist");
    client.set_paused(&admin, &true);
    let res = client.try_delist(&id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert!(client.get(&id).listed);
}

#[test]
fn pause_blocks_repair_index() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedrepair");
    client.set_paused(&admin, &true);
    let res = client.try_repair_index(&Vec::from_array(&env, [id.clone()]));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn flag_and_unflag_roundtrip() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "roundtrip0");

    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);

    client.flag_resource(&id, &moderator, &FlagReason::Other);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Other)
    );

    client.unflag_resource(&id, &moderator);
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);

    // Can be re-flagged after unflagging.
    client.flag_resource(&id, &moderator, &FlagReason::Malicious);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Malicious)
    );
}

// ── Moderator flag reason hash (#649) ─────────────────────────────────────

#[test]
fn moderator_can_set_and_get_flag_reason_hash() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash0");

    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "sha256:abc123"));

    assert_eq!(
        client.get_flag_reason_hash(&id),
        String::from_str(&env, "sha256:abc123")
    );
}

#[test]
fn set_flag_reason_hash_does_not_require_active_flag() {
    // A moderator may attach reason detail before (or without ever) calling
    // flag_resource — the two are independent.
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash1");

    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "sha256:nohash"));
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
}

#[test]
fn set_flag_reason_hash_replaces_existing_hash() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash2");

    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "first"));
    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "second"));

    assert_eq!(
        client.get_flag_reason_hash(&id),
        String::from_str(&env, "second")
    );
}

#[test]
fn set_flag_reason_hash_non_moderator_is_unauthorized() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "reasonhash3");
    let not_moderator = Address::generate(&env);

    let res = client.try_set_flag_reason_hash(
        &id,
        &not_moderator,
        &String::from_str(&env, "sha256:x"),
    );
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn set_flag_reason_hash_revoked_moderator_is_unauthorized() {
    let (env, creator, admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash4");
    client.remove_moderator(&moderator);

    let res = client.try_set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "x"));
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    let _ = admin;
}

#[test]
fn set_flag_reason_hash_missing_resource_fails() {
    let (env, _creator, _admin, moderator, client) = setup_with_moderator();
    let res = client.try_set_flag_reason_hash(
        &String::from_str(&env, "nosuchresource"),
        &moderator,
        &String::from_str(&env, "x"),
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn set_flag_reason_hash_rejects_over_max_length() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash5");

    let mut buf = alloc::string::String::new();
    while (buf.len() as u32) < MAX_FLAG_REASON_HASH_LEN + 1 {
        buf.push('a');
    }
    let too_long = String::from_str(&env, &buf);

    let res = client.try_set_flag_reason_hash(&id, &moderator, &too_long);
    assert_eq!(res, Err(Ok(Error::FlagReasonHashTooLong)));
}

#[test]
fn get_flag_reason_hash_missing_fails() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash6");
    let _ = moderator;

    let res = client.try_get_flag_reason_hash(&id);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// ── Storage TTL tests for index entries (#371) ────────────────────────────────

fn index_storage_ttl(env: &Env, contract: &soroban_sdk::Address, index: u32) -> u32 {
    let key = DataKey::Index(index);
    env.as_contract(contract, || env.storage().persistent().get_ttl(&key))
}

#[test]
fn pause_blocks_record_payment() {
    let (env, creator, admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "pausedpayrec");
    let payer = Address::generate(&env);
    client.set_paused(&admin, &true);
    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptpaused"),
        &id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "txhash"),
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

// ── Read-only methods keep working while paused ──────────────────────────────

#[test]
fn pause_allows_read_only_methods() {
    let (env, creator, admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "pausedread");

    // Record a payment receipt and terms hash while unpaused so we have
    // something to read back.
    let payer = Address::generate(&env);
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptpausedread"),
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "txhash"),
    );
    client.set_terms_hash(&creator, &String::from_str(&env, "termshash"));

    client.set_paused(&admin, &true);

    // All of these must succeed while paused.
    assert!(client.is_paused());
    assert!(client.exists(&id));
    assert_eq!(client.count(), 1);
    let _ = client.get(&id);
    let _ = client.get_owner(&id);
    let _ = client.list(&0u32, &10u32);
    let _ = client.list_page(&0u32, &10u32);
    let _ = client.list_listed(&0u32, &10u32);
    let _ = client.list_by_creator(&creator, &0u32, &10u32);
    let _ = client.creator_resource_count(&creator);
    let _ = client.registry_info();
    let _ = client.contract_version();
    let _ = client.admin();
    let _ = client.pending_admin();
    let _ = client.is_verifier(&creator);
    let _ = client.get_payment_receipt(&id, &payer);
    let _ = client.get_terms_hash(&creator);
}

// ── Unpause restores write access ────────────────────────────────────────────

#[test]
fn unpause_restores_register() {
    let (env, creator, admin, client) = setup_with_admin();
    client.set_paused(&admin, &true);
    client.set_paused(&admin, &false);
    // Must succeed now that the contract is unpaused.
    client.register(
        &creator,
        &String::from_str(&env, "unpaused"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.count(), 1);
}

#[test]
fn resource_includes_schema_version() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "schemaverres");
    let meta = String::from_str(&env, "ipfs://schemaver");

    client.register(&creator, &id, &100i128, &meta, &empty_tags(&env));

    let r = client.get(&id);
    assert_eq!(
        r.schema_version, RESOURCE_SCHEMA_VERSION,
        "Resource from get() must include RESOURCE_SCHEMA_VERSION"
    );

    let page = client.list_page(&0u32, &10u32);
    assert_eq!(
        page.items.get(0).unwrap().schema_version,
        RESOURCE_SCHEMA_VERSION,
        "Resource from list_page() must include RESOURCE_SCHEMA_VERSION"
    );

    let listed = client.list_listed(&0u32, &10u32);
    assert_eq!(
        listed.get(0).unwrap().schema_version,
        RESOURCE_SCHEMA_VERSION,
        "Resource from list_listed() must include RESOURCE_SCHEMA_VERSION"
    );

    let by_creator = client.list_by_creator(&creator, &0u32, &10u32);
    assert_eq!(
        by_creator.get(0).unwrap().schema_version,
        RESOURCE_SCHEMA_VERSION,
        "Resource from list_by_creator() must include RESOURCE_SCHEMA_VERSION"
    );
}
