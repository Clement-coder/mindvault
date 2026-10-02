// ── Contract storage footprint report ────────────────────────────────────────
//
// Soroban charges rent per ledger entry and archives entries whose TTL runs
// out, so the shape of what this contract writes is an operational cost.
// `storage_footprint_report` builds a representative registry, measures every
// entry class it writes, and prints the table published in
// `docs/contract-storage-footprint.md`.

#[derive(Copy, Clone, Debug, PartialEq)]
enum StorageKind {
    Persistent,
    Instance,
}

struct FootprintRow {
    label: &'static str,
    kind: StorageKind,
    key_bytes: usize,
    value_bytes: usize,
    /// Maximum `key_bytes + value_bytes` this entry class may occupy before
    /// the report fails. See `docs/contract-storage-footprint.md`.
    budget: usize,
}

impl FootprintRow {
    fn total(&self) -> usize {
        self.key_bytes + self.value_bytes
    }
}

fn xdr_len<T: IntoVal<Env, soroban_sdk::Val>>(env: &Env, value: T) -> usize {
    use soroban_sdk::xdr::{Limits, ScVal, WriteXdr};
    let val: soroban_sdk::Val = value.into_val(env);
    ScVal::try_from_val(env, &val)
        .expect("every stored contract value must be ScVal-encodable")
        .to_xdr(Limits::none())
        .expect("ScVal encoding must not exceed XDR limits")
        .len()
}

fn measure_entry(
    env: &Env,
    contract: &Address,
    label: &'static str,
    key: DataKey,
    kind: StorageKind,
    budget: usize,
) -> Option<FootprintRow> {
    let key_bytes = xdr_len(env, key.clone());
    let stored: Option<soroban_sdk::Val> = env.as_contract(contract, || match kind {
        StorageKind::Persistent => env.storage().persistent().get(&key),
        StorageKind::Instance => env.storage().instance().get(&key),
    });
    stored.map(|value| FootprintRow {
        label,
        kind,
        key_bytes,
        value_bytes: xdr_len(env, value),
        budget,
    })
}

fn register_max_size_resource(
    env: &Env,
    creator: &Address,
    client: &VaultRegistryClient<'_>,
) -> String {
    let id = String::from_str(env, &"m".repeat(MAX_RESOURCE_ID_LEN as usize));
    let metadata = String::from_str(
        env,
        &std::format!(
            "ipfs://{}",
            "q".repeat(MAX_METADATA_POINTER_LEN as usize - "ipfs://".len())
        ),
    );
    let mut tag_list = Vec::new(env);
    for i in 0..MAX_TAGS {
        let tag = std::format!("{i}{}", "t".repeat(MAX_TAG_LEN as usize - 1));
        tag_list.push_back(String::from_str(env, &tag));
    }
    let content_hash = String::from_str(env, &"c".repeat(MAX_CONTENT_HASH_LEN as usize));

    client.register_with_hash(
        creator,
        &id,
        &MAX_PRICE,
        &metadata,
        &tag_list,
        &Some(content_hash),
    );
    id
}

#[test]
fn storage_footprint_report() {
    let (env, creator, admin, client) = setup_with_admin();
    let contract = client.address.clone();

    let max_id = register_max_size_resource(&env, &creator, &client);
    let typical_id = register_tagged(&env, &creator, &client, "typicalres", &["dataset"]);
    let tag_fixture_creator = Address::generate(&env);
    for i in 0..(TOP_TAGS_CAP - MAX_TAGS) {
        let tag = format!("{:02}{}", i, "t".repeat(MAX_TAG_LEN as usize - 2));
        let id = format!("topfixture{:02}", i);
        register_tagged(
            &env,
            &tag_fixture_creator,
            &client,
            &id,
            &[tag.as_str()],
        );
    }

    let settler = Address::generate(&env);
    let verifier = Address::generate(&env);
    let moderator = Address::generate(&env);
    let buyer = Address::generate(&env);
    let receipt_id = String::from_str(&env, &"r".repeat(MAX_RECEIPT_ID_LEN as usize));
    let max_hash = String::from_str(&env, &"h".repeat(MAX_TX_HASH_LEN as usize));

    client.add_settler(&settler);
    client.add_verifier(&verifier);
    client.add_moderator(&moderator);
    client.set_terms_hash(
        &creator,
        &String::from_str(&env, &"t".repeat(MAX_TERMS_HASH_LEN as usize)),
    );
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 250,
        fee_recipient: Some(admin.clone()),
    });
    client.set_fee_destination(&FeeDestinationConfig {
        bps: MAX_FEE_DESTINATION_BPS,
        destination: FeeDestination::Burn,
    });
    client.record_payment(
        &settler,
        &receipt_id,
        &max_id,
        &buyer,
        &MAX_PRICE,
        &max_hash,
    );
    client.anchor_purchase_receipt(&verifier, &max_id, &buyer, &max_hash);
    client.set_verification_status(
        &typical_id,
        &verifier,
        &VerificationStatus::Verified,
        &Some(String::from_str(
            &env,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )),
    );
    client.flag_resource(&max_id, &moderator, &FlagReason::Copyright);
    client.set_flag_reason_hash(
        &max_id,
        &moderator,
        &String::from_str(&env, &"f".repeat(MAX_FLAG_REASON_HASH_LEN as usize)),
    );
    // A rejected anchor attempt leaves the pair's retry bookkeeping behind.
    let retry_buyer = Address::generate(&env);
    assert!(!client.attempt_anchor_purchase_receipt(
        &verifier,
        &max_id,
        &retry_buyer,
        &String::from_str(&env, ""),
    ));
    // A max-size lease: the widest tier and a max-length tx hash.
    let lessee = Address::generate(&env);
    let lease_amount = client.lease_price(&max_id, &LeaseTier::Week);
    client.buy_lease(
        &lessee,
        &max_id,
        &LeaseTier::Week,
        &lease_amount,
        &String::from_str(&env, &"l".repeat(MAX_TX_HASH_LEN as usize)),
    );
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);

    let max_tag = client.get(&max_id).tags.get(0).unwrap();
    let specs: std::vec::Vec<(&'static str, DataKey, StorageKind, usize)> = std::vec![
        (
            "Resource (max-size)",
            DataKey::Resource(max_id.clone()),
            StorageKind::Persistent,
            1700,
        ),
        (
            "Resource (typical)",
            DataKey::Resource(typical_id.clone()),
            StorageKind::Persistent,
            640,
        ),
        (
            "Index(u32) -> id",
            DataKey::Index(0),
            StorageKind::Persistent,
            96,
        ),
        ("Count", DataKey::Count, StorageKind::Instance, 48),
        (
            "TagCount (max-size tag)",
            DataKey::TagCount(max_tag.clone()),
            StorageKind::Instance,
            160,
        ),
        ("TopTags", DataKey::TopTags, StorageKind::Instance, 2000),
        (
            "CreatorResources",
            DataKey::CreatorResources(creator.clone()),
            StorageKind::Persistent,
            160,
        ),
        (
            "CreatorCount",
            DataKey::CreatorCount(creator.clone()),
            StorageKind::Instance,
            96,
        ),
        (
            "TagIndex (max-size tag)",
            DataKey::TagIndex(max_tag),
            StorageKind::Persistent,
            160,
        ),
        (
            "CreatorTerms",
            DataKey::CreatorTerms(creator.clone()),
            StorageKind::Persistent,
            200,
        ),
        (
            "PaymentReceipt",
            DataKey::PaymentReceipt(receipt_id.clone()),
            StorageKind::Persistent,
            640,
        ),
        (
            "PaymentIndex -> receipt id",
            DataKey::PaymentIndex(max_id.clone(), buyer.clone()),
            StorageKind::Persistent,
            240,
        ),
        (
            "PurchaseReceipt (anchor)",
            DataKey::PurchaseReceipt(max_id.clone(), buyer.clone()),
            StorageKind::Persistent,
            480,
        ),
        (
            "AnchorAttempts",
            DataKey::AnchorAttempts(max_id.clone(), retry_buyer.clone()),
            StorageKind::Persistent,
            200,
        ),
        (
            "Lease (max-size)",
            DataKey::Lease(max_id.clone(), lessee.clone()),
            StorageKind::Persistent,
            640,
        ),
        (
            "FlagReasonHash",
            DataKey::FlagReasonHash(max_id.clone()),
            StorageKind::Persistent,
            200,
        ),
        (
            "FlagModerator",
            DataKey::FlagModerator(max_id.clone()),
            StorageKind::Persistent,
            160,
        ),
        (
            "AttestationHash",
            DataKey::AttestationHash(typical_id.clone()),
            StorageKind::Persistent,
            160,
        ),
        ("FeeConfig", DataKey::FeeConfig, StorageKind::Instance, 192),
        (
            "FeeDestination",
            DataKey::FeeDestination,
            StorageKind::Instance,
            192,
        ),
        ("Admin", DataKey::Admin, StorageKind::Instance, 80),
        (
            "Verifier grant",
            DataKey::Verifier(verifier),
            StorageKind::Instance,
            96,
        ),
        (
            "Moderator grant",
            DataKey::Moderator(moderator),
            StorageKind::Instance,
            96,
        ),
        (
            "Settler grant",
            DataKey::Settler(settler),
            StorageKind::Instance,
            96,
        ),
        ("Paused flag", DataKey::Paused, StorageKind::Instance, 48),
        (
            "Pause deadline",
            DataKey::PauseUntil,
            StorageKind::Instance,
            64,
        ),
    ];

    let mut rows: std::vec::Vec<FootprintRow> = std::vec::Vec::new();
    let mut missing: std::vec::Vec<&'static str> = std::vec::Vec::new();
    for (label, key, kind, budget) in specs {
        match measure_entry(&env, &contract, label, key, kind, budget) {
            Some(row) => rows.push(row),
            None if label == "Paused flag" => {}
            None => missing.push(label),
        }
    }
    assert!(
        missing.is_empty(),
        "the report setup did not write these entry classes: {missing:?} — \
         extend the setup, or drop the row if the class no longer exists"
    );

    std::println!("\n### Storage footprint (XDR bytes)\n");
    std::println!("| Entry | Map | Key | Value | Total | Budget |");
    std::println!("| ----- | --- | ---:| -----:| -----:| ------:|");
    for row in &rows {
        let map = match row.kind {
            StorageKind::Persistent => "persistent",
            StorageKind::Instance => "instance",
        };
        std::println!(
            "| {} | {} | {} | {} | {} | {} |",
            row.label,
            map,
            row.key_bytes,
            row.value_bytes,
            row.total(),
            row.budget,
        );
    }

    let per_resource: usize = rows
        .iter()
        .filter(|r| {
            matches!(
                r.label,
                "Resource (max-size)"
                    | "Index(u32) -> id"
                    | "TagIndex (max-size tag)"
                    | "TagCount (max-size tag)"
            )
        })
        .map(FootprintRow::total)
        .sum();
    let per_payment: usize = rows
        .iter()
        .filter(|r| matches!(r.label, "PaymentReceipt" | "PaymentIndex -> receipt id"))
        .map(FootprintRow::total)
        .sum();
    std::println!(
        "\nPer max-size registration (Resource + Index + one TagIndex + one TagCount): {per_resource} bytes"
    );
    std::println!("Per payment (PaymentReceipt + PaymentIndex): {per_payment} bytes\n");

    for row in &rows {
        assert!(
            row.total() <= row.budget,
            "storage entry `{}` is {} XDR bytes, over its {}-byte budget — if the \
             growth is intended, raise the budget here and update \
             docs/contract-storage-footprint.md",
            row.label,
            row.total(),
            row.budget,
        );
    }

    assert!(
        per_resource <= 1_900,
        "a max-size registration now writes {per_resource} XDR bytes across its \
         four entry classes, over the 1900-byte budget"
    );
    assert!(
        per_payment <= 850,
        "a payment now writes {per_payment} XDR bytes across its two entry \
         classes, over the 850-byte budget"
    );
}
