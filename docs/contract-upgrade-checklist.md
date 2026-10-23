# Contract Upgrade Checklist — vault-registry WASM

Use this checklist before deploying a new `vault-registry` WASM to any Stellar
network. Work through each phase in order. Do not skip phases for "minor"
changes — the on-chain contract is immutable once deployed.

Legend:

- ⚠️ Irreversible or high-impact action — double-check before proceeding
- 🔒 Involves a secret key — handle with care
- 💥 Breaking change — requires downstream updates before or alongside deploy

---

## Phase 1 — Pre-flight: source checks

- [ ] **All tests pass locally**

  ```bash
  cd contract
  cargo test
  ```

  Zero failures required. If any test fails, stop here.

- [ ] **Snapshot files are current**  
      `cargo test` regenerates `test_snapshots/` automatically when `soroban-sdk`
      testutils detect a mismatch. Commit any changed snapshot files before
      proceeding — a stale snapshot is a sign the test ran against the wrong state.

- [ ] **No unintended public API changes**  
      Review the diff of `contract/contracts/vault-registry/src/lib.rs` for any
      signature changes to exported functions (arguments, return types, error
      variants). Compared against the acceptance criteria:
  - Added or removed methods → update contract `README.md` function table
  - Changed `Resource` struct fields → bump `RESOURCE_SCHEMA_VERSION` and
    update the `README.md` constants table
  - Added, renamed, or removed error codes → update `README.md` error table
  - Added, renamed, or removed event topics → update `EVENT_SCHEMA` in
    `lib.rs` **and** the `README.md` Events table (tests
    `event_schema_matches_documented_readme_table` and
    `full_workflow_emits_exactly_the_documented_events` enforce parity)

- [ ] **`EVENT_SCHEMA` is in sync with `README.md`**  
      These two tests must pass after any event change:
  - `event_schema_matches_documented_readme_table`
  - `full_workflow_emits_exactly_the_documented_events`

- [ ] **Error handling is deterministic**  
      Every new error path must map to an explicit `Error` variant (not a panic or
      an opaque `Err`). Verify the error code table in `README.md` covers every
      variant returned by the modified functions.

---

## Phase 2 — Build

- [ ] **Optimized WASM builds cleanly**

  ```bash
  cd contract
  stellar contract build --manifest-path Cargo.toml --optimize
  ```

- [ ] **WASM size is within budget (36,864 bytes)**

  ```bash
  SIZE=$(stat -c%s target/wasm32v1-none/release/vault_registry.wasm)
  echo "WASM size: $SIZE bytes (budget: 36864)"
  ```

  If `$SIZE > 36864`, either optimize the contract or raise `MAX_SIZE` in
  `.github/workflows/contract-ci.yml` and document the growth reason in this
  PR's description.

- [ ] **Optimized and unoptimized hashes recorded**

  ```bash
  stellar contract wasm hash \
    --wasm target/wasm32v1-none/release/vault_registry.wasm
  ```

  Save the hash now — you'll need it to verify on-chain upload after deploy.

- [ ] **`no_std` check passes**
  ```bash
  cargo build --release \
    --target wasm32-unknown-unknown \
    --no-default-features
  ```

---

## Phase 3 — Network and identity checks

- [ ] **Target network confirmed**  
      Decide which network this WASM targets. Set `NETWORK` for the commands below:

  ```bash
  # testnet
  NETWORK=testnet
  SOROBAN_RPC=https://soroban-testnet.stellar.org

  # mainnet ⚠️
  NETWORK=mainnet
  SOROBAN_RPC=https://soroban.stellar.org
  ```

- [ ] **Deployer identity exists and is funded**

  ```bash
  stellar keys show deployer
  # Verify it has enough XLM for fees (at least 0.1 XLM on testnet;
  # 1+ XLM recommended buffer on mainnet ⚠️)
  stellar account show --network $NETWORK --account $(stellar keys address deployer)
  ```

  On testnet, fund via Friendbot if needed. On mainnet, transfer from an
  exchange. 🔒

- [ ] **Existing contract ID noted**  
      Record the current `VAULT_REGISTRY_CONTRACT_ID` from `server/.env` (or
      `server/.env.example`). This is the contract the server and MCP currently
      point to — needed for the rollback plan and for binding verification.

- [ ] **Soroban RPC is reachable**
  ```bash
  curl -s $SOROBAN_RPC/health | jq .
  # Expected: {"status":"healthy", ...}
  ```

---

## Phase 4 — Deploy ⚠️

> **On-chain deployments are permanent.** A deployed WASM cannot be removed or
> patched in place. Each deploy creates a new contract at a new ID. The server
> and all clients must be updated to point to the new ID after deploy.

- [ ] **Upload and deploy the WASM** ⚠️

  ```bash
  cd contract
  NEW_CONTRACT_ID=$(stellar contract deploy \
    --wasm target/wasm32v1-none/release/vault_registry.wasm \
    --source deployer \
    --network $NETWORK)
  echo "New contract ID: $NEW_CONTRACT_ID"
  ```

- [ ] **Verify on-chain WASM hash matches local build**

  ```bash
  # Hash of the deployed WASM (from the chain)
  stellar contract info --network $NETWORK \
    --contract-id $NEW_CONTRACT_ID | jq .wasm_hash
  # Must equal the hash recorded in Phase 2
  ```

- [ ] **`registry_info()` returns expected fields**

  ```bash
  stellar contract invoke \
    --network $NETWORK \
    --id $NEW_CONTRACT_ID \
    -- registry_info
  # Expected: name="mindvault-vault-registry",
  #           version=<new cargo version>,
  #           resource_schema_version=<current RESOURCE_SCHEMA_VERSION>,
  #           network_id=<correct network>
  ```

  The `network_id` field is derived from `env.ledger().network_id()` and will
  differ between testnet and mainnet — confirm it matches the target network.

- [ ] **`contract_version()` returns the expected crate version**

  ```bash
  stellar contract invoke \
    --network $NETWORK \
    --id $NEW_CONTRACT_ID \
    -- contract_version
  # Must match the version in contract/contracts/vault-registry/Cargo.toml
  ```

- [ ] **Deployment details recorded**  
      Update `contract/README.md`'s "Testnet Deployment" (or Mainnet) table with:
  - Contract ID
  - WASM Hash
  - Deployer Address
  - Deployment Date
  - Network

---

## Phase 5 — Client bindings regeneration 💥

Every change to the exported function signatures requires fresh bindings. Even
no-op deploys (same WASM, new contract ID) require this step to align the
embedded contract ID in the generated client.

- [ ] **Regenerate TypeScript bindings from the new WASM**

  ```bash
  # Preferred: generate from local WASM (no network call)
  CONTRACT_WASM=contract/target/wasm32v1-none/release/vault_registry.wasm \
    pnpm contract:bindings

  # Alternative: generate from the newly deployed contract ID
  VAULT_REGISTRY_CONTRACT_ID=$NEW_CONTRACT_ID \
  STELLAR_NETWORK=$NETWORK \
    pnpm contract:bindings
  ```

  This writes `packages/registry-client/src/generated/index.ts` and
  auto-formats it with Prettier. Commit the updated file.

- [ ] **Binding check passes against the deployed contract**

  ```bash
  # From within an MCP session, or via the registry-client package test:
  pnpm --filter @mindvault/registry-client test
  ```

  The `bindingCheck.test.ts` suite compares the installed binding method set
  against the contract spec. A mismatch means the regeneration step above was
  skipped or targeted the wrong WASM.

- [ ] **`VAULT_REGISTRY_CONTRACT_ID` updated everywhere**  
      Search for the old contract ID and replace with `$NEW_CONTRACT_ID`:
  - `server/.env` (and any staging/production secrets)
  - `mcp/.env` (and MCP client configs in `docs/mcp-client-configs.md`)
  - `contract/README.md` deployment table (done in Phase 4)
  - `scripts/generate-bindings.mjs` default `CONTRACT_ID` constant
  - Any hardcoded references in test fixtures or seed scripts

---

## Phase 6 — Server and MCP verification

- [ ] **Server starts without errors against the new contract ID**

  ```bash
  VAULT_REGISTRY_CONTRACT_ID=$NEW_CONTRACT_ID pnpm --filter @mindvault/server dev
  # Check stderr for any registry client initialisation errors
  ```

- [ ] **Health probe is green**

  ```bash
  curl -s http://localhost:4021/health/ready | jq .
  # Expected: {"status":"ok", dependencies: {...}}
  ```

- [ ] **A read-only registry call succeeds**

  ```bash
  curl -s http://localhost:4021/registry | jq .
  # Expected: contract ID, name, version matching the deployed contract
  ```

- [ ] **MCP binding check tool reports a match**  
      In an MCP session connected to the updated server:

  ```
  mindvault_registry_info
  # Check: bindingCheck.status === "match"
  ```

- [ ] **MCP deployment verification reports a match**
      Compare the live deployment with the expected manifest. The built-in
      manifest covers the canonical testnet deployment; for a new contract,
      pass a `manifest` with the new contract ID, WASM hash, crate version, and
      resource schema version.

  ```
  mindvault_verify_deployment
  # Check: status === "match", mismatches === [], errors === []
  # Never signs or submits a transaction.
  ```

  See [MCP deployment verification](./mcp-deployment-verification.md).

- [ ] **End-to-end smoke test passes** (testnet only)

  ```bash
  pnpm --filter @mindvault/mcp smoke
  # Expected: all tool calls succeed, exits 0
  ```

- [ ] **Reconciliation reports no drift** (after seeding any data)
  ```bash
  pnpm --filter @mindvault/server reconcile
  # Expected: "Result: ALL CLEAR"
  ```

---

## Phase 7 — Admin role bootstrap (new contract only)

If this is a **new contract deployment** (not upgrading the WASM of an existing
contract), the admin role must be bootstrapped before the server can call
`set_verification_status` or manage verifier access.

- [ ] **Bootstrap admin**

  ```bash
  stellar contract invoke \
    --network $NETWORK \
    --id $NEW_CONTRACT_ID \
    --source deployer \
    -- nominate_new_admin \
    --new_admin <PLATFORM_WALLET_ADDRESS>
  ```

  Because no admin is set yet, the first call bootstraps `new_admin` directly
  (no accept step required). Verify:

  ```bash
  stellar contract invoke \
    --network $NETWORK \
    --id $NEW_CONTRACT_ID \
    -- admin
  # Expected: <PLATFORM_WALLET_ADDRESS>
  ```

- [ ] **Add the verifier address**
  ```bash
  stellar contract invoke \
    --network $NETWORK \
    --id $NEW_CONTRACT_ID \
    --source <ADMIN_KEY> \
    -- add_verifier \
    --verifier <PLATFORM_WALLET_ADDRESS>
  ```
  Verify:
  ```bash
  stellar contract invoke \
    --network $NETWORK \
    --id $NEW_CONTRACT_ID \
    -- is_verifier \
    --address <PLATFORM_WALLET_ADDRESS>
  # Expected: true
  ```

---

## Phase 8 — Post-deploy

- [ ] **CI passes on the updated branch / PR**  
      Push the changes (updated bindings, `README.md`, env defaults). The
      `Contract CI` workflow must pass — it enforces WASM size budget, runs
      `cargo test`, and the `no_std` check. The `PR` workflow enforces binding
      freshness via `pnpm contract:bindings` diff.

- [ ] **Rollback plan documented**  
      If the new deployment has a critical bug, the rollback is: set
      `VAULT_REGISTRY_CONTRACT_ID` back to the previous contract ID and redeploy
      the server. The old contract remains live on-chain. Any resources registered
      against the new contract ID will not appear in the rolled-back state — note
      this in the deployment PR description if there is any risk of data written to
      the new contract before rollback.

- [ ] **Deployment PR description includes**
  - Old contract ID
  - New contract ID
  - WASM hash (old and new)
  - WASM size delta (old → new bytes)
  - Any `RESOURCE_SCHEMA_VERSION` bump and its rationale
  - Any breaking API changes and affected clients
  - WASM size budget update (if `MAX_SIZE` was raised), with justification

---

## Quick-reference commands

```bash
# 1. Test
cd contract && cargo test

# 2. Build (optimized)
stellar contract build --manifest-path Cargo.toml --optimize

# 3. Check WASM size
stat -c%s target/wasm32v1-none/release/vault_registry.wasm

# 4. Deploy
stellar contract deploy \
  --wasm target/wasm32v1-none/release/vault_registry.wasm \
  --source deployer \
  --network $NETWORK

# 5. Regenerate bindings
CONTRACT_WASM=contract/target/wasm32v1-none/release/vault_registry.wasm \
  pnpm contract:bindings

# 6. Run server tests
pnpm --filter @mindvault/server test

# 7. Reconcile
pnpm --filter @mindvault/server reconcile
```

---

## Related docs

- [Deployment Runbook](./deployment-runbook.md) — full stack deploy (contract + server + frontend + MCP)
- [Mainnet Deployment Checklist](./mainnet-deployment-checklist.md) — additional mainnet-specific steps
- [Registry Client Bindings](./registry-client-bindings.md) — how bindings are generated and kept fresh
- [Index Repair](./index-repair.md) — `repair_index` admin operation
- [Reconciliation](./reconciliation.md) — drift detection between DB and on-chain registry
- [Contract Registry Pause Decision](./contract-registry-pause-decision.md) — pause/unpause ADR
- [`contract/README.md`](../contract/README.md) — contract API reference, error codes, events table
