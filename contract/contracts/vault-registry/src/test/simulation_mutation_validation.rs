// ─── Simulation and Mutation Validation (#1017) ────────────────────────────
//
// Acceptance criteria (from issue):
//   • Shared tests compare simulation results with submitted mutations across
//     valid, invalid, and authorization cases.
//   • Update focused tests and relevant MCP/contract documentation.
//   • Keep changes bounded to the stated behavior and preserve existing client
//     compatibility where applicable.

fn setup_with_settlement<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, admin, client) = setup_with_admin();
    let settler = Address::generate(&env);
    client.add_settler(&settler);
    (env, creator, admin, settler, client)
}

// ── Simulation succeeds for valid payments ──────────────────────────────────

#[test]
fn simulate_record_payment_succeeds_for_valid_inputs() {
    let (env, creator, _admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres0");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    let result = client.simulate_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );

    assert!(result.is_ok());
    let receipt = result.unwrap();
    assert_eq!(receipt.receipt_id, String::from_str(&env, "receipt1"));
    assert_eq!(receipt.resource_id, resource_id);
    assert_eq!(receipt.payer, payer);
    assert_eq!(receipt.amount, amount);
}

// ── Simulation fails for invalid inputs matching mutation behavior ──────────

#[test]
fn simulate_record_payment_fails_for_invalid_resource() {
    let (env, _creator, _admin, settler, client) = setup_with_settlement();
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    let sim_result = client.try_simulate_record_payment(
        &settler,
        "receipt1",
        "invalid@resource",
        &payer,
        &amount,
        &"txhash1",
    );

    let mut_result = client.try_record_payment(
        &settler,
        "receipt2",
        "invalid@resource",
        &payer,
        &amount,
        &"txhash2",
    );

    // Both should fail with the same error
    assert_eq!(sim_result, Err(Ok(Error::InvalidResourceId)));
    assert_eq!(mut_result, Err(Ok(Error::InvalidResourceId)));
}

#[test]
fn simulate_record_payment_fails_for_invalid_payment_amount() {
    let (env, creator, _admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres1");
    let payer = Address::generate(&env);

    let sim_result = client.try_simulate_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &-100i128,
        &"txhash1",
    );

    let mut_result = client.try_record_payment(
        &settler,
        "receipt2",
        &resource_id,
        &payer,
        &-100i128,
        &"txhash2",
    );

    // Both should fail with the same error
    assert_eq!(sim_result, Err(Ok(Error::InvalidPaymentAmount)));
    assert_eq!(mut_result, Err(Ok(Error::InvalidPaymentAmount)));
}

// ── Simulation respects pause state like mutations ───────────────────────────

#[test]
fn simulate_record_payment_fails_when_paused_like_mutation() {
    let (env, creator, admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres2");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    // Pause contract
    client.set_paused(&admin, &true);

    let sim_result = client.try_simulate_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );

    let mut_result = client.try_record_payment(
        &settler,
        "receipt2",
        &resource_id,
        &payer,
        &amount,
        &"txhash2",
    );

    // Both should fail with ContractPaused
    assert_eq!(sim_result, Err(Ok(Error::ContractPaused)));
    assert_eq!(mut_result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn simulate_record_payment_fails_when_payment_paused_like_mutation() {
    let (env, creator, admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres3");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    // Pause only payments
    client.set_payment_paused(&admin, &true);

    let sim_result = client.try_simulate_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );

    let mut_result = client.try_record_payment(
        &settler,
        "receipt2",
        &resource_id,
        &payer,
        &amount,
        &"txhash2",
    );

    // Both should fail with ContractPaused
    assert_eq!(sim_result, Err(Ok(Error::ContractPaused)));
    assert_eq!(mut_result, Err(Ok(Error::ContractPaused)));
}

// ── Simulation does not modify state ────────────────────────────────────────

#[test]
fn simulate_record_payment_does_not_modify_state() {
    let (env, creator, _admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres4");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    // Simulate recording a payment
    let _sim_result = client.simulate_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );

    // Try to get the payment - it should not exist
    let res = client.try_get_payment("receipt1");
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// ── Simulation result structure matches receipt structure ───────────────────

#[test]
fn simulate_record_payment_returns_correct_receipt_structure() {
    let (env, creator, _admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres5");
    let payer = Address::generate(&env);
    let amount = 5_000_000i128;
    let receipt_id = "simreceipt";

    let sim_receipt = client
        .simulate_record_payment(&settler, receipt_id, &resource_id, &payer, &amount, &"txhash")
        .unwrap();

    // Verify all fields
    assert_eq!(
        sim_receipt.receipt_id,
        String::from_str(&env, receipt_id)
    );
    assert_eq!(sim_receipt.resource_id, resource_id);
    assert_eq!(sim_receipt.payer, payer);
    assert_eq!(sim_receipt.amount, amount);
    assert_eq!(
        sim_receipt.state,
        PaymentState::Escrowed,
        "Simulated payment should be in Escrowed state"
    );
    assert_eq!(sim_receipt.tx_hash, String::from_str(&env, "txhash"));
}

// ── Simulation error codes match mutation errors ───────────────────────────

#[test]
fn simulate_record_payment_emits_validation_event() {
    let (env, creator, _admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres6");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    // Success case
    client.simulate_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );

    let all_events = env.events().all();
    let mut found_success = false;
    for i in 0..all_events.len() {
        let (_, topics, _) = all_events.get(i).unwrap();
        if topics.len() >= 1 {
            if let Ok(sym) =
                <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
            {
                if sym == Symbol::new(&env, "simvalid") {
                    found_success = true;
                    break;
                }
            }
        }
    }
    assert!(found_success, "simulate_record_payment must emit a 'simvalid' event");
}

// ── Simulation with nonexistent settler matches mutation error ──────────────

#[test]
fn simulate_record_payment_fails_without_settler_role() {
    let (env, creator, _admin, _settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "simres7");
    let not_settler = Address::generate(&env);
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    let sim_result = client.try_simulate_record_payment(
        &not_settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );

    let mut_result = client.try_record_payment(
        &not_settler,
        "receipt2",
        &resource_id,
        &payer,
        &amount,
        &"txhash2",
    );

    // Both should fail with NotSettler
    assert_eq!(sim_result, Err(Ok(Error::NotSettler)));
    assert_eq!(mut_result, Err(Ok(Error::NotSettler)));
}
