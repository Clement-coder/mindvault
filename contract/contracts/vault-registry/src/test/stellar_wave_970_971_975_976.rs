// Tests for Stellar Wave issues #970, #971, #975, #976
//
// #970 — resource listing revision counter for metadata and price changes
// #971 — revision counter overflow guard
// #975 — tag popularity saturation at the integer boundary
// #976 — read-only tag-index integrity report

// ── Issue #970: listing revision counter ────────────────────────────────────

#[test]
fn get_revision_starts_at_zero_and_bumps_on_price_change() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "rev0");

    assert_eq!(client.get_revision(&id), 0u32);

    client.set_price(&id, &250i128);
    assert_eq!(client.get_revision(&id), 1u32);

    client.set_price(&id, &300i128);
    assert_eq!(client.get_revision(&id), 2u32);
}

#[test]
fn get_revision_bumps_on_metadata_change() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "rev1");

    client.update_metadata(&id, &String::from_str(&env, "ipfs://next"));
    assert_eq!(client.get_revision(&id), 1u32);
}

#[test]
fn get_revision_increments_exactly_once_per_mutation() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "rev2");

    client.set_price(&id, &200i128);
    client.update_metadata(&id, &String::from_str(&env, "ipfs://m2"));
    client.set_price(&id, &300i128);
    assert_eq!(client.get_revision(&id), 3u32);
}

#[test]
fn get_revision_unchanged_on_rejected_and_noop_calls() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "rev3");

    // No-op price update: same price, no mutation.
    client.set_price(&id, &100i128);
    assert_eq!(client.get_revision(&id), 0u32);

    // Rejected: invalid price.
    let _ = client.try_set_price(&id, &-1i128);
    assert_eq!(client.get_revision(&id), 0u32);

    // Rejected: over-long metadata (> MAX_METADATA_POINTER_LEN).
    let mut long_buf = std::vec::Vec::from(*b"ipfs://");
    long_buf.extend(core::iter::repeat(b'x').take(MAX_METADATA_POINTER_LEN as usize));
    let long_meta = String::from_str(&env, core::str::from_utf8(&long_buf).unwrap());
    let _ = client.try_update_metadata(&id, &long_meta);
    assert_eq!(client.get_revision(&id), 0u32);

    // A successful mutation after the rejections still starts from 0.
    client.set_price(&id, &150i128);
    assert_eq!(client.get_revision(&id), 1u32);
}

#[test]
fn get_revision_exposed_in_price_and_metadata_events() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "rev4");

    client.set_price(&id, &200i128);
    let price_event = find_setprice_event(&env, &client.address).unwrap();
    assert_eq!(price_event.revision, 1u32);

    client.update_metadata(&id, &String::from_str(&env, "ipfs://m2"));
    let meta_events = collect_updmeta_events(&env, &client.address);
    assert_eq!(meta_events.get(0).unwrap().revision, 2u32);
}

#[test]
fn get_revision_on_missing_resource_fails() {
    let (env, _creator, client) = setup();
    let res = client.try_get_revision(&String::from_str(&env, "ghostrev"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn get_revision_not_bumped_by_unrelated_mutations() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "rev5");

    client.set_tags(&id, &tags(&env, &["dataset"]));
    client.set_listed(&id, &false);
    assert_eq!(client.get_revision(&id), 0u32);

    client.set_price(&id, &200i128);
    assert_eq!(client.get_revision(&id), 1u32);
}

// ── Issue #971: revision overflow guard ─────────────────────────────────────

#[test]
fn revision_overflow_blocks_price_change_without_state_change() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "revovf1");
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Revision(id.clone()), &u32::MAX);
    });

    let before = client.get(&id);
    let res = client.try_set_price(&id, &999i128);
    assert_eq!(res, Err(Ok(Error::RevisionOverflow)));

    let after = client.get(&id);
    assert_eq!(after.price, before.price);
    assert_eq!(client.get_revision(&id), u32::MAX);
}

#[test]
fn revision_overflow_blocks_metadata_change_without_state_change() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "revovf2");
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Revision(id.clone()), &u32::MAX);
    });

    let before = client.get(&id);
    let res = client.try_update_metadata(&id, &String::from_str(&env, "ipfs://new"));
    assert_eq!(res, Err(Ok(Error::RevisionOverflow)));
    assert_eq!(client.get(&id).metadata, before.metadata);
}

#[test]
fn revision_does_not_wrap_at_integer_boundary() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "revovf3");
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Revision(id.clone()), &u32::MAX);
    });

    // Repeated attempts all fail safely; the counter never wraps to 0.
    for _ in 0..3 {
        let _ = client.try_set_price(&id, &123i128);
        assert_eq!(client.get_revision(&id), u32::MAX);
    }
}

// ── Issue #975: tag popularity saturation ───────────────────────────────────

#[test]
fn tag_popularity_never_wraps_across_repeated_maxed_updates() {
    let (env, creator, client) = setup();
    let tag = String::from_str(&env, "satmax");
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::TagCount(tag.clone()), &u32::MAX);
    });

    client.register(
        &creator,
        &String::from_str(&env, "satres1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["satmax"]),
    );
    client.register(
        &creator,
        &String::from_str(&env, "satres2"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["satmax"]),
    );

    let top = client.top_tags(&1u32);
    assert_eq!(top.get(0).unwrap().count, u32::MAX);
}

#[test]
fn repair_tag_index_preserves_saturated_popularity_counters() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = String::from_str(&env, "satrep1");
    client.register(
        &creator,
        &a,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["kept"]),
    );

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::TagCount(String::from_str(&env, "kept")), &u32::MAX);
    });

    // Repair rewrites TagIndex only — the saturated TagCount must survive.
    client.repair_tag_index(&Vec::from_array(&env, [a.clone()]));

    env.as_contract(&client.address, || {
        let kept: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TagCount(String::from_str(&env, "kept")))
            .unwrap();
        assert_eq!(kept, u32::MAX, "repair must not reset a saturated TagCount");
    });

    // A further registration still does not wrap.
    client.register(
        &creator,
        &String::from_str(&env, "satrep2"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["kept"]),
    );
    // The post-repair registration refreshes TopTags from the saturated count.
    let top = client.top_tags(&1u32);
    assert_eq!(top.get(0).unwrap().count, u32::MAX);
}

// ── Issue #976: tag-index integrity report ──────────────────────────────────

#[test]
fn check_tag_index_reports_clean_index_as_empty() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "intclean");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["alpha", "beta"]),
    );

    let report = client.check_tag_index(&Vec::from_array(&env, [id.clone()]));
    assert_eq!(report.missing.len(), 0);
    assert_eq!(report.stale.len(), 0);
}

#[test]
fn check_tag_index_reports_missing_memberships() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "intmiss");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["alpha"]),
    );

    // Corrupt the index: drop the membership without touching Resource.tags.
    env.as_contract(&client.address, || {
        let key = DataKey::TagIndex(String::from_str(&env, "alpha"));
        env.storage().persistent().remove(&key);
    });

    let report = client.check_tag_index(&Vec::from_array(&env, [id.clone()]));
    assert_eq!(report.missing.len(), 1);
    assert_eq!(report.missing.get(0).unwrap().id, id);
    assert_eq!(report.missing.get(0).unwrap().tag, String::from_str(&env, "alpha"));
    assert_eq!(report.stale.len(), 0);
}

#[test]
fn check_tag_index_reports_stale_memberships() {
    let (env, creator, client) = setup();
    let a = String::from_str(&env, "intstale1");
    let b = String::from_str(&env, "intstale2");
    client.register(
        &creator,
        &a,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["shared"]),
    );
    client.register(
        &creator,
        &b,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["shared", "extra"]),
    );

    // Corrupt: list `a` under a tag it does not carry (`extra`), which is in
    // the audited universe because `b` carries it.
    env.as_contract(&client.address, || {
        let key = DataKey::TagIndex(String::from_str(&env, "extra"));
        let mut list: Vec<String> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        list.push_back(a.clone());
        env.storage().persistent().set(&key, &list);
    });

    let report = client.check_tag_index(&Vec::from_array(&env, [a.clone(), b.clone()]));
    assert_eq!(report.missing.len(), 0);
    assert_eq!(report.stale.len(), 1);
    assert_eq!(report.stale.get(0).unwrap().id, a);
    assert_eq!(report.stale.get(0).unwrap().tag, String::from_str(&env, "extra"));
}

#[test]
fn check_tag_index_is_read_only() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "intro");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["alpha"]),
    );

    let before = client.get(&id);
    let _ = client.check_tag_index(&Vec::from_array(&env, [id.clone()]));
    let after = client.get(&id);
    assert_eq!(before.version, after.version);
    assert_eq!(before.updated_at, after.updated_at);
}

#[test]
fn check_tag_index_rejects_oversized_id_set() {
    let (env, _creator, client) = setup();
    let mut ids = Vec::new(&env);
    for i in 0..(MAX_TAG_INDEX_CHECK + 1) {
        ids.push_back(String::from_str(&env, "x"));
        let _ = i;
    }
    // Ids need not exist for the size guard to fire first.
    let res = client.try_check_tag_index(&ids);
    assert_eq!(res, Err(Ok(Error::BatchTooLarge)));
}

#[test]
fn check_tag_index_rejects_unknown_id() {
    let (env, _creator, client) = setup();
    let res = client.try_check_tag_index(&Vec::from_array(
        &env,
        [String::from_str(&env, "nosuchres")],
    ));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}
