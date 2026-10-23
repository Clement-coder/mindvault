// ── Tag removal event semantics (#362) ──────────────────────────────────────

// ── set_tags validation — reject before any state mutation ──────────────────
//
// These tests ensure every invalid tag array is rejected by `validate_tags`
// before the contract touches on-chain state. The acceptance criterion is:
// "Tool rejects invalid tag arrays before RPC calls." The equivalent MCP-layer
// rejection is covered by mcp/src/validation.test.ts and
// mcp/src/catalogFilters.test.ts.

#[test]
fn set_tags_rejects_too_many_tags() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "manytags");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // MAX_TAGS is 8; a vector of 9 tags must be rejected.
    let nine = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    assert_eq!(
        client.try_set_tags(&id, &nine),
        Err(Ok(Error::InvalidTag)),
        "set_tags must reject tag counts > MAX_TAGS (8)"
    );
    // State must be unchanged (still no tags).
    assert_eq!(client.get(&id).tags, empty_tags(&env));
}

#[test]
fn set_tags_accepts_exactly_max_tags() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "eighttagsok");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let eight = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h"]);
    client.set_tags(&id, &eight);
    assert_eq!(client.get(&id).tags.len(), 8);
}

#[test]
fn set_tags_rejects_tag_exceeding_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "longtag");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // MAX_TAG_LEN is 32; a 33-character tag must be rejected.
    let long_tag = String::from_str(&env, "123456789012345678901234567890123"); // 33 chars
    let mut bad = Vec::new(&env);
    bad.push_back(long_tag);
    assert_eq!(
        client.try_set_tags(&id, &bad),
        Err(Ok(Error::InvalidTag)),
        "set_tags must reject tags longer than MAX_TAG_LEN (32)"
    );
    assert_eq!(client.get(&id).tags, empty_tags(&env));
}

#[test]
fn set_tags_accepts_tag_at_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxlentagok");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Exactly 32 characters — must be accepted.
    let ok_tag = String::from_str(&env, "12345678901234567890123456789012"); // 32 chars
    let mut one = Vec::new(&env);
    one.push_back(ok_tag.clone());
    client.set_tags(&id, &one);
    assert_eq!(client.get(&id).tags.get(0).unwrap(), ok_tag);
}

#[test]
fn set_tags_rejects_on_nonexistent_resource() {
    let (env, _creator, client) = setup();
    let ghost = String::from_str(&env, "ghost");
    let t = tags(&env, &["x"]);
    assert_eq!(
        client.try_set_tags(&ghost, &t),
        Err(Ok(Error::NotFound)),
        "set_tags must error NotFound for an unregistered resource id"
    );
}

#[test]
fn set_tags_event_includes_prev_and_next() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "eventtest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with initial tags
    let initial_tags = tags(&env, &["data", "research"]);
    client.register(&creator, &id, &100i128, &metadata, &initial_tags);

    // Replace with new tags
    let new_tags = tags(&env, &["finance", "api"]);
    client.set_tags(&id, &new_tags);

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");

    assert_eq!(prev_tags.len(), 2);
    assert_eq!(prev_tags.get(0).unwrap(), String::from_str(&env, "data"));
    assert_eq!(
        prev_tags.get(1).unwrap(),
        String::from_str(&env, "research")
    );

    assert_eq!(next_tags.len(), 2);
    assert_eq!(next_tags.get(0).unwrap(), String::from_str(&env, "finance"));
    assert_eq!(next_tags.get(1).unwrap(), String::from_str(&env, "api"));
}

#[test]
fn set_tags_event_supports_tag_removal() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "removaltest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with multiple tags then clear all tags
    let initial_tags = tags(&env, &["tag1", "tag2", "tag3"]);
    client.register(&creator, &id, &100i128, &metadata, &initial_tags);
    client.set_tags(&id, &empty_tags(&env));

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");
    assert_eq!(prev_tags.len(), 3);
    assert_eq!(next_tags.len(), 0);
}

#[test]
fn set_tags_event_supports_tag_addition() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "additiontest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with no tags then add some
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    client.set_tags(&id, &tags(&env, &["first", "second"]));

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");
    assert_eq!(prev_tags.len(), 0);
    assert_eq!(next_tags.len(), 2);
    assert_eq!(next_tags.get(0).unwrap(), String::from_str(&env, "first"));
}

#[test]
fn set_tags_event_on_replacement() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "replacetest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with initial tags then replace completely
    let initial_tags = tags(&env, &["old1", "old2"]);
    client.register(&creator, &id, &100i128, &metadata, &initial_tags);
    client.set_tags(&id, &tags(&env, &["new1", "new2", "new3"]));

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");
    assert_eq!(prev_tags.len(), 2);
    assert_eq!(prev_tags.get(0).unwrap(), String::from_str(&env, "old1"));
    assert_eq!(prev_tags.get(1).unwrap(), String::from_str(&env, "old2"));

    assert_eq!(next_tags.len(), 3);
    assert_eq!(next_tags.get(0).unwrap(), String::from_str(&env, "new1"));
    assert_eq!(next_tags.get(1).unwrap(), String::from_str(&env, "new2"));
    assert_eq!(next_tags.get(2).unwrap(), String::from_str(&env, "new3"));
}

// ---------------------------------------------------------------------------
// list_by_tag + tag index (#359)
// ---------------------------------------------------------------------------
//
// Acceptance criteria (from issue):
//   • Resources are indexed by normalized tag; changing tags updates indexes.
//   • Tests cover add/remove/duplicate tags.
//   • Pagination works the same as other list_* functions (limit capped at 20,
//     start beyond index returns empty, TTL is bumped for returned resources).
//   • list_by_tag is case-insensitive (normalized to lowercase).
//   • repair_tag_index is admin-only, rebuilds from Resource.tags.

/// Register a resource tagged with `tag_strs` using the default metadata.
fn register_tagged<'a>(
    env: &Env,
    creator: &Address,
    client: &VaultRegistryClient<'a>,
    id: &str,
    tag_strs: &[&str],
) -> String {
    let id = String::from_str(env, id);
    client.register(
        creator,
        &id,
        &100i128,
        &String::from_str(env, "ipfs://m"),
        &tags(env, tag_strs),
    );
    id
}

// ── Basic indexing on register ──────────────────────────────────────────────

#[test]
fn list_by_tag_returns_registered_resource() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagr1", &["dataset"]);

    let result = client.list_by_tag(&String::from_str(&env, "dataset"), &0u32, &20u32);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap().id, id);
}

#[test]
fn list_by_tag_returns_empty_when_no_resources_carry_tag() {
    let (env, creator, client) = setup();
    register_tagged(&env, &creator, &client, "tagr2", &["other"]);

    let result = client.list_by_tag(&String::from_str(&env, "dataset"), &0u32, &20u32);
    assert_eq!(result.len(), 0);
}

#[test]
fn list_by_tag_returns_empty_when_no_resources_registered() {
    let (env, _creator, client) = setup();
    let result = client.list_by_tag(&String::from_str(&env, "any"), &0u32, &20u32);
    assert_eq!(result.len(), 0);
}

#[test]
fn list_by_tag_multiple_resources_same_tag() {
    let (env, creator, client) = setup();
    let a = register_tagged(&env, &creator, &client, "tagm1", &["ml"]);
    let b = register_tagged(&env, &creator, &client, "tagm2", &["ml", "research"]);
    let c = register_tagged(&env, &creator, &client, "tagm3", &["other"]);
    // c carries a different tag — should not appear

    let result = client.list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32);
    assert_eq!(result.len(), 2);
    assert_eq!(result.get(0).unwrap().id, a);
    assert_eq!(result.get(1).unwrap().id, b);
    let _ = c; // registered but not in "ml" index
}

// ── Case-insensitive normalization ──────────────────────────────────────────

#[test]
fn list_by_tag_is_case_insensitive() {
    let (env, creator, client) = setup();
    // Register with mixed-case tag; the index normalizes to lowercase.
    let id = register_tagged(&env, &creator, &client, "tagci", &["Dataset"]);

    // All variants should match.
    for variant in &["Dataset", "dataset", "DATASET", "DataSet"] {
        let result = client.list_by_tag(&String::from_str(&env, variant), &0u32, &20u32);
        assert_eq!(
            result.len(),
            1,
            "list_by_tag(\"{variant}\") should match resource with tag \"Dataset\""
        );
        assert_eq!(result.get(0).unwrap().id, id);
    }
}

#[test]
fn list_by_tag_lowercase_tag_on_register_also_indexed() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "taglow", &["research"]);

    let result = client.list_by_tag(&String::from_str(&env, "Research"), &0u32, &20u32);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap().id, id);
}

// ── Index update on set_tags ─────────────────────────────────────────────────

#[test]
fn list_by_tag_updated_when_set_tags_adds_tag() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagadd", &["alpha"]);

    // Not yet in "beta" index.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32)
            .len(),
        0
    );

    // Add "beta" tag via set_tags.
    client.set_tags(&id, &tags(&env, &["alpha", "beta"]));

    let result = client.list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap().id, id);
    // Still in "alpha" index.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "alpha"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn list_by_tag_updated_when_set_tags_removes_tag() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagrem", &["alpha", "beta"]);

    // Both indexed initially.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "alpha"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32)
            .len(),
        1
    );

    // Remove "beta" by replacing with only "alpha".
    client.set_tags(&id, &tags(&env, &["alpha"]));

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "alpha"), &0u32, &20u32)
            .len(),
        1,
        "alpha should still be indexed"
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32)
            .len(),
        0,
        "beta should be removed from index after set_tags"
    );
}

#[test]
fn list_by_tag_updated_when_all_tags_cleared() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagclr", &["data", "ml"]);

    // Both indexed.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "data"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32)
            .len(),
        1
    );

    // Clear all tags.
    client.set_tags(&id, &empty_tags(&env));

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "data"), &0u32, &20u32)
            .len(),
        0,
        "data should be removed after clearing all tags"
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32)
            .len(),
        0,
        "ml should be removed after clearing all tags"
    );
}

#[test]
fn list_by_tag_reflects_complete_tag_replacement() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagreplace", &["old1", "old2"]);

    client.set_tags(&id, &tags(&env, &["new1", "new2", "new3"]));

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "old1"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "old2"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "new1"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "new2"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "new3"), &0u32, &20u32)
            .len(),
        1
    );
}

// ── Duplicate tags are rejected on write ─────────────────────────────────────

#[test]
fn register_rejects_duplicate_normalized_tags_with_case_variants() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "tagdup");
    let metadata = String::from_str(&env, "ipfs://m");

    let res = client.try_register(&creator, &id, &100i128, &metadata, &tags(&env, &["ML", "ml"]));
    assert_eq!(res, Err(Ok(Error::InvalidTag)));
    assert!(!client.exists(&id));

    let result = client.list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32);
    assert_eq!(
        result.len(),
        0,
        "failed registration must not create a tag index entry"
    );
}

#[test]
fn set_tags_rejects_duplicate_normalized_tags_with_case_variants() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagdup2", &["finance"]);

    // "Finance" and "finance" normalize to the same tag and must be rejected.
    assert_eq!(
        client.try_set_tags(&id, &tags(&env, &["Finance", "finance"])),
        Err(Ok(Error::InvalidTag))
    );

    // Existing tags stay unchanged after failed set_tags.
    let result = client.list_by_tag(&String::from_str(&env, "finance"), &0u32, &20u32);
    assert_eq!(
        result.len(),
        1,
        "tag index must not double-insert on repeated set_tags"
    );
}

// ── Pagination ───────────────────────────────────────────────────────────────

#[test]
fn list_by_tag_pagination_first_page() {
    let (env, creator, client) = setup();
    for i in 0..5u32 {
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("pgr{i}"),
            &["page"],
        );
    }

    let page = client.list_by_tag(&String::from_str(&env, "page"), &0u32, &3u32);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "pgr0"));
    assert_eq!(page.get(2).unwrap().id, String::from_str(&env, "pgr2"));
}

#[test]
fn list_by_tag_pagination_second_page() {
    let (env, creator, client) = setup();
    for i in 0..5u32 {
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("pgs{i}"),
            &["page"],
        );
    }

    let page = client.list_by_tag(&String::from_str(&env, "page"), &3u32, &3u32);
    assert_eq!(page.len(), 2); // only pgs3, pgs4 remain
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "pgs3"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "pgs4"));
}

#[test]
fn list_by_tag_start_beyond_index_returns_empty() {
    let (env, creator, client) = setup();
    register_tagged(&env, &creator, &client, "pgx1", &["only"]);

    let result = client.list_by_tag(&String::from_str(&env, "only"), &99u32, &20u32);
    assert_eq!(result.len(), 0);
}

#[test]
fn list_by_tag_limit_capped_at_20() {
    let (env, creator, client) = setup();
    for i in 0..25u32 {
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("pg20x{i:02}"),
            &["bulk"],
        );
    }

    let result = client.list_by_tag(&String::from_str(&env, "bulk"), &0u32, &25u32);
    assert_eq!(result.len(), 20, "limit must be capped at 20");
}

// ── TTL bump on list_by_tag read ─────────────────────────────────────────────

#[test]
fn list_by_tag_bumps_ttl_for_returned_resources() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagtll", &["ttl"]);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + TTL_DAY_IN_LEDGERS);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &String::from_str(&env, "tagtll")),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS
    );

    client.list_by_tag(&String::from_str(&env, "ttl"), &0u32, &20u32);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT,
        "list_by_tag must bump TTL for each returned resource"
    );
}

// ── repair_tag_index ─────────────────────────────────────────────────────────

#[test]
fn repair_tag_index_rebuilds_drifted_index() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtia", &["science"]);
    let b = register_tagged(&env, &creator, &client, "reprtib", &["science", "data"]);

    // Verify initial state via list_by_tag.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "science"), &0u32, &20u32)
            .len(),
        2
    );

    // Repair is a no-op when the index is already correct.
    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), b.clone()]));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "science"), &0u32, &20u32)
            .len(),
        2
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "data"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn repair_tag_index_rejects_unknown_id() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtix", &["tag"]);

    let res = client.try_repair_tag_index(&Vec::from_array(
        &env,
        [a.clone(), String::from_str(&env, "ghost")],
    ));
    assert_eq!(res, Err(Ok(Error::NotFound)));
    // The index must be untouched after a failed repair.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "tag"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn repair_tag_index_before_admin_set_fails() {
    let (env, creator, client) = setup();
    let a = register_tagged(&env, &creator, &client, "reprtinadmin", &["t"]);

    let res = client.try_repair_tag_index(&Vec::from_array(&env, [a.clone()]));
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn repair_tag_index_accepts_duplicate_ids_in_input() {
    // Duplicate ids in the input are idempotent per the ADR.
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtidp", &["dup"]);

    // Passing the same id twice must not error and must not create a duplicate entry.
    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), a.clone()]));

    let result = client.list_by_tag(&String::from_str(&env, "dup"), &0u32, &20u32);
    assert_eq!(
        result.len(),
        1,
        "repair with duplicate input ids must not double-insert"
    );
}

#[test]
fn repair_tag_index_emits_retagidx_event() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtevent", &["evt"]);
    let b = register_tagged(&env, &creator, &client, "reprtevent2", &["evt"]);

    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), b.clone()]));

    let all = env.events().all();
    assert_eq!(all.len(), 1, "exactly one event should be emitted");
    let (_, topics, data) = all.get(0).unwrap();
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, symbol_short!("retagidx"));
    let count: u32 = u32::try_from_val(&env, &data).unwrap();
    assert_eq!(
        count, 2u32,
        "event must report the number of unique ids processed"
    );
}

#[test]
fn repair_tag_index_with_empty_id_list_emits_event() {
    let (env, _creator, _admin, client) = setup_with_admin();
    client.repair_tag_index(&Vec::new(&env));
    let all = env.events().all();
    assert_eq!(all.len(), 1);
    let (_, _, data) = all.get(0).unwrap();
    let count: u32 = u32::try_from_val(&env, &data).unwrap();
    assert_eq!(count, 0u32);
}

#[test]
fn list_by_tag_index_maintained_across_multiple_set_tags_calls() {
    // Simulate a real lifecycle: register → set_tags (several times) → verify index.
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "lifecycle", &["v1"]);

    // v1 → v1 + v2
    client.set_tags(&id, &tags(&env, &["v1", "v2"]));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v1"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v2"), &0u32, &20u32)
            .len(),
        1
    );

    // v1 + v2 → v3 only
    client.set_tags(&id, &tags(&env, &["v3"]));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v1"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v2"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v3"), &0u32, &20u32)
            .len(),
        1
    );

    // v3 → empty
    client.set_tags(&id, &empty_tags(&env));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v3"), &0u32, &20u32)
            .len(),
        0
    );
}

#[test]
fn list_by_tag_tag_shared_across_multiple_resources_independent_per_resource() {
    let (env, creator, client) = setup();
    let a = register_tagged(&env, &creator, &client, "shared1", &["common", "unique1"]);
    let b = register_tagged(&env, &creator, &client, "shared2", &["common", "unique2"]);

    // "common" index has both.
    let common = client.list_by_tag(&String::from_str(&env, "common"), &0u32, &20u32);
    assert_eq!(common.len(), 2);

    // Remove "common" from a only — b's "common" entry must remain.
    client.set_tags(&a, &tags(&env, &["unique1"]));

    let common_after = client.list_by_tag(&String::from_str(&env, "common"), &0u32, &20u32);
    assert_eq!(
        common_after.len(),
        1,
        "removing tag from one resource must not affect other resources in the same index"
    );
    assert_eq!(common_after.get(0).unwrap().id, b);

    // "unique1" still points to a; "unique2" still points to b.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "unique1"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "unique2"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn set_terms_hash_works_and_extends_ttl() {
    let (env, creator, client) = setup();
    let terms = String::from_str(&env, "hash123");
    client.set_terms_hash(&creator, &terms);
    assert_eq!(client.get_terms_hash(&creator), terms);

    let key = DataKey::CreatorTerms(creator.clone());
    let ttl = env.as_contract(&client.address, || env.storage().persistent().get_ttl(&key));
    assert_eq!(ttl, TTL_BUMP_AMOUNT);
}

#[test]
fn get_terms_hash_missing_fails() {
    let (_env, creator, client) = setup();
    assert_eq!(
        client.try_get_terms_hash(&creator),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn set_terms_hash_rejects_over_max_length() {
    let (env, creator, client) = setup();
    let terms = metadata_of_len(&env, MAX_TERMS_HASH_LEN + 1);
    assert_eq!(
        client.try_set_terms_hash(&creator, &terms),
        Err(Ok(Error::TermsHashTooLong))
    );
    assert_eq!(
        client.try_get_terms_hash(&creator),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn set_terms_hash_accepts_max_length() {
    let (env, creator, client) = setup();
    let terms = String::from_str(&env, &"a".repeat(MAX_TERMS_HASH_LEN as usize));

    client.set_terms_hash(&creator, &terms);
    assert_eq!(client.get_terms_hash(&creator), terms);
}

#[test]
fn terms_hash_validation_counts_utf8_bytes_and_allows_empty() {
    let (env, creator, client) = setup();
    let empty = String::from_str(&env, "");
    client.set_terms_hash(&creator, &empty);
    assert_eq!(client.get_terms_hash(&creator), empty);

    let at_byte_limit = String::from_str(&env, &"é".repeat((MAX_TERMS_HASH_LEN / 2) as usize));
    assert_eq!(at_byte_limit.len(), MAX_TERMS_HASH_LEN);
    client.set_terms_hash(&creator, &at_byte_limit);
    assert_eq!(client.get_terms_hash(&creator), at_byte_limit);

    let over_byte_limit = String::from_str(&env, &"é".repeat((MAX_TERMS_HASH_LEN / 2 + 1) as usize));
    assert_eq!(over_byte_limit.len(), MAX_TERMS_HASH_LEN + 2);
    assert_eq!(
        client.try_set_terms_hash(&creator, &over_byte_limit),
        Err(Ok(Error::TermsHashTooLong))
    );
}

// Admin bootstrap/uninitialized-state behavior is covered by
// `admin_transfer_nominate_then_accept` (bootstrap via the first
// `nominate_new_admin` call) — see the two-step admin model above.
// `admin()` returns `Option<Address>` (`None` before any admin is set), not
// a `Result`, so there is no separate "uninitialized" error case to test.
