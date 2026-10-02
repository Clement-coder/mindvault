// ─── Composite moderation read (#820) ───────────────────────────────────────
//
// `flag_details(id)` returns a resource's dispute flag, the moderator's reason
// hash, and the moderator who last acted on it in one call, and `is_flagged(id)`
// answers the yes/no question on its own. Consumers used to assemble this from
// `get`, `get_flag_reason_hash` (which errors when no hash is set), and the
// moderation event history. These tests pin what each field reports after
// every moderator write, and that failed writes and other callers leave the
// recorded moderator alone.

fn reason_hash(env: &Env, value: &str) -> String {
    String::from_str(env, value)
}

#[test]
fn flag_details_of_an_untouched_resource_is_empty() {
    let (env, creator, _admin, _moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "fdempty");

    assert!(!client.is_flagged(&id));
    assert_eq!(
        client.flag_details(&id),
        FlagDetails {
            dispute_flag: DisputeFlag::NoFlag,
            reason_hash: None,
            last_moderator: None,
        }
    );
}

#[test]
fn flag_details_reports_flag_reason_hash_and_moderator() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "fdflagged");

    client.flag_resource(&id, &moderator, &FlagReason::Copyright);
    client.set_flag_reason_hash(&id, &moderator, &reason_hash(&env, "sha256:fd1"));

    assert!(client.is_flagged(&id));
    let details = client.flag_details(&id);
    assert_eq!(
        details,
        FlagDetails {
            dispute_flag: DisputeFlag::Flagged(FlagReason::Copyright),
            reason_hash: Some(reason_hash(&env, "sha256:fd1")),
            last_moderator: Some(moderator),
        }
    );
    // The composite read agrees with the individual getters it replaces.
    assert_eq!(details.dispute_flag, client.get(&id).dispute_flag);
    assert_eq!(details.reason_hash, Some(client.get_flag_reason_hash(&id)));
}

#[test]
fn last_moderator_follows_the_most_recent_moderator_write() {
    let (env, creator, _admin, first, client) = setup_with_moderator();
    let second = Address::generate(&env);
    client.add_moderator(&second);
    let id = register_default(&env, &creator, &client, "fdlast");

    client.flag_resource(&id, &first, &FlagReason::Spam);
    assert_eq!(client.flag_details(&id).last_moderator, Some(first.clone()));

    client.set_flag_reason_hash(&id, &second, &reason_hash(&env, "sha256:fd2"));
    assert_eq!(client.flag_details(&id).last_moderator, Some(second.clone()));

    client.unflag_resource(&id, &first);
    let details = client.flag_details(&id);
    assert!(!client.is_flagged(&id));
    assert_eq!(details.dispute_flag, DisputeFlag::NoFlag);
    assert_eq!(details.last_moderator, Some(first));
    // Unflagging does not clear the reason hash; the two are independent.
    assert_eq!(details.reason_hash, Some(reason_hash(&env, "sha256:fd2")));
}

#[test]
fn reason_hash_without_a_flag_is_reported_unflagged() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "fdhashonly");

    client.set_flag_reason_hash(&id, &moderator, &reason_hash(&env, "sha256:fd3"));

    assert!(!client.is_flagged(&id));
    assert_eq!(
        client.flag_details(&id),
        FlagDetails {
            dispute_flag: DisputeFlag::NoFlag,
            reason_hash: Some(reason_hash(&env, "sha256:fd3")),
            last_moderator: Some(moderator),
        }
    );
}

#[test]
fn rejected_moderator_writes_leave_last_moderator_unchanged() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let revoked = Address::generate(&env);
    client.add_moderator(&revoked);
    let stranger = Address::generate(&env);
    let id = register_default(&env, &creator, &client, "fdreject");

    client.flag_resource(&id, &moderator, &FlagReason::Malicious);
    client.remove_moderator(&revoked);

    assert_eq!(
        client.try_flag_resource(&id, &stranger, &FlagReason::Other),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_unflag_resource(&id, &revoked),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_set_flag_reason_hash(&id, &stranger, &reason_hash(&env, "x")),
        Err(Ok(Error::Unauthorized))
    );

    let details = client.flag_details(&id);
    assert_eq!(details.dispute_flag, DisputeFlag::Flagged(FlagReason::Malicious));
    assert_eq!(details.last_moderator, Some(moderator));
}

#[test]
fn creator_writes_do_not_touch_moderation_state() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "fdcreator");
    client.flag_resource(&id, &moderator, &FlagReason::Spam);
    let before = client.flag_details(&id);

    client.set_price(&id, &250i128);
    client.set_tags(&id, &tags(&env, &["moderated"]));

    assert_eq!(client.flag_details(&id), before);
}

#[test]
fn flag_details_and_is_flagged_match_list_by_dispute_status() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let flagged = register_default(&env, &creator, &client, "fdlistone");
    let clean = register_default(&env, &creator, &client, "fdlisttwo");
    client.flag_resource(&flagged, &moderator, &FlagReason::Other);

    let listed_flagged = client.list_by_dispute_status(&true, &0u32, &20u32);
    assert_eq!(listed_flagged.len(), 1);
    assert_eq!(listed_flagged.get(0).unwrap().id, flagged);
    assert!(client.is_flagged(&flagged));
    assert!(client.flag_details(&flagged).dispute_flag.is_flagged());
    assert!(!client.is_flagged(&clean));
    assert!(!client.flag_details(&clean).dispute_flag.is_flagged());
}

#[test]
fn moderation_reads_work_while_paused() {
    let (env, creator, admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "fdpaused");
    client.flag_resource(&id, &moderator, &FlagReason::Copyright);
    client.set_paused(&admin, &true);

    assert!(client.is_flagged(&id));
    assert_eq!(client.flag_details(&id).last_moderator, Some(moderator));
}

#[test]
fn moderation_reads_reject_missing_and_malformed_ids() {
    let (env, _creator, _admin, _moderator, client) = setup_with_moderator();
    let missing = String::from_str(&env, "fdmissing");
    let malformed = String::from_str(&env, "Not A Valid Id");

    assert_eq!(client.try_is_flagged(&missing), Err(Ok(Error::NotFound)));
    assert_eq!(client.try_flag_details(&missing), Err(Ok(Error::NotFound)));
    assert_eq!(
        client.try_is_flagged(&malformed),
        Err(Ok(Error::InvalidResourceId))
    );
    assert_eq!(
        client.try_flag_details(&malformed),
        Err(Ok(Error::InvalidResourceId))
    );
}

#[test]
fn flag_moderator_entry_gets_a_ttl_on_write() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "fdttl");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    let ttl = env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .get_ttl(&DataKey::FlagModerator(id.clone()))
    });
    assert!(
        ttl >= LIFETIME_THRESHOLD,
        "the last-moderator entry must be bumped like the flag reason hash, got TTL {ttl}"
    );
}
