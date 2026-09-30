// ─── Test helpers for the role / verification / freeze / repair suites ────

/// Like `setup`, but also installs `admin` as the contract admin via the
/// bootstrap path of `nominate_new_admin`.
fn setup_with_admin<'a>() -> (Env, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    client.nominate_new_admin(&admin);
    (env, creator, admin, client)
}

/// Register a resource with a valid cuid2-shaped id and a valid metadata
/// pointer, no tags. Returns the id.
fn register_default<'a>(
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

// ─── Verifier role management (#437) ───────────────────────────────────────

#[test]
fn admin_can_grant_and_revoke_verifier() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);

    assert!(!client.is_verifier(&verifier));

    client.add_verifier(&verifier);
    assert!(client.is_verifier(&verifier));

    client.remove_verifier(&verifier);
    assert!(!client.is_verifier(&verifier));
}

#[test]
fn add_verifier_before_admin_set_fails() {
    let (env, _creator, client) = setup();
    let verifier = Address::generate(&env);
    let res = client.try_add_verifier(&verifier);
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn is_verifier_false_for_unknown_address() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let stranger = Address::generate(&env);
    assert!(!client.is_verifier(&stranger));
}

// ─── On-chain verification status mirror (#436) ────────────────────────────

#[test]
fn resource_starts_pending_and_unfrozen() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "vres0");
    let resource = client.get(&id);
    assert_eq!(resource.verified, VerificationStatus::Pending);
    assert!(!resource.frozen);
    assert_eq!(resource.metadata_frozen_at, None);
    assert_eq!(resource.state, ResourceState::Listed);
    assert!(resource.listed);
}

// ─── Resource lifecycle state machine (#455) ──────────────────────────────

#[test]
fn creator_lifecycle_transitions_keep_listing_projection_in_sync() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "lifecyc1");

    client.set_listed(&id, &false);
    let delisted = client.get(&id);
    assert_eq!(delisted.state, ResourceState::Delisted);
    assert!(!delisted.listed);

    client.set_listed(&id, &true);
    let listed = client.get(&id);
    assert_eq!(listed.state, ResourceState::Listed);
    assert!(listed.listed);

    client.freeze_resource(&id);
    let frozen = client.get(&id);
    assert_eq!(frozen.state, ResourceState::Frozen);
    assert!(!frozen.listed);
}

#[test]
fn lifecycle_rejects_creator_transitions_out_of_frozen() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "lifecyc2");

    client.freeze_resource(&id);
    assert_eq!(
        client.try_set_listed(&id, &false),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
    assert_eq!(
        client.try_freeze_resource(&id),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn admin_can_dispute_resolve_and_tombstone_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "lifecyc3");

    client.open_dispute(&id, &admin);
    assert_eq!(client.get(&id).state, ResourceState::Disputed);
    assert_eq!(
        client.try_set_price(&id, &200i128),
        Err(Ok(Error::ResourceNotMutable))
    );

    client.resolve_dispute(&id, &admin, &ResourceState::Frozen);
    assert_eq!(client.get(&id).state, ResourceState::Frozen);

    client.tombstone_resource(&id, &admin);
    let tombstoned = client.get(&id);
    assert_eq!(tombstoned.state, ResourceState::Tombstoned);
    assert!(!tombstoned.listed);
    assert_eq!(
        client.try_tombstone_resource(&id, &admin),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn tombstoned_resource_is_not_discoverable_by_tag_but_stays_auditable() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = String::from_str(&env, "lifecyc5");
    let tags_before = tags(&env, &["archive", "proof"]);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://audit"),
        &tags_before,
    );

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "archive"), &0u32, &20u32)
            .len(),
        1
    );

    let before = client.get(&id);
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "archive"), &0u32, &20u32)
            .len(),
        0,
        "tombstoned resources must not be discoverable by tag"
    );

    let after = client.get(&id);
    assert_eq!(after.state, ResourceState::Tombstoned);
    assert_eq!(after.id, before.id);
    assert_eq!(after.metadata, before.metadata);
    assert_eq!(after.creator, before.creator);

    // Tombstoned resources remain in canonical storage for auditability.
    let all = client.list(&0u32, &20u32);
    assert_eq!(all.len(), 1);
    assert_eq!(all.get(0).unwrap().id, id);
}

#[test]
fn tombstone_removes_resource_from_creator_index() {
    let (env, creator, admin, client) = setup_with_admin();
    let kept = register_default(&env, &creator, &client, "tombkeep");
    let doomed = register_default(&env, &creator, &client, "tombgone");

    assert_eq!(client.list_by_creator(&creator, &0u32, &20u32).len(), 2);

    client.tombstone_resource(&doomed, &admin);

    let listed = client.list_by_creator(&creator, &0u32, &20u32);
    assert_eq!(
        listed.len(),
        1,
        "tombstoned resources must not surface in list_by_creator"
    );
    assert_eq!(listed.get(0).unwrap().id, kept);
}

#[test]
fn tombstone_decrements_creator_resource_count() {
    let (env, creator, admin, client) = setup_with_admin();
    register_default(&env, &creator, &client, "tombcnt1");
    let doomed = register_default(&env, &creator, &client, "tombcnt2");
    assert_eq!(client.creator_resource_count(&creator), 2);

    client.tombstone_resource(&doomed, &admin);

    assert_eq!(
        client.creator_resource_count(&creator),
        1,
        "creator_resource_count must not count retired resources"
    );
}

#[test]
fn tombstone_leaves_global_catalog_index_intact() {
    let (env, creator, admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "tombcat1");
    let b = register_default(&env, &creator, &client, "tombcat2");

    client.tombstone_resource(&a, &admin);

    // `Count` is monotonic and `list` stays an audit view over every id ever
    // registered; only the discovery indexes are pruned.
    assert_eq!(client.count(), 2, "count() must stay monotonic");
    let all = client.list(&0u32, &20u32);
    assert_eq!(all.len(), 2);
    assert_eq!(all.get(0).unwrap().id, a);
    assert_eq!(all.get(1).unwrap().id, b);
    assert!(client.exists(&a));
}

#[test]
fn tombstone_cleans_the_current_owner_index_after_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "tombxfer");
    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.creator_resource_count(&new_owner), 1);
    assert_eq!(client.creator_resource_count(&creator), 0);

    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.list_by_creator(&new_owner, &0u32, &20u32).len(),
        0,
        "the index cleaned must be the current owner's, not the original creator's"
    );
    assert_eq!(client.creator_resource_count(&new_owner), 0);
    assert_eq!(
        client.creator_resource_count(&creator),
        0,
        "the previous owner's count must not go negative"
    );
}

#[test]
fn tombstone_index_cleanup_leaves_other_creators_untouched() {
    let (env, creator, admin, client) = setup_with_admin();
    let other = Address::generate(&env);
    let mine = register_default(&env, &creator, &client, "tombmine");
    let theirs = register_default(&env, &other, &client, "tombtheir");

    client.tombstone_resource(&mine, &admin);

    assert_eq!(client.creator_resource_count(&other), 1);
    let listed = client.list_by_creator(&other, &0u32, &20u32);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed.get(0).unwrap().id, theirs);
}

#[test]
fn tombstoned_resource_blocks_creator_mutations_deterministically() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = String::from_str(&env, "lifecyc6");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://audit2"),
        &tags(&env, &["tag1"]),
    );
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.try_set_price(&id, &200i128),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_update_metadata(&id, &String::from_str(&env, "ipfs://new")),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_set_tags(&id, &tags(&env, &["tag2"])),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_transfer_ownership(&id, &Address::generate(&env)),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_set_listed(&id, &true),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn lifecycle_admin_methods_reject_wrong_role_and_invalid_resolution() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "lifecyc4");
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_open_dispute(&id, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_resolve_dispute(&id, &admin, &ResourceState::Listed),
        Err(Ok(Error::InvalidLifecycleTransition))
    );

    client.open_dispute(&id, &admin);
    assert_eq!(
        client.try_resolve_dispute(&id, &admin, &ResourceState::Tombstoned),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn verifier_can_verify_pending_resource() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres1");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None::<String>);
    assert_eq!(client.get(&id).verified, VerificationStatus::Verified);
}

#[test]
fn set_verification_status_emits_old_and_new_status() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres2");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None::<String>);

    let all = env.events().all();
    let (_contract, _topics, data) = all.get_unchecked(all.len() - 1);
    let decoded: (VerificationStatus, VerificationStatus, Option<String>) =
        <(VerificationStatus, VerificationStatus, Option<String>)>::try_from_val(&env, &data)
            .expect("failed to decode verification event");
    assert_eq!(decoded.0, VerificationStatus::Pending);
    assert_eq!(decoded.1, VerificationStatus::Verified);
    assert_eq!(decoded.2, None);
}

#[test]
fn non_verifier_cannot_set_verification_status() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres3");
    let stranger = Address::generate(&env);

    let res = client.try_set_verification_status(&id, &stranger, &VerificationStatus::Verified, &None::<String>);
    assert_eq!(res, Err(Ok(Error::NotVerifier)));
    assert_eq!(client.get(&id).verified, VerificationStatus::Pending);
}

#[test]
fn revoked_verifier_cannot_set_verification_status() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres4");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    client.remove_verifier(&verifier);

    let res = client.try_set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None::<String>);
    assert_eq!(res, Err(Ok(Error::NotVerifier)));
}

#[test]
fn verification_self_transition_rejected() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres5");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    // Pending -> Pending is a no-op and rejected as invalid.
    let res = client.try_set_verification_status(&id, &verifier, &VerificationStatus::Pending, &None::<String>);
    assert_eq!(res, Err(Ok(Error::InvalidVerificationTransition)));
}

#[test]
fn verification_cannot_revert_to_pending() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres6");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None::<String>);
    let res = client.try_set_verification_status(&id, &verifier, &VerificationStatus::Pending, &None::<String>);
    assert_eq!(res, Err(Ok(Error::InvalidVerificationTransition)));
}

#[test]
fn verification_round_trip_verified_rejected_verified() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres7");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None::<String>);
    client.set_verification_status(&id, &verifier, &VerificationStatus::Rejected, &None::<String>);
    assert_eq!(client.get(&id).verified, VerificationStatus::Rejected);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None::<String>);
    assert_eq!(client.get(&id).verified, VerificationStatus::Verified);
}

#[test]
fn verification_status_on_missing_resource_fails() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    let res = client.try_set_verification_status(&String::from_str(&env, "nosuchresource"), &verifier, &VerificationStatus::Verified, &None::<String>);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// ─── Metadata freeze (#438) ────────────────────────────────────────────────

#[test]
fn event_schema_matches_documented_readme_table() {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("contract/README.md must be readable from the vault-registry crate");

    let events_section = readme
        .split("### Events")
        .nth(1)
        .expect("contract/README.md must have an `### Events` section")
        .split("### Resource lifecycle")
        .next()
        .expect("`### Events` section must precede lifecycle documentation")
        .split("### Registry info")
        .next()
        .expect("`### Events` section must be immediately followed by `### Registry info`");

    for (topic, _payload) in EVENT_SCHEMA {
        let needle = std::format!("| `{topic}` ");
        assert!(
            events_section.contains(needle.as_str()),
            "EVENT_SCHEMA lists `{topic}` but contract/README.md's Events table \
             does not document it — update the table to match lib.rs::EVENT_SCHEMA"
        );
    }

    // Reverse direction: every event name documented in the table's leading
    // column must be a real, currently-emitted topic in EVENT_SCHEMA — and
    // there must be exactly one documented row per schema entry (no stale
    // duplicates left behind by a bad merge).
    let documented: std::vec::Vec<&str> = events_section
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("| `")?;
            let end = rest.find('`')?;
            Some(&rest[..end])
        })
        .collect();

    for name in &documented {
        assert!(
            EVENT_SCHEMA.iter().any(|(topic, _)| topic == name),
            "contract/README.md documents event `{name}` but it is not in \
             lib.rs::EVENT_SCHEMA — either the doc is stale or EVENT_SCHEMA is \
             missing an entry"
        );
    }

    assert_eq!(
        documented.len(),
        EVENT_SCHEMA.len(),
        "contract/README.md's Events table row count must match EVENT_SCHEMA's \
         length exactly (no duplicate or missing rows)"
    );
}

fn method_schema_names() -> std::vec::Vec<std::string::String> {
    METHOD_SCHEMA
        .iter()
        .map(|(name, _auth)| std::string::String::from(*name))
        .collect()
}

fn exported_contract_method_names() -> std::vec::Vec<std::string::String> {
    let source = include_str!("../lib.rs");
    let attr = source
        .find("#[contractimpl]")
        .expect("lib.rs must contain the contractimpl attribute");
    let impl_start = attr
        + source[attr..]
            .find("impl VaultRegistry")
            .expect("contractimpl must be on impl VaultRegistry");
    let open_brace = impl_start
        + source[impl_start..]
            .find('{')
            .expect("impl VaultRegistry must have a body");

    let mut depth = 0u32;
    let mut close_brace = open_brace;
    for (offset, ch) in source[open_brace..].char_indices() {
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                close_brace = open_brace + offset;
                break;
            }
        }
    }

    source[(open_brace + 1)..close_brace]
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("pub fn ")?;
            let name = rest.split('(').next()?;
            Some(std::string::String::from(name))
        })
        .collect()
}

fn documented_method_names() -> std::vec::Vec<std::string::String> {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("contract/README.md must be readable from the vault-registry crate");
    let methods_section = readme
        .split("### Methods")
        .nth(1)
        .expect("contract/README.md must have a `### Methods` section")
        .split("### Roles")
        .next()
        .expect("`### Methods` section must precede role documentation");

    methods_section
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("| `")?;
            let end = rest.find('`')?;
            let signature = &rest[..end];
            let name = signature.split('(').next()?;
            Some(std::string::String::from(name))
        })
        .collect()
}

fn assert_names_have_no_duplicates(names: &[std::string::String], label: &str) {
    let mut sorted = names.to_vec();
    sorted.sort();
    for window in sorted.windows(2) {
        assert_ne!(
            window[0], window[1],
            "{label} must not contain duplicate `{}` rows",
            window[0]
        );
    }
}

#[test]
fn method_schema_matches_exported_contract_methods() {
    let mut schema = method_schema_names();
    let mut exported = exported_contract_method_names();

    assert_names_have_no_duplicates(&schema, "METHOD_SCHEMA");
    assert_names_have_no_duplicates(&exported, "contractimpl exports");

    schema.sort();
    exported.sort();
    assert_eq!(
        schema, exported,
        "METHOD_SCHEMA must match every public method exported by the contractimpl"
    );
}

#[test]
fn readme_methods_table_matches_method_schema() {
    let mut schema = method_schema_names();
    let mut documented = documented_method_names();

    assert_names_have_no_duplicates(&documented, "contract/README.md Methods table");

    schema.sort();
    documented.sort();
    assert_eq!(
        documented, schema,
        "contract/README.md's Methods table must match lib.rs::METHOD_SCHEMA exactly"
    );
}

#[test]
fn readme_error_codes_table_matches_error_schema() {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("contract/README.md must be readable from the vault-registry crate");

    let errors_section = readme
        .split("### Error codes")
        .nth(1)
        .expect("contract/README.md must have an `### Error codes` section")
        .split("### Events")
        .next()
        .expect("`### Error codes` section must be followed by `### Events`");

    let documented: std::vec::Vec<(u32, &str)> = errors_section
        .lines()
        .filter_map(|line| {
            let mut cells = line.trim().split('|').map(str::trim);
            cells.next()?;
            let code = cells.next()?.trim_matches('`').parse::<u32>().ok()?;
            let name = cells.next()?.trim_matches('`');
            Some((code, name))
        })
        .collect();

    for (code, name, _desc) in ERROR_SCHEMA {
        assert!(
            documented.contains(&(*code, name)),
            "ERROR_SCHEMA lists `{code}`/`{name}` but contract/README.md's Error \
             codes table does not document it — update the table to match \
             lib.rs::ERROR_SCHEMA"
        );
    }

    for (code, name) in &documented {
        assert!(
            ERROR_SCHEMA
                .iter()
                .any(|(schema_code, schema_name, _)| schema_code == code && schema_name == name),
            "contract/README.md documents error `{code}`/`{name}` but it is not in \
             lib.rs::ERROR_SCHEMA — either the doc is stale or ERROR_SCHEMA is \
             missing an entry"
        );
    }

    assert_eq!(
        documented.len(),
        ERROR_SCHEMA.len(),
        "contract/README.md's Error codes table row count must match \
         ERROR_SCHEMA's length exactly (no duplicate or missing rows)"
    );
}

#[test]
fn freeze_metadata_sets_flag_and_emits_event() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres0");

    client.freeze_metadata(&id);
    // Checked immediately after the write, before any other invocation
    // (e.g. a read call) rolls the per-invocation event log forward.
    assert_eq!(env.events().all().len(), 1);
    assert!(client.get(&id).frozen);
}

#[test]
fn freeze_metadata_records_freeze_ledger_sequence() {
    let (env, creator, client) = setup();
    env.ledger().set_sequence_number(41);
    let id = register_default(&env, &creator, &client, "fresledger");
    assert_eq!(client.get(&id).metadata_frozen_at, None);

    env.ledger().set_sequence_number(99);
    client.freeze_metadata(&id);

    let resource = client.get(&id);
    assert!(resource.frozen);
    assert_eq!(resource.created_at, 41);
    assert_eq!(resource.metadata_frozen_at, Some(99));
}

#[test]
fn freeze_metadata_twice_fails() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres1");
    client.freeze_metadata(&id);

    let res = client.try_freeze_metadata(&id);
    assert_eq!(res, Err(Ok(Error::AlreadyFrozen)));
}

#[test]
fn update_metadata_on_frozen_resource_fails() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres2");
    client.freeze_metadata(&id);

    let res = client.try_update_metadata(&id, &String::from_str(&env, "ipfs://new"));
    assert_eq!(res, Err(Ok(Error::MetadataFrozen)));
}

#[test]
fn frozen_resource_still_allows_price_listing_tags_and_ownership_mutations() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres3");
    client.freeze_metadata(&id);

    client.set_price(&id, &500i128);
    assert_eq!(client.get(&id).price, 500i128);

    client.set_listed(&id, &false);
    assert!(!client.get(&id).listed);

    client.set_tags(&id, &tags(&env, &["dataset"]));
    assert_eq!(client.get(&id).tags.len(), 1);

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.get(&id).creator, new_owner);

    // Frozen state survives all of the above.
    assert!(client.get(&id).frozen);
}

// ─── Index repair (#428) ───────────────────────────────────────────────────

#[test]
fn repair_index_rebuilds_from_authoritative_list() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres0a");
    let b = register_default(&env, &creator, &client, "rres0b");
    let c = register_default(&env, &creator, &client, "rres0c");

    client.repair_index(&Vec::from_array(&env, [c.clone(), a.clone()]));

    assert_eq!(client.count(), 2);
    let page = client.list(&0u32, &10u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, c);
    assert_eq!(page.get(1).unwrap().id, a);

    // repair only rewrites the derived index — the dropped resource `b` is
    // still directly addressable by id.
    assert!(client.exists(&b));
    assert_eq!(client.get(&b).id, b);
}

#[test]
fn repair_index_rejects_unknown_id() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres1a");

    let res = client.try_repair_index(&Vec::from_array(
        &env,
        [a.clone(), String::from_str(&env, "ghost")],
    ));
    assert_eq!(res, Err(Ok(Error::NotFound)));
    // No partial write: the index is untouched.
    assert_eq!(client.count(), 1);
    assert_eq!(client.list(&0u32, &10u32).get(0).unwrap().id, a);
}

#[test]
fn repair_index_rejects_duplicates() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres2a");

    let res = client.try_repair_index(&Vec::from_array(&env, [a.clone(), a.clone()]));
    assert_eq!(res, Err(Ok(Error::DuplicateInRepair)));
}

#[test]
fn repair_index_before_admin_set_fails() {
    let (env, creator, client) = setup();
    let a = register_default(&env, &creator, &client, "rres3a");

    let res = client.try_repair_index(&Vec::from_array(&env, [a.clone()]));
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn repair_index_rerunning_current_list_is_a_safe_noop() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres4a");
    let b = register_default(&env, &creator, &client, "rres4b");

    client.repair_index(&Vec::from_array(&env, [a.clone(), b.clone()]));
    assert_eq!(client.count(), 2);
    let page = client.list(&0u32, &10u32);
    assert_eq!(page.get(0).unwrap().id, a);
    assert_eq!(page.get(1).unwrap().id, b);
}

#[test]
fn repair_index_emits_reindex_event() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres5a");
    let b = register_default(&env, &creator, &client, "rres5b");

    client.repair_index(&Vec::from_array(&env, [a.clone(), b.clone()]));

    let all = env.events().all();
    assert_eq!(all.len(), 1, "exactly one event should be emitted");
    let (_, topics, data) = all.get(0).unwrap();
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, symbol_short!("reindex"));
    let count: u32 = u32::try_from_val(&env, &data).unwrap();
    assert_eq!(
        count, 2u32,
        "event must report the number of ids in the repaired index"
    );
}

// ── Lifecycle transition property tests ──────────────────────────────────────
//
// The lifecycle state machine is documented as a table in `contract/README.md`
// and implemented across five entry points (`set_listed`, `freeze_resource`,
// `open_dispute`, `resolve_dispute`, `tombstone_resource`) that each enforce
// their own slice of it. The example-based tests above cover individual
// transitions; these properties drive random operation sequences against a
// model of the table and assert the contract agrees on every step.

#[derive(Copy, Clone, Debug, PartialEq)]
enum LifecycleOp {
    Relist,
    Delist,
    Freeze,
    OpenDispute,
    Resolve(ResourceState),
    Tombstone,
}

impl LifecycleOp {
    fn from_byte(byte: u8) -> Self {
        // Weighted so `Tombstone` stays rare: it is terminal, so a uniform mix
        // would end most sequences after a couple of steps.
        match byte % 16 {
            0 | 1 => LifecycleOp::Relist,
            2 | 3 => LifecycleOp::Delist,
            4 | 5 => LifecycleOp::Freeze,
            6..=8 => LifecycleOp::OpenDispute,
            9 | 10 => LifecycleOp::Resolve(ResourceState::Listed),
            11 | 12 => LifecycleOp::Resolve(ResourceState::Delisted),
            13 | 14 => LifecycleOp::Resolve(ResourceState::Frozen),
            _ => LifecycleOp::Tombstone,
        }
    }
}

fn model_transition(current: ResourceState, op: LifecycleOp) -> Option<ResourceState> {
    use LifecycleOp::*;
    use ResourceState::*;
    match (current, op) {
        (Tombstoned, _) => None,
        (_, Tombstone) => Some(Tombstoned),
        (Listed, Relist) => Some(Listed),
        (Delisted, Delist) => Some(Delisted),
        (Listed, Delist) => Some(Delisted),
        (Delisted, Relist) => Some(Listed),
        (Listed, Freeze) | (Delisted, Freeze) => Some(Frozen),
        (Listed, OpenDispute) | (Delisted, OpenDispute) | (Frozen, OpenDispute) => Some(Disputed),
        (Disputed, Resolve(target @ (Listed | Delisted | Frozen))) => Some(target),
        _ => None,
    }
}

fn apply_lifecycle_op(
    client: &VaultRegistryClient<'_>,
    id: &String,
    admin: &Address,
    op: LifecycleOp,
) -> Option<ResourceState> {
    let result = match op {
        LifecycleOp::Relist => client.try_set_listed(id, &true),
        LifecycleOp::Delist => client.try_set_listed(id, &false),
        LifecycleOp::Freeze => client.try_freeze_resource(id),
        LifecycleOp::OpenDispute => client.try_open_dispute(id, admin),
        LifecycleOp::Resolve(target) => client.try_resolve_dispute(id, admin, &target),
        LifecycleOp::Tombstone => client.try_tombstone_resource(id, admin),
    };
    match result {
        Ok(Ok(())) => Some(client.get(id).state),
        Err(Ok(Error::InvalidLifecycleTransition)) => None,
        other => panic!("unexpected lifecycle result for {op:?}: {other:?}"),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    #[test]
    fn test_lifecycle_transitions_follow_the_documented_table(
        ops in prop::collection::vec(any::<u8>(), 1..24),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = register_default(&env, &creator, &client, "lifeprop");
        let _ = (&env, &creator);

        let mut expected = ResourceState::Listed;
        for byte in ops {
            let op = LifecycleOp::from_byte(byte);
            let allowed = model_transition(expected, op);
            let observed = apply_lifecycle_op(&client, &id, &admin, op);

            match allowed {
                Some(next) => {
                    prop_assert_eq!(
                        observed,
                        Some(next),
                        "{:?} from {:?} must be accepted and land in {:?}",
                        op,
                        expected,
                        next
                    );
                    expected = next;
                }
                None => {
                    prop_assert_eq!(
                        observed,
                        None,
                        "{:?} from {:?} must be refused with InvalidLifecycleTransition",
                        op,
                        expected
                    );
                    prop_assert_eq!(
                        client.get(&id).state,
                        expected,
                        "a refused transition must not change the state"
                    );
                }
            }
        }
    }

    #[test]
    fn test_lifecycle_keeps_listed_projection_and_views_consistent(
        ops in prop::collection::vec(any::<u8>(), 1..16),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = String::from_str(&env, "lifeproj");
        client.register(
            &creator,
            &id,
            &100i128,
            &String::from_str(&env, "ipfs://lifeproj"),
            &tags(&env, &["proj"]),
        );

        for byte in ops {
            let _ = apply_lifecycle_op(&client, &id, &admin, LifecycleOp::from_byte(byte));

            let resource = client.get(&id);
            let is_listed = resource.state == ResourceState::Listed;
            prop_assert_eq!(
                resource.listed,
                is_listed,
                "listed must project state == Listed (state was {:?})",
                resource.state
            );
            prop_assert_eq!(
                client.list_listed(&0u32, &20u32).len(),
                if is_listed { 1 } else { 0 },
                "list_listed membership must follow the Listed state"
            );

            let tagged = client.list_by_tag(&String::from_str(&env, "proj"), &0u32, &20u32);
            prop_assert_eq!(
                tagged.len(),
                if resource.state == ResourceState::Tombstoned { 0 } else { 1 },
                "only tombstoning removes a resource from tag discovery"
            );
        }
    }

    #[test]
    fn test_lifecycle_gates_creator_mutations_by_state(
        ops in prop::collection::vec(any::<u8>(), 0..12),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = register_default(&env, &creator, &client, "lifemut");

        for byte in ops {
            let _ = apply_lifecycle_op(&client, &id, &admin, LifecycleOp::from_byte(byte));
        }

        let state = client.get(&id).state;
        let mutable = matches!(state, ResourceState::Listed | ResourceState::Delisted);
        let result = client.try_set_price(&id, &4_242i128);

        if mutable {
            prop_assert!(result.is_ok(), "set_price must be allowed in {:?}", state);
            prop_assert_eq!(client.get(&id).price, 4_242i128);
        } else {
            prop_assert_eq!(
                result,
                Err(Ok(Error::ResourceNotMutable)),
                "set_price must be refused in {:?}",
                state
            );
        }
    }

    #[test]
    fn test_tombstone_is_terminal_for_every_operation(
        ops in prop::collection::vec(any::<u8>(), 1..16),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = register_default(&env, &creator, &client, "lifeterm");
        let before = client.get(&id);
        client.tombstone_resource(&id, &admin);
        let _ = &env;

        for byte in ops {
            let op = LifecycleOp::from_byte(byte);
            prop_assert_eq!(
                apply_lifecycle_op(&client, &id, &admin, op),
                None,
                "{:?} must be refused once tombstoned",
                op
            );
        }

        let after = client.get(&id);
        prop_assert_eq!(after.state, ResourceState::Tombstoned);
        prop_assert_eq!(after.id, before.id);
        prop_assert_eq!(after.creator, before.creator);
        prop_assert_eq!(after.metadata, before.metadata);
    }
}

// ─── list_by_verification_status query (#621) ─────────────────────────────

#[test]
fn list_by_verification_status_empty_registry_returns_empty() {
    let (env, _creator, _admin, client) = setup_with_admin();
    
    let pending = client.list_by_verification_status(&VerificationStatus::Pending, &0u32, &20u32);
    assert_eq!(pending.items.len(), 0);
    assert_eq!(pending.next_cursor, None);
    
    let verified = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &20u32);
    assert_eq!(verified.items.len(), 0);
    assert_eq!(verified.next_cursor, None);
    
    let rejected = client.list_by_verification_status(&VerificationStatus::Rejected, &0u32, &20u32);
    assert_eq!(rejected.items.len(), 0);
    assert_eq!(rejected.next_cursor, None);
}

#[test]
fn list_by_verification_status_only_verified_records() {
    let (env, creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    
    let id1 = register_default(&env, &creator, &client, "verif0");
    let id2 = register_default(&env, &creator, &client, "verif1");
    
    client.set_verification_status(&id1, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&id2, &verifier, &VerificationStatus::Verified, &None);
    
    let verified = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &20u32);
    assert_eq!(verified.items.len(), 2);
    assert_eq!(verified.items.get(0).unwrap().id, id1);
    assert_eq!(verified.items.get(1).unwrap().id, id2);
    assert_eq!(verified.next_cursor, None);
    
    let pending = client.list_by_verification_status(&VerificationStatus::Pending, &0u32, &20u32);
    assert_eq!(pending.items.len(), 0);
    
    let rejected = client.list_by_verification_status(&VerificationStatus::Rejected, &0u32, &20u32);
    assert_eq!(rejected.items.len(), 0);
}

#[test]
fn list_by_verification_status_only_unverified_records() {
    let (env, creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    
    let id1 = register_default(&env, &creator, &client, "pend0");
    let id2 = register_default(&env, &creator, &client, "pend1");
    let id3 = register_default(&env, &creator, &client, "reject0");
    
    client.set_verification_status(&id3, &verifier, &VerificationStatus::Rejected, &None);
    
    let pending = client.list_by_verification_status(&VerificationStatus::Pending, &0u32, &20u32);
    assert_eq!(pending.items.len(), 2);
    assert_eq!(pending.items.get(0).unwrap().id, id1);
    assert_eq!(pending.items.get(1).unwrap().id, id2);
    
    let rejected = client.list_by_verification_status(&VerificationStatus::Rejected, &0u32, &20u32);
    assert_eq!(rejected.items.len(), 1);
    assert_eq!(rejected.items.get(0).unwrap().id, id3);
    
    let verified = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &20u32);
    assert_eq!(verified.items.len(), 0);
}

#[test]
fn list_by_verification_status_mixed_records() {
    let (env, creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    
    let pending1 = register_default(&env, &creator, &client, "mixpend1");
    let verified1 = register_default(&env, &creator, &client, "mixverif1");
    let rejected1 = register_default(&env, &creator, &client, "mixreject1");
    let pending2 = register_default(&env, &creator, &client, "mixpend2");
    let verified2 = register_default(&env, &creator, &client, "mixverif2");
    
    client.set_verification_status(&verified1, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&verified2, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&rejected1, &verifier, &VerificationStatus::Rejected, &None);
    
    let verified_page = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &20u32);
    assert_eq!(verified_page.items.len(), 2);
    assert_eq!(verified_page.items.get(0).unwrap().id, verified1);
    assert_eq!(verified_page.items.get(1).unwrap().id, verified2);
    
    let pending_page = client.list_by_verification_status(&VerificationStatus::Pending, &0u32, &20u32);
    assert_eq!(pending_page.items.len(), 2);
    assert_eq!(pending_page.items.get(0).unwrap().id, pending1);
    assert_eq!(pending_page.items.get(1).unwrap().id, pending2);
    
    let rejected_page = client.list_by_verification_status(&VerificationStatus::Rejected, &0u32, &20u32);
    assert_eq!(rejected_page.items.len(), 1);
    assert_eq!(rejected_page.items.get(0).unwrap().id, rejected1);
}

#[test]
fn list_by_verification_status_is_read_only() {
    let (env, creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    
    let id = register_default(&env, &creator, &client, "readonly");
    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    
    let before = client.get(&id);
    let _page = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &20u32);
    let after = client.get(&id);
    
    assert_eq!(before.version, after.version, "query must not modify resource version");
    assert_eq!(before.verified, after.verified, "query must not modify verification status");
}

#[test]
fn list_by_verification_status_respects_catalog_order() {
    let (env, creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    
    let id1 = register_default(&env, &creator, &client, "order1");
    let id2 = register_default(&env, &creator, &client, "order2");
    let id3 = register_default(&env, &creator, &client, "order3");
    
    client.set_verification_status(&id1, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&id2, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&id3, &verifier, &VerificationStatus::Verified, &None);
    
    let page = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &20u32);
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.items.get(0).unwrap().id, id1, "results must preserve registration order");
    assert_eq!(page.items.get(1).unwrap().id, id2);
    assert_eq!(page.items.get(2).unwrap().id, id3);
}

#[test]
fn list_by_verification_status_pagination_works() {
    let (env, creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    
    let id1 = register_default(&env, &creator, &client, "page1");
    let id2 = register_default(&env, &creator, &client, "page2");
    let id3 = register_default(&env, &creator, &client, "page3");
    
    client.set_verification_status(&id1, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&id2, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&id3, &verifier, &VerificationStatus::Verified, &None);
    
    let page1 = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &2u32);
    assert_eq!(page1.items.len(), 2);
    assert_eq!(page1.items.get(0).unwrap().id, id1);
    assert_eq!(page1.items.get(1).unwrap().id, id2);
    assert!(page1.next_cursor.is_some(), "more results should be available");
    
    let page2 = client.list_by_verification_status(&VerificationStatus::Verified, &page1.next_cursor.unwrap(), &2u32);
    assert_eq!(page2.items.len(), 1);
    assert_eq!(page2.items.get(0).unwrap().id, id3);
    assert_eq!(page2.next_cursor, None, "no more results");
}
