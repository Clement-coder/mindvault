// Tests for Stellar Wave issues #977, #978, #979, #980
//
// #977 — tag-index repair idempotent for repeated and reordered IDs
// #978 — registry-level maintenance status with reason code
// #979 — expired pause deadlines must not reactivate after timestamp rollback
// #980 — delayed admin nomination cancellation

// ── Issue #977: repair_tag_index idempotence ────────────────────────────────

fn last_retagidx_count(env: &Env) -> u32 {
    let all = env.events().all();
    for i in (0..all.len()).rev() {
        let (_, topics, data) = all.get(i).unwrap();
        let sym: Option<Symbol> = topics
            .get(0)
            .and_then(|v| <Symbol as TryFromVal<Env, Val>>::try_from_val(env, &v).ok());
        if sym == Some(symbol_short!("retagidx")) {
            return u32::try_from_val(env, &data).unwrap();
        }
    }
    panic!("no retagidx event found");
}

#[test]
fn repair_tag_index_duplicate_ids_report_unique_count() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "sw977dupa", &["dup977"]);

    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), a.clone(), a.clone()]));
    assert_eq!(
        last_retagidx_count(&env),
        1,
        "duplicate input ids must not inflate the retagidx count"
    );
}

#[test]
fn repair_tag_index_reordered_input_converges_to_same_index() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "sw977orda", &["conv977"]);
    let b = register_tagged(&env, &creator, &client, "sw977ordb", &["conv977"]);
    let tag = String::from_str(&env, "conv977");

    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), b.clone()]));
    let forward = client.list_by_tag(&tag, &0u32, &20u32);

    client.repair_tag_index(&Vec::from_array(&env, [b.clone(), a.clone()]));
    let reversed = client.list_by_tag(&tag, &0u32, &20u32);

    assert_eq!(
        forward, reversed,
        "a reordered retry must converge to the same tag index"
    );

    client.repair_tag_index(&Vec::from_array(&env, [b.clone(), a.clone(), a.clone()]));
    let with_dups = client.list_by_tag(&tag, &0u32, &20u32);
    assert_eq!(
        forward, with_dups,
        "a retry with duplicates and reordering must converge to the same tag index"
    );
}

#[test]
fn repair_tag_index_duplicate_input_does_not_inflate_popularity() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "sw977popp", &["pop977"]);
    let before = client.top_tags();

    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), a.clone()]));
    let after = client.top_tags();

    assert_eq!(
        before, after,
        "repair with duplicate ids must not change tag popularity"
    );
}

#[test]
fn repair_tag_index_rejects_oversized_input_before_writes() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "sw977biga", &["big977"]);

    let mut ids: std::vec::Vec<String> = std::vec::Vec::new();
    for _ in 0..=MAX_TAG_INDEX_REPAIR {
        ids.push(a.clone());
    }
    let input = Vec::from_array(&env, ids.as_slice());
    let res = client.try_repair_tag_index(&input);
    assert_eq!(
        res,
        Err(Ok(Error::BatchTooLarge)),
        "oversized repair input must be rejected"
    );

    // No writes: no retagidx event and the index is untouched.
    assert_eq!(
        env.events().all().len(),
        0,
        "oversized input must be rejected before any event is emitted"
    );
    assert_eq!(client.list_by_tag(&String::from_str(&env, "big977"), &0u32, &20u32).len(), 1);
}

// ── Issue #978: registry-level maintenance status ───────────────────────────

#[test]
fn set_maintenance_status_records_kind_and_reason_code() {
    let (env, _creator, admin, client) = setup_with_admin();

    let status = client.maintenance_status();
    assert_eq!(status.kind, MaintenanceKind::None);
    assert_eq!(status.reason_code, 0u32);

    client.set_maintenance_status(&admin, &MaintenanceKind::Scheduled, &3u32);
    let status = client.maintenance_status();
    assert_eq!(status.kind, MaintenanceKind::Scheduled);
    assert_eq!(status.reason_code, 3u32);

    client.set_maintenance_status(&admin, &MaintenanceKind::Emergency, &1u32);
    let status = client.maintenance_status();
    assert_eq!(status.kind, MaintenanceKind::Emergency);
    assert_eq!(status.reason_code, 1u32);
}

#[test]
fn set_maintenance_status_rejects_reason_code_above_max() {
    let (env, _creator, admin, client) = setup_with_admin();
    client.set_maintenance_status(&admin, &MaintenanceKind::Scheduled, &5u32);

    let res = client.try_set_maintenance_status(
        &admin,
        &MaintenanceKind::Emergency,
        &(MAX_MAINTENANCE_REASON_CODE + 1),
    );
    assert_eq!(res, Err(Ok(Error::InvalidMaintenanceReason)));

    let status = client.maintenance_status();
    assert_eq!(status.kind, MaintenanceKind::Scheduled);
    assert_eq!(status.reason_code, 5u32, "failed write must not change status");
}

#[test]
fn set_maintenance_status_requires_current_admin() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let stranger = Address::generate(&env);
    let res = client.try_set_maintenance_status(&stranger, &MaintenanceKind::Emergency, &1u32);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn maintenance_status_readable_while_paused() {
    let (env, _creator, admin, client) = setup_with_admin();
    client.set_maintenance_status(&admin, &MaintenanceKind::Emergency, &2u32);
    client.set_paused(&admin, &true);

    let status = client.maintenance_status();
    assert_eq!(status.kind, MaintenanceKind::Emergency);
    assert_eq!(status.reason_code, 2u32);
    assert!(client.is_paused());
}

#[test]
fn set_maintenance_status_emits_mntstat_event() {
    let (env, _creator, admin, client) = setup_with_admin();
    client.set_maintenance_status(&admin, &MaintenanceKind::Scheduled, &7u32);

    let all = env.events().all();
    let (_, topics, data) = all.get(all.len() - 1).unwrap();
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, symbol_short!("mntstat"));
    let event: MaintenanceStatusEvent = MaintenanceStatusEvent::try_from_val(&env, &data).unwrap();
    assert_eq!(event.kind, MaintenanceKind::Scheduled);
    assert_eq!(event.reason_code, 7u32);
    assert_eq!(event.admin, admin);
}

// ── Issue #979: expired pause deadlines must not reactivate ─────────────────

#[test]
fn scheduled_pause_deadline_equality_counts_as_expired() {
    let (env, creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);

    env.ledger().set_timestamp(200);
    assert!(
        !client.is_paused(),
        "deadline equality must count as expired"
    );
    assert_eq!(client.pause_until(), None);
    client.register(
        &creator,
        &String::from_str(&env, "sw979eq"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
}

#[test]
fn expired_pause_deadline_does_not_reactivate_after_timestamp_rollback() {
    let (env, creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);
    assert!(client.is_paused());

    // Reach the deadline and observe the expiry.
    env.ledger().set_timestamp(200);
    assert!(!client.is_paused());

    // Timestamp rolls back to inside the original window. The expired pause
    // must stay expired — it cannot oscillate back to active.
    env.ledger().set_timestamp(150);
    assert!(
        !client.is_paused(),
        "an expired scheduled pause must not reactivate after a timestamp rollback"
    );
    assert_eq!(client.pause_until(), None);
    client.register(
        &creator,
        &String::from_str(&env, "sw979roll"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
}

#[test]
fn repeated_set_paused_until_updates_deadline_without_oscillation() {
    let (env, _creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);
    assert_eq!(client.pause_until(), Some(200));

    // Repeated update pushes the deadline later.
    client.set_paused_until(&admin, &300);
    assert_eq!(client.pause_until(), Some(300));
    assert!(client.is_paused());

    // Deadline passes and is latched; a later rollback cannot revive it.
    env.ledger().set_timestamp(300);
    assert!(!client.is_paused());
    env.ledger().set_timestamp(250);
    assert!(!client.is_paused());
}

// ── Issue #980: delayed admin nomination cancellation ───────────────────────

#[test]
fn cancel_admin_nomination_clears_pending_nomination() {
    let (env, _creator, admin, client) = setup_with_admin();
    let pending = Address::generate(&env);
    client.nominate_new_admin(&pending);
    assert_eq!(client.pending_admin(), Some(pending.clone()));

    client.cancel_admin_nomination(&admin);
    assert_eq!(client.pending_admin(), None);
    assert_eq!(client.pending_admin_expiry(), None);
}

#[test]
fn cancel_admin_nomination_without_pending_is_stable_error() {
    let (env, _creator, admin, client) = setup_with_admin();
    let res = client.try_cancel_admin_nomination(&admin);
    assert_eq!(
        res,
        Err(Ok(Error::PendingAdminNotSet)),
        "cancelling with no nomination must return PendingAdminNotSet"
    );
}

#[test]
fn cancel_admin_nomination_requires_current_admin() {
    let (env, _creator, admin, client) = setup_with_admin();
    let pending = Address::generate(&env);
    client.nominate_new_admin(&pending);

    let stranger = Address::generate(&env);
    let res = client.try_cancel_admin_nomination(&stranger);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    assert_eq!(client.pending_admin(), Some(pending));
    assert_eq!(client.admin(), Some(admin));
}

#[test]
fn canceled_nominee_cannot_accept_admin() {
    let (env, _creator, admin, client) = setup_with_admin();
    let pending = Address::generate(&env);
    client.nominate_new_admin(&pending);
    client.cancel_admin_nomination(&admin);

    let res = client.try_accept_admin(&pending);
    assert_eq!(
        res,
        Err(Ok(Error::AdminNominationExpired)),
        "a canceled nominee must not be able to accept"
    );
    assert_eq!(client.admin(), Some(admin));
}

#[test]
fn cancel_admin_nomination_emits_nomcncl_event() {
    let (env, _creator, admin, client) = setup_with_admin();
    let pending = Address::generate(&env);
    client.nominate_new_admin(&pending);

    client.cancel_admin_nomination(&admin);
    let all = env.events().all();
    let (_, topics, data) = all.get(all.len() - 1).unwrap();
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, symbol_short!("nomcncl"));
    let (nominee, emitted_admin): (Address, Address) =
        <(Address, Address)>::try_from_val(&env, &data).unwrap();
    assert_eq!(nominee, pending);
    assert_eq!(emitted_admin, admin);
}
