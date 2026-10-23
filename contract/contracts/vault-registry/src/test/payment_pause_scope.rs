// ─── Payment Pause Scope (#1016) ───────────────────────────────────────────
//
// Acceptance criteria (from issue):
//   • Pause scopes are independently readable, role-protected, evented, and tested
//     against every affected method.
//   • Update focused tests and relevant MCP/contract documentation.
//   • Keep changes bounded to the stated behavior and preserve existing client
//     compatibility where applicable.

fn setup_with_settlement<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, admin, client) = setup_with_admin();
    let settler = Address::generate(&env);
    client.add_settler(&settler);
    (env, creator, admin, settler, client)
}

// ── set_payment_paused / is_payment_paused ──────────────────────────────────

#[test]
fn set_payment_paused_before_admin_set_fails() {
    let (env, _creator, client) = setup();
    let anyone = Address::generate(&env);
    let res = client.try_set_payment_paused(&anyone, &true);
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn admin_can_set_payment_paused() {
    let (env, _creator, admin, client) = setup_with_admin();

    assert!(!client.is_payment_paused());

    client.set_payment_paused(&admin, &true);
    assert!(client.is_payment_paused());

    client.set_payment_paused(&admin, &false);
    assert!(!client.is_payment_paused());
}

#[test]
fn set_payment_paused_emits_event() {
    let (env, _creator, admin, client) = setup_with_admin();

    client.set_payment_paused(&admin, &true);

    let all = env.events().all();
    let found = (0..all.len()).any(|i| {
        let (_, topics, _) = all.get(i).unwrap();
        topics
            .get(0)
            .and_then(|v| {
                <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &v)
                    .ok()
            })
            .map(|sym: Symbol| sym == Symbol::new(&env, "payment_pause"))
            .unwrap_or(false)
    });
    assert!(found, "set_payment_paused must emit a 'payment_pause' event");
}

// ── record_payment blocked by payment pause ─────────────────────────────────

#[test]
fn record_payment_fails_when_payment_paused() {
    let (env, creator, admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "payres0");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    client.set_payment_paused(&admin, &true);

    let res = client.try_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn settle_payment_fails_when_payment_paused() {
    let (env, creator, admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "payres1");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    client.record_payment(&settler, "receipt1", &resource_id, &payer, &amount, &"txhash1");

    client.set_payment_paused(&admin, &true);

    let res = client.try_settle_payment(&settler, "receipt1");
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

// ── record_creator_refund blocked by payment pause ──────────────────────────

#[test]
fn record_creator_refund_fails_when_payment_paused() {
    let (env, creator, admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "payres2");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    client.record_payment(&settler, "receipt1", &resource_id, &payer, &amount, &"txhash1");
    client.settle_payment(&settler, "receipt1");

    client.set_payment_paused(&admin, &true);

    let res = client.try_record_creator_refund(
        &creator,
        "refund1",
        "receipt1",
        &payer,
        &(amount / 2),
        &"txhash2",
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

// ── buy_lease blocked by payment pause ──────────────────────────────────────

#[test]
fn buy_lease_fails_when_payment_paused() {
    let (env, creator, admin, _settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "leaseres0");
    let holder = Address::generate(&env);

    client.set_payment_paused(&admin, &true);

    let res = client.try_buy_lease(&holder, &resource_id, &LeaseTier::Hour, &LEASE_HOUR_MULTIPLIER);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

// ── Catalog mutations still work when payment paused ──────────────────────────

#[test]
fn set_price_works_when_payment_paused() {
    let (env, creator, admin, _settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "catres0");

    client.set_payment_paused(&admin, &true);

    let new_price = 2_000_000i128;
    client.set_price(&creator, &resource_id, &new_price);

    let resource = client.get(&resource_id);
    assert_eq!(resource.price, new_price);
}

#[test]
fn register_works_when_payment_paused() {
    let (env, creator, admin, _settler, client) = setup_with_admin();
    let _admin2 = admin.clone();

    client.set_payment_paused(&admin, &true);

    let resource_id = "newresource";
    let price = 1_000_000i128;
    client.register(&creator, resource_id, &price, "ipfs://metadata");

    let resource = client.get(resource_id);
    assert_eq!(resource.id, resource_id);
    assert_eq!(resource.price, price);
}

// ── set_payment_paused_until ────────────────────────────────────────────────

#[test]
fn set_payment_paused_until_auto_resumes() {
    let (env, creator, admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "payres3");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    let now = env.ledger().timestamp();
    let pause_until = now + 100u64;
    client.set_payment_paused_until(&admin, &pause_until);
    assert!(client.is_payment_paused());

    // Should fail while paused
    let res = client.try_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // Simulate time passing (deadline expired)
    env.ledger().with_mut(|l| {
        l.timestamp = pause_until + 1;
    });

    // Should work after deadline
    assert!(!client.is_payment_paused());
    client.record_payment(&settler, "receipt1", &resource_id, &payer, &amount, &"txhash1");
}

// ── payment_pause_until query ───────────────────────────────────────────────

#[test]
fn payment_pause_until_returns_deadline() {
    let (env, _creator, admin, client) = setup_with_admin();

    assert_eq!(client.payment_pause_until(), None);

    let now = env.ledger().timestamp();
    let deadline = now + 500u64;
    client.set_payment_paused_until(&admin, &deadline);

    assert_eq!(client.payment_pause_until(), Some(deadline));
}

// ── Independent pause scopes ────────────────────────────────────────────────

#[test]
fn payment_pause_independent_from_general_pause() {
    let (env, creator, admin, settler, client) = setup_with_settlement();
    let resource_id = register_default(&env, &creator, &client, "indep0");
    let payer = Address::generate(&env);
    let amount = LEASE_HOUR_MULTIPLIER * USDC_BASE_UNITS_PER_USDC;

    // Pause only payments
    client.set_payment_paused(&admin, &true);

    // General catalog operations work
    client.set_price(&creator, &resource_id, &2_000_000);

    // Payments fail
    let res = client.try_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));

    // General pause also prevents catalog mutations
    client.set_paused(&admin, &true);
    let res2 = client.try_set_price(&creator, &resource_id, &3_000_000);
    assert_eq!(res2, Err(Ok(Error::ContractPaused)));

    // Unpause general pause, payment pause remains
    client.set_paused(&admin, &false);

    // Catalog works again
    client.set_price(&creator, &resource_id, &3_000_000);

    // Payments still fail
    let res3 = client.try_record_payment(
        &settler,
        "receipt1",
        &resource_id,
        &payer,
        &amount,
        &"txhash1",
    );
    assert_eq!(res3, Err(Ok(Error::ContractPaused)));
}
