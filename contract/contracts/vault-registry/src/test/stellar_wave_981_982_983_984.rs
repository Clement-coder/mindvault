// Tests for Stellar Wave issues #981, #982, #983, #984
//
// #981 — admin recovery cannot target the current or pending admin
// #982 — role inventory page for admin, verifier, moderator, and settler
// #983 — complete actor and target data for role rotation events
// #984 — role-specific capability version in registry_info

// ── Issue #981: recovery-admin target rules ─────────────────────────────────

/// Bootstrap an admin and a distinct recovery admin via the dual-key path.
fn setup_dual_admin<'a>() -> (Env, Address, Address, VaultRegistryClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let recovery = Address::generate(&env);
    client.bootstrap_dual_admin(&admin, &recovery);
    (env, admin, recovery, client)
}

#[test]
fn recover_admin_rejects_current_admin_target() {
    let (env, admin, recovery, client) = setup_dual_admin();

    let res = client.try_recover_admin(&admin);
    assert_eq!(res, Err(Ok(Error::SameAdmin)));

    // No role changes on the invalid request.
    assert_eq!(client.admin(), Some(admin.clone()));
    assert_eq!(client.recovery_admin(), Some(recovery.clone()));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn recover_admin_rejects_pending_admin_target() {
    let (env, admin, recovery, client) = setup_dual_admin();
    let pending = Address::generate(&env);

    client.nominate_new_admin(&pending);
    assert_eq!(client.pending_admin(), Some(pending.clone()));

    let res = client.try_recover_admin(&pending);
    assert_eq!(res, Err(Ok(Error::SameAdmin)));

    // No role changes: the pending nomination and admin stay put.
    assert_eq!(client.admin(), Some(admin.clone()));
    assert_eq!(client.pending_admin(), Some(pending.clone()));
    assert_eq!(client.recovery_admin(), Some(recovery.clone()));
}

#[test]
fn recover_admin_rejects_recovery_admin_target() {
    let (env, admin, recovery, client) = setup_dual_admin();

    let res = client.try_recover_admin(&recovery);
    assert_eq!(res, Err(Ok(Error::SameAdmin)));

    assert_eq!(client.admin(), Some(admin.clone()));
    assert_eq!(client.recovery_admin(), Some(recovery.clone()));
}

#[test]
fn recover_admin_accepts_valid_new_address_and_clears_pending() {
    let (env, admin, recovery, client) = setup_dual_admin();
    let pending = Address::generate(&env);
    let replacement = Address::generate(&env);

    client.nominate_new_admin(&pending);
    client.recover_admin(&replacement);

    assert_eq!(client.admin(), Some(replacement.clone()));
    assert_eq!(client.pending_admin(), None);
    assert_eq!(client.pending_admin_expiry(), None);
    assert_eq!(client.recovery_admin(), Some(recovery.clone()));

    // The replaced admin no longer holds the role.
    assert_ne!(client.admin(), Some(admin));
}

#[test]
fn recover_admin_emits_recover_event_with_old_and_new_admin() {
    let (env, _admin, _recovery, client) = setup_dual_admin();
    let replacement = Address::generate(&env);
    let old_admin = client.admin().unwrap();

    client.recover_admin(&replacement);
    let (old, new): (Address, Address) = find_event(&env, &client.address, "recover").unwrap();
    assert_eq!(old, old_admin);
    assert_eq!(new, replacement);
}

// ── Issue #983: role mutation event payloads ────────────────────────────────

#[test]
fn add_verifier_emits_role_change_with_actor_and_target() {
    let (env, _creator, admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);

    client.add_verifier(&verifier);
    let change: RoleChange = find_event(&env, &client.address, "addverif").unwrap();
    assert_eq!(change.admin, admin);
    assert_eq!(change.target, verifier);
    assert!(change.granted);
}

#[test]
fn remove_verifier_emits_role_change_with_actor_and_target() {
    let (env, _creator, admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.remove_verifier(&verifier);
    let change: RoleChange = find_event(&env, &client.address, "rmverif").unwrap();
    assert_eq!(change.admin, admin);
    assert_eq!(change.target, verifier);
    assert!(!change.granted);
}

#[test]
fn rotate_verifier_emits_complete_actor_previous_and_replacement() {
    let (env, _creator, admin, client) = setup_with_admin();
    let old_verifier = Address::generate(&env);
    let new_verifier = Address::generate(&env);
    client.add_verifier(&old_verifier);

    client.rotate_verifier(&old_verifier, &new_verifier);

    let rotation: VerifierRotation = find_event(&env, &client.address, "verrot").unwrap();
    assert_eq!(rotation.admin, admin);
    assert_eq!(rotation.old_verifier, old_verifier);
    assert_eq!(rotation.new_verifier, new_verifier);
    assert_eq!(rotation.ledger, env.ledger().sequence());
}

#[test]
fn rotate_verifier_still_emits_rmverif_and_addverif_role_changes() {
    let (env, _creator, admin, client) = setup_with_admin();
    let old_verifier = Address::generate(&env);
    let new_verifier = Address::generate(&env);
    client.add_verifier(&old_verifier);

    client.rotate_verifier(&old_verifier, &new_verifier);

    let rm: RoleChange = find_event(&env, &client.address, "rmverif").unwrap();
    assert_eq!(rm.admin, admin);
    assert_eq!(rm.target, old_verifier);
    assert!(!rm.granted);

    let add: RoleChange = find_event(&env, &client.address, "addverif").unwrap();
    assert_eq!(add.admin, admin);
    assert_eq!(add.target, new_verifier);
    assert!(add.granted);
}

#[test]
fn settler_and_moderator_mutations_emit_stable_role_change_payloads() {
    let (env, _creator, admin, client) = setup_with_admin();
    let settler = Address::generate(&env);
    let moderator = Address::generate(&env);

    client.add_settler(&settler);
    let add_s: RoleChange = find_event(&env, &client.address, "addsettlr").unwrap();
    assert_eq!(add_s.admin, admin);
    assert_eq!(add_s.target, settler);
    assert!(add_s.granted);

    client.remove_settler(&settler);
    let rm_s: RoleChange = find_event(&env, &client.address, "rmsettlr").unwrap();
    assert_eq!(rm_s.admin, admin);
    assert_eq!(rm_s.target, settler);
    assert!(!rm_s.granted);

    client.add_moderator(&moderator);
    let add_m: RoleChange = find_event(&env, &client.address, "addmod").unwrap();
    assert_eq!(add_m.admin, admin);
    assert_eq!(add_m.target, moderator);
    assert!(add_m.granted);

    client.remove_moderator(&moderator);
    let rm_m: RoleChange = find_event(&env, &client.address, "rmmod").unwrap();
    assert_eq!(rm_m.admin, admin);
    assert_eq!(rm_m.target, moderator);
    assert!(!rm_m.granted);
}

// ── Issue #982: role inventory page ─────────────────────────────────────────

#[test]
fn role_inventory_admin_returns_single_holder() {
    let (_env, _admin, _recovery, client) = setup_dual_admin();

    let page = client.role_inventory_page(&RoleKind::Admin, &0, &20);
    assert_eq!(page.holders.len(), 1);
    assert_eq!(page.holders.get(0).unwrap(), client.admin().unwrap());
    assert_eq!(page.next_cursor, None);
}

#[test]
fn role_inventory_admin_is_empty_before_bootstrap() {
    let (_env, _creator, client) = setup();

    let page = client.role_inventory_page(&RoleKind::Admin, &0, &20);
    assert_eq!(page.holders.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn role_inventory_verifier_lists_active_holders_in_grant_order() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let v1 = Address::generate(&env);
    let v2 = Address::generate(&env);

    client.add_verifier(&v1);
    client.add_verifier(&v2);

    let page = client.role_inventory_page(&RoleKind::Verifier, &0, &20);
    assert_eq!(page.holders.len(), 2);
    assert_eq!(page.holders.get(0).unwrap(), v1.clone());
    assert_eq!(page.holders.get(1).unwrap(), v2.clone());
    assert_eq!(page.next_cursor, None);

    client.remove_verifier(&v1);
    let page = client.role_inventory_page(&RoleKind::Verifier, &0, &20);
    assert_eq!(page.holders.len(), 1);
    assert_eq!(page.holders.get(0).unwrap(), v2);
}

#[test]
fn role_inventory_moderator_and_settler_list_active_holders() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let m = Address::generate(&env);
    let s = Address::generate(&env);

    client.add_moderator(&m);
    client.add_settler(&s);

    let mods = client.role_inventory_page(&RoleKind::Moderator, &0, &20);
    assert_eq!(mods.holders.len(), 1);
    assert_eq!(mods.holders.get(0).unwrap(), m);

    let setts = client.role_inventory_page(&RoleKind::Settler, &0, &20);
    assert_eq!(setts.holders.len(), 1);
    assert_eq!(setts.holders.get(0).unwrap(), s);
}

#[test]
fn role_inventory_page_is_deterministic_and_capped() {
    let (env, _creator, _admin, client) = setup_with_admin();
    for _ in 0..5 {
        client.add_settler(&Address::generate(&env));
    }

    // limit is clamped to ROLE_INVENTORY_PAGE_CAP; a tiny limit still pages.
    let first = client.role_inventory_page(&RoleKind::Settler, &0, &2);
    assert_eq!(first.holders.len(), 2);
    assert_eq!(first.next_cursor, Some(2u32));

    let second = client.role_inventory_page(&RoleKind::Settler, &2, &2);
    assert_eq!(second.holders.len(), 2);
    assert_eq!(second.next_cursor, Some(4u32));

    let third = client.role_inventory_page(&RoleKind::Settler, &4, &2);
    assert_eq!(third.holders.len(), 1);
    assert_eq!(third.next_cursor, None);

    // Same cursor/limit always yields the same page.
    let replay = client.role_inventory_page(&RoleKind::Settler, &0, &2);
    assert_eq!(first.holders, replay.holders);
    assert_eq!(first.next_cursor, replay.next_cursor);
}

#[test]
fn role_inventory_page_never_mutates_role_state() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let v = Address::generate(&env);
    client.add_verifier(&v);

    let _ = client.role_inventory_page(&RoleKind::Verifier, &0, &20);
    let _ = client.role_inventory_page(&RoleKind::Admin, &0, &20);
    let _ = client.role_inventory_page(&RoleKind::Moderator, &0, &20);
    let _ = client.role_inventory_page(&RoleKind::Settler, &0, &20);

    // Reads leave the verifier set (and every other role) untouched.
    assert!(client.is_verifier(&v));
    let page = client.role_inventory_page(&RoleKind::Verifier, &0, &20);
    assert_eq!(page.holders.len(), 1);
}

#[test]
fn role_inventory_membership_cap_rejects_grant_without_state_change() {
    let (env, _creator, _admin, client) = setup_with_admin();
    for _ in 0..MAX_ROLE_HOLDERS {
        client.add_moderator(&Address::generate(&env));
    }

    let overflow = Address::generate(&env);
    let res = client.try_add_moderator(&overflow);
    assert_eq!(res, Err(Ok(Error::RoleCapacityReached)));
    assert!(!client.is_moderator(&overflow));

    let page = client.role_inventory_page(&RoleKind::Moderator, &0, &ROLE_INVENTORY_PAGE_CAP);
    assert_eq!(page.holders.len(), MAX_ROLE_HOLDERS);
}

#[test]
fn role_inventory_regrant_after_revoke_stays_within_cap() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let holder = Address::generate(&env);
    for _ in 0..MAX_ROLE_HOLDERS {
        client.add_settler(&Address::generate(&env));
    }

    // At capacity: a fresh grant is rejected.
    assert_eq!(
        client.try_add_settler(&holder),
        Err(Ok(Error::RoleCapacityReached))
    );

    // Freeing a slot (via rotate-free remove of an existing holder) reopens it.
    // Remove the first holder by listing and revoking them.
    let first = client
        .role_inventory_page(&RoleKind::Settler, &0, &1)
        .holders
        .get(0)
        .unwrap();
    client.remove_settler(&first);
    client.add_settler(&holder);
    assert!(client.is_settler(&holder));
}

// ── Issue #984: role capability version in registry_info ────────────────────

#[test]
fn registry_info_exposes_role_capability_version() {
    let (_env, _creator, client) = setup();
    let info = client.registry_info();
    assert_eq!(info.role_capability_version, ROLE_CAPABILITY_VERSION);
}

#[test]
fn role_capability_version_is_stable_across_calls() {
    let (env, creator, client) = setup();
    let before = client.registry_info().role_capability_version;

    client.add_moderator(&Address::generate(&env));
    client.register(
        &creator,
        &String::from_str(&env, "capstable"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    assert_eq!(client.registry_info().role_capability_version, before);
}

#[test]
fn role_capability_version_matches_contract_interface() {
    // The capability version advertises the role-administration surface.
    // Every role method the version covers must be present in METHOD_SCHEMA,
    // and the inventory page (the newest role feature) must be exported.
    let (_env, _creator, client) = setup();
    assert!(client.registry_info().role_capability_version >= 1);

    let role_methods = [
        "add_verifier",
        "remove_verifier",
        "rotate_verifier",
        "is_verifier",
        "add_moderator",
        "remove_moderator",
        "is_moderator",
        "add_settler",
        "remove_settler",
        "is_settler",
        "role_inventory_page",
        "recover_admin",
    ];
    for method in role_methods {
        assert!(
            METHOD_SCHEMA.iter().any(|(name, _)| *name == method),
            "ROLE_CAPABILITY_VERSION advertises `{method}` but METHOD_SCHEMA does not list it"
        );
    }
}
