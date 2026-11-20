# Registry/API Divergence Incident Runbook

Use this runbook when MindVault's Postgres/API view of a resource disagrees with
the Stellar `vault-registry`, or when registry deployment configuration may
point at the wrong network or contract. The API database drives the public
catalog and paywall; the contract is the public on-chain record. A reconciliation
finding alone does not establish which value should win.

This runbook is read-only until the recovery steps. Preserve evidence and agree
on the authoritative value before changing either system. The
[`pnpm reconcile`](reconciliation.md) command is read-only; it reports selected
fields and does not repair state.

## 1. Declare and scope the incident

Record the detection time in UTC, environment, Stellar network, configured
registry contract ID, affected resource IDs, first known bad time, and the
alert or user report. Assign an incident lead and a registry/API operator.

If incorrect prices, ownership, listing state, or registrations are actively
causing harm, use the deployment's approved control to stop the affected writes
while investigating. The contract's admin pause methods stop guarded
on-chain mutations; they do not stop API database writes or change existing
catalog rows. Treat a pause as a separate, broad operational action: confirm
admin authority, the expected impact, and an unpause owner before using it.
There is no read-only reconciliation command that pauses traffic.

Do not retry registration, price changes, ownership transfer, or database
updates just to make the report green. First capture the current state and the
transaction history.

## 2. Verify the target and collect evidence

Check the server's health and confirm the intended network, RPC URL, and
contract ID from the deployment configuration. In an MCP session, run these
read-only tools:

```text
mindvault_onchain_preflight
mindvault_verify_deployment
mindvault_registry_info
```

`mindvault_verify_deployment` compares the configured deployment with its
expected manifest, including network, contract ID, network ID, contract version,
resource schema version, and deployed WASM hash. A `mismatch` or `unreachable`
result must be resolved before interpreting resource-level drift. See the
[deployment verification reference](mcp-deployment-verification.md) and
[on-chain preflight](mcp-onchain-preflight.md).

Capture a reconciliation report with restrictive local file permissions. Run
from the repository root:

```bash
umask 077
set +e
pnpm --filter @mindvault/server reconcile 2>&1 | tee /tmp/mindvault-reconcile.txt
status=${PIPESTATUS[0]}
set -e
if [ "$status" -gt 1 ]; then
  echo "Reconciliation failed to run (exit $status); check configuration and RPC/DB reachability."
fi
```

Exit status `0` means no discrepancies detected by this script, `1` means one
or more findings, and `2` means the check could not complete. Keep the report
with the incident record; it contains resource IDs and wallet addresses. Never
attach `.env` files, secret keys, service credentials, or unredacted database
exports to an issue.

The reconciliation script checks prices and owner wallet addresses for DB rows
marked `onchain_status = "registered"`, reports when the chain `count()` is
higher than that DB row count, and detects listed DB rows whose on-chain status
is not `registered`. It does not report a count-only case where the DB count is
higher than the chain count, compare every metadata field, enumerate all
contract resources, or repair either side. `Result: ALL CLEAR` therefore means
these checks found no drift; it is not a proof that every API and contract
field is identical. See [Reconciliation](reconciliation.md) for prerequisites
and output definitions.

## 3. Classify the finding

| Finding | What it establishes | Next investigation |
| --- | --- | --- |
| `mismatches` | DB price differs from `get(id)` on chain | Inspect the publisher's latest price change request, signed transaction hash, and event/result. Determine which value was authorized. |
| `ownerMismatches` | DB `walletAddress` differs from the on-chain creator | Check transfer preparation/submission, confirmation, and the DB update result. Confirm with the current publisher before changing ownership data. |
| `missingOnChain` | A registered DB row has no contract entry at that ID | Check the registration transaction and DB `onchainStatus` history. Do not submit another registration until confirming the first did not land. |
| `listingDrift` | A DB row is public (`listed = true`) although its `onchainStatus` is not `registered` | Confirm the resource is safe and eligible to be public; inspect registration and listing history before correcting visibility or status. |
| `missingInDb` | Chain `count()` exceeds registered DB rows by a number | This is a count delta only. Soroban contracts cannot enumerate storage keys; it does not identify orphan IDs and may also indicate a derived index problem. |
| Deployment verification mismatch/unreachable | Configured network/contract/WASM/schema differs from expectation or cannot be read | Check deployment manifest, environment variables, RPC network passphrase, and deployment history before resource-level repair. |

Concrete example: if the report contains

```json
{
  "resourceId": "resource-123",
  "dbPrice": "0.50",
  "chainPrice": "0.25",
  "publisherWallet": "G..."
}
```

first inspect the confirmed `set_price` transaction and the publisher's intended
price. If the on-chain `0.25` is the authorized change and the DB update failed,
repair the DB record through the normal operational data-change process. If
`0.50` is still intended, have the authorized publisher submit the creator-signed
price update, then rerun reconciliation. Do not infer intent from which system
has the newer timestamp alone.

## 4. Recover the affected state

Choose one recovery path per finding, record the approver and transaction or
change reference, and make the smallest correction:

- **Price or owner:** use the normal creator-authorized API flow where the
  on-chain value should change. For a DB correction, use the controlled data
  change process and verify the corresponding chain transaction before editing.
  The creator-signed flow is documented in
  [Creator Signed Registration Flow](creator-signed-registration-flow.md).
- **Missing on-chain:** only retry registration after confirming the original
  transaction did not succeed and the resource row is valid. Use the
  registration prepare/submit routes documented in the same flow; retain the
  new transaction hash.
- **Listing drift:** correct eligibility and public visibility using the
  existing resource lifecycle and listing flows. Do not set a row to
  `registered` by hand to hide the finding; the status represents a successful
  on-chain registration. See the
  [resource publish lifecycle](resource-publish-lifecycle.md).
- **Missing in DB / index count concern:** identify IDs from archived
  registration events, transaction receipts, an indexer, or a last-known-good
  snapshot. Reconcile that evidence against the DB before creating any row.
  The contract has no enumeration method, so do not invent IDs from the count.
- **Registry index drift:** `repair_index(ids)` rewrites the registry's
  insertion-order index and count. It is admin-only and requires the complete,
  correctly ordered list of existing IDs; an omitted ID becomes unreachable
  through list/count pagination. The repository does not provide an automatic
  repair command. Follow the cautions in the
  [owner index repair decision](index-repair.md) and have the contract operator
  review and simulate the full transaction before submission.
- **Wrong deployment target:** correct the deployment configuration only
  through the deployment process. Do not point production at a different
  contract to make verification pass. Use the
  [contract upgrade checklist](contract-upgrade-checklist.md) for WASM or
  schema changes.

If the evidence does not identify a safe authoritative value, leave both sides
unchanged, keep the incident open, and escalate to the registry and database
owners.

## 5. Verify recovery and close

1. Re-run `mindvault_onchain_preflight` and
   `mindvault_verify_deployment` after configuration or deployment changes.
2. Run `pnpm --filter @mindvault/server reconcile` and confirm the relevant
   findings are gone. For a count-only orphan report, attach the independent
   event/indexer evidence; the reconcile tool cannot prove orphan IDs are
   repaired.
3. Check the public API (`GET /resources` and the affected
   `GET /resources/:id/meta`) and use `mindvault_registry_lookup` to read the
   affected contract resource. Confirm price, owner, registration, and listing
   state agree with the intended outcome.
4. If a registry pause or traffic control was used, have the named owner remove
   it only after write paths and monitoring are ready. Confirm reads and writes
   behave as expected.
5. Record the root cause, scope, timeline, transaction hashes, approved data
   changes, validation results, and follow-up work. Redact credentials and
   private keys from the incident record.

## Related references

- [Reconciliation command and output](reconciliation.md)
- [Registry deployment verification](mcp-deployment-verification.md)
- [On-chain preflight](mcp-onchain-preflight.md)
- [Owner index repair decision and limitations](index-repair.md)
- [Creator signed registration flow](creator-signed-registration-flow.md)
- [Resource publish lifecycle](resource-publish-lifecycle.md)
- [Contract upgrade checklist](contract-upgrade-checklist.md)
- [API examples](api-examples.md)
