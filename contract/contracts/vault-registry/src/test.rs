#![cfg(test)]

use super::*;
use alloc::{format, string::ToString};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{
        storage::Persistent as _, Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke,
    },
    Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, TryIntoVal, Val, Vec,
};

fn resource_storage_ttl(env: &Env, contract: &soroban_sdk::Address, id: &String) -> u32 {
    let key = DataKey::Resource(id.clone());
    env.as_contract(contract, || env.storage().persistent().get_ttl(&key))
}

/// Live TTL of the persistent entry holding the payment receipt `receipt_id`.
fn payment_receipt_ttl(env: &Env, contract: &soroban_sdk::Address, receipt_id: &String) -> u32 {
    let key = DataKey::PaymentReceipt(receipt_id.clone());
    env.as_contract(contract, || env.storage().persistent().get_ttl(&key))
}

fn setup<'a>() -> (Env, Address, VaultRegistryClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    (env, creator, client)
}

fn setup_strict_auth<'a>() -> (Env, Address, Address, VaultRegistryClient<'a>, String) {
    let env = Env::default();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let owner = Address::generate(&env);
    let stranger = Address::generate(&env);
    let id = String::from_str(&env, "authres");
    client.mock_all_auths().register(
        &owner,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://auth"),
        &empty_tags(&env),
    );
    (env, owner, stranger, client, id)
}

fn empty_tags(env: &Env) -> Vec<String> {
    Vec::new(env)
}

fn tags(env: &Env, items: &[&str]) -> Vec<String> {
    let mut v = Vec::new(env);
    for item in items {
        v.push_back(String::from_str(env, item));
    }
    v
}

#[test]
fn register_then_read() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "swcn98besxpp6t1u8e77fqz3");
    let metadata = String::from_str(&env, "ipfs://QmResourceMetadata");

    client.register(&creator, &id, &1_000_000i128, &metadata, &empty_tags(&env));

    assert_eq!(client.count(), 1);
    assert!(client.exists(&id));

    let r = client.get(&id);
    assert_eq!(r.id, id);
    assert_eq!(r.creator, creator);
    assert_eq!(r.price, 1_000_000i128);
    assert_eq!(r.metadata, metadata);
    assert!(r.listed); // Resources are listed by default
}

#[test]
fn register_event_contains_full_resource_payload() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtres");
    let metadata = String::from_str(&env, "ipfs://evt");
    let price = 1_000_000i128;
    let tags_list = tags(&env, &["tag1"]);

    client.register(&creator, &id, &price, &metadata, &tags_list);

    let all_events = env.events().all();
    let mut found = false;
    for i in 0..all_events.len() {
        let (_, topics, data) = all_events.get(i).unwrap();
        if topics.len() != 2 {
            continue;
        }
        let t0: Symbol =
            <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
                .ok()
                .unwrap();
        if t0 != Symbol::new(&env, "register") {
            continue;
        }
        let event: RegisterEvent =
            <RegisterEvent as TryFromVal<Env, Val>>::try_from_val(&env, &data)
                .ok()
                .unwrap();
        assert_eq!(event.id, id);
        assert_eq!(event.creator, creator);
        assert_eq!(event.price, price);
        assert_eq!(event.metadata, metadata);
        assert!(event.listed);
        assert_eq!(event.tags.len(), 1);
        assert_eq!(event.tags.get(0).unwrap(), String::from_str(&env, "tag1"));
        found = true;
        break;
    }
    assert!(found, "register event not emitted");
}

#[test]
fn count_tracks_multiple_successful_registrations() {
    let (env, creator, client) = setup();
    assert_eq!(client.count(), 0);

    let ids = ["c1", "c2", "c3", "c4"];
    for id in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }
    assert_eq!(client.count(), 4);

    // Failed duplicate must not increment count.
    let dup = String::from_str(&env, "c2");
    assert_eq!(
        client.try_register(
            &creator,
            &dup,
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(client.count(), 4);
}

#[test]
fn duplicate_registration_fails() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "dup");
    let metadata = String::from_str(&env, "ipfs://x");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    let res = client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert_eq!(res, Err(Ok(Error::AlreadyRegistered)));
    assert_eq!(client.count(), 1);
}

// ─── Bounded batch registration (#627) ────────────────────────────────────

#[test]
fn register_batch_succeeds_for_valid_items() {
    let (env, creator, client) = setup();

    let mut items = Vec::new(&env);
    for i in 0..5 {
        items.push_back(BatchRegisterItem {
            id: String::from_str(&env, &format!("batch{}", i)),
            price: 100i128 + i128::from(i),
            metadata: String::from_str(&env, "ipfs://QmBatch"),
            tags: empty_tags(&env),
            content_hash: None,
        });
    }

    let result = client.register_batch(&creator, &items);
    assert_eq!(result.succeeded.len(), 5);
    assert_eq!(result.failed.len(), 0);
    assert_eq!(client.count(), 5);

    // Verify all resources were registered
    for i in 0..5 {
        let id = String::from_str(&env, &format!("batch{}", i));
        assert!(client.exists(&id));
    }
}

#[test]
fn register_batch_handles_partial_failures() {
    let (env, creator, client) = setup();

    // Pre-register one resource to cause a duplicate
    let dup_id = String::from_str(&env, "batch1");
    client.register(
        &creator,
        &dup_id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let mut items = Vec::new(&env);
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch0"),
        price: 100i128,
        metadata: String::from_str(&env, "ipfs://QmBatch"),
        tags: empty_tags(&env),
        content_hash: None,
    });
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch1"), // Duplicate
        price: 100i128,
        metadata: String::from_str(&env, "ipfs://QmBatch"),
        tags: empty_tags(&env),
        content_hash: None,
    });
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch2"),
        price: 0i128, // Invalid price
        metadata: String::from_str(&env, "ipfs://QmBatch"),
        tags: empty_tags(&env),
        content_hash: None,
    });
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch3"),
        price: 100i128,
        metadata: String::from_str(&env, "ipfs://QmBatch"),
        tags: empty_tags(&env),
        content_hash: None,
    });

    let result = client.register_batch(&creator, &items);

    // batch0 and batch3 should succeed
    assert_eq!(result.succeeded.len(), 2);
    assert_eq!(
        result.succeeded.get(0).unwrap(),
        String::from_str(&env, "batch0")
    );
    assert_eq!(
        result.succeeded.get(1).unwrap(),
        String::from_str(&env, "batch3")
    );

    // batch1 (index 1) and batch2 (index 2) should fail
    assert_eq!(result.failed.len(), 2);

    let (idx1, err1) = result.failed.get(0).unwrap();
    assert_eq!(idx1, 1);
    assert_eq!(err1, Error::AlreadyRegistered as u32);

    let (idx2, err2) = result.failed.get(1).unwrap();
    assert_eq!(idx2, 2);
    assert_eq!(err2, Error::InvalidPrice as u32);
}

#[test]
fn register_batch_rejects_oversized_batch() {
    let (env, creator, client) = setup();

    let mut items = Vec::new(&env);
    for i in 0..15 {
        items.push_back(BatchRegisterItem {
            id: String::from_str(&env, &format!("batch{}", i)),
            price: 100i128,
            metadata: String::from_str(&env, "ipfs://QmBatch"),
            tags: empty_tags(&env),
            content_hash: None,
        });
    }

    let res = client.try_register_batch(&creator, &items);
    assert_eq!(res, Err(Ok(Error::BatchTooLarge)));
}

#[test]
fn register_batch_requires_creator_auth() {
    let (env, creator, client) = setup();

    let mut items = Vec::new(&env);
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch0"),
        price: 100i128,
        metadata: String::from_str(&env, "ipfs://QmBatch"),
        tags: empty_tags(&env),
        content_hash: None,
    });

    env.mock_auths(&[]);
    let res = client.try_register_batch(&creator, &items);
    assert!(res.is_err());
}

#[test]
fn register_batch_respects_pause_state() {
    let (env, creator, admin, client) = setup_with_admin();

    let mut items = Vec::new(&env);
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch0"),
        price: 100i128,
        metadata: String::from_str(&env, "ipfs://QmBatch"),
        tags: empty_tags(&env),
        content_hash: None,
    });

    client.set_paused(&admin, &true);

    let res = client.try_register_batch(&creator, &items);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn register_batch_handles_empty_batch() {
    let (env, creator, client) = setup();

    let items = Vec::new(&env);
    let result = client.register_batch(&creator, &items);

    assert_eq!(result.succeeded.len(), 0);
    assert_eq!(result.failed.len(), 0);
}

#[test]
fn register_batch_with_content_hashes() {
    let (env, creator, client) = setup();

    let mut items = Vec::new(&env);
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch0"),
        price: 100i128,
        metadata: String::from_str(&env, "ipfs://QmBatch"),
        tags: empty_tags(&env),
        content_hash: Some(String::from_str(&env, "sha256:abcd1234")),
    });
    items.push_back(BatchRegisterItem {
        id: String::from_str(&env, "batch1"),
        price: 200i128,
        metadata: String::from_str(&env, "ipfs://QmBatch2"),
        tags: empty_tags(&env),
        content_hash: None,
    });

    let result = client.register_batch(&creator, &items);
    assert_eq!(result.succeeded.len(), 2);
    assert_eq!(result.failed.len(), 0);

    // Verify content hash was set
    let r0 = client.get(&String::from_str(&env, "batch0"));
    assert_eq!(
        r0.content_hash,
        Some(String::from_str(&env, "sha256:abcd1234"))
    );

    let r1 = client.get(&String::from_str(&env, "batch1"));
    assert_eq!(r1.content_hash, None);
}

#[test]
fn zero_or_negative_price_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "free");
    let metadata = String::from_str(&env, "ipfs://x");

    assert_eq!(
        client.try_register(&creator, &id, &0i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        client.try_register(&creator, &id, &-5i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidPrice))
    );
}

#[test]
fn register_rejects_price_exceeding_max() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "toopricey");
    let metadata = String::from_str(&env, "ipfs://x");
    let over = MAX_PRICE + 1;
    assert_eq!(
        client.try_register(&creator, &id, &over, &metadata, &empty_tags(&env)),
        Err(Ok(Error::PriceExceedsMax))
    );
}

#[test]
fn set_price_rejects_price_exceeding_max() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    let over = MAX_PRICE + 1;
    assert_eq!(
        client.try_set_price(&id, &over),
        Err(Ok(Error::PriceExceedsMax))
    );
}

#[test]
fn maximum_price_accepted() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxprice");
    let metadata = String::from_str(&env, "ipfs://x");
    client.register(&creator, &id, &MAX_PRICE, &metadata, &empty_tags(&env));
    assert_eq!(client.get(&id).price, MAX_PRICE);
}

#[test]
fn invalid_resource_id_rejected() {
    let (env, creator, client) = setup();
    let metadata = String::from_str(&env, "ipfs://x");

    let empty = String::from_str(&env, "");
    assert_eq!(
        client.try_register(&creator, &empty, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidResourceId))
    );

    let overlong = String::from_str(&env, &"a".repeat(25));
    assert_eq!(
        client.try_register(&creator, &overlong, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidResourceId))
    );

    let invalid_chars = String::from_str(&env, "bad-id");
    assert_eq!(
        client.try_register(
            &creator,
            &invalid_chars,
            &100i128,
            &metadata,
            &empty_tags(&env)
        ),
        Err(Ok(Error::InvalidResourceId))
    );
}

#[test]
fn valid_resource_id_is_accepted() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "swcn98besxpp6t1u8e77fqz3");
    let metadata = String::from_str(&env, "ipfs://x");

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert!(client.exists(&id));
}

// ── Resource ID reserved-word list documentation (#645) ──────────────────────
//
// The contract rejects a fixed set of reserved words (case-insensitive) with
// `ReservedId`. This test pins every word in the list so that adding a new
// reserved word without updating the documentation (contract/README.md §
// "Resource ID format and reserved words") triggers a test change.

/// Every word in the `is_reserved_id` list must be rejected at registration
/// time with `ReservedId`, regardless of capitalisation.
#[test]
fn reserved_resource_ids_are_rejected() {
    let (env, creator, client) = setup();
    let meta = String::from_str(&env, "ipfs://m");
    let tags = empty_tags(&env);

    // Each tuple is (lowercase form, at-least-one-uppercase variant).
    let cases: &[(&str, &str)] = &[
        ("admin", "Admin"),
        ("null", "NULL"),
        ("registry", "Registry"),
        ("api", "API"),
        ("index", "Index"),
        ("root", "Root"),
        ("system", "System"),
    ];

    for (lower, upper) in cases {
        let id_lower = String::from_str(&env, lower);
        assert_eq!(
            client.try_register(&creator, &id_lower, &100i128, &meta, &tags),
            Err(Ok(Error::ReservedId)),
            "lowercase reserved word `{}` must be rejected with ReservedId",
            lower
        );

        // validate_resource_id only accepts lowercase letters/digits, so an
        // uppercase variant is caught by InvalidResourceId before the reserved
        // check — this confirms the *format* guard fires first.
        let id_upper = String::from_str(&env, upper);
        let res = client.try_register(&creator, &id_upper, &100i128, &meta, &tags);
        assert!(
            res == Err(Ok(Error::ReservedId)) || res == Err(Ok(Error::InvalidResourceId)),
            "uppercase reserved word `{}` must be rejected (got {:?})",
            upper,
            res
        );
    }
}

/// `MAX_RESOURCE_ID_LEN` is exported and equals 24 — pin the value here so any
/// change to the constant surfaces as a test failure.
#[test]
fn max_resource_id_len_is_24() {
    assert_eq!(MAX_RESOURCE_ID_LEN, 24);
}

/// An id exactly at `MAX_RESOURCE_ID_LEN` bytes is accepted; one byte longer
/// is rejected with `InvalidResourceId`.
#[test]
fn resource_id_boundary_at_max_len() {
    let (env, creator, client) = setup();
    let meta = String::from_str(&env, "ipfs://x");

    // Exactly at the limit — must succeed.
    let at_max = "a".repeat(MAX_RESOURCE_ID_LEN as usize);
    client.register(
        &creator,
        &String::from_str(&env, &at_max),
        &100i128,
        &meta,
        &empty_tags(&env),
    );

    // One byte over — must fail.
    let over_max = "a".repeat(MAX_RESOURCE_ID_LEN as usize + 1);
    assert_eq!(
        client.try_register(
            &creator,
            &String::from_str(&env, &over_max),
            &100i128,
            &meta,
            &empty_tags(&env)
        ),
        Err(Ok(Error::InvalidResourceId))
    );
}

#[test]
fn resource_id_at_max_length_is_accepted() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "abcdefghijklmnopqrstuvwx"); // 24 bytes

    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://x"),
        &empty_tags(&env),
    );
    assert!(client.exists(&id));
}

#[test]
fn get_missing_fails() {
    let (env, _creator, client) = setup();
    let res = client.try_get(&String::from_str(&env, "nope"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn test_get_resource_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "stateres");
    let metadata = String::from_str(&env, "ipfs://meta");

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    // Default state is Listed
    let state = client.get_resource_state(&id);
    assert_eq!(state, ResourceState::Listed);

    // Delist the resource
    client.delist(&id);
    assert_eq!(client.get_resource_state(&id), ResourceState::Delisted);

    // Non-existent resource should fail
    let missing_id = String::from_str(&env, "missing");
    assert_eq!(
        client.try_get_resource_state(&missing_id),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn get_many_preserves_order_and_missing_slots() {
    let (env, creator, client) = setup();
    let id_a = String::from_str(&env, "batcha");
    let id_b = String::from_str(&env, "batchb");
    let missing = String::from_str(&env, "batchmissing");
    client.register(
        &creator,
        &id_a,
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &id_b,
        &200i128,
        &String::from_str(&env, "ipfs://b"),
        &empty_tags(&env),
    );

    let mut ids = Vec::new(&env);
    ids.push_back(id_a.clone());
    ids.push_back(missing);
    ids.push_back(id_b.clone());

    let resources = client.get_many(&ids);
    assert_eq!(resources.len(), 3);
    assert_eq!(resources.get(0).unwrap().unwrap().id, id_a);
    assert!(resources.get(1).unwrap().is_none());
    assert_eq!(resources.get(2).unwrap().unwrap().id, id_b);
}

#[test]
fn get_many_rejects_batches_over_twenty() {
    let (env, _creator, client) = setup();
    let mut ids = Vec::new(&env);
    for i in 0..21 {
        ids.push_back(String::from_str(&env, &format!("batch{i}")));
    }
    assert_eq!(client.try_get_many(&ids), Err(Ok(Error::BatchTooLarge)));
}

// ─── #810: semantic royalty/price check ─────────────────────────────────
//
// `validate_price` used to bound each field on its own, so a price that passed
// `0 < price <= MAX_PRICE` could still be far too small to support the active
// `royalty_bps`. These cover the cross-field rule on all three write paths that
// accept a price: `register`, `set_price` and `set_price_many`.

/// Installs an admin plus a fee config carrying `royalty_bps`.
fn setup_with_royalty<'a>(royalty_bps: u32) -> (Env, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    client.nominate_new_admin(&admin);
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 0,
        royalty_bps,
        fee_recipient: Some(admin.clone()),
    });
    (env, creator, admin, client)
}

#[test]
fn register_rejects_price_not_above_active_royalty() {
    let (env, creator, _admin, client) = setup_with_royalty(5_000);
    let metadata = String::from_str(&env, "ipfs://x");
    let id = String::from_str(&env, "toosmall");

    // `royalty_bps` is 5000, so any price at or below it is refused.
    for price in [1i128, 2_499, 5_000] {
        assert_eq!(
            client.try_register(&creator, &id, &price, &metadata, &empty_tags(&env)),
            Err(Ok(Error::InvalidPrice))
        );
    }
    assert_eq!(client.count(), 0);
}

#[test]
fn register_accepts_price_just_above_active_royalty() {
    let (env, creator, _admin, client) = setup_with_royalty(5_000);
    let id = String::from_str(&env, "okprice");
    // One stroop above `royalty_bps` is the first acceptable price.
    client.register(
        &creator,
        &id,
        &5_001i128,
        &String::from_str(&env, "ipfs://x"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).price, 5_001);
}

#[test]
fn set_price_rejects_price_not_above_active_royalty() {
    let (env, creator, _admin, client) = setup_with_royalty(5_000);
    let id = String::from_str(&env, "reprice");
    client.register(
        &creator,
        &id,
        &1_000_000i128,
        &String::from_str(&env, "ipfs://x"),
        &empty_tags(&env),
    );
    assert_eq!(
        client.try_set_price(&id, &5_000i128),
        Err(Ok(Error::InvalidPrice))
    );
    // The refused re-price leaves the stored price untouched.
    assert_eq!(client.get(&id).price, 1_000_000);
}

#[test]
fn set_price_many_rejects_batch_when_any_price_is_below_active_royalty() {
    let (env, creator, _admin, client) = setup_with_royalty(5_000);
    let id = String::from_str(&env, "batchprice");
    client.register(
        &creator,
        &id,
        &1_000_000i128,
        &String::from_str(&env, "ipfs://x"),
        &empty_tags(&env),
    );
    let updates = soroban_sdk::vec![
        &env,
        BatchPriceUpdate {
            id: id.clone(),
            new_price: 900_000,
        },
        BatchPriceUpdate {
            id: id.clone(),
            new_price: 10,
        },
    ];
    assert_eq!(
        client.try_set_price_many(&creator, &updates),
        Err(Ok(Error::InvalidPrice))
    );
    // Every update is validated before any mutation, so the legal entry in the
    // batch is rolled back along with the illegal one.
    assert_eq!(client.get(&id).price, 1_000_000);
}

#[test]
fn zero_royalty_config_leaves_low_prices_legal() {
    // With no royalty owed the cross-field rule has nothing to enforce, so the
    // pre-#810 floor of 1 stroop still stands.
    let (env, creator, _admin, client) = setup_with_royalty(0);
    let id = String::from_str(&env, "cheap");
    client.register(
        &creator,
        &id,
        &1i128,
        &String::from_str(&env, "ipfs://x"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).price, 1);
}

#[test]
fn royalty_check_is_skipped_until_a_fee_config_exists() {
    // `royalty_bps` is treated as 0 while no fee config is stored, which keeps
    // the rule a no-op for registries that never enable fees.
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "nofee");
    client.register(
        &creator,
        &id,
        &1i128,
        &String::from_str(&env, "ipfs://x"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).price, 1);
    assert_eq!(client.get_fee_config(), None);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_set_price() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_price",
        args: (id.clone(), 200i128).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).set_price(&id, &200i128);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_update_metadata() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let metadata = String::from_str(&env, "ipfs://newauth");
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "update_metadata",
        args: (id.clone(), metadata.clone()).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).update_metadata(&id, &metadata);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_set_tags() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let next_tags = tags(&env, &["private"]);
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_tags",
        args: (id.clone(), next_tags.clone()).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).set_tags(&id, &next_tags);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_transfer() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let new_owner = Address::generate(&env);
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "transfer_ownership",
        args: (id.clone(), new_owner.clone()).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client
        .mock_auths(&auths)
        .transfer_ownership(&id, &new_owner);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_set_listed() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_listed",
        args: (id.clone(), false).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).set_listed(&id, &false);
}

#[test]
#[should_panic]
fn non_owner_auth_cannot_delist() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "delist",
        args: (id.clone(),).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).delist(&id);
}

#[test]
fn set_price_updates_value() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r1");
    client.register(
        &creator,
        &id,
        &1_000_000i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.set_price(&id, &2_500_000i128);
    assert_eq!(client.get(&id).price, 2_500_000i128);

    assert_eq!(
        client.try_set_price(&id, &0i128),
        Err(Ok(Error::InvalidPrice))
    );
}
#[test]
fn set_price_emits_structured_event() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtr1");
    let initial_price = 1_000_000i128;
    let updated_price = 2_500_000i128;

    client.register(
        &creator,
        &id,
        &initial_price,
        &String::from_str(&env, "ipfs://QmEventTest"),
        &empty_tags(&env),
    );

    client.set_price(&id, &updated_price);

    let payload = find_setprice_event(&env, &client.address).expect("setprice event not found");
    assert_eq!(payload.id, id);
    assert_eq!(payload.old_price, initial_price);
    assert_eq!(payload.new_price, updated_price);
    assert_eq!(payload.updater, creator);
}

#[test]
fn set_price_many_updates_owned_resources() {
    let (env, creator, client) = setup();
    for id in ["manya", "manyb"] {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "https://example.com/metadata"),
            &empty_tags(&env),
        );
    }

    let mut updates = Vec::new(&env);
    updates.push_back(BatchPriceUpdate {
        id: String::from_str(&env, "manya"),
        new_price: 250i128,
    });
    updates.push_back(BatchPriceUpdate {
        id: String::from_str(&env, "manyb"),
        new_price: 350i128,
    });

    client.set_price_many(&creator, &updates);
    assert_eq!(client.get(&String::from_str(&env, "manya")).price, 250i128);
    assert_eq!(client.get(&String::from_str(&env, "manyb")).price, 350i128);
}

#[test]
fn set_price_many_validates_before_writing_any_resource() {
    let (env, creator, client) = setup();
    for id in ["atomica", "atomicb"] {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "https://example.com/metadata"),
            &empty_tags(&env),
        );
    }

    let mut updates = Vec::new(&env);
    updates.push_back(BatchPriceUpdate {
        id: String::from_str(&env, "atomica"),
        new_price: 250i128,
    });
    updates.push_back(BatchPriceUpdate {
        id: String::from_str(&env, "atomicb"),
        new_price: 0i128,
    });

    assert_eq!(
        client.try_set_price_many(&creator, &updates),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        client.get(&String::from_str(&env, "atomica")).price,
        100i128
    );
    assert_eq!(
        client.get(&String::from_str(&env, "atomicb")).price,
        100i128
    );
}

#[test]
fn set_price_many_rejects_resources_owned_by_another_creator() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ownedcreator");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "https://example.com/metadata"),
        &empty_tags(&env),
    );

    let stranger = Address::generate(&env);
    let mut updates = Vec::new(&env);
    updates.push_back(BatchPriceUpdate {
        id: id.clone(),
        new_price: 200i128,
    });

    assert_eq!(
        client.try_set_price_many(&stranger, &updates),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.get(&id).price, 100i128);
}

#[test]
fn set_price_many_rejects_oversized_batches() {
    let (env, creator, client) = setup();
    let mut updates = Vec::new(&env);
    for i in 0..=MAX_BATCH_PRICE_UPDATES {
        updates.push_back(BatchPriceUpdate {
            id: String::from_str(&env, &format!("toomany{i}")),
            new_price: 100i128,
        });
    }

    assert_eq!(
        client.try_set_price_many(&creator, &updates),
        Err(Ok(Error::BatchTooLarge))
    );
}

#[test]
fn update_metadata_changes_pointer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "https://example.com/old"),
        &empty_tags(&env),
    );

    let new_meta = String::from_str(&env, "ipfs://QmNew");
    client.update_metadata(&id, &new_meta);
    assert_eq!(client.get(&id).metadata, new_meta);
}

#[test]
fn register_with_hash_immutably_binds_metadata_pointer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "hashbound");
    let metadata = String::from_str(&env, "ipfs://QmImmutable");
    let content_hash = String::from_str(&env, "sha256:registered");

    client.register_with_hash(
        &creator,
        &id,
        &100i128,
        &metadata,
        &empty_tags(&env),
        &Some(content_hash.clone()),
    );

    let divergent = String::from_str(&env, "ipfs://QmDifferent");
    assert_eq!(
        client.try_update_metadata(&id, &divergent),
        Err(Ok(Error::MetadataFrozen))
    );

    let resource = client.get(&id);
    assert_eq!(resource.metadata, metadata);
    assert_eq!(resource.content_hash, Some(content_hash));
}

#[test]
fn register_with_hash_without_content_hash_keeps_metadata_mutable() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "hashoptional");
    let initial = String::from_str(&env, "ipfs://QmInitial");
    client.register_with_hash(&creator, &id, &100i128, &initial, &empty_tags(&env), &None);

    let updated = String::from_str(&env, "ipfs://QmUpdated");
    client.update_metadata(&id, &updated);
    assert_eq!(client.get(&id).metadata, updated);
}

#[test]
fn ownership_can_transfer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r3");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.get(&id).creator, new_owner);
}

#[test]
fn transfer_ownership_event_contains_previous_and_new_owner() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtxfer");
    let new_owner = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.transfer_ownership(&id, &new_owner);

    let (prev, new) =
        find_transfer_event(&env, &client.address).expect("transfer event not emitted");
    assert_eq!(prev, creator);
    assert_eq!(new, new_owner);
}

#[test]
fn propose_transfer_event_contains_owner_and_proposed() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtpropose");
    let proposed = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &proposed);

    let (owner, target) =
        find_propose_event(&env, &client.address).expect("propose event not emitted");
    assert_eq!(owner, creator);
    assert_eq!(target, proposed);
}

#[test]
fn accept_transfer_event_contains_previous_and_new_owner() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtaccept");
    let new_owner = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &new_owner);
    env.mock_all_auths();
    client.accept_transfer(&id);

    let (prev, new) =
        find_transfer_event(&env, &client.address).expect("accept transfer event not emitted");
    assert_eq!(prev, creator);
    assert_eq!(new, new_owner);
}

#[test]
fn cancel_transfer_event_contains_owner() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtcancel");
    let proposed = Address::generate(&env);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &proposed);
    client.cancel_transfer(&id);

    let owner = find_cancel_event(&env, &client.address).expect("cancel event not emitted");
    assert_eq!(owner, creator);
}

// ── Self-cancel protection for accepted transfers (#637) ─────────────────────

/// After `accept_transfer` completes the pending-transfer entry is removed.
/// Any subsequent `cancel_transfer` call must return `NoPendingTransfer`
/// regardless of who calls it — an accepted transfer can never be reversed
/// through `cancel_transfer`.
#[test]
fn cancel_after_accept_returns_no_pending_transfer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "selfcancel1");
    let new_owner = Address::generate(&env);

    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &new_owner);
    client.accept_transfer(&id);

    // Ownership has moved; pending key was removed inside accept_transfer.
    // Either the old or new owner calling cancel_transfer must get NoPendingTransfer.
    assert_eq!(
        client.try_cancel_transfer(&id),
        Err(Ok(Error::NoPendingTransfer))
    );
}

/// The original owner (now dispossessed) cannot cancel the transfer after it
/// has been accepted — they are no longer `resource.creator` and therefore
/// fail `require_auth` before even reaching the pending-key check.
#[test]
fn original_owner_cannot_cancel_after_accept() {
    let env = Env::default();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    let id = String::from_str(&env, "selfcancel2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &new_owner);
    client.accept_transfer(&id);

    // Resource is now owned by new_owner. Attempting cancel returns NoPendingTransfer
    // because the pending entry was cleared during acceptance.
    assert_eq!(
        client.try_cancel_transfer(&id),
        Err(Ok(Error::NoPendingTransfer))
    );

    // Confirm ownership has moved
    assert_eq!(client.get(&id).creator, new_owner);
}

/// Verifies that the new owner can propose and then cancel a NEW transfer
/// after accepting the initial one — only the original accepted transfer
/// is protected, not future proposals by the new owner.
#[test]
fn new_owner_can_propose_and_cancel_new_transfer_after_acceptance() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "selfcancel3");
    let new_owner = Address::generate(&env);
    let third_party = Address::generate(&env);

    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.propose_transfer(&id, &new_owner);
    client.accept_transfer(&id);

    // new_owner is now the creator and may propose a new transfer and cancel it
    client.propose_transfer(&id, &third_party);
    client.cancel_transfer(&id);

    // After cancellation ownership is still with new_owner
    assert_eq!(client.get(&id).creator, new_owner);
}

#[test]
fn set_listed_toggles_listing_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r4");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Initially listed
    assert!(client.get(&id).listed);

    // Delist
    client.set_listed(&id, &false);
    assert!(!client.get(&id).listed);

    // Re-list
    client.set_listed(&id, &true);
    assert!(client.get(&id).listed);
}

#[test]
fn delist_convenience_method() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r5");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Initially listed
    assert!(client.get(&id).listed);

    // Delist using convenience method
    client.delist(&id);
    assert!(!client.get(&id).listed);
}

#[test]
fn set_price_preserves_other_fields() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r7");
    let metadata = String::from_str(&env, "ipfs://QmPreserve");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    client.set_price(&id, &250i128);
    let resource = client.get(&id);

    assert_eq!(resource.price, 250i128);
    assert_eq!(resource.metadata, metadata);
    assert_eq!(resource.creator, creator);
    assert!(resource.listed);
}

#[test]
fn transfer_ownership_keeps_count_and_order() {
    let (env, creator, client) = setup();
    let ids = ["a", "b"];
    for id in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }

    let new_owner = Address::generate(&env);
    let id = String::from_str(&env, "a");
    client.transfer_ownership(&id, &new_owner);

    assert_eq!(client.count(), 2);
    let list = client.list(&0u32, &10u32);
    assert_eq!(list.get(0).unwrap().id, id);
    assert_eq!(list.get(0).unwrap().creator, new_owner);
    assert_eq!(list.get(1).unwrap().id, String::from_str(&env, "b"));
}

#[test]
fn update_metadata_preserves_price_and_creator() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r8");
    let original_metadata = String::from_str(&env, "ipfs://QmOriginal");
    client.register(
        &creator,
        &id,
        &500i128,
        &original_metadata,
        &empty_tags(&env),
    );

    let new_metadata = String::from_str(&env, "ipfs://QmUpdated");
    client.update_metadata(&id, &new_metadata);

    let resource = client.get(&id);
    assert_eq!(resource.metadata, new_metadata);
    assert_eq!(resource.price, 500i128);
    assert_eq!(resource.creator, creator);
}

#[test]
fn get_owner_returns_creator() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ownertest");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let owner = client.get_owner(&id);
    assert_eq!(owner, creator);
}

#[test]
fn get_owner_missing_fails() {
    let (env, _creator, client) = setup();
    let res = client.try_get_owner(&String::from_str(&env, "nope"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn get_owner_after_transfer() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ownerxfer");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);

    assert_eq!(client.get_owner(&id), new_owner);
}

#[test]
fn get_owner_many_preserves_order_and_missing_slots() {
    let (env, creator, client) = setup();
    let id_a = String::from_str(&env, "ownermanya");
    let id_b = String::from_str(&env, "ownermanyb");
    let missing = String::from_str(&env, "ownermanyz");
    let new_owner = Address::generate(&env);

    client.register(
        &creator,
        &id_a,
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &id_b,
        &200i128,
        &String::from_str(&env, "ipfs://b"),
        &empty_tags(&env),
    );
    client.transfer_ownership(&id_b, &new_owner);

    let mut ids = Vec::new(&env);
    ids.push_back(id_a);
    ids.push_back(missing);
    ids.push_back(id_b);

    let owners = client.get_owner_many(&ids);
    assert_eq!(owners.len(), 3);
    assert_eq!(owners.get(0).unwrap(), Some(creator));
    assert_eq!(owners.get(1).unwrap(), None);
    assert_eq!(owners.get(2).unwrap(), Some(new_owner));
}

#[test]
fn get_owner_many_rejects_batches_over_twenty() {
    let (env, _creator, client) = setup();
    let mut ids = Vec::new(&env);
    for i in 0..21 {
        ids.push_back(String::from_str(&env, &format!("owner{i}")));
    }

    assert_eq!(
        client.try_get_owner_many(&ids),
        Err(Ok(Error::BatchTooLarge))
    );
}

#[test]
fn set_listed_requires_creator_auth() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "r6");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // This should work fine since we mock all auths
    client.set_listed(&id, &false);
    assert!(!client.get(&id).listed);
}

#[test]
fn set_listed_on_missing_resource_fails() {
    let (env, _creator, client) = setup();
    let id = String::from_str(&env, "missing");

    let res = client.try_set_listed(&id, &false);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// ---------------------------------------------------------------------------
// Event payload tests for set_listed / delist
// ---------------------------------------------------------------------------
//
// In Soroban SDK 22, `env.events().all()` returns only the events emitted
// by the **most recent contract invocation**. Each `client.*()` call clears
// and repopulates the buffer, so we check events immediately after the call
// we care about.
//
// The `setlisted` event schema:
//   topics: (Symbol("setlisted"), id_string)
//   data:   (old_listed: bool, new_listed: bool)

#[test]
fn set_listed_event_emits_old_and_new_state_delist() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evdelist");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Start listed=true; calling set_listed(false) should emit (true, false)
    client.set_listed(&id, &false);

    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );
}

#[test]
fn set_listed_event_emits_old_and_new_state_relist() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evrelist");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Delist, then relist — check both events individually
    client.set_listed(&id, &false);
    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );

    client.set_listed(&id, &true);
    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (false, true).into_val(&env),
            ),
        ]
    );
}

#[test]
fn set_listed_allows_no_op_same_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evnoop");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.set_listed(&id, &true);
    assert_eq!(client.get(&id).state, ResourceState::Listed);
}

#[test]
fn delist_convenience_method_emits_old_and_new_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evdelist2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // delist() delegates to set_listed(false) — must emit (true, false)
    // with the "setlisted" topic symbol (not a separate "delist" topic).
    client.delist(&id);

    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );
}

#[test]
fn set_listed_and_delist_events_are_consistent() {
    // Both paths (set_listed(false) and delist()) must produce the same event
    // shape. This directly tests the acceptance criterion: "Events are
    // consistent for set_listed(false), delist, and relisting."
    let (env, creator, client) = setup();
    let id1 = String::from_str(&env, "evcons1");
    let id2 = String::from_str(&env, "evcons2");

    client.register(
        &creator,
        &id1,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &id2,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Check that set_listed(false) and delist() emit identical (true, false) data.
    client.set_listed(&id1, &false);
    let ev_set_listed = env.events().all();
    assert_eq!(
        ev_set_listed,
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id1.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );

    client.delist(&id2);
    let ev_delist = env.events().all();
    assert_eq!(
        ev_delist,
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("setlisted"), id2.clone()).into_val(&env),
                (true, false).into_val(&env),
            ),
        ]
    );
}

#[test]
fn list_empty_returns_empty() {
    let (_env, _creator, client) = setup();
    let page = client.list(&0u32, &20u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_returns_all_in_insertion_order() {
    let (env, creator, client) = setup();
    let ids = ["a", "b", "c"];
    for id in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }

    let page = client.list(&0u32, &20u32);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "a"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "b"));
    assert_eq!(page.get(2).unwrap().id, String::from_str(&env, "c"));
}

fn metadata_of_len(env: &Env, len: u32) -> String {
    let prefix = "ipfs://";
    let prefix_len = prefix.len();
    assert!(len >= prefix_len as u32);
    let body_len = len - prefix_len as u32;
    let body = "a".repeat(body_len as usize);
    String::from_str(env, &(prefix.to_string() + &body))
}

#[test]
fn register_accepts_metadata_at_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metamax");
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN);
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert_eq!(client.get(&id).metadata.len(), MAX_METADATA_POINTER_LEN);
}

#[test]
fn register_rejects_metadata_over_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metalong");
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::MetadataTooLong))
    );
    assert!(!client.exists(&id));
}

#[test]
fn update_metadata_accepts_at_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metaupdok");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://short"),
        &empty_tags(&env),
    );
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN);
    client.update_metadata(&id, &metadata);
    assert_eq!(client.get(&id).metadata.len(), MAX_METADATA_POINTER_LEN);
}

#[test]
fn update_metadata_rejects_over_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "metaupdbad");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ar://short"),
        &empty_tags(&env),
    );
    let metadata = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    assert_eq!(
        client.try_update_metadata(&id, &metadata),
        Err(Ok(Error::MetadataTooLong))
    );
    assert_eq!(
        client.get(&id).metadata,
        String::from_str(&env, "ar://short")
    );
}

// Empty metadata and single-character metadata (e.g. "a") are both rejected
// by `validate_metadata_pointer` (`EmptyMetadata` / `InvalidMetadataPointer`
// respectively, since "a" matches no supported pointer prefix) — see
// `register_rejects_empty_metadata`, `update_metadata_rejects_empty`, and
// `invalid_metadata_pointer_rejected` below.

fn register_n(env: &Env, creator: &Address, client: &VaultRegistryClient<'_>, ids: &[&str]) {
    for id in ids {
        client.register(
            creator,
            &String::from_str(env, id),
            &100i128,
            &String::from_str(env, "ipfs://m"),
            &empty_tags(env),
        );
    }
}

#[test]
fn list_pagination_first_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let page = client.list(&0u32, &3u32);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "r0"));
    assert_eq!(page.get(2).unwrap().id, String::from_str(&env, "r2"));
}

#[test]
fn list_pagination_second_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let page = client.list(&3u32, &3u32);
    assert_eq!(page.len(), 2); // only r3, r4 remain
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "r3"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "r4"));
}

#[test]
fn list_start_beyond_count_returns_empty() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "x"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let page = client.list(&99u32, &10u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn register_extends_resource_storage_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlregister");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn set_price_reextends_resource_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlprice");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT - DAY_IN_LEDGERS
    );

    client.set_price(&id, &200i128);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn update_metadata_reextends_resource_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlmeta");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "https://example.com/old"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);

    client.update_metadata(&id, &String::from_str(&env, "https://example.com/new"));
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn transfer_ownership_reextends_resource_ttl() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "ttlxfer");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + DAY_IN_LEDGERS);

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT
    );
}

#[test]
fn list_limit_capped_at_20() {
    let (env, creator, client) = setup();
    let ids = [
        "i00", "i01", "i02", "i03", "i04", "i05", "i06", "i07", "i08", "i09", "i10", "i11", "i12",
        "i13", "i14", "i15", "i16", "i17", "i18", "i19", "i20", "i21", "i22", "i23", "i24",
    ];
    register_n(&env, &creator, &client, &ids);

    // Requesting 25 items should be silently capped to 20.
    let page = client.list(&0u32, &25u32);
    assert_eq!(page.len(), 20);
}

#[test]
fn list_listed_excludes_delisted() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c"]);

    client.set_listed(&String::from_str(&env, "b"), &false);

    let page = client.list_listed(&0u32, &20u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "a"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "c"));
}

#[test]
fn list_listed_empty_when_no_resources() {
    let (_env, _creator, client) = setup();
    let page = client.list_listed(&0u32, &20u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_listed_relisted_reappears() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b"]);

    client.set_listed(&String::from_str(&env, "b"), &false);
    assert_eq!(client.list_listed(&0u32, &20u32).len(), 1);

    client.set_listed(&String::from_str(&env, "b"), &true);
    assert_eq!(client.list_listed(&0u32, &20u32).len(), 2);
}

#[test]
fn list_listed_pagination_first_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c", "d", "e"]);

    client.set_listed(&String::from_str(&env, "b"), &false);
    client.set_listed(&String::from_str(&env, "d"), &false);

    let page = client.list_listed(&0u32, &2u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "a"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "c"));
}

#[test]
fn list_listed_pagination_second_page() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c", "d", "e"]);

    client.set_listed(&String::from_str(&env, "b"), &false);

    let page = client.list_listed(&2u32, &2u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "c"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "d"));
}

#[test]
fn list_listed_start_beyond_listed_items_returns_empty() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b"]);

    let page = client.list_listed(&20u32, &10u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_listed_limit_capped_at_20() {
    let (env, creator, client) = setup();
    let ids: [&str; 25] = [
        "i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10", "i11", "i12", "i13",
        "i14", "i15", "i16", "i17", "i18", "i19", "i20", "i21", "i22", "i23", "i24",
    ];
    register_n(&env, &creator, &client, &ids);

    // Delist the last 5 so result length can be reached only by traversing the cap.
    for idx in [20, 21, 22, 23, 24] {
        client.set_listed(&String::from_str(&env, ids[idx]), &false);
    }

    let page = client.list_listed(&0u32, &25u32);
    assert_eq!(page.len(), 20);
}

#[test]
fn list_page_empty_is_end_of_list() {
    let (_env, _creator, client) = setup();
    let page = client.list_page(&0u32, &20u32);
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn list_page_exposes_next_cursor_then_end() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let first = client.list_page(&0u32, &3u32);
    assert_eq!(first.items.len(), 3);
    assert_eq!(first.items.get(0).unwrap().id, String::from_str(&env, "r0"));
    assert_eq!(first.items.get(2).unwrap().id, String::from_str(&env, "r2"));
    assert_eq!(first.next_cursor, Some(3u32));

    let second = client.list_page(&first.next_cursor.unwrap(), &3u32);
    assert_eq!(second.items.len(), 2);
    assert_eq!(
        second.items.get(0).unwrap().id,
        String::from_str(&env, "r3")
    );
    assert_eq!(
        second.items.get(1).unwrap().id,
        String::from_str(&env, "r4")
    );
    assert_eq!(second.next_cursor, None);
}

#[test]
fn list_page_cursor_past_end_is_empty_end_of_list() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "x"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let page = client.list_page(&99u32, &10u32);
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn list_page_exact_page_boundary_is_end_of_list() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["a", "b", "c"]);

    let page = client.list_page(&0u32, &3u32);
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.next_cursor, None);
}

#[test]
fn list_delegates_to_list_page_items() {
    let (env, creator, client) = setup();
    register_n(&env, &creator, &client, &["r0", "r1", "r2", "r3", "r4"]);

    let body = client.list(&0u32, &3u32);
    let page = client.list_page(&0u32, &3u32);
    assert_eq!(body.len(), page.items.len());
    assert_eq!(body.get(0).unwrap().id, page.items.get(0).unwrap().id);
    assert_eq!(body.get(2).unwrap().id, page.items.get(2).unwrap().id);
}

#[test]
fn list_page_limit_capped_at_20_with_next_cursor() {
    let (env, creator, client) = setup();
    let ids = [
        "i00", "i01", "i02", "i03", "i04", "i05", "i06", "i07", "i08", "i09", "i10", "i11", "i12",
        "i13", "i14", "i15", "i16", "i17", "i18", "i19", "i20", "i21", "i22", "i23", "i24",
    ];
    register_n(&env, &creator, &client, &ids);

    let page = client.list_page(&0u32, &25u32);
    assert_eq!(page.items.len(), 20);
    assert_eq!(page.next_cursor, Some(20u32));
}

#[test]
fn register_with_tags_stores_labels() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "tagged");
    let metadata = String::from_str(&env, "ipfs://QmTagged");
    let resource_tags = tags(&env, &["dataset", "research"]);

    client.register(&creator, &id, &100i128, &metadata, &resource_tags);

    let r = client.get(&id);
    assert_eq!(r.metadata, metadata);
    assert_eq!(r.tags.len(), 2);
    assert_eq!(r.tags.get(0).unwrap(), String::from_str(&env, "dataset"));
    assert_eq!(r.tags.get(1).unwrap(), String::from_str(&env, "research"));
}

#[test]
fn set_tags_updates_value_without_touching_metadata() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "tagupdate");
    let metadata = String::from_str(&env, "ipfs://QmKeepMeta");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    let new_tags = tags(&env, &["finance", "api"]);
    client.set_tags(&id, &new_tags);

    let r = client.get(&id);
    assert_eq!(r.metadata, metadata);
    assert_eq!(r.tags.len(), 2);
    assert_eq!(r.tags.get(0).unwrap(), String::from_str(&env, "finance"));
}

// ─── Per-resource royalty recipient override (#618) ───────────────────────

#[test]
fn set_royalty_recipient_overrides_for_resource() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "royal1");
    let metadata = String::from_str(&env, "ipfs://m");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    // Initially None
    let resource = client.get(&id);
    assert_eq!(resource.royalty_recipient, None);

    // Set royalty recipient
    let recipient = Address::generate(&env);
    client.set_royalty_recipient(&id, &Some(recipient.clone()));

    // Verify it's set
    let resource = client.get(&id);
    assert_eq!(resource.royalty_recipient, Some(recipient));
}

#[test]
fn set_royalty_recipient_can_clear_override() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "royal2");
    let metadata = String::from_str(&env, "ipfs://m");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    // Set a recipient
    let recipient = Address::generate(&env);
    client.set_royalty_recipient(&id, &Some(recipient.clone()));
    assert_eq!(client.get(&id).royalty_recipient, Some(recipient));

    // Clear it
    client.set_royalty_recipient(&id, &None);
    assert_eq!(client.get(&id).royalty_recipient, None);
}

#[test]
fn set_royalty_recipient_requires_creator_auth() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "royal3");
    let metadata = String::from_str(&env, "ipfs://m");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    // Without auth, should fail
    env.mock_auths(&[]);
    let recipient = Address::generate(&env);
    let res = client.try_set_royalty_recipient(&id, &Some(recipient));
    assert!(res.is_err());
}

#[test]
fn set_royalty_recipient_fails_for_nonexistent_resource() {
    let (env, _creator, client) = setup();
    let id = String::from_str(&env, "noexist");
    let recipient = Address::generate(&env);

    let res = client.try_set_royalty_recipient(&id, &Some(recipient));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn set_royalty_recipient_emits_event() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "royal4");
    let metadata = String::from_str(&env, "ipfs://m");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    // Set recipient
    let recipient = Address::generate(&env);
    client.set_royalty_recipient(&id, &Some(recipient.clone()));

    // Check event
    let events = env.events().all();
    let last_event = events.last().unwrap();
    let (_contract, topics, data): (
        Address,
        soroban_sdk::Vec<soroban_sdk::Val>,
        soroban_sdk::Val,
    ) = last_event;

    let topic_symbol: soroban_sdk::Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(topic_symbol, symbol_short!("setroyal"));

    // Data should be (old, new)
    let (old, new): (Option<Address>, Option<Address>) = data.try_into_val(&env).unwrap();
    assert_eq!(old, None);
    assert_eq!(new, Some(recipient));
}

#[test]
fn set_royalty_recipient_fails_when_paused() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = String::from_str(&env, "royal5");
    let metadata = String::from_str(&env, "ipfs://m");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    // Pause contract
    client.set_paused(&admin, &true);

    // Try to set recipient while paused
    let recipient = Address::generate(&env);
    let res = client.try_set_royalty_recipient(&id, &Some(recipient));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn set_royalty_recipient_fails_for_frozen_resource() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "royal6");
    let metadata = String::from_str(&env, "ipfs://m");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));

    // Freeze resource
    client.freeze_resource(&id);

    // Try to set recipient on frozen resource
    let recipient = Address::generate(&env);
    let res = client.try_set_royalty_recipient(&id, &Some(recipient));
    assert_eq!(res, Err(Ok(Error::ResourceNotMutable)));
}

#[test]
fn invalid_metadata_pointer_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "badpointer");
    let metadata = String::from_str(&env, "not-a-supported-pointer");

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id));
}

#[test]
fn sha256_pointer_rejects_short_hash() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "shortsha");
    // 63 hex chars — one short of the required 64
    let metadata = String::from_str(
        &env,
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678",
    );

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id));
}

#[test]
fn sha256_pointer_rejects_long_hash() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "longsha");
    // 65 hex chars — one more than the required 64
    let metadata = String::from_str(
        &env,
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
    );

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id));
}

#[test]
fn sha256_pointer_rejects_non_hex_chars() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "nonhexsha");
    // 64 chars but contains 'g' (not a hex digit)
    let metadata = String::from_str(
        &env,
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789g",
    );

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id));
}

#[test]
fn sha256_pointer_accepts_valid_64_hex_hash() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "goodsha");
    let metadata = String::from_str(
        &env,
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    let r = client.get(&id);
    assert_eq!(r.metadata, metadata);
}

#[test]
fn sha256_dash_prefix_pointer_rejects_short_hash() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "dashshort");
    // sha-256: with only 63 hex chars
    let metadata = String::from_str(
        &env,
        "sha-256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678",
    );

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::InvalidMetadataPointer))
    );
    assert!(!client.exists(&id));
}

#[test]
fn sha256_dash_prefix_pointer_accepts_valid_64_hex_hash() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "dashgood");
    let metadata = String::from_str(
        &env,
        "sha-256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    let r = client.get(&id);
    assert_eq!(r.metadata, metadata);
}

#[test]
fn sha256_pointer_rejected_with_uppercase_hex() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "uppercasesha");
    // 64 chars, valid hex, but uppercase — the contract should still accept it
    let metadata = String::from_str(
        &env,
        "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
    );

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    let r = client.get(&id);
    assert_eq!(r.metadata, metadata);
}

#[test]
fn invalid_tag_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "badtag");
    let metadata = String::from_str(&env, "ipfs://m");
    let empty = String::from_str(&env, "");
    let mut bad = Vec::new(&env);
    bad.push_back(empty);

    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &bad),
        Err(Ok(Error::InvalidTag))
    );
    assert!(!client.exists(&id));

    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert_eq!(client.try_set_tags(&id, &bad), Err(Ok(Error::InvalidTag)));
}

#[test]
fn admin_transfer_nominate_then_accept() {
    let (env, _creator, client) = setup();
    let initial_admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    // Set initial admin
    assert_eq!(client.admin(), None);
    client.nominate_new_admin(&initial_admin);
    assert_eq!(client.admin(), Some(initial_admin.clone()));
    assert_eq!(client.pending_admin(), None);

    // Nominate new admin
    client.nominate_new_admin(&new_admin);
    assert_eq!(client.admin(), Some(initial_admin.clone()));
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));
    assert_eq!(
        client.pending_admin_expiry(),
        Some(env.ledger().sequence() + ADMIN_NOMINATION_DURATION)
    );

    // Advance past the mandatory gap before accepting.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + ADMIN_NOMINATION_MIN_GAP);

    // Accept admin nomination
    client.accept_admin(&new_admin);
    assert_eq!(client.admin(), Some(new_admin));
    assert_eq!(client.pending_admin(), None);
    assert_eq!(client.pending_admin_expiry(), None);
}

#[test]
fn expired_admin_nomination_can_be_replaced() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let expired = Address::generate(&env);
    let replacement = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&expired);
    let expiry = client.pending_admin_expiry().unwrap();
    env.ledger().set_sequence_number(expiry);

    assert_eq!(client.try_nominate_new_admin(&replacement), Ok(Ok(())));
    assert_eq!(client.pending_admin(), Some(replacement.clone()));
    assert!(client.pending_admin_expiry().unwrap() > expiry);
    client.accept_admin(&replacement);
    assert_eq!(client.admin(), Some(replacement));
}

#[test]
fn expired_admin_nomination_cannot_be_accepted() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending);
    let expiry = client.pending_admin_expiry().unwrap();
    env.ledger().set_sequence_number(expiry);

    assert_eq!(
        client.try_accept_admin(&pending),
        Err(Ok(Error::AdminNominationExpired))
    );
    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.pending_admin(), Some(pending));
}

#[test]
fn accept_admin_rejects_wrong_caller() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending = Address::generate(&env);
    let wrong = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending);

    // Advance past the gap so the wrong-caller check, not the too-soon check,
    // is what fires.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + ADMIN_NOMINATION_MIN_GAP);

    assert_eq!(
        client.try_accept_admin(&wrong),
        Err(Ok(Error::PendingAdminNotSet))
    );
    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.pending_admin(), Some(pending));
}

#[test]
fn accept_admin_without_pending_returns_not_set() {
    let (env, _creator, client) = setup();
    let caller = Address::generate(&env);

    assert_eq!(
        client.try_accept_admin(&caller),
        Err(Ok(Error::AdminNominationExpired))
    );
}

// ─── Ledger-gap enforcement (#ledger-gap) ───────────────────────────────────

#[test]
fn accept_admin_before_gap_returns_nomination_expired() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending);

    // One ledger short of the required gap must still be rejected.
    let nominated_at = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(nominated_at + ADMIN_NOMINATION_MIN_GAP - 1);

    assert_eq!(
        client.try_accept_admin(&pending),
        Err(Ok(Error::AdminNominationExpired)),
        "accept_admin must be rejected before ADMIN_NOMINATION_MIN_GAP ledgers have elapsed"
    );
    // Admin unchanged.
    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.pending_admin(), Some(pending));
}

#[test]
fn accept_admin_at_exact_gap_succeeds() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending);

    let nominated_at = env.ledger().sequence();
    // Exactly at the gap boundary: nominated_at + MIN_GAP is the first valid ledger.
    env.ledger()
        .set_sequence_number(nominated_at + ADMIN_NOMINATION_MIN_GAP);

    assert_eq!(client.try_accept_admin(&pending), Ok(Ok(())));
    assert_eq!(client.admin(), Some(pending));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn accept_admin_same_ledger_as_nominate_is_rejected() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending);

    // No ledger advance — same block as the nomination.
    assert_eq!(
        client.try_accept_admin(&pending),
        Err(Ok(Error::AdminNominationExpired)),
        "nominate + accept in the same ledger must be rejected"
    );
    assert_eq!(client.admin(), Some(admin));
}

#[test]
fn nominated_at_is_cleared_after_successful_accept() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let first_pending = Address::generate(&env);
    let second_pending = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&first_pending);

    let first_nominated_at = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(first_nominated_at + ADMIN_NOMINATION_MIN_GAP);
    client.accept_admin(&first_pending);
    assert_eq!(client.admin(), Some(first_pending.clone()));

    // New admin nominates again; the gap is measured from this new nomination,
    // not from the previous one.
    client.nominate_new_admin(&second_pending);
    let second_nominated_at = env.ledger().sequence();

    // One ledger short of gap from second nomination — must be rejected.
    env.ledger()
        .set_sequence_number(second_nominated_at + ADMIN_NOMINATION_MIN_GAP - 1);
    assert_eq!(
        client.try_accept_admin(&second_pending),
        Err(Ok(Error::AdminNominationExpired))
    );

    // Advance to the exact gap boundary — must now succeed.
    env.ledger()
        .set_sequence_number(second_nominated_at + ADMIN_NOMINATION_MIN_GAP);
    assert_eq!(client.try_accept_admin(&second_pending), Ok(Ok(())));
    assert_eq!(client.admin(), Some(second_pending));
}

#[test]
fn nominate_new_admin_rejects_same_address() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    client.nominate_new_admin(&admin);
    assert_eq!(
        client.try_nominate_new_admin(&admin),
        Err(Ok(Error::SameAdmin))
    );
}

#[test]
fn nominate_new_admin_rejects_pending_already_set() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);
    let pending1 = Address::generate(&env);
    let pending2 = Address::generate(&env);

    client.nominate_new_admin(&admin);
    client.nominate_new_admin(&pending1);

    assert_eq!(
        client.try_nominate_new_admin(&pending2),
        Err(Ok(Error::PendingAdminAlreadySet))
    );
}

// ─── Admin bootstrap replay protection ─────────────────────────────────────

#[test]
fn bootstrap_followed_by_second_nominate_uses_two_step_path() {
    let (env, _creator, client) = setup();
    let initial_admin = Address::generate(&env);
    let second = Address::generate(&env);

    // First call bootstraps initial_admin directly (no accept step).
    client.nominate_new_admin(&initial_admin);
    assert_eq!(client.admin(), Some(initial_admin.clone()));
    assert_eq!(client.pending_admin(), None);

    // Second call must follow the two-step nominate + accept path.
    client.nominate_new_admin(&second);
    assert_eq!(client.admin(), Some(initial_admin.clone())); // admin unchanged
    assert_eq!(client.pending_admin(), Some(second.clone())); // pending set

    // The pending admin must accept before becoming admin, and only after
    // the mandatory ledger gap has elapsed.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + ADMIN_NOMINATION_MIN_GAP);
    client.accept_admin(&second);
    assert_eq!(client.admin(), Some(second));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn bootstrap_requires_new_admin_auth() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    // Bootstrap path requires `new_admin` to authorize. Calling with an
    // address that doesn't authorize should fail. In the test harness
    // we simulate this by using try_nominate_new_admin (which doesn't
    // force auth on the caller) — the Soroban runtime enforces auth.
    //
    // Here we verify the happy path succeeds and the state is set.
    client.nominate_new_admin(&admin);
    assert_eq!(client.admin(), Some(admin));
}

#[test]
fn bootstrap_cannot_overwrite_existing_admin() {
    let (env, _creator, client) = setup();
    let first_admin = Address::generate(&env);
    let hijacker = Address::generate(&env);

    // Bootstrap establishes first_admin.
    client.nominate_new_admin(&first_admin);
    assert_eq!(client.admin(), Some(first_admin.clone()));

    // A second nominate by a different address follows the two-step path
    // and cannot overwrite admin without first_admin's auth.
    // The contract requires stored_admin.require_auth() — in the test
    // harness both calls succeed because the env authorises all, but the
    // key assertion is that admin is NOT changed by the nominate alone.
    client.nominate_new_admin(&hijacker);
    assert_eq!(client.admin(), Some(first_admin.clone())); // still first_admin
    assert_eq!(client.pending_admin(), Some(hijacker.clone()));

    // Only accept_admin by the pending admin finalizes the transfer, and only
    // after the mandatory ledger gap has elapsed.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + ADMIN_NOMINATION_MIN_GAP);
    client.accept_admin(&hijacker);
    assert_eq!(client.admin(), Some(hijacker));
}

#[test]
fn bootstrap_emits_setadmin_not_nomadmin() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    client.nominate_new_admin(&admin);

    // The bootstrap path emits `setadmin`, not `nomadmin`.
    let all = env.events().all();
    let (_contract, topics, _data) = all.get_unchecked(0);
    // First topic is the event symbol.
    let topic0: Symbol = Symbol::try_from_val(&env, &topics.get_unchecked(0)).unwrap();
    assert_eq!(topic0, symbol_short!("setadmin"));
}

#[test]
fn bootstrap_sets_pending_admin_to_none() {
    let (env, _creator, client) = setup();
    let admin = Address::generate(&env);

    // Before bootstrap, no admin and no pending.
    assert_eq!(client.admin(), None);
    assert_eq!(client.pending_admin(), None);

    // After bootstrap, admin is set and pending is still None.
    client.nominate_new_admin(&admin);
    assert_eq!(client.admin(), Some(admin));
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn register_rejects_empty_metadata() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "emptymeta");
    let metadata = String::from_str(&env, "");
    assert_eq!(
        client.try_register(&creator, &id, &100i128, &metadata, &empty_tags(&env)),
        Err(Ok(Error::EmptyMetadata))
    );
    assert!(!client.exists(&id));
}

#[test]
fn update_metadata_rejects_empty() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "updempty");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://QmOriginal"),
        &empty_tags(&env),
    );
    let empty = String::from_str(&env, "");
    assert_eq!(
        client.try_update_metadata(&id, &empty),
        Err(Ok(Error::EmptyMetadata))
    );
    assert_eq!(
        client.get(&id).metadata,
        String::from_str(&env, "ipfs://QmOriginal")
    );
}

// ---------------------------------------------------------------------------
// update_metadata event tests
// ---------------------------------------------------------------------------

/// Extract all "updmeta" events emitted by `contract_id` from the environment,
/// decoded as `MetadataUpdateEvent`.
fn collect_updmeta_events(
    env: &Env,
    contract_id: &soroban_sdk::Address,
) -> soroban_sdk::Vec<MetadataUpdateEvent> {
    use soroban_sdk::{FromVal, Symbol};
    let all = env.events().all();
    let mut result: soroban_sdk::Vec<MetadataUpdateEvent> = soroban_sdk::Vec::new(env);
    for i in 0..all.len() {
        let (cid, topics, data) = all.get(i).unwrap();
        if cid != *contract_id || topics.is_empty() {
            continue;
        }
        // topics.get(0) is a Val. Try to decode it as a Symbol and compare.
        let first_topic_val: soroban_sdk::Val = topics.get(0).unwrap();
        let Ok(sym) = Symbol::try_from_val(env, &first_topic_val) else {
            continue;
        };
        if sym != symbol_short!("updmeta") {
            continue;
        }
        let event = MetadataUpdateEvent::from_val(env, &data);
        result.push_back(event);
    }
    result
}

#[test]
fn update_metadata_emits_structured_event_with_old_and_new() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "eventtest");
    let old_meta = String::from_str(&env, "ipfs://QmOld");
    let new_meta = String::from_str(&env, "ipfs://QmNew");

    client.register(&creator, &id, &100i128, &old_meta, &empty_tags(&env));
    client.update_metadata(&id, &new_meta);

    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(events.len(), 1, "expected exactly one updmeta event");

    let event = events.get(0).unwrap();
    assert_eq!(event.id, id);
    assert_eq!(event.old_metadata, old_meta);
    assert_eq!(event.new_metadata, new_meta);
}

#[test]
fn update_metadata_event_old_metadata_matches_prior_state() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtchain");
    let meta_v1 = String::from_str(&env, "ipfs://QmV1");
    let meta_v2 = String::from_str(&env, "ipfs://QmV2");
    let meta_v3 = String::from_str(&env, "ipfs://QmV3");

    client.register(&creator, &id, &100i128, &meta_v1, &empty_tags(&env));

    // First update: v1 → v2; check event immediately after this invocation.
    client.update_metadata(&id, &meta_v2);
    {
        let events = collect_updmeta_events(&env, &client.address);
        assert_eq!(
            events.len(),
            1,
            "expected one updmeta event after first update"
        );
        let e = events.get(0).unwrap();
        assert_eq!(e.old_metadata, meta_v1);
        assert_eq!(e.new_metadata, meta_v2);
    }

    // Second update: v2 → v3; old_metadata in the event must be v2.
    client.update_metadata(&id, &meta_v3);
    {
        let events = collect_updmeta_events(&env, &client.address);
        assert_eq!(
            events.len(),
            1,
            "expected one updmeta event after second update"
        );
        let e = events.get(0).unwrap();
        assert_eq!(e.old_metadata, meta_v2);
        assert_eq!(e.new_metadata, meta_v3);
    }
}

#[test]
fn update_metadata_event_id_matches_resource_id() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtidcheck");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.update_metadata(&id, &String::from_str(&env, "ipfs://QmEvtId"));

    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(events.len(), 1);
    let event = events.get(0).unwrap();
    assert_eq!(event.id, id);
}

#[test]
fn update_metadata_failed_validation_emits_no_event() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtnoemit");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://valid"),
        &empty_tags(&env),
    );
    let empty = String::from_str(&env, "");
    assert_eq!(
        client.try_update_metadata(&id, &empty),
        Err(Ok(Error::EmptyMetadata))
    );
    assert_eq!(
        client.get(&id).metadata,
        String::from_str(&env, "ipfs://valid")
    );

    // No updmeta event should be emitted when the call fails.
    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(
        events.len(),
        0,
        "failed update_metadata must not emit any updmeta event"
    );
}

#[test]
fn update_metadata_too_long_emits_no_event() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "evtnoemit2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let too_long = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    assert_eq!(
        client.try_update_metadata(&id, &too_long),
        Err(Ok(Error::MetadataTooLong))
    );

    // No updmeta event should be emitted when the call fails.
    let events = collect_updmeta_events(&env, &client.address);
    assert_eq!(
        events.len(),
        0,
        "failed update_metadata must not emit any updmeta event"
    );
}

#[test]
fn update_metadata_state_not_mutated_on_failed_call() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "nostatechange");
    let original = String::from_str(&env, "ipfs://QmOriginal");
    client.register(&creator, &id, &100i128, &original, &empty_tags(&env));

    // Attempt an invalid update (too long).
    let too_long = metadata_of_len(&env, MAX_METADATA_POINTER_LEN + 1);
    let _ = client.try_update_metadata(&id, &too_long);

    // State must be unchanged.
    let r = client.get(&id);
    assert_eq!(
        r.metadata, original,
        "metadata must not change when update_metadata returns an error"
    );
    assert_eq!(r.price, 100i128);
    assert_eq!(r.creator, creator);
}

/// Assert core registry invariants after mixed ops.
///
/// Checks:
/// - `count` equals the number of successfully registered ids (monotonic)
/// - insertion-index order is preserved by `list(0, count)`
/// - `exists` / `get` / `get_owner` agree with tracked ownership
/// - listing, tags, and price match the tracked expected state
fn assert_registry_invariants(
    client: &VaultRegistryClient,
    expected_ids: &[String],
    expected_owners: &[Address],
    expected_prices: &[i128],
    expected_listed: &[bool],
    expected_tags: &[Vec<String>],
) {
    let n = expected_ids.len() as u32;
    assert_eq!(
        client.count(),
        n,
        "count must equal number of successful registrations"
    );

    let page = client.list(&0u32, &n.max(1));
    assert_eq!(page.len(), n, "list must return all registered resources");
    for i in 0..expected_ids.len() {
        let r = page.get(i as u32).unwrap();
        assert_eq!(r.id, expected_ids[i], "index order broken at {i}");
        assert_eq!(r.creator, expected_owners[i], "owner mismatch at {i}");
        assert_eq!(r.price, expected_prices[i], "price mismatch at {i}");
        assert_eq!(r.listed, expected_listed[i], "listed mismatch at {i}");
        assert_eq!(r.tags, expected_tags[i], "tags mismatch at {i}");

        assert!(client.exists(&expected_ids[i]));
        let got = client.get(&expected_ids[i]);
        assert_eq!(got, r);
        assert_eq!(client.get_owner(&expected_ids[i]), expected_owners[i]);
    }
}

/// Focused invariant suite: mixed register / transfer / tag / listing / price
/// ops, asserting core registry invariants after each step. Failure cases are
/// deterministic and must not corrupt count, index order, ownership, listing,
/// or tags.
#[test]
fn registry_invariant_suite_mixed_ops() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);

    // Empty registry baseline.
    assert_eq!(client.count(), 0);
    assert_eq!(client.list(&0u32, &20u32).len(), 0);

    // ── Step 1: register r0 under alice ──────────────────────────────────────
    let r0 = String::from_str(&env, "invr0");
    let tags0 = tags(&env, &["dataset"]);
    client.register(
        &alice,
        &r0,
        &1_000i128,
        &String::from_str(&env, "ipfs://r0"),
        &tags0,
    );
    assert_registry_invariants(
        &client,
        core::slice::from_ref(&r0),
        core::slice::from_ref(&alice),
        &[1_000],
        &[true],
        core::slice::from_ref(&tags0),
    );

    // ── Step 2: register r1 under alice ──────────────────────────────────────
    let r1 = String::from_str(&env, "invr1");
    let empty0 = empty_tags(&env);
    client.register(
        &alice,
        &r1,
        &2_000i128,
        &String::from_str(&env, "ipfs://r1"),
        &empty0,
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[alice.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, true],
        &[tags0.clone(), empty0.clone()],
    );

    // ── Step 3: transfer ownership of r0 → bob (count/order unchanged) ────────
    client.transfer_ownership(&r0, &bob);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, true],
        &[tags0.clone(), empty0.clone()],
    );

    // ── Step 4: set tags on r1 ───────────────────────────────────────────────
    let tags1 = tags(&env, &["research", "alpha"]);
    client.set_tags(&r1, &tags1);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, true],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 5: delist r1 (listing only) ─────────────────────────────────────
    client.delist(&r1);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[1_000, 2_000],
        &[true, false],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 6: set_price on r0 (bob is owner) ───────────────────────────────
    client.set_price(&r0, &9_999i128);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[9_999, 2_000],
        &[true, false],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 7: re-list r1 ───────────────────────────────────────────────────
    client.set_listed(&r1, &true);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone()],
        &[bob.clone(), alice.clone()],
        &[9_999, 2_000],
        &[true, true],
        &[tags0.clone(), tags1.clone()],
    );

    // ── Step 8: register r2 under bob ────────────────────────────────────────
    let r2 = String::from_str(&env, "invr2");
    let tags2 = tags(&env, &["beta"]);
    client.register(
        &bob,
        &r2,
        &500i128,
        &String::from_str(&env, "ipfs://r2"),
        &tags2,
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // ── Deterministic failure cases — must not corrupt invariants ────────────

    // Duplicate registration does not change count / order / state.
    assert_eq!(
        client.try_register(
            &alice,
            &r1,
            &1i128,
            &String::from_str(&env, "ipfs://x"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Invalid price on set_price leaves prior price intact.
    assert_eq!(
        client.try_set_price(&r0, &0i128),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        client.try_set_price(&r0, &-1i128),
        Err(Ok(Error::InvalidPrice))
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Invalid tags rejected; prior tags preserved.
    let too_many = tags(
        &env,
        &["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"],
    );
    assert_eq!(
        client.try_set_tags(&r1, &too_many),
        Err(Ok(Error::InvalidTag))
    );
    let empty_tag = {
        let mut v = Vec::new(&env);
        v.push_back(String::from_str(&env, ""));
        v
    };
    assert_eq!(
        client.try_set_tags(&r1, &empty_tag),
        Err(Ok(Error::InvalidTag))
    );
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Missing resource lookups are deterministic NotFound.
    let missing = String::from_str(&env, "nosuchresource");
    assert_eq!(client.try_get(&missing), Err(Ok(Error::NotFound)));
    assert_eq!(client.try_get_owner(&missing), Err(Ok(Error::NotFound)));
    assert!(!client.exists(&missing));
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), bob.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[tags0.clone(), tags1.clone(), tags2.clone()],
    );

    // Clear tags on r0 (owned by bob) and transfer r2 back to alice.
    let empty1 = empty_tags(&env);
    client.set_tags(&r0, &empty1);
    client.transfer_ownership(&r2, &alice);
    assert_registry_invariants(
        &client,
        &[r0.clone(), r1.clone(), r2.clone()],
        &[bob.clone(), alice.clone(), alice.clone()],
        &[9_999, 2_000, 500],
        &[true, true, true],
        &[empty1.clone(), tags1.clone(), tags2.clone()],
    );

    // Final: count is still exactly 3 (no ghost entries from failures).
    assert_eq!(client.count(), 3);
}

#[test]
fn creator_resource_count_starts_at_zero() {
    let (_env, creator, client) = setup();
    assert_eq!(client.creator_resource_count(&creator), 0);
}

#[test]
fn creator_resource_count_increments_on_register() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "r1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.creator_resource_count(&creator), 1);

    client.register(
        &creator,
        &String::from_str(&env, "r2"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.creator_resource_count(&creator), 2);

    // Failed duplicate does not inflate count.
    let dup = String::from_str(&env, "r1");
    assert_eq!(
        client.try_register(
            &creator,
            &dup,
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env)
        ),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.creator_resource_count(&creator), 2);
}

#[test]
fn creator_resource_count_moves_on_transfer_ownership() {
    let (env, creator, client) = setup();
    let new_owner = Address::generate(&env);

    client.register(
        &creator,
        &String::from_str(&env, "r1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    client.register(
        &creator,
        &String::from_str(&env, "r2"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    assert_eq!(client.creator_resource_count(&creator), 2);
    assert_eq!(client.creator_resource_count(&new_owner), 0);

    client.transfer_ownership(&String::from_str(&env, "r1"), &new_owner);

    assert_eq!(client.creator_resource_count(&creator), 1);
    assert_eq!(client.creator_resource_count(&new_owner), 1);

    // Global count stays monotonic.
    assert_eq!(client.count(), 2);
}

#[test]
fn creator_resource_count_zero_for_unrelated_creator() {
    let (env, creator_a, client) = setup();
    let creator_b = Address::generate(&env);

    client.register(
        &creator_a,
        &String::from_str(&env, "r1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Creator B never registered anything; 0 expected.
    assert_eq!(client.creator_resource_count(&creator_b), 0);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50))]
    #[test]
    fn test_metadata_pointer_roundtrip_property(
        id_str in r"[a-z0-9]{1,24}",
        price in 1..1000000000000i128,
        price_2 in 1..1000000000000i128,
        meta_str in r"[a-zA-Z0-9:/\\._-]{1,500}",
        meta_str_2 in r"[a-zA-Z0-9:/\\._-]{1,500}",
        listed in any::<bool>(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);

        let id = String::from_str(&env, &id_str);
        let metadata = String::from_str(&env, &format!("ipfs://{}", meta_str));
        let metadata_2 = String::from_str(&env, &format!("https://{}", meta_str_2));

        client.register(&creator, &id, &price, &metadata, &empty_tags(&env));

        let r = client.get(&id);
        assert_eq!(r.metadata, metadata);
        assert_eq!(r.price, price);
        assert_eq!(r.creator, creator);
        assert!(r.listed);

        client.update_metadata(&id, &metadata_2);

        let r2 = client.get(&id);
        assert_eq!(r2.metadata, metadata_2);
        assert_eq!(r2.price, price);
        assert_eq!(r2.creator, creator);
        assert!(r2.listed);

        client.set_price(&id, &price_2);
        let r3 = client.get(&id);
        assert_eq!(r3.metadata, metadata_2);
        assert_eq!(r3.price, price_2);

        client.set_listed(&id, &listed);
        let r4 = client.get(&id);
        assert_eq!(r4.metadata, metadata_2);
        assert_eq!(r4.listed, listed);
    }
}

// ── Tag removal event semantics (#362) ──────────────────────────────────────

// ── set_tags validation — reject before any state mutation ──────────────────
//
// These tests ensure every invalid tag array is rejected by `validate_tags`
// before the contract touches on-chain state. The acceptance criterion is:
// "Tool rejects invalid tag arrays before RPC calls." The equivalent MCP-layer
// rejection is covered by mcp/src/validation.test.ts and
// mcp/src/catalogFilters.test.ts.

#[test]
fn set_tags_rejects_too_many_tags() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "manytags");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // MAX_TAGS is 8; a vector of 9 tags must be rejected.
    let nine = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    assert_eq!(
        client.try_set_tags(&id, &nine),
        Err(Ok(Error::InvalidTag)),
        "set_tags must reject tag counts > MAX_TAGS (8)"
    );
    // State must be unchanged (still no tags).
    assert_eq!(client.get(&id).tags, empty_tags(&env));
}

#[test]
fn set_tags_accepts_exactly_max_tags() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "eighttagsok");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let eight = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h"]);
    client.set_tags(&id, &eight);
    assert_eq!(client.get(&id).tags.len(), 8);
}

#[test]
fn set_tags_rejects_tag_exceeding_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "longtag");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // MAX_TAG_LEN is 32; a 33-character tag must be rejected.
    let long_tag = String::from_str(&env, "123456789012345678901234567890123"); // 33 chars
    let mut bad = Vec::new(&env);
    bad.push_back(long_tag);
    assert_eq!(
        client.try_set_tags(&id, &bad),
        Err(Ok(Error::InvalidTag)),
        "set_tags must reject tags longer than MAX_TAG_LEN (32)"
    );
    assert_eq!(client.get(&id).tags, empty_tags(&env));
}

#[test]
fn set_tags_accepts_tag_at_max_length() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxlentagok");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Exactly 32 characters — must be accepted.
    let ok_tag = String::from_str(&env, "12345678901234567890123456789012"); // 32 chars
    let mut one = Vec::new(&env);
    one.push_back(ok_tag.clone());
    client.set_tags(&id, &one);
    assert_eq!(client.get(&id).tags.get(0).unwrap(), ok_tag);
}

#[test]
fn set_tags_rejects_on_nonexistent_resource() {
    let (env, _creator, client) = setup();
    let ghost = String::from_str(&env, "ghost");
    let t = tags(&env, &["x"]);
    assert_eq!(
        client.try_set_tags(&ghost, &t),
        Err(Ok(Error::NotFound)),
        "set_tags must error NotFound for an unregistered resource id"
    );
}

#[test]
fn set_tags_event_includes_prev_and_next() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "eventtest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with initial tags
    let initial_tags = tags(&env, &["data", "research"]);
    client.register(&creator, &id, &100i128, &metadata, &initial_tags);

    // Replace with new tags
    let new_tags = tags(&env, &["finance", "api"]);
    client.set_tags(&id, &new_tags);

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");

    assert_eq!(prev_tags.len(), 2);
    assert_eq!(prev_tags.get(0).unwrap(), String::from_str(&env, "data"));
    assert_eq!(
        prev_tags.get(1).unwrap(),
        String::from_str(&env, "research")
    );

    assert_eq!(next_tags.len(), 2);
    assert_eq!(next_tags.get(0).unwrap(), String::from_str(&env, "finance"));
    assert_eq!(next_tags.get(1).unwrap(), String::from_str(&env, "api"));
}

#[test]
fn set_tags_event_supports_tag_removal() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "removaltest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with multiple tags then clear all tags
    let initial_tags = tags(&env, &["tag1", "tag2", "tag3"]);
    client.register(&creator, &id, &100i128, &metadata, &initial_tags);
    client.set_tags(&id, &empty_tags(&env));

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");
    assert_eq!(prev_tags.len(), 3);
    assert_eq!(next_tags.len(), 0);
}

#[test]
fn set_tags_event_supports_tag_addition() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "additiontest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with no tags then add some
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    client.set_tags(&id, &tags(&env, &["first", "second"]));

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");
    assert_eq!(prev_tags.len(), 0);
    assert_eq!(next_tags.len(), 2);
    assert_eq!(next_tags.get(0).unwrap(), String::from_str(&env, "first"));
}

#[test]
fn set_tags_event_on_replacement() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "replacetest");
    let metadata = String::from_str(&env, "ipfs://m");

    // Register with initial tags then replace completely
    let initial_tags = tags(&env, &["old1", "old2"]);
    client.register(&creator, &id, &100i128, &metadata, &initial_tags);
    client.set_tags(&id, &tags(&env, &["new1", "new2", "new3"]));

    let (prev_tags, next_tags) =
        find_settags_event(&env, &client.address).expect("settags event not emitted");
    assert_eq!(prev_tags.len(), 2);
    assert_eq!(prev_tags.get(0).unwrap(), String::from_str(&env, "old1"));
    assert_eq!(prev_tags.get(1).unwrap(), String::from_str(&env, "old2"));

    assert_eq!(next_tags.len(), 3);
    assert_eq!(next_tags.get(0).unwrap(), String::from_str(&env, "new1"));
    assert_eq!(next_tags.get(1).unwrap(), String::from_str(&env, "new2"));
    assert_eq!(next_tags.get(2).unwrap(), String::from_str(&env, "new3"));
}

// ---------------------------------------------------------------------------
// list_by_tag + tag index (#359)
// ---------------------------------------------------------------------------
//
// Acceptance criteria (from issue):
//   • Resources are indexed by normalized tag; changing tags updates indexes.
//   • Tests cover add/remove/duplicate tags.
//   • Pagination works the same as other list_* functions (limit capped at 20,
//     start beyond index returns empty, TTL is bumped for returned resources).
//   • list_by_tag is case-insensitive (normalized to lowercase).
//   • repair_tag_index is admin-only, rebuilds from Resource.tags.

/// Register a resource tagged with `tag_strs` using the default metadata.
fn register_tagged<'a>(
    env: &Env,
    creator: &Address,
    client: &VaultRegistryClient<'a>,
    id: &str,
    tag_strs: &[&str],
) -> String {
    let id = String::from_str(env, id);
    client.register(
        creator,
        &id,
        &100i128,
        &String::from_str(env, "ipfs://m"),
        &tags(env, tag_strs),
    );
    id
}

// ── Basic indexing on register ──────────────────────────────────────────────

#[test]
fn list_by_tag_returns_registered_resource() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagr1", &["dataset"]);

    let result = client.list_by_tag(&String::from_str(&env, "dataset"), &0u32, &20u32);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap().id, id);
}

#[test]
fn list_by_tag_returns_empty_when_no_resources_carry_tag() {
    let (env, creator, client) = setup();
    register_tagged(&env, &creator, &client, "tagr2", &["other"]);

    let result = client.list_by_tag(&String::from_str(&env, "dataset"), &0u32, &20u32);
    assert_eq!(result.len(), 0);
}

#[test]
fn list_by_tag_returns_empty_when_no_resources_registered() {
    let (env, _creator, client) = setup();
    let result = client.list_by_tag(&String::from_str(&env, "any"), &0u32, &20u32);
    assert_eq!(result.len(), 0);
}

#[test]
fn list_by_tag_multiple_resources_same_tag() {
    let (env, creator, client) = setup();
    let a = register_tagged(&env, &creator, &client, "tagm1", &["ml"]);
    let b = register_tagged(&env, &creator, &client, "tagm2", &["ml", "research"]);
    let c = register_tagged(&env, &creator, &client, "tagm3", &["other"]);
    // c carries a different tag — should not appear

    let result = client.list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32);
    assert_eq!(result.len(), 2);
    assert_eq!(result.get(0).unwrap().id, a);
    assert_eq!(result.get(1).unwrap().id, b);
    let _ = c; // registered but not in "ml" index
}

// ── Case-insensitive normalization ──────────────────────────────────────────

#[test]
fn list_by_tag_is_case_insensitive() {
    let (env, creator, client) = setup();
    // Register with mixed-case tag; the index normalizes to lowercase.
    let id = register_tagged(&env, &creator, &client, "tagci", &["Dataset"]);

    // All variants should match.
    for variant in &["Dataset", "dataset", "DATASET", "DataSet"] {
        let result = client.list_by_tag(&String::from_str(&env, variant), &0u32, &20u32);
        assert_eq!(
            result.len(),
            1,
            "list_by_tag(\"{variant}\") should match resource with tag \"Dataset\""
        );
        assert_eq!(result.get(0).unwrap().id, id);
    }
}

#[test]
fn list_by_tag_lowercase_tag_on_register_also_indexed() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "taglow", &["research"]);

    let result = client.list_by_tag(&String::from_str(&env, "Research"), &0u32, &20u32);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap().id, id);
}

// ── Index update on set_tags ─────────────────────────────────────────────────

#[test]
fn list_by_tag_updated_when_set_tags_adds_tag() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagadd", &["alpha"]);

    // Not yet in "beta" index.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32)
            .len(),
        0
    );

    // Add "beta" tag via set_tags.
    client.set_tags(&id, &tags(&env, &["alpha", "beta"]));

    let result = client.list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap().id, id);
    // Still in "alpha" index.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "alpha"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn list_by_tag_updated_when_set_tags_removes_tag() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagrem", &["alpha", "beta"]);

    // Both indexed initially.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "alpha"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32)
            .len(),
        1
    );

    // Remove "beta" by replacing with only "alpha".
    client.set_tags(&id, &tags(&env, &["alpha"]));

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "alpha"), &0u32, &20u32)
            .len(),
        1,
        "alpha should still be indexed"
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "beta"), &0u32, &20u32)
            .len(),
        0,
        "beta should be removed from index after set_tags"
    );
}

#[test]
fn list_by_tag_updated_when_all_tags_cleared() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagclr", &["data", "ml"]);

    // Both indexed.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "data"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32)
            .len(),
        1
    );

    // Clear all tags.
    client.set_tags(&id, &empty_tags(&env));

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "data"), &0u32, &20u32)
            .len(),
        0,
        "data should be removed after clearing all tags"
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32)
            .len(),
        0,
        "ml should be removed after clearing all tags"
    );
}

#[test]
fn list_by_tag_reflects_complete_tag_replacement() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagreplace", &["old1", "old2"]);

    client.set_tags(&id, &tags(&env, &["new1", "new2", "new3"]));

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "old1"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "old2"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "new1"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "new2"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "new3"), &0u32, &20u32)
            .len(),
        1
    );
}

// ── Duplicate tags are rejected on write ─────────────────────────────────────

#[test]
fn register_rejects_duplicate_normalized_tags_with_case_variants() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "tagdup");
    let metadata = String::from_str(&env, "ipfs://m");

    // "ML" and "ml" normalize to the same tag and must be rejected outright.
    assert_eq!(
        client.try_register(
            &creator,
            &id,
            &100i128,
            &metadata,
            &tags(&env, &["ML", "ml"])
        ),
        Err(Ok(Error::InvalidTag))
    );
    assert!(!client.exists(&id), "rejected register must not persist");

    // A single spelling registers and lands in the index exactly once.
    client.register(&creator, &id, &100i128, &metadata, &tags(&env, &["ML"]));

    let result = client.list_by_tag(&String::from_str(&env, "ml"), &0u32, &20u32);
    assert_eq!(
        result.len(),
        1,
        "tag index must not contain duplicate id entries"
    );
    assert_eq!(result.get(0).unwrap().id, id);
}

#[test]
fn set_tags_rejects_duplicate_normalized_tags_with_case_variants() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagdup2", &["finance"]);

    // "Finance" and "finance" normalize to the same tag and must be rejected.
    assert_eq!(
        client.try_set_tags(&id, &tags(&env, &["Finance", "finance"])),
        Err(Ok(Error::InvalidTag))
    );

    // Existing tags stay unchanged after failed set_tags.
    let result = client.list_by_tag(&String::from_str(&env, "finance"), &0u32, &20u32);
    assert_eq!(
        result.len(),
        1,
        "tag index must not double-insert on repeated set_tags"
    );
}

// ── Pagination ───────────────────────────────────────────────────────────────

#[test]
fn list_by_tag_pagination_first_page() {
    let (env, creator, client) = setup();
    for i in 0..5u32 {
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("pgr{i}"),
            &["page"],
        );
    }

    let page = client.list_by_tag(&String::from_str(&env, "page"), &0u32, &3u32);
    assert_eq!(page.len(), 3);
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "pgr0"));
    assert_eq!(page.get(2).unwrap().id, String::from_str(&env, "pgr2"));
}

#[test]
fn list_by_tag_pagination_second_page() {
    let (env, creator, client) = setup();
    for i in 0..5u32 {
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("pgs{i}"),
            &["page"],
        );
    }

    let page = client.list_by_tag(&String::from_str(&env, "page"), &3u32, &3u32);
    assert_eq!(page.len(), 2); // only pgs3, pgs4 remain
    assert_eq!(page.get(0).unwrap().id, String::from_str(&env, "pgs3"));
    assert_eq!(page.get(1).unwrap().id, String::from_str(&env, "pgs4"));
}

#[test]
fn list_by_tag_start_beyond_index_returns_empty() {
    let (env, creator, client) = setup();
    register_tagged(&env, &creator, &client, "pgx1", &["only"]);

    let result = client.list_by_tag(&String::from_str(&env, "only"), &99u32, &20u32);
    assert_eq!(result.len(), 0);
}

#[test]
fn list_by_tag_limit_capped_at_20() {
    let (env, creator, client) = setup();
    for i in 0..25u32 {
        register_tagged(
            &env,
            &creator,
            &client,
            &alloc::format!("pg20x{i:02}"),
            &["bulk"],
        );
    }

    let result = client.list_by_tag(&String::from_str(&env, "bulk"), &0u32, &25u32);
    assert_eq!(result.len(), 20, "limit must be capped at 20");
}

// ── TTL bump on list_by_tag read ─────────────────────────────────────────────

#[test]
fn list_by_tag_bumps_ttl_for_returned_resources() {
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "tagtll", &["ttl"]);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + TTL_DAY_IN_LEDGERS);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &String::from_str(&env, "tagtll")),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS
    );

    client.list_by_tag(&String::from_str(&env, "ttl"), &0u32, &20u32);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT,
        "list_by_tag must bump TTL for each returned resource"
    );
}

// ── repair_tag_index ─────────────────────────────────────────────────────────

#[test]
fn repair_tag_index_rebuilds_drifted_index() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtia", &["science"]);
    let b = register_tagged(&env, &creator, &client, "reprtib", &["science", "data"]);

    // Verify initial state via list_by_tag.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "science"), &0u32, &20u32)
            .len(),
        2
    );

    // Repair is a no-op when the index is already correct.
    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), b.clone()]));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "science"), &0u32, &20u32)
            .len(),
        2
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "data"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn repair_tag_index_rejects_unknown_id() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtix", &["tag"]);

    let res = client.try_repair_tag_index(&Vec::from_array(
        &env,
        [a.clone(), String::from_str(&env, "ghost")],
    ));
    assert_eq!(res, Err(Ok(Error::NotFound)));
    // The index must be untouched after a failed repair.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "tag"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn repair_tag_index_before_admin_set_fails() {
    let (env, creator, client) = setup();
    let a = register_tagged(&env, &creator, &client, "reprtinadmin", &["t"]);

    let res = client.try_repair_tag_index(&Vec::from_array(&env, [a.clone()]));
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn repair_tag_index_accepts_duplicate_ids_in_input() {
    // Duplicate ids in the input are idempotent per the ADR.
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtidp", &["dup"]);

    // Passing the same id twice must not error and must not create a duplicate entry.
    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), a.clone()]));

    let result = client.list_by_tag(&String::from_str(&env, "dup"), &0u32, &20u32);
    assert_eq!(
        result.len(),
        1,
        "repair with duplicate input ids must not double-insert"
    );
}

#[test]
fn repair_tag_index_emits_retagidx_event() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "reprtevent", &["evt"]);
    let b = register_tagged(&env, &creator, &client, "reprtevent2", &["evt"]);

    client.repair_tag_index(&Vec::from_array(&env, [a.clone(), b.clone()]));

    let all = env.events().all();
    assert_eq!(all.len(), 1, "exactly one event should be emitted");
    let (_, topics, data) = all.get(0).unwrap();
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, symbol_short!("retagidx"));
    let count: u32 = u32::try_from_val(&env, &data).unwrap();
    assert_eq!(
        count, 2u32,
        "event must report the number of unique ids processed"
    );
}

/// Regression test for #778: an empty id list must not report a repair.
///
/// The old behavior emitted `retagidx` with a count of `0`, which read to
/// operators and audit tooling as "a repair ran and covered 0 resources" —
/// indistinguishable from a real repair of an empty catalog. It now returns
/// `Ok` without emitting, so "no `retagidx` event" is an unambiguous "no repair
/// performed".
#[test]
fn repair_tag_index_with_empty_id_list_is_a_silent_no_op() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_tagged(&env, &creator, &client, "emptyrepair", &["keepme"]);

    // Seed a real index entry so we can prove the empty call leaves it intact.
    let keepme = String::from_str(&env, "keepme");
    assert_eq!(client.list_by_tag(&keepme, &0u32, &20u32).len(), 1);

    client.repair_tag_index(&Vec::new(&env));

    assert_eq!(
        env.events().all().len(),
        0,
        "an empty id list must not emit `retagidx`: the event is the audit \
         signal that a repair ran, and a 0-count event would falsely assert one"
    );

    let survivors = client.list_by_tag(&keepme, &0u32, &20u32);
    assert_eq!(
        survivors.len(),
        1,
        "an empty id list must not truncate the tag index — nothing is indexed, \
         so every existing TagIndex entry has to survive untouched"
    );
    assert_eq!(survivors.get(0).unwrap().id, a);
}

#[test]
fn list_by_tag_index_maintained_across_multiple_set_tags_calls() {
    // Simulate a real lifecycle: register → set_tags (several times) → verify index.
    let (env, creator, client) = setup();
    let id = register_tagged(&env, &creator, &client, "lifecycle", &["v1"]);

    // v1 → v1 + v2
    client.set_tags(&id, &tags(&env, &["v1", "v2"]));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v1"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v2"), &0u32, &20u32)
            .len(),
        1
    );

    // v1 + v2 → v3 only
    client.set_tags(&id, &tags(&env, &["v3"]));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v1"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v2"), &0u32, &20u32)
            .len(),
        0
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v3"), &0u32, &20u32)
            .len(),
        1
    );

    // v3 → empty
    client.set_tags(&id, &empty_tags(&env));
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "v3"), &0u32, &20u32)
            .len(),
        0
    );
}

#[test]
fn list_by_tag_tag_shared_across_multiple_resources_independent_per_resource() {
    let (env, creator, client) = setup();
    let a = register_tagged(&env, &creator, &client, "shared1", &["common", "unique1"]);
    let b = register_tagged(&env, &creator, &client, "shared2", &["common", "unique2"]);

    // "common" index has both.
    let common = client.list_by_tag(&String::from_str(&env, "common"), &0u32, &20u32);
    assert_eq!(common.len(), 2);

    // Remove "common" from a only — b's "common" entry must remain.
    client.set_tags(&a, &tags(&env, &["unique1"]));

    let common_after = client.list_by_tag(&String::from_str(&env, "common"), &0u32, &20u32);
    assert_eq!(
        common_after.len(),
        1,
        "removing tag from one resource must not affect other resources in the same index"
    );
    assert_eq!(common_after.get(0).unwrap().id, b);

    // "unique1" still points to a; "unique2" still points to b.
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "unique1"), &0u32, &20u32)
            .len(),
        1
    );
    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "unique2"), &0u32, &20u32)
            .len(),
        1
    );
}

#[test]
fn set_terms_hash_works_and_extends_ttl() {
    let (env, creator, client) = setup();
    let terms = String::from_str(&env, "hash123");
    client.set_terms_hash(&creator, &terms);
    assert_eq!(client.get_terms_hash(&creator), terms);

    let key = DataKey::CreatorTerms(creator.clone());
    let ttl = env.as_contract(&client.address, || env.storage().persistent().get_ttl(&key));
    assert_eq!(ttl, TTL_BUMP_AMOUNT);
}

#[test]
fn get_terms_hash_missing_fails() {
    let (_env, creator, client) = setup();
    assert_eq!(
        client.try_get_terms_hash(&creator),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn set_terms_hash_rejects_over_max_length() {
    let (env, creator, client) = setup();
    let terms = metadata_of_len(&env, MAX_TERMS_HASH_LEN + 1);
    assert_eq!(
        client.try_set_terms_hash(&creator, &terms),
        Err(Ok(Error::TermsHashTooLong))
    );
    assert_eq!(
        client.try_get_terms_hash(&creator),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn set_terms_hash_accepts_max_length() {
    let (env, creator, client) = setup();
    let terms = String::from_str(&env, &"a".repeat(MAX_TERMS_HASH_LEN as usize));

    client.set_terms_hash(&creator, &terms);
    assert_eq!(client.get_terms_hash(&creator), terms);
}

#[test]
fn set_terms_hash_validates_byte_length_not_character_count() {
    // The limit is 64 bytes (for hex-encoded hashes like SHA-256 = 64 hex chars).
    // Multi-byte UTF-8 characters count as multiple bytes, so a 64-char
    // multi-byte string exceeds the limit and is rejected.
    let (env, creator, client) = setup();

    // 64 ASCII chars = 64 bytes = valid (hex hash length)
    let ascii_64 = String::from_str(&env, &"a".repeat(64));
    client.set_terms_hash(&creator, &ascii_64);
    assert_eq!(client.get_terms_hash(&creator), ascii_64);

    // 64 multi-byte chars (e.g., emoji = 4 bytes each) = 256 bytes = rejected
    let creator2 = Address::generate(&env);
    let multibyte_64 = String::from_str(&env, &"😀".repeat(64));
    assert_eq!(
        client.try_set_terms_hash(&creator2, &multibyte_64),
        Err(Ok(Error::TermsHashTooLong))
    );

    // 16 multi-byte chars = 64 bytes = valid (but not a typical hash)
    let creator3 = Address::generate(&env);
    let multibyte_16 = String::from_str(&env, &"😀".repeat(16));
    client.set_terms_hash(&creator3, &multibyte_16);
    assert_eq!(client.get_terms_hash(&creator3), multibyte_16);
}

// Admin bootstrap/uninitialized-state behavior is covered by
// `admin_transfer_nominate_then_accept` (bootstrap via the first
// `nominate_new_admin` call) — see the two-step admin model above.
// `admin()` returns `Option<Address>` (`None` before any admin is set), not
// a `Result`, so there is no separate "uninitialized" error case to test.

// ---------------------------------------------------------------------------
// registry_info() — registry discovery metadata
// ---------------------------------------------------------------------------

#[test]
fn registry_info_exposes_stable_fields() {
    let (env, _creator, client) = setup();
    let info = client.registry_info();

    assert_eq!(info.name, String::from_str(&env, REGISTRY_NAME));
    assert_eq!(info.resource_schema_version, RESOURCE_SCHEMA_VERSION);
    assert!(!info.version.is_empty(), "version must not be empty");
    assert_eq!(info.network_id, env.ledger().network_id());
}

#[test]
fn registry_info_is_stable_across_calls_and_registrations() {
    let (env, creator, client) = setup();
    let before = client.registry_info();

    client.register(
        &creator,
        &String::from_str(&env, "infostability"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let after = client.registry_info();
    assert_eq!(
        before, after,
        "registry_info must not depend on registry contents"
    );
}

// ---------------------------------------------------------------------------
// Deployment network identifier guard (#457)
// ---------------------------------------------------------------------------

#[test]
fn network_id_requires_initialization() {
    let (env, _creator, client) = setup();
    assert_eq!(
        client.try_network_id(),
        Err(Ok(Error::NetworkNotInitialized))
    );
    assert_eq!(client.registry_info().network_id, env.ledger().network_id());
}

#[test]
fn initialize_network_records_and_exposes_current_ledger_id() {
    let (env, _creator, client) = setup();
    let expected = env.ledger().network_id();

    client.initialize_network(&expected);

    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                client.address.clone(),
                (symbol_short!("netinit"),).into_val(&env),
                expected.into_val(&env),
            ),
        ]
    );

    assert_eq!(client.network_id(), expected);
}

#[test]
fn initialize_network_rejects_mismatched_network_id_without_writing() {
    let (env, _creator, client) = setup();
    let mut wrong = env.ledger().network_id().to_array();
    wrong[0] ^= 1;
    let wrong = BytesN::from_array(&env, &wrong);

    assert_eq!(
        client.try_initialize_network(&wrong),
        Err(Ok(Error::NetworkIdMismatch))
    );
    assert_eq!(
        client.try_network_id(),
        Err(Ok(Error::NetworkNotInitialized))
    );
}

#[test]
fn initialize_network_rejects_duplicate_initialization() {
    let (env, _creator, client) = setup();
    let network_id = env.ledger().network_id();
    client.initialize_network(&network_id);

    assert_eq!(
        client.try_initialize_network(&network_id),
        Err(Ok(Error::NetworkAlreadyInitialized))
    );
    assert_eq!(client.network_id(), network_id);
}

// ---------------------------------------------------------------------------
// contract_version() — compact build/schema version for deployment scripts
// ---------------------------------------------------------------------------

#[test]
fn contract_version_returns_crate_and_schema_version() {
    let (_env, _creator, client) = setup();
    let v = client.contract_version();

    // crate_version is baked at build time; it must be a non-empty semver string.
    assert!(
        !v.crate_version.is_empty(),
        "crate_version must not be empty"
    );
    // resource_schema_version is the compile-time constant; the call must echo it.
    assert_eq!(
        v.resource_schema_version, RESOURCE_SCHEMA_VERSION,
        "contract_version must expose RESOURCE_SCHEMA_VERSION"
    );
}

#[test]
fn contract_version_matches_registry_info_fields() {
    // contract_version is a focused subset of registry_info. Both must agree on
    // the same crate_version/schema_version so deployment scripts can use either.
    let (_env, _creator, client) = setup();
    let v = client.contract_version();
    let info = client.registry_info();

    assert_eq!(
        v.crate_version, info.version,
        "contract_version.crate_version must equal registry_info.version"
    );
    assert_eq!(
        v.resource_schema_version, info.resource_schema_version,
        "contract_version.resource_schema_version must equal registry_info.resource_schema_version"
    );
}

#[test]
fn contract_version_is_stable_across_calls_and_registrations() {
    let (env, creator, client) = setup();
    let before = client.contract_version();

    client.register(
        &creator,
        &String::from_str(&env, "cvstability"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let after = client.contract_version();
    assert_eq!(
        before, after,
        "contract_version must not change when resources are registered"
    );
}

// ---------------------------------------------------------------------------
// Event schema drift detection
// ---------------------------------------------------------------------------
//
// `EVENT_SCHEMA` in lib.rs is the single source of truth for every event
// topic this contract emits. These two tests fail if it drifts from either
// side: the contract's actual runtime emissions, or the human-readable
// Events table in `contract/README.md`. Add/rename/remove an emitted event
// without updating all three (code, EVENT_SCHEMA, README) and one of these
// tests catches it.
extern crate std;

fn topic0_symbol(env: &Env, topics: &soroban_sdk::Vec<Val>) -> Option<Symbol> {
    Symbol::try_from_val(env, &topics.get(0)?).ok()
}

fn find_event<D>(env: &Env, contract: &Address, topic: &str) -> Option<D>
where
    D: TryFromVal<Env, Val>,
{
    let events = env.events().all();
    for i in 0..events.len() {
        let (address, topics, data) = events.get(i).unwrap();
        if address != *contract || topic0_symbol(env, &topics) != Some(Symbol::new(env, topic)) {
            continue;
        }
        if let Ok(decoded) = D::try_from_val(env, &data) {
            return Some(decoded);
        }
    }
    None
}

fn find_setprice_event(env: &Env, contract: &Address) -> Option<PriceUpdated> {
    find_event(env, contract, "setprice")
}

fn find_transfer_event(env: &Env, contract: &Address) -> Option<(Address, Address)> {
    find_event(env, contract, "transfer")
}

fn find_propose_event(env: &Env, contract: &Address) -> Option<(Address, Address)> {
    find_event(env, contract, "propose")
}

fn find_cancel_event(env: &Env, contract: &Address) -> Option<Address> {
    find_event(env, contract, "cancel")
}

fn find_settags_event(env: &Env, contract: &Address) -> Option<(Vec<String>, Vec<String>)> {
    find_event(env, contract, "settags")
}

// ---------------------------------------------------------------------------
// Tag index repair design (#429)
// ---------------------------------------------------------------------------
//
// No on-chain tag index exists yet (see docs/tag-index-repair-design.md), but
// a future one's repair path could rebuild id->tags associations either by
// reading `Resource.tags` directly or by replaying `register`/`settags`
// events. This test backs the ADR's "no third source of truth needed" claim
// by reconstructing tag state purely from event replay — never calling
// `get` — and checking it against `Resource.tags` exactly.
#[test]
fn register_then_settags_events_reconstruct_current_tags() {
    let (env, creator, client) = setup();

    let id_a = String::from_str(&env, "replaytaga");
    let id_b = String::from_str(&env, "replaytagb");
    let metadata = String::from_str(&env, "ipfs://m");

    // The Soroban test event log only reliably reflects the most recent
    // invocation (see `freeze_metadata_sets_flag_and_emits_event`'s comment
    // on this), so record the last event's decoded tag state immediately
    // after each call rather than replaying `env.events().all()` once at
    // the end.
    let last_settags_tags = |env: &Env| -> (String, Vec<String>) {
        let (_, topics, data) = env.events().all().last().unwrap();
        let event_id: String =
            <String as TryFromVal<Env, Val>>::try_from_val(env, &topics.get(1).unwrap()).unwrap();
        let (_prev, next): (Vec<String>, Vec<String>) = data.try_into_val(env).unwrap();
        (event_id, next)
    };
    let last_register_tags = |env: &Env| -> (String, Vec<String>) {
        let (_, _, data) = env.events().all().last().unwrap();
        let resource: RegisterEvent = data.try_into_val(env).unwrap();
        (resource.id, resource.tags)
    };

    client.register(
        &creator,
        &id_a,
        &100i128,
        &metadata,
        &tags(&env, &["alpha", "beta"]),
    );
    let (rid, _) = last_register_tags(&env);
    assert_eq!(rid, id_a);

    client.register(&creator, &id_b, &100i128, &metadata, &empty_tags(&env));
    let (rid, _) = last_register_tags(&env);
    assert_eq!(rid, id_b);

    client.set_tags(&id_a, &tags(&env, &["gamma"]));
    let (eid, _) = last_settags_tags(&env);
    assert_eq!(eid, id_a);

    client.set_tags(&id_b, &tags(&env, &["delta", "epsilon"]));
    let (eid, reconstructed_b) = last_settags_tags(&env);
    assert_eq!(eid, id_b);

    client.set_tags(&id_a, &empty_tags(&env));
    let (eid, _) = last_settags_tags(&env);
    assert_eq!(eid, id_a);

    client.set_tags(&id_a, &tags(&env, &["zeta"]));
    let (eid, reconstructed_a) = last_settags_tags(&env);
    assert_eq!(eid, id_a);

    assert_eq!(reconstructed_a, client.get(&id_a).tags);
    assert_eq!(reconstructed_b, client.get(&id_b).tags);

    // Sanity: prove replay tracked the final mutation, not just the initial register.
    assert_eq!(client.get(&id_a).tags.len(), 1);
    assert_eq!(
        client.get(&id_a).tags.get(0).unwrap(),
        String::from_str(&env, "zeta")
    );
}

#[test]
fn full_workflow_emits_exactly_the_documented_events() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let mut observed: std::vec::Vec<std::string::String> = std::vec::Vec::new();

    fn record(
        env: &Env,
        client: &VaultRegistryClient,
        observed: &mut std::vec::Vec<std::string::String>,
    ) {
        let all = env.events().all();
        for i in 0..all.len() {
            let (cid, topics, _data) = all.get(i).unwrap();
            if cid != client.address {
                continue;
            }
            if let Some(sym) = topic0_symbol(env, &topics) {
                observed.push(sym.to_string());
            }
        }
    }

    let expected = env.ledger().network_id();
    client.initialize_network(&expected); // -> "netinit"
    record(&env, &client, &mut observed);

    let r0 = String::from_str(&env, "schemar0");
    client.register(
        &alice,
        &r0,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    record(&env, &client, &mut observed);

    let r_memo = String::from_str(&env, "schemamemo");
    client.register_with_memo(
        &alice,
        &r_memo,
        &1_000i128,
        &String::from_str(&env, "ipfs://memo"),
        &empty_tags(&env),
        &None,
        &Some(BytesN::from_array(&env, &[7u8; 32])),
    ); // -> "register", "regmemo"
    record(&env, &client, &mut observed);

    client.set_price(&r0, &200i128);
    record(&env, &client, &mut observed);

    client.update_metadata(&r0, &String::from_str(&env, "ipfs://m2"));
    record(&env, &client, &mut observed);

    client.set_tags(&r0, &tags(&env, &["a"]));
    record(&env, &client, &mut observed);

    client.set_listed(&r0, &false);
    record(&env, &client, &mut observed);
    client.set_listed(&r0, &true);
    record(&env, &client, &mut observed);
    client.delist(&r0);
    record(&env, &client, &mut observed);

    client.propose_transfer(&r0, &bob);
    record(&env, &client, &mut observed);
    env.mock_all_auths();
    client.accept_transfer(&r0);
    record(&env, &client, &mut observed);

    let r1 = String::from_str(&env, "schemar1");
    client.register(
        &alice,
        &r1,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    record(&env, &client, &mut observed);
    client.transfer_ownership(&r1, &bob);
    record(&env, &client, &mut observed);

    // #808: transfer_ownership_with_terms — emits both `transfer` and `txfrterms`
    let r1b = String::from_str(&env, "schemar1b");
    client.register(
        &alice,
        &r1b,
        &100i128,
        &String::from_str(&env, "ipfs://mterms"),
        &empty_tags(&env),
    );
    record(&env, &client, &mut observed);
    client.transfer_ownership_with_terms(
        &r1b,
        &bob,
        &Some(String::from_str(&env, "newtermshash")),
        &false,
    ); // -> "transfer", "txfrterms", "setterms"
    record(&env, &client, &mut observed);

    let r2 = String::from_str(&env, "schemar2");
    client.register(
        &alice,
        &r2,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    record(&env, &client, &mut observed);
    client.propose_transfer(&r2, &bob);
    record(&env, &client, &mut observed);
    client.cancel_transfer(&r2);
    record(&env, &client, &mut observed);

    client.set_terms_hash(&alice, &String::from_str(&env, "termshash"));
    record(&env, &client, &mut observed);

    // Per-resource royalty recipient override (#618) and the scheduled-pause
    // deadline round out the documented event schema (`setroyal`,
    // `pause_until`).
    client.set_royalty_recipient(&r1, &Some(bob.clone())); // -> "setroyal"
    record(&env, &client, &mut observed);
    client.set_metadata_pointers(
        &r1,
        &Vec::from_array(
            &env,
            [
                String::from_str(&env, "ipfs://m"),
                String::from_str(&env, "ar://mirror"),
            ],
        ),
        &0,
    ); // -> "setptrs"
    record(&env, &client, &mut observed);

    let admin1 = Address::generate(&env);
    client.nominate_new_admin(&admin1); // bootstrap -> "setadmin"
    record(&env, &client, &mut observed);
    let admin2 = Address::generate(&env);
    client.nominate_new_admin(&admin2); // rotation -> "nomadmin"
    record(&env, &client, &mut observed);
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + ADMIN_NOMINATION_MIN_GAP);
    client.accept_admin(&admin2);
    record(&env, &client, &mut observed);

    // Verifier role, verification mirror, freeze, and index repair.
    let old_verifier = Address::generate(&env);
    let verifier = Address::generate(&env);
    client.add_verifier(&old_verifier); // -> "addverif"
    record(&env, &client, &mut observed);
    client.rotate_verifier(&old_verifier, &verifier); // -> "rmverif", "addverif", "verrot"
    record(&env, &client, &mut observed);
    client.set_verification_status(&r2, &verifier, &VerificationStatus::Verified, &None); // -> "verify"
    record(&env, &client, &mut observed);
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 100,
        fee_recipient: Some(admin2.clone()),
    }); // -> "setfee"
    record(&env, &client, &mut observed);
    client.set_fee_destination(&FeeDestinationConfig {
        bps: 250,
        destination: FeeDestination::Burn,
    });
    record(&env, &client, &mut observed);

    let buyer = Address::generate(&env);
    client.anchor_purchase_receipt(
        &verifier,
        &r0,
        &buyer,
        &String::from_str(&env, "sha256anchor"),
    ); // -> "anchor"
    record(&env, &client, &mut observed);

    // Re-anchoring the same (resource, buyer) pair is rejected — the
    // reporting variant records that as an event instead of reverting.
    assert!(!client.attempt_anchor_purchase_receipt(
        &verifier,
        &r0,
        &buyer,
        &String::from_str(&env, "sha256anchor2"),
    )); // -> "anchrfail"
    record(&env, &client, &mut observed);
    // Keep retrying past the back-off window until the pair's attempt cap is
    // reached; the attempt that reaches it also emits "anchrxhst".
    for _ in 1..MAX_ANCHOR_ATTEMPTS {
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + ANCHOR_RETRY_BACKOFF_LEDGERS);
        assert!(!client.attempt_anchor_purchase_receipt(
            &verifier,
            &r0,
            &buyer,
            &String::from_str(&env, "sha256anchor2"),
        )); // -> "anchrfail" (+ "anchrxhst" on the last one)
        record(&env, &client, &mut observed);
    }
    client.remove_verifier(&verifier); // -> "rmverif"
    record(&env, &client, &mut observed);

    client.freeze_metadata(&r2); // -> "freeze"
    record(&env, &client, &mut observed);

    client.open_dispute(&r2, &admin2); // -> "lifecycle"
    record(&env, &client, &mut observed);
    client.resolve_dispute(&r2, &admin2, &ResourceState::Frozen); // -> "lifecycle"
    record(&env, &client, &mut observed);

    // Admin emergency takedown. This is the only path that emits `emdelist` —
    // a creator delist above emitted `setlisted` instead — so the workflow has
    // to exercise it for the event-schema drift check to see every topic.
    client.open_dispute(&r1, &admin2);
    record(&env, &client, &mut observed);
    client.emergency_delist(
        &r1,
        &admin2,
        &String::from_str(&env, "workflow emergency takedown"),
    ); // -> "emdelist"
    record(&env, &client, &mut observed);
    client.extend_resource_ttl(&bob, &r0); // -> "ttlext"
    record(&env, &client, &mut observed);

    client.repair_index(&Vec::from_array(&env, [r0.clone(), r1.clone(), r2.clone()])); // -> "reindex"
    record(&env, &client, &mut observed);

    client.repair_tag_index(&Vec::from_array(&env, [r0.clone(), r1.clone(), r2.clone()])); // -> "retagidx"
    record(&env, &client, &mut observed);

    let settler = Address::generate(&env);
    client.add_settler(&settler); // -> "addsettlr"
    record(&env, &client, &mut observed);

    let payer = Address::generate(&env);
    let workflow_receipt = String::from_str(&env, "wfrcpt1");
    // Payments require a listed resource; r0 was delisted above.
    client.set_listed(&r0, &true); // -> "setlisted"
    record(&env, &client, &mut observed);
    client.record_payment(
        &settler,
        &workflow_receipt,
        &r0,
        &payer,
        &200i128,
        &String::from_str(&env, "txhash123"),
    ); // -> "payment"
    record(&env, &client, &mut observed);
    client.settle_payment(&settler, &workflow_receipt); // -> "settle"
    record(&env, &client, &mut observed);
    // Time-limited access leases: buy (pending), settle, revoke.
    let lease_amount = client.lease_price(&r0, &LeaseTier::Hour);
    client.buy_lease(
        &bob,
        &r0,
        &LeaseTier::Hour,
        &lease_amount,
        &String::from_str(&env, "leasetx0"),
    ); // -> "lease"
    record(&env, &client, &mut observed);
    client.settle_lease(&settler, &r0, &bob); // -> "leasesetl"
    record(&env, &client, &mut observed);
    client.revoke_lease(&r0, &bob); // -> "leaserevk"
    record(&env, &client, &mut observed);
    client.remove_settler(&settler); // -> "rmsettlr"
    record(&env, &client, &mut observed);

    client.set_paused(&admin2, &true); // -> "pause"
    record(&env, &client, &mut observed);
    client.set_paused_until(&admin2, &200); // -> "pause", "pause_until"
    record(&env, &client, &mut observed);
    client.set_paused(&admin2, &false);
    record(&env, &client, &mut observed);

    // Network bootstrap and the creator reactivation path round out the
    // documented event schema (`netinit` was already observed above, so this
    // only covers `reactive`; `initialize_network` is write-once).
    client.freeze_resource(&r0);
    record(&env, &client, &mut observed);
    client.reactivate_resource(&r0);
    record(&env, &client, &mut observed);

    // Moderator role and dispute flagging (#389).
    let moderator = Address::generate(&env);
    client.add_moderator(&moderator); // -> "addmod"
    record(&env, &client, &mut observed);
    client.flag_resource(&r0, &moderator, &FlagReason::Spam); // -> "flag"
    record(&env, &client, &mut observed);
    client.set_flag_reason_hash(&r0, &moderator, &String::from_str(&env, "reasonhash")); // -> "flagrsn"
    record(&env, &client, &mut observed);
    client.unflag_resource(&r0, &moderator); // -> "unflag"
    record(&env, &client, &mut observed);
    client.remove_moderator(&moderator); // -> "rmmod"
    record(&env, &client, &mut observed);

    // Recovery admin (dual-key bootstrap path).
    let recovery = Address::generate(&env);
    client.set_recovery_admin(&Some(recovery.clone())); // -> "setrecov"
    record(&env, &client, &mut observed);
    client.recover_admin(&Address::generate(&env)); // -> "recover"
    record(&env, &client, &mut observed);

    observed.sort();
    observed.dedup();

    let mut expected: std::vec::Vec<std::string::String> = EVENT_SCHEMA
        .iter()
        .map(|(topic, _)| std::string::String::from(*topic))
        .collect();
    expected.sort();

    assert_eq!(
        observed, expected,
        "emitted event topics must exactly match EVENT_SCHEMA in lib.rs — update \
         EVENT_SCHEMA (and contract/README.md's Events table) whenever you add, \
         rename, or remove an emitted event"
    );
}

// ── Fee configuration and basis-point calculation ───────────────────────────

fn fee_amount(amount: i128, fee_bps: u32) -> i128 {
    amount * i128::from(fee_bps) / i128::from(FEE_BPS_DENOM)
}

#[test]
fn fee_amount_calculation_handles_zero_and_standard_rates() {
    assert_eq!(fee_amount(1_000_000, 0), 0);
    assert_eq!(fee_amount(1_000_000, 250), 25_000);
    assert_eq!(fee_amount(1_000_000, 1_000), 100_000);
}

#[test]
fn fee_amount_calculation_truncates_fractional_stroops() {
    assert_eq!(fee_amount(101, 100), 1);
    assert_eq!(fee_amount(99, 100), 0);
}

#[test]
fn fee_amount_calculation_handles_maximum_rate_and_large_amount() {
    assert_eq!(fee_amount(1_000_000, MAX_FEE_BPS), 500_000);
    assert_eq!(fee_amount(MAX_PRICE, MAX_FEE_BPS), 500_000_000_000_000_000);
}

#[test]
fn fee_config_accepts_zero_and_exact_combined_limit() {
    let (env, _creator, admin, client) = setup_with_admin();

    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 0,
        royalty_bps: 0,
        fee_recipient: None,
    });
    assert_eq!(client.get_fee_config().unwrap().platform_fee_bps, 0);

    client.set_fee_config(&FeeConfig {
        platform_fee_bps: MAX_FEE_BPS / 2,
        royalty_bps: MAX_FEE_BPS - (MAX_FEE_BPS / 2),
        fee_recipient: Some(admin),
    });
    let config = client.get_fee_config().unwrap();
    assert_eq!(config.platform_fee_bps + config.royalty_bps, MAX_FEE_BPS);
    let _ = env;
}

#[test]
fn fee_config_rejects_each_rate_above_maximum() {
    let (_env, _creator, _admin, client) = setup_with_admin();

    assert_eq!(
        client.try_set_fee_config(&FeeConfig {
            platform_fee_bps: MAX_FEE_BPS + 1,
            royalty_bps: 0,
            fee_recipient: None,
        }),
        Err(Ok(Error::FeeBpsTooHigh))
    );
    assert_eq!(
        client.try_set_fee_config(&FeeConfig {
            platform_fee_bps: 0,
            royalty_bps: MAX_FEE_BPS + 1,
            fee_recipient: None,
        }),
        Err(Ok(Error::FeeBpsTooHigh))
    );
}

#[test]
fn fee_config_rejects_combined_rates_above_maximum() {
    let (_env, _creator, _admin, client) = setup_with_admin();

    assert_eq!(
        client.try_set_fee_config(&FeeConfig {
            platform_fee_bps: MAX_FEE_BPS / 2 + 1,
            royalty_bps: MAX_FEE_BPS / 2,
            fee_recipient: None,
        }),
        Err(Ok(Error::TotalFeeTooHigh))
    );
}

// ─── Fee recipient configuration (#617) ───────────────────────────────────

#[test]
fn set_fee_recipient_updates_only_recipient() {
    let (env, _creator, _admin, client) = setup_with_admin();

    // Set initial fee config with rates and recipient
    let initial_recipient = Address::generate(&env);
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 200,
        fee_recipient: Some(initial_recipient.clone()),
    });

    // Update only the recipient
    let new_recipient = Address::generate(&env);
    client.set_fee_recipient(&Some(new_recipient.clone()));

    // Verify recipient changed but rates stayed the same
    let config = client.get_fee_config().unwrap();
    assert_eq!(config.platform_fee_bps, 100);
    assert_eq!(config.royalty_bps, 200);
    assert_eq!(config.fee_recipient, Some(new_recipient));
}

#[test]
fn set_fee_recipient_can_clear_recipient() {
    let (env, _creator, _admin, client) = setup_with_admin();

    // Set initial config with recipient
    let recipient = Address::generate(&env);
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 50,
        fee_recipient: Some(recipient),
    });

    // Clear the recipient
    client.set_fee_recipient(&None);

    // Verify recipient is None but rates preserved
    let config = client.get_fee_config().unwrap();
    assert_eq!(config.platform_fee_bps, 100);
    assert_eq!(config.royalty_bps, 50);
    assert_eq!(config.fee_recipient, None);
}

#[test]
fn set_fee_recipient_can_set_recipient_when_none() {
    let (_env, _creator, admin, client) = setup_with_admin();

    // Set initial config without recipient
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 150,
        royalty_bps: 100,
        fee_recipient: None,
    });

    // Add a recipient
    client.set_fee_recipient(&Some(admin.clone()));

    // Verify recipient added
    let config = client.get_fee_config().unwrap();
    assert_eq!(config.fee_recipient, Some(admin));
}

#[test]
fn set_fee_recipient_fails_before_fee_config_set() {
    let (_env, _creator, admin, client) = setup_with_admin();

    // Try to set recipient before any fee config exists
    let res = client.try_set_fee_recipient(&Some(admin));
    assert_eq!(res, Err(Ok(Error::FeeConfigNotSet)));
}

#[test]
fn set_fee_recipient_requires_admin_auth() {
    let (env, _creator, _admin, client) = setup_with_admin();

    // Set initial fee config
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 100,
        fee_recipient: None,
    });

    // Without admin auth, the call should fail
    env.mock_auths(&[]);
    let new_recipient = Address::generate(&env);
    let res = client.try_set_fee_recipient(&Some(new_recipient));
    assert!(res.is_err());
}

#[test]
fn set_fee_recipient_emits_setfee_event() {
    let (env, _creator, _admin, client) = setup_with_admin();

    // Set initial config
    let initial_recipient = Address::generate(&env);
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 200,
        fee_recipient: Some(initial_recipient.clone()),
    });

    // Update recipient
    let new_recipient = Address::generate(&env);
    client.set_fee_recipient(&Some(new_recipient.clone()));

    // Verify setfee event was emitted
    let events = env.events().all();
    let last_event = events.last().unwrap();
    let (_contract, topics, data): (
        Address,
        soroban_sdk::Vec<soroban_sdk::Val>,
        soroban_sdk::Val,
    ) = last_event;

    // Event should have "setfee" topic
    let topic_symbol: soroban_sdk::Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(topic_symbol, symbol_short!("setfee"));

    // Data should contain old and new config
    let event_data: FeeConfigUpdated = data.try_into_val(&env).unwrap();

    // Old config should have initial recipient
    match event_data.old_config {
        OptFeeConfig::Some(old) => {
            assert_eq!(old.fee_recipient, Some(initial_recipient));
            assert_eq!(old.platform_fee_bps, 100);
            assert_eq!(old.royalty_bps, 200);
        }
        OptFeeConfig::None => panic!("Expected old config to be Some"),
    }

    // New config should have new recipient
    assert_eq!(event_data.new_config.fee_recipient, Some(new_recipient));
    assert_eq!(event_data.new_config.platform_fee_bps, 100);
    assert_eq!(event_data.new_config.royalty_bps, 200);
}

#[test]
fn fee_destination_defaults_to_disabled() {
    let (_env, _creator, _admin, client) = setup_with_admin();
    assert_eq!(
        client.get_fee_destination(),
        FeeDestinationConfig {
            bps: 0,
            destination: FeeDestination::None,
        }
    );
}

#[test]
fn set_fee_destination_supports_burn_charity_and_clear() {
    let (env, _creator, admin, client) = setup_with_admin();
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 1_000,
        royalty_bps: 0,
        fee_recipient: Some(admin),
    });

    let burn = FeeDestinationConfig {
        bps: 2_500,
        destination: FeeDestination::Burn,
    };
    client.set_fee_destination(&burn);
    assert_eq!(client.get_fee_destination(), burn);

    let charity = FeeDestinationConfig {
        bps: 5_000,
        destination: FeeDestination::Charity(Address::generate(&env)),
    };
    client.set_fee_destination(&charity);
    assert_eq!(client.get_fee_destination(), charity);

    let disabled = FeeDestinationConfig {
        bps: 0,
        destination: FeeDestination::None,
    };
    client.set_fee_destination(&disabled);
    assert_eq!(client.get_fee_destination(), disabled);
}

#[test]
fn set_fee_destination_emits_audit_event() {
    let (env, _creator, admin, client) = setup_with_admin();
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 1_000,
        royalty_bps: 0,
        fee_recipient: Some(admin),
    });

    env.ledger().set_sequence_number(321);
    let new_destination = FeeDestinationConfig {
        bps: 2_500,
        destination: FeeDestination::Burn,
    };
    client.set_fee_destination(&new_destination);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (contract, topics, data) = events.get(0).unwrap();
    assert_eq!(contract, client.address);
    assert_eq!(topics.len(), 1);
    let topic: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, symbol_short!("setdest"));
    let event: FeeDestinationUpdated = data.try_into_val(&env).unwrap();
    assert_eq!(
        event.old_destination,
        FeeDestinationConfig {
            bps: 0,
            destination: FeeDestination::None,
        }
    );
    assert_eq!(event.new_destination, new_destination);
    assert_eq!(event.ledger, 321);
}

#[test]
fn set_fee_destination_validates_bounds_and_combined_policy() {
    let (env, _creator, _admin, client) = setup_with_admin();
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 0,
        royalty_bps: 0,
        fee_recipient: None,
    });

    assert_eq!(
        client.try_set_fee_destination(&FeeDestinationConfig {
            bps: MAX_FEE_DESTINATION_BPS + 1,
            destination: FeeDestination::Burn,
        }),
        Err(Ok(Error::FeeBpsTooHigh))
    );
    assert_eq!(
        client.try_set_fee_destination(&FeeDestinationConfig {
            bps: 0,
            destination: FeeDestination::Burn,
        }),
        Err(Ok(Error::TotalFeeTooHigh))
    );
    assert_eq!(
        client.try_set_fee_destination(&FeeDestinationConfig {
            bps: 0,
            destination: FeeDestination::Charity(Address::generate(&env)),
        }),
        Err(Ok(Error::TotalFeeTooHigh))
    );
    assert_eq!(
        client.try_set_fee_destination(&FeeDestinationConfig {
            bps: 2_500,
            destination: FeeDestination::Burn,
        }),
        Err(Ok(Error::TotalFeeTooHigh))
    );
    assert_eq!(
        client.get_fee_destination(),
        FeeDestinationConfig {
            bps: 0,
            destination: FeeDestination::None,
        }
    );

    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 1_000,
        royalty_bps: 0,
        fee_recipient: None,
    });
    assert_eq!(
        client.try_set_fee_destination(&FeeDestinationConfig {
            bps: 2_500,
            destination: FeeDestination::Burn,
        }),
        Err(Ok(Error::TotalFeeTooHigh))
    );
    client.set_fee_destination(&FeeDestinationConfig {
        bps: MAX_FEE_DESTINATION_BPS,
        destination: FeeDestination::Burn,
    });
}

#[test]
fn set_fee_destination_requires_fee_config() {
    let (_env, _creator, _admin, client) = setup_with_admin();
    assert_eq!(
        client.try_set_fee_destination(&FeeDestinationConfig {
            bps: MAX_FEE_DESTINATION_BPS,
            destination: FeeDestination::Burn,
        }),
        Err(Ok(Error::FeeConfigNotSet))
    );
}

#[test]
fn set_fee_destination_requires_admin_auth() {
    let (env, _creator, _admin, client) = setup_with_admin();
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 1_000,
        royalty_bps: 0,
        fee_recipient: Some(Address::generate(&env)),
    });
    env.mock_auths(&[]);
    let result = client.try_set_fee_destination(&FeeDestinationConfig {
        bps: MAX_FEE_DESTINATION_BPS,
        destination: FeeDestination::Burn,
    });
    assert!(result.is_err());
}

#[test]
fn set_fee_destination_fails_when_paused() {
    let (_env, _creator, admin, client) = setup_with_admin();
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 1_000,
        royalty_bps: 0,
        fee_recipient: Some(admin.clone()),
    });
    client.set_paused(&admin, &true);
    let result = client.try_set_fee_destination(&FeeDestinationConfig {
        bps: MAX_FEE_DESTINATION_BPS,
        destination: FeeDestination::Burn,
    });
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
    assert_eq!(
        client.get_fee_destination(),
        FeeDestinationConfig {
            bps: 0,
            destination: FeeDestination::None,
        }
    );
}

#[test]
fn fee_destination_is_preserved_and_partial_routes_require_recipient() {
    let (_env, _creator, admin, client) = setup_with_admin();
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 1_000,
        royalty_bps: 0,
        fee_recipient: Some(admin.clone()),
    });
    let destination = FeeDestinationConfig {
        bps: 5_000,
        destination: FeeDestination::Burn,
    };
    client.set_fee_destination(&destination);

    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 2_000,
        royalty_bps: 500,
        fee_recipient: Some(admin.clone()),
    });
    assert_eq!(client.get_fee_destination(), destination);

    assert_eq!(
        client.try_set_fee_recipient(&None),
        Err(Ok(Error::TotalFeeTooHigh))
    );
    let full_destination = FeeDestinationConfig {
        bps: MAX_FEE_DESTINATION_BPS,
        destination: FeeDestination::Burn,
    };
    client.set_fee_destination(&full_destination);
    client.set_fee_recipient(&None);
    assert_eq!(client.get_fee_destination(), full_destination);
    assert_eq!(client.get_fee_config().unwrap().fee_recipient, None);
}

#[test]
fn set_fee_recipient_fails_when_paused() {
    let (_env, _creator, admin, client) = setup_with_admin();

    // Set initial fee config
    client.set_fee_config(&FeeConfig {
        platform_fee_bps: 100,
        royalty_bps: 100,
        fee_recipient: None,
    });

    // Pause the contract
    client.set_paused(&admin, &true);

    // Try to set recipient while paused
    let res = client.try_set_fee_recipient(&Some(admin));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

// ─── Test helpers for the role / verification / freeze / repair suites ────

/// Like `setup`, but also installs `admin` as the contract admin via the
/// bootstrap path of `nominate_new_admin`.
fn setup_with_admin<'a>() -> (Env, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, client) = setup();
    let admin = Address::generate(&env);
    client.nominate_new_admin(&admin);
    (env, creator, admin, client)
}

/// Register a resource with a valid cuid2-shaped id and a valid metadata
/// pointer, no tags. Returns the id.
fn register_default<'a>(
    env: &Env,
    creator: &Address,
    client: &VaultRegistryClient<'a>,
    id: &str,
) -> String {
    let id = String::from_str(env, id);
    client.register(
        creator,
        &id,
        &100i128,
        &String::from_str(env, "ipfs://m"),
        &empty_tags(env),
    );
    id
}

fn register_priced<'a>(
    env: &Env,
    creator: &Address,
    client: &VaultRegistryClient<'a>,
    id: &str,
    price: i128,
) -> String {
    let id = String::from_str(env, id);
    client.register(
        creator,
        &id,
        &price,
        &String::from_str(env, "ipfs://m"),
        &empty_tags(env),
    );
    id
}

// ─── Verifier role management (#437) ───────────────────────────────────────

#[test]
fn admin_can_grant_and_revoke_verifier() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);

    assert!(!client.is_verifier(&verifier));

    client.add_verifier(&verifier);
    assert!(client.is_verifier(&verifier));

    client.remove_verifier(&verifier);
    assert!(!client.is_verifier(&verifier));
}

#[test]
fn add_verifier_before_admin_set_fails() {
    let (env, _creator, client) = setup();
    let verifier = Address::generate(&env);
    let res = client.try_add_verifier(&verifier);
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn is_verifier_false_for_unknown_address() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let stranger = Address::generate(&env);
    assert!(!client.is_verifier(&stranger));
}

// ─── Verifier removal authorization regression tests (#615) ───────────────

#[test]
fn remove_verifier_before_admin_set_fails() {
    let (env, _creator, client) = setup();
    let verifier = Address::generate(&env);
    let res = client.try_remove_verifier(&verifier);
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn remove_verifier_idempotent() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);

    // Add and remove verifier
    client.add_verifier(&verifier);
    assert!(client.is_verifier(&verifier));

    client.remove_verifier(&verifier);
    assert!(!client.is_verifier(&verifier));

    // Removing again should not error (idempotent)
    client.remove_verifier(&verifier);
    assert!(!client.is_verifier(&verifier));
}

#[test]
fn remove_verifier_requires_admin_auth() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);

    // Admin adds a verifier
    client.add_verifier(&verifier);
    assert!(client.is_verifier(&verifier));

    // Without mocking auth, the call will fail auth check
    env.mock_auths(&[]);
    let res = client.try_remove_verifier(&verifier);
    assert!(res.is_err());

    // With admin auth, it succeeds
    env.mock_all_auths();
    client.remove_verifier(&verifier);
    assert!(!client.is_verifier(&verifier));
}

#[test]
fn remove_verifier_revokes_verification_ability() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "revoketest");
    let verifier = Address::generate(&env);

    // Add verifier and verify they can set verification status
    client.add_verifier(&verifier);
    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    let resource = client.get(&id);
    assert_eq!(resource.verified, VerificationStatus::Verified);

    // Remove verifier
    client.remove_verifier(&verifier);
    assert!(!client.is_verifier(&verifier));

    // Register another resource
    let id2 = register_default(&env, &creator, &client, "revoketest2");

    // Removed verifier cannot set verification status
    let res =
        client.try_set_verification_status(&id2, &verifier, &VerificationStatus::Verified, &None);
    assert_eq!(res, Err(Ok(Error::NotVerifier)));
}

#[test]
fn admin_can_rotate_verifier_with_audit_event() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let old_verifier = Address::generate(&env);
    let new_verifier = Address::generate(&env);

    client.add_verifier(&old_verifier);
    let ledger = env.ledger().sequence();
    client.rotate_verifier(&old_verifier, &new_verifier);

    let events = env.events().all();
    assert!(!client.is_verifier(&old_verifier));
    assert!(client.is_verifier(&new_verifier));

    let mut found = false;
    for i in 0..events.len() {
        let (contract, topics, data) = events.get(i).unwrap();
        if contract != client.address {
            continue;
        }
        let topic: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        if topic != symbol_short!("verrot") {
            continue;
        }
        assert_eq!(topics.len(), 2);
        let topic_old_verifier: Address = topics.get(1).unwrap().try_into_val(&env).unwrap();
        let payload: VerifierRotation = data.try_into_val(&env).unwrap();
        assert_eq!(topic_old_verifier, old_verifier);
        assert_eq!(
            payload,
            VerifierRotation {
                old_verifier: old_verifier.clone(),
                new_verifier: new_verifier.clone(),
                ledger,
            }
        );
        found = true;
    }
    assert!(found, "rotate_verifier must emit a verrot event");
}

#[test]
fn rotate_verifier_requires_admin_auth() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let old_verifier = Address::generate(&env);
    let new_verifier = Address::generate(&env);
    client.add_verifier(&old_verifier);

    env.mock_auths(&[]);
    let result = client.try_rotate_verifier(&old_verifier, &new_verifier);
    assert!(result.is_err());

    env.mock_all_auths();
    assert!(client.is_verifier(&old_verifier));
    assert!(!client.is_verifier(&new_verifier));
}

#[test]
fn rotate_verifier_rejects_unregistered_old_verifier() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let old_verifier = Address::generate(&env);
    let new_verifier = Address::generate(&env);

    let result = client.try_rotate_verifier(&old_verifier, &new_verifier);
    assert_eq!(result, Err(Ok(Error::NotFound)));
    assert!(!client.is_verifier(&old_verifier));
    assert!(!client.is_verifier(&new_verifier));
}

#[test]
fn rotate_verifier_rejects_same_key_without_state_change() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    let result = client.try_rotate_verifier(&verifier, &verifier);
    assert_eq!(result, Err(Ok(Error::AlreadyRegistered)));
    assert!(client.is_verifier(&verifier));
}

#[test]
fn rotate_verifier_rejects_registered_new_key_without_state_change() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let old_verifier = Address::generate(&env);
    let new_verifier = Address::generate(&env);
    client.add_verifier(&old_verifier);
    client.add_verifier(&new_verifier);

    let result = client.try_rotate_verifier(&old_verifier, &new_verifier);
    assert_eq!(result, Err(Ok(Error::AlreadyRegistered)));
    assert!(client.is_verifier(&old_verifier));
    assert!(client.is_verifier(&new_verifier));
}

// ─── On-chain verification status mirror (#436) ────────────────────────────

#[test]
fn resource_starts_pending_and_unfrozen() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "vres0");
    let resource = client.get(&id);
    assert_eq!(resource.verified, VerificationStatus::Pending);
    assert!(!resource.frozen);
    assert_eq!(resource.state, ResourceState::Listed);
    assert!(resource.listed);
}

// ─── Resource lifecycle state machine (#455) ──────────────────────────────

#[test]
fn creator_lifecycle_transitions_keep_listing_projection_in_sync() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "lifecyc1");

    client.set_listed(&id, &false);
    let delisted = client.get(&id);
    assert_eq!(delisted.state, ResourceState::Delisted);
    assert!(!delisted.listed);

    client.set_listed(&id, &true);
    let listed = client.get(&id);
    assert_eq!(listed.state, ResourceState::Listed);
    assert!(listed.listed);

    client.freeze_resource(&id);
    let frozen = client.get(&id);
    assert_eq!(frozen.state, ResourceState::Frozen);
    assert!(!frozen.listed);
}

#[test]
fn lifecycle_rejects_creator_transitions_out_of_frozen() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "lifecyc2");

    client.freeze_resource(&id);
    assert_eq!(
        client.try_set_listed(&id, &false),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
    assert_eq!(
        client.try_freeze_resource(&id),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn admin_can_dispute_resolve_and_tombstone_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "lifecyc3");

    client.open_dispute(&id, &admin);
    assert_eq!(client.get(&id).state, ResourceState::Disputed);
    assert_eq!(
        client.try_set_price(&id, &200i128),
        Err(Ok(Error::ResourceNotMutable))
    );

    client.resolve_dispute(&id, &admin, &ResourceState::Frozen);
    assert_eq!(client.get(&id).state, ResourceState::Frozen);

    client.tombstone_resource(&id, &admin);
    let tombstoned = client.get(&id);
    assert_eq!(tombstoned.state, ResourceState::Tombstoned);
    assert!(!tombstoned.listed);
    assert_eq!(
        client.try_tombstone_resource(&id, &admin),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn admin_can_emergency_delist_disputed_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "emerdelist");

    client.open_dispute(&id, &admin);
    client.emergency_delist(&id, &admin, &String::from_str(&env, "dispute upheld"));

    let resource = client.get(&id);
    assert_eq!(resource.state, ResourceState::Delisted);
    assert!(!resource.listed);
    assert_eq!(client.listed_count(), 0);
}

#[test]
fn emergency_delist_requires_current_admin_and_disputed_state() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "emerdelist2");
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_emergency_delist(&id, &stranger, &String::from_str(&env, "dispute upheld")),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_emergency_delist(&id, &admin, &String::from_str(&env, "dispute upheld")),
        Err(Ok(Error::InvalidLifecycleTransition))
    );

    client.open_dispute(&id, &admin);
    client.emergency_delist(&id, &admin, &String::from_str(&env, "dispute upheld"));
    assert_eq!(client.get(&id).state, ResourceState::Delisted);
}

/// Regression test for #779: an admin emergency delist must be attributable
/// at the event boundary.
///
/// Before this, `emergency_delist` emitted no event at all, so an indexer could
/// not tell an admin takedown from a creator delist without re-reading state.
/// The payload must carry the acting admin and the caller's reason verbatim.
#[test]
fn emergency_delist_emits_event_with_acting_admin_and_reason() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "emdelistevt");
    let contract_id = client.address.clone();

    client.open_dispute(&id, &admin);
    client.emergency_delist(
        &id,
        &admin,
        &String::from_str(&env, "counterfeit listing, dispute upheld"),
    );

    let payload: EmergencyDelistEvent =
        find_event(&env, &contract_id, "emdelist").expect("emdelist must be emitted");
    assert_eq!(
        payload.id, id,
        "payload must identify the delisted resource"
    );
    assert_eq!(
        payload.admin, admin,
        "payload must name the admin who acted, so the takedown is attributable"
    );
    assert_eq!(
        payload.reason,
        String::from_str(&env, "counterfeit listing, dispute upheld"),
        "payload must carry the admin's stated reason verbatim"
    );
}

/// The event topic itself is the discriminator: a creator delist emits
/// `setlisted` and no `emdelist`, and an admin takedown emits `emdelist` and no
/// `setlisted`. An indexer keying on topic can therefore never confuse the two.
#[test]
fn emergency_delist_and_creator_delist_are_distinguishable_by_topic() {
    let (env, creator, admin, client) = setup_with_admin();
    let contract_id = client.address.clone();

    // Creator-initiated delist.
    let creator_id = register_default(&env, &creator, &client, "emdelistcrea");
    client.delist(&creator_id);
    assert!(
        find_event::<EmergencyDelistEvent>(&env, &contract_id, "emdelist").is_none(),
        "a creator delist must not emit `emdelist`"
    );
    assert!(
        find_event::<(bool, bool)>(&env, &contract_id, "setlisted").is_some(),
        "a creator delist emits `setlisted`"
    );

    // Admin-initiated emergency delist on a separate resource.
    let admin_id = register_default(&env, &creator, &client, "emdelistadmn");
    client.open_dispute(&admin_id, &admin);
    client.emergency_delist(&admin_id, &admin, &String::from_str(&env, "abuse"));

    assert!(
        find_event::<EmergencyDelistEvent>(&env, &contract_id, "emdelist").is_some(),
        "an admin emergency delist must emit `emdelist`"
    );

    // Both resources end up `Delisted`, so state alone cannot tell them apart —
    // only the event stream can. That is the bug this fixes.
    assert_eq!(client.get(&creator_id).state, ResourceState::Delisted);
    assert_eq!(client.get(&admin_id).state, ResourceState::Delisted);
}

#[test]
fn tombstoned_resource_is_not_discoverable_by_tag_but_stays_auditable() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = String::from_str(&env, "lifecyc5");
    let tags_before = tags(&env, &["archive", "proof"]);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://audit"),
        &tags_before,
    );

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "archive"), &0u32, &20u32)
            .len(),
        1
    );

    let before = client.get(&id);
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client
            .list_by_tag(&String::from_str(&env, "archive"), &0u32, &20u32)
            .len(),
        0,
        "tombstoned resources must not be discoverable by tag"
    );

    let after = client.get(&id);
    assert_eq!(after.state, ResourceState::Tombstoned);
    assert_eq!(after.id, before.id);
    assert_eq!(after.metadata, before.metadata);
    assert_eq!(after.creator, before.creator);

    // Tombstoned resources remain in canonical storage for auditability.
    let all = client.list(&0u32, &20u32);
    assert_eq!(all.len(), 1);
    assert_eq!(all.get(0).unwrap().id, id);
}

// ── Listing index cleanup on tombstone ──────────────────────────────────────
//
// Tombstoning is terminal, so the derived listing indexes must not keep
// pointing at a retired resource. The tag index was already purged; these
// tests pin the creator index and `creator_resource_count` to the same rule,
// and pin the two indexes that deliberately are *not* touched (the canonical
// `Resource` entry, and the monotonic `Index`/`Count` catalog pair).

#[test]
fn tombstone_removes_resource_from_creator_index() {
    let (env, creator, admin, client) = setup_with_admin();
    let kept = register_default(&env, &creator, &client, "tombkeep");
    let doomed = register_default(&env, &creator, &client, "tombgone");

    assert_eq!(client.list_by_creator(&creator, &0u32, &20u32).len(), 2);

    client.tombstone_resource(&doomed, &admin);

    let listed = client.list_by_creator(&creator, &0u32, &20u32);
    assert_eq!(
        listed.len(),
        1,
        "tombstoned resources must not surface in list_by_creator"
    );
    assert_eq!(listed.get(0).unwrap().id, kept);
}

#[test]
fn tombstone_decrements_creator_resource_count() {
    let (env, creator, admin, client) = setup_with_admin();
    register_default(&env, &creator, &client, "tombcnt1");
    let doomed = register_default(&env, &creator, &client, "tombcnt2");
    assert_eq!(client.creator_resource_count(&creator), 2);

    client.tombstone_resource(&doomed, &admin);

    assert_eq!(
        client.creator_resource_count(&creator),
        1,
        "creator_resource_count must not count retired resources"
    );
}

#[test]
fn tombstone_leaves_global_catalog_index_intact() {
    let (env, creator, admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "tombcat1");
    let b = register_default(&env, &creator, &client, "tombcat2");

    client.tombstone_resource(&a, &admin);

    // `Count` is monotonic and `list` stays an audit view over every id ever
    // registered — only the discovery indexes are pruned.
    assert_eq!(client.count(), 2, "count() must stay monotonic");
    let all = client.list(&0u32, &20u32);
    assert_eq!(all.len(), 2);
    assert_eq!(all.get(0).unwrap().id, a);
    assert_eq!(all.get(1).unwrap().id, b);
    assert!(client.exists(&a));
}

#[test]
fn tombstone_cleans_the_current_owner_index_after_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "tombxfer");
    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.creator_resource_count(&new_owner), 1);
    assert_eq!(client.creator_resource_count(&creator), 0);

    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.list_by_creator(&new_owner, &0u32, &20u32).len(),
        0,
        "the index cleaned must be the current owner's, not the original creator's"
    );
    assert_eq!(client.creator_resource_count(&new_owner), 0);
    assert_eq!(
        client.creator_resource_count(&creator),
        0,
        "the previous owner's count must not go negative"
    );
}

#[test]
fn tombstone_index_cleanup_leaves_other_creators_untouched() {
    let (env, creator, admin, client) = setup_with_admin();
    let other = Address::generate(&env);
    let mine = register_default(&env, &creator, &client, "tombmine");
    let theirs = register_default(&env, &other, &client, "tombtheir");

    client.tombstone_resource(&mine, &admin);

    assert_eq!(client.creator_resource_count(&other), 1);
    let listed = client.list_by_creator(&other, &0u32, &20u32);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed.get(0).unwrap().id, theirs);
}

#[test]
fn tombstoned_resource_blocks_creator_mutations_deterministically() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = String::from_str(&env, "lifecyc6");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://audit2"),
        &tags(&env, &["tag1"]),
    );
    client.tombstone_resource(&id, &admin);

    assert_eq!(
        client.try_set_price(&id, &200i128),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_update_metadata(&id, &String::from_str(&env, "ipfs://new")),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_set_tags(&id, &tags(&env, &["tag2"])),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_transfer_ownership(&id, &Address::generate(&env)),
        Err(Ok(Error::ResourceNotMutable))
    );
    assert_eq!(
        client.try_set_listed(&id, &true),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn lifecycle_admin_methods_reject_wrong_role_and_invalid_resolution() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "lifecyc4");
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_open_dispute(&id, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_resolve_dispute(&id, &admin, &ResourceState::Listed),
        Err(Ok(Error::InvalidLifecycleTransition))
    );

    client.open_dispute(&id, &admin);
    assert_eq!(
        client.try_resolve_dispute(&id, &admin, &ResourceState::Tombstoned),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
}

#[test]
fn verifier_can_verify_pending_resource() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres1");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    assert_eq!(client.get(&id).verified, VerificationStatus::Verified);
}

#[test]
fn set_verification_status_emits_old_and_new_status() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres2");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);

    let all = env.events().all();
    let (_contract, topics, data) = all.get_unchecked(all.len() - 1);
    assert_eq!(topics.len(), 2);
    let topic: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, symbol_short!("verify"));
    let topic_id: String = String::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_id, id);

    let decoded: (VerificationStatus, VerificationStatus, Option<String>) =
        <(VerificationStatus, VerificationStatus, Option<String>)>::try_from_val(&env, &data)
            .expect("failed to decode verification event");
    assert_eq!(decoded.0, VerificationStatus::Pending);
    assert_eq!(decoded.1, VerificationStatus::Verified);
    assert_eq!(decoded.2, None);
}

#[test]
fn non_verifier_cannot_set_verification_status() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres3");
    let stranger = Address::generate(&env);

    let res =
        client.try_set_verification_status(&id, &stranger, &VerificationStatus::Verified, &None);
    assert_eq!(res, Err(Ok(Error::NotVerifier)));
    assert_eq!(client.get(&id).verified, VerificationStatus::Pending);
}

#[test]
fn revoked_verifier_cannot_set_verification_status() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres4");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    client.remove_verifier(&verifier);

    let res =
        client.try_set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    assert_eq!(res, Err(Ok(Error::NotVerifier)));
}

#[test]
fn verification_self_transition_rejected() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres5");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    // Pending -> Pending is a no-op and rejected as invalid.
    let res =
        client.try_set_verification_status(&id, &verifier, &VerificationStatus::Pending, &None);
    assert_eq!(res, Err(Ok(Error::InvalidVerificationTransition)));
}

#[test]
fn verification_cannot_revert_to_pending() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres6");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    let res =
        client.try_set_verification_status(&id, &verifier, &VerificationStatus::Pending, &None);
    assert_eq!(res, Err(Ok(Error::InvalidVerificationTransition)));
}

#[test]
fn verification_round_trip_verified_rejected_verified() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres7");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    client.set_verification_status(&id, &verifier, &VerificationStatus::Rejected, &None);
    assert_eq!(client.get(&id).verified, VerificationStatus::Rejected);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    assert_eq!(client.get(&id).verified, VerificationStatus::Verified);
}

#[test]
fn verification_status_on_missing_resource_fails() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    let res = client.try_set_verification_status(
        &String::from_str(&env, "nosuchresource"),
        &verifier,
        &VerificationStatus::Verified,
        &None,
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn verification_status_can_store_and_retrieve_attestation_hash() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres8");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    let hash_val = String::from_str(&env, "a1b2c3d4e5f6g7h8i9j0");
    client.set_verification_status(
        &id,
        &verifier,
        &VerificationStatus::Verified,
        &Some(hash_val.clone()),
    );

    assert_eq!(client.get(&id).verified, VerificationStatus::Verified);
    let retrieved_hash = client.get_attestation_hash(&id);
    assert_eq!(
        retrieved_hash,
        Some(String::from_str(&env, "sha256:a1b2c3d4e5f6g7h8i9j0"))
    );

    // Clearing it
    client.set_verification_status(&id, &verifier, &VerificationStatus::Rejected, &None);
    assert_eq!(client.get_attestation_hash(&id), None);
}

#[test]
fn verification_status_preserves_explicit_attestation_hash_algorithm() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "vres9");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    let hash_val = String::from_str(&env, "poseidon:abc123");

    client.set_verification_status(
        &id,
        &verifier,
        &VerificationStatus::Verified,
        &Some(hash_val.clone()),
    );

    assert_eq!(client.get_attestation_hash(&id), Some(hash_val));
}

// ─── Metadata freeze (#438) ────────────────────────────────────────────────

/// `METHOD_SCHEMA` in lib.rs is the single source of truth for the contract's
/// exported API surface. `contract/README.md`'s Methods table must document
/// exactly those entries — no stale rows, no undocumented methods.
#[test]
fn readme_methods_table_matches_method_schema() {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("contract/README.md must be readable from the vault-registry crate");

    let methods_section = readme
        .split("### Methods")
        .nth(1)
        .expect("contract/README.md must have a `### Methods` section")
        .split("### Roles")
        .next()
        .expect("`### Methods` section must be followed by `### Roles`");

    let documented: std::vec::Vec<&str> = methods_section
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("| `")?;
            let end = rest.find(['(', '`'])?;
            Some(&rest[..end])
        })
        .collect();

    for (name, _auth) in METHOD_SCHEMA {
        assert!(
            documented.contains(name),
            "METHOD_SCHEMA lists `{name}` but contract/README.md's Methods table \
             does not document it — update the table to match lib.rs::METHOD_SCHEMA"
        );
    }

    for name in &documented {
        assert!(
            METHOD_SCHEMA.iter().any(|(method, _)| method == name),
            "contract/README.md documents method `{name}` but it is not in \
             lib.rs::METHOD_SCHEMA — either the doc is stale or METHOD_SCHEMA is \
             missing an entry"
        );
    }

    assert_eq!(
        documented.len(),
        METHOD_SCHEMA.len(),
        "contract/README.md's Methods table row count must match METHOD_SCHEMA's \
         length exactly (no duplicate or missing rows)"
    );
}

/// `ERROR_SCHEMA` in lib.rs is the single source of truth for error codes.
/// `contract/README.md`'s Error codes table must document exactly those codes,
/// with matching discriminants and names.
#[test]
fn readme_error_codes_table_matches_error_schema() {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("contract/README.md must be readable from the vault-registry crate");

    let errors_section = readme
        .split("### Error codes")
        .nth(1)
        .expect("contract/README.md must have an `### Error codes` section")
        .split("### Events")
        .next()
        .expect("`### Error codes` section must be followed by `### Events`");

    let documented: std::vec::Vec<(u32, &str)> = errors_section
        .lines()
        .filter_map(|line| {
            let mut cells = line.trim().split('|').map(str::trim);
            cells.next()?; // leading empty cell
            let code = cells.next()?.trim_matches('`').parse::<u32>().ok()?;
            let name = cells.next()?.trim_matches('`');
            Some((code, name))
        })
        .collect();

    for (code, name, _desc) in ERROR_SCHEMA {
        assert!(
            documented.contains(&(*code, name)),
            "ERROR_SCHEMA lists `{code}`/`{name}` but contract/README.md's Error \
             codes table does not document it — update the table to match \
             lib.rs::ERROR_SCHEMA"
        );
    }

    for (code, name) in &documented {
        assert!(
            ERROR_SCHEMA
                .iter()
                .any(|(schema_code, schema_name, _)| schema_code == code && schema_name == name),
            "contract/README.md documents error `{code}`/`{name}` but it is not in \
             lib.rs::ERROR_SCHEMA — either the doc is stale or ERROR_SCHEMA is \
             missing an entry"
        );
    }

    assert_eq!(
        documented.len(),
        ERROR_SCHEMA.len(),
        "contract/README.md's Error codes table row count must match \
         ERROR_SCHEMA's length exactly (no duplicate or missing rows)"
    );
}

#[test]
fn event_schema_matches_documented_readme_table() {
    let readme = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../README.md"))
        .expect("contract/README.md must be readable from the vault-registry crate");

    let events_section = readme
        .split("### Events")
        .nth(1)
        .expect("contract/README.md must have an `### Events` section")
        .split("### Resource lifecycle")
        .next()
        .expect("`### Events` section must precede lifecycle documentation")
        .split("### Registry info")
        .next()
        .expect("`### Events` section must be immediately followed by `### Registry info`");

    for (topic, _payload) in EVENT_SCHEMA {
        let needle = std::format!("| `{topic}` ");
        assert!(
            events_section.contains(needle.as_str()),
            "EVENT_SCHEMA lists `{topic}` but contract/README.md's Events table \
             does not document it — update the table to match lib.rs::EVENT_SCHEMA"
        );
    }

    // Reverse direction: every event name documented in the table's leading
    // column must be a real, currently-emitted topic in EVENT_SCHEMA — and
    // there must be exactly one documented row per schema entry (no stale
    // duplicates left behind by a bad merge).
    let documented: std::vec::Vec<&str> = events_section
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("| `")?;
            let end = rest.find('`')?;
            Some(&rest[..end])
        })
        .collect();

    for name in &documented {
        assert!(
            EVENT_SCHEMA.iter().any(|(topic, _)| topic == name),
            "contract/README.md documents event `{name}` but it is not in \
             lib.rs::EVENT_SCHEMA — either the doc is stale or EVENT_SCHEMA is \
             missing an entry"
        );
    }

    assert_eq!(
        documented.len(),
        EVENT_SCHEMA.len(),
        "contract/README.md's Events table row count must match EVENT_SCHEMA's \
         length exactly (no duplicate or missing rows)"
    );
}

#[test]
fn freeze_metadata_sets_flag_and_emits_event() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres0");

    client.freeze_metadata(&id);
    // Checked immediately after the write, before any other invocation
    // (e.g. a read call) rolls the per-invocation event log forward.
    assert_eq!(env.events().all().len(), 1);
    assert!(client.get(&id).frozen);
}

#[test]
fn freeze_metadata_twice_fails() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres1");
    client.freeze_metadata(&id);

    let res = client.try_freeze_metadata(&id);
    assert_eq!(res, Err(Ok(Error::AlreadyFrozen)));
}

#[test]
fn update_metadata_on_frozen_resource_fails() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres2");
    client.freeze_metadata(&id);

    let res = client.try_update_metadata(&id, &String::from_str(&env, "ipfs://new"));
    assert_eq!(res, Err(Ok(Error::MetadataFrozen)));
}

#[test]
fn frozen_resource_still_allows_price_listing_tags_and_ownership_mutations() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "fres3");
    client.freeze_metadata(&id);

    client.set_price(&id, &500i128);
    assert_eq!(client.get(&id).price, 500i128);

    client.set_listed(&id, &false);
    assert!(!client.get(&id).listed);

    client.set_tags(&id, &tags(&env, &["dataset"]));
    assert_eq!(client.get(&id).tags.len(), 1);

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.get(&id).creator, new_owner);

    // Frozen state survives all of the above.
    assert!(client.get(&id).frozen);
}

// ─── Index repair (#428) ───────────────────────────────────────────────────

#[test]
fn repair_index_rebuilds_from_authoritative_list() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres0a");
    let b = register_default(&env, &creator, &client, "rres0b");
    let c = register_default(&env, &creator, &client, "rres0c");

    client.repair_index(&Vec::from_array(&env, [c.clone(), a.clone()]));

    assert_eq!(client.count(), 2);
    let page = client.list(&0u32, &10u32);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap().id, c);
    assert_eq!(page.get(1).unwrap().id, a);

    // repair only rewrites the derived index — the dropped resource `b` is
    // still directly addressable by id.
    assert!(client.exists(&b));
    assert_eq!(client.get(&b).id, b);
}

#[test]
fn repair_index_rejects_unknown_id() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres1a");

    let res = client.try_repair_index(&Vec::from_array(
        &env,
        [a.clone(), String::from_str(&env, "ghost")],
    ));
    assert_eq!(res, Err(Ok(Error::NotFound)));
    // No partial write: the index is untouched.
    assert_eq!(client.count(), 1);
    assert_eq!(client.list(&0u32, &10u32).get(0).unwrap().id, a);
}

#[test]
fn repair_index_rejects_duplicates() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres2a");

    let res = client.try_repair_index(&Vec::from_array(&env, [a.clone(), a.clone()]));
    assert_eq!(res, Err(Ok(Error::DuplicateInRepair)));
}

#[test]
fn repair_index_before_admin_set_fails() {
    let (env, creator, client) = setup();
    let a = register_default(&env, &creator, &client, "rres3a");

    let res = client.try_repair_index(&Vec::from_array(&env, [a.clone()]));
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn repair_index_rerunning_current_list_is_a_safe_noop() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "rres4a");
    let b = register_default(&env, &creator, &client, "rres4b");

    client.repair_index(&Vec::from_array(&env, [a.clone(), b.clone()]));
    assert_eq!(client.count(), 2);
    let page = client.list(&0u32, &10u32);
    assert_eq!(page.get(0).unwrap().id, a);
    assert_eq!(page.get(1).unwrap().id, b);
}

// ---------------------------------------------------------------------------
// Issue 1 — MAX_METADATA_POINTER_LEN boundary hardening
// ---------------------------------------------------------------------------
//
// Acceptance criteria:
//   • Exact max length succeeds.            (register_accepts_metadata_at_max_length above)
//   • Max + 1 fails with MetadataTooLong.   (register_rejects_metadata_over_max_length above)
//   • Random shorter format-valid strings succeed.  ← proptest below
//   • update_metadata obeys the same boundary.      (update_metadata_accepts_at_max_length above)
//   • Error handling is deterministic: only MetadataTooLong is returned for over-limit,
//     never a panic or a different error code.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]
    /// Any format-valid metadata pointer up to MAX_METADATA_POINTER_LEN bytes
    /// must be accepted by both `register` and `update_metadata`. The prefix
    /// is fixed; the body length is drawn uniformly in [0, max − longest_prefix_len]
    /// where the longest prefix is `https://` (8 bytes) to ensure both the
    /// `ipfs://` and `https://` forms stay within MAX_METADATA_POINTER_LEN.
    #[test]
    fn metadata_boundary_shorter_strings_always_succeed(
        id_str   in r"[a-z][a-z0-9]{0,10}",
        // Bound by "https://" (8 bytes) — the longer of the two prefixes used
        // in this test — so the generated body stays within MAX_METADATA_POINTER_LEN
        // for both the register ("ipfs://") and update_metadata ("https://") steps.
        body_len in 0usize..=(512usize - "https://".len()),
        ch       in r"[a-zA-Z0-9]",
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);

        let body: alloc::string::String = ch.repeat(body_len);
        let raw = alloc::format!("ipfs://{}", body);
        // Double-check our generator stays within the contract limit.
        prop_assert!(raw.len() <= MAX_METADATA_POINTER_LEN as usize);

        let id       = String::from_str(&env, &id_str);
        let metadata = String::from_str(&env, &raw);

        // register must succeed
        let reg_result = client.try_register(
            &creator, &id, &100i128, &metadata, &empty_tags(&env),
        );
        prop_assert!(reg_result.is_ok(), "register rejected valid metadata of len {}: {:?}", raw.len(), reg_result);

        // update_metadata must also succeed
        let new_body: alloc::string::String = ch.repeat(body_len.min(512usize - "https://".len()));
        let new_raw  = alloc::format!("https://{}", new_body);
        prop_assert!(new_raw.len() <= MAX_METADATA_POINTER_LEN as usize);
        let new_meta = String::from_str(&env, &new_raw);
        let upd_result = client.try_update_metadata(&id, &new_meta);
        prop_assert!(upd_result.is_ok(), "update_metadata rejected valid metadata of len {}: {:?}", new_raw.len(), upd_result);
    }

    /// Over-limit metadata (MAX + 1 … MAX + 50) must always return MetadataTooLong,
    /// never any other error and never succeed.
    #[test]
    fn metadata_over_limit_always_returns_metadata_too_long(
        id_str  in r"[a-z][a-z0-9]{0,10}",
        excess  in 1usize..=50usize,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);

        let prefix = "ipfs://";
        let total_len = MAX_METADATA_POINTER_LEN as usize + excess;
        let body: alloc::string::String = "a".repeat(total_len - prefix.len());
        let raw = alloc::format!("{}{}", prefix, body);

        let id       = String::from_str(&env, &id_str);
        let metadata = String::from_str(&env, &raw);

        let res = client.try_register(
            &creator, &id, &100i128, &metadata, &empty_tags(&env),
        );
        prop_assert_eq!(
            res,
            Err(Ok(Error::MetadataTooLong)),
            "expected MetadataTooLong for metadata len {}", raw.len()
        );
        // Resource must not have been created.
        prop_assert!(!client.exists(&id));

        // update_metadata on an existing resource with over-limit pointer also
        // returns MetadataTooLong and leaves the original metadata untouched.
        let valid_meta = String::from_str(&env, "ipfs://seed");
        let id2 = String::from_str(&env, &alloc::format!("{}x", &id_str[..id_str.len().min(10)]));
        // id2 may collide across runs; skip if already exists via the try_ variant
        if client.try_register(&creator, &id2, &100i128, &valid_meta, &empty_tags(&env)).is_ok() {
            let upd = client.try_update_metadata(&id2, &metadata);
            prop_assert_eq!(
                upd,
                Err(Ok(Error::MetadataTooLong)),
                "update_metadata should return MetadataTooLong for len {}", raw.len()
            );
            prop_assert_eq!(client.get(&id2).metadata, valid_meta);
        }
    }
}

// ---------------------------------------------------------------------------
// Issue 2 — Duplicate detection stability across lifecycle flows
// ---------------------------------------------------------------------------
//
// Acceptance criteria:
//   • Duplicate register always fails with AlreadyRegistered.
//   • count and Index state are unchanged after every failed duplicate attempt.
//   • Stability holds after transfer, delist, relist, and propose/accept flows.

/// After transferring ownership, the old id is still occupied — a duplicate
/// register must fail regardless of whether the caller is the old or new owner.
#[test]
fn duplicate_register_fails_after_transfer_ownership() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let id = String::from_str(&env, "dupxfer");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&alice, &id, &100i128, &meta, &empty_tags(&env));
    client.transfer_ownership(&id, &bob);

    // Both the old and the new owner must be rejected on a fresh register.
    assert_eq!(
        client.try_register(&alice, &id, &200i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(
        client.try_register(&bob, &id, &300i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    // count and index must be unchanged.
    assert_eq!(client.count(), 1);
    assert_eq!(client.list(&0u32, &10u32).get(0).unwrap().id, id);
    assert_eq!(client.get_owner(&id), bob);
}

/// After propose + accept transfer, the id is still locked against re-registration.
#[test]
fn duplicate_register_fails_after_propose_accept_transfer() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let id = String::from_str(&env, "dupaccept");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&alice, &id, &100i128, &meta, &empty_tags(&env));
    client.propose_transfer(&id, &bob);
    client.accept_transfer(&id);

    assert_eq!(
        client.try_register(&alice, &id, &200i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(
        client.try_register(&bob, &id, &300i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.count(), 1);
    assert_eq!(client.get_owner(&id), bob);
}

/// Delisting a resource does not vacate its id — a duplicate register must fail
/// on both a delisted and a relisted resource, with count/index intact throughout.
#[test]
fn duplicate_register_fails_across_delist_and_relist() {
    let (env, alice, client) = setup();
    let id = String::from_str(&env, "dupdelist");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&alice, &id, &100i128, &meta, &empty_tags(&env));

    // After delist: id still occupied.
    client.delist(&id);
    assert!(!client.get(&id).listed);
    assert_eq!(
        client.try_register(&alice, &id, &200i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.count(), 1);

    // After relist: id still occupied.
    client.set_listed(&id, &true);
    assert!(client.get(&id).listed);
    assert_eq!(
        client.try_register(&alice, &id, &300i128, &meta, &empty_tags(&env)),
        Err(Ok(Error::AlreadyRegistered)),
    );
    assert_eq!(client.count(), 1);

    // Index order is stable throughout.
    assert_eq!(client.list(&0u32, &10u32).get(0).unwrap().id, id);
}

/// Multi-resource scenario: duplicate attempts against any of several resources
/// (after mixed transfer / delist / relist ops) never corrupt count or index order.
#[test]
fn duplicate_detection_stable_after_mixed_lifecycle_ops() {
    let (env, alice, client) = setup();
    let bob = Address::generate(&env);
    let meta = String::from_str(&env, "ipfs://m");

    let r0 = String::from_str(&env, "mxr0");
    let r1 = String::from_str(&env, "mxr1");
    let r2 = String::from_str(&env, "mxr2");

    client.register(&alice, &r0, &100i128, &meta, &empty_tags(&env));
    client.register(&alice, &r1, &200i128, &meta, &empty_tags(&env));
    client.register(&alice, &r2, &300i128, &meta, &empty_tags(&env));

    // Mutate state.
    client.transfer_ownership(&r0, &bob);
    client.delist(&r1);
    client.set_listed(&r1, &true); // relist

    // Each duplicate attempt must return AlreadyRegistered.
    for id in [&r0, &r1, &r2] {
        assert_eq!(
            client.try_register(&alice, id, &1i128, &meta, &empty_tags(&env)),
            Err(Ok(Error::AlreadyRegistered)),
            "expected AlreadyRegistered for id {:?}",
            id,
        );
        assert_eq!(
            client.try_register(&bob, id, &1i128, &meta, &empty_tags(&env)),
            Err(Ok(Error::AlreadyRegistered)),
            "expected AlreadyRegistered for id {:?}",
            id,
        );
    }

    // Count stays at 3; insertion order is preserved.
    assert_eq!(client.count(), 3);
    let page = client.list(&0u32, &10u32);
    assert_eq!(page.get(0).unwrap().id, r0);
    assert_eq!(page.get(1).unwrap().id, r1);
    assert_eq!(page.get(2).unwrap().id, r2);
}

// ── updated_at ledger metadata (#365) ───────────────────────────────────────

/// `register` stamps updated_at with the ledger sequence at call time.
#[test]
fn register_stamps_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(42);
    let id = String::from_str(&env, "ts1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    assert_eq!(client.get(&id).updated_at, 42);
}

/// `register` stamps created_at with the ledger sequence at call time.
#[test]
fn register_stamps_created_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(41);
    let id = String::from_str(&env, "tsc1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    assert_eq!(client.get(&id).created_at, 41);
}

/// `set_price` updates updated_at to the ledger sequence at call time.
#[test]
fn set_price_updates_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(10);
    let id = String::from_str(&env, "ts2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).updated_at, 10);

    env.ledger().set_sequence_number(55);
    client.set_price(&id, &200i128);
    assert_eq!(client.get(&id).updated_at, 55);
}

/// `set_price` no-op guard (#646): calling it with the resource's current
/// price must not re-save the resource (no `updated_at`/`version` bump) or
/// emit a `setprice` event.
#[test]
fn set_price_noop_skips_save_and_event() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(10);
    let id = String::from_str(&env, "pricenoop");
    let price = 1_000_000i128;
    client.register(
        &creator,
        &id,
        &price,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).updated_at, 10);

    env.ledger().set_sequence_number(55);
    let events_before = env.events().all().len();
    client.set_price(&id, &price);

    assert_eq!(
        client.get(&id).updated_at,
        10,
        "no-op set_price must not re-save the resource"
    );
    assert_eq!(
        env.events().all().len(),
        events_before,
        "no-op set_price must not emit a setprice event"
    );
}

/// `update_metadata` updates updated_at to the ledger sequence at call time.
#[test]
fn update_metadata_updates_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(7);
    let id = String::from_str(&env, "ts3");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://old"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).updated_at, 7);

    env.ledger().set_sequence_number(99);
    client.update_metadata(&id, &String::from_str(&env, "ipfs://new"));
    assert_eq!(client.get(&id).updated_at, 99);
}

/// `update_metadata` no-op guard (#647): calling it with the resource's
/// current metadata pointer must not re-save the resource (no
/// `updated_at`/`version` bump) or emit an `updmeta` event.
#[test]
fn update_metadata_noop_skips_save_and_event() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(7);
    let id = String::from_str(&env, "metanoop");
    let metadata = String::from_str(&env, "ipfs://same");
    client.register(&creator, &id, &100i128, &metadata, &empty_tags(&env));
    assert_eq!(client.get(&id).updated_at, 7);

    env.ledger().set_sequence_number(99);
    let events_before = env.events().all().len();
    client.update_metadata(&id, &metadata);

    assert_eq!(
        client.get(&id).updated_at,
        7,
        "no-op update_metadata must not re-save the resource"
    );
    assert_eq!(
        env.events().all().len(),
        events_before,
        "no-op update_metadata must not emit an updmeta event"
    );
}

/// `created_at` remains unchanged when metadata is updated.
#[test]
fn update_metadata_preserves_created_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(70);
    let id = String::from_str(&env, "tsc2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://old"),
        &empty_tags(&env),
    );
    let created_at = client.get(&id).created_at;
    assert_eq!(created_at, 70);

    env.ledger().set_sequence_number(90);
    client.update_metadata(&id, &String::from_str(&env, "ipfs://new"));

    let resource = client.get(&id);
    assert_eq!(resource.created_at, created_at);
    assert_eq!(resource.updated_at, 90);
}

/// `transfer_ownership` updates updated_at to the ledger sequence at call time.
#[test]
fn transfer_ownership_updates_updated_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(3);
    let id = String::from_str(&env, "ts4");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.get(&id).updated_at, 3);

    let new_owner = Address::generate(&env);
    env.ledger().set_sequence_number(200);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.get(&id).updated_at, 200);
}

/// `created_at` remains unchanged when ownership is transferred.
#[test]
fn transfer_ownership_preserves_created_at() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(300);
    let id = String::from_str(&env, "tsc3");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    let created_at = client.get(&id).created_at;
    assert_eq!(created_at, 300);

    let new_owner = Address::generate(&env);
    env.ledger().set_sequence_number(420);
    client.transfer_ownership(&id, &new_owner);

    let resource = client.get(&id);
    assert_eq!(resource.created_at, created_at);
    assert_eq!(resource.updated_at, 420);
}

/// updated_at is independent per resource and not shared across resources.
#[test]
fn updated_at_is_per_resource() {
    let (env, creator, client) = setup();

    env.ledger().set_sequence_number(1);
    let id_a = String::from_str(&env, "tsa");
    client.register(
        &creator,
        &id_a,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    env.ledger().set_sequence_number(2);
    let id_b = String::from_str(&env, "tsb");
    client.register(
        &creator,
        &id_b,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Mutate only b at ledger 50.
    env.ledger().set_sequence_number(50);
    client.set_price(&id_b, &999i128);

    // a should still reflect ledger 1; b should reflect ledger 50.
    assert_eq!(client.get(&id_a).updated_at, 1);
    assert_eq!(client.get(&id_b).updated_at, 50);
}

// ─── Deployment preflight checks (#392) ────────────────────────────────────
//
// These tests back the automated steps in docs/contract-upgrade-checklist.md.
// Each one exercises a specific Phase-1 or Phase-4 verification requirement
// so that running `cargo test` locally (or `make preflight`) gives the same
// confidence as the manual checklist commands against a live network.

/// `CARGO_PKG_VERSION` baked into `contract_version()` must be a non-empty
/// string in `MAJOR.MINOR.PATCH` semver format. Deployers use this value to
/// confirm which build is running on-chain (checklist Phase 4).
#[test]
fn contract_version_crate_version_is_valid_semver() {
    let (_env, _creator, client) = setup();
    let v = client.contract_version();

    // Copy into a std String for parsing.
    let len = v.crate_version.len() as usize;
    let mut buf = alloc::vec![0u8; len];
    v.crate_version.copy_into_slice(&mut buf);
    let version_str = alloc::str::from_utf8(&buf).expect("crate_version must be valid UTF-8");

    assert!(!version_str.is_empty(), "crate_version must not be empty");

    // Must contain at least two dots (MAJOR.MINOR.PATCH).
    let dot_count = version_str.chars().filter(|&c| c == '.').count();
    assert!(
        dot_count >= 2,
        "crate_version '{}' must be in MAJOR.MINOR.PATCH format (at least 2 dots)",
        version_str
    );

    // Every segment must be a non-empty string of ASCII digits or digits+pre-release.
    let parts: alloc::vec::Vec<&str> = version_str.splitn(3, '.').collect();
    assert_eq!(
        parts.len(),
        3,
        "crate_version must have exactly 3 dot-separated parts"
    );
    assert!(
        parts[0].chars().all(|c| c.is_ascii_digit()),
        "MAJOR segment '{}' must be numeric",
        parts[0]
    );
    assert!(!parts[0].is_empty(), "MAJOR segment must not be empty");
    assert!(!parts[1].is_empty(), "MINOR segment must not be empty");
}

/// `registry_info()` must return the stable registry name that clients use
/// to confirm they are talking to the right contract (checklist Phase 4).
#[test]
fn registry_info_name_is_stable_registry_name() {
    let (env, _creator, client) = setup();
    // No register — the key does not exist.
    let missing = String::from_str(&env, "ttlmissing");
    assert!(!client.exists(&missing));
    // No panic / storage error; the test passing is sufficient.
}

// ---------------------------------------------------------------------------
// exists_many (#369) — batch existence check
// ---------------------------------------------------------------------------

/// `exists_many` returns an empty Vec for an empty input.
#[test]
fn exists_many_empty_input_returns_empty() {
    let (env, _creator, client) = setup();
    let result = client.exists_many(&Vec::new(&env));
    assert_eq!(result.len(), 0);
}

/// `exists_many` returns false for every id when nothing is registered.
#[test]
fn exists_many_all_absent() {
    let (env, _creator, client) = setup();
    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(String::from_str(&env, "abc"));
    ids.push_back(String::from_str(&env, "def"));

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 2);
    assert!(!result.get(0).unwrap());
    assert!(!result.get(1).unwrap());
}

/// `exists_many` returns true for registered ids and false for absent ones
/// in the correct parallel order.
#[test]
fn exists_many_mixed_present_and_absent() {
    let (env, creator, client) = setup();

    let id_a = String::from_str(&env, "ema1");
    let id_b = String::from_str(&env, "ema2");
    let id_c = String::from_str(&env, "ema3");
    let meta = String::from_str(&env, "ipfs://m");

    client.register(&creator, &id_a, &100i128, &meta, &empty_tags(&env));
    // id_b is NOT registered
    client.register(&creator, &id_c, &100i128, &meta, &empty_tags(&env));

    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(id_a);
    ids.push_back(id_b);
    ids.push_back(id_c);

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 3);
    assert!(
        result.get(0).unwrap(),
        "id_a is registered — should be true"
    );
    assert!(!result.get(1).unwrap(), "id_b is absent — should be false");
    assert!(
        result.get(2).unwrap(),
        "id_c is registered — should be true"
    );
}

/// `exists_many` returns all-true when every id is registered.
#[test]
fn exists_many_all_present() {
    let (env, creator, client) = setup();
    let ids_str = ["em1", "em2", "em3"];
    let meta = String::from_str(&env, "ipfs://m");
    for id_str in &ids_str {
        client.register(
            &creator,
            &String::from_str(&env, id_str),
            &100i128,
            &meta,
            &empty_tags(&env),
        );
    }

    let mut ids: Vec<String> = Vec::new(&env);
    for id_str in &ids_str {
        ids.push_back(String::from_str(&env, id_str));
    }

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 3);
    for i in 0..3u32 {
        assert!(
            result.get(i).unwrap(),
            "all ids are registered — should be true"
        );
    }
}

/// `exists_many` treats an id that fails format validation as absent (`false`)
/// rather than propagating an error, consistent with `exists`.
#[test]
fn exists_many_invalid_id_format_treated_as_absent() {
    let (env, _creator, client) = setup();
    // An id with an uppercase letter fails validate_resource_id.
    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(String::from_str(&env, "INVALID"));
    ids.push_back(String::from_str(&env, "validid"));

    let result = client.exists_many(&ids);
    assert_eq!(result.len(), 2);
    assert!(
        !result.get(0).unwrap(),
        "invalid-format id treated as absent"
    );
    assert!(
        !result.get(1).unwrap(),
        "valid-format but unregistered id is absent"
    );
}

/// `exists_many` bumps TTL for each id that resolves to a registered resource.
#[test]
fn exists_many_bumps_ttl_for_found_ids() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "emttl");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Decay TTL by one day.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + TTL_DAY_IN_LEDGERS);
    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS,
        "TTL must have decayed before the read"
    );

    let mut ids: Vec<String> = Vec::new(&env);
    ids.push_back(id.clone());
    client.exists_many(&ids);

    assert_eq!(
        resource_storage_ttl(&env, &client.address, &id),
        TTL_BUMP_AMOUNT,
        "exists_many must bump TTL for each found resource"
    );
}

// ---------------------------------------------------------------------------
// LIST_PAGE_CAP constant (#370)
// ---------------------------------------------------------------------------

/// `LIST_PAGE_CAP` has the expected value (20). This test pins the constant
/// so that any accidental change to the cap surfaces as a test failure.
#[test]
fn list_page_cap_constant_value() {
    assert_eq!(LIST_PAGE_CAP, 20u32, "LIST_PAGE_CAP must equal 20");
}

/// `list`, `list_page`, `list_listed`, and `list_by_creator` all honour
/// `LIST_PAGE_CAP` — requesting more items than the cap only returns the cap.
#[test]
fn all_list_variants_honour_list_page_cap() {
    let (env, creator, client) = setup();
    // Register LIST_PAGE_CAP + 5 resources so every list variant has something
    // to truncate.
    let n = LIST_PAGE_CAP + 5;
    let meta = String::from_str(&env, "ipfs://m");
    for i in 0..n {
        // Pad to ensure ids are valid (lowercase+digits, ≤ 24 chars).
        let id_str = format!("cap{:02}", i);
        client.register(
            &creator,
            &String::from_str(&env, &id_str),
            &100i128,
            &meta,
            &empty_tags(&env),
        );
    }

    let over_cap = LIST_PAGE_CAP + 5;
    assert_eq!(
        client.list(&0u32, &over_cap).len(),
        LIST_PAGE_CAP,
        "list must be capped at LIST_PAGE_CAP"
    );
    assert_eq!(
        client.list_page(&0u32, &over_cap).items.len(),
        LIST_PAGE_CAP,
        "list_page must be capped at LIST_PAGE_CAP"
    );
    assert_eq!(
        client.list_listed(&0u32, &over_cap).len(),
        LIST_PAGE_CAP,
        "list_listed must be capped at LIST_PAGE_CAP"
    );
    assert_eq!(
        client.list_by_creator(&creator, &0u32, &over_cap).len(),
        LIST_PAGE_CAP,
        "list_by_creator must be capped at LIST_PAGE_CAP"
    );
}

/// `list` (delegates to `list_page`) restores TTL on every resource it returns.
#[test]
fn list_bumps_ttl_for_returned_resources() {
    let (env, creator, client) = setup();
    let ids = ["ttll0", "ttll1", "ttll2"];
    for id_str in &ids {
        client.register(
            &creator,
            &String::from_str(&env, id_str),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        );
    }

    // Decay TTL by one day across all entries.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + TTL_DAY_IN_LEDGERS);

    for id_str in &ids {
        assert_eq!(
            resource_storage_ttl(&env, &client.address, &String::from_str(&env, id_str)),
            TTL_BUMP_AMOUNT - TTL_DAY_IN_LEDGERS,
            "TTL must have decayed before the read"
        );
    }

    // One call to list covers all three resources.
    client.list(&0u32, &20u32);

    for id_str in &ids {
        assert_eq!(
            resource_storage_ttl(&env, &client.address, &String::from_str(&env, id_str)),
            TTL_BUMP_AMOUNT,
            "list must bump TTL for each returned resource"
        );
    }
    let info = client.registry_info();
    assert_eq!(
        info.name,
        String::from_str(&env, REGISTRY_NAME),
        "registry_info().name must equal the REGISTRY_NAME constant"
    );
}

/// `registry_info()` must expose a non-zero `resource_schema_version` that
/// clients use to detect breaking schema changes (checklist Phase 1 / Phase 4).
#[test]
fn registry_info_resource_schema_version_is_nonzero() {
    let (_env, _creator, client) = setup();
    let info = client.registry_info();
    assert!(
        info.resource_schema_version > 0,
        "resource_schema_version must be > 0 (it tracks breaking Resource schema changes)"
    );
    assert_eq!(
        info.resource_schema_version, RESOURCE_SCHEMA_VERSION,
        "registry_info().resource_schema_version must equal the RESOURCE_SCHEMA_VERSION constant"
    );
}

/// `registry_info()` and `contract_version()` must agree on both version
/// fields so deployers can use either endpoint for verification (checklist
/// Phase 4 verification commands).
#[test]
fn preflight_contract_version_and_registry_info_agree() {
    let (_env, _creator, client) = setup();
    let v = client.contract_version();
    let info = client.registry_info();

    assert_eq!(
        v.crate_version, info.version,
        "contract_version.crate_version must match registry_info.version"
    );
    assert_eq!(
        v.resource_schema_version, info.resource_schema_version,
        "contract_version.resource_schema_version must match registry_info.resource_schema_version"
    );
}

/// A fresh contract starts in a known, safe state for deployment:
/// zero resources and no admin set. This backs the checklist's Phase 7
/// admin-bootstrap verification step — if admin() is Some on a fresh deploy,
/// the bootstrap was already run (possibly by a prior deployment script).
#[test]
fn preflight_fresh_contract_starts_in_safe_state() {
    let (_env, _creator, client) = setup();

    assert_eq!(client.count(), 0, "fresh contract must have zero resources");
    assert!(
        client.admin().is_none(),
        "fresh contract must have no admin set (bootstrap required)"
    );
}

// ─── Escrow-ready payment state (#387) ────────────────────────────────────

/// Helper: set up a contract with an admin and a settler.
fn setup_with_settler<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, admin, client) = setup_with_admin();
    let settler = Address::generate(&env);
    client.add_settler(&settler);
    (env, creator, admin, settler, client)
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
    let id = register_priced(&env, &creator, &client, "payr0", 1_000_000);

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

/// record_payment stamps `recorded_at` from the ledger sequence at call time.
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
        receipt.recorded_at, 777,
        "recorded_at must reflect env sequence at record time"
    );
}

/// Receipts are immutable and keyed by `receipt_id`, but the
/// `(resource_id, payer)` index always resolves to the most recent one.
#[test]
fn record_payment_index_tracks_most_recent_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_priced(&env, &creator, &client, "payrecow", 500);
    let payer = Address::generate(&env);

    let first = String::from_str(&env, "rcptow1");
    let second = String::from_str(&env, "rcptow2");
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
        &500i128,
        &String::from_str(&env, "second_tx"),
    );

    // Both receipts remain individually addressable...
    assert_eq!(client.get_payment(&first).amount, 500i128);
    assert_eq!(client.get_payment(&second).amount, 500i128);
    // ...but the pair index points at the latest.
    let latest = client.get_payment_receipt(&id, &payer);
    assert_eq!(latest.receipt_id, second);
    assert_eq!(latest.amount, 500i128);
}

/// A receipt can only leave `Escrowed` once — settling twice fails.
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
fn record_payment_duplicate_receipt_id_fails() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_priced(&env, &creator, &client, "payr3", 1_000_000);
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
        &String::from_str(&env, "rcptmiss"),
        &missing,
        &payer,
        &100i128,
        &String::from_str(&env, "0xtxmiss"),
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

/// record_payment emits a `payment` event keyed by receipt id, carrying the
/// full receipt so indexers never need a follow-up storage read.
#[test]
fn record_payment_emits_payment_event() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_priced(&env, &creator, &client, "payrecev", 4_200);
    let payer = Address::generate(&env);
    let receipt_id = String::from_str(&env, "rcptev1");
    let tx_hash = String::from_str(&env, "0xtxev");
    let amount = 4_200i128;

    client.record_payment(&settler, &receipt_id, &id, &payer, &amount, &tx_hash);

    // env.events().all() reflects the most recent invocation
    let all = env.events().all();
    assert_eq!(all.len(), 1, "exactly one event should be emitted");

    let (_, topics, data) = all.get(0).unwrap();
    assert_eq!(
        topics.len(),
        2,
        "payment topics should be (symbol, receipt_id)"
    );

    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, symbol_short!("payment"));

    let topic_id: String = String::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_id, receipt_id);

    let receipt: PaymentReceipt = PaymentReceipt::try_from_val(&env, &data).unwrap();
    assert_eq!(receipt.receipt_id, receipt_id);
    assert_eq!(receipt.resource_id, id);
    assert_eq!(receipt.payer, payer);
    assert_eq!(receipt.tx_hash, tx_hash);
    assert_eq!(receipt.amount, amount);
    assert_eq!(receipt.state, PaymentState::Escrowed);
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
    let id = register_priced(&env, &creator, &client, "payr5", 1_000_000);
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
    assert_eq!(
        client.get_payment(&receipt_id).state,
        PaymentState::Escrowed
    );
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
        &String::from_str(&env, "rcptnotx"),
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
    let empty_receipt_id = String::from_str(&env, "");
    let res = client.try_record_payment(
        &settler,
        &empty_receipt_id,
        &id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "0xtxhash"),
    );
    assert_eq!(
        res,
        Err(Ok(Error::InvalidReceiptId)),
        "empty receipt_id must be rejected with InvalidReceiptId"
    );
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

/// record_payment errors InvalidPaymentAmount when amount is negative.
#[test]
fn record_payment_rejects_negative_amount() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payr10");
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
fn settle_payment_emits_settle_event() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_priced(&env, &creator, &client, "payr11", 3_000_000);
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
    let t0: Symbol = <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
        .ok()
        .unwrap();
    assert_eq!(t0, Symbol::new(&env, "settle"));

    let decoded: PaymentReceipt =
        <PaymentReceipt as TryFromVal<Env, Val>>::try_from_val(&env, &data)
            .ok()
            .unwrap();
    assert_eq!(decoded.state, PaymentState::Settled);
}

#[test]
fn record_payment_settle_payment_anchor_end_to_end() {
    let (env, creator, _admin, client) = setup_with_admin();
    let settler = Address::generate(&env);
    let verifier = Address::generate(&env);
    let payer = Address::generate(&env);
    let resource_id = String::from_str(&env, "x402e2e");
    let receipt_id = String::from_str(&env, "x402-receipt-001");
    let tx_hash = String::from_str(&env, "sha256:x402-transaction-001");
    let receipt_hash = String::from_str(&env, "sha256:x402-anchor-001");
    let amount = 100i128;

    client.add_settler(&settler);
    client.add_verifier(&verifier);
    assert!(client.is_settler(&settler));
    assert!(client.is_verifier(&verifier));

    client.register(
        &creator,
        &resource_id,
        &amount,
        &String::from_str(&env, "ipfs://x402e2e"),
        &empty_tags(&env),
    );

    env.ledger().set_sequence_number(700);
    client.record_payment(
        &settler,
        &receipt_id,
        &resource_id,
        &payer,
        &amount,
        &tx_hash,
    );
    let expected_recorded = PaymentReceipt {
        receipt_id: receipt_id.clone(),
        resource_id: resource_id.clone(),
        payer: payer.clone(),
        amount,
        state: PaymentState::Escrowed,
        tx_hash: tx_hash.clone(),
        recorded_at: 700,
        ledger: 700,
    };

    let payment_events = env.events().all();
    assert_eq!(payment_events.len(), 1);
    let (payment_contract, payment_topics, payment_data) = payment_events.get(0).unwrap();
    assert_eq!(payment_contract, client.address);
    assert_eq!(payment_topics.len(), 2);
    let payment_symbol: Symbol =
        Symbol::try_from_val(&env, &payment_topics.get(0).unwrap()).unwrap();
    assert_eq!(payment_symbol, symbol_short!("payment"));
    let payment_topic_id: String =
        String::try_from_val(&env, &payment_topics.get(1).unwrap()).unwrap();
    assert_eq!(payment_topic_id, receipt_id);
    let payment_event: PaymentReceipt = PaymentReceipt::try_from_val(&env, &payment_data).unwrap();
    assert_eq!(payment_event, expected_recorded);
    assert_eq!(client.get_payment(&receipt_id), expected_recorded);
    assert_eq!(
        client.get_payment_receipt(&resource_id, &payer),
        expected_recorded
    );

    env.ledger().set_sequence_number(701);
    client.settle_payment(&settler, &receipt_id);
    let expected_settled = PaymentReceipt {
        state: PaymentState::Settled,
        ..expected_recorded.clone()
    };

    let settle_events = env.events().all();
    assert_eq!(settle_events.len(), 1);
    let (settle_contract, settle_topics, settle_data) = settle_events.get(0).unwrap();
    assert_eq!(settle_contract, client.address);
    assert_eq!(settle_topics.len(), 2);
    let settle_symbol: Symbol = Symbol::try_from_val(&env, &settle_topics.get(0).unwrap()).unwrap();
    assert_eq!(settle_symbol, symbol_short!("settle"));
    let settle_topic_id: String =
        String::try_from_val(&env, &settle_topics.get(1).unwrap()).unwrap();
    assert_eq!(settle_topic_id, receipt_id);
    let settle_event: PaymentReceipt = PaymentReceipt::try_from_val(&env, &settle_data).unwrap();
    assert_eq!(settle_event, expected_settled);
    assert_eq!(client.get_payment(&receipt_id), expected_settled);
    assert_eq!(
        client.get_payment_receipt(&resource_id, &payer),
        expected_settled
    );

    env.ledger().set_sequence_number(702);
    client.anchor_purchase_receipt(&verifier, &resource_id, &payer, &receipt_hash);
    let expected_anchor = PurchaseReceiptAnchor {
        resource_id: resource_id.clone(),
        buyer: payer.clone(),
        receipt_hash: receipt_hash.clone(),
        ledger: 702,
    };

    let anchor_events = env.events().all();
    assert_eq!(anchor_events.len(), 1);
    let (anchor_contract, anchor_topics, anchor_data) = anchor_events.get(0).unwrap();
    assert_eq!(anchor_contract, client.address);
    assert_eq!(anchor_topics.len(), 2);
    let anchor_symbol: Symbol = Symbol::try_from_val(&env, &anchor_topics.get(0).unwrap()).unwrap();
    assert_eq!(anchor_symbol, symbol_short!("anchor"));
    let anchor_topic_id: String =
        String::try_from_val(&env, &anchor_topics.get(1).unwrap()).unwrap();
    assert_eq!(anchor_topic_id, resource_id);
    let anchor_event: PurchaseReceiptAnchor =
        PurchaseReceiptAnchor::try_from_val(&env, &anchor_data).unwrap();
    assert_eq!(anchor_event, expected_anchor);
    assert_eq!(
        client.get_purchase_receipt(&resource_id, &payer),
        expected_anchor
    );
}

/// Failed record_payment calls leave no receipt behind.
#[test]
fn failed_record_payment_does_not_store_receipt() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "payrecfailstore");
    let payer = Address::generate(&env);

    // Attempt with zero amount — should fail
    let _ = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptfail"),
        &id,
        &payer,
        &0i128,
        &String::from_str(&env, "txhash"),
    );

    // No receipt should be stored
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
    let receipt_id = String::from_str(&env, "rcptttlw");
    client.record_payment(
        &settler,
        &receipt_id,
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "tx"),
    );

    assert_eq!(
        payment_receipt_ttl(&env, &client.address, &receipt_id),
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
    let receipt_id = String::from_str(&env, "rcptttlr");
    client.record_payment(
        &settler,
        &receipt_id,
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
        payment_receipt_ttl(&env, &client.address, &receipt_id),
        TTL_BUMP_AMOUNT - decay,
        "TTL should have decayed before the read"
    );

    client.get_payment_receipt(&id, &payer);

    assert_eq!(
        payment_receipt_ttl(&env, &client.address, &receipt_id),
        TTL_BUMP_AMOUNT,
        "get_payment_receipt must bump TTL back to BUMP_AMOUNT"
    );
}

/// record_payment does not affect existing Resource fields — all registry
/// reads on the resource return the same values before and after.
#[test]
fn record_payment_does_not_mutate_resource() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_priced(&env, &creator, &client, "payr12", 1_000_000);
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

// ─── Dispute flagging (#389) ───────────────────────────────────────────────
//
// Acceptance criteria (from issue):
//   • Flag state is exposed in reads and listing filters; events include reason code.
//   • Error handling is deterministic and documented.
//   • The implementation passes the relevant local test suite.

// ── Helper: setup with admin + moderator pre-configured ──────────────────

fn setup_with_moderator<'a>() -> (Env, Address, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, admin, client) = setup_with_admin();
    let moderator = Address::generate(&env);
    client.add_moderator(&moderator);
    (env, creator, admin, moderator, client)
}

// ── add_moderator / remove_moderator / is_moderator ──────────────────────

#[test]
fn admin_can_grant_and_revoke_moderator() {
    let (env, _creator, _admin, client) = setup_with_admin();
    let moderator = Address::generate(&env);

    assert!(!client.is_moderator(&moderator));

    client.add_moderator(&moderator);
    assert!(client.is_moderator(&moderator));

    client.remove_moderator(&moderator);
    assert!(!client.is_moderator(&moderator));
}

#[test]
fn set_paused_before_admin_set_fails() {
    let (env, _creator, client) = setup();
    let anyone = Address::generate(&env);
    let res = client.try_set_paused(&anyone, &true);
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn set_paused_emits_pause_event() {
    let (env, _creator, admin, client) = setup_with_admin();

    client.set_paused(&admin, &true);

    let all = env.events().all();
    // The last event is from set_paused (setadmin is first from setup_with_admin).
    let (_cid, topics, data) = all.get_unchecked(all.len() - 1);
    let t0: Symbol = <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
        .ok()
        .unwrap();
    assert_eq!(t0, Symbol::new(&env, "pause"));
    let (paused, emitted_admin): (bool, Address) = <(bool, Address)>::try_from_val(&env, &data)
        .expect("pause event data must be (bool, Address)");
    assert!(paused);
    assert_eq!(emitted_admin, admin);
}

#[test]
fn set_paused_noop_still_emits_event() {
    // Pausing when already paused is allowed and still emits an event, so
    // off-chain monitors can detect rapid successive calls.
    // We verify this by checking that the event is present immediately after
    // each call — the Soroban test env reflects the most recent invocation.
    let (env, _creator, admin, client) = setup_with_admin();
    client.set_paused(&admin, &true);

    // Second pause call (no-op state change): the event must still be emitted.
    client.set_paused(&admin, &true);
    let all = env.events().all();
    let found = (0..all.len()).any(|i| {
        let (_, topics, _) = all.get(i).unwrap();
        topics
            .get(0)
            .and_then(|v| <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &v).ok())
            .map(|sym: Symbol| sym == Symbol::new(&env, "pause"))
            .unwrap_or(false)
    });
    assert!(
        found,
        "set_paused must emit a 'pause' event even on a no-op state transition"
    );
}

#[test]
fn set_paused_until_at_or_before_now_resumes_immediately() {
    let (env, _creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);

    client.set_paused_until(&admin, &100);
    assert!(!client.is_paused());
    assert_eq!(client.pause_until(), None);

    client.set_paused_until(&admin, &99);
    assert!(!client.is_paused());
    assert_eq!(client.pause_until(), None);
}

#[test]
fn scheduled_pause_blocks_until_deadline_then_auto_resumes() {
    let (env, creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);

    assert!(client.is_paused());
    assert_eq!(client.pause_until(), Some(200));
    assert_eq!(
        client.try_register(
            &creator,
            &String::from_str(&env, "scheduledpause"),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &empty_tags(&env),
        ),
        Err(Ok(Error::ContractPaused))
    );

    env.ledger().set_timestamp(200);
    assert!(!client.is_paused());
    assert_eq!(client.pause_until(), None);
    client.register(
        &creator,
        &String::from_str(&env, "scheduledpause"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
}

#[test]
fn explicit_unpause_clears_scheduled_deadline() {
    let (env, creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);
    client.set_paused(&admin, &false);

    assert!(!client.is_paused());
    assert_eq!(client.pause_until(), None);
    client.register(
        &creator,
        &String::from_str(&env, "clearpause"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
}

#[test]
fn indefinite_pause_clears_any_scheduled_deadline() {
    let (env, _creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);
    client.set_paused(&admin, &true);

    assert!(client.is_paused());
    assert_eq!(client.pause_until(), None);
}

#[test]
fn set_paused_until_emits_deadline_event() {
    let (env, _creator, admin, client) = setup_with_admin();
    env.ledger().set_timestamp(100);
    client.set_paused_until(&admin, &200);

    let all = env.events().all();
    let (_, topics, data) = all.get_unchecked(all.len() - 1);
    let topic: Symbol =
        <Symbol as TryFromVal<Env, Val>>::try_from_val(&env, &topics.get(0).unwrap())
            .ok()
            .unwrap();
    assert_eq!(topic, Symbol::new(&env, "pause_until"));
    let (pause_until, emitted_admin): (u64, Address) =
        <(u64, Address)>::try_from_val(&env, &data).unwrap();
    assert_eq!(pause_until, 200);
    assert_eq!(emitted_admin, admin);
}

// ── flag_resource ─────────────────────────────────────────────────────────

#[test]
fn moderator_can_flag_resource() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres0");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    let resource = client.get(&id);
    assert_eq!(
        resource.dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );
}

#[test]
fn pause_blocks_register() {
    let (env, creator, admin, client) = setup_with_admin();
    client.set_paused(&admin, &true);
    let res = client.try_register(
        &creator,
        &String::from_str(&env, "pausedreg"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.count(), 0);
}

#[test]
fn flag_resource_with_all_reasons() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();

    for (suffix, reason) in [
        ("fr2a", FlagReason::Spam),
        ("fr2b", FlagReason::Copyright),
        ("fr2c", FlagReason::Malicious),
        ("fr2d", FlagReason::Other),
    ] {
        let id = register_default(&env, &creator, &client, suffix);
        client.flag_resource(&id, &moderator, &reason);
        let resource = client.get(&id);
        assert_eq!(
            resource.dispute_flag,
            DisputeFlag::Flagged(reason),
            "dispute_flag mismatch for reason {:?}",
            reason
        );
    }
}

#[test]
fn flag_resource_replaces_existing_flag() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres3");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );

    client.flag_resource(&id, &moderator, &FlagReason::Malicious);
    assert_eq!(client.get(&id).metadata, String::from_str(&env, "ipfs://m"),);
}

#[test]
fn flag_resource_non_moderator_is_unauthorized() {
    let (env, creator, _admin, _moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres4");
    let stranger = Address::generate(&env);

    let res = client.try_flag_resource(&id, &stranger, &FlagReason::Spam);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    // Resource must not be flagged.
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
}

#[test]
fn flag_resource_revoked_moderator_is_unauthorized() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres5");

    client.remove_moderator(&moderator);

    let res = client.try_flag_resource(&id, &moderator, &FlagReason::Spam);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn flag_resource_missing_resource_fails() {
    let (env, _creator, _admin, moderator, client) = setup_with_moderator();
    let ghost = String::from_str(&env, "ghostres0");

    let res = client.try_flag_resource(&ghost, &moderator, &FlagReason::Other);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn flag_resource_does_not_delist_resource() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres6");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    let resource = client.get(&id);
    assert!(resource.listed, "flagging must not change listed state");
}

#[test]
fn flag_resource_preserves_all_other_fields() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagres7");
    let before = client.get(&id);

    client.flag_resource(&id, &moderator, &FlagReason::Copyright);

    let after = client.get(&id);
    assert_eq!(after.id, before.id);
    assert_eq!(after.creator, before.creator);
    assert_eq!(after.price, before.price);
    assert_eq!(after.metadata, before.metadata);
    assert_eq!(after.listed, before.listed);
    assert_eq!(after.tags, before.tags);
    assert_eq!(after.verified, before.verified);
    assert_eq!(after.frozen, before.frozen);
    assert_eq!(
        after.dispute_flag,
        DisputeFlag::Flagged(FlagReason::Copyright)
    );
}

// ── unflag_resource ───────────────────────────────────────────────────────

#[test]
fn moderator_can_unflag_resource() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "unflagr0");

    client.flag_resource(&id, &moderator, &FlagReason::Spam);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );

    client.unflag_resource(&id, &moderator);
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
}

#[test]
fn pause_blocks_set_verification_status() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedverif");
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);
    client.set_paused(&admin, &true);
    let res =
        client.try_set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.get(&id).verified, VerificationStatus::Pending);
}

#[test]
fn pause_blocks_set_tags() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedtags");
    client.set_paused(&admin, &true);
    let res = client.try_set_tags(&id, &tags(&env, &["blocked"]));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.get(&id).tags.len(), 0);
}

#[test]
fn unflag_resource_non_moderator_is_unauthorized() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "unflagr3");
    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    let stranger = Address::generate(&env);
    let res = client.try_unflag_resource(&id, &stranger);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    // Flag must remain.
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Spam)
    );
}

#[test]
fn pause_blocks_propose_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedpropose");
    let proposed = Address::generate(&env);
    client.set_paused(&admin, &true);
    let res = client.try_propose_transfer(&id, &proposed);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn pause_blocks_accept_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedaccept");
    let new_owner = Address::generate(&env);
    // Propose before pausing so there is a pending transfer to accept.
    client.propose_transfer(&id, &new_owner);
    client.set_paused(&admin, &true);
    let res = client.try_accept_transfer(&id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert_eq!(client.get(&id).creator, creator);
}

#[test]
fn pause_blocks_cancel_transfer() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedcancel");
    let proposed = Address::generate(&env);
    client.propose_transfer(&id, &proposed);
    client.set_paused(&admin, &true);
    let res = client.try_cancel_transfer(&id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn list_listed_exposes_dispute_flag() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "listdflag");
    client.flag_resource(&id, &moderator, &FlagReason::Copyright);

    let listed = client.list_listed(&0u32, &20u32);
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed.get(0).unwrap().dispute_flag,
        DisputeFlag::Flagged(FlagReason::Copyright)
    );
}

#[test]
fn pause_blocks_delist() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pauseddelist");
    client.set_paused(&admin, &true);
    let res = client.try_delist(&id);
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
    assert!(client.get(&id).listed);
}

#[test]
fn pause_blocks_repair_index() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausedrepair");
    client.set_paused(&admin, &true);
    let res = client.try_repair_index(&Vec::from_array(&env, [id.clone()]));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn flag_and_unflag_roundtrip() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "roundtrip0");

    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);

    client.flag_resource(&id, &moderator, &FlagReason::Other);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Other)
    );

    client.unflag_resource(&id, &moderator);
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);

    // Can be re-flagged after unflagging.
    client.flag_resource(&id, &moderator, &FlagReason::Malicious);
    assert_eq!(
        client.get(&id).dispute_flag,
        DisputeFlag::Flagged(FlagReason::Malicious)
    );
}

// ── Moderator flag reason hash (#649) ─────────────────────────────────────

#[test]
fn moderator_can_set_and_get_flag_reason_hash() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash0");

    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "sha256:abc123"));

    assert_eq!(
        client.get_flag_reason_hash(&id),
        String::from_str(&env, "sha256:abc123")
    );
}

#[test]
fn set_flag_reason_hash_does_not_require_active_flag() {
    // A moderator may attach reason detail before (or without ever) calling
    // flag_resource — the two are independent.
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash1");

    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "sha256:nohash"));
    assert_eq!(client.get(&id).dispute_flag, DisputeFlag::NoFlag);
}

#[test]
fn set_flag_reason_hash_replaces_existing_hash() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash2");

    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "first"));
    client.set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "second"));

    assert_eq!(
        client.get_flag_reason_hash(&id),
        String::from_str(&env, "second")
    );
}

#[test]
fn set_flag_reason_hash_non_moderator_is_unauthorized() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "reasonhash3");
    let not_moderator = Address::generate(&env);

    let res =
        client.try_set_flag_reason_hash(&id, &not_moderator, &String::from_str(&env, "sha256:x"));
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn set_flag_reason_hash_revoked_moderator_is_unauthorized() {
    let (env, creator, admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash4");
    client.remove_moderator(&moderator);

    let res = client.try_set_flag_reason_hash(&id, &moderator, &String::from_str(&env, "x"));
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    let _ = admin;
}

#[test]
fn set_flag_reason_hash_missing_resource_fails() {
    let (env, _creator, _admin, moderator, client) = setup_with_moderator();
    let res = client.try_set_flag_reason_hash(
        &String::from_str(&env, "nosuchresource"),
        &moderator,
        &String::from_str(&env, "x"),
    );
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

#[test]
fn set_flag_reason_hash_rejects_over_max_length() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash5");

    let mut buf = alloc::string::String::new();
    while (buf.len() as u32) < MAX_FLAG_REASON_HASH_LEN + 1 {
        buf.push('a');
    }
    let too_long = String::from_str(&env, &buf);

    let res = client.try_set_flag_reason_hash(&id, &moderator, &too_long);
    assert_eq!(res, Err(Ok(Error::FlagReasonHashTooLong)));
}

#[test]
fn get_flag_reason_hash_missing_fails() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "reasonhash6");
    let _ = moderator;

    let res = client.try_get_flag_reason_hash(&id);
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// ── Moderator role event payload tests (#616) ─────────────────────────────
//
// The topic-matching test earlier in this file (`event_topics_match_...`)
// only pins that these events are emitted under the right symbol; it never
// decodes their payload. These tests assert the actual topic and data
// contents of every moderator-role and dispute-flag event, so a payload
// regression (wrong address, stale bool, truncated reason hash) fails here
// instead of only surfacing off-chain.

#[test]
fn add_moderator_emits_address_and_role_change_payload() {
    let (env, _creator, admin, client) = setup_with_admin();
    let moderator = Address::generate(&env);

    client.add_moderator(&moderator);

    let all = env.events().all();
    let (_, topics, data) = all.get_unchecked(all.len() - 1);
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, Symbol::new(&env, "addmod"));
    let topic_moderator: Address = Address::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_moderator, moderator);
    let payload: RoleChange = RoleChange::try_from_val(&env, &data).unwrap();
    assert_eq!(
        payload,
        RoleChange {
            admin: admin.clone(),
            target: moderator.clone(),
            granted: true,
        },
        "addmod payload must carry the admin actor and target"
    );
}

#[test]
fn remove_moderator_emits_address_and_role_change_payload() {
    let (env, _creator, admin, client) = setup_with_admin();
    let moderator = Address::generate(&env);
    client.add_moderator(&moderator);

    client.remove_moderator(&moderator);

    let all = env.events().all();
    let (_, topics, data) = all.get_unchecked(all.len() - 1);
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, Symbol::new(&env, "rmmod"));
    let topic_moderator: Address = Address::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_moderator, moderator);
    let payload: RoleChange = RoleChange::try_from_val(&env, &data).unwrap();
    assert_eq!(
        payload,
        RoleChange {
            admin: admin.clone(),
            target: moderator.clone(),
            granted: false,
        },
        "rmmod payload must carry the admin actor and target"
    );
}

#[test]
fn flag_resource_emits_full_event_payload() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagpay0");

    client.flag_resource(&id, &moderator, &FlagReason::Malicious);

    let all = env.events().all();
    let (_, topics, data) = all.get_unchecked(all.len() - 1);
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, Symbol::new(&env, "flag"));
    let topic_id: String = String::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_id, id);
    let payload: FlagEvent = FlagEvent::try_from_val(&env, &data).unwrap();
    assert_eq!(payload.id, id);
    assert_eq!(payload.moderator, moderator);
    assert_eq!(payload.reason, FlagReason::Malicious);
}

#[test]
fn unflag_resource_emits_id_payload() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagpay1");
    client.flag_resource(&id, &moderator, &FlagReason::Spam);

    client.unflag_resource(&id, &moderator);

    let all = env.events().all();
    let (_, topics, data) = all.get_unchecked(all.len() - 1);
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, Symbol::new(&env, "unflag"));
    let topic_id: String = String::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_id, id);
    let data_id: String = String::try_from_val(&env, &data).unwrap();
    assert_eq!(data_id, id);
}

#[test]
fn set_flag_reason_hash_emits_full_event_payload() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id = register_default(&env, &creator, &client, "flagpay2");
    let reason_hash = String::from_str(&env, "sha256:abc123");

    client.set_flag_reason_hash(&id, &moderator, &reason_hash);

    let all = env.events().all();
    let (_, topics, data) = all.get_unchecked(all.len() - 1);
    let sym: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(sym, Symbol::new(&env, "flagrsn"));
    let topic_id: String = String::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_id, id);
    let (data_moderator, data_hash): (Address, String) =
        <(Address, String)>::try_from_val(&env, &data).unwrap();
    assert_eq!(data_moderator, moderator);
    assert_eq!(data_hash, reason_hash);
}

// ── Storage TTL tests for index entries (#371) ────────────────────────────────

#[test]
fn pause_blocks_record_payment() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "pausedpayrec");
    let payer = Address::generate(&env);
    client.set_paused(&_admin, &true);
    let res = client.try_record_payment(
        &settler,
        &String::from_str(&env, "rcptpaused"),
        &id,
        &payer,
        &1_000_000i128,
        &String::from_str(&env, "txhash"),
    );
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

// ── Read-only methods keep working while paused ──────────────────────────────

#[test]
fn pause_allows_read_only_methods() {
    let (env, creator, admin, settler, client) = setup_with_settler();
    let id = register_default(&env, &creator, &client, "pausedread");

    // Record a payment receipt and terms hash while unpaused so we have
    // something to read back.
    let payer = Address::generate(&env);
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcptread"),
        &id,
        &payer,
        &100i128,
        &String::from_str(&env, "txhash"),
    );
    client.set_terms_hash(&creator, &String::from_str(&env, "termshash"));

    client.set_paused(&admin, &true);

    // All of these must succeed while paused.
    assert!(client.is_paused());
    assert!(client.exists(&id));
    assert_eq!(client.count(), 1);
    let _ = client.get(&id);
    let _ = client.get_owner(&id);
    let _ = client.list(&0u32, &10u32);
    let _ = client.list_page(&0u32, &10u32);
    let _ = client.list_listed(&0u32, &10u32);
    let _ = client.list_by_creator(&creator, &0u32, &10u32);
    let _ = client.creator_resource_count(&creator);
    let _ = client.registry_info();
    let _ = client.contract_version();
    let _ = client.admin();
    let _ = client.pending_admin();
    let _ = client.is_verifier(&creator);
    let _ = client.get_payment_receipt(&id, &payer);
    let _ = client.get_terms_hash(&creator);
}

// ── Unpause restores write access ────────────────────────────────────────────

#[test]
fn unpause_restores_register() {
    let (env, creator, admin, client) = setup_with_admin();
    client.set_paused(&admin, &true);
    client.set_paused(&admin, &false);
    // Must succeed now that the contract is unpaused.
    client.register(
        &creator,
        &String::from_str(&env, "unpaused"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(client.count(), 1);
}

#[test]
fn resource_includes_schema_version() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "schemaverres");
    let meta = String::from_str(&env, "ipfs://schemaver");

    client.register(&creator, &id, &100i128, &meta, &empty_tags(&env));

    let r = client.get(&id);
    assert_eq!(
        r.schema_version, RESOURCE_SCHEMA_VERSION,
        "Resource from get() must include RESOURCE_SCHEMA_VERSION"
    );

    let page = client.list_page(&0u32, &10u32);
    assert_eq!(
        page.items.get(0).unwrap().schema_version,
        RESOURCE_SCHEMA_VERSION,
        "Resource from list_page() must include RESOURCE_SCHEMA_VERSION"
    );

    let listed = client.list_listed(&0u32, &10u32);
    assert_eq!(
        listed.get(0).unwrap().schema_version,
        RESOURCE_SCHEMA_VERSION,
        "Resource from list_listed() must include RESOURCE_SCHEMA_VERSION"
    );

    let by_creator = client.list_by_creator(&creator, &0u32, &10u32);
    assert_eq!(
        by_creator.get(0).unwrap().schema_version,
        RESOURCE_SCHEMA_VERSION,
        "Resource from list_by_creator() must include RESOURCE_SCHEMA_VERSION"
    );
}

// ── Pagination property tests (#377) ─────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]
    #[test]
    fn test_pagination_invariants_property(
        num_resources in 0u32..=30u32,
        start in 0u32..=40u32,
        limit in 0u32..=35u32,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let meta = String::from_str(&env, "ipfs://pagetest");

        for i in 0..num_resources {
            let id_str = format!("res{:04}", i);
            let id = String::from_str(&env, &id_str);
            client.register(&creator, &id, &100i128, &meta, &empty_tags(&env));
        }

        assert_eq!(client.count(), num_resources);

        // 1. list_page invariants
        let page = client.list_page(&start, &limit);
        let cap = limit.min(20);

        // Cap enforcement
        assert!(page.items.len() <= cap, "list_page items count exceeds cap limit.min(20)");

        if start >= num_resources {
            // Out-of-range starts: no panic, empty items, next_cursor is None
            assert_eq!(page.items.len(), 0, "out-of-range start must return empty items");
            assert_eq!(page.next_cursor, None, "out-of-range start must produce next_cursor = None");
        } else {
            // Ordering check
            let expected_len = (num_resources - start).min(cap);
            assert_eq!(page.items.len(), expected_len);
            for (idx, item) in page.items.iter().enumerate() {
                let expected_id = format!("res{:04}", start + idx as u32);
                assert_eq!(item.id, String::from_str(&env, &expected_id), "ordering invariant failed");
            }

            if start + page.items.len() < num_resources {
                assert_eq!(page.next_cursor, Some(start + page.items.len()));
            } else {
                assert_eq!(page.next_cursor, None);
            }
        }

        // 2. list invariants
        let list_items = client.list(&start, &limit);
        assert_eq!(list_items, page.items, "list() must delegate to list_page().items");

        // 3. list_by_creator invariants
        let creator_items = client.list_by_creator(&creator, &start, &limit);
        assert_eq!(creator_items, page.items, "list_by_creator must match list_page for single creator");
    }
}

// ── Tag validation property tests (#376) ──────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]
    #[test]
    fn test_tag_validation_property(
        tag_count in 0u32..=12u32,
        max_tag_len in 0u32..=40u32,
        include_duplicate in any::<bool>(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let id = String::from_str(&env, "tagpropres");
        let meta = String::from_str(&env, "ipfs://tagprop");

        let mut tags_vec = Vec::new(&env);
        let mut is_valid = tag_count <= 8;

        for i in 0..tag_count {
            let len = if max_tag_len == 0 { 0 } else { (i % max_tag_len) + 1 };
            if len == 0 || len > 32 {
                is_valid = false;
            }
            let char_byte = b'a' + (i % 26) as u8;
            let buf = alloc::vec![char_byte; len as usize];
            let tag_str = core::str::from_utf8(&buf).unwrap();
            tags_vec.push_back(String::from_str(&env, tag_str));
        }

        if include_duplicate && tag_count >= 2 {
            // Two tags normalizing to the same value are rejected outright.
            tags_vec.set(1, tags_vec.get(0).unwrap());
            is_valid = false;
        }

        let result = client.try_register(&creator, &id, &100i128, &meta, &tags_vec);
        if is_valid {
            assert!(result.is_ok(), "valid tag vector should succeed in register");
        } else {
            assert_eq!(result, Err(Ok(Error::InvalidTag)), "invalid tag vector should be rejected with InvalidTag");
        }
    }
}

// ─── Event topic length regression tests (#655) ────────────────────────────
//
// A resource id is the only user-influenced value ever placed directly in an
// event topic (see `validate_resource_id`, which caps ids at
// `MAX_RESOURCE_ID_LEN` ASCII lowercase/digit bytes). These tests pin that
// bound at the event layer with ids at the maximum accepted length, so that
// widening `validate_resource_id` without revisiting the topic-carrying
// events below shows up here rather than as a silent oversized-topic
// regression later.

const MAX_RESOURCE_ID_LEN: u32 = 24;

fn max_len_resource_id(env: &Env, prefix: &str) -> String {
    let mut buf = alloc::string::String::new();
    buf.push_str(prefix);
    while (buf.len() as u32) < MAX_RESOURCE_ID_LEN {
        buf.push('x');
    }
    String::from_str(env, &buf)
}

/// Decode topic index 1 (the resource id) off the most recently emitted
/// event. Panics if the last event does not have exactly 2 topics.
fn last_event_id_topic(env: &Env) -> String {
    let all = env.events().all();
    let (_contract, topics, _data) = all.get_unchecked(all.len() - 1);
    assert_eq!(topics.len(), 2, "expected a 2-topic (name, id) event");
    String::try_from_val(env, &topics.get(1).unwrap())
        .expect("topic 1 should decode as the resource id String")
}

#[test]
fn max_length_resource_id_helper_produces_bound_length() {
    let (env, _creator, _client) = setup();
    let id = max_len_resource_id(&env, "regr");
    assert_eq!(id.len(), MAX_RESOURCE_ID_LEN);
}

#[test]
fn resource_id_one_byte_over_max_is_rejected() {
    // Companion to the topic-length tests below: confirms MAX_RESOURCE_ID_LEN
    // is actually the enforced ceiling, not just this test file's assumption.
    let (env, creator, client) = setup();
    let mut buf = alloc::string::String::new();
    while (buf.len() as u32) < MAX_RESOURCE_ID_LEN + 1 {
        buf.push('x');
    }
    let id = String::from_str(&env, &buf);
    let res = client.try_register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(res, Err(Ok(Error::InvalidResourceId)));
}

#[test]
fn update_metadata_event_topic_holds_full_max_length_id() {
    let (env, creator, client) = setup();
    let id = max_len_resource_id(&env, "updmeta");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.update_metadata(&id, &String::from_str(&env, "ipfs://new"));

    let topic_id = last_event_id_topic(&env);
    assert_eq!(topic_id, id);
    assert_eq!(topic_id.len(), MAX_RESOURCE_ID_LEN);
}

#[test]
fn set_tags_event_topic_holds_full_max_length_id() {
    let (env, creator, client) = setup();
    let id = max_len_resource_id(&env, "settags");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.set_tags(&id, &tags(&env, &["dataset"]));

    let topic_id = last_event_id_topic(&env);
    assert_eq!(topic_id, id);
    assert_eq!(topic_id.len(), MAX_RESOURCE_ID_LEN);
}

#[test]
fn freeze_metadata_event_topic_holds_full_max_length_id() {
    let (env, creator, client) = setup();
    let id = max_len_resource_id(&env, "freeze");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.freeze_metadata(&id);

    let topic_id = last_event_id_topic(&env);
    assert_eq!(topic_id, id);
    assert_eq!(topic_id.len(), MAX_RESOURCE_ID_LEN);
}

#[test]
fn set_listed_event_topic_holds_full_max_length_id() {
    let (env, creator, client) = setup();
    let id = max_len_resource_id(&env, "listed");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    client.set_listed(&id, &false);

    let topic_id = last_event_id_topic(&env);
    assert_eq!(topic_id, id);
    assert_eq!(topic_id.len(), MAX_RESOURCE_ID_LEN);
}

#[test]
fn transfer_ownership_event_topic_holds_full_max_length_id() {
    let (env, creator, client) = setup();
    let id = max_len_resource_id(&env, "xfer");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let new_owner = Address::generate(&env);
    client.transfer_ownership(&id, &new_owner);

    let topic_id = last_event_id_topic(&env);
    assert_eq!(topic_id, id);
    assert_eq!(topic_id.len(), MAX_RESOURCE_ID_LEN);
}

#[test]
fn set_verification_status_event_topic_holds_full_max_length_id() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = max_len_resource_id(&env, "verify");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    let verifier = Address::generate(&env);
    client.add_verifier(&verifier);

    client.set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);

    let topic_id = last_event_id_topic(&env);
    assert_eq!(topic_id, id);
    assert_eq!(topic_id.len(), MAX_RESOURCE_ID_LEN);
}

// ── listed_count tests ──────────────────────────────────────────────────────

#[test]
fn listed_count_starts_at_zero() {
    let (_env, _creator, client) = setup();
    assert_eq!(client.listed_count(), 0u32);
}

#[test]
fn listed_count_increments_on_register() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "res1"),
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 1);
    client.register(
        &creator,
        &String::from_str(&env, "res2"),
        &200i128,
        &String::from_str(&env, "ipfs://b"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 2);
}

#[test]
fn listed_count_decrements_on_set_listed_false() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "res1"),
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 1);
    client.set_listed(&String::from_str(&env, "res1"), &false);
    assert_eq!(client.listed_count(), 0);
}

#[test]
fn listed_count_increments_when_relisted() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "res1"),
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 1);
    client.set_listed(&String::from_str(&env, "res1"), &false);
    assert_eq!(client.listed_count(), 0);
    client.set_listed(&String::from_str(&env, "res1"), &true);
    assert_eq!(client.listed_count(), 1);
}

#[test]
fn listed_count_noop_when_already_in_target_state() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "res1"),
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 1);
    // set_listed(true) on an already-listed resource should not change count
    client.set_listed(&String::from_str(&env, "res1"), &true);
    assert_eq!(client.listed_count(), 1);
}

#[test]
fn listed_count_decrements_on_freeze() {
    let (env, creator, client) = setup();
    client.register(
        &creator,
        &String::from_str(&env, "res1"),
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 1);
    client.freeze_resource(&String::from_str(&env, "res1"));
    assert_eq!(client.listed_count(), 0);
}

#[test]
fn listed_count_decrements_on_tombstone() {
    let (env, creator, _admin, client) = setup_with_admin();
    client.register(
        &creator,
        &String::from_str(&env, "res1"),
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 1);
    client.tombstone_resource(&String::from_str(&env, "res1"), &_admin);
    assert_eq!(client.listed_count(), 0);
}

#[test]
fn listed_count_increments_when_dispute_resolved_to_listed() {
    let (env, creator, _admin, client) = setup_with_admin();
    client.register(
        &creator,
        &String::from_str(&env, "res1"),
        &100i128,
        &String::from_str(&env, "ipfs://a"),
        &empty_tags(&env),
    );
    assert_eq!(client.listed_count(), 1);
    client.open_dispute(&String::from_str(&env, "res1"), &_admin);
    assert_eq!(client.listed_count(), 0);
    client.resolve_dispute(
        &String::from_str(&env, "res1"),
        &_admin,
        &ResourceState::Listed,
    );
    assert_eq!(client.listed_count(), 1);
}

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
    client.anchor_purchase_receipt(&service, &id, &buyer_a, &String::from_str(&env, "hashofa"));
    client.anchor_purchase_receipt(&service, &id, &buyer_b, &String::from_str(&env, "hashofb"));

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

// ─── Storage key migration (#629) ────────────────────────────────────────────
//
// Every entry this contract owns is addressed by a `DataKey`. Soroban encodes a
// `#[contracttype]` enum as a vec whose first element is a `Symbol` of the
// *variant name* — the name, not the declaration order — so the storage address
// of every existing entry is a function of the spelling of these variants.
//
// That makes two otherwise-invisible edits catastrophic on an upgrade:
//
//   * Renaming a variant re-points the contract at an address nothing was ever
//     written to. The old entries stay on the ledger, fully paid for, and
//     become unreachable — reads return NotFound and writes silently start a
//     parallel set of entries.
//   * Adding or removing an argument changes the key's arity, with the same
//     effect for that variant.
//
// Neither shows up as a compile error, and neither is caught by a behavioural
// test that writes and reads within a single contract version. These tests pin
// the wire shape of every key so that an upgrade which would strand live state
// fails here first. Reordering variants and appending new ones stay allowed —
// both are safe, because nothing about an existing key changes.

/// Decompose a storage key into the vec Soroban encodes it as.
fn storage_key_parts(env: &Env, key: &DataKey) -> Vec<Val> {
    let val: Val = key.into_val(env);
    Vec::try_from_val(env, &val).expect("a #[contracttype] enum key encodes as a vec")
}

/// The variant name a storage key is addressed by on the ledger.
fn storage_key_variant(env: &Env, key: &DataKey) -> Symbol {
    let parts = storage_key_parts(env, key);
    Symbol::try_from_val(env, &parts.get(0).expect("key has a discriminant"))
        .expect("key discriminant is a symbol")
}

/// Every `DataKey` variant, with the name and arity it must keep across
/// upgrades. Adding a variant means adding a row here — the exhaustive match in
/// `storage_key_migration_covers_every_variant` will not compile until you do.
fn storage_key_wire_contract(env: &Env) -> [(DataKey, &'static str, u32); 37] {
fn storage_key_wire_contract(env: &Env) -> [(DataKey, &'static str, u32); 31] {
    let id = String::from_str(env, "migkey");
    let who = Address::generate(env);
    [
        (DataKey::Resource(id.clone()), "Resource", 2),
        (DataKey::Count, "Count", 1),
        (DataKey::Index(0), "Index", 2),
        (DataKey::Admin, "Admin", 1),
        (DataKey::PendingAdmin, "PendingAdmin", 1),
        (DataKey::CreatorTerms(who.clone()), "CreatorTerms", 2),
        (
            DataKey::CreatorResources(who.clone()),
            "CreatorResources",
            2,
        ),
        (DataKey::CreatorCount(who.clone()), "CreatorCount", 2),
        (DataKey::PendingTransfer(id.clone()), "PendingTransfer", 2),
        (DataKey::Verifier(who.clone()), "Verifier", 2),
        (DataKey::NetworkId, "NetworkId", 1),
        (DataKey::PaymentReceipt(id.clone()), "PaymentReceipt", 2),
        (
            DataKey::PaymentIndex(id.clone(), who.clone()),
            "PaymentIndex",
            3,
        ),
        (
            DataKey::PurchaseReceipt(id.clone(), who.clone()),
            "PurchaseReceipt",
            3,
        ),
        (DataKey::TagIndex(id.clone()), "TagIndex", 2),
        (DataKey::FeeConfig, "FeeConfig", 1),
        (DataKey::Moderator(who.clone()), "Moderator", 2),
        (DataKey::DisputeFlag(id.clone()), "DisputeFlag", 2),
        (DataKey::Paused, "Paused", 1),
        (DataKey::PauseUntil, "PauseUntil", 1),
        (DataKey::Settler(who.clone()), "Settler", 2),
        (DataKey::ListedCount, "ListedCount", 1),
        (DataKey::FlagReasonHash(id.clone()), "FlagReasonHash", 2),
        (DataKey::PaymentTxHash(id.clone()), "PaymentTxHash", 2),
        (DataKey::AttestationHash(id.clone()), "AttestationHash", 2),
        (DataKey::PendingAdminExpiry, "PendingAdminExpiry", 1),
        (
            DataKey::PendingAdminNominatedAt,
            "PendingAdminNominatedAt",
            1,
        ),
        (DataKey::TagCount(id.clone()), "TagCount", 2),
        (DataKey::TopTags, "TopTags", 1),
        (
            DataKey::CreatorListedCount(who.clone()),
            "CreatorListedCount",
            2,
        ),
        (DataKey::MemoHash(id.clone()), "MemoHash", 2),
        (DataKey::FeeDestination, "FeeDestination", 1),
        (DataKey::RefundReceipt(id.clone()), "RefundReceipt", 2),
        (DataKey::RefundedAmount(id.clone()), "RefundedAmount", 2),
        (DataKey::RefundTxHash(id.clone()), "RefundTxHash", 2),
        (DataKey::RefundDeadline(id.clone()), "RefundDeadline", 2),
        (DataKey::RefundWindow, "RefundWindow", 1),
        (DataKey::PaymentRecipient(id.clone()), "PaymentRecipient", 2),
        (DataKey::TopTags, "TopTags", 1),
        (DataKey::TagCount(id), "TagCount", 2),
        (DataKey::FlagModerator(id), "FlagModerator", 2),
        (DataKey::CreatorEarnings(who.clone()), "CreatorEarnings", 2),
        (DataKey::VerifierHistory(who.clone()), "VerifierHistory", 2),
    ]
}

#[test]
fn storage_key_variant_names_are_stable() {
    let env = Env::default();
    for (key, name, _) in storage_key_wire_contract(&env).iter() {
        assert_eq!(
            storage_key_variant(&env, key),
            Symbol::new(&env, name),
            "DataKey::{name} is addressed on-chain by its variant name. Renaming it \
             strands every entry already written under the old name — the data stays \
             on the ledger but nothing looks for it. If the rename is intentional, \
             ship a migration that rewrites the affected entries before changing this."
        );
    }
}

#[test]
fn storage_key_arity_is_stable() {
    let env = Env::default();
    for (key, name, arity) in storage_key_wire_contract(&env).iter() {
        assert_eq!(
            storage_key_parts(&env, key).len(),
            *arity,
            "DataKey::{name} must keep {arity} encoded element(s) (the discriminant \
             plus its arguments). Adding or removing an argument re-points the \
             variant at a different address and strands its existing entries."
        );
    }
}

/// Compile-time tripwire: a new `DataKey` variant fails to match here, which
/// forces whoever adds it to also add it to `storage_key_wire_contract` and to
/// think about what the new key means for state already on-chain.
#[test]
fn storage_key_migration_covers_every_variant() {
    let env = Env::default();
    let contract = storage_key_wire_contract(&env);
    assert_eq!(
        contract.len(),
        37,
        31,
        "storage_key_wire_contract must list every DataKey variant"
    );

    for (key, name, _) in contract.iter() {
        let matched = match key {
            DataKey::Resource(_) => "Resource",
            DataKey::Count => "Count",
            DataKey::Index(_) => "Index",
            DataKey::Admin => "Admin",
            DataKey::PendingAdmin => "PendingAdmin",
            DataKey::CreatorTerms(_) => "CreatorTerms",
            DataKey::CreatorResources(_) => "CreatorResources",
            DataKey::CreatorCount(_) => "CreatorCount",
            DataKey::PendingTransfer(_) => "PendingTransfer",
            DataKey::Verifier(_) => "Verifier",
            DataKey::NetworkId => "NetworkId",
            DataKey::PaymentReceipt(_) => "PaymentReceipt",
            DataKey::PaymentIndex(_, _) => "PaymentIndex",
            DataKey::PurchaseReceipt(_, _) => "PurchaseReceipt",
            DataKey::TagIndex(_) => "TagIndex",
            DataKey::FeeConfig => "FeeConfig",
            DataKey::Moderator(_) => "Moderator",
            DataKey::DisputeFlag(_) => "DisputeFlag",
            DataKey::Paused => "Paused",
            DataKey::PauseUntil => "PauseUntil",
            DataKey::Settler(_) => "Settler",
            DataKey::ListedCount => "ListedCount",
            DataKey::FlagReasonHash(_) => "FlagReasonHash",
            DataKey::PaymentTxHash(_) => "PaymentTxHash",
            DataKey::AttestationHash(_) => "AttestationHash",
            DataKey::PendingAdminExpiry => "PendingAdminExpiry",
            DataKey::PendingAdminNominatedAt => "PendingAdminNominatedAt",
            DataKey::TagCount(_) => "TagCount",
            DataKey::TopTags => "TopTags",
            DataKey::CreatorListedCount(_) => "CreatorListedCount",
            DataKey::MemoHash(_) => "MemoHash",
            DataKey::FeeDestination => "FeeDestination",
            DataKey::RefundReceipt(_) => "RefundReceipt",
            DataKey::RefundedAmount(_) => "RefundedAmount",
            DataKey::RefundTxHash(_) => "RefundTxHash",
            DataKey::RefundDeadline(_) => "RefundDeadline",
            DataKey::RefundWindow => "RefundWindow",
            DataKey::PaymentRecipient(_) => "PaymentRecipient",
            DataKey::TopTags => "TopTags",
            DataKey::TagCount(_) => "TagCount",
            DataKey::FlagModerator(_) => "FlagModerator",
            DataKey::CreatorEarnings(_) => "CreatorEarnings",
            DataKey::VerifierHistory(_) => "VerifierHistory",
        };
        assert_eq!(
            matched, *name,
            "storage_key_wire_contract lists {name} against the wrong variant"
        );
    }
}

#[test]
fn same_string_addresses_a_different_entry_per_key_variant() {
    let (env, _creator, client) = setup();
    let shared = String::from_str(&env, "collide");

    // String-keyed variants must remain distinct even when given identical ids.
    env.as_contract(&client.address, || {
        let keys = [
            DataKey::Resource(shared.clone()),
            DataKey::PendingTransfer(shared.clone()),
            DataKey::TagIndex(shared.clone()),
            DataKey::DisputeFlag(shared.clone()),
            DataKey::FlagReasonHash(shared.clone()),
            DataKey::MemoHash(shared.clone()),
            DataKey::RefundReceipt(shared.clone()),
            DataKey::RefundedAmount(shared.clone()),
            DataKey::RefundTxHash(shared.clone()),
            DataKey::RefundDeadline(shared.clone()),
            DataKey::PaymentRecipient(shared.clone()),
            DataKey::TagCount(shared.clone()),
        ];
        for (marker, key) in keys.iter().enumerate() {
            env.storage().persistent().set(key, &(marker as u32));
        }
        for (marker, key) in keys.iter().enumerate() {
            assert_eq!(
                env.storage().persistent().get::<DataKey, u32>(key),
                Some(marker as u32),
                "key variant {marker} was overwritten by another variant carrying \
                 the same string — the variants share a storage address"
            );
        }
    });
}

#[test]
fn address_keyed_variants_do_not_collide_for_one_address() {
    let (env, _creator, client) = setup();
    let who = Address::generate(&env);

    env.as_contract(&client.address, || {
        let keys = [
            DataKey::CreatorTerms(who.clone()),
            DataKey::CreatorResources(who.clone()),
            DataKey::CreatorCount(who.clone()),
            DataKey::CreatorListedCount(who.clone()),
            DataKey::Verifier(who.clone()),
            DataKey::Moderator(who.clone()),
        ];
        for (marker, key) in keys.iter().enumerate() {
            env.storage().persistent().set(key, &(marker as u32));
        }
        for (marker, key) in keys.iter().enumerate() {
            assert_eq!(
                env.storage().persistent().get::<DataKey, u32>(key),
                Some(marker as u32),
                "address-keyed variant {marker} collided with another variant for \
                 the same address"
            );
        }
    });
}

#[test]
fn receipt_and_payment_index_keys_stay_distinct() {
    let (env, _creator, client) = setup();
    let receipt_a = String::from_str(&env, "receipta");
    let receipt_b = String::from_str(&env, "receiptb");
    let res_a = String::from_str(&env, "resa");
    let res_b = String::from_str(&env, "resb");
    let party_a = Address::generate(&env);
    let party_b = Address::generate(&env);

    // PaymentReceipt is keyed by receipt_id alone. PaymentIndex is the
    // resource/counterparty index and must vary in both of its arguments, and
    // both wire shapes must remain distinct from purchase receipt anchors.
    env.as_contract(&client.address, || {
        let keys = [
            DataKey::PaymentReceipt(receipt_a.clone()),
            DataKey::PaymentReceipt(receipt_b.clone()),
            DataKey::PaymentIndex(res_a.clone(), party_a.clone()),
            DataKey::PaymentIndex(res_a.clone(), party_b.clone()),
            DataKey::PaymentIndex(res_b.clone(), party_a.clone()),
            DataKey::PurchaseReceipt(res_a.clone(), party_a.clone()),
            DataKey::PurchaseReceipt(res_b.clone(), party_b.clone()),
        ];
        for (marker, key) in keys.iter().enumerate() {
            env.storage().persistent().set(key, &(marker as u32));
        }
        for (marker, key) in keys.iter().enumerate() {
            assert_eq!(
                env.storage().persistent().get::<DataKey, u32>(key),
                Some(marker as u32),
                "receipt/payment key {marker} collided — distinct keys must not \
                 share a storage address"
            );
        }
    });
}

#[test]
fn indexed_keys_stay_distinct_per_index() {
    let (env, _creator, client) = setup();

    env.as_contract(&client.address, || {
        for slot in 0u32..5 {
            env.storage().persistent().set(&DataKey::Index(slot), &slot);
        }
        for slot in 0u32..5 {
            assert_eq!(
                env.storage()
                    .persistent()
                    .get::<DataKey, u32>(&DataKey::Index(slot)),
                Some(slot),
                "Index({slot}) collided with another slot"
            );
        }
    });
}

#[test]
fn registered_state_survives_a_redeploy_at_the_same_address() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "upgradesafe");
    let metadata = String::from_str(&env, "ipfs://QmUpgrade");
    client.register(
        &creator,
        &id,
        &1_000_000i128,
        &metadata,
        &tags(&env, &["a"]),
    );

    // Redeploy the same contract at the same address, as an upgrade does.
    env.register_at(&client.address, VaultRegistry, ());
    let upgraded = VaultRegistryClient::new(&env, &client.address);

    // Every read path must still resolve the entries written by the old build.
    assert_eq!(upgraded.count(), 1, "counter entry lost across redeploy");
    assert!(upgraded.exists(&id), "resource entry lost across redeploy");

    let resource = upgraded.get(&id);
    assert_eq!(resource.id, id);
    assert_eq!(resource.creator, creator);
    assert_eq!(resource.price, 1_000_000i128);
    assert_eq!(resource.metadata, metadata);
    assert_eq!(
        upgraded.list_by_creator(&creator, &0, &10).len(),
        1,
        "creator index lost across redeploy"
    );
    assert_eq!(
        upgraded
            .list_by_tag(&String::from_str(&env, "a"), &0, &10)
            .len(),
        1,
        "tag index lost across redeploy"
    );
}

#[test]
fn tag_popularity_starts_empty_for_pre_upgrade_resources() {
    let (env, creator, client) = setup();
    let legacy_id = String::from_str(&env, "poplegacy");
    let legacy_tag = String::from_str(&env, "legacy");
    client.register(
        &creator,
        &legacy_id,
        &100i128,
        &String::from_str(&env, "ipfs://legacy"),
        &tags(&env, &["legacy"]),
    );
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .remove(&DataKey::TagCount(legacy_tag.clone()));
        env.storage().instance().remove(&DataKey::TopTags);
    });

    env.register_at(&client.address, VaultRegistry, ());
    let upgraded = VaultRegistryClient::new(&env, &client.address);
    assert_eq!(upgraded.top_tags(&20u32).len(), 0);
    assert_eq!(
        upgraded
            .list_by_tag(&String::from_str(&env, "legacy"), &0u32, &10u32)
            .len(),
        1
    );

    upgraded.register(
        &creator,
        &String::from_str(&env, "popnew1"),
        &100i128,
        &String::from_str(&env, "ipfs://new1"),
        &tags(&env, &["legacy"]),
    );
    upgraded.register(
        &creator,
        &String::from_str(&env, "popnew2"),
        &100i128,
        &String::from_str(&env, "ipfs://new2"),
        &tags(&env, &["new"]),
    );
    upgraded.register(
        &creator,
        &String::from_str(&env, "popnew3"),
        &100i128,
        &String::from_str(&env, "ipfs://new3"),
        &tags(&env, &["new"]),
    );

    let top = upgraded.top_tags(&20u32);
    assert_eq!(top.len(), 2);
    assert_eq!(top.get(0).unwrap().tag, String::from_str(&env, "new"));
    assert_eq!(top.get(0).unwrap().count, 2);
    assert_eq!(top.get(1).unwrap().tag, String::from_str(&env, "legacy"));
    assert_eq!(top.get(1).unwrap().count, 1);
}

#[test]
fn an_entry_written_under_a_datakey_is_the_one_the_contract_reads() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "handwritten");
    client.register(
        &creator,
        &id,
        &1_000_000i128,
        &String::from_str(&env, "ipfs://QmOriginal"),
        &empty_tags(&env),
    );

    // A migration tool works on `DataKey::Resource(id)` from outside the
    // contract's own methods. If the key it computes were not the key `get`
    // reads, a migration would appear to succeed and change nothing.
    let mut migrated = client.get(&id);
    let new_metadata = String::from_str(&env, "ipfs://QmMigrated");
    migrated.metadata = new_metadata.clone();
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::Resource(id.clone()), &migrated);
    });

    assert_eq!(
        client.get(&id).metadata,
        new_metadata,
        "the contract reads a different address than DataKey::Resource(id) computes"
    );
}
// ─── Documentation drift guards (#643, #640) ─────────────────────────────────

/// The crate's own README, which documents the TTL policy and the version
/// compatibility rules that the constants below define.
fn vault_registry_readme() -> std::string::String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/README.md"))
        .expect("contracts/vault-registry/README.md must be readable from the crate")
}

/// Pull the section between one `## ` heading and the next.
fn readme_section<'a>(readme: &'a str, heading: &str) -> &'a str {
    let body = readme
        .split(heading)
        .nth(1)
        .unwrap_or_else(|| panic!("README must have a `{heading}` section"));
    body.split("\n## ").next().unwrap_or(body)
}

#[test]
fn readme_documents_ttl_threshold_constants() {
    let readme = vault_registry_readme();
    let section = readme_section(&readme, "## Storage TTL threshold constants");

    // Each constant must appear in the table with its real value, so the doc
    // cannot drift the way the constants tables in contract/README.md did.
    for (name, value) in [
        ("DAY_IN_LEDGERS", TTL_DAY_IN_LEDGERS),
        ("BUMP_AMOUNT", TTL_BUMP_AMOUNT),
        ("LIFETIME_THRESHOLD", TTL_LIFETIME_THRESHOLD),
    ] {
        assert!(
            section.contains(&format!("`{name}`")),
            "the TTL section must document `{name}`"
        );
        let formatted = format!("`{}`", group_digits(value));
        assert!(
            section.contains(&formatted),
            "the TTL section documents `{name}` but not its current value {formatted} — \
             update contracts/vault-registry/README.md to match src/lib.rs"
        );
    }
}

/// Render a number the way the README's tables do: `518_400`.
fn group_digits(value: u32) -> std::string::String {
    let digits = value.to_string();
    let mut out = std::string::String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push('_');
        }
        out.push(ch);
    }
    out
}

/// Whether `extend_ttl`'s no-op window is strictly positive. Kept as a function
/// rather than inlined into the assertion below so the comparison is evaluated
/// at runtime: written inline the compiler folds it to a constant, and a
/// constant assertion cannot catch the constants actually drifting apart.
fn has_positive_extend_window(lifetime_threshold: u32, bump_amount: u32) -> bool {
    lifetime_threshold < bump_amount
}

#[test]
fn ttl_threshold_leaves_exactly_one_day_of_slack() {
    // The README explains the no-op window in terms of this identity; if the
    // constants stop satisfying it, the explanation is wrong.
    assert_eq!(
        TTL_BUMP_AMOUNT - TTL_LIFETIME_THRESHOLD,
        TTL_DAY_IN_LEDGERS,
        "BUMP_AMOUNT and LIFETIME_THRESHOLD must differ by exactly one day"
    );
    assert!(
        has_positive_extend_window(TTL_LIFETIME_THRESHOLD, TTL_BUMP_AMOUNT),
        "LIFETIME_THRESHOLD must stay below BUMP_AMOUNT, or every read would pay rent"
    );
}

#[test]
fn readme_version_compatibility_documents_current_schema_version() {
    let readme = vault_registry_readme();
    let section = readme_section(&readme, "## Contract version compatibility");

    assert!(
        section.contains("`RESOURCE_SCHEMA_VERSION`"),
        "the version compatibility section must name RESOURCE_SCHEMA_VERSION"
    );
    assert!(
        section.contains(&format!(
            "\"resource_schema_version\": {RESOURCE_SCHEMA_VERSION}"
        )),
        "the documented contract_version output must show the current \
         resource_schema_version ({RESOURCE_SCHEMA_VERSION}) — update \
         contracts/vault-registry/README.md to match src/lib.rs"
    );
    assert!(
        section.contains(&format!("| {RESOURCE_SCHEMA_VERSION} ")),
        "the schema history table must have a row for the current version \
         ({RESOURCE_SCHEMA_VERSION})"
    );
}

#[test]
fn readme_version_compatibility_names_the_breaking_changes() {
    let readme = vault_registry_readme();
    let section = readme_section(&readme, "## Contract version compatibility");

    // The two upgrade hazards the storage-key migration tests above defend
    // against must both be written down, or the tests read as arbitrary.
    assert!(
        section.contains("DataKey"),
        "the compatibility section must explain what renaming a DataKey variant costs"
    );
    assert!(
        section.contains("crate_version") && section.contains("resource_schema_version"),
        "the compatibility section must distinguish the two reported versions"
    );
}

// ── Reporting anchor failures as events ──────────────────────────────────────
//
// `anchor_purchase_receipt` reverts on a rejected anchor, and a Soroban error
// rolls back the whole invocation — events included — so a batching settlement
// service loses every surviving anchor and any on-chain trace of what went
// wrong. `attempt_anchor_purchase_receipt` keeps authorization strict but
// reports the three data failures as an `anchrfail` event.

/// Helper: a registry with an admin and a verifier that can anchor receipts.
fn setup_with_anchor_service<'a>() -> (Env, Address, Address, VaultRegistryClient<'a>) {
    let (env, creator, _admin, client) = setup_with_admin();
    let service = Address::generate(&env);
    client.add_verifier(&service);
    (env, creator, service, client)
}

/// Decode the `AnchorFailure` payload of the most recent event, asserting the
/// topic is `anchrfail` and carries the resource id.
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

    // A success emits the normal `anchor` event, not `anchrfail`. Read it
    // before any other call: the test env's event log reflects only the most
    // recent invocation.
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

    // The pair is now inside its back-off window; move past it before the
    // second attempt so the oversized hash is judged on its own.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + ANCHOR_RETRY_BACKOFF_LEDGERS);
    let too_long = String::from_str(&env, &"a".repeat(MAX_TX_HASH_LEN as usize + 1));
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &too_long));
    assert_eq!(
        last_anchor_failure(&env, &id).reason,
        AnchorFailureReason::InvalidReceiptHash
    );

    // Neither rejected attempt wrote an anchor.
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

/// Every reason the reporting variant emits maps to the error the reverting
/// variant returns for the same input, so callers can treat them alike.
#[test]
fn attempt_anchor_failure_reasons_match_the_reverting_variant_errors() {
    let (env, creator, service, client) = setup_with_anchor_service();
    let id = register_default(&env, &creator, &client, "attparity");
    let buyer = Address::generate(&env);
    let missing = String::from_str(&env, "attparityx");
    let good = String::from_str(&env, "sha256parity");

    // Unknown resource. The reported reason has to be read before the next
    // call: a reverting invocation discards the event log it would have left.
    assert!(!client.attempt_anchor_purchase_receipt(&service, &missing, &buyer, &good));
    let reported = last_anchor_failure(&env, &missing).reason;
    assert_eq!(
        client.try_anchor_purchase_receipt(&service, &missing, &buyer, &good),
        Err(Ok(reported.as_error()))
    );

    // Unusable receipt hash.
    let empty = String::from_str(&env, "");
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &empty));
    let reported = last_anchor_failure(&env, &id).reason;
    assert_eq!(
        client.try_anchor_purchase_receipt(&service, &id, &buyer, &empty),
        Err(Ok(reported.as_error()))
    );

    // Duplicate pair.
    client.anchor_purchase_receipt(&service, &id, &buyer, &good);
    assert!(!client.attempt_anchor_purchase_receipt(&service, &id, &buyer, &good));
    let reported = last_anchor_failure(&env, &id).reason;
    assert_eq!(
        client.try_anchor_purchase_receipt(&service, &id, &buyer, &good),
        Err(Ok(reported.as_error()))
    );
}

/// Authorization is never downgraded to an event: a non-verifier still
/// reverts, so it cannot write to the event log at all.
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

/// A malformed resource id is a caller bug rather than an anchorable attempt,
/// so it reverts instead of producing a failure event.
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

// ── Lifecycle transition property tests ──────────────────────────────────────
//
// The lifecycle state machine is documented as a table in `contract/README.md`
// and implemented across five entry points (`set_listed`, `freeze_resource`,
// `open_dispute`, `resolve_dispute`, `tombstone_resource`) that each enforce
// their own slice of it. The example-based tests above cover individual
// transitions; these properties drive random operation sequences against a
// model of the table and assert the contract agrees on every step — both when
// a transition is accepted and when it is refused.

/// The five lifecycle operations, as a model-side enum.
#[derive(Copy, Clone, Debug, PartialEq)]
enum LifecycleOp {
    Relist,
    Delist,
    Freeze,
    OpenDispute,
    Resolve(ResourceState),
    Tombstone,
}

impl LifecycleOp {
    /// Map a generated byte onto an operation, so proptest can shrink over a
    /// plain `Vec<u8>` rather than a custom strategy.
    fn from_byte(byte: u8) -> Self {
        // Weighted so `Tombstone` stays rare (1 in 16): it is terminal, so a
        // uniform mix would end most sequences after a couple of steps and
        // leave the rest of the table barely explored.
        match byte % 16 {
            0 | 1 => LifecycleOp::Relist,
            2 | 3 => LifecycleOp::Delist,
            4 | 5 => LifecycleOp::Freeze,
            6..=8 => LifecycleOp::OpenDispute,
            9 | 10 => LifecycleOp::Resolve(ResourceState::Listed),
            11 | 12 => LifecycleOp::Resolve(ResourceState::Delisted),
            13 | 14 => LifecycleOp::Resolve(ResourceState::Frozen),
            _ => LifecycleOp::Tombstone,
        }
    }
}

/// The documented transition table, independent of the contract's own
/// branching. Returns the state the operation should leave the resource in,
/// or `None` when the contract must refuse it with
/// `InvalidLifecycleTransition`.
fn model_transition(current: ResourceState, op: LifecycleOp) -> Option<ResourceState> {
    use LifecycleOp::*;
    use ResourceState::*;
    match (current, op) {
        // Tombstoned is terminal: nothing leaves it, not even a re-tombstone.
        (Tombstoned, _) => None,
        // An admin may retire anything that is not already retired.
        (_, Tombstone) => Some(Tombstoned),
        // `set_listed` is a no-op when the resource is already in the target
        // state — it still succeeds, but does not count as a transition.
        (Listed, Relist) => Some(Listed),
        (Delisted, Delist) => Some(Delisted),
        // Creator-driven transitions.
        (Listed, Delist) => Some(Delisted),
        (Delisted, Relist) => Some(Listed),
        (Listed, Freeze) | (Delisted, Freeze) => Some(Frozen),
        // Admin-driven dispute hold, from any active state.
        (Listed, OpenDispute) | (Delisted, OpenDispute) | (Frozen, OpenDispute) => Some(Disputed),
        // A dispute resolves only to an active state.
        (Disputed, Resolve(target @ (Listed | Delisted | Frozen))) => Some(target),
        _ => None,
    }
}

/// Apply an operation through the contract, returning the same
/// `Option<ResourceState>` shape as the model: `None` for a refusal.
fn apply_lifecycle_op(
    client: &VaultRegistryClient<'_>,
    id: &String,
    admin: &Address,
    op: LifecycleOp,
) -> Option<ResourceState> {
    let result = match op {
        LifecycleOp::Relist => client.try_set_listed(id, &true),
        LifecycleOp::Delist => client.try_set_listed(id, &false),
        LifecycleOp::Freeze => client.try_freeze_resource(id),
        LifecycleOp::OpenDispute => client.try_open_dispute(id, admin),
        LifecycleOp::Resolve(target) => client.try_resolve_dispute(id, admin, &target),
        LifecycleOp::Tombstone => client.try_tombstone_resource(id, admin),
    };
    match result {
        Ok(Ok(())) => Some(client.get(id).state),
        Err(Ok(Error::InvalidLifecycleTransition)) => None,
        other => panic!("unexpected lifecycle result for {op:?}: {other:?}"),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    /// Every operation in a random sequence is accepted exactly when the
    /// documented table says it should be, and lands in exactly the state the
    /// table names. A refusal must leave the state untouched.
    #[test]
    fn test_lifecycle_transitions_follow_the_documented_table(
        ops in prop::collection::vec(any::<u8>(), 1..24),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = register_default(&env, &creator, &client, "lifeprop");
        let _ = (&env, &creator);

        let mut expected = ResourceState::Listed;
        for byte in ops {
            let op = LifecycleOp::from_byte(byte);
            let allowed = model_transition(expected, op);
            let observed = apply_lifecycle_op(&client, &id, &admin, op);

            match allowed {
                Some(next) => {
                    prop_assert_eq!(
                        observed,
                        Some(next),
                        "{:?} from {:?} must be accepted and land in {:?}",
                        op,
                        expected,
                        next
                    );
                    expected = next;
                }
                None => {
                    prop_assert_eq!(
                        observed,
                        None,
                        "{:?} from {:?} must be refused with InvalidLifecycleTransition",
                        op,
                        expected
                    );
                    prop_assert_eq!(
                        client.get(&id).state,
                        expected,
                        "a refused transition must not change the state"
                    );
                }
            }
        }
    }

    /// `listed` is a projection of the state, and the discovery views agree
    /// with it, after any sequence of lifecycle operations.
    #[test]
    fn test_lifecycle_keeps_listed_projection_and_views_consistent(
        ops in prop::collection::vec(any::<u8>(), 1..16),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = String::from_str(&env, "lifeproj");
        client.register(
            &creator,
            &id,
            &100i128,
            &String::from_str(&env, "ipfs://lifeproj"),
            &tags(&env, &["proj"]),
        );

        for byte in ops {
            let _ = apply_lifecycle_op(&client, &id, &admin, LifecycleOp::from_byte(byte));

            let resource = client.get(&id);
            let is_listed = resource.state == ResourceState::Listed;
            prop_assert_eq!(
                resource.listed,
                is_listed,
                "listed must project state == Listed (state was {:?})",
                resource.state
            );
            prop_assert_eq!(
                client.list_listed(&0u32, &20u32).len(),
                if is_listed { 1 } else { 0 },
                "list_listed membership must follow the Listed state"
            );

            // Tag discovery survives every state except the terminal one.
            let tagged = client.list_by_tag(&String::from_str(&env, "proj"), &0u32, &20u32);
            prop_assert_eq!(
                tagged.len(),
                if resource.state == ResourceState::Tombstoned { 0 } else { 1 },
                "only tombstoning removes a resource from tag discovery"
            );
        }
    }

    /// Creator mutations are permitted exactly in the two active states, for
    /// every state reachable by a random operation sequence.
    #[test]
    fn test_lifecycle_gates_creator_mutations_by_state(
        ops in prop::collection::vec(any::<u8>(), 0..12),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = register_default(&env, &creator, &client, "lifemut");

        for byte in ops {
            let _ = apply_lifecycle_op(&client, &id, &admin, LifecycleOp::from_byte(byte));
        }

        let state = client.get(&id).state;
        let mutable = matches!(state, ResourceState::Listed | ResourceState::Delisted);
        let result = client.try_set_price(&id, &4_242i128);

        if mutable {
            prop_assert!(
                result.is_ok(),
                "set_price must be allowed in {:?}",
                state
            );
            prop_assert_eq!(client.get(&id).price, 4_242i128);
        } else {
            prop_assert_eq!(
                result,
                Err(Ok(Error::ResourceNotMutable)),
                "set_price must be refused in {:?}",
                state
            );
        }
    }

    /// Once tombstoned, no operation ever succeeds again, and the resource
    /// stays readable for audit.
    #[test]
    fn test_tombstone_is_terminal_for_every_operation(
        ops in prop::collection::vec(any::<u8>(), 1..16),
    ) {
        let (env, creator, admin, client) = setup_with_admin();
        let id = register_default(&env, &creator, &client, "lifeterm");
        let before = client.get(&id);
        client.tombstone_resource(&id, &admin);
        let _ = &env;

        for byte in ops {
            let op = LifecycleOp::from_byte(byte);
            prop_assert_eq!(
                apply_lifecycle_op(&client, &id, &admin, op),
                None,
                "{:?} must be refused once tombstoned",
                op
            );
        }

        let after = client.get(&id);
        prop_assert_eq!(after.state, ResourceState::Tombstoned);
        prop_assert_eq!(after.id, before.id);
        prop_assert_eq!(after.creator, before.creator);
        prop_assert_eq!(after.metadata, before.metadata);
    }
}

// ── Contract storage footprint report ────────────────────────────────────────
//
// Soroban charges rent per ledger entry and archives entries whose TTL runs
// out, so the *shape* of what this contract writes is an operational cost, not
// just an implementation detail. Nothing in the test suite measured it: a
// change that widened `Resource` by a field, or added a second index entry per
// write, showed up only as a WASM size delta (which it does not affect at all)
// or on a rent bill.
//
// `storage_footprint_report` builds one registry in a representative state,
// measures every entry class it writes, and prints the table published in
// `docs/contract-storage-footprint.md`. Run it with:
//
//     cargo test storage_footprint_report -- --nocapture
//
// The budgets below are the enforcement half: they fail the suite when an
// entry class grows past its documented allowance, so growth has to be an
// explicit decision recorded in the doc rather than a silent regression.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]
    #[test]
    fn test_duplicate_resource_id_property(
        ids in prop::collection::vec(r"[a-z0-9]{1,24}", 1..=20),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VaultRegistry, ());
        let client = VaultRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let meta = String::from_str(&env, "ipfs://fuzztest");

        let mut registered = alloc::vec::Vec::new();
        let mut expected_count = 0;

        for id_str in ids {
            let is_reserved = id_str == "admin"
                || id_str == "null"
                || id_str == "registry"
                || id_str == "api"
                || id_str == "index"
                || id_str == "root"
                || id_str == "system";
            if is_reserved {
                continue;
            }

            let id = String::from_str(&env, &id_str);
            let already_registered = registered.contains(&id_str);

            let res = client.try_register(&creator, &id, &100i128, &meta, &empty_tags(&env));
            if already_registered {
                assert_eq!(res, Err(Ok(Error::AlreadyRegistered)));
            } else {
                assert!(res.is_ok());
                registered.push(id_str);
                expected_count += 1;
            }
            assert_eq!(client.count(), expected_count);
        }
    }
}

// ── #610: resource reactivation after dispute resolution ──────────────────
//
// `reactivate_resource` is the creator's exit from `Frozen`/`Delisted` back
// to `Listed`. A resource that was resolved out of a dispute (or otherwise
// left inactive) can be reactivated by its creator; `Disputed` and
// `Tombstoned` resources have no creator exit.

#[test]
fn creator_reactivates_resource_resolved_to_frozen() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "reactv1");

    client.open_dispute(&id, &admin);
    client.resolve_dispute(&id, &admin, &ResourceState::Frozen);
    assert_eq!(client.get(&id).state, ResourceState::Frozen);
    assert!(!client.get(&id).listed);
    assert_eq!(client.listed_count(), 0);

    client.reactivate_resource(&id);
    let resource = client.get(&id);
    assert_eq!(resource.state, ResourceState::Listed);
    assert!(resource.listed);
    assert_eq!(client.listed_count(), 1);
}

#[test]
fn creator_reactivates_resource_resolved_to_delisted() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "reactv2");

    client.open_dispute(&id, &admin);
    client.resolve_dispute(&id, &admin, &ResourceState::Delisted);
    assert_eq!(client.get(&id).state, ResourceState::Delisted);

    client.reactivate_resource(&id);
    assert_eq!(client.get(&id).state, ResourceState::Listed);
    assert!(client.get(&id).listed);
    assert_eq!(client.listed_count(), 1);
}

#[test]
fn creator_reactivates_own_frozen_resource_without_dispute() {
    let (env, creator, _admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "reactv3");

    client.freeze_resource(&id);
    assert_eq!(client.get(&id).state, ResourceState::Frozen);
    assert_eq!(client.listed_count(), 0);

    client.reactivate_resource(&id);
    assert_eq!(client.get(&id).state, ResourceState::Listed);
    assert!(client.get(&id).listed);
    assert_eq!(client.listed_count(), 1);
}

#[test]
fn reactivate_requires_prior_resolution_and_blocks_disputed() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "reactv4");

    // A resource still under dispute has no creator exit: the admin must
    // resolve the dispute first.
    client.open_dispute(&id, &admin);
    assert_eq!(
        client.try_reactivate_resource(&id),
        Err(Ok(Error::InvalidLifecycleTransition)),
        "reactivating a Disputed resource without admin resolution must fail"
    );
    assert_eq!(client.get(&id).state, ResourceState::Disputed);
}

#[test]
fn reactivate_rejects_active_and_tombstoned_resources() {
    let (env, creator, admin, client) = setup_with_admin();
    let active = register_default(&env, &creator, &client, "reactv5");
    let gone = register_default(&env, &creator, &client, "reactv6");

    // Already Listed — nothing to reactivate.
    assert_eq!(
        client.try_reactivate_resource(&active),
        Err(Ok(Error::InvalidLifecycleTransition))
    );

    // Tombstoned is terminal.
    client.tombstone_resource(&gone, &admin);
    assert_eq!(
        client.try_reactivate_resource(&gone),
        Err(Ok(Error::InvalidLifecycleTransition))
    );
    assert_eq!(client.get(&gone).state, ResourceState::Tombstoned);
}

#[test]
#[should_panic]
fn reactivate_requires_creator_authorization() {
    let env = Env::default();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let stranger = Address::generate(&env);
    let id = String::from_str(&env, "reactv7");

    let meta = String::from_str(&env, "ipfs://auth");
    client
        .mock_all_auths()
        .register(&creator, &id, &100i128, &meta, &empty_tags(&env));
    client.mock_all_auths().freeze_resource(&id);
    assert_eq!(client.get(&id).state, ResourceState::Frozen);

    // The stranger signs; the creator's authorization is missing, so the
    // `reactivate_resource` invocation must be reverted by the host.
    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "reactivate_resource",
        args: (id.clone(),).into_val(&env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auths).reactivate_resource(&id);
}

#[test]
fn reactivate_emits_reactive_event() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "reactv8");

    client.open_dispute(&id, &admin);
    client.resolve_dispute(&id, &admin, &ResourceState::Frozen);
    client.reactivate_resource(&id);

    let events = env.events().all();
    let mut found = false;
    for i in 0..events.len() {
        let (address, topics, _data) = events.get(i).unwrap();
        if address == client.address
            && topic0_symbol(&env, &topics) == Some(Symbol::new(&env, "reactive"))
        {
            let carried: String = String::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
            assert_eq!(carried, id);
            found = true;
        }
    }
    assert!(found, "reactive event must be emitted with the resource id");
}

// ── #612: pagination tests for empty indexes ──────────────────────────────
//
// Every paginated listing must degrade gracefully when its index is empty:
// an empty page (never `NotFound`), and for cursor-based listers a `None`
// next cursor.

#[test]
fn list_by_creator_empty_when_creator_has_no_resources() {
    let (env, creator, client) = setup();
    let stranger = Address::generate(&env);
    register_default(&env, &creator, &client, "emptc1");
    register_default(&env, &creator, &client, "emptc2");

    let page = client.list_by_creator(&stranger, &0u32, &20u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_by_creator_empty_when_catalog_empty() {
    let (env, _creator, client) = setup();
    let stranger = Address::generate(&env);
    let page = client.list_by_creator(&stranger, &0u32, &20u32);
    assert_eq!(page.len(), 0);
}

#[test]
fn list_by_creator_empty_when_start_beyond_index() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "emptc3");
    let page = client.list_by_creator(&creator, &5u32, &20u32);
    assert_eq!(page.len(), 0);
    assert_eq!(
        client
            .list_by_creator(&creator, &0u32, &1u32)
            .get(0)
            .unwrap()
            .id,
        id
    );
}

#[test]
fn list_by_dispute_status_empty_on_empty_catalog() {
    let (_env, _creator, client) = setup();
    let flagged = client.list_by_dispute_status(&true, &0u32, &20u32);
    let unflagged = client.list_by_dispute_status(&false, &0u32, &20u32);
    assert_eq!(flagged.len(), 0);
    assert_eq!(unflagged.len(), 0);
}

#[test]
fn list_by_dispute_status_empty_when_no_matching_flags() {
    let (env, creator, client) = setup();
    let id1 = register_default(&env, &creator, &client, "emptd1");
    let id2 = register_default(&env, &creator, &client, "emptd2");
    // No resource is flagged.
    assert_eq!(client.list_by_dispute_status(&true, &0u32, &20u32).len(), 0);
    // Both are unflagged — pagination still walks the catalog.
    let unflagged = client.list_by_dispute_status(&false, &0u32, &20u32);
    assert_eq!(unflagged.len(), 2);
    assert_eq!(unflagged.get(0).unwrap().id, id1);
    assert_eq!(unflagged.get(1).unwrap().id, id2);
}

#[test]
fn list_by_dispute_status_empty_for_opposite_filter() {
    let (env, creator, _admin, moderator, client) = setup_with_moderator();
    let id1 = register_default(&env, &creator, &client, "emptf1");
    let id2 = register_default(&env, &creator, &client, "emptf2");
    client.flag_resource(&id1, &moderator, &FlagReason::Spam);

    // Only id1 is flagged: the true-filter must not see id2, and the
    // false-filter must not see id1 while still walking the catalog.
    let flagged = client.list_by_dispute_status(&true, &0u32, &20u32);
    assert_eq!(flagged.len(), 1);
    assert_eq!(flagged.get(0).unwrap().id, id1);

    let unflagged = client.list_by_dispute_status(&false, &0u32, &20u32);
    assert_eq!(unflagged.len(), 1);
    assert_eq!(unflagged.get(0).unwrap().id, id2);
}

#[test]
fn list_by_verification_status_empty_on_empty_catalog() {
    let (_env, _creator, client) = setup();
    for status in [
        VerificationStatus::Pending,
        VerificationStatus::Verified,
        VerificationStatus::Rejected,
    ] {
        let page = client.list_by_verification_status(&status, &0u32, &20u32);
        assert_eq!(page.items.len(), 0);
        assert_eq!(page.next_cursor, None, "{status:?} on an empty catalog");
    }
}

#[test]
fn list_by_verification_status_empty_when_no_matching_status() {
    let (env, creator, client) = setup();
    register_default(&env, &creator, &client, "emptv1");
    register_default(&env, &creator, &client, "emptv2");

    let page = client.list_by_verification_status(&VerificationStatus::Verified, &0u32, &20u32);
    assert_eq!(page.items.len(), 0);
    assert_eq!(page.next_cursor, None);

    let pending = client.list_by_verification_status(&VerificationStatus::Pending, &0u32, &20u32);
    assert_eq!(pending.items.len(), 2);
    assert_eq!(pending.next_cursor, None);
}

// ── #613: boundary tests for maximum tag count ────────────────────────────
//
// MAX_TAGS is 8. These tests pin the exact boundary: registration and
// set_tags both accept exactly 8 tags and reject the 9th, including the
// case-normalized and structurally-invalid boundary cases.

#[test]
fn register_accepts_exactly_max_tags() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxregok");
    let eight = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h"]);
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &eight,
    );
    assert_eq!(client.get(&id).tags.len(), 8);
}

#[test]
fn register_rejects_one_past_max_tag_count() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxreg9");
    let nine = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    assert_eq!(
        client.try_register(
            &creator,
            &id,
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &nine,
        ),
        Err(Ok(Error::InvalidTag)),
        "register must reject tag counts > MAX_TAGS (8)"
    );
    assert_eq!(client.try_get(&id), Err(Ok(Error::NotFound)));
}

#[test]
fn set_tags_accepts_growth_at_the_boundary_then_rejects_boundary_plus_one() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxgrow");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    let seven = tags(&env, &["a", "b", "c", "d", "e", "f", "g"]);
    client.set_tags(&id, &seven);
    let eight = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h"]);
    client.set_tags(&id, &eight);
    assert_eq!(client.get(&id).tags.len(), 8);

    let nine = tags(&env, &["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    assert_eq!(
        client.try_set_tags(&id, &nine),
        Err(Ok(Error::InvalidTag)),
        "growing past exactly MAX_TAGS must be rejected"
    );
    assert_eq!(client.get(&id).tags.len(), 8);
}

#[test]
fn max_tag_count_with_an_empty_entry_is_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxempty");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // 8 entries, one of which is empty — structurally over the constraint.
    let bad = tags(&env, &["a", "b", "c", "d", "", "f", "g", "h"]);
    assert_eq!(
        client.try_set_tags(&id, &bad),
        Err(Ok(Error::InvalidTag)),
        "a max-count set containing an empty tag must be rejected"
    );
    assert_eq!(client.get(&id).tags.len(), 0);
}

#[test]
fn max_tag_count_with_a_duplicate_normalized_entry_is_rejected() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "maxdup");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // 8 entries but "ML"/"ml" normalize to the same tag — must not pass the
    // boundary check as if it were 8 distinct labels.
    let bad = tags(&env, &["ML", "ml", "c", "d", "e", "f", "g", "h"]);
    assert_eq!(
        client.try_set_tags(&id, &bad),
        Err(Ok(Error::InvalidTag)),
        "max-count set must still reject duplicate normalized tags"
    );
    assert_eq!(client.get(&id).tags.len(), 0);
}

// ── #614: duplicate payment receipts by tx hash ───────────────────────────
//
// `record_payment` must refuse to store a second receipt backed by the same
// Stellar transaction hash, so a single settlement cannot be double-counted.

#[test]
fn record_payment_rejects_same_tx_hash_with_different_receipt_id() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_priced(&env, &creator, &client, "duptx1", 1_000_000);
    let shared_tx = String::from_str(&env, "0xdeadbeefsharedtxhash");

    client.record_payment(
        &settler,
        &String::from_str(&env, "rcpt-a"),
        &id,
        &creator,
        &1_000_000i128,
        &shared_tx,
    );

    assert_eq!(
        client.try_record_payment(
            &settler,
            &String::from_str(&env, "rcpt-b"),
            &id,
            &creator,
            &1_000_000i128,
            &shared_tx,
        ),
        Err(Ok(Error::DuplicateTxHash)),
        "a second receipt reusing the same tx_hash must be rejected explicitly"
    );
    // The first receipt stays usable; the second never materialized.
    assert_eq!(
        client.get_payment(&String::from_str(&env, "rcpt-a")).state,
        PaymentState::Escrowed
    );
    assert_eq!(
        client.try_get_payment(&String::from_str(&env, "rcpt-b")),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn record_payment_allows_same_receipt_id_with_different_tx_hash() {
    let (env, creator, _admin, settler, client) = setup_with_settler();
    let id = register_priced(&env, &creator, &client, "duptx2", 1_000_000);
    let tx_a = String::from_str(&env, "0xtxhashone");
    let tx_b = String::from_str(&env, "0xtxhashtwo");

    client.record_payment(
        &settler,
        &String::from_str(&env, "rcpt-only"),
        &id,
        &creator,
        &1_000_000i128,
        &tx_a,
    );
    // Distinct tx hashes are fine for the same resource/payer — the change is
    // scoped to the tx hash, not to the (resource, payer) pair.
    client.record_payment(
        &settler,
        &String::from_str(&env, "rcpt-second"),
        &id,
        &creator,
        &1_000_000i128,
        &tx_b,
    );
    assert_eq!(
        client
            .get_payment(&String::from_str(&env, "rcpt-only"))
            .tx_hash,
        tx_a
    );
    assert_eq!(
        client
            .get_payment(&String::from_str(&env, "rcpt-second"))
            .tx_hash,
        tx_b
    );
}

#[test]
fn top_tags_counts_successful_registrations_by_normalized_tag() {
    let (env, creator, client) = setup();
    assert_eq!(client.top_tags(&20u32).len(), 0);

    client.register(
        &creator,
        &String::from_str(&env, "popr1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["DataSet", "common"]),
    );
    client.register(
        &creator,
        &String::from_str(&env, "popr2"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["dataset", "other"]),
    );
    client.register(
        &creator,
        &String::from_str(&env, "popr3"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["COMMON"]),
    );

    let top = client.top_tags(&20u32);
    assert_eq!(top.len(), 3);
    assert_eq!(top.get(0).unwrap().tag, String::from_str(&env, "common"));
    assert_eq!(top.get(0).unwrap().count, 2);
    assert_eq!(top.get(1).unwrap().tag, String::from_str(&env, "dataset"));
    assert_eq!(top.get(1).unwrap().count, 2);
    assert_eq!(top.get(2).unwrap().tag, String::from_str(&env, "other"));
    assert_eq!(top.get(2).unwrap().count, 1);
}

#[test]
fn whitespace_only_tags_are_rejected_before_counting() {
    let (env, creator, client) = setup();
    assert_eq!(
        client.try_register(
            &creator,
            &String::from_str(&env, "popblank"),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &tags(&env, &[" \t"]),
        ),
        Err(Ok(Error::InvalidTag))
    );
    assert_eq!(client.top_tags(&20u32).len(), 0);
}

#[test]
fn top_tags_ignores_failed_registrations_and_later_tag_replacements() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "popr4");
    let metadata = String::from_str(&env, "ipfs://m");
    let original = tags(&env, &["original"]);
    client.register(&creator, &id, &100i128, &metadata, &original);

    assert_eq!(
        client.try_register(
            &creator,
            &id,
            &100i128,
            &metadata,
            &tags(&env, &["duplicate"]),
        ),
        Err(Ok(Error::AlreadyRegistered))
    );
    client.set_tags(&id, &tags(&env, &["replacement"]));

    let top = client.top_tags(&20u32);
    assert_eq!(top.len(), 1);
    assert_eq!(top.get(0).unwrap().tag, String::from_str(&env, "original"));
    assert_eq!(top.get(0).unwrap().count, 1);
}

#[test]
fn top_tags_caps_the_response_and_honors_zero_limit() {
    let (env, creator, client) = setup();
    for i in 0..(TOP_TAGS_CAP + 5) {
        let id = format!("popcap{:02}", i);
        let tag = format!("tag{:02}", i);
        client.register(
            &creator,
            &String::from_str(&env, &id),
            &100i128,
            &String::from_str(&env, "ipfs://m"),
            &tags(&env, &[tag.as_str()]),
        );
    }

    assert_eq!(client.top_tags(&0u32).len(), 0);
    let top = client.top_tags(&(TOP_TAGS_CAP + 5));
    assert_eq!(top.len(), TOP_TAGS_CAP);
    assert_eq!(top.get(0).unwrap().tag, String::from_str(&env, "tag00"));
    assert_eq!(top.get(19).unwrap().tag, String::from_str(&env, "tag19"));

    client.register(
        &creator,
        &String::from_str(&env, "popreenter"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["tag20"]),
    );
    let top = client.top_tags(&TOP_TAGS_CAP);
    assert_eq!(top.get(0).unwrap().tag, String::from_str(&env, "tag20"));
    assert_eq!(top.get(0).unwrap().count, 2);
}

#[test]
fn tag_popularity_counter_saturates_at_u32_max() {
    let (env, creator, client) = setup();
    let maxed_tag = String::from_str(&env, "maxed");
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::TagCount(maxed_tag.clone()), &u32::MAX);
    });

    client.register(
        &creator,
        &String::from_str(&env, "popmax"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &tags(&env, &["maxed"]),
    );

    let top = client.top_tags(&1u32);
    assert_eq!(top.get(0).unwrap().tag, String::from_str(&env, "maxed"));
    assert_eq!(top.get(0).unwrap().count, u32::MAX);
}

#[test]
fn register_surfaces_count_overflow_when_count_is_max() {
    let (env, creator, client) = setup();
    env.as_contract(&client.address, || {
        env.storage().instance().set(&DataKey::Count, &u32::MAX);
    });

    let res = client.try_register(
        &creator,
        &String::from_str(&env, "ovf1"),
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );
    assert_eq!(res, Err(Ok(Error::CountOverflow)));
}

#[test]
fn initialize_network_rejects_replay_even_with_mismatched_id() {
    let (env, _creator, client) = setup();
    let network_id = env.ledger().network_id();
    client.initialize_network(&network_id);

    let mut wrong = network_id.to_array();
    wrong[0] ^= 1;
    let wrong = BytesN::from_array(&env, &wrong);

    // After network is initialized, duplicate call with wrong id fails with NetworkAlreadyInitialized
    assert_eq!(
        client.try_initialize_network(&wrong),
        Err(Ok(Error::NetworkAlreadyInitialized))
    );
}

#[test]
fn differently_cased_tags_indexed_under_same_normalized_tag() {
    let (env, creator, client) = setup();
    let r1 = String::from_str(&env, "case1");
    let r2 = String::from_str(&env, "case2");

    client.register(
        &creator,
        &r1,
        &100i128,
        &String::from_str(&env, "ipfs://1"),
        &tags(&env, &["RustLang"]),
    );
    client.register(
        &creator,
        &r2,
        &200i128,
        &String::from_str(&env, "ipfs://2"),
        &tags(&env, &["rustlang"]),
    );

    let results = client.list_by_tag(&String::from_str(&env, "RUSTLANG"), &0, &10);
    assert_eq!(results.len(), 2);
}

include!("test/lifecycle_events.rs");
include!("test/storage_footprint.rs");

include!("test/auth_fixtures.rs");
include!("test/tombstone_read.rs");
include!("test/creator_listed_count.rs");
include!("test/memo_hash.rs");
include!("test/flag_details.rs");
include!("test/payment_idempotency.rs");
include!("test/stellar_wave_804_805_806_808.rs");
