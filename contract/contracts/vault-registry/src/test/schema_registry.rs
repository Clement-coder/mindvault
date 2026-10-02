// ---------------------------------------------------------------------------
// registry_info() — registry discovery metadata
// ---------------------------------------------------------------------------

#[test]
fn registry_info_exposes_stable_fields() {
    let (env, _creator, client) = setup();
    let info = client.registry_info();

    assert_eq!(info.name, String::from_str(&env, REGISTRY_NAME));
    assert_eq!(info.resource_schema_version, RESOURCE_SCHEMA_VERSION);
    assert!(!info.version.is_empty(), "version must not be empty");
    assert_eq!(info.network_id, env.ledger().network_id());
}

#[test]
fn registry_info_is_stable_across_calls_and_registrations() {
    let (env, creator, client) = setup();
    let before = client.registry_info();

    client.register(
        &creator,
        &String::from_str(&env, "infostability"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let after = client.registry_info();
    assert_eq!(
        before, after,
        "registry_info must not depend on registry contents"
    );
}

// ---------------------------------------------------------------------------
// Deployment network identifier guard (#457)
// ---------------------------------------------------------------------------

#[test]
fn network_id_requires_initialization() {
    let (env, _creator, client) = setup();
    assert_eq!(
        client.try_network_id(),
        Err(Ok(Error::NetworkNotInitialized))
    );
    assert_eq!(client.registry_info().network_id, env.ledger().network_id());
}

#[test]
fn initialize_network_records_and_exposes_current_ledger_id() {
    let (env, _creator, client) = setup();
    let expected = env.ledger().network_id();

    client.initialize_network(&expected);
    assert_eq!(client.network_id(), expected);
}

#[test]
fn initialize_network_rejects_mismatched_network_id_without_writing() {
    let (env, _creator, client) = setup();
    let mut wrong = env.ledger().network_id().to_array();
    wrong[0] ^= 1;
    let wrong = BytesN::from_array(&env, &wrong);

    assert_eq!(
        client.try_initialize_network(&wrong),
        Err(Ok(Error::NetworkIdMismatch))
    );
    assert_eq!(
        client.try_network_id(),
        Err(Ok(Error::NetworkNotInitialized))
    );
}

#[test]
fn initialize_network_rejects_duplicate_initialization() {
    let (env, _creator, client) = setup();
    let network_id = env.ledger().network_id();
    client.initialize_network(&network_id);

    assert_eq!(
        client.try_initialize_network(&network_id),
        Err(Ok(Error::NetworkAlreadyInitialized))
    );
    assert_eq!(client.network_id(), network_id);
}

// ---------------------------------------------------------------------------
// contract_version() — compact build/schema version for deployment scripts
// ---------------------------------------------------------------------------

#[test]
fn contract_version_returns_crate_and_schema_version() {
    let (_env, _creator, client) = setup();
    let v = client.contract_version();

    // crate_version is baked at build time; it must be a non-empty semver string.
    assert!(
        !v.crate_version.is_empty(),
        "crate_version must not be empty"
    );
    // resource_schema_version is the compile-time constant; the call must echo it.
    assert_eq!(
        v.resource_schema_version, RESOURCE_SCHEMA_VERSION,
        "contract_version must expose RESOURCE_SCHEMA_VERSION"
    );
}

#[test]
fn contract_version_matches_registry_info_fields() {
    // contract_version is a focused subset of registry_info. Both must agree on
    // the same crate_version/schema_version so deployment scripts can use either.
    let (_env, _creator, client) = setup();
    let v = client.contract_version();
    let info = client.registry_info();

    assert_eq!(
        v.crate_version, info.version,
        "contract_version.crate_version must equal registry_info.version"
    );
    assert_eq!(
        v.resource_schema_version, info.resource_schema_version,
        "contract_version.resource_schema_version must equal registry_info.resource_schema_version"
    );
}

#[test]
fn contract_version_is_stable_across_calls_and_registrations() {
    let (env, creator, client) = setup();
    let before = client.contract_version();

    client.register(
        &creator,
        &String::from_str(&env, "cvstability"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let after = client.contract_version();
    assert_eq!(
        before, after,
        "contract_version must not change when resources are registered"
    );
}

// ---------------------------------------------------------------------------
// Event schema drift detection
// ---------------------------------------------------------------------------
//
// `EVENT_SCHEMA` in lib.rs is the single source of truth for every event
// topic this contract emits. These two tests fail if it drifts from either
// side: the contract's actual runtime emissions, or the human-readable
// Events table in `contract/README.md`. Add/rename/remove an emitted event
// without updating all three (code, EVENT_SCHEMA, README) and one of these
// tests catches it.
extern crate std;

fn topic0_symbol(env: &Env, topics: &soroban_sdk::Vec<Val>) -> Option<Symbol> {
    Symbol::try_from_val(env, &topics.get(0)?).ok()
}

fn find_event<D>(env: &Env, contract: &Address, topic: &str) -> Option<D>
where
    D: TryFromVal<Env, Val>,
{
    let events = env.events().all();
    for i in 0..events.len() {
        let (address, topics, data) = events.get(i).unwrap();
        if address != *contract || topic0_symbol(env, &topics) != Some(Symbol::new(env, topic)) {
            continue;
        }
        if let Ok(decoded) = D::try_from_val(env, &data) {
            return Some(decoded);
        }
    }
    None
}

fn find_setprice_event(env: &Env, contract: &Address) -> Option<PriceUpdated> {
    find_event(env, contract, "setprice")
}

fn find_transfer_event(env: &Env, contract: &Address) -> Option<(Address, Address)> {
    find_event(env, contract, "transfer")
}

fn find_propose_event(env: &Env, contract: &Address) -> Option<(Address, Address)> {
    find_event(env, contract, "propose")
}

fn find_cancel_event(env: &Env, contract: &Address) -> Option<Address> {
    find_event(env, contract, "cancel")
}

fn find_settags_event(env: &Env, contract: &Address) -> Option<(Vec<String>, Vec<String>)> {
    find_event(env, contract, "settags")
}

// ---------------------------------------------------------------------------
// Tag index repair design (#429)
// ---------------------------------------------------------------------------
//
// No on-chain tag index exists yet (see docs/tag-index-repair-design.md), but
// a future one's repair path could rebuild id->tags associations either by
// reading `Resource.tags` directly or by replaying `register`/`settags`
// events. This test backs the ADR's "no third source of truth needed" claim
// by reconstructing tag state purely from event replay — never calling
// `get` — and checking it against `Resource.tags` exactly.
#[test]
fn register_then_settags_events_reconstruct_current_tags() {
    let (env, creator, client) = setup();

    let id_a = String::from_str(&env, "replaytaga");
    let id_b = String::from_str(&env, "replaytagb");
    let metadata = String::from_str(&env, "ipfs://m");

    // The Soroban test event log only reliably reflects the most recent
    // invocation (see `freeze_metadata_sets_flag_and_emits_event`'s comment
    // on this), so record the last event's decoded tag state immediately
    // after each call rather than replaying `env.events().all()` once at
    // the end.
    let last_settags_tags = |env: &Env| -> (String, Vec<String>) {
        let (_, topics, data) = env.events().all().last().unwrap();
        let event_id: String =
            <String as TryFromVal<Env, Val>>::try_from_val(env, &topics.get(1).unwrap()).unwrap();
        let (_prev, next): (Vec<String>, Vec<String>) = data.try_into_val(env).unwrap();
        (event_id, next)
    };
    let last_register_tags = |env: &Env| -> (String, Vec<String>) {
        let (_, _, data) = env.events().all().last().unwrap();
        let resource: RegisterEvent = data.try_into_val(env).unwrap();
        (resource.id, resource.tags)
    };

    client.register(
        &creator,
        &id_a,
        &100i128,
        &metadata,
        &tags(&env, &["alpha", "beta"]),
    );
    let (rid, _) = last_register_tags(&env);
    assert_eq!(rid, id_a);

    client.register(&creator, &id_b, &100i128, &metadata, &empty_tags(&env));
    let (rid, _) = last_register_tags(&env);
    assert_eq!(rid, id_b);

    client.set_tags(&id_a, &tags(&env, &["gamma"]));
    let (eid, _) = last_settags_tags(&env);
    assert_eq!(eid, id_a);

    client.set_tags(&id_b, &tags(&env, &["delta", "epsilon"]));
    let (eid, reconstructed_b) = last_settags_tags(&env);
    assert_eq!(eid, id_b);

    client.set_tags(&id_a, &empty_tags(&env));
    let (eid, _) = last_settags_tags(&env);
    assert_eq!(eid, id_a);

    client.set_tags(&id_a, &tags(&env, &["zeta"]));
    let (eid, reconstructed_a) = last_settags_tags(&env);
    assert_eq!(eid, id_a);

    assert_eq!(reconstructed_a, client.get(&id_a).tags);
    assert_eq!(reconstructed_b, client.get(&id_b).tags);

    // Sanity: prove replay tracked the final mutation, not just the initial register.
    assert_eq!(client.get(&id_a).tags.len(), 1);
    assert_eq!(
        client.get(&id_a).tags.get(0).unwrap(),
        String::from_str(&env, "zeta")
    );
}

#[test]
fn full_workflow_emits_exactly_the_documented_events() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let mut observed: std::vec::Vec<std::string::String> = std::vec::Vec::new();

    fn record(
        env: &Env,
        client: &VaultRegistryClient,
        observed: &mut std::vec::Vec<std::string::String>,
    ) {
        let all = env.events().all();
        for i in 0..all.len() {
            let (cid, topics, _data) = all.get(i).unwrap();
            if cid != client.address {
                continue;
            }
            if let Some(sym) = topic0_symbol(env, &topics) {
                observed.push(sym.to_string());
            }
        }
    }

    let r0 = String::from_str(&env, "schemar0");
    client.register(
        &alice,
        &r0,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    record(&env, &client, &mut observed);

    client.set_price(&r0, &200i128);
    record(&env, &client, &mut observed);

    client.update_metadata(&r0, &String::from_str(&env, "ipfs://m2"));
    record(&env, &client, &mut observed);

    client.set_tags(&r0, &tags(&env, &["a"]));
    record(&env, &client, &mut observed);

    client.set_listed(&r0, &false);
    record(&env, &client, &mut observed);
    client.set_listed(&r0, &true);
    record(&env, &client, &mut observed);
    client.delist(&r0);
    record(&env, &client, &mut observed);

    client.propose_transfer(&r0, &bob);
    record(&env, &client, &mut observed);
    env.mock_all_auths();
    client.accept_transfer(&r0);
    record(&env, &client, &mut observed);

    let r1 = String::from_str(&env, "schemar1");
    client.register(
        &alice,
        &r1,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    record(&env, &client, &mut observed);
    client.transfer_ownership(&r1, &bob);
    record(&env, &client, &mut observed);

    let r2 = String::from_str(&env, "schemar2");
    client.register(
        &alice,
        &r2,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    record(&env, &client, &mut observed);
    client.propose_transfer(&r2, &bob);
    record(&env, &client, &mut observed);
    client.cancel_transfer(&r2);
    record(&env, &client, &mut observed);

    client.set_terms_hash(&alice, &String::from_str(&env, "termshash"));
    record(&env, &client, &mut observed);

    let admin1 = Address::generate(&env);
    client.nominate_new_admin(&admin1); // bootstrap -> "setadmin"
    record(&env, &client, &mut observed);
    let admin2 = Address::generate(&env);
    client.nominate_new_admin(&admin2); // rotation -> "nomadmin"
    record(&env, &client, &mut observed);
    client.accept_admin(&admin2);
    record(&env, &client, &mut observed);

    // Verifier role, verification mirror, freeze, and index repair.
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier); // -> "addverif"
    record(&env, &client, &mut observed);
    client.set_verification_status(&r2, &verifier, &VerificationStatus::Verified, &None::<String>); // -> "verify"
    record(&env, &client, &mut observed);
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 100,
        fee_recipient: Some(admin2.clone()),
    }); // -> "setfee"
    record(&env, &client, &mut observed);

    let buyer = Address::generate(&env);
    client.anchor_purchase_receipt(
        &verifier,
        &r0,
        &buyer,
        &String::from_str(&env, "sha256anchor"),
    ); // -> "anchor"
    record(&env, &client, &mut observed);
    assert!(!client.attempt_anchor_purchase_receipt(
        &verifier,
        &r0,
        &buyer,
        &String::from_str(&env, "sha256anchor2"),
    )); // -> "anchrfail"
    record(&env, &client, &mut observed);
    client.remove_verifier(&verifier); // -> "rmverif"
    record(&env, &client, &mut observed);

    client.freeze_metadata(&r2); // -> "freeze"
    record(&env, &client, &mut observed);

    client.open_dispute(&r2, &admin2); // -> "lifecycle"
    record(&env, &client, &mut observed);
    client.resolve_dispute(&r2, &admin2, &ResourceState::Frozen); // -> "lifecycle"
    record(&env, &client, &mut observed);
    client.extend_resource_ttl(&bob, &r0); // -> "ttlext"
    record(&env, &client, &mut observed);

    client.repair_index(&Vec::from_array(&env, [r0.clone(), r1.clone(), r2.clone()])); // -> "reindex"
    record(&env, &client, &mut observed);

    client.repair_tag_index(&Vec::from_array(&env, [r0.clone(), r1.clone(), r2.clone()])); // -> "retagidx"
    record(&env, &client, &mut observed);

    client.set_paused(&admin2, &false); // -> "pause"
    record(&env, &client, &mut observed);

    let settler = Address::generate(&env);
    client.add_settler(&settler); // -> "addsettlr"
    record(&env, &client, &mut observed);

    let payer = Address::generate(&env);
    let receipt_id = String::from_str(&env, "schemarcpt");
    client.record_payment(
        &settler,
        &receipt_id,
        &r0,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "txhash123"),
    ); // -> "payment"
    record(&env, &client, &mut observed);
    client.settle_payment(&settler, &receipt_id); // -> "settle"
    record(&env, &client, &mut observed);
    client.remove_settler(&settler); // -> "rmsettlr"
    record(&env, &client, &mut observed);

    // Moderator role and dispute flagging (#389).
    let moderator = Address::generate(&env);
    client.add_moderator(&moderator); // -> "addmod"
    record(&env, &client, &mut observed);
    client.flag_resource(&r0, &moderator, &FlagReason::Spam); // -> "flag"
    record(&env, &client, &mut observed);
    client.set_flag_reason_hash(&r0, &moderator, &String::from_str(&env, "reasonhash")); // -> "flagrsn"
    record(&env, &client, &mut observed);
    client.unflag_resource(&r0, &moderator); // -> "unflag"
    record(&env, &client, &mut observed);
    client.remove_moderator(&moderator); // -> "rmmod"
    record(&env, &client, &mut observed);

    observed.sort();
    observed.dedup();

    let mut expected: std::vec::Vec<std::string::String> = EVENT_SCHEMA
        .iter()
        .map(|(topic, _)| std::string::String::from(*topic))
        .collect();
    expected.sort();

    assert_eq!(
        observed, expected,
        "emitted event topics must exactly match EVENT_SCHEMA in lib.rs — update \
         EVENT_SCHEMA (and contract/README.md's Events table) whenever you add, \
         rename, or remove an emitted event"
    );
}
