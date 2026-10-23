// ─── Bounded registry export pages (#1073) ──────────────────────────────────
//
// `export_page(cursor, limit)` is the stable view migration and audit tooling
// reads the whole registry through. These tests pin that it is deterministic
// (same storage, same pages), paginated and capped (never more than
// `EXPORT_PAGE_CAP` index slots per call, always making progress), complete
// (every lifecycle state, including entries on an older schema), and that it
// carries only the `ResourceExport` allowlist, never private values.

fn export_register(env: &Env, creator: &Address, client: &VaultRegistryClient, id: &str) -> String {
    let id = String::from_str(env, id);
    client.register(
        creator,
        &id,
        &100i128,
        &String::from_str(env, "ipfs://private-content-pointer"),
        &tags(env, &["dataset"]),
    );
    id
}

/// Walk every page from cursor 0 with the given `limit`, returning the pages.
fn export_all(client: &VaultRegistryClient, limit: u32) -> std::vec::Vec<ExportPage> {
    let mut pages = std::vec::Vec::new();
    let mut cursor = 0u32;
    loop {
        let page = client.export_page(&cursor, &limit);
        let next = page.next_cursor;
        pages.push(page);
        match next {
            Some(next) => {
                assert!(next > cursor, "export cursor must always advance");
                cursor = next;
            }
            None => return pages,
        }
        assert!(pages.len() < 1_000, "export did not terminate");
    }
}

fn exported_ids(pages: &[ExportPage]) -> std::vec::Vec<std::string::String> {
    let mut ids = std::vec::Vec::new();
    for page in pages {
        for item in page.items.iter() {
            ids.push(item.id.to_string());
        }
    }
    ids
}

#[test]
fn export_of_an_empty_registry_is_one_empty_final_page() {
    let (_env, _creator, client) = setup();
    let page = client.export_page(&0, &EXPORT_PAGE_CAP);
    assert_eq!(page.total, 0);
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.export_version, EXPORT_VIEW_VERSION);
    assert_eq!(page.resource_schema_version, RESOURCE_SCHEMA_VERSION);
}

#[test]
fn export_reports_state_and_version_fields_from_storage() {
    let (env, creator, client) = setup();
    let id = export_register(&env, &creator, &client, "exportone");
    client.set_price(&id, &250i128);

    let page = client.export_page(&0, &1);
    let stored = client.get(&id);
    assert_eq!(page.total, 1);
    assert_eq!(page.next_cursor, None);
    assert_eq!(
        page.items.get(0).unwrap(),
        ResourceExport {
            index: 0,
            id: id.clone(),
            creator: creator.clone(),
            state: ResourceState::Listed,
            listed: true,
            price: 250,
            verified: stored.verified,
            frozen: false,
            flagged: false,
            schema_version: stored.schema_version,
            version: stored.version,
            created_at: stored.created_at,
            updated_at: stored.updated_at,
        }
    );
}

#[test]
fn export_pages_are_capped_and_cover_every_resource_in_index_order() {
    let (env, creator, client) = setup();
    let mut expected = std::vec::Vec::new();
    for n in 0..(EXPORT_PAGE_CAP * 2 + 5) {
        let id = format!("exp{n}");
        export_register(&env, &creator, &client, &id);
        expected.push(id);
    }

    // A limit above the cap is clamped to it.
    let pages = export_all(&client, EXPORT_PAGE_CAP * 10);
    assert_eq!(pages.len(), 3);
    for page in &pages {
        assert!(page.items.len() <= EXPORT_PAGE_CAP);
        assert_eq!(page.total, EXPORT_PAGE_CAP * 2 + 5);
    }
    assert_eq!(pages[0].next_cursor, Some(EXPORT_PAGE_CAP));
    assert_eq!(pages[1].next_cursor, Some(EXPORT_PAGE_CAP * 2));
    assert_eq!(pages[2].next_cursor, None);
    assert_eq!(exported_ids(&pages), expected);

    // `index` is strictly increasing across the whole export.
    let mut last: Option<u32> = None;
    for page in &pages {
        for item in page.items.iter() {
            if let Some(prev) = last {
                assert!(item.index > prev);
            }
            last = Some(item.index);
        }
    }
}

#[test]
fn export_is_deterministic_for_the_same_storage_and_any_page_size() {
    let (env, creator, client) = setup();
    for n in 0..7 {
        export_register(&env, &creator, &client, &format!("det{n}"));
    }

    let first = export_all(&client, 3);
    let again = export_all(&client, 3);
    assert_eq!(
        first, again,
        "re-reading the same storage must give identical pages"
    );

    // Page size changes the page boundaries, never the exported sequence.
    let reference = exported_ids(&first);
    for limit in [1u32, 2, 5, 7, EXPORT_PAGE_CAP] {
        assert_eq!(exported_ids(&export_all(&client, limit)), reference);
    }
}

#[test]
fn export_with_zero_limit_still_makes_progress() {
    let (env, creator, client) = setup();
    for n in 0..3 {
        export_register(&env, &creator, &client, &format!("zero{n}"));
    }
    let page = client.export_page(&0, &0);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.next_cursor, Some(1));
    assert_eq!(exported_ids(&export_all(&client, 0)).len(), 3);
}

#[test]
fn export_past_the_end_returns_an_empty_final_page() {
    let (env, creator, client) = setup();
    export_register(&env, &creator, &client, "pastend");
    for cursor in [1u32, 5, u32::MAX] {
        let page = client.export_page(&cursor, &EXPORT_PAGE_CAP);
        assert_eq!(page.items.len(), 0);
        assert_eq!(page.next_cursor, None);
        assert_eq!(page.total, 1);
    }
}

#[test]
fn export_includes_every_lifecycle_state() {
    let (env, creator, admin, moderator, client) = setup_with_moderator();
    let listed = export_register(&env, &creator, &client, "stlisted");
    let delisted = export_register(&env, &creator, &client, "stdelisted");
    let flagged = export_register(&env, &creator, &client, "stflagged");
    let tombstoned = export_register(&env, &creator, &client, "sttomb");

    client.delist(&delisted);
    client.flag_resource(&flagged, &moderator, &FlagReason::Spam);
    client.tombstone_resource(&tombstoned, &admin);

    let pages = export_all(&client, EXPORT_PAGE_CAP);
    let mut seen = std::vec::Vec::new();
    for page in &pages {
        for item in page.items.iter() {
            // Each exported state agrees with what `get` reports.
            let stored = client.get(&item.id);
            assert_eq!(item.state, stored.state);
            assert_eq!(item.listed, stored.listed);
            assert_eq!(item.flagged, stored.dispute_flag.is_flagged());
            seen.push((item.id.to_string(), item.state, item.flagged));
        }
    }
    assert!(seen.contains(&(listed.to_string(), ResourceState::Listed, false)));
    assert!(seen.contains(&(delisted.to_string(), ResourceState::Delisted, false)));
    assert!(seen
        .iter()
        .any(|(id, _, f)| *id == flagged.to_string() && *f));
    assert!(seen.contains(&(tombstoned.to_string(), ResourceState::Tombstoned, false)));
}

#[test]
fn export_skips_missing_index_slots_without_stalling() {
    let (env, creator, client) = setup();
    for n in 0..4 {
        export_register(&env, &creator, &client, &format!("gap{n}"));
    }
    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&DataKey::Index(1));
    });

    let page = client.export_page(&0, &2);
    // Slots 0 and 1 were read; only slot 0 still resolves.
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.next_cursor, Some(2));
    assert_eq!(
        exported_ids(&export_all(&client, 2)),
        std::vec!["gap0", "gap2", "gap3"]
    );
}

#[test]
fn export_reports_entries_still_on_an_older_schema() {
    let (env, creator, client) = setup();
    let id = export_register(&env, &creator, &client, "oldschema");
    let older = RESOURCE_SCHEMA_VERSION - 1;
    env.as_contract(&client.address, || {
        let key = DataKey::Resource(id.clone());
        let mut stored: Resource = env.storage().persistent().get(&key).unwrap();
        stored.schema_version = older;
        env.storage().persistent().set(&key, &stored);
    });

    let page = client.export_page(&0, &1);
    assert_eq!(page.items.get(0).unwrap().schema_version, older);
    assert!(page.items.get(0).unwrap().schema_version < page.resource_schema_version);
}

#[test]
fn export_works_while_paused() {
    let (env, creator, admin, client) = setup_with_admin();
    export_register(&env, &creator, &client, "paused");
    client.set_paused(&admin, &true);
    let page = client.export_page(&0, &1);
    assert_eq!(page.items.len(), 1);
}

#[test]
fn export_view_carries_only_the_allowlisted_fields() {
    let (env, creator, client) = setup();
    let id = export_register(&env, &creator, &client, "allowlist");
    // Give the resource every optional private-ish value it can carry.
    client.set_royalty_recipient(&id, &Some(Address::generate(&env)));

    let page = client.export_page(&0, &1);
    let item = page.items.get(0).unwrap();
    let raw: Val = item.into_val(&env);
    let encoded: soroban_sdk::Map<Symbol, Val> =
        soroban_sdk::Map::try_from_val(&env, &raw).unwrap();
    let allowlist = [
        "created_at",
        "creator",
        "flagged",
        "frozen",
        "id",
        "index",
        "listed",
        "price",
        "schema_version",
        "state",
        "updated_at",
        "verified",
        "version",
    ];
    let mut expected: Vec<Symbol> = Vec::new(&env);
    for name in allowlist {
        expected.push_back(Symbol::new(&env, name));
    }
    assert_eq!(
        encoded.keys(),
        expected,
        "ResourceExport is an allowlist: adding a field is a deliberate change \
         that must bump EXPORT_VIEW_VERSION and be reviewed for private data"
    );
    for private in [
        "metadata",
        "content_hash",
        "tags",
        "royalty_recipient",
        "dispute_flag",
    ] {
        assert!(
            !encoded.contains_key(Symbol::new(&env, private)),
            "{private} must not be exported"
        );
    }
}
