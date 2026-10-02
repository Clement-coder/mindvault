// ─── Registration memo hash (#682) ──────────────────────────────────────────
//
// `register_with_memo` records an optional 32-byte memo hash alongside a new
// resource (for example the `MEMO_HASH` of the transaction that announced it),
// readable through `get_memo_hash` and announced by a `regmemo` event. The hash
// is written once at registration and has no setter, so these tests pin both
// what is stored and everything that must leave it alone.

fn memo(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

fn register_memo<'a>(
    env: &Env,
    creator: &Address,
    client: &VaultRegistryClient<'a>,
    id: &str,
    memo_hash: Option<BytesN<32>>,
) -> String {
    let id = String::from_str(env, id);
    client.register_with_memo(
        creator,
        &id,
        &100i128,
        &String::from_str(env, "ipfs://memo"),
        &empty_tags(env),
        &None,
        &memo_hash,
    );
    id
}

/// Topic-0 symbols of every event this contract emitted for `id`.
fn topics_for(
    env: &Env,
    client: &VaultRegistryClient<'_>,
    id: &String,
) -> std::vec::Vec<std::string::String> {
    let mut out = std::vec::Vec::new();
    let all = env.events().all();
    for i in 0..all.len() {
        let (cid, topics, _data) = all.get(i).unwrap();
        if cid != client.address || topics.len() != 2 {
            continue;
        }
        let topic_id: String = match topics.get(1).unwrap().try_into_val(env) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if topic_id != *id {
            continue;
        }
        if let Some(sym) = topic0_symbol(env, &topics) {
            out.push(sym.to_string());
        }
    }
    out
}

#[test]
fn register_with_memo_stores_the_hash() {
    let (env, creator, client) = setup();
    let id = register_memo(&env, &creator, &client, "memores1", Some(memo(&env, 1)));

    assert_eq!(client.get_memo_hash(&id), Some(memo(&env, 1)));
    // Everything else about the registration is unchanged.
    let r = client.get(&id);
    assert!(r.listed);
    assert_eq!(r.creator, creator);
    assert_eq!(r.content_hash, None);
    assert_eq!(client.count(), 1);
}

#[test]
fn register_with_memo_keeps_the_content_hash_too() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "memores2");
    client.register_with_memo(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://memo"),
        &empty_tags(&env),
        &Some(String::from_str(&env, "sha256:abcd")),
        &Some(memo(&env, 2)),
    );

    assert_eq!(
        client.get(&id).content_hash,
        Some(String::from_str(&env, "sha256:abcd"))
    );
    assert_eq!(client.get_memo_hash(&id), Some(memo(&env, 2)));
}

#[test]
fn resources_registered_without_a_memo_have_none() {
    let (env, creator, client) = setup();
    let plain = register_default(&env, &creator, &client, "memonone1");
    let hashed = String::from_str(&env, "memonone2");
    client.register_with_hash(
        &creator,
        &hashed,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
        &Some(String::from_str(&env, "sha256:abcd")),
    );
    let explicit_none = register_memo(&env, &creator, &client, "memonone3", None);

    assert_eq!(client.get_memo_hash(&plain), None);
    assert_eq!(client.get_memo_hash(&hashed), None);
    assert_eq!(client.get_memo_hash(&explicit_none), None);
}

#[test]
fn get_memo_hash_is_none_for_unknown_and_malformed_ids() {
    let (env, _creator, client) = setup();
    assert_eq!(
        client.get_memo_hash(&String::from_str(&env, "neverseen")),
        None
    );
    assert_eq!(
        client.get_memo_hash(&String::from_str(&env, "NOT-VALID!")),
        None
    );
}

#[test]
fn register_with_memo_emits_regmemo_after_register() {
    let (env, creator, client) = setup();
    let id = register_memo(&env, &creator, &client, "memoevt1", Some(memo(&env, 3)));

    assert_eq!(topics_for(&env, &client, &id), ["register", "regmemo"]);

    // The regmemo payload is the memo hash itself.
    let all = env.events().all();
    let mut found = false;
    for i in 0..all.len() {
        let (_, topics, data) = all.get(i).unwrap();
        if topic0_symbol(&env, &topics) == Some(Symbol::new(&env, "regmemo")) {
            let payload: BytesN<32> = data.try_into_val(&env).unwrap();
            assert_eq!(payload, memo(&env, 3));
            found = true;
        }
    }
    assert!(found, "regmemo event must be emitted");
}

#[test]
fn no_regmemo_event_without_a_memo() {
    let (env, creator, client) = setup();
    let id = register_memo(&env, &creator, &client, "memoevt2", None);
    assert_eq!(topics_for(&env, &client, &id), ["register"]);
}

#[test]
fn memo_hash_survives_every_later_mutation() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_memo(&env, &creator, &client, "memokeep", Some(memo(&env, 4)));
    let new_owner = Address::generate(&env);

    client.set_price(&id, &200i128);
    client.update_metadata(&id, &String::from_str(&env, "ipfs://moved"));
    client.delist(&id);
    client.transfer_ownership(&id, &new_owner);
    assert_eq!(client.get_memo_hash(&id), Some(memo(&env, 4)));

    // Tombstoning keeps the memo readable for audit, like the resource itself.
    client.tombstone_resource(&id, &admin);
    assert_eq!(client.get_memo_hash(&id), Some(memo(&env, 4)));
}

#[test]
fn register_with_memo_rejects_duplicate_ids() {
    let (env, creator, client) = setup();
    let id = register_memo(&env, &creator, &client, "memodup", Some(memo(&env, 5)));

    let again = client.try_register_with_memo(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://memo"),
        &empty_tags(&env),
        &None,
        &Some(memo(&env, 6)),
    );

    assert_eq!(again, Err(Ok(Error::AlreadyRegistered)));
    assert_eq!(
        client.get_memo_hash(&id),
        Some(memo(&env, 5)),
        "the first memo must stand"
    );
}

#[test]
fn register_with_memo_respects_the_pause() {
    let (env, creator, admin, client) = setup_with_admin();
    client.set_paused(&admin, &true);

    let result = client.try_register_with_memo(
        &creator,
        &String::from_str(&env, "memopause"),
        &100i128,
        &String::from_str(&env, "ipfs://memo"),
        &empty_tags(&env),
        &None,
        &Some(memo(&env, 7)),
    );

    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}
