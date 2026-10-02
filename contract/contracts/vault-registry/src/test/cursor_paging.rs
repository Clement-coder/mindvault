// ─── Stable cursors for the list_* family (#794) ─────────────────────────────
//
// `list_by_dispute_status` and friends return a bare `Vec<Resource>`, so the
// only cursor a client could derive was `start + items.len()`, which skips
// entries whenever the filter dropped a slot and skips or repeats them when a
// flag flips between pages. The `*_page` variants return the catalog index to
// resume from (global scans) or an id-based cursor (creator / tag indexes).

fn paging_setup<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, admin, client) = setup_with_admin();
    let moderator = Address::generate(&env);
    client.add_moderator(&moderator);
    (env, creator, admin, moderator, client)
}

fn ids_of(env: &Env, items: &Vec<Resource>) -> std::vec::Vec<std::string::String> {
    let mut out = std::vec::Vec::new();
    for r in items.iter() {
        let len = r.id.len() as usize;
        let mut buf = std::vec![0u8; len];
        r.id.copy_into_slice(&mut buf);
        out.push(std::string::String::from_utf8(buf).unwrap());
    }
    let _ = env;
    out
}

#[test]
fn dispute_status_page_returns_catalog_index_cursors_not_match_counts() {
    let (env, creator, _admin, moderator, client) = paging_setup();
    for i in 0..6u32 {
        let id = register_default(&env, &creator, &client, &format!("dcur{i}"));
        if i % 2 == 0 {
            client.flag_resource(&id, &moderator, &FlagReason::Spam);
        }
    }

    // Flagged: slots 0, 2, 4. Page size 2 → two matches from slots 0-2, cursor 3.
    let page = client.list_by_dispute_status_page(&true, &0u32, &2u32);
    assert_eq!(ids_of(&env, &page.items), ["dcur0", "dcur2"]);
    assert_eq!(page.next_cursor, Some(3));
    let page = client.list_by_dispute_status_page(&true, &3u32, &2u32);
    assert_eq!(ids_of(&env, &page.items), ["dcur4"]);
    assert_eq!(page.next_cursor, None);

    // The count-based cursor a client would derive from the unpaged variant
    // (start + items.len() = 2) would have repeated slot 2.
    let unpaged = client.list_by_dispute_status(&true, &2u32, &2u32);
    assert_eq!(ids_of(&env, &unpaged), ["dcur2", "dcur4"]);
}

#[test]
fn dispute_flag_flip_between_pages_neither_skips_nor_repeats() {
    let (env, creator, _admin, moderator, client) = paging_setup();
    for i in 0..5u32 {
        let id = register_default(&env, &creator, &client, &format!("flip{i}"));
        client.flag_resource(&id, &moderator, &FlagReason::Spam);
    }

    let first = client.list_by_dispute_status_page(&true, &0u32, &2u32);
    assert_eq!(ids_of(&env, &first.items), ["flip0", "flip1"]);
    let cursor = first.next_cursor.unwrap();
    assert_eq!(cursor, 2);

    // Flags change while the client holds the cursor: an already-returned
    // resource is unflagged and a not-yet-visited one is unflagged too.
    client.unflag_resource(&String::from_str(&env, "flip0"), &moderator);
    client.unflag_resource(&String::from_str(&env, "flip3"), &moderator);

    let mut seen = ids_of(&env, &first.items);
    let mut next = Some(cursor);
    while let Some(c) = next {
        let page = client.list_by_dispute_status_page(&true, &c, &2u32);
        seen.extend(ids_of(&env, &page.items));
        next = page.next_cursor;
    }
    // flip0 appears once (returned before it was unflagged), flip3 never
    // (unflagged before its slot was visited), nothing repeats.
    assert_eq!(seen, ["flip0", "flip1", "flip2", "flip4"]);

    // The unflagged view is consistent with the same walk.
    let unflagged = client.list_by_dispute_status_page(&false, &0u32, &20u32);
    assert_eq!(ids_of(&env, &unflagged.items), ["flip0", "flip3"]);
    assert_eq!(unflagged.next_cursor, None);
}

#[test]
fn listed_page_cursor_survives_delisting_between_pages() {
    let (env, creator, _admin, _moderator, client) = paging_setup();
    for i in 0..5u32 {
        register_default(&env, &creator, &client, &format!("lst{i}"));
    }
    let first = client.list_listed_page(&0u32, &2u32);
    assert_eq!(ids_of(&env, &first.items), ["lst0", "lst1"]);
    assert_eq!(first.next_cursor, Some(2));

    client.delist(&String::from_str(&env, "lst1"));
    client.delist(&String::from_str(&env, "lst2"));

    let second = client.list_listed_page(&2u32, &2u32);
    assert_eq!(ids_of(&env, &second.items), ["lst3", "lst4"]);
    assert_eq!(second.next_cursor, None);

    // Empty catalog / cursor past the end: empty page, end-of-list.
    let past = client.list_listed_page(&99u32, &2u32);
    assert_eq!(past.items.len(), 0);
    assert_eq!(past.next_cursor, None);
}

#[test]
fn creator_page_walks_the_creator_index_with_id_cursors() {
    let (env, creator, _admin, _moderator, client) = paging_setup();
    for i in 0..5u32 {
        register_default(&env, &creator, &client, &format!("crp{i}"));
    }
    let first = client.list_by_creator_page(&creator, &IdCursor::Start, &2u32);
    assert_eq!(ids_of(&env, &first.items), ["crp0", "crp1"]);
    match &first.next_cursor {
        IdCursor::After(position, last_id, _created_at) => {
            assert_eq!(*position, 1);
            assert_eq!(*last_id, String::from_str(&env, "crp1"));
        }
        other => panic!("expected an After cursor, got {other:?}"),
    }

    let second = client.list_by_creator_page(&creator, &first.next_cursor, &2u32);
    assert_eq!(ids_of(&env, &second.items), ["crp2", "crp3"]);
    let third = client.list_by_creator_page(&creator, &second.next_cursor, &2u32);
    assert_eq!(ids_of(&env, &third.items), ["crp4"]);
    assert_eq!(third.next_cursor, IdCursor::End);

    // End passed back in yields an empty page; a zero limit too.
    let past = client.list_by_creator_page(&creator, &IdCursor::End, &2u32);
    assert_eq!(past.items.len(), 0);
    assert_eq!(past.next_cursor, IdCursor::End);
    let none = client.list_by_creator_page(&creator, &IdCursor::Start, &0u32);
    assert_eq!(none.items.len(), 0);
}

#[test]
fn creator_page_cursor_survives_removals_before_and_at_the_cursor() {
    let (env, creator, admin, _moderator, client) = paging_setup();
    for i in 0..6u32 {
        register_default(&env, &creator, &client, &format!("crm{i}"));
    }
    let first = client.list_by_creator_page(&creator, &IdCursor::Start, &2u32);
    assert_eq!(ids_of(&env, &first.items), ["crm0", "crm1"]);

    // An entry before the cursor disappears: the vector shifts left by one.
    client.tombstone_resource(&String::from_str(&env, "crm0"), &admin);
    let second = client.list_by_creator_page(&creator, &first.next_cursor, &2u32);
    assert_eq!(ids_of(&env, &second.items), ["crm2", "crm3"]);

    // The cursor's own entry disappears (transferred away): resume at the
    // first entry registered after it.
    let other = Address::generate(&env);
    client.transfer_ownership(&String::from_str(&env, "crm3"), &other);
    let third = client.list_by_creator_page(&creator, &second.next_cursor, &2u32);
    assert_eq!(ids_of(&env, &third.items), ["crm4", "crm5"]);
    assert_eq!(third.next_cursor, IdCursor::End);

    // A position-based walk would have skipped crm2 or crm4; the id walk
    // saw every surviving entry exactly once.
}

#[test]
fn tag_page_uses_id_cursors_and_skips_tombstones() {
    let (env, creator, admin, _moderator, client) = paging_setup();
    let tag = String::from_str(&env, "Dataset");
    for i in 0..4u32 {
        let id = String::from_str(&env, &format!("tgp{i}"));
        let mut tags = Vec::new(&env);
        tags.push_back(tag.clone());
        client.register(&creator, &id, &100i128, &String::from_str(&env, "ipfs://m"), &tags);
    }
    let first = client.list_by_tag_page(&String::from_str(&env, "dataset"), &IdCursor::Start, &3u32);
    assert_eq!(ids_of(&env, &first.items), ["tgp0", "tgp1", "tgp2"]);

    client.tombstone_resource(&String::from_str(&env, "tgp1"), &admin);
    let second = client.list_by_tag_page(&tag, &first.next_cursor, &3u32);
    assert_eq!(ids_of(&env, &second.items), ["tgp3"]);
    assert_eq!(second.next_cursor, IdCursor::End);

    let empty = client.list_by_tag_page(&String::from_str(&env, "nosuchtag"), &IdCursor::Start, &3u32);
    assert_eq!(empty.items.len(), 0);
    assert_eq!(empty.next_cursor, IdCursor::End);
}
