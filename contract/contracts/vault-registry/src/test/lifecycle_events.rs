// ─── Lifecycle transition event payload regression tests ─────────────────────
//
// Verifies exact event payloads for lifecycle state transitions.
//
// In Soroban SDK 22, `env.events().all()` returns only the events emitted
// by the **most recent contract invocation**. Tests check events immediately
// after the lifecycle transition call.

/// Verify that `set_listed(false)` emits `setlisted` event with exact payload
/// `(true, false)` reflecting the Listed → Delisted transition.
#[test]
fn lifecycle_event_set_listed_delist_payload() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "lifecev1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Delist: Listed → Delisted
    client.set_listed(&id, &false);

    // Verify exact event
    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (contract_id, topics, data) = events.get(0).unwrap();
    assert_eq!(contract_id, client.address);

    // Verify topic structure
    let event_name: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_name, symbol_short!("setlisted"));
    let event_id: String = topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_id, id);

    // Verify exact payload: (old_listed, new_listed)
    let payload: (bool, bool) = data.try_into_val(&env).unwrap();
    assert!(payload.0, "old_listed must be true (was Listed)");
    assert!(!payload.1, "new_listed must be false (now Delisted)");
}

/// Verify that `set_listed(true)` emits `setlisted` event with exact payload
/// `(false, true)` reflecting the Delisted → Listed transition.
#[test]
fn lifecycle_event_set_listed_relist_payload() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "lifecev2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Delist first
    client.set_listed(&id, &false);

    // Relist: Delisted → Listed
    client.set_listed(&id, &true);

    // Verify exact event
    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (contract_id, topics, data) = events.get(0).unwrap();
    assert_eq!(contract_id, client.address);

    // Verify topic structure
    let event_name: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_name, symbol_short!("setlisted"));
    let event_id: String = topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_id, id);

    // Verify exact payload: (old_listed, new_listed)
    let payload: (bool, bool) = data.try_into_val(&env).unwrap();
    assert!(!payload.0, "old_listed must be false (was Delisted)");
    assert!(payload.1, "new_listed must be true (now Listed)");
}
