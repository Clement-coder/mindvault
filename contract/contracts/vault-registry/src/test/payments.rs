// ─── Escrow-ready payment state (#387) ────────────────────────────────────

/// Helper: set up a contract with an admin and a settler.
fn setup_with_settler<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, admin, client) = setup_with_admin();
    let settler = Address::generate(&env);
    client.add_settler(&settler);
    (env, creator, admin, settler, client)
}

fn payment_receipt_ttl(
    env: &Env,
    contract: &soroban_sdk::Address,
    receipt_id: &String,
) -> u32 {
    let key = DataKey::PaymentReceipt(receipt_id.clone());
    env.as_contract(contract, || env.storage().persistent().get_ttl(&key))
}

#[test]
fn admin_can_grant_and_revoke_settler() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let settler = Address::generate(&env);

    assert!(!client.is_settler(&settler));

    client.add_settler(&settler);
    assert!(client.is_settler(&settler));

    client.remove_settler(&settler);
    assert!(!client.is_settler(&settler));
}

#[test]
fn add_settler_before_admin_set_fails() {
    let (env, _creator, client) = setup();
    let settler = Address::generate(&env);
    let res = client.try_add_settler(&settler);
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn is_settler_false_for_unknown_address() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let stranger = Address::generate(&env);
    assert!(!client.is_settler(&stranger));
}

#[test]
fn record_payment_creates_escrowed_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr0");

    client.record_payment(
        &settler,
        &String::from_str(&env, "rcpt1"),
        &id,
        &creator,
        &1_000_000i128,
        &String::from_str(&env, "0xtxhash1"),
    );

    let receipt = client.get_payment(&String::from_str(&env, "rcpt1"));
    assert_eq!(receipt.receipt_id, String::from_str(&env, "rcpt1"));
    assert_eq!(receipt.resource_id, id);
    assert_eq!(receipt.payer, creator);
    assert_eq!(receipt.amount, 1_000_000i128);
    assert_eq!(receipt.state, PaymentState::Escrowed);
    assert_eq!(receipt.tx_hash, String::from_str(&env, "0xtxhash1"));
    assert_eq!(receipt.recorded_at, env.ledger().sequence());
}

#[test]
fn anchor_purchase_receipt_round_trip_and_rejects_duplicates() {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    let service = Address::generate(&env);
    let buyer = Address::generate(&env);
    let id = String::from_str(&env, "anchorrt");
    let hash = String::from_str(&env, "sha256receipt");

    client.nominate_new_admin(&admin);
    client.add_verifier(&service);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://anchor"),
        &empty_tags(&env),
    );

    env.ledger().set_sequence_number(888);
    client.anchor_purchase_receipt(&service, &id, &buyer, &hash);

    let anchor = client.get_purchase_receipt(&id, &buyer);
    assert_eq!(anchor.resource_id, id);
    assert_eq!(anchor.buyer, buyer);
    assert_eq!(anchor.receipt_hash, hash);
    assert_eq!(anchor.ledger, 888);

    assert_eq!(
        client.try_anchor_purchase_receipt(
            &service,
            &String::from_str(&env, "anchorrt"),
            &anchor.buyer,
            &String::from_str(&env, "sha256other")
        ),
        Err(Ok(Error::DuplicateReceipt))
    );
}

#[test]
fn anchor_purchase_receipt_requires_verifier_role() {
    let (env, creator, client) = setup();
    let service = Address::generate(&env);
    let buyer = Address::generate(&env);
    let id = String::from_str(&env, "anchorrole");

    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://anchor"),
        &empty_tags(&env),
    );

    assert_eq!(
        client.try_anchor_purchase_receipt(
            &service,
            &id,
            &buyer,
            &String::from_str(&env, "sha256receipt")
        ),
        Err(Ok(Error::NotVerifier))
    );
}

/// record_payment stamps ledger from the ledger sequence at call time.
#[test]
fn record_payment_stamps_ledger_sequence() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payreclgr");

    env.ledger().set_sequence_number(777);
    let payer = Address::generate(&env);
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptlgr"),
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "txhash777"),
    );

    let receipt = client.get_payment_receipt(&id, &payer);
    assert_eq!(
        receipt.ledger, 777,
        "ledger must reflect env sequence at record time"
    );
}

/// Recording a second payment for the same (resource_id, payer) pair
/// overwrites the first — the stored value always reflects the most recent.
#[test]
fn record_payment_overwrites_previous_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecow");

    let payer = Address::generate(&env);

    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptow1"),
        &id,
        &payer,
        &500i128,
        &String::from_str(&env, "firsttx"),
    );
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptow2"),
        &id,
        &payer,
        &750i128,
        &String::from_str(&env, "secondtx"),
    );

    let latest = client.get_payment_receipt(&id, &payer);
    assert_eq!(latest.receipt_id, String::from_str(&env, "rcptow2"));
    assert_eq!(latest.tx_hash, String::from_str(&env, "secondtx"));
    assert_eq!(latest.amount, 750i128);
}

#[test]
fn record_payment_index_tracks_most_recent_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecix");
    let payer = Address::generate(&env);

    let first = String::from_str(&env, "rcptix1");
    let second = String::from_str(&env, "rcptix2");
    client.record_payment(
        &settler,
        &first,
        &id,
        &payer,
        &500i128,
        &String::from_str(&env, "first_tx"),
    );
    client.record_payment(
        &settler,
        &second,
        &id,
        &payer,
        &750i128,
        &String::from_str(&env, "second_tx"),
    );

    // Both receipts remain individually addressable, while the pair index points at the latest.
    assert_eq!(client.get_payment(&first).amount, 500i128);
    assert_eq!(client.get_payment(&second).amount, 750i128);
    let latest = client.get_payment_receipt(&id, &payer);
    assert_eq!(latest.receipt_id, second);
    assert_eq!(latest.amount, 750i128);
}

#[test]
fn record_payment_duplicate_receipt_id_fails() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr3");
    let receipt_id = String::from_str(&env, "rcpt4");

    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &creator,
        &1_000_000i128,
        &String::from_str(&env, "0xtx4"),
    );

    let res = client.try_record_payment(
        &settler,
        &receipt_id,
        &id,
        &creator,
        &1_000_000i128,
        &String::from_str(&env, "0xtx4b"),
    );
    assert_eq!(res, Err(Ok(Error::ReceiptAlreadyExists)));
}

#[test]
fn record_payment_nonexistent_resource_fails() {
    let (env, _creator, _admin, settler, client) = setup_with_settler();
    let missing = String::from_str(&env, "nosuchresource");
    let payer = Address::generate(&env);

    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptmissing"),
        &missing,
        &payer,
        &100i128,
        &String::from_str(&env, "txhash"),
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn non_settler_cannot_record_payment() {
    let (env, creator, _admin, _settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr4");
    let stranger = Address::generate(&env);

    let res = client.try_record_payment(
        &stranger,
        &String::from_str(&env, "rcpt6"),
        &id,
        &creator,
        &1_000_000i128,
        &String::from_str(&env, "0xtx6"),
    );
    assert_eq!(res, Err(Ok(Error::NotSettler)));
}

#[test]
fn non_settler_cannot_settle_payment() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr5");
    let receipt_id = String::from_str(&env, "rcpt7");

    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &creator,
        &1_000_000i128,
        &String::from_str(&env, "0xtx7"),
    );

    let stranger = Address::generate(&env);
    let res = client.try_settle_payment(&stranger, &receipt_id);
    assert_eq!(res, Err(Ok(Error::NotSettler)));
    // Receipt state must not have changed.
    assert_eq!(client.get_payment(&receipt_id).state, PaymentState::Escrowed);
}

#[test]
fn settle_payment_transitions_receipt_to_settled() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrectrs");
    let receipt_id = String::from_str(&env, "rcpttrs1");

    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &creator,
        &123_456i128,
        &String::from_str(&env, "0xtxtrs"),
    );

    let before = client.get_payment(&receipt_id);
    assert_eq!(before.state, PaymentState::Escrowed);

    client.settle_payment(&settler, &receipt_id);

    let after = client.get_payment(&receipt_id);
    assert_eq!(after.state, PaymentState::Settled);
    assert_eq!(after.receipt_id, before.receipt_id);
    assert_eq!(after.resource_id, before.resource_id);
    assert_eq!(after.payer, before.payer);
    assert_eq!(after.amount, before.amount);
    assert_eq!(after.tx_hash, before.tx_hash);
    assert_eq!(after.recorded_at, before.recorded_at);
    assert_eq!(after.ledger, before.ledger);
}

#[test]
fn creator_can_record_partial_refund_to_original_payer() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "refund01");
    let payer = Address::generate(&env);
    let payment_id = String::from_str(&env, "refundpay1");
    let refund_id = String::from_str(&env, "refundrec1");

    client.record_payment(
        &settler,
        &payment_id,
        &id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "paymenttx1"),
    );
    client.settle_payment(&settler, &payment_id);
    client.record_creator_refund(
        &creator,
        &refund_id,
        &payment_id,
        &payer,
        &400_000i128,
        &String::from_str(&env, "refundtx1"),
    );

    let refund = client.get_refund(&refund_id);
    assert_eq!(refund.payment_receipt_id, payment_id);
    assert_eq!(refund.resource_id, id);
    assert_eq!(refund.recipient, payer);
    assert_eq!(refund.amount, 400_000i128);
    assert_eq!(refund.initiated_by, creator);
    assert!(!refund.admin_override);
    assert_eq!(client.get_refunded_amount(&payment_id), 400_000i128);
}

#[test]
fn refund_authority_stays_with_creator_who_received_payment() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "refundown");
    let payer = Address::generate(&env);
    let new_creator = Address::generate(&env);
    let payment_id = String::from_str(&env, "refundpayown");

    client.record_payment(
        &settler,
        &payment_id,
        &id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "paymenttxown"),
    );
    client.settle_payment(&settler, &payment_id);
    client.transfer_ownership(&id, &new_creator);

    assert_eq!(
        client.try_record_creator_refund(
            &new_creator,
            &String::from_str(&env, "refundnewown"),
            &payment_id,
            &payer,
            &100i128,
            &String::from_str(&env, "refundtxown1"),
        ),
        Err(Ok(Error::Unauthorized))
    );
    client.record_creator_refund(
        &creator,
        &String::from_str(&env, "refundoldown"),
        &payment_id,
        &payer,
        &100i128,
        &String::from_str(&env, "refundtxown2"),
    );
}

#[test]
fn refunds_require_settled_payment_payer_and_remaining_amount() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "refund02");
    let payer = Address::generate(&env);
    let wrong_recipient = Address::generate(&env);
    let payment_id = String::from_str(&env, "refundpay2");

    client.record_payment(
        &settler,
        &payment_id,
        &id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "paymenttx2"),
    );
    assert_eq!(
        client.try_record_creator_refund(
            &creator,
            &String::from_str(&env, "refundrec2a"),
            &payment_id,
            &payer,
            &100i128,
            &String::from_str(&env, "refundtx2a"),
        ),
        Err(Ok(Error::InvalidPaymentTransition))
    );

    client.settle_payment(&settler, &payment_id);
    assert_eq!(
        client.try_record_creator_refund(
            &creator,
            &String::from_str(&env, "refundrec2b"),
            &payment_id,
            &wrong_recipient,
            &100i128,
            &String::from_str(&env, "refundtx2b"),
        ),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_record_creator_refund(
            &creator,
            &String::from_str(&env, "refundrec2c"),
            &payment_id,
            &payer,
            &1_000_001i128,
            &String::from_str(&env, "refundtx2c"),
        ),
        Err(Ok(Error::PaymentAmountMismatch))
    );

    client.record_creator_refund(
        &creator,
        &String::from_str(&env, "refundrec2d"),
        &payment_id,
        &payer,
        &600_000i128,
        &String::from_str(&env, "refundtx2d"),
    );
    assert_eq!(
        client.try_record_creator_refund(
            &creator,
            &String::from_str(&env, "refundrec2e"),
            &payment_id,
            &payer,
            &400_001i128,
            &String::from_str(&env, "refundtx2e"),
        ),
        Err(Ok(Error::PaymentAmountMismatch))
    );
    assert_eq!(client.get_refunded_amount(&payment_id), 600_000i128);
}

#[test]
fn refund_deadline_is_snapshotted_and_admin_can_override_expiry() {
    let (env, creator, admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "refund03");
    let payer = Address::generate(&env);
    let payment_id = String::from_str(&env, "refundpay3");
    client.set_refund_window(&admin, &2u32);
    client.record_payment(
        &settler,
        &payment_id,
        &id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "paymenttx3"),
    );
    client.settle_payment(&settler, &payment_id);
    let deadline = client.get_refund_deadline(&payment_id);

    client.set_refund_window(&admin, &100u32);
    assert_eq!(client.get_refund_deadline(&payment_id), deadline);
    env.ledger().set_sequence_number(deadline);
    assert_eq!(
        client.try_record_creator_refund(
            &creator,
            &String::from_str(&env, "refundrec3a"),
            &payment_id,
            &payer,
            &1_000_000i128,
            &String::from_str(&env, "refundtx3a"),
        ),
        Err(Ok(Error::InvalidPaymentTransition))
    );

    client.record_admin_refund(
        &admin,
        &String::from_str(&env, "refundrec3b"),
        &payment_id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "refundtx3b"),
    );
    assert!(client.get_refund(&String::from_str(&env, "refundrec3b")).admin_override);
}

#[test]
fn settle_payment_missing_receipt_fails() {
    let (env, _creator, _admin, settler, client) = setup_with_settler();
    let receipt_id = String::from_str(&env, "nosuchrcpt");

    let res = client.try_settle_payment(&settler, &receipt_id);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn settle_payment_sets_ttl_on_write() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecttlsw");
    let receipt_id = String::from_str(&env, "rcptttlsw");
    let payer = Address::generate(&env);

    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "tx"),
    );

    let decay: u32 = TTL_DAY_IN_LEDGERS + 100;
    env.ledger().set_sequence_number(env.ledger().sequence() + decay);

    assert_eq!(
        payment_receipt_ttl(&env, &client.address, &receipt_id),
        TTL_BUMP_AMOUNT - decay,
        "TTL should have decayed"
    );

    client.settle_payment(&settler, &receipt_id);

    assert_eq!(
        payment_receipt_ttl(&env, &client.address, &receipt_id),
        TTL_BUMP_AMOUNT,
        "settle_payment must set TTL to BUMP_AMOUNT"
    );
}

#[test]
fn settle_payment_twice_fails() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrectw");
    let receipt_id = String::from_str(&env, "rcpttw1");

    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &creator,
        &100i128,
        &String::from_str(&env, "0xtxtw"),
    );
    client.settle_payment(&settler, &receipt_id);
    assert_eq!(client.get_payment(&receipt_id).state, PaymentState::Settled);

    let res = client.try_settle_payment(&settler, &receipt_id);
    assert_eq!(res, Err(Ok(Error::InvalidPaymentTransition)));
}

#[test]
fn revoked_settler_cannot_record_payment() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr6");
    client.remove_settler(&settler);

    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcpt8"),
        &id,
        &creator,
        &1_000_000i128,
        &String::from_str(&env, "0xtx8"),
    );
    assert_eq!(res, Err(Ok(Error::NotSettler)));
}

#[test]
fn get_payment_missing_fails() {
    let (env, _creator, client) = setup();
    let res = client.try_get_payment(&String::from_str(&env, "nosuchreceipt"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn record_payment_empty_tx_hash_fails() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr7");
    let payer = Address::generate(&env);
    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptbadtx"),
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, ""),
    );
    assert_eq!(res, Err(Ok(Error::InvalidTxHash)));
}

#[test]
fn record_payment_empty_receipt_id_fails() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr9");
    let payer = Address::generate(&env);
    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, ""),
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "txhashempty"),
    );
    assert_eq!(res, Err(Ok(Error::InvalidReceiptId)));
}

/// record_payment accepts a tx_hash exactly at MAX_TX_HASH_LEN.
#[test]
fn record_payment_accepts_tx_hash_at_max_length() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecmaxh");
    let payer = Address::generate(&env);
    let max_hash = String::from_str(&env, &"a".repeat(MAX_TX_HASH_LEN as usize));
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptmaxh"),
        &id,
        &payer,
        &100i128,
        &max_hash,
    );
    assert_eq!(client.get_payment_receipt(&id, &payer).tx_hash, max_hash);
}

/// record_payment errors InvalidPaymentAmount when amount is zero.
#[test]
fn record_payment_rejects_zero_amount() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecbadamt1");
    let payer = Address::generate(&env);
    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptzero"),
        &id,
        &payer,
        &0i128,
        &String::from_str(&env, "txhash"),
    );
    assert_eq!(res, Err(Ok(Error::InvalidPaymentAmount)));
}

#[test]
fn record_payment_rejects_negative_amount() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrneg");
    let payer = Address::generate(&env);
    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptneg"),
        &id,
        &payer,
        &-1i128,
        &String::from_str(&env, "txhash"),
    );
    assert_eq!(res, Err(Ok(Error::InvalidPaymentAmount)));
}

#[test]
fn record_payment_emits_payment_event() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr10");
    let receipt_id = String::from_str(&env, "rcptevt1");
    let tx_hash = String::from_str(&env, "0xtxevt1");

    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &creator,
        &2_000_000i128,
        &tx_hash,
    );
    let all = env.events().all();
    let (_cid, topics, data) = all.get_unchecked(all.len() - 1);
    let t0: Symbol =
        <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
            .ok()
            .unwrap();
    assert_eq!(t0, Symbol::new(&env, "payment"));
    let topic_receipt_id: String =
        <String as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(1).unwrap())
            .ok()
            .unwrap();
    assert_eq!(topic_receipt_id, receipt_id);

    let decoded: PaymentReceipt =
        <PaymentReceipt as TryFromVal<Env, Val>>::try_from_val(&env, &data)
            .ok()
            .unwrap();
    assert_eq!(decoded.resource_id, id);
    assert_eq!(decoded.payer, creator);
    assert_eq!(decoded.amount, 2_000_000i128);
    assert_eq!(decoded.tx_hash, tx_hash);
}

#[test]
fn settle_payment_emits_settle_event() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr11");
    let receipt_id = String::from_str(&env, "rcptevt2");

    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &creator,
        &3_000_000i128,
        &String::from_str(&env, "0xtxevt2"),
    );
    client.settle_payment(&settler, &receipt_id);

    let all = env.events().all();
    let (_cid, topics, data) = all.get_unchecked(all.len() - 1);
    let t0: Symbol =
        <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
            .ok()
            .unwrap();
    assert_eq!(t0, Symbol::new(&env, "settle"));

    let decoded: PaymentReceipt =
        <PaymentReceipt as TryFromVal<Env, Val>>::try_from_val(&env, &data)
            .ok()
            .unwrap();
    assert_eq!(decoded.state, PaymentState::Settled);
}

/// Failed record_payment calls leave no receipt behind.
#[test]
fn failed_record_payment_does_not_store_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecfailstore");
    let payer = Address::generate(&env);
    let receipt_id = String::from_str(&env, "rcptfail");

    // Attempt with zero amount — should fail
    let _ = client.try_record_payment(
        &settler,
        &receipt_id,
        &id,
        &payer,
        &0i128,
        &String::from_str(&env, "txhash"),
    );

    // No receipt should be stored
    assert_eq!(client.try_get_payment(&receipt_id), Err(Ok(Error::NotFound)));
    assert_eq!(
        client.try_get_payment_receipt(&id, &payer),
        Err(Ok(Error::NotFound)),
        "a failed record_payment must not persist a receipt"
    );
}

/// record_payment bumps the receipt entry's TTL on write.
#[test]
fn record_payment_sets_ttl_on_write() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecttlw");
    let payer = Address::generate(&env);
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptttlw"),
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "tx"),
    );

    assert_eq!(
        payment_receipt_ttl(&env, &client.address, &String::from_str(&env, "rcptttlw")),
        TTL_BUMP_AMOUNT,
        "record_payment must set TTL to BUMP_AMOUNT"
    );
}

/// get_payment_receipt bumps the receipt entry's TTL on a successful read.
#[test]
fn get_payment_receipt_bumps_ttl_on_read() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecttlr");
    let payer = Address::generate(&env);
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptttlr"),
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "tx"),
    );

    // Decay past LIFETIME_THRESHOLD so extend_ttl fires.
    let decay: u32 = TTL_DAY_IN_LEDGERS + 100;
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + decay);

    assert_eq!(
        payment_receipt_ttl(&env, &client.address, &String::from_str(&env, "rcptttlr")),
        TTL_BUMP_AMOUNT - decay,
        "TTL should have decayed before the read"
    );

    client.get_payment_receipt(&id, &payer);

    assert_eq!(
        payment_receipt_ttl(&env, &client.address, &String::from_str(&env, "rcptttlr")),
        TTL_BUMP_AMOUNT,
        "get_payment_receipt must bump TTL back to BUMP_AMOUNT"
    );
}

/// record_payment does not affect existing Resource fields — all registry
/// reads on the resource return the same values before and after.
#[test]
fn record_payment_does_not_mutate_resource() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr12");
    let before = client.get(&id);

    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptmut"),
        &id,
        &creator,
        &1_000_000i128,
        &String::from_str(&env, "0xtxmut"),
    );

    let after = client.get(&id);

    assert_eq!(
        before, after,
        "record_payment must not mutate the Resource entry"
    );
    assert_eq!(
        client.count(),
        1,
        "record_payment must not change the resource count"
    );
    assert_eq!(
        client.list(&0u32, &10u32).get(0).unwrap().id,
        id,
        "record_payment must not affect catalog order"
    );
}

/// Payment receipt amount must match the resource's current price.
/// This test locks down the amount consistency invariant:
/// - VALID: amount == resource.price → succeeds
/// - INVALID: amount != resource.price → PaymentAmountMismatch
#[test]
fn record_payment_amount_must_match_resource_price() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    
    // Register a resource with price 1_000_000 stroops (0.10 USDC)
    let id = String::from_str(&env, "payrecpricematch");
    client.register(
        &creator,
        &id,
        &1_000_000i128,
        &String::from_str(&env, "ipfs://test"),
        &empty_tags(&env),
    );
    
    let resource = client.get(&id);
    assert_eq!(resource.price, 1_000_000i128);

    // VALID CASE: amount matches resource price
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptvalid"),
        &id,
        &creator,
        &1_000_000i128, // matches resource.price
        &String::from_str(&env, "txhashvalid"),
    );
    
    let receipt = client.get_payment(&String::from_str(&env, "rcptvalid"));
    assert_eq!(receipt.amount, 1_000_000i128);
    assert_eq!(receipt.resource_id, id);
    assert_eq!(receipt.state, PaymentState::Escrowed);

    // INVALID CASE: amount does NOT match resource price (too low)
    let res_low = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptlow"),
        &id,
        &creator,
        &500_000i128, // does not match resource.price
        &String::from_str(&env, "txhashlow"),
    );
    assert_eq!(res_low, Err(Ok(Error::PaymentAmountMismatch)));

    // INVALID CASE: amount does NOT match resource price (too high)
    let res_high = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcpthigh"),
        &id,
        &creator,
        &2_000_000i128, // does not match resource.price
        &String::from_str(&env, "txhashhigh"),
    );
    assert_eq!(res_high, Err(Ok(Error::PaymentAmountMismatch)));
    
    // Verify that failed attempts didn't create receipts
    assert_eq!(
        client.try_get_payment(&String::from_str(&env, "rcptlow")),
        Err(Ok(Error::NotFound)),
        "rejected payment must not persist a receipt"
    );
    assert_eq!(
        client.try_get_payment(&String::from_str(&env, "rcpthigh")),
        Err(Ok(Error::NotFound)),
        "rejected payment must not persist a receipt"
    );
}
