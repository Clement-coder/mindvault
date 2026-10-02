// ── Duplicate receipt buyer normalization (#683) ──────────────────────────────
//
// The duplicate-receipt guard is keyed on the exact `(resource_id, buyer)`
// pair stored in `DataKey::PurchaseReceipt`. These tests verify:
//
//   • Different buyers on the same resource each get their own independent
//     slot — a receipt for buyer A must not prevent buyer B from anchoring.
//   • The same buyer on different resources each get their own slot — a
//     receipt on resource X must not prevent an anchor on resource Y.
//   • A re-anchor attempt for an existing `(resource_id, buyer)` pair always
//     fails with `DuplicateReceipt`, regardless of the new hash supplied.
//   • A failed duplicate attempt leaves the original anchor intact and
//     readable from storage.
//   • Looking up `get_purchase_receipt` with a buyer address that has no
//     anchor for that resource returns `NotFound` (not another buyer's data).

/// Two distinct buyers anchoring to the same resource are independent —
/// buyer B's anchor must succeed even though buyer A already has one.
#[test]
fn anchor_purchase_receipt_different_buyers_same_resource_are_independent() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    let service = Address::generate(&env);
    let buyer_a = Address::generate(&env);
    let buyer_b = Address::generate(&env);
    let id = String::from_str(&env, "normres1");

    client.nominate_new_admin(&admin);
    client.add_verifier(&service);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://norm1"),
        &empty_tags(&env),
    );

    let hash_a = String::from_str(&env, "hashbuyera");
    let hash_b = String::from_str(&env, "hashbuyerb");

    // Anchor for buyer A succeeds.
    client.anchor_purchase_receipt(&service, &id, &buyer_a, &hash_a);

    // Anchor for buyer B on the same resource must also succeed — different
    // buyer means a different storage key.
    client.anchor_purchase_receipt(&service, &id, &buyer_b, &hash_b);

    let anchor_a = client.get_purchase_receipt(&id, &buyer_a);
    let anchor_b = client.get_purchase_receipt(&id, &buyer_b);

    assert_eq!(anchor_a.buyer, buyer_a);
    assert_eq!(anchor_a.receipt_hash, hash_a);
    assert_eq!(anchor_b.buyer, buyer_b);
    assert_eq!(anchor_b.receipt_hash, hash_b);

    // The two anchors are distinct entries — different hashes, different buyers.
    assert_ne!(
        anchor_a.receipt_hash, anchor_b.receipt_hash,
        "each buyer must have their own independent receipt slot"
    );
}

/// The same buyer can anchor to two different resources — the key is the
/// full `(resource_id, buyer)` pair, not just the buyer.
#[test]
fn anchor_purchase_receipt_same_buyer_different_resources_are_independent() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    let service = Address::generate(&env);
    let buyer = Address::generate(&env);
    let id1 = String::from_str(&env, "normres2a");
    let id2 = String::from_str(&env, "normres2b");

    client.nominate_new_admin(&admin);
    client.add_verifier(&service);
    client.register(
        &creator,
        &id1,
        &100i128,
        &String::from_str(&env, "ipfs://norm2a"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &id2,
        &200i128,
        &String::from_str(&env, "ipfs://norm2b"),
        &empty_tags(&env),
    );

    let hash1 = String::from_str(&env, "hashres1");
    let hash2 = String::from_str(&env, "hashres2");

    client.anchor_purchase_receipt(&service, &id1, &buyer, &hash1);
    client.anchor_purchase_receipt(&service, &id2, &buyer, &hash2);

    let anchor1 = client.get_purchase_receipt(&id1, &buyer);
    let anchor2 = client.get_purchase_receipt(&id2, &buyer);

    assert_eq!(anchor1.resource_id, id1);
    assert_eq!(anchor1.receipt_hash, hash1);
    assert_eq!(anchor2.resource_id, id2);
    assert_eq!(anchor2.receipt_hash, hash2);
}

/// A re-anchor attempt with a different hash for an already-anchored
/// `(resource_id, buyer)` pair must be rejected with `DuplicateReceipt`.
#[test]
fn anchor_purchase_receipt_duplicate_with_different_hash_still_errors() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    let service = Address::generate(&env);
    let buyer = Address::generate(&env);
    let id = String::from_str(&env, "normres3");

    client.nominate_new_admin(&admin);
    client.add_verifier(&service);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://norm3"),
        &empty_tags(&env),
    );

    let original_hash = String::from_str(&env, "originalhash");
    let new_hash = String::from_str(&env, "differenthash");

    client.anchor_purchase_receipt(&service, &id, &buyer, &original_hash);

    // A second anchor for the same pair with a *different* hash must fail.
    assert_eq!(
        client.try_anchor_purchase_receipt(&service, &id, &buyer, &new_hash),
        Err(Ok(Error::DuplicateReceipt)),
        "changing the hash must not bypass duplicate detection"
    );
}

/// After a failed duplicate anchor, the original anchor is preserved in
/// storage — the collision must not corrupt or overwrite the stored value.
#[test]
fn anchor_purchase_receipt_failed_duplicate_preserves_original() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    let service = Address::generate(&env);
    let buyer = Address::generate(&env);
    let id = String::from_str(&env, "normres4");

    client.nominate_new_admin(&admin);
    client.add_verifier(&service);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://norm4"),
        &empty_tags(&env),
    );

    env.ledger().set_sequence_number(42);
    let original_hash = String::from_str(&env, "canonicalhash");
    client.anchor_purchase_receipt(&service, &id, &buyer, &original_hash);

    // Attempt a duplicate (must fail).
    let _ = client.try_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "intruderhash"),
    );

    // The original anchor must be readable and unchanged.
    let anchor = client.get_purchase_receipt(&id, &buyer);
    assert_eq!(
        anchor.receipt_hash, original_hash,
        "original receipt hash must survive a failed duplicate attempt"
    );
    assert_eq!(
        anchor.ledger, 42,
        "ledger timestamp must not be updated by a failed duplicate attempt"
    );
    assert_eq!(anchor.buyer, buyer);
    assert_eq!(anchor.resource_id, id);
}

/// `get_purchase_receipt` returns `NotFound` for a buyer that has no anchor
/// for the given resource, even when another buyer does have one.
#[test]
fn get_purchase_receipt_returns_not_found_for_unknown_buyer() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    let service = Address::generate(&env);
    let buyer_with_receipt = Address::generate(&env);
    let buyer_without_receipt = Address::generate(&env);
    let id = String::from_str(&env, "normres5");

    client.nominate_new_admin(&admin);
    client.add_verifier(&service);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://norm5"),
        &empty_tags(&env),
    );

    client.anchor_purchase_receipt(
        &service,
        &id,
        &buyer_with_receipt,
        &String::from_str(&env, "knownhash"),
    );

    // A different buyer address must not resolve to the other buyer's anchor.
    assert_eq!(
        client.try_get_purchase_receipt(&id, &buyer_without_receipt),
        Err(Ok(Error::NotFound)),
        "get_purchase_receipt must not leak another buyer's anchor"
    );
}

/// Each buyer's duplicate guard is independent: buyer A's anchor must not
/// affect buyer B's ability to anchor, and neither affects the other's
/// duplicate detection.
#[test]
fn anchor_purchase_receipt_duplicate_guard_is_per_buyer() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    let service = Address::generate(&env);
    let buyer_a = Address::generate(&env);
    let buyer_b = Address::generate(&env);
    let id = String::from_str(&env, "normres6");

    client.nominate_new_admin(&admin);
    client.add_verifier(&service);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://norm6"),
        &empty_tags(&env),
    );

    // Anchor both buyers.
    client.anchor_purchase_receipt(
        &service,
        &id,
        &buyer_a,
        &String::from_str(&env, "hashofa"),
    );
    client.anchor_purchase_receipt(
        &service,
        &id,
        &buyer_b,
        &String::from_str(&env, "hashofb"),
    );

    // Re-anchoring buyer A still errors — buyer B's anchor is irrelevant.
    assert_eq!(
        client.try_anchor_purchase_receipt(
            &service,
            &id,
            &buyer_a,
            &String::from_str(&env, "newhasha")
        ),
        Err(Ok(Error::DuplicateReceipt)),
        "buyer A duplicate guard must fire independently of buyer B"
    );

    // Re-anchoring buyer B also errors.
    assert_eq!(
        client.try_anchor_purchase_receipt(
            &service,
            &id,
            &buyer_b,
            &String::from_str(&env, "newhashb")
        ),
        Err(Ok(Error::DuplicateReceipt)),
        "buyer B duplicate guard must fire independently of buyer A"
    );
}

// ── Reporting anchor failures as events ──────────────────────────────────────

fn setup_with_anchor_service<'a>() -> (Env, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, _admin, client) = setup_with_admin();
    let service = Address::generate(&env);
    client.add_verifier(&service);
    (env, creator, service, client)
}

fn last_anchor_failure(env: &Env, expected_id: &String) -> AnchorFailure {
    let all = env.events().all();
    let (_cid, topics, data) = all.get_unchecked(all.len() - 1);
    assert_eq!(
        topics.len(),
        2,
        "anchrfail topics are (symbol, resource_id)"
    );

    let topic: Symbol = Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, symbol_short!("anchrfail"));
    let topic_id: String = String::try_from_val(env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(&topic_id, expected_id);

    AnchorFailure::try_from_val(env, &data).unwrap()
}

#[test]
fn attempt_anchor_purchase_receipt_succeeds_like_the_reverting_variant() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attanch1");
    let buyer = Address::generate(&env);
    let hash = String::from_str(&env, "sha256ok");

    assert!(client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &hash));

    let all = env.events().all();
    let (_cid, topics, _data) = all.get_unchecked(all.len() - 1);
    let topic: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, symbol_short!("anchor"));

    let anchor = client.get_purchase_receipt(&id, &buyer);
    assert_eq!(anchor.receipt_hash, hash);
    assert_eq!(anchor.buyer, buyer);
}

#[test]
fn attempt_anchor_reports_unknown_resource() {
    let (env, _creator, service, client) = setup_with_anchor_service();
    let missing = String::from_str(&env, "attnores");
    let buyer = Address::generate(&env);
    let hash = String::from_str(&env, "sha256missing");

    assert!(!client.attempt_anchor_purchase_receipt(&service, &missing, &buyer, &hash));

    let failure = last_anchor_failure(&env, &missing);
    assert_eq!(failure.reason, AnchorFailureReason::ResourceNotFound);
    assert_eq!(failure.buyer, buyer);
    assert_eq!(failure.receipt_hash, hash);
    assert_eq!(failure.ledger, env.ledger().sequence());
}

#[test]
fn attempt_anchor_reports_empty_and_oversized_receipt_hash() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attbadhsh");
    let buyer = Address::generate(&env);

    assert!(!client.attempt_anchor_purchase_receipt(
        &service,
        &id,
        &buyer,
        &String::from_str(&env, "")
    ));
    assert_eq!(
        last_anchor_failure(&env, &id).reason,
        AnchorFailureReason::InvalidReceiptHash
    );

    let too_long = String::from_str(&env, &"a".repeat(MAX_TX_HASH_LEN as usize + 1));
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &too_long));
    assert_eq!(
        last_anchor_failure(&env, &id).reason,
        AnchorFailureReason::InvalidReceiptHash
    );

    assert_eq!(
        client.try_get_purchase_receipt(&id, &buyer),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn attempt_anchor_reports_duplicate_and_preserves_the_original() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attdup");
    let buyer = Address::generate(&env);
    let original = String::from_str(&env, "sha256first");

    client.anchor_purchase_receipt(&service, &id, &buyer, &original);

    let replacement = String::from_str(&env, "sha256second");
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &replacement));

    let failure = last_anchor_failure(&env, &id);
    assert_eq!(failure.reason, AnchorFailureReason::DuplicateReceipt);
    assert_eq!(
        failure.receipt_hash, replacement,
        "the failure event carries the rejected hash, not the stored one"
    );
    assert_eq!(
        client.get_purchase_receipt(&id, &buyer).receipt_hash,
        original,
        "a rejected attempt must leave the canonical anchor untouched"
    );
}

#[test]
fn attempt_anchor_failure_reasons_match_the_reverting_variant_errors() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attparity");
    let buyer = Address::generate(&env);
    let missing = String::from_str(&env, "attparityx");
    let good = String::from_str(&env, "sha256parity");

    assert!(!client.attempt_anchor_purchase_receipt(&service, &missing, &buyer, &good));
    let reported = last_anchor_failure(&env, &missing).reason;
    assert_eq!(
        client.try_anchor_purchase_receipt(&service, &missing, &buyer, &good),
        Err(Ok(reported.as_error()))
    );

    let empty = String::from_str(&env, "");
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &empty));
    let reported = last_anchor_failure(&env, &id).reason;
    assert_eq!(
        client.try_anchor_purchase_receipt(&service, &id, &buyer, &empty),
        Err(Ok(reported.as_error()))
    );

    client.anchor_purchase_receipt(&service, &id, &buyer, &good);
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &good));
    let reported = last_anchor_failure(&env, &id).reason;
    assert_eq!(
        client.try_anchor_purchase_receipt(&service, &id, &buyer, &good),
        Err(Ok(reported.as_error()))
    );
}

#[test]
fn attempt_anchor_still_reverts_for_a_non_verifier() {
    let (env, creator, _service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attauth");
    let stranger = Address::generate(&env);
    let buyer = Address::generate(&env);

    assert_eq!(
        client.try_attempt_anchor_purchase_receipt(
            &stranger,
            &id,
            &buyer,
            &String::from_str(&env, "sha256stranger")
        ),
        Err(Ok(Error::NotVerifier))
    );
}

#[test]
fn attempt_anchor_still_reverts_for_a_malformed_resource_id() {
    let (env, _creator, service, client) = setup_with_anchor_service();
    let buyer = Address::generate(&env);

    assert_eq!(
        client.try_attempt_anchor_purchase_receipt(
            &service,
            &String::from_str(&env, "NOT A VALID ID"),
            &buyer,
            &String::from_str(&env, "sha256bad")
        ),
        Err(Ok(Error::InvalidResourceId))
    );
}

// ── Override flow ────────────────────────────────────────────────────────────

#[test]
fn override_purchase_receipt_anchor_updates_existing_anchor() {
    let (env, creator, admin, client) = setup_with_admin();
    let service = Address::generate(&env);
    client.add_verifier(&service);
    let id = register_default(&env, &creator, &client, "ovrride1");
    let buyer = Address::generate(&env);
    
    let original = String::from_str(&env, "originalhash");
    client.anchor_purchase_receipt(&service, &id, &buyer, &original);
    
    let replacement = String::from_str(&env, "replacementhash");
    client.override_purchase_receipt_anchor(&admin, &id, &buyer, &replacement);
    
    let anchor = client.get_purchase_receipt(&id, &buyer);
    assert_eq!(anchor.receipt_hash, replacement);
    assert_eq!(anchor.buyer, buyer);
}

#[test]
fn override_purchase_receipt_anchor_fails_if_not_found() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "ovrride2");
    let buyer = Address::generate(&env);
    
    let hash = String::from_str(&env, "somehash");
    assert_eq!(
        client.try_override_purchase_receipt_anchor(&admin, &id, &buyer, &hash),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn override_purchase_receipt_anchor_reverts_for_non_admin() {
    let (env, creator, _admin, client) = setup_with_admin();
    let service = Address::generate(&env);
    client.add_verifier(&service);
    let id = register_default(&env, &creator, &client, "ovrride3");
    let buyer = Address::generate(&env);
    let stranger = Address::generate(&env);
    
    let original = String::from_str(&env, "originalhash");
    client.anchor_purchase_receipt(&service, &id, &buyer, &original);
    
    let hash = String::from_str(&env, "newhash");
    assert_eq!(
        client.try_override_purchase_receipt_anchor(&service, &id, &buyer, &hash),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_override_purchase_receipt_anchor(&stranger, &id, &buyer, &hash),
        Err(Ok(Error::Unauthorized))
    );
}
