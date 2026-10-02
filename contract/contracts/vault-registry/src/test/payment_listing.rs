// ─── record_payment requires a listed resource (#791) ────────────────────────

fn try_record(
    env: &Env,
    client: &VaultRegistryClient,
    settler: &Address,
    payer: &Address,
    id: &String,
    receipt: &str,
    tx: &str,
) -> Result<Result<(), soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>> {
    client.try_record_payment(
        settler,
        &String::from_str(env, receipt),
        id,
        payer,
        &100i128,
        &String::from_str(env, tx),
    )
}

#[test]
fn record_payment_rejects_frozen_and_delisted_resources() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payfrozen");
    let payer = Address::generate(&env);

    client.freeze_resource(&id);
    assert_eq!(
        try_record(&env, &client, &settler, &payer, &id, "rcptfz1", "0xfz1"),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_get_payment(&String::from_str(&env, "rcptfz1")),
        Err(Ok(Error::NotFound))
    );

    client.reactivate_resource(&id);
    client.delist(&id);
    assert_eq!(
        try_record(&env, &client, &settler, &payer, &id, "rcptdl1", "0xdl1"),
        Err(Ok(Error::ResourceNotMutable))
    );

    // Relisted: payments flow again.
    client.set_listed(&id, &true);
    assert!(try_record(&env, &client, &settler, &payer, &id, "rcptok1", "0xok1").is_ok());
    assert_eq!(
        client.get_payment(&String::from_str(&env, "rcptok1")).state,
        PaymentState::Escrowed
    );
}

#[test]
fn record_payment_rejects_disputed_and_tombstoned_resources() {
    let (env, creator, admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "paydisp");
    let payer = Address::generate(&env);

    client.open_dispute(&id, &admin);
    assert_eq!(
        try_record(&env, &client, &settler, &payer, &id, "rcptdp1", "0xdp1"),
        Err(Ok(Error::ResourceNotMutable))
    );
    client.resolve_dispute(&id, &admin, &ResourceState::Listed);
    assert!(try_record(&env, &client, &settler, &payer, &id, "rcptdp2", "0xdp2").is_ok());

    client.tombstone_resource(&id, &admin);
    assert_eq!(
        try_record(&env, &client, &settler, &payer, &id, "rcptdp3", "0xdp3"),
        Err(Ok(Error::ResourceNotMutable))
    );
}

#[test]
fn listed_check_runs_after_not_found_and_before_price_mismatch() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payorder");
    let payer = Address::generate(&env);
    client.freeze_resource(&id);

    // A wrong amount on a frozen resource reports the state, not the price.
    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptord1"),
        &id,
        &payer,
        &999i128,
        &String::from_str(&env, "0xord1"),
    );
    assert_eq!(res, Err(Ok(Error::ResourceNotMutable)));

    // An unknown resource still reports NotFound first.
    assert_eq!(
        try_record(
            &env,
            &client,
            &settler,
            &payer,
            &String::from_str(&env, "nosuchpay"),
            "rcptord2",
            "0xord2"
        ),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn idempotent_retry_of_a_recorded_receipt_survives_a_later_freeze() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payretry");
    let payer = Address::generate(&env);
    let receipt = String::from_str(&env, "rcptrt1");
    let tx = String::from_str(&env, "0xrt1");

    let first = client.record_payment_idempotent(&settler, &receipt, &id, &payer, &100i128, &tx);
    client.freeze_resource(&id);

    // The stored receipt is returned unchanged; only new receipts are gated.
    let again = client.record_payment_idempotent(&settler, &receipt, &id, &payer, &100i128, &tx);
    assert_eq!(again, first);
    assert_eq!(
        client.try_record_payment_idempotent(
            &settler,
            &String::from_str(&env, "rcptrt2"),
            &id,
            &payer,
            &100i128,
            &String::from_str(&env, "0xrt2"),
        ),
        Err(Ok(Error::ResourceNotMutable))
    );
}
