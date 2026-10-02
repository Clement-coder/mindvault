// ─── Soroban auth fixture helpers (#641) ──────────────────────────────────
//
// This module provides reusable helpers for assembling `MockAuth` /
// `MockAuthInvoke` fixtures in contract tests.  Each helper builds the
// `[MockAuth]` slice that you pass to `client.mock_auths(…)` so individual
// tests do not have to repeat the boilerplate inline.
//
// `MockAuthInvoke<'a>` fields (soroban-sdk 22):
//   contract:     &'a Address
//   fn_name:      &'a str
//   args:         Vec<Val>       ← soroban_sdk::Vec<Val>, no generic
//   sub_invokes:  &'a [MockAuthInvoke<'a>]
//
// `MockAuth<'a>` fields:
//   address:  &'a Address
//   invoke:   &'a MockAuthInvoke<'a>
//
// Usage pattern
// -------------
// Keep the `MockAuthInvoke` and the `MockAuth` slice in the same stack
// frame so the borrow checker is happy:
//
//   let invoke = build_set_price_invoke(&env, &client, &id, 999i128);
//   let auth   = [MockAuth { address: &owner, invoke: &invoke }];
//   client.mock_auths(&auth).set_price(&id, &999i128);
//
// Acceptance tests
// ----------------
// Every helper is exercised by two tests:
//   1. Correct signer ⇒ call succeeds.
//   2. Wrong signer   ⇒ call panics (strict auth enforcement).

// ---------------------------------------------------------------------------
// Per-method invoke builders
// ---------------------------------------------------------------------------

/// Build a `MockAuthInvoke` for `register(creator, id, price, metadata, tags)`.
fn build_register_invoke<'a>(
    env: &soroban_sdk::Env,
    caller: &soroban_sdk::Address,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    price: i128,
    metadata: &soroban_sdk::String,
    tags: &soroban_sdk::Vec<soroban_sdk::String>,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "register",
        args: (
            caller.clone(),
            id.clone(),
            price,
            metadata.clone(),
            tags.clone(),
        )
            .into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `set_price(id, new_price)`.
fn build_set_price_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    new_price: i128,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_price",
        args: (id.clone(), new_price).into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `update_metadata(id, metadata)`.
fn build_update_metadata_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    metadata: &soroban_sdk::String,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "update_metadata",
        args: (id.clone(), metadata.clone()).into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `set_tags(id, tags)`.
fn build_set_tags_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    t: &soroban_sdk::Vec<soroban_sdk::String>,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_tags",
        args: (id.clone(), t.clone()).into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `set_listed(id, listed)`.
fn build_set_listed_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    listed: bool,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_listed",
        args: (id.clone(), listed).into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `delist(id)`.
fn build_delist_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "delist",
        args: (id.clone(),).into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `transfer_ownership(id, new_owner)`.
fn build_transfer_ownership_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    new_owner: &soroban_sdk::Address,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "transfer_ownership",
        args: (id.clone(), new_owner.clone()).into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `freeze_metadata(id)`.
fn build_freeze_metadata_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "freeze_metadata",
        args: (id.clone(),).into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for
/// `set_verification_status(id, verifier, status, attestation_hash)`.
fn build_set_verification_status_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    verifier: &soroban_sdk::Address,
    status: VerificationStatus,
    attestation_hash: &Option<soroban_sdk::String>,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "set_verification_status",
        args: (
            id.clone(),
            verifier.clone(),
            status,
            attestation_hash.clone(),
        )
            .into_val(env),
        sub_invokes: &[],
    }
}

/// Build a `MockAuthInvoke` for `tombstone_resource(id, admin)`.
fn build_tombstone_invoke<'a>(
    env: &soroban_sdk::Env,
    client: &'a VaultRegistryClient<'a>,
    id: &soroban_sdk::String,
    admin: &soroban_sdk::Address,
) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &client.address,
        fn_name: "tombstone_resource",
        args: (id.clone(), admin.clone()).into_val(env),
        sub_invokes: &[],
    }
}

// ---------------------------------------------------------------------------
// Convenience setup helper: env + admin + verifier
// ---------------------------------------------------------------------------

/// Like `setup_with_admin` (from lifecycle_roles.rs) but also adds a verifier.
/// Returns `(env, creator, admin, verifier, client)`.
fn setup_with_verifier<'a>() -> (
    soroban_sdk::Env,
    soroban_sdk::Address,
    soroban_sdk::Address,
    soroban_sdk::Address,
    VaultRegistryClient<'a>,
) {
    let (env, creator, client) = setup();
    let admin = soroban_sdk::Address::generate(&env);
    let verifier = soroban_sdk::Address::generate(&env);
    client.nominate_new_admin(&admin);
    client.add_verifier(&verifier);
    (env, creator, admin, verifier, client)
}

// ---------------------------------------------------------------------------
// Acceptance tests — creator-gated methods
// ---------------------------------------------------------------------------

/// `build_register_invoke` produces an invoke the SDK accepts for the creator.
#[test]
fn auth_fixture_register_accepted_for_creator() {
    let env = soroban_sdk::Env::default();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let creator = soroban_sdk::Address::generate(&env);
    let id = soroban_sdk::String::from_str(&env, "authreg");
    let price = 1_000i128;
    let metadata = soroban_sdk::String::from_str(&env, "ipfs://authreg");
    let tags = empty_tags(&env);
    let invoke = build_register_invoke(&env, &creator, &client, &id, price, &metadata, &tags);
    let auth = [MockAuth {
        address: &creator,
        invoke: &invoke,
    }];
    client
        .mock_auths(&auth)
        .register(&creator, &id, &price, &metadata, &tags);
    assert_eq!(client.get(&id).creator, creator);
}

/// Supplying a stranger's auth panics, so a registration cannot be made to look
/// as though a third party authored it.
#[test]
#[should_panic]
fn auth_fixture_register_rejected_for_stranger() {
    let env = soroban_sdk::Env::default();
    let contract_id = env.register(VaultRegistry, ());
    let client = VaultRegistryClient::new(&env, &contract_id);
    let creator = soroban_sdk::Address::generate(&env);
    let stranger = soroban_sdk::Address::generate(&env);
    let id = soroban_sdk::String::from_str(&env, "authreg2");
    let price = 1_000i128;
    let metadata = soroban_sdk::String::from_str(&env, "ipfs://authreg2");
    let tags = empty_tags(&env);
    let invoke = build_register_invoke(&env, &creator, &client, &id, price, &metadata, &tags);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client
        .mock_auths(&auth)
        .register(&creator, &id, &price, &metadata, &tags);
}

/// `build_set_price_invoke` produces an invoke the SDK accepts for the owner.
#[test]
fn auth_fixture_set_price_accepted_for_owner() {
    let (env, owner, _stranger, client, id) = setup_strict_auth();
    let new_price = 999i128;
    let invoke = build_set_price_invoke(&env, &client, &id, new_price);
    let auth = [MockAuth {
        address: &owner,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).set_price(&id, &new_price);
    assert_eq!(client.get(&id).price, new_price);
}

/// Supplying a stranger panics (strict `require_auth` enforcement).
#[test]
#[should_panic]
fn auth_fixture_set_price_rejected_for_stranger() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let new_price = 42i128;
    let invoke = build_set_price_invoke(&env, &client, &id, new_price);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).set_price(&id, &new_price);
}

/// `build_update_metadata_invoke` is accepted for the owner.
#[test]
fn auth_fixture_update_metadata_accepted_for_owner() {
    let (env, owner, _stranger, client, id) = setup_strict_auth();
    let new_meta = soroban_sdk::String::from_str(&env, "ipfs://fixture-meta");
    let invoke = build_update_metadata_invoke(&env, &client, &id, &new_meta);
    let auth = [MockAuth {
        address: &owner,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).update_metadata(&id, &new_meta);
    assert_eq!(client.get(&id).metadata, new_meta);
}

/// `build_update_metadata_invoke` panics for a stranger.
#[test]
#[should_panic]
fn auth_fixture_update_metadata_rejected_for_stranger() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let new_meta = soroban_sdk::String::from_str(&env, "ipfs://stolen");
    let invoke = build_update_metadata_invoke(&env, &client, &id, &new_meta);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).update_metadata(&id, &new_meta);
}

/// `build_set_tags_invoke` is accepted for the owner.
#[test]
fn auth_fixture_set_tags_accepted_for_owner() {
    let (env, owner, _stranger, client, id) = setup_strict_auth();
    let new_tags = tags(&env, &["fixture", "auth"]);
    let invoke = build_set_tags_invoke(&env, &client, &id, &new_tags);
    let auth = [MockAuth {
        address: &owner,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).set_tags(&id, &new_tags);
    assert_eq!(client.get(&id).tags.len(), 2);
}

/// `build_set_tags_invoke` panics for a stranger.
#[test]
#[should_panic]
fn auth_fixture_set_tags_rejected_for_stranger() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let t = tags(&env, &["hacked"]);
    let invoke = build_set_tags_invoke(&env, &client, &id, &t);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).set_tags(&id, &t);
}

/// `build_set_listed_invoke` is accepted for the owner.
#[test]
fn auth_fixture_set_listed_accepted_for_owner() {
    let (env, owner, _stranger, client, id) = setup_strict_auth();
    let invoke = build_set_listed_invoke(&env, &client, &id, false);
    let auth = [MockAuth {
        address: &owner,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).set_listed(&id, &false);
    assert!(!client.get(&id).listed);
}

/// `build_set_listed_invoke` panics for a stranger.
#[test]
#[should_panic]
fn auth_fixture_set_listed_rejected_for_stranger() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = build_set_listed_invoke(&env, &client, &id, false);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).set_listed(&id, &false);
}

/// `build_delist_invoke` is accepted for the owner.
#[test]
fn auth_fixture_delist_accepted_for_owner() {
    let (env, owner, _stranger, client, id) = setup_strict_auth();
    let invoke = build_delist_invoke(&env, &client, &id);
    let auth = [MockAuth {
        address: &owner,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).delist(&id);
    assert!(!client.get(&id).listed);
}

/// `build_delist_invoke` panics for a stranger.
#[test]
#[should_panic]
fn auth_fixture_delist_rejected_for_stranger() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = build_delist_invoke(&env, &client, &id);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).delist(&id);
}

/// `build_transfer_ownership_invoke` is accepted for the owner.
#[test]
fn auth_fixture_transfer_ownership_accepted_for_owner() {
    let (env, owner, _stranger, client, id) = setup_strict_auth();
    let new_owner = soroban_sdk::Address::generate(&env);
    let invoke = build_transfer_ownership_invoke(&env, &client, &id, &new_owner);
    let auth = [MockAuth {
        address: &owner,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).transfer_ownership(&id, &new_owner);
    assert_eq!(client.get_owner(&id), new_owner);
}

/// `build_transfer_ownership_invoke` panics for a stranger.
#[test]
#[should_panic]
fn auth_fixture_transfer_ownership_rejected_for_stranger() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let new_owner = soroban_sdk::Address::generate(&env);
    let invoke = build_transfer_ownership_invoke(&env, &client, &id, &new_owner);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).transfer_ownership(&id, &new_owner);
}

/// `build_freeze_metadata_invoke` is accepted for the owner.
#[test]
fn auth_fixture_freeze_metadata_accepted_for_owner() {
    let (env, owner, _stranger, client, id) = setup_strict_auth();
    let invoke = build_freeze_metadata_invoke(&env, &client, &id);
    let auth = [MockAuth {
        address: &owner,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).freeze_metadata(&id);
    assert!(client.get(&id).frozen);
}

/// `build_freeze_metadata_invoke` panics for a stranger.
#[test]
#[should_panic]
fn auth_fixture_freeze_metadata_rejected_for_stranger() {
    let (env, _owner, stranger, client, id) = setup_strict_auth();
    let invoke = build_freeze_metadata_invoke(&env, &client, &id);
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).freeze_metadata(&id);
}

// ---------------------------------------------------------------------------
// Acceptance tests — verifier-gated method
// ---------------------------------------------------------------------------

/// `build_set_verification_status_invoke` is accepted for the legitimate verifier.
#[test]
fn auth_fixture_set_verification_status_accepted_for_verifier() {
    let (env, creator, _admin, verifier, client) = setup_with_verifier();
    let id = soroban_sdk::String::from_str(&env, "authvfx1");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://auth"),
        &empty_tags(&env),
    );
    let invoke = build_set_verification_status_invoke(
        &env,
        &client,
        &id,
        &verifier,
        VerificationStatus::Verified,
        &None,
    );
    let auth = [MockAuth {
        address: &verifier,
        invoke: &invoke,
    }];
    client
        .mock_auths(&auth)
        .set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
    assert_eq!(client.get(&id).verified, VerificationStatus::Verified);
}

/// `build_set_verification_status_invoke` works with an attestation hash.
#[test]
fn auth_fixture_set_verification_status_with_attestation_hash() {
    let (env, creator, _admin, verifier, client) = setup_with_verifier();
    let id = soroban_sdk::String::from_str(&env, "authvfx2");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://auth2"),
        &empty_tags(&env),
    );
    let attest = Some(soroban_sdk::String::from_str(&env, "sha256:abcdef01"));
    let invoke = build_set_verification_status_invoke(
        &env,
        &client,
        &id,
        &verifier,
        VerificationStatus::Rejected,
        &attest,
    );
    let auth = [MockAuth {
        address: &verifier,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).set_verification_status(
        &id,
        &verifier,
        &VerificationStatus::Rejected,
        &attest,
    );
    assert_eq!(client.get(&id).verified, VerificationStatus::Rejected);
    assert_eq!(
        client.get_attestation_hash(&id),
        Some(soroban_sdk::String::from_str(&env, "sha256:abcdef01"))
    );
}

/// Supplying a stranger in a verifier auth fixture panics.
#[test]
#[should_panic]
fn auth_fixture_set_verification_status_rejected_for_stranger() {
    let (env, creator, _admin, verifier, client) = setup_with_verifier();
    let stranger = soroban_sdk::Address::generate(&env);
    let id = soroban_sdk::String::from_str(&env, "authvfx3");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://auth3"),
        &empty_tags(&env),
    );
    let invoke = build_set_verification_status_invoke(
        &env,
        &client,
        &id,
        &verifier,
        VerificationStatus::Verified,
        &None,
    );
    // stranger is in the auth slot but the contract checks verifier.require_auth()
    let auth = [MockAuth {
        address: &stranger,
        invoke: &invoke,
    }];
    client
        .mock_auths(&auth)
        .set_verification_status(&id, &verifier, &VerificationStatus::Verified, &None);
}

// ---------------------------------------------------------------------------
// Acceptance tests — admin-gated method
// ---------------------------------------------------------------------------

/// `build_tombstone_invoke` is accepted when the current admin signs.
#[test]
fn auth_fixture_tombstone_accepted_for_admin() {
    let (env, creator, client) = setup();
    let admin = soroban_sdk::Address::generate(&env);
    client.nominate_new_admin(&admin);
    let id = soroban_sdk::String::from_str(&env, "authtmb1");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://t"),
        &empty_tags(&env),
    );
    let invoke = build_tombstone_invoke(&env, &client, &id, &admin);
    let auth = [MockAuth {
        address: &admin,
        invoke: &invoke,
    }];
    client.mock_auths(&auth).tombstone_resource(&id, &admin);
    assert_eq!(client.get(&id).state, ResourceState::Tombstoned);
}

/// `build_tombstone_invoke` panics when a non-admin address signs.
#[test]
#[should_panic]
fn auth_fixture_tombstone_rejected_for_non_admin() {
    let (env, creator, client) = setup();
    let admin = soroban_sdk::Address::generate(&env);
    let stranger = soroban_sdk::Address::generate(&env);
    client.nominate_new_admin(&admin);
    let id = soroban_sdk::String::from_str(&env, "authtmb2");
    client.register(
        &creator,
        &id,
        &100i128,
        &soroban_sdk::String::from_str(&env, "ipfs://t"),
        &empty_tags(&env),
    );
    let invoke = build_tombstone_invoke(&env, &client, &id, &admin);
    let auth = [MockAuth {
        address: &stranger, // wrong signer
        invoke: &invoke,
    }];
    client.mock_auths(&auth).tombstone_resource(&id, &admin);
}
