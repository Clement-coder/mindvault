# Debug Bundle Export (`mindvault_debug_bundle`)

`mindvault_debug_bundle` produces one document an agent or operator can attach
to a bug report or support ticket without first scrubbing it by hand. It
gathers what a maintainer asks for first (resolved configuration, startup
diagnostics, install checks, profiles, state-file mode, metrics, catalog cache
status, the tail of the audit log) and applies the sanitisation rules below
before anything is returned.

Source: [`mcp/src/debugBundle.ts`](../mcp/src/debugBundle.ts).

The tool is local and read-only: no network calls, no wallet required, no
state changes. It is the natural next call after
[`mindvault_verify_install`](mcp-verify-install.md) reports a problem you
cannot explain from the summary alone.

## Arguments

| Argument             | Type    | Meaning                                                                                          |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `auditLogLines`      | integer | Entries to include from the end of `MINDVAULT_AUDIT_LOG_FILE` (0 to 500, default 50); 0 omits it |
| `includeEnvironment` | boolean | Include the MindVault-related environment variables (masked). Default `true`                     |

## What is removed, and what is kept

Sanitisation is by construction, not by pattern matching alone:

- Wallet secret keys and publisher API keys are never read into the bundle.
  Profiles are reported as `name`, `active`, `hasWallet`, `publicKey`,
  `hasApiKey`.
- Only environment variables the server reads are listed: the `MINDVAULT_`,
  `STELLAR_`, `SOROBAN_`, `HORIZON_` and `VAULT_REGISTRY_` prefixes plus
  `NETWORK`, `SPONSORED_ACCOUNT_URL`, `USDC_CONTRACT_ID` and `NODE_ENV`. An
  unrelated credential in the parent shell is not reported even in masked form.
- Within that set, a variable whose name contains `SECRET`, `KEY`, `TOKEN`,
  `PASS`, `PRIVATE`, `CREDENTIAL` or `SIGNING` is reported as `[REDACTED]`, and
  its name is listed under `sanitized.maskedEnvironment` so the reader knows it
  was set.
- Audit-log entries are the already-redacted lines the server wrote. Only the
  last 256 KiB of the file is read, and each line passes through the
  secret-key redactor again before parsing.
- As a final pass, anything shaped like a Stellar secret key (`S` followed by
  55 base32 characters) is replaced wherever it appears in the serialised
  document.

Public keys and contract ids are kept on purpose. A bundle that hides
`GDNK…` and `CDQK…` cannot show that the wallet is on one network and the
registry on another, which is the most common thing a bundle is opened to
find.

## The envelope

```json
{
  "schema": "mindvault.debug-bundle/v1",
  "generatedAt": "2026-09-25T12:00:00.000Z",
  "sanitized": {
    "maskedEnvironment": ["MINDVAULT_AGENT_SECRET"],
    "rules": ["Wallet secret keys and publisher API keys are never read into the bundle; ..."]
  },
  "runtime": {
    "serverVersion": "1.0.0",
    "nodeVersion": "v20.11.0",
    "platform": "linux",
    "arch": "x64",
    "mockMode": false,
    "readOnlyMode": false
  },
  "config": {
    "stellarNetwork": "testnet",
    "x402Network": "stellar:testnet",
    "baseUrl": "https://mindvault-hyr3.onrender.com",
    "registryContractId": "CDQK…",
    "registryNetworkPassphrase": "Test SDF Network ; September 2015",
    "sponsoredAccountUrl": "https://…",
    "horizonUrl": "https://horizon-testnet.stellar.org",
    "sorobanRpcUrl": "https://soroban-testnet.stellar.org"
  },
  "environment": { "STELLAR_NETWORK": "testnet", "MINDVAULT_AGENT_SECRET": "[REDACTED]" },
  "diagnostics": [],
  "install": { "ok": true, "checks": [{ "name": "node_version", "ok": true, "detail": "…" }] },
  "profiles": {
    "active": "default",
    "entries": [
      {
        "name": "default",
        "active": true,
        "hasWallet": true,
        "publicKey": "GDNK…",
        "hasApiKey": true
      }
    ]
  },
  "state": {
    "dir": "/home/agent/.mindvault",
    "file": "/home/agent/.mindvault/state.json",
    "permissions": {
      "exists": true,
      "mode": "0600",
      "expectedMode": "0600",
      "isSafe": true,
      "message": "…"
    }
  },
  "metrics": {
    "enabled": false,
    "since": null,
    "toolDurationBudgetMs": null,
    "totals": {},
    "payments": {},
    "tools": {}
  },
  "catalogCache": {
    "ttlMs": 86400000,
    "maxAgeMs": 604800000,
    "snapshot": { "present": false, "savedAt": null, "resourceCount": 0, "label": null }
  },
  "auditLog": {
    "enabled": true,
    "filePath": "/var/log/mindvault/audit.jsonl",
    "exists": true,
    "requested": 50,
    "entries": []
  }
}
```

The tool advertises an `outputSchema`, so the same object also arrives as MCP
`structuredContent`. `metrics` is the `mindvault_metrics` snapshot and reports
`enabled: false` when `MINDVAULT_METRICS` is off.

## Filing a report

1. Call `mindvault_debug_bundle` (raise `auditLogLines` if the failure is a few
   calls back).
2. Skim `sanitized.maskedEnvironment` and `profiles`; if you still see
   something you do not want to share, pass `includeEnvironment: false`.
3. Attach the JSON. `diagnostics` and `install.checks` name the environment
   variable behind each problem, so a maintainer can usually answer from the
   bundle alone.

## Tests

`mcp/src/debugBundle.test.ts` places the same secret key in the environment,
in a profile, and in an audit-log line and asserts it is absent from the
output while the public key and contract id survive.
`mcp/src/integration.test.ts` calls the tool over a real transport and checks
the schema, the structured result, and that nothing shaped like a secret key
is present.
