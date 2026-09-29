// ─── Retry-safe payment recording (#823) ────────────────────────────────────
//
// `record_payment` rejects a second call with the same `receipt_id` as
// `ReceiptAlreadyExists`, which keeps receipts unique but makes an off-chain
// retry (a timed-out submission, a facilitator restart) look like a failure.
// `record_payment_idempotent` applies the same checks and returns the stored
// receipt when the retry carries the same arguments, so a caller can resubmit
// without first reading `get_payment`. These tests pin both halves: a true
// retry is a no-op that returns the original receipt, and anything that is
// not a retry is still rejected.

const IDEMPOTENT_PRICE: i128 = 100;

fn idem_str(env: &Env, value: &str) -> String {
    String::from_str(env, value)
}

/// Topic-0 symbols of the events emitted by the most recent invocation.
fn last_call_topics(env: &Env) -> std::vec::Vec<std::string::String> {
    let mut out = std::vec::Vec::new();
    let all = env.events().all();
    for i in 0..all.len() {
        let (_, topics, _) = all.get(i).unwrap();
        if let Some(sym) = topic0_symbol(env, &topics) {
            out.push(sym.to_string());
        }
    }
    out
}

#[test]
fn record_payment_idempotent_records_a_new_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemnew");
    let payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-rcpt-1");
    let tx_hash = idem_str(&env, "0xidemtx1");

    let receipt = client.record_payment_idempotent(
        &settler,
        &receipt_id,
        &id,
        &payer,
        &IDEMPOTENT_PRICE,
        &tx_hash,
    );

    assert_eq!(last_call_topics(&env), ["payment"]);
    assert_eq!(receipt.receipt_id, receipt_id);
    assert_eq!(receipt.resource_id, id);
    assert_eq!(receipt.payer, payer);
    assert_eq!(receipt.amount, IDEMPOTENT_PRICE);
    assert_eq!(receipt.state, PaymentState::Escrowed);
    assert_eq!(receipt.tx_hash, tx_hash);
    assert_eq!(receipt.recorded_at, env.ledger().sequence());
    assert_eq!(client.get_payment(&receipt_id), receipt);
    assert_eq!(client.get_payment_receipt(&id, &payer), receipt);
}

#[test]
fn record_payment_idempotent_requires_settler_and_payer_auth() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemauth");
    let payer = Address::generate(&env);

    client.record_payment_idempotent(
        &settler,
        &idem_str(&env, "idem-auth"),
        &id,
        &payer,
        &IDEMPOTENT_PRICE,
        &idem_str(&env, "0xidemauth"),
    );

    let signers: std::vec::Vec<Address> = env.auths().into_iter().map(|(a, _)| a).collect();
    assert!(signers.contains(&settler), "settler must authorize");
    assert!(signers.contains(&payer), "payer must authorize");
}

#[test]
fn retry_with_identical_arguments_returns_the_stored_receipt_without_writing() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemretry");
    let payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-retry");
    let tx_hash = idem_str(&env, "0xidemretry");

    let first =
        client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    env.ledger().with_mut(|li| li.sequence_number += 10);

    let retried =
        client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);

    assert_eq!(retried, first, "a retry must return the original receipt");
    assert_eq!(
        last_call_topics(&env),
        std::vec::Vec::<std::string::String>::new(),
        "a retry must not emit a second payment event"
    );
    assert_eq!(client.get_payment(&receipt_id), first);
    assert_eq!(client.get_payment(&receipt_id).recorded_at, first.recorded_at);
}

#[test]
fn retry_after_a_plain_record_payment_returns_that_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemplain");
    let payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-plain");
    let tx_hash = idem_str(&env, "0xidemplain");

    client.record_payment(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    let stored = client.get_payment(&receipt_id);

    let retried =
        client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    assert_eq!(retried, stored);
}

#[test]
fn plain_record_payment_still_rejects_a_duplicate_id() {
    // The strict entry point keeps its contract: only the idempotent variant
    // treats a repeated receipt id as a retry.
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemstrict");
    let payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-strict");
    let tx_hash = idem_str(&env, "0xidemstrict");

    client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);

    assert_eq!(
        client.try_record_payment(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash),
        Err(Ok(Error::ReceiptAlreadyExists))
    );
}

#[test]
fn retry_of_a_settled_receipt_returns_it_settled() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemsettled");
    let payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-settled");
    let tx_hash = idem_str(&env, "0xidemsettled");

    client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    client.settle_payment(&settler, &receipt_id);

    let retried =
        client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    assert_eq!(retried.state, PaymentState::Settled);
    assert_eq!(client.get_payment(&receipt_id).state, PaymentState::Settled);
}

#[test]
fn retry_after_a_price_change_returns_the_stored_receipt() {
    // The receipt matched the price when it was recorded. A later price change
    // must not turn a retry of that payment into `PaymentAmountMismatch`.
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemreprice");
    let payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-reprice");
    let tx_hash = idem_str(&env, "0xidemreprice");

    let first =
        client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    client.set_price(&id, &(IDEMPOTENT_PRICE * 2));

    let retried =
        client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    assert_eq!(retried, first);
}

#[test]
fn same_receipt_id_with_different_arguments_is_rejected() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemconflict");
    let other_id = register_default(&env, &creator, &client, "idemconflict2");
    let payer = Address::generate(&env);
    let other_payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-conflict");
    let tx_hash = idem_str(&env, "0xidemconflict");

    let first =
        client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    client.set_price(&id, &(IDEMPOTENT_PRICE * 2));

    let conflicts = [
        (other_id.clone(), payer.clone(), IDEMPOTENT_PRICE, tx_hash.clone()),
        (id.clone(), other_payer, IDEMPOTENT_PRICE, tx_hash.clone()),
        (id.clone(), payer.clone(), IDEMPOTENT_PRICE * 2, tx_hash.clone()),
        (id.clone(), payer.clone(), IDEMPOTENT_PRICE, idem_str(&env, "0xother")),
    ];
    for (resource_id, who, amount, hash) in conflicts.iter() {
        assert_eq!(
            client.try_record_payment_idempotent(&settler, &receipt_id, resource_id, who, amount, hash),
            Err(Ok(Error::ReceiptAlreadyExists)),
            "a receipt id reused with different arguments is not a retry"
        );
    }
    assert_eq!(client.get_payment(&receipt_id), first);
}

#[test]
fn new_receipt_id_reusing_a_tx_hash_is_rejected() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemtxhash");
    let payer = Address::generate(&env);
    let tx_hash = idem_str(&env, "0xidemshared");

    client.record_payment_idempotent(
        &settler,
        &idem_str(&env, "idem-tx-a"),
        &id,
        &payer,
        &IDEMPOTENT_PRICE,
        &tx_hash,
    );

    assert_eq!(
        client.try_record_payment_idempotent(
            &settler,
            &idem_str(&env, "idem-tx-b"),
            &id,
            &payer,
            &IDEMPOTENT_PRICE,
            &tx_hash,
        ),
        Err(Ok(Error::DuplicateTxHash))
    );
    assert_eq!(
        client.try_get_payment(&idem_str(&env, "idem-tx-b")),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn record_payment_idempotent_keeps_record_payment_validation() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idemvalid");
    let payer = Address::generate(&env);
    let stranger = Address::generate(&env);
    let tx_hash = idem_str(&env, "0xidemvalid");
    let receipt_id = idem_str(&env, "idem-valid");

    let cases = [
        (
            stranger,
            receipt_id.clone(),
            id.clone(),
            IDEMPOTENT_PRICE,
            tx_hash.clone(),
            Error::NotSettler,
        ),
        (
            settler.clone(),
            idem_str(&env, ""),
            id.clone(),
            IDEMPOTENT_PRICE,
            tx_hash.clone(),
            Error::InvalidReceiptId,
        ),
        (
            settler.clone(),
            receipt_id.clone(),
            idem_str(&env, "idemnosuch"),
            IDEMPOTENT_PRICE,
            tx_hash.clone(),
            Error::NotFound,
        ),
        (
            settler.clone(),
            receipt_id.clone(),
            id.clone(),
            0,
            tx_hash.clone(),
            Error::InvalidPaymentAmount,
        ),
        (
            settler.clone(),
            receipt_id.clone(),
            id.clone(),
            IDEMPOTENT_PRICE + 1,
            tx_hash.clone(),
            Error::PaymentAmountMismatch,
        ),
        (
            settler.clone(),
            receipt_id.clone(),
            id.clone(),
            IDEMPOTENT_PRICE,
            idem_str(&env, ""),
            Error::InvalidTxHash,
        ),
    ];
    for (caller, rid, resource_id, amount, hash, expected) in cases.iter() {
        assert_eq!(
            client.try_record_payment_idempotent(caller, rid, resource_id, &payer, amount, hash),
            Err(Ok(*expected))
        );
    }
    assert_eq!(client.try_get_payment(&receipt_id), Err(Ok(Error::NotFound)));
}

#[test]
fn record_payment_idempotent_is_blocked_while_paused() {
    // Pause blocks every state-changing entry point, and this is one even when
    // the call turns out to be a retry.
    let (env, creator, admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "idempaused");
    let payer = Address::generate(&env);
    let receipt_id = idem_str(&env, "idem-paused");
    let tx_hash = idem_str(&env, "0xidempaused");

    client.record_payment_idempotent(&settler, &receipt_id, &id, &payer, &IDEMPOTENT_PRICE, &tx_hash);
    client.set_paused(&admin, &true);

    assert_eq!(
        client.try_record_payment_idempotent(
            &settler,
            &receipt_id,
            &id,
            &payer,
            &IDEMPOTENT_PRICE,
            &tx_hash,
        ),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_record_payment_idempotent(
            &settler,
            &idem_str(&env, "idem-paused-2"),
            &id,
            &payer,
            &IDEMPOTENT_PRICE,
            &idem_str(&env, "0xidempaused2"),
        ),
        Err(Ok(Error::ContractPaused))
    );
}
