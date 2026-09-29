// ─── Anchor attempt cap and back-off (#792) ──────────────────────────────────

fn advance_past_backoff(env: &Env) {
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + ANCHOR_RETRY_BACKOFF_LEDGERS);
}

#[test]
fn rejected_attempts_are_counted_and_cleared_by_a_successful_anchor() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attcount");
    let buyer = Address::generate(&env);
    env.ledger().set_sequence_number(500);

    let fresh = client.get_anchor_attempts(&id, &buyer);
    assert_eq!(fresh.attempts, 0);
    assert_eq!(fresh.last_attempt_ledger, 0);

    assert!(!client.attempt_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "")
    ));
    let after_one = client.get_anchor_attempts(&id, &buyer);
    assert_eq!(after_one.attempts, 1);
    assert_eq!(after_one.last_attempt_ledger, 500);

    advance_past_backoff(&env);
    assert!(client.attempt_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "sha256good")
    ));
    let cleared = client.get_anchor_attempts(&id, &buyer);
    assert_eq!(cleared.attempts, 0);
    assert_eq!(cleared.last_attempt_ledger, 0);
}

#[test]
fn retry_inside_the_backoff_window_fails_fast_without_writing() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attbackoff");
    let buyer = Address::generate(&env);
    env.ledger().set_sequence_number(1_000);

    assert!(!client.attempt_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "")
    ));
    // One ledger short of the window: throttled, counter untouched, and the
    // data checks did not run (a valid hash is still reported as too soon).
    env.ledger()
        .set_sequence_number(1_000 + ANCHOR_RETRY_BACKOFF_LEDGERS - 1);
    assert!(!client.attempt_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "sha256valid")
    ));
    let failure = last_anchor_failure(&env, &id);
    assert_eq!(failure.reason, AnchorFailureReason::RetryTooSoon);
    assert_eq!(failure.ledger, 1_000 + ANCHOR_RETRY_BACKOFF_LEDGERS - 1);
    let state = client.get_anchor_attempts(&id, &buyer);
    assert_eq!(state.attempts, 1);
    assert_eq!(state.last_attempt_ledger, 1_000);
    assert_eq!(
        client.try_get_purchase_receipt(&id, &buyer),
        Err(Ok(Error::NotFound))
    );

    // At the window boundary the attempt runs and succeeds.
    env.ledger().set_sequence_number(1_000 + ANCHOR_RETRY_BACKOFF_LEDGERS);
    assert!(client.attempt_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "sha256valid")
    ));
}

#[test]
fn attempts_cap_emits_exhausted_once_then_fails_fast_forever() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attcap");
    let buyer = Address::generate(&env);
    env.ledger().set_sequence_number(10);
    let bad = String::from_str(&env, "");

    for n in 1..=MAX_ANCHOR_ATTEMPTS {
        if n > 1 {
            advance_past_backoff(&env);
        }
        assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &bad));
        // Events are per invocation: read them before any other call.
        let all = env.events().all();
        if n < MAX_ANCHOR_ATTEMPTS {
            // Only the anchrfail event for this attempt.
            assert_eq!(all.len(), 1);
            assert_eq!(
                last_anchor_failure(&env, &id).reason,
                AnchorFailureReason::InvalidReceiptHash
            );
        } else {
            // anchrfail followed by anchrxhst.
            assert_eq!(all.len(), 2);
            let (_cid, topics, data) = all.get_unchecked(1);
            let topic: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
            assert_eq!(topic, symbol_short!("anchrxhst"));
            let topic_id: String = String::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
            assert_eq!(topic_id, id);
            let topic_buyer: Address =
                Address::try_from_val(&env, &topics.get(2).unwrap()).unwrap();
            assert_eq!(topic_buyer, buyer);
            let exhausted = AnchorAttempts::try_from_val(&env, &data).unwrap();
            assert_eq!(exhausted.attempts, MAX_ANCHOR_ATTEMPTS);
            assert_eq!(exhausted.last_attempt_ledger, env.ledger().sequence());
        }
        assert_eq!(client.get_anchor_attempts(&id, &buyer).attempts, n);
    }

    // Past the cap, even a valid hash after the back-off is refused fast.
    advance_past_backoff(&env);
    assert!(!client.attempt_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "sha256valid")
    ));
    let all = env.events().all();
    assert_eq!(all.len(), 1, "an exhausted pair emits anchrfail only, no second anchrxhst");
    assert_eq!(
        last_anchor_failure(&env, &id).reason,
        AnchorFailureReason::AttemptsExhausted
    );
    assert_eq!(client.get_anchor_attempts(&id, &buyer).attempts, MAX_ANCHOR_ATTEMPTS);

    // The reverting entry point keeps no history and still works for the pair.
    client.anchor_purchase_receipt(&service, &id, &buyer, &String::from_str(&env, "sha256valid"));
    assert_eq!(client.get_anchor_attempts(&id, &buyer).attempts, 0);
}

#[test]
fn attempt_history_is_per_pair() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attpair");
    let other_id = register_default(&env, &creator, &client, "attpair2");
    let buyer_a = Address::generate(&env);
    let buyer_b = Address::generate(&env);
    let bad = String::from_str(&env, "");

    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer_a, &bad));
    // Same ledger, different buyer and different resource: not throttled.
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer_b, &bad));
    assert_eq!(
        last_anchor_failure(&env, &id).reason,
        AnchorFailureReason::InvalidReceiptHash
    );
    assert!(!client.attempt_anchor_purchase_receipt(&service, &other_id, &buyer_a, &bad));
    assert_eq!(
        last_anchor_failure(&env, &other_id).reason,
        AnchorFailureReason::InvalidReceiptHash
    );
    assert_eq!(client.get_anchor_attempts(&id, &buyer_a).attempts, 1);
    assert_eq!(client.get_anchor_attempts(&id, &buyer_b).attempts, 1);
    assert_eq!(client.get_anchor_attempts(&other_id, &buyer_a).attempts, 1);
}

#[test]
fn throttle_reasons_map_to_a_total_error_mapping() {
    assert_eq!(
        AnchorFailureReason::RetryTooSoon.as_error(),
        Error::InvalidPaymentTransition
    );
    assert_eq!(
        AnchorFailureReason::AttemptsExhausted.as_error(),
        Error::InvalidPaymentTransition
    );
}
