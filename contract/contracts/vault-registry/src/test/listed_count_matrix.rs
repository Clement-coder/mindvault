// ─── Listed-count transition matrix (#973) ───────────────────────────────────
//
// `creator_listed_count(creator)` and `listed_count()` are cached counters.
// A cached counter is only trustworthy if every operation that changes a
// resource's *effective listing eligibility* keeps it in step with the
// resources themselves.
//
// This module builds the truth from the resources — a full catalog scan, not
// the capped `list_by_creator` page — and compares it against the stored
// counters after every operation in the matrix, including the operations that
// are *rejected* (a rejected transition must leave every counter untouched).

/// A resource in the catalog, as seen by a full scan.
struct Scanned {
    creator: Address,
    state: ResourceState,
}

/// Read every registered resource in the registry.
///
/// The global `Index`/`Count` pair is never pruned (tombstoning leaves the
/// entry in place for audit), so walking the `list_page` cursor until it
/// reports end-of-list visits every resource that was ever registered. The
/// cursor is followed rather than recomputed, so a page that comes back short
/// cannot silently skip entries.
fn full_catalog_scan(client: &VaultRegistryClient<'_>) -> alloc::vec::Vec<Scanned> {
    let mut out = alloc::vec::Vec::new();
    let mut cursor = 0u32;
    loop {
        let page = client.list_page(&cursor, &LIST_PAGE_CAP);
        for i in 0..page.items.len() {
            let r = page.items.get(i).unwrap();
            out.push(Scanned {
                creator: r.creator.clone(),
                state: r.state,
            });
        }
        match page.next_cursor {
            Some(next) => cursor = next,
            None => break,
        }
    }
    out
}

/// How many scanned resources are `Listed`, globally and per creator.
fn expected_listed(scan: &[Scanned], creator: Option<&Address>) -> (u32, u32) {
    let mut global = 0u32;
    let mut for_creator = 0u32;
    for entry in scan {
        if entry.state != ResourceState::Listed {
            continue;
        }
        global += 1;
        if let Some(c) = creator {
            if entry.creator == *c {
                for_creator += 1;
            }
        }
    }
    (global, for_creator)
}

/// How many scanned resources a creator still owns.
///
/// Tombstoned resources are dropped from the creator index, so they are not
/// part of `creator_resource_count` even though they stay in the global
/// catalog for audit.
fn expected_creator_total(scan: &[Scanned], creator: &Address) -> u32 {
    let mut n = 0u32;
    for entry in scan {
        if entry.creator == *creator && entry.state != ResourceState::Tombstoned {
            n += 1;
        }
    }
    n
}

/// Assert that every stored counter agrees with a full catalog scan.
fn assert_counters_match_catalog(
    client: &VaultRegistryClient<'_>,
    creator: &Address,
    label: &str,
) {
    let scan = full_catalog_scan(client);
    let (global_listed, creator_listed) = expected_listed(&scan, Some(creator));
    assert_eq!(
        client.listed_count(),
        global_listed,
        "global listed_count drifted after `{label}`"
    );
    assert_eq!(
        client.creator_listed_count(creator),
        creator_listed,
        "creator_listed_count drifted after `{label}`"
    );
    assert_eq!(
        client.creator_resource_count(creator),
        expected_creator_total(&scan, creator),
        "creator_resource_count drifted after `{label}`"
    );
}

// ── The matrix ──────────────────────────────────────────────────────────────

/// Every operation that can change a resource's effective listing
/// eligibility. Ownership moves are included because they move the listed
/// count between two creators without changing the global count.
#[derive(Copy, Clone, Debug)]
enum MatrixOp {
    Relist,
    Delist,
    Freeze,
    Reactivate,
    OpenDispute,
    ResolveListed,
    ResolveDelisted,
    ResolveFrozen,
    EmergencyDelist,
    Tombstone,
    TransferOwnership,
    ProposeAndAcceptTransfer,
}

const MATRIX_OPS: [MatrixOp; 12] = [
    MatrixOp::Relist,
    MatrixOp::Delist,
    MatrixOp::Freeze,
    MatrixOp::Reactivate,
    MatrixOp::OpenDispute,
    MatrixOp::ResolveListed,
    MatrixOp::ResolveDelisted,
    MatrixOp::ResolveFrozen,
    MatrixOp::EmergencyDelist,
    MatrixOp::Tombstone,
    MatrixOp::TransferOwnership,
    MatrixOp::ProposeAndAcceptTransfer,
];

/// The states a resource can be in when the matrix starts.
const MATRIX_STATES: [ResourceState; 5] = [
    ResourceState::Listed,
    ResourceState::Delisted,
    ResourceState::Frozen,
    ResourceState::Disputed,
    ResourceState::Tombstoned,
];

/// Flatten the `try_*` result into a plain `Result`.
///
/// `try_*` returns `Ok(Ok(v))` on success, `Err(Ok(Error))` when the contract
/// returns an error, `Ok(Err(ConversionError))` when the arguments could not
/// be converted, and `Err(Err(InvokeError))` when the host rejected the call.
fn flatten<T>(
    res: Result<
        Result<T, soroban_sdk::ConversionError>,
        Result<Error, soroban_sdk::InvokeError>,
    >,
) -> Result<T, Error> {
    match res {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => panic!("argument conversion failed unexpectedly: {e:?}"),
        Err(Ok(e)) => Err(e),
        Err(Err(e)) => panic!("contract invocation failed unexpectedly: {e:?}"),
    }
}

/// Apply one matrix operation. Returns the contract's error when the
/// operation is refused.
fn apply_matrix_op(
    env: &Env,
    client: &VaultRegistryClient<'_>,
    id: &String,
    admin: &Address,
    op: MatrixOp,
) -> Result<(), Error> {
    match op {
        MatrixOp::Relist => flatten(client.try_set_listed(id, &true)),
        MatrixOp::Delist => flatten(client.try_set_listed(id, &false)),
        MatrixOp::Freeze => flatten(client.try_freeze_resource(id)),
        MatrixOp::Reactivate => flatten(client.try_reactivate_resource(id)),
        MatrixOp::OpenDispute => flatten(client.try_open_dispute(id, admin)),
        MatrixOp::ResolveListed => {
            flatten(client.try_resolve_dispute(id, admin, &ResourceState::Listed))
        }
        MatrixOp::ResolveDelisted => {
            flatten(client.try_resolve_dispute(id, admin, &ResourceState::Delisted))
        }
        MatrixOp::ResolveFrozen => {
            flatten(client.try_resolve_dispute(id, admin, &ResourceState::Frozen))
        }
        MatrixOp::EmergencyDelist => flatten(client.try_emergency_delist(
            id,
            admin,
            &String::from_str(env, "matrix"),
        )),
        MatrixOp::Tombstone => flatten(client.try_tombstone_resource(id, admin)),
        MatrixOp::TransferOwnership => {
            let new_owner = Address::generate(env);
            flatten(client.try_transfer_ownership(id, &new_owner))
        }
        MatrixOp::ProposeAndAcceptTransfer => {
            let new_owner = Address::generate(env);
            flatten(client.try_propose_transfer(id, &new_owner))?;
            flatten(client.try_accept_transfer(id))
        }
    }
    .map(|_| ())
}

/// Drive a freshly registered resource into `state`.
fn drive_to_state(
    client: &VaultRegistryClient<'_>,
    id: &String,
    admin: &Address,
    state: ResourceState,
) {
    match state {
        ResourceState::Listed => {}
        ResourceState::Delisted => {
            client.delist(id);
        }
        ResourceState::Frozen => {
            client.freeze_resource(id);
        }
        ResourceState::Disputed => {
            client.open_dispute(id, admin);
        }
        ResourceState::Tombstoned => {
            client.tombstone_resource(id, admin);
        }
    }
}

#[test]
fn listed_count_matrix_matches_catalog_after_every_transition() {
    for start_state in MATRIX_STATES {
        for op in MATRIX_OPS {
            let (env, creator, admin, client) = setup_with_admin();
            let id = register_default(&env, &creator, &client, "matrixres");
            drive_to_state(&client, &id, &admin, start_state);
            assert_counters_match_catalog(&client, &creator, "setup");

            let state_before = client.get(&id).state;
            let outcome = apply_matrix_op(&env, &client, &id, &admin, op);

            // A refused operation must leave the resource exactly as it was.
            if outcome.is_err() {
                assert_eq!(
                    client.get(&id).state,
                    state_before,
                    "a refused {op:?} must not change the state ({start_state:?} start)"
                );
            }

            assert_counters_match_catalog(
                &client,
                &creator,
                &alloc::format!("{op:?} from {start_state:?}"),
            );
        }
    }
}

#[test]
fn listed_count_matrix_holds_for_a_creator_with_many_resources() {
    let (env, creator, admin, client) = setup_with_admin();
    let mut ids = alloc::vec::Vec::new();
    for i in 0..25u32 {
        let raw = alloc::format!("matrixbulk{i:02}");
        let id = register_default(&env, &creator, &client, &raw);
        ids.push(id);
    }
    assert_counters_match_catalog(&client, &creator, "bulk register");

    // Spread the catalog across every lifecycle state.
    client.delist(&ids[0]);
    client.freeze_resource(&ids[1]);
    client.open_dispute(&ids[2], &admin);
    client.tombstone_resource(&ids[3], &admin);
    assert_counters_match_catalog(&client, &creator, "mixed states");

    for op in MATRIX_OPS {
        let target = &ids[4];
        let state_before = client.get(target).state;
        let _ = apply_matrix_op(&env, &client, target, &admin, op);
        if client.get(target).state == state_before {
            // Unchanged state can still mean a successful no-op; either way the
            // counters must still agree with the catalog.
        }
        assert_counters_match_catalog(&client, &creator, &alloc::format!("bulk {op:?}"));
    }
}

#[test]
fn paused_registry_rejects_every_transition_without_moving_counters() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "pausematrix");
    assert_counters_match_catalog(&client, &creator, "before pause");

    client.set_paused(&admin, &true);

    for op in MATRIX_OPS {
        let outcome = apply_matrix_op(&env, &client, &id, &admin, op);
        assert_eq!(
            outcome,
            Err(Error::ContractPaused),
            "{op:?} must be refused while the registry is paused"
        );
        assert_counters_match_catalog(&client, &creator, &alloc::format!("paused {op:?}"));
    }

    client.set_paused(&admin, &false);
    assert_counters_match_catalog(&client, &creator, "after resume");
}
