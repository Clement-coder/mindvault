// ─── Creator-scoped listing page with filters (#972) ─────────────────────────
//
// `list_by_creator_page_filtered` extends creator pagination with explicit
// listed-state and lifecycle filters so a creator dashboard can query its own
// inventory without scanning the global catalog. These tests pin down:
//
//   * the filters compose with AND and never error on a contradictory pair,
//   * the cursor resumes exactly where the previous page stopped,
//   * empty, mixed-state and maximum-size pages behave as documented.

/// Register a resource owned by `creator` with the given id.
fn register_owned<'a>(
    env: &Env,
    creator: &Address,
    client: &VaultRegistryClient<'a>,
    id: &str,
) -> String {
    let id = String::from_str(env, id);
    client.register(
        creator,
        &id,
        &100i128,
        &String::from_str(env, "ipfs://m"),
        &empty_tags(env),
    );
    id
}

/// Collect every id on a page, in order.
fn page_ids(page: &IdPage) -> alloc::vec::Vec<String> {
    let mut out = alloc::vec::Vec::new();
    for i in 0..page.items.len() {
        out.push(page.items.get(i).unwrap().id);
    }
    out
}

#[test]
fn creator_page_filtered_without_filters_matches_the_unfiltered_page() {
    let (env, creator, _admin, client) = setup_with_admin();
    for i in 0..5u32 {
        register_owned(&env, &creator, &client, &alloc::format!("cpbase{i}"));
    }

    let filtered = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &None,
    );
    let unfiltered = client.list_by_creator_page(&creator, &IdCursor::Start, &20u32);
    assert_eq!(filtered.items.len(), unfiltered.items.len());
    for i in 0..unfiltered.items.len() {
        assert_eq!(
            filtered.items.get(i).unwrap().id,
            unfiltered.items.get(i).unwrap().id
        );
    }
    assert_eq!(filtered.next_cursor, IdCursor::End);
}

#[test]
fn creator_page_filtered_of_an_unknown_creator_is_an_empty_end_of_list() {
    let (_env, creator, _admin, client) = setup_with_admin();
    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &None,
    );
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, IdCursor::End);
}

#[test]
fn creator_page_filtered_filters_by_listed_projection() {
    let (env, creator, _admin, client) = setup_with_admin();
    let listed = register_owned(&env, &creator, &client, "cplisted");
    let delisted = register_owned(&env, &creator, &client, "cpdelisted");
    client.delist(&delisted);

    let only_listed = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(true),
        &None,
    );
    assert_eq!(page_ids(&only_listed), alloc::vec![listed.clone()]);

    let only_unlisted = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(false),
        &None,
    );
    assert_eq!(page_ids(&only_unlisted), alloc::vec![delisted.clone()]);
}

#[test]
fn creator_page_filtered_filters_by_lifecycle_state() {
    let (env, creator, _admin, client) = setup_with_admin();
    let listed = register_owned(&env, &creator, &client, "cplifelisted");
    let frozen = register_owned(&env, &creator, &client, "cplifefrozen");
    client.freeze_resource(&frozen);

    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &Some(ResourceState::Frozen),
    );
    assert_eq!(page_ids(&page), alloc::vec![frozen.clone()]);

    let listed_page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &Some(ResourceState::Listed),
    );
    assert_eq!(page_ids(&listed_page), alloc::vec![listed.clone()]);
}

#[test]
fn creator_page_filtered_filters_compose_with_and() {
    let (env, creator, _admin, client) = setup_with_admin();
    let listed = register_owned(&env, &creator, &client, "cpand1");
    let frozen = register_owned(&env, &creator, &client, "cpand2");
    client.freeze_resource(&frozen);

    // listed AND frozen: the frozen resource is not listed, so it drops out.
    // A contradictory pair is an empty page, never an error.
    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(true),
        &Some(ResourceState::Frozen),
    );
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, IdCursor::End);

    // unlisted AND frozen: exactly the frozen resource survives.
    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(false),
        &Some(ResourceState::Frozen),
    );
    assert_eq!(page_ids(&page), alloc::vec![frozen.clone()]);

    // listed AND listed: the still-listed resource survives.
    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(true),
        &Some(ResourceState::Listed),
    );
    assert_eq!(page_ids(&page), alloc::vec![listed.clone()]);
}

#[test]
fn creator_page_filtered_cursor_resumes_without_gaps_or_duplicates() {
    let (env, creator, _admin, client) = setup_with_admin();
    let mut ids = alloc::vec::Vec::new();
    for i in 0..7u32 {
        ids.push(register_owned(
            &env,
            &creator,
            &client,
            &alloc::format!("cpcursor{i}"),
        ));
    }

    let mut seen: alloc::vec::Vec<String> = alloc::vec::Vec::new();
    let mut cursor = IdCursor::Start;
    let mut pages = 0u32;
    loop {
        let page =
            client.list_by_creator_page_filtered(&creator, &cursor, &3u32, &None, &None);
        for id in page_ids(&page) {
            seen.push(id);
        }
        pages += 1;
        match page.next_cursor {
            IdCursor::End => break,
            next => cursor = next,
        }
        assert!(pages < 10, "pagination did not terminate");
    }
    assert_eq!(seen, ids);
    assert_eq!(pages, 3);
}

#[test]
fn creator_page_filtered_cursor_resumes_across_a_filtered_gap() {
    let (env, creator, _admin, client) = setup_with_admin();
    let mut ids = alloc::vec::Vec::new();
    for i in 0..5u32 {
        let id = register_owned(&env, &creator, &client, &alloc::format!("cpgap{i}"));
        ids.push(id);
    }
    // Delist the second entry so the filter has to skip over it.
    client.delist(&ids[1]);

    let first = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &1u32,
        &Some(true),
        &None,
    );
    assert_eq!(page_ids(&first), alloc::vec![ids[0].clone()]);
    assert!(first.next_cursor != IdCursor::End);

    let second = client.list_by_creator_page_filtered(
        &creator,
        &first.next_cursor,
        &1u32,
        &Some(true),
        &None,
    );
    assert_eq!(page_ids(&second), alloc::vec![ids[2].clone()]);
    assert!(second.next_cursor != IdCursor::End);

    // The rejected entry never shows up; the rest of the listing does.
    let third = client.list_by_creator_page_filtered(
        &creator,
        &second.next_cursor,
        &20u32,
        &Some(true),
        &None,
    );
    assert_eq!(
        page_ids(&third),
        alloc::vec![ids[3].clone(), ids[4].clone()]
    );
    assert_eq!(third.next_cursor, IdCursor::End);
}

#[test]
fn creator_page_filtered_maximum_size_page_is_capped_and_keeps_a_cursor() {
    let (env, creator, _admin, client) = setup_with_admin();
    for i in 0..25u32 {
        register_owned(&env, &creator, &client, &alloc::format!("cpmax{i:02}"));
    }

    let first = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &25u32,
        &None,
        &None,
    );
    assert_eq!(first.items.len(), LIST_PAGE_CAP);
    assert!(first.next_cursor != IdCursor::End);

    let second = client.list_by_creator_page_filtered(
        &creator,
        &first.next_cursor,
        &25u32,
        &None,
        &None,
    );
    assert_eq!(second.items.len(), 5);
    assert_eq!(second.next_cursor, IdCursor::End);
}

#[test]
fn creator_page_filtered_limit_of_zero_returns_an_empty_page() {
    let (env, creator, _admin, client) = setup_with_admin();
    register_owned(&env, &creator, &client, "cpzero");
    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &0u32,
        &None,
        &None,
    );
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, IdCursor::End);
}

#[test]
fn creator_page_filtered_mixed_states_are_separated_by_the_filters() {
    let (env, creator, admin, client) = setup_with_admin();
    let listed = register_owned(&env, &creator, &client, "cpmix1");
    let delisted = register_owned(&env, &creator, &client, "cpmix2");
    let frozen = register_owned(&env, &creator, &client, "cpmix3");
    let disputed = register_owned(&env, &creator, &client, "cpmix4");
    client.delist(&delisted);
    client.freeze_resource(&frozen);
    client.open_dispute(&disputed, &admin);

    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &None,
    );
    assert_eq!(page.items.len(), 4);

    let listed_page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(true),
        &Some(ResourceState::Listed),
    );
    assert_eq!(page_ids(&listed_page), alloc::vec![listed.clone()]);

    let delisted_page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(false),
        &Some(ResourceState::Delisted),
    );
    assert_eq!(page_ids(&delisted_page), alloc::vec![delisted.clone()]);

    let frozen_page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(false),
        &Some(ResourceState::Frozen),
    );
    assert_eq!(page_ids(&frozen_page), alloc::vec![frozen.clone()]);

    let disputed_page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &Some(false),
        &Some(ResourceState::Disputed),
    );
    assert_eq!(page_ids(&disputed_page), alloc::vec![disputed.clone()]);
}

#[test]
fn creator_page_filtered_omits_tombstoned_resources() {
    let (env, creator, admin, client) = setup_with_admin();
    let kept = register_owned(&env, &creator, &client, "cptomb1");
    let gone = register_owned(&env, &creator, &client, "cptomb2");
    client.tombstone_resource(&gone, &admin);

    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &None,
    );
    assert_eq!(page_ids(&page), alloc::vec![kept.clone()]);

    // A tombstoned resource is gone from the creator index, so the lifecycle
    // filter for it can never match.
    let tombstoned = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &Some(ResourceState::Tombstoned),
    );
    assert_eq!(tombstoned.items.len(), 0);
}

#[test]
fn creator_page_filtered_does_not_leak_another_creators_resources() {
    let (env, creator, _admin, client) = setup_with_admin();
    let other = Address::generate(&env);
    register_owned(&env, &creator, &client, "cpown1");
    let foreign = String::from_str(&env, "cpown2");
    client.register(
        &other,
        &foreign,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let page = client.list_by_creator_page_filtered(
        &creator,
        &IdCursor::Start,
        &20u32,
        &None,
        &None,
    );
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items.get(0).unwrap().id,
        String::from_str(&env, "cpown1")
    );
}
