# Registry Deployment Verification (`mindvault_verify_deployment`)

`mindvault_verify_deployment` produces a read-only report comparing the
deployment this MCP server is configured to use against an expected deployment
manifest. It answers the question an operator should ask after every deploy,
upgrade, or network switch: **is this the contract, version, schema, and WASM
we think we are talking to?**

The tool is **read-only**. It reads from Soroban RPC (`getNetwork`,
`getContractWasmByContractId`) and simulates two contract calls
(`registry_info()` and `contract_version()`). It never signs a transaction,
never submits one, and needs no wallet.

Source: [`mcp/src/deploymentVerification.ts`](../mcp/src/deploymentVerification.ts)

## What is compared

| Field                     | Expected from manifest           | Observed from                                  |
| ------------------------- | -------------------------------- | ---------------------------------------------- |
| `network`                 | `manifest.network`               | Resolved `STELLAR_NETWORK`                     |
| `contract_id`             | `manifest.contractId`            | Resolved `VAULT_REGISTRY_CONTRACT_ID` / preset |
| `rpc_network`             | Manifest network preset          | Soroban RPC `getNetwork().passphrase`          |
| `network_id`              | SHA-256 of passphrase            | `registry_info().network_id`                   |
| `contract_version`        | `manifest.crateVersion`          | `contract_version().crate_version`             |
| `resource_schema_version` | `manifest.resourceSchemaVersion` | `contract_version().resource_schema_version`   |
| `wasm_hash`               | `manifest.wasmHash`              | SHA-256 of the deployed WASM returned by RPC   |

Every difference is reported as a machine-readable entry in `mismatches` with
the field name, expected value, actual value, a detail string, and a
remediation. A read failure (unreachable RPC, wrong contract ID, missing WASM)
is reported in `errors` with the overall `status: "unreachable"`; it is never
reported as a match.

## Arguments

| Argument   | Type   | Required | Description                                                                                                                                            |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest` | object | no       | Expected deployment manifest. Omit to use the built-in canonical testnet manifest. Required for a custom testnet deployment or any mainnet deployment. |

### Manifest shape

```json
{
  "schema": "mindvault.deployment-manifest/v1",
  "network": "testnet",
  "contractId": "CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4",
  "wasmHash": "fa60c0c2086fddf6add8abc7e1b191e1368ed62983f4e967069fc4b4d679c8eb",
  "crateVersion": "0.0.0",
  "resourceSchemaVersion": 7
}
```

- `schema` is optional; when present it must be
  `mindvault.deployment-manifest/v1`.
- `network` must be `testnet` or `mainnet` (aliases such as `pubnet` are
  canonicalized).
- `contractId` must look like a Stellar contract ID (`C` + 55 base32 chars).
- `wasmHash` must be 64 hex characters; case is normalized.
- `crateVersion` is the contract's `CARGO_PKG_VERSION` at build time.
- `resourceSchemaVersion` is the contract's `RESOURCE_SCHEMA_VERSION`.
- Unknown fields are rejected so a typo cannot silently skip a comparison.

The canonical testnet manifest is also exported as
`DEFAULT_DEPLOYMENT_MANIFESTS.testnet`; mainnet has no built-in manifest.

## Output

The result is pretty-printed JSON with `structuredContent` validated against
`DEPLOYMENT_VERIFICATION_OUTPUT_SCHEMA`. The stable top-level fields are:

```json
{
  "schema": "mindvault.deployment-verification/v1",
  "ok": false,
  "status": "mismatch",
  "readOnly": true,
  "signing": "none",
  "mode": "live",
  "configured": {
    "network": "testnet",
    "contractId": "C…",
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "networkPassphrase": "Test SDF Network ; September 2015"
  },
  "expected": { "…": "manifest" },
  "observed": { "…": "on-chain values" },
  "checks": [
    {
      "field": "wasm_hash",
      "status": "mismatch",
      "expected": "fa60…",
      "actual": "abab…",
      "detail": "Expected WASM hash fa60…, found deployed WASM hash abab….",
      "remediation": "The deployed code differs from the manifest. …"
    }
  ],
  "mismatches": [{ "field": "wasm_hash", "expected": "fa60…", "actual": "abab…", "…": "…" }],
  "errors": [],
  "summary": "Deployment verification found 1 mismatch(es)…"
}
```

`status` is one of:

- `match` — every value agrees and every on-chain read succeeded.
- `mismatch` — at least one compared value differs.
- `unreachable` — the configured deployment could not be read.
- `invalid_manifest` — the supplied or default manifest is missing or malformed.

`ok` is true only for `match`. `readOnly` is always `true` and `signing` is
always `"none"` so an agent can branch on the safety contract without parsing
the summary. In `MINDVAULT_MOCK=1` mode the report is built from the expected
manifest and `mode` is `"mock"`; no RPC call is made.

## Typical workflow

```text
mindvault_onchain_preflight      # local configuration coherence, no RPC
mindvault_verify_deployment      # live deployment vs expected manifest
mindvault_check_bindings         # deployed method set vs installed bindings
```

Run `mindvault_verify_deployment` after:

- deploying or upgrading `vault-registry`,
- changing `STELLAR_NETWORK`, `VAULT_REGISTRY_CONTRACT_ID`, or
  `SOROBAN_RPC_URL`,
- regenerating bindings or publishing a new MCP server release.

For the canonical testnet deployment, the default manifest matches the
Testnet Deployment table in [`contract/README.md`](../contract/README.md).

## Tests

```bash
pnpm --dir mcp vitest run src/deploymentVerification.test.ts
```

The tests cover a clean match, each individual mismatch, unreachable RPC,
invalid manifests, the default-manifest path, mock mode, and validation
against the advertised output schema.

## Related

- [On-chain preflight](mcp-onchain-preflight.md) — local configuration checks (`mindvault_onchain_preflight`)
- [Contract upgrade checklist](contract-upgrade-checklist.md) — deploy-time verification steps
- [MCP tool reference](mcp-tool-reference.md) — the full tool list
- [Structured output](mcp-structured-output.md) — `outputSchema` contract
