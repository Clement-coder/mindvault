// ─── Pause-scope matrix (#1018) ─────────────────────────────────────────────
//
// The registry has exactly one emergency pause and it is global. This module
// pins down what that pause covers.
//
// Every state-changing method in the payment, refund, lease and anchor
// families must refuse to run while the registry is paused, and a refused
// call must leave the registry unchanged: no receipt, no secondary index, no
// refund record, no lease, no anchor, no counter.
//
// Each matrix entry is exercised twice. The first pass runs against a live
// registry, where the call must succeed with the very same arguments: that
// is the control which proves the arguments are valid and that the entry is
// not blocked for some unrelated reason. The second pass runs the same calls
// against a paused registry, where every call must fail with
// `Error::ContractPaused` and must change nothing at all.
//
// The same matrix is published in `contract/README.md` under "Pause scope
// matrix". `readme_pause_scope_matrix_matches_contract` fails when the
// documented matrix and the one below drift apart.

use soroban_sdk::InvokeError;

/// Rows of the published pause-scope matrix: the contract method and the
/// family of money paths it belongs to. Every family listed here is fully
/// covered by the global pause.
const PAUSE_SCOPE_MATRIX: &[(&str, &str)] = &[
    ("record_payment", "payment"),
    ("record_payment_idempotent", "payment"),
    ("settle_payment", "payment"),
    ("set_refund_window", "refund"),
    ("record_creator_refund", "refund"),
    ("record_admin_refund", "refund"),
    ("buy_lease", "lease"),
    ("record_lease", "lease"),
    ("settle_lease", "lease"),
    ("revoke_lease", "lease"),
    ("anchor_purchase_receipt", "anchor"),
    ("attempt_anchor_purchase_receipt", "anchor"),
    ("override_purchase_receipt_anchor", "anchor"),
    ("record_anchor_failure", "anchor"),
    ("retry_anchor_purchase_receipt", "anchor"),
];

/// A registry entry the pause-scoped methods can write, read back in a
/// comparable shape.
///
/// The snapshot is taken through the contract's own storage API rather than
/// through public getters, because a getter hides exactly the entries that
/// matter here: the ones a blocked call would have *created* rather than
/// updated.
#[derive(Clone, Debug, PartialEq)]
enum ScopedValue {
    Absent,
    Text(String),
    Amount(i128),
    AmountAndCount((i128, u32)),
    Window(u32),
    Address(Address),
    Payment(PaymentReceipt),
    Refund(RefundReceipt),
    Lease(Lease),
    Anchor(PurchaseReceiptAnchor),
    AnchorFailure(AnchorFailure),
    AnchorAttempts(AnchorAttempts),
}

/// Read one registry entry into a comparable value.
fn read_scoped(env: &Env, contract: &Address, key: &DataKey) -> ScopedValue {
    env.as_contract(contract, || match key {
        DataKey::PaymentReceipt(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Payment(value),
            None => ScopedValue::Absent,
        },
        DataKey::PaymentIndex(_, _) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Text(value),
            None => ScopedValue::Absent,
        },
        DataKey::PaymentTxHash(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Text(value),
            None => ScopedValue::Absent,
        },
        DataKey::PaymentRecipient(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Address(value),
            None => ScopedValue::Absent,
        },
        DataKey::CreatorEarnings(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::AmountAndCount(value),
            None => ScopedValue::Absent,
        },
        DataKey::RefundReceipt(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Refund(value),
            None => ScopedValue::Absent,
        },
        DataKey::RefundedAmount(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Amount(value),
            None => ScopedValue::Absent,
        },
        DataKey::RefundTxHash(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Text(value),
            None => ScopedValue::Absent,
        },
        DataKey::RefundDeadline(_) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Window(value),
            None => ScopedValue::Absent,
        },
        DataKey::Lease(_, _) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Lease(value),
            None => ScopedValue::Absent,
        },
        DataKey::PurchaseReceipt(_, _) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::Anchor(value),
            None => ScopedValue::Absent,
        },
        DataKey::AnchorFailure(_, _) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::AnchorFailure(value),
            None => ScopedValue::Absent,
        },
        DataKey::AnchorAttempts(_, _) => match env.storage().persistent().get(key) {
            Some(value) => ScopedValue::AnchorAttempts(value),
            None => ScopedValue::Absent,
        },
        DataKey::RefundWindow => match env.storage().instance().get(key) {
            Some(value) => ScopedValue::Window(value),
            None => ScopedValue::Absent,
        },
        _ => ScopedValue::Absent,
    })
}

/// Snapshot every entry the pause-scoped methods can write.
fn snapshot_scoped(env: &Env, contract: &Address, keys: &[DataKey]) -> alloc::vec::Vec<ScopedValue> {
    keys.iter().map(|key| read_scoped(env, contract, key)).collect()
}

/// The contract error a `try_*` call produced, or `None` when it succeeded.
///
/// A call that could not be delivered at all (host error or invoke error) is
/// a test failure, not a contract error, so it panics.
fn contract_error<T>(
    result: Result<Result<T, Error>, Result<Error, InvokeError>>,
) -> Option<Error> {
    match result {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(error),
        Err(Err(error)) => panic!("the call reverted at the host level: {error:?}"),
        Err(Ok(error)) => panic!("the call could not be invoked: {error:?}"),
    }
}

/// Every payment, refund, lease and anchor method is refused while the
/// registry is paused, and the refusal leaves the registry untouched.
#[test]
fn pause_scope_matrix_refuses_every_money_path_and_changes_nothing() {
    let (env, creator, client) = setup();
    let settler = Address::generate(&env);
    let verifier = Address::generate(&env);
    let payer = Address::generate(&env);
    let buyer = Address::generate(&env);
    let buyer_two = Address::generate(&env);
    let buyer_three = Address::generate(&env);
    let buyer_four = Address::generate(&env);
    let buyer_five = Address::generate(&env);
    let lease_holder = Address::generate(&env);
    let lease_holder_two = Address::generate(&env);
    let lease_holder_three = Address::generate(&env);
    let lease_holder_four = Address::generate(&env);

    client.add_settler(&settler);
    client.add_verifier(&verifier);

    let resource_id = String::from_str(&env, "pausemat1");
    let anchor_resource_id = String::from_str(&env, "pausemat2");
    let price = 100i128;
    let lease_amount = price * LEASE_HOUR_MULTIPLIER;

    client.register(
        &creator,
        &resource_id,
        &price,
        &String::from_str(&env, "ipfs://pausemat"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &anchor_resource_id,
        &price,
        &String::from_str(&env, "ipfs://pausemat"),
        &empty_tags(&env),
    );

    let receipt_id = String::from_str(&env, "pmt-pay");
    let idempotent_receipt_id = String::from_str(&env, "pmt-idem");
    let settle_receipt_id = String::from_str(&env, "pmt-settle");
    let retry_receipt_id = String::from_str(&env, "pmt-retry");
    let payment_tx = String::from_str(&env, "tx-pay");
    let idempotent_tx = String::from_str(&env, "tx-idem");
    let settle_tx = String::from_str(&env, "tx-settle");
    let retry_tx = String::from_str(&env, "tx-retry");
    let refund_id = String::from_str(&env, "refund-creator");
    let admin_refund_id = String::from_str(&env, "refund-admin");
    let refund_tx = String::from_str(&env, "tx-refund");
    let admin_refund_tx = String::from_str(&env, "tx-refund-admin");
    let lease_tx = String::from_str(&env, "tx-lease");
    let record_lease_tx = String::from_str(&env, "tx-lease-rec");
    let settle_lease_tx = String::from_str(&env, "tx-lease-set");
    let revoke_lease_tx = String::from_str(&env, "tx-lease-rev");
    let anchor_hash = String::from_str(&env, "anchor-hash");
    let anchor_hash_two = String::from_str(&env, "anchor-hash-2");
    let anchor_hash_three = String::from_str(&env, "anchor-hash-3");
    let anchor_hash_four = String::from_str(&env, "anchor-hash-4");
    let anchor_hash_five = String::from_str(&env, "anchor-hash-5");

    // ── Control pass: the registry is live, so every matrix entry runs ─────
    //
    // These calls also build the state the paused pass needs a target for:
    // a settled payment to refund, pending leases to settle and revoke, and
    // an anchor to override.

    // Payments.
    assert_eq!(
        contract_error(client.try_record_payment(
            &settler,
            &receipt_id,
            &resource_id,
            &payer,
            &price,
            &payment_tx,
        )),
        None,
        "record_payment must succeed on a live registry"
    );
    assert_eq!(
        contract_error(client.try_record_payment_idempotent(
            &settler,
            &idempotent_receipt_id,
            &resource_id,
            &payer,
            &price,
            &idempotent_tx,
        )),
        None,
        "record_payment_idempotent must succeed on a live registry"
    );
    // A second, still-escrowed receipt: `settle_payment` has something to
    // settle, and the receipt stays a target for the paused pass.
    assert_eq!(
        contract_error(client.try_record_payment(
            &settler,
            &settle_receipt_id,
            &resource_id,
            &payer,
            &price,
            &settle_tx,
        )),
        None,
        "the payment to settle must be recorded on a live registry"
    );
    assert_eq!(
        contract_error(client.try_settle_payment(&settler, &settle_receipt_id)),
        None,
        "settle_payment must succeed on a live registry"
    );

    // Refunds.
    assert_eq!(
        contract_error(client.try_set_refund_window(&creator, &100u32)),
        None,
        "set_refund_window must succeed on a live registry"
    );
    assert_eq!(
        contract_error(client.try_record_creator_refund(
            &creator,
            &refund_id,
            &settle_receipt_id,
            &payer,
            &10i128,
            &refund_tx,
        )),
        None,
        "record_creator_refund must succeed on a live registry"
    );
    assert_eq!(
        contract_error(client.try_record_admin_refund(
            &creator,
            &admin_refund_id,
            &settle_receipt_id,
            &payer,
            &10i128,
            &admin_refund_tx,
        )),
        None,
        "record_admin_refund must succeed on a live registry"
    );

    // Leases.
    assert_eq!(
        contract_error(client.try_buy_lease(
            &lease_holder,
            &resource_id,
            &LeaseTier::Hour,
            &lease_amount,
            &lease_tx,
        )),
        None,
        "buy_lease must succeed on a live registry"
    );
    assert_eq!(
        contract_error(client.try_record_lease(
            &settler,
            &lease_holder_two,
            &resource_id,
            &LeaseTier::Hour,
            &lease_amount,
            &record_lease_tx,
        )),
        None,
        "record_lease must succeed on a live registry"
    );
    // A pending lease that the paused pass will try to settle.
    assert_eq!(
        contract_error(client.try_buy_lease(
            &lease_holder_three,
            &resource_id,
            &LeaseTier::Hour,
            &lease_amount,
            &settle_lease_tx,
        )),
        None,
        "the lease to settle must be bought on a live registry"
    );
    assert_eq!(
        contract_error(client.try_settle_lease(&settler, &resource_id, &lease_holder_three)),
        None,
        "settle_lease must succeed on a live registry"
    );
    // A pending lease that the paused pass will try to revoke.
    assert_eq!(
        contract_error(client.try_buy_lease(
            &lease_holder_four,
            &resource_id,
            &LeaseTier::Hour,
            &lease_amount,
            &revoke_lease_tx,
        )),
        None,
        "the lease to revoke must be bought on a live registry"
    );

    // Anchors.
    assert_eq!(
        contract_error(client.try_anchor_purchase_receipt(
            &verifier,
            &anchor_resource_id,
            &buyer,
            &anchor_hash,
        )),
        None,
        "anchor_purchase_receipt must succeed on a live registry"
    );
    assert_eq!(
        contract_error(client.try_attempt_anchor_purchase_receipt(
            &verifier,
            &anchor_resource_id,
            &buyer_two,
            &anchor_hash_two,
        )),
        None,
        "attempt_anchor_purchase_receipt must succeed on a live registry"
    );
    // An anchor to override: it is written first, then replaced.
    assert_eq!(
        contract_error(client.try_anchor_purchase_receipt(
            &verifier,
            &anchor_resource_id,
            &buyer_three,
            &anchor_hash_three,
        )),
        None,
        "the anchor to override must exist on a live registry"
    );
    assert_eq!(
        contract_error(client.try_override_purchase_receipt_anchor(
            &creator,
            &anchor_resource_id,
            &buyer_three,
            &anchor_hash_four,
        )),
        None,
        "override_purchase_receipt_anchor must succeed on a live registry"
    );
    assert_eq!(
        contract_error(client.try_record_anchor_failure(
            &settler,
            &anchor_resource_id,
            &buyer_four,
            &anchor_hash_five,
        )),
        None,
        "record_anchor_failure must succeed on a live registry"
    );
    // The retry path needs a recorded payment whose `tx_hash` is the
    // receipt hash being anchored.
    assert_eq!(
        contract_error(client.try_record_payment(
            &settler,
            &retry_receipt_id,
            &anchor_resource_id,
            &buyer_five,
            &price,
            &retry_tx,
        )),
        None,
        "the payment to retry must be recorded on a live registry"
    );
    assert_eq!(
        contract_error(client.try_retry_anchor_purchase_receipt(
            &settler,
            &anchor_resource_id,
            &buyer_five,
            &retry_tx,
        )),
        None,
        "retry_anchor_purchase_receipt must succeed on a live registry"
    );

    // ── Paused pass: the same calls, refused and inert ────────────────────

    let keys: alloc::vec::Vec<DataKey> = alloc::vec![
        // Payments.
        DataKey::PaymentReceipt(receipt_id.clone()),
        DataKey::PaymentReceipt(idempotent_receipt_id.clone()),
        DataKey::PaymentReceipt(settle_receipt_id.clone()),
        DataKey::PaymentReceipt(retry_receipt_id.clone()),
        DataKey::PaymentIndex(resource_id.clone(), payer.clone()),
        DataKey::PaymentIndex(anchor_resource_id.clone(), buyer_five.clone()),
        DataKey::PaymentTxHash(payment_tx.clone()),
        DataKey::PaymentTxHash(idempotent_tx.clone()),
        DataKey::PaymentTxHash(settle_tx.clone()),
        DataKey::PaymentTxHash(retry_tx.clone()),
        DataKey::PaymentRecipient(settle_receipt_id.clone()),
        DataKey::RefundDeadline(settle_receipt_id.clone()),
        DataKey::CreatorEarnings(creator.clone()),
        // Refunds.
        DataKey::RefundReceipt(refund_id.clone()),
        DataKey::RefundReceipt(admin_refund_id.clone()),
        DataKey::RefundedAmount(settle_receipt_id.clone()),
        DataKey::RefundTxHash(refund_tx.clone()),
        DataKey::RefundTxHash(admin_refund_tx.clone()),
        DataKey::RefundWindow,
        // Leases.
        DataKey::Lease(resource_id.clone(), lease_holder.clone()),
        DataKey::Lease(resource_id.clone(), lease_holder_two.clone()),
        DataKey::Lease(resource_id.clone(), lease_holder_three.clone()),
        DataKey::Lease(resource_id.clone(), lease_holder_four.clone()),
        // Anchors.
        DataKey::PurchaseReceipt(anchor_resource_id.clone(), buyer.clone()),
        DataKey::PurchaseReceipt(anchor_resource_id.clone(), buyer_two.clone()),
        DataKey::PurchaseReceipt(anchor_resource_id.clone(), buyer_three.clone()),
        DataKey::AnchorFailure(anchor_resource_id.clone(), buyer_four.clone()),
        DataKey::AnchorAttempts(anchor_resource_id.clone(), buyer_two.clone()),
        DataKey::AnchorAttempts(anchor_resource_id.clone(), buyer_five.clone()),
    ];

    let before = snapshot_scoped(&env, &client.address, &keys);

    client.set_paused(&creator, &true);
    assert!(client.is_paused(), "the registry must be paused");

    // Payments.
    assert_eq!(
        contract_error(client.try_record_payment(
            &settler,
            &receipt_id,
            &resource_id,
            &payer,
            &price,
            &payment_tx,
        )),
        Some(Error::ContractPaused),
        "record_payment must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_record_payment_idempotent(
            &settler,
            &idempotent_receipt_id,
            &resource_id,
            &payer,
            &price,
            &idempotent_tx,
        )),
        Some(Error::ContractPaused),
        "record_payment_idempotent must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_settle_payment(&settler, &settle_receipt_id)),
        Some(Error::ContractPaused),
        "settle_payment must be refused while paused"
    );
    assert_eq!(
        snapshot_scoped(&env, &client.address, &keys),
        before,
        "the payment calls must not change any state while paused"
    );

    // Refunds.
    assert_eq!(
        contract_error(client.try_set_refund_window(&creator, &500u32)),
        Some(Error::ContractPaused),
        "set_refund_window must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_record_creator_refund(
            &creator,
            &refund_id,
            &settle_receipt_id,
            &payer,
            &10i128,
            &refund_tx,
        )),
        Some(Error::ContractPaused),
        "record_creator_refund must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_record_admin_refund(
            &creator,
            &admin_refund_id,
            &settle_receipt_id,
            &payer,
            &10i128,
            &admin_refund_tx,
        )),
        Some(Error::ContractPaused),
        "record_admin_refund must be refused while paused"
    );
    assert_eq!(
        snapshot_scoped(&env, &client.address, &keys),
        before,
        "the refund calls must not change any state while paused"
    );

    // Leases.
    assert_eq!(
        contract_error(client.try_buy_lease(
            &lease_holder,
            &resource_id,
            &LeaseTier::Hour,
            &lease_amount,
            &lease_tx,
        )),
        Some(Error::ContractPaused),
        "buy_lease must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_record_lease(
            &settler,
            &lease_holder_two,
            &resource_id,
            &LeaseTier::Hour,
            &lease_amount,
            &record_lease_tx,
        )),
        Some(Error::ContractPaused),
        "record_lease must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_settle_lease(&settler, &resource_id, &lease_holder_three)),
        Some(Error::ContractPaused),
        "settle_lease must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_revoke_lease(&resource_id, &lease_holder_four)),
        Some(Error::ContractPaused),
        "revoke_lease must be refused while paused"
    );
    assert_eq!(
        snapshot_scoped(&env, &client.address, &keys),
        before,
        "the lease calls must not change any state while paused"
    );

    // Anchors.
    assert_eq!(
        contract_error(client.try_anchor_purchase_receipt(
            &verifier,
            &anchor_resource_id,
            &buyer,
            &anchor_hash,
        )),
        Some(Error::ContractPaused),
        "anchor_purchase_receipt must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_attempt_anchor_purchase_receipt(
            &verifier,
            &anchor_resource_id,
            &buyer_two,
            &anchor_hash_two,
        )),
        Some(Error::ContractPaused),
        "attempt_anchor_purchase_receipt must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_override_purchase_receipt_anchor(
            &creator,
            &anchor_resource_id,
            &buyer_three,
            &anchor_hash_four,
        )),
        Some(Error::ContractPaused),
        "override_purchase_receipt_anchor must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_record_anchor_failure(
            &settler,
            &anchor_resource_id,
            &buyer_four,
            &anchor_hash_five,
        )),
        Some(Error::ContractPaused),
        "record_anchor_failure must be refused while paused"
    );
    assert_eq!(
        contract_error(client.try_retry_anchor_purchase_receipt(
            &settler,
            &anchor_resource_id,
            &buyer_five,
            &retry_tx,
        )),
        Some(Error::ContractPaused),
        "retry_anchor_purchase_receipt must be refused while paused"
    );
    assert_eq!(
        snapshot_scoped(&env, &client.address, &keys),
        before,
        "the anchor calls must not change any state while paused"
    );

    // The pause is still in force afterwards, and the registry resumes
    // normally once it is lifted.
    assert!(client.is_paused());
    client.set_paused(&creator, &false);
    assert!(!client.is_paused());
    assert_eq!(
        contract_error(client.try_record_payment(
            &settler,
            &receipt_id,
            &resource_id,
            &payer,
            &price,
            &payment_tx,
        )),
        None,
        "the registry must accept payments again once the pause is lifted"
    );
}

/// The pause is scoped to writes: the read-only surface keeps working while
/// the registry is paused, so a monitor can still see what it is protecting.
#[test]
fn pause_scope_matrix_leaves_the_read_surface_open() {
    let (env, creator, client) = setup();
    let settler = Address::generate(&env);
    let payer = Address::generate(&env);

    client.add_settler(&settler);

    let resource_id = String::from_str(&env, "pausemat3");
    let receipt_id = String::from_str(&env, "pmt-read");
    let tx_hash = String::from_str(&env, "tx-read");
    let price = 100i128;

    client.register(
        &creator,
        &resource_id,
        &price,
        &String::from_str(&env, "ipfs://pausemat"),
        &empty_tags(&env),
    );
    client.record_payment(&settler, &receipt_id, &resource_id, &payer, &price, &tx_hash);

    client.set_paused(&creator, &true);

    assert!(client.is_paused(), "the registry must be paused");
    assert_eq!(
        client.get_resource_state(&resource_id),
        Ok(ResourceState::Listed),
        "reads must keep working while the registry is paused"
    );
    assert!(client.exists(&resource_id));
    assert_eq!(client.count(), 1);
    assert_eq!(
        client.get_payment(&receipt_id).map(|receipt| receipt.receipt_id),
        Ok(receipt_id.clone())
    );
}

/// The published matrix in `contract/README.md` must document exactly the
/// methods this module proves are refused while the registry is paused.
#[test]
fn readme_pause_scope_matrix_matches_contract() {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("contract/README.md must be readable from the vault-registry crate");

    let section = readme
        .split("### Pause scope matrix")
        .nth(1)
        .expect("contract/README.md must have a `### Pause scope matrix` section")
        .split("\n### ")
        .next()
        .expect("`### Pause scope matrix` section must be followed by another section");

    let documented: std::vec::Vec<(&str, &str)> = section
        .lines()
        .filter_map(|line| {
            let mut cells = line.trim().split('|').map(str::trim);
            cells.next()?; // leading empty cell
            let method = cells.next()?.trim_matches('`');
            if method.is_empty() || method == "Method" || method.starts_with('-') {
                return None;
            }
            let family = cells.next()?.trim_matches('`');
            Some((method, family))
        })
        .collect();

    for (method, family) in PAUSE_SCOPE_MATRIX {
        assert!(
            documented.contains(&(*method, *family)),
            "the pause-scope matrix proves `{method}` ({family}) is refused while \
             paused, but contract/README.md's Pause scope matrix does not \
             document it that way — update the table to match"
        );
    }

    for (method, _family) in &documented {
        assert!(
            PAUSE_SCOPE_MATRIX.iter().any(|(name, _)| *name == *method),
            "contract/README.md's Pause scope matrix documents `{method}`, but no \
             matrix entry proves it is refused while paused — either the doc is \
             stale or the matrix is missing an entry"
        );
    }

    assert_eq!(
        documented.len(),
        PAUSE_SCOPE_MATRIX.len(),
        "contract/README.md's Pause scope matrix row count must match the \
         matrix exactly (no duplicate or missing rows)"
    );
}
