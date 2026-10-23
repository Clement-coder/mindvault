// ─── Time-limited access leases (#803) ───────────────────────────────────────
//
// On-chain lease fields (`start_ledger`, `expiry_ledger`, `tier`) plus the
// read helpers a paywall needs, and the holder / settler / creator paths
// that write them.

fn lease_setup<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, _admin, client) = setup_with_admin();
    let settler = Address::generate(&env);
    client.add_settler(&settler);
    let holder = Address::generate(&env);
    (env, creator, settler, holder, client)
}

fn last_lease_event(env: &Env, expected_topic: Symbol, expected_id: &String) -> Lease {
    let all = env.events().all();
    let (_cid, topics, data) = all.get_unchecked(all.len() - 1);
    let topic: Symbol = Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, expected_topic);
    let topic_id: String = String::try_from_val(env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(&topic_id, expected_id);
    Lease::try_from_val(env, &data).unwrap()
}

#[test]
fn lease_tier_ledgers_and_prices_follow_the_documented_tables() {
    let (env, creator, _settler, _holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leasetier", 1_000i128);

    assert_eq!(LEASE_HOUR_LEDGERS, 720);
    assert_eq!(LEASE_DAY_LEDGERS, 17_280);
    assert_eq!(LEASE_WEEK_LEDGERS, 120_960);

    assert_eq!(client.lease_price(&id, &LeaseTier::Hour), 1_000i128);
    assert_eq!(client.lease_price(&id, &LeaseTier::Day), 5_000i128);
    assert_eq!(client.lease_price(&id, &LeaseTier::Week), 20_000i128);

    // The price tracks the resource's current price.
    client.set_price(&id, &2_000i128);
    assert_eq!(client.lease_price(&id, &LeaseTier::Week), 40_000i128);

    assert_eq!(
        client.try_lease_price(&String::from_str(&env, "nosuchlease"), &LeaseTier::Hour),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn buy_lease_records_a_pending_window_from_the_current_ledger() {
    let (env, creator, _settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leasebuy", 300i128);
    env.ledger().set_sequence_number(1_000);

    let lease = client.buy_lease(
        &holder,
        &id,
        &LeaseTier::Day,
        &1_500i128,
        &String::from_str(&env, "0xleasetx"),
    );

    assert_eq!(lease.resource_id, id);
    assert_eq!(lease.holder, holder);
    assert_eq!(lease.tier, LeaseTier::Day);
    assert_eq!(lease.start_ledger, 1_000);
    assert_eq!(lease.expiry_ledger, 1_000 + LEASE_DAY_LEDGERS);
    assert_eq!(lease.amount, 1_500i128);
    assert_eq!(lease.tx_hash, String::from_str(&env, "0xleasetx"));
    assert_eq!(lease.state, LeaseState::Pending);
    assert_eq!(lease.recorded_at, 1_000);
    assert_eq!(last_lease_event(&env, symbol_short!("lease"), &id), lease);

    // Pending grants nothing yet; the record is readable.
    assert!(!client.lease_is_active(&id, &holder));
    assert_eq!(client.get_lease(&id, &holder), lease);
}

#[test]
fn settle_lease_activates_and_the_window_expires_by_ledger() {
    let (env, creator, settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leasesetl", 100i128);
    env.ledger().set_sequence_number(50);
    client.buy_lease(
        &holder,
        &id,
        &LeaseTier::Hour,
        &100i128,
        &String::from_str(&env, "tx1"),
    );

    let settled = client.settle_lease(&settler, &id, &holder);
    assert_eq!(settled.state, LeaseState::Active);
    assert_eq!(last_lease_event(&env, symbol_short!("leasesetl"), &id), settled);
    assert!(client.lease_is_active(&id, &holder));

    // Last ledger inside the window.
    env.ledger().set_sequence_number(50 + LEASE_HOUR_LEDGERS - 1);
    assert!(client.lease_is_active(&id, &holder));
    // First ledger outside it.
    env.ledger().set_sequence_number(50 + LEASE_HOUR_LEDGERS);
    assert!(!client.lease_is_active(&id, &holder));
    // The record survives expiry for audit.
    assert_eq!(client.get_lease(&id, &holder).state, LeaseState::Active);

    // Settling twice is a transition error, as is settling without a lease.
    assert_eq!(
        client.try_settle_lease(&settler, &id, &holder),
        Err(Ok(Error::InvalidPaymentTransition))
    );
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_settle_lease(&settler, &id, &stranger),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn record_lease_writes_an_active_lease_for_a_settler() {
    let (env, creator, settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leaserec", 100i128);
    env.ledger().set_sequence_number(10);

    let lease = client.record_lease(
        &settler,
        &holder,
        &id,
        &LeaseTier::Week,
        &2_000i128,
        &String::from_str(&env, "x402settled"),
    );
    assert_eq!(lease.state, LeaseState::Active);
    assert_eq!(lease.expiry_ledger, 10 + LEASE_WEEK_LEDGERS);
    assert!(client.lease_is_active(&id, &holder));

    // Only a settler may record directly.
    let not_settler = Address::generate(&env);
    let other = Address::generate(&env);
    assert_eq!(
        client.try_record_lease(
            &not_settler,
            &other,
            &id,
            &LeaseTier::Hour,
            &100i128,
            &String::from_str(&env, "tx"),
        ),
        Err(Ok(Error::NotSettler))
    );
}

#[test]
fn lease_rejects_wrong_amount_bad_hash_and_unlisted_resources() {
    let (env, creator, _settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leasebad", 100i128);
    let tx = String::from_str(&env, "tx");

    assert_eq!(
        client.try_buy_lease(&holder, &id, &LeaseTier::Day, &100i128, &tx),
        Err(Ok(Error::PaymentAmountMismatch))
    );
    assert_eq!(
        client.try_buy_lease(&holder, &id, &LeaseTier::Day, &0i128, &tx),
        Err(Ok(Error::InvalidPaymentAmount))
    );
    assert_eq!(
        client.try_buy_lease(
            &holder,
            &id,
            &LeaseTier::Day,
            &500i128,
            &String::from_str(&env, "")
        ),
        Err(Ok(Error::InvalidTxHash))
    );
    assert_eq!(
        client.try_buy_lease(
            &holder,
            &String::from_str(&env, "nosuchres"),
            &LeaseTier::Day,
            &500i128,
            &tx
        ),
        Err(Ok(Error::NotFound))
    );

    // Delisted, frozen, disputed: not for sale, so not for lease.
    client.delist(&id);
    assert_eq!(
        client.try_buy_lease(&holder, &id, &LeaseTier::Day, &500i128, &tx),
        Err(Ok(Error::ResourceNotMutable))
    );
    client.freeze_resource(&id);
    assert_eq!(
        client.try_buy_lease(&holder, &id, &LeaseTier::Day, &500i128, &tx),
        Err(Ok(Error::ResourceNotMutable))
    );
    client.reactivate_resource(&id);
    assert!(client
        .try_buy_lease(&holder, &id, &LeaseTier::Day, &500i128, &tx)
        .is_ok());
}

#[test]
fn one_open_lease_per_pair_but_expired_or_revoked_leases_are_replaced() {
    let (env, creator, settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leaseonce", 100i128);
    let tx = String::from_str(&env, "tx");
    env.ledger().set_sequence_number(100);

    client.buy_lease(&holder, &id, &LeaseTier::Hour, &100i128, &tx);
    // Pending blocks a second purchase.
    assert_eq!(
        client.try_buy_lease(&holder, &id, &LeaseTier::Hour, &100i128, &tx),
        Err(Ok(Error::AlreadyRegistered))
    );
    client.settle_lease(&settler, &id, &holder);
    // Active and unexpired blocks it too.
    assert_eq!(
        client.try_buy_lease(&holder, &id, &LeaseTier::Day, &500i128, &tx),
        Err(Ok(Error::AlreadyRegistered))
    );
    // Another holder is independent.
    let other = Address::generate(&env);
    client.buy_lease(&other, &id, &LeaseTier::Hour, &100i128, &tx);

    // Expired: replaced by a new lease.
    env.ledger().set_sequence_number(100 + LEASE_HOUR_LEDGERS);
    let renewed = client.buy_lease(&holder, &id, &LeaseTier::Day, &500i128, &tx);
    assert_eq!(renewed.tier, LeaseTier::Day);
    assert_eq!(renewed.start_ledger, 100 + LEASE_HOUR_LEDGERS);
    assert_eq!(renewed.state, LeaseState::Pending);

    // Revoked: replaced as well.
    client.revoke_lease(&id, &holder);
    let again = client.buy_lease(&holder, &id, &LeaseTier::Week, &2_000i128, &tx);
    assert_eq!(again.tier, LeaseTier::Week);
}

#[test]
fn revoke_lease_is_creator_only_immediate_and_terminal() {
    let (env, creator, settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leaserevk", 100i128);
    client.record_lease(
        &settler,
        &holder,
        &id,
        &LeaseTier::Day,
        &500i128,
        &String::from_str(&env, "tx"),
    );
    assert!(client.lease_is_active(&id, &holder));

    let revoked = client.revoke_lease(&id, &holder);
    assert_eq!(revoked.state, LeaseState::Revoked);
    assert_eq!(last_lease_event(&env, symbol_short!("leaserevk"), &id), revoked);
    assert!(!client.lease_is_active(&id, &holder));
    assert_eq!(client.get_lease(&id, &holder).state, LeaseState::Revoked);

    assert_eq!(
        client.try_revoke_lease(&id, &holder),
        Err(Ok(Error::InvalidPaymentTransition))
    );
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_revoke_lease(&id, &stranger),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn revoke_lease_requires_the_creator_signature() {
    let (env, creator, settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leaseauth", 100i128);
    client.record_lease(
        &settler,
        &holder,
        &id,
        &LeaseTier::Hour,
        &100i128,
        &String::from_str(&env, "tx"),
    );

    let intruder = Address::generate(&env);
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "revoke_lease",
        args: (id.clone(), holder.clone()).into_val(&env),
        sub_invokes: &[],
    };
    let auth = [MockAuth {
        address: &intruder,
        invoke: &invoke,
    }];
    let res = client.mock_auths(&auth).try_revoke_lease(&id, &holder);
    assert!(res.is_err(), "a non-creator must not be able to revoke a lease");
    assert!(client.lease_is_active(&id, &holder));
}

#[test]
fn lease_reads_never_panic_on_unknown_pairs_or_bad_ids() {
    let (env, creator, _settler, holder, client) = lease_setup();
    let id = register_priced(&env, &creator, &client, "leaseread", 100i128);

    assert!(!client.lease_is_active(&id, &holder));
    assert!(!client.lease_is_active(&String::from_str(&env, "NOT-VALID"), &holder));
    assert_eq!(client.try_get_lease(&id, &holder), Err(Ok(Error::NotFound)));
    assert_eq!(
        client.try_get_lease(&String::from_str(&env, "NOT-VALID"), &holder),
        Err(Ok(Error::InvalidResourceId))
    );
}

#[test]
fn lease_writes_respect_the_emergency_pause() {
    let (env, creator, settler, holder, client) = lease_setup();
    let admin = client.admin().unwrap();
    let id = register_priced(&env, &creator, &client, "leasepause", 100i128);
    let tx = String::from_str(&env, "tx");

    client.set_paused(&admin, &true);
    assert_eq!(
        client.try_buy_lease(&holder, &id, &LeaseTier::Hour, &100i128, &tx),
        Err(Ok(Error::ContractPaused))
    );
    assert_eq!(
        client.try_record_lease(&settler, &holder, &id, &LeaseTier::Hour, &100i128, &tx),
        Err(Ok(Error::ContractPaused))
    );
    // Reads still work while paused.
    assert!(!client.lease_is_active(&id, &holder));
    assert_eq!(client.lease_price(&id, &LeaseTier::Hour), 100i128);
}

// ─── Fee-config freeze for active leases (#991) ─────────────────────────────
//
// When a lease is created the resource's current price is locked into
// `lease.amount`. A subsequent `set_fee_config` that raises the combined fee
// bps to or above that resource's price would retroactively invalidate the
// lease's pricing. The contract tracks an `ActiveLeasePriceFloor` — the
// minimum resource price among resources with open leases — and rejects
// fee configs whose combined bps is ≥ the floor.

#[test]
fn set_fee_config_rejected_when_combined_bps_meets_leased_resource_price() {
    let (env, creator, settler, holder, client) = lease_setup();
    let admin = client.admin().unwrap();

    // Resource priced at 100 stroops.
    let id = register_priced(&env, &creator, &client, "freezres", 100i128);

    // Create an active lease — this sets the price floor to 100.
    client.record_lease(
        &settler,
        &holder,
        &id,
        &LeaseTier::Hour,
        &100i128,
        &String::from_str(&env, "tx1"),
    );

    // Combined bps = 100 (≥ floor 100) → rejected.
    assert_eq!(
        client.try_set_fee_config(&FeeConfig {
            platform_fee_bps: 50,
            royalty_bps: 50,
            fee_recipient: None,
        }),
        Err(Ok(Error::LeaseFeeConfigConflict))
    );

    // Combined bps = 99 (< floor 100) → accepted.
    assert!(client
        .try_set_fee_config(&FeeConfig {
            platform_fee_bps: 50,
            royalty_bps: 49,
            fee_recipient: None,
        })
        .is_ok());
}

#[test]
fn set_fee_config_allowed_when_no_open_leases_exist() {
    let (_env, creator, _settler, _holder, client) = lease_setup();

    // Register a cheap resource but never lease it.
    let _id = register_priced(&env, &creator, &client, "nolease", 1i128);

    // Even 5000 combined bps should be allowed — no open leases.
    assert!(client
        .try_set_fee_config(&FeeConfig {
            platform_fee_bps: 2500,
            royalty_bps: 2500,
            fee_recipient: None,
        })
        .is_ok());
}

#[test]
fn fee_config_block_persists_across_multiple_resources() {
    let (env, creator, settler, holder, client) = lease_setup();

    // Resource A: price 1000, leased.
    let id_a = register_priced(&env, &creator, &client, "resA", 1_000i128);
    client.record_lease(
        &settler,
        &holder,
        &id_a,
        &LeaseTier::Hour,
        &1_000i128,
        &String::from_str(&env, "txA"),
    );

    // Resource B: price 50, leased — floor drops to 50.
    let id_b = register_priced(&env, &creator, &client, "resB", 50i128);
    let holder2 = Address::generate(&env);
    client.record_lease(
        &settler,
        &holder2,
        &id_b,
        &LeaseTier::Hour,
        &50i128,
        &String::from_str(&env, "txB"),
    );

    // Combined bps = 50 (≥ floor 50) → rejected.
    assert_eq!(
        client.try_set_fee_config(&FeeConfig {
            platform_fee_bps: 25,
            royalty_bps: 25,
            fee_recipient: None,
        }),
        Err(Ok(Error::LeaseFeeConfigConflict))
    );

    // Combined bps = 49 (< floor 50) → accepted.
    assert!(client
        .try_set_fee_config(&FeeConfig {
            platform_fee_bps: 25,
            royalty_bps: 24,
            fee_recipient: None,
        })
        .is_ok());
}

#[test]
fn zero_fee_config_always_allowed_even_with_active_leases() {
    let (env, creator, settler, holder, client) = lease_setup();

    // Even a 1-stroop resource with an active lease.
    let id = register_priced(&env, &creator, &client, "cheap", 1i128);
    client.record_lease(
        &settler,
        &holder,
        &id,
        &LeaseTier::Hour,
        &1i128,
        &String::from_str(&env, "tx1"),
    );

    // Zero fees always pass the guard.
    assert!(client
        .try_set_fee_config(&FeeConfig {
            platform_fee_bps: 0,
            royalty_bps: 0,
            fee_recipient: None,
        })
        .is_ok());
}

#[test]
fn existing_lease_amount_is_preserved_after_fee_config_change() {
    let (env, creator, settler, holder, client) = lease_setup();

    // Resource priced at 10_000.
    let id = register_priced(&env, &creator, &client, "preserve", 10_000i128);

    // Buy a day lease: 10_000 × 5 = 50_000.
    let lease1 = client.buy_lease(
        &holder,
        &id,
        &LeaseTier::Day,
        &50_000i128,
        &String::from_str(&env, "tx1"),
    );
    client.settle_lease(&settler, &id, &holder);
    assert_eq!(lease1.amount, 50_000i128);

    // Fee config with combined 100 bps is below the floor 10_000 → accepted.
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 50,
        royalty_bps: 50,
        fee_recipient: None,
    });

    // The lease still has its original locked-in amount.
    let stored = client.get_lease(&id, &holder);
    assert_eq!(stored.amount, 50_000i128);
    assert_eq!(stored.state, LeaseState::Active);

    // New leases on the same resource use the same price (price hasn't changed).
    let holder2 = Address::generate(&env);
    let lease2 = client.buy_lease(
        &holder2,
        &id,
        &LeaseTier::Day,
        &50_000i128,
        &String::from_str(&env, "tx2"),
    );
    assert_eq!(lease2.amount, 50_000i128);
}

#[test]
fn fee_config_then_lease_then_higher_fee_config_rejected() {
    let (env, creator, settler, holder, client) = lease_setup();

    // No fee config yet — set a low one first.
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 10,
        royalty_bps: 10,
        fee_recipient: None,
    });

    // Resource priced at 100, lease it.
    let id = register_priced(&env, &creator, &client, "seqres", 100i128);
    client.record_lease(
        &settler,
        &holder,
        &id,
        &LeaseTier::Hour,
        &100i128,
        &String::from_str(&env, "tx1"),
    );

    // Now try to raise fees to 100 combined — equals the floor → rejected.
    assert_eq!(
        client.try_set_fee_config(&FeeConfig {
            platform_fee_bps: 50,
            royalty_bps: 50,
            fee_recipient: None,
        }),
        Err(Ok(Error::LeaseFeeConfigConflict))
    );

    // But 99 combined is fine.
    assert!(client
        .try_set_fee_config(&FeeConfig {
            platform_fee_bps: 50,
            royalty_bps: 49,
            fee_recipient: None,
        })
        .is_ok());
}
