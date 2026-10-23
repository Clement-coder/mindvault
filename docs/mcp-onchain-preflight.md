# On-chain Preflight (`mindvault_onchain_preflight`)

`mindvault_onchain_preflight` is a read-only self-check that answers one
question before you enable the on-chain MCP tools: **is the configured
vault-registry contract ID, network, and schema version coherent?** It is the
right call after changing `STELLAR_NETWORK`, `NETWORK`, or
`VAULT_REGISTRY_CONTRACT_ID`, and before `mindvault_register`,
`mindvault_publish`, or `mindvault_register_onchain`.

All checks are **local and synchronous** — no network calls are made, no wallet
is required, nothing is submitted on-chain, and no funds are at risk. Live
reachability of the deployed contract remains the job of
`mindvault_registry_health` and `mindvault_check_bindings`.

Source: [`mcp/src/onchainPreflight.ts`](../mcp/src/onchainPreflight.ts)

## Arguments

| Argument                 | Type    | Required | Description                                                                                                                                                                       |
| ------------------------ | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestedSchemaVersion` | integer | No       | The on-chain `Resource` schema version the caller intends to use. Omit to report the supported set without a verdict. A non-integer value fails validation before any check runs. |

## What it checks

### `stellar_network`

- **Passes** when `STELLAR_NETWORK` is unset (defaults to `testnet`) or a
  recognized value (`testnet`, `mainnet`, `pubnet`, `public`).
- **Fails** when the raw value is not recognized — resolution silently falls
  back to testnet, which is surprising enough to surface.
- **Remediation:** set `STELLAR_NETWORK` to `testnet` or `mainnet`.

### `x402_network`

- **Passes** when the x402 payment network (`NETWORK`, or the preset default)
  infers the same deployment network as `STELLAR_NETWORK`.
- **Fails** when `NETWORK` is unsupported, or when it points at the other
  network (e.g. `NETWORK=stellar:pubnet` with `STELLAR_NETWORK=testnet`) —
  x402 payments would be signed against the wrong network.
- **Remediation:** set `NETWORK` to `stellar:testnet` or `stellar:pubnet` to
  match `STELLAR_NETWORK`, or unset it to use the preset default.

### `contract_id`

- **Passes** when the resolved contract ID (`VAULT_REGISTRY_CONTRACT_ID`, or
  the network preset default) is present and matches the StrKey format
  (`C` + 55 base32 characters), and came from the environment.
- **Warns** when a well-formed ID came from the testnet **preset default**
  rather than an explicit `VAULT_REGISTRY_CONTRACT_ID` override (the note says
  which source is in use).
- **Fails** when the ID is empty (e.g. mainnet, which has no preset default)
  or malformed.
- **Remediation:** deploy vault-registry and set `VAULT_REGISTRY_CONTRACT_ID`
  to its contract ID (`C` followed by 55 base32 characters).

### `resource_schema_version`

- **Passes** with `requested: null` when no version was requested — the
  supported set is still reported.
- **Passes** when the requested version is in the supported set. The set is
  `[6, 7]`, derived from the contract's `RESOURCE_SCHEMA_VERSION` (7) and
  `PREVIOUS_RESOURCE_SCHEMA_VERSION` (6) in
  [`contract/contracts/vault-registry/src/lib.rs`](../contract/contracts/vault-registry/src/lib.rs);
  `resource_schema_version` accepts a resource stamped with either value.
- **Fails** when the requested version is outside the set (the detail lists
  the supported versions) or is not an integer.
- **Remediation:** use one of the supported versions, or omit
  `requestedSchemaVersion`.

### `mainnet_readiness`

- Only present when the Stellar network is mainnet. **Warn at most** — the
  preflight stays read-only. The detail is the standard mainnet diagnostics
  block (`Network`, `x402`, `Registry`, how mainnet mutations are confirmed);
  the remediation restates that every gated mutation still needs
  `confirmMainnet: true` per call (or `MINDVAULT_ALLOW_MAINNET=1` on the MCP
  server process).

`ready` is `true` when no check has `fail` status; warnings are advisory.

## Reuse in publish/register flows

The publish/register setup flows reuse the same preflight so a locally fatal
misconfiguration fails fast with an actionable message instead of an opaque
Soroban error deep inside the first mutation. `assertOnchainSetupReady(env)`
(from [`mcp/src/onchainPreflight.ts`](../mcp/src/onchainPreflight.ts)) runs the
preflight against the current environment and throws only on the fail-severity
checks that are truly fatal **locally** — a missing/malformed
`VAULT_REGISTRY_CONTRACT_ID` or an unrecognized `STELLAR_NETWORK`. Pass and
warn results are a no-op, and an x402/stellar mismatch stays advisory here
(it mirrors the startup diagnostics' warning severity).

Hook sites in [`mcp/src/tools/publish.ts`](../mcp/src/tools/publish.ts):

- `register()` — before the publisher-registration request.
- `publish()` — after the dry-run early return, so dry runs keep working
  offline with any environment.
- `registerOnchain()` — before the register/prepare request.

## The envelope

```json
{
  "schema": "mindvault.onchain-preflight/v1",
  "ready": true,
  "network": {
    "stellarNetwork": "testnet",
    "x402Network": "stellar:testnet",
    "networkPassphrase": "Test SDF Network ; September 2015"
  },
  "contract": {
    "contractId": "CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4",
    "status": "ok",
    "note": "Using VAULT_REGISTRY_CONTRACT_ID from the environment."
  },
  "schemaVersions": {
    "supported": [6, 7],
    "requested": null,
    "status": "pass"
  },
  "checks": [
    {
      "name": "stellar_network",
      "status": "pass",
      "detail": "STELLAR_NETWORK: testnet (\"testnet\")",
      "remediation": ""
    }
  ],
  "mismatches": [],
  "summary": "On-chain preflight ready (testnet, contract CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4)."
}
```

## Tests

[`mcp/src/onchainPreflight.test.ts`](../mcp/src/onchainPreflight.test.ts)
exercises the pure builder and the handler with crafted inputs — no network, no
process state mutation. It covers the happy path, each failure mode above, the
`assertOnchainSetupReady` throw/no-op behaviour, garbage-input totality, and
validates the tool's JSON envelope against
`ONCHAIN_PREFLIGHT_OUTPUT_SCHEMA` with the same Ajv validator MCP clients use.

Run it with:

```
pnpm --dir mcp vitest run src/onchainPreflight.test.ts
```

## Related

- [Install verification](mcp-verify-install.md) — local install/config checks (`mindvault_verify_install`)
- [Client configs](mcp-client-configs.md) — copy-ready configs for every MCP client
- [Environment variables](mcp-env-variables.md) — every variable the server reads
- [Tool reference](mcp-tool-reference.md) — the full tool list
