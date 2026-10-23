// ─── Bounded resource search by normalized tag prefix (#974) ─────────────────
//
// `search_by_tag_prefix` resolves the resources that carry a tag sharing a
// normalized prefix. These tests pin down the normalization rules, the
// documented behaviour for empty prefixes and out-of-range limits, the
// deterministic ordering, and the bound on the returned page.

/// Collect every id in a result set, in order.
fn result_ids(items: &Vec<Resource>) -> alloc::vec::Vec<String> {
    let mut out = alloc::vec::Vec::new();
    for i in 0..items.len() {
        out.push(items.get(i).unwrap().id);
    }
    out
}

#[test]
fn tag_prefix_search_matches_every_tag_with_the_prefix() {
    let (env, creator, client) = setup();
    let exact = register_tagged(&env, &creator, &client, "tp1", &["data"]);
    let extended = register_tagged(&env, &creator, &client, "tp2", &["dataset"]);
    let other = register_tagged(&env, &creator, &client, "tp3", &["research"]);

    let hits = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &20u32);
    let ids = result_ids(&hits.items);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&exact));
    assert!(ids.contains(&extended));
    assert!(!ids.contains(&other));
}

#[test]
fn tag_prefix_search_normalizes_the_prefix_like_a_tag() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tpnorm", &["dataset"]);

    // Uppercase and surrounding whitespace normalize to the same prefix.
    let hits = client.search_by_tag_prefix(&String::from_str(&env, "  DATA  "), &0u32, &20u32);
    assert_eq!(result_ids(&hits.items), alloc::vec![id.clone()]);
}

#[test]
fn tag_prefix_search_only_matches_the_start_of_a_tag() {
    let (env, creator, client) = setup();
    let prefix = register_tagged(&env, &creator, &client, "tpstart1", &["dataset"]);
    let middle = register_tagged(&env, &creator, &client, "tpstart2", &["mydata"]);

    let hits = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &20u32);
    let ids = result_ids(&hits.items);
    assert_eq!(ids, alloc::vec![prefix.clone()]);
    assert!(!ids.contains(&middle));
}

#[test]
fn tag_prefix_search_with_an_empty_prefix_returns_nothing() {
    let (env, creator, client) = setup();
    register_tagged(&env, &creator, &client, "tpempty", &["dataset"]);

    // An empty prefix would match every tag, which is an unbounded read, so
    // it is rejected by returning an empty page.
    let hits = client.search_by_tag_prefix(&String::from_str(&env, ""), &0u32, &20u32);
    assert_eq!(hits.items.len(), 0);
    assert_eq!(hits.next_cursor, None);
}

#[test]
fn tag_prefix_search_with_a_whitespace_only_prefix_returns_nothing() {
    let (env, creator, client) = setup();
    register_tagged(&env, &creator, &client, "tpws", &["dataset"]);

    // Whitespace is trimmed by the tag normalization, so a blank prefix
    // normalizes to the empty prefix and is rejected the same way.
    let hits = client.search_by_tag_prefix(&String::from_str(&env, "   "), &0u32, &20u32);
    assert_eq!(hits.items.len(), 0);
    assert_eq!(hits.next_cursor, None);
}

#[test]
fn tag_prefix_search_returns_results_in_registration_order() {
    let (env, creator, client) = setup();
    let first = register_tagged(&env, &creator, &client, "tpord1", &["data"]);
    let second = register_tagged(&env, &creator, &client, "tpord2", &["data-science"]);
    let third = register_tagged(&env, &creator, &client, "tpord3", &["database"]);

    let hits = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &20u32);
    assert_eq!(
        result_ids(&hits.items),
        alloc::vec![first.clone(), second.clone(), third.clone()]
    );
}

#[test]
fn tag_prefix_search_result_size_is_capped() {
    let (env, creator, client) = setup();
    for i in 0..25u32 {
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("tpcap{i:02}"),
            &["data"],
        );
    }

    let hits = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &25u32);
    assert_eq!(hits.items.len(), LIST_PAGE_CAP);
    assert!(hits.next_cursor.is_some());
}

#[test]
fn tag_prefix_search_with_a_limit_of_zero_still_makes_progress() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tpzero", &["dataset"]);

    // The limit is clamped to at least one entry so a client that follows
    // the cursor can never be stuck on the same catalog slot.
    let hits = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &0u32);
    assert_eq!(result_ids(&hits.items), alloc::vec![id.clone()]);
    assert_eq!(hits.next_cursor, None);
}

#[test]
fn tag_prefix_search_cursor_advances_over_entries_that_do_not_match() {
    let (env, creator, client) = setup();
    for i in 0..6u32 {
        let tag = if i == 3 { "data" } else { "other" };
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("tpcur{i}"),
            &[tag],
        );
    }

    // The catalog cursor is a catalog index, not a match count: the first
    // page has to walk past the three non-matching entries to find the
    // match, and it reports where the scan stopped.
    let first = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &1u32);
    assert_eq!(result_ids(&first.items), alloc::vec![String::from_str(&env, "tpcur3")]);
    assert_eq!(first.next_cursor, Some(4));

    let second = client.search_by_tag_prefix(
        &String::from_str(&env, "data"),
        &first.next_cursor.unwrap(),
        &1u32,
    );
    assert_eq!(second.items.len(), 0);
    assert_eq!(second.next_cursor, None);
}

#[test]
fn tag_prefix_search_omits_tombstoned_resources() {
    let (env, creator, admin, client) = setup_with_admin();
    let kept = register_tagged(&env, &creator, &client, "tptomb1", &["data"]);
    let gone = register_tagged(&env, &creator, &client, "tptomb2", &["data"]);
    client.tombstone_resource(&gone, &admin);

    let hits = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &20u32);
    assert_eq!(result_ids(&hits.items), alloc::vec![kept.clone()]);
}

#[test]
fn tag_prefix_search_does_not_match_a_different_tag() {
    let (env, creator, client) = setup();
    register_tagged(&env, &creator, &client, "tpmiss", &["research"]);

    let hits = client.search_by_tag_prefix(&String::from_str(&env, "data"), &0u32, &20u32);
    assert_eq!(hits.items.len(), 0);
    assert_eq!(hits.next_cursor, None);
}
