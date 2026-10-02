# Environment Variables

All variables are read by `server/src/config.ts` using Zod validation. If a required variable is missing or malformed, the server exits with a descriptive error at startup.

Copy `server/.env.example` to `server/.env` and fill in the values before running locally.

---

## Server

| Variable   | Required | Default                 | Description                                                                                             |
| ---------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `PORT`     | no       | `4021`                  | TCP port the Express server listens on.                                                                 |
| `BASE_URL` | no       | `http://localhost:4021` | Public base URL. Used to build `accessUrl` in API responses. Set to your deployed origin in production. |

---

## Stellar / x402

| Variable           | Required | Default                            | Description                                                                                                                                             |
| ------------------ | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETWORK`          | no       | `stellar:testnet`                  | x402 network identifier. Use `stellar:testnet` for testnet, `stellar:mainnet` for mainnet.                                                              |
| `FACILITATOR_URL`  | no       | `https://www.x402.org/facilitator` | x402 facilitator endpoint used to verify and settle payments.                                                                                           |
| `PAY_TO`           | **yes**  | —                                  | Platform Stellar wallet address (`G...`). Receives verification fees ($0.10 USDC per verification).                                                     |
| `AGENT_SECRET_KEY` | **yes**  | —                                  | Platform agent secret key (`S...`). Signs Soroban auth entries when the server pays for content verification autonomously. **Never commit this value.** |

Example (testnet):

```
NETWORK=stellar:testnet
FACILITATOR_URL=https://www.x402.org/facilitator
PAY_TO=GB6LGS25BCTVQSIXNCXDTRH5OHKBXFB4CPCNPOCFXCZJVLFAJNL5KHM
AGENT_SECRET_KEY=<your-stellar-secret-key>
```

---

## Soroban / Vault Registry

| Variable                     | Required | Default                               | Description                                                                                                                                                                                                         |
| ---------------------------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOROBAN_RPC_URL`            | no       | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. Override for mainnet (`https://soroban-mainnet.stellar.org`) or a self-hosted node.                                                                                                           |
| `VAULT_REGISTRY_CONTRACT_ID` | **yes**  | —                                     | Contract ID of the deployed `vault-registry` Soroban contract. The testnet canonical deployment is `CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4`. See `contract/README.md` for how to deploy your own. |
| `REGISTRY_CONTRACT_ID`       | **yes**  | —                                     | Alias for the vault registry contract ID (same contract, read by the registry client package).                                                                                                                      |
| `REGISTRY_SECRET_KEY`        | **yes**  | —                                     | Secret key of the registry deployer / owner account. Required to write entries to the on-chain registry. **Never commit this value.**                                                                               |

> `SOROBAN_RPC_URL`, `VAULT_REGISTRY_CONTRACT_ID`, and `REGISTRY_CONTRACT_ID` refer to the same contract and RPC. Both variable names appear in `config.ts` for backward compatibility; keep them in sync.

---

## OpenRouter (AI Verification)

| Variable             | Required | Default                     | Description                                                                                                                   |
| -------------------- | -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | **yes**  | —                           | API key for [OpenRouter](https://openrouter.ai). Used by the verification agent to call the LLM. **Never commit this value.** |
| `OPENROUTER_MODEL`   | no       | `anthropic/claude-sonnet-4` | Model identifier passed to OpenRouter. Any model available on OpenRouter works.                                               |

---

## Supabase

| Variable                  | Required | Default     | Description                                                                                                                                                |
| ------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | **yes**  | —           | Postgres connection string from Supabase (pooler recommended). Format: `postgresql://postgres.xxx:password@aws-0-region.pooler.supabase.com:6543/postgres` |
| `SUPABASE_URL`            | **yes**  | —           | Supabase project URL. Format: `https://<project-ref>.supabase.co`                                                                                          |
| `SUPABASE_SERVICE_KEY`    | **yes**  | —           | Supabase service-role JWT. Used by the storage client to upload/download files. **Never commit this value.**                                               |
| `SUPABASE_STORAGE_BUCKET` | no       | `resources` | Storage bucket name for uploaded file resources. Create the bucket in the Supabase dashboard before use.                                                   |

---

## Limits

| Variable             | Required | Default | Description                                                                                     |
| -------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------- |
| `MAX_FILE_SIZE_MB`   | no       | `50`    | Maximum size for file upload resources, in megabytes. Enforced by the multer middleware.        |
| `VERIFICATION_PRICE` | no       | `0.10`  | Price in USDC charged per content verification (the x402-paywalled `/verify-content` endpoint). |

### MCP automatic payment ceiling

`mindvault_buy` will not automatically settle an x402 payment above
`MINDVAULT_MAX_AUTO_PAY_USDC`, which defaults to `10` USDC. Set this environment
variable to a non-negative decimal amount with up to seven decimal places to
adjust the ceiling.

For a resource above the configured ceiling, pass `maxAutoPayUsdc` to
`mindvault_buy` with an amount at least equal to the advertised price. This is a
per-call override; it does not change the configured default.

```bash
MINDVAULT_MAX_AUTO_PAY_USDC=5
```

### MCP catalog preview size limits

Titles and descriptions are publisher-supplied and unbounded at the source, so a
single listing could otherwise fill an agent's context window. `mindvault_preview`
caps them before the response is serialized:

- Each free-text field (`title`, `description`) is clipped to
  `MINDVAULT_PREVIEW_FIELD_MAX_CHARS` characters (default `1000`).
- If the serialized response is still larger than `MINDVAULT_PREVIEW_MAX_BYTES`
  (default `8192`), the description and then the title are shrunk further until
  it fits. A non-zero budget below `1024` is raised to `1024`, the room the
  identity fields and the truncation notice need.

Set either variable to `0` to disable that limit.

Identity fields — `id`, `price`, `accessUrl`, `type`, `verificationStatus` — are
never shortened, and the limit is applied per field rather than to the encoded
JSON, so the response is always parseable. When anything was clipped, the
response carries a `truncated` block:

```json
{
  "id": "cm7x8y9z",
  "title": "Stellar Payments Dataset",
  "description": "Ledger-level payment records… [truncated: 1000 of 54321 characters]",
  "price": "$1.5 USDC",
  "accessUrl": "https://example.com/cm7x8y9z",
  "truncated": {
    "fields": ["description"],
    "notice": "Preview shortened to fit the response size limit. Buy the resource for the full content, or raise MINDVAULT_PREVIEW_MAX_BYTES / MINDVAULT_PREVIEW_FIELD_MAX_CHARS."
  }
}
```

```bash
MINDVAULT_PREVIEW_MAX_BYTES=16384
MINDVAULT_PREVIEW_FIELD_MAX_CHARS=2000
```

---

## Diagnosing Missing Variables

If the server exits immediately on startup, the Zod validation error will list every missing or invalid variable:

```
Invalid environment variables:
{
  PAY_TO: [ "PAY_TO (platform wallet address) is required" ],
  AGENT_SECRET_KEY: [ "AGENT_SECRET_KEY (platform agent secret) is required" ]
}
```

Fix each item in `server/.env` and restart.

---

## Secrets Checklist

The following values **must never be committed** to version control:

- `AGENT_SECRET_KEY` — spending capability over the platform wallet
- `REGISTRY_SECRET_KEY` — write access to the on-chain registry
- `OPENROUTER_API_KEY` — billed API access
- `SUPABASE_SERVICE_KEY` — full database and storage access
- `DATABASE_URL` — direct Postgres access including password

All other variables are either public addresses or non-sensitive configuration. `server/.env` is in `.gitignore`; verify before committing.

---

## MCP

| Variable                            | Required | Default   | Description                                                                                                                                             |
| ----------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK`                   | no       | `testnet` | MCP deployment target (`testnet` or `mainnet` / `pubnet` / `public`).                                                                                   |
| `MINDVAULT_ALLOW_MAINNET`           | no       | unset     | Set to `1` / `true` / `yes` to allow gated MCP mutations and buys on mainnet without per-call `confirmMainnet`. Parsed fail-safe: anything else — `0` / `false` / `no` / `off`, or an unrecognized value — keeps per-call confirmation, and a set-but-ineffective value raises a startup warning (#606). |
| `MINDVAULT_READ_ONLY`               | no       | unset     | Set to `1` / `true` / `yes` / `on` to restrict the MCP server to catalog browsing. Only read-only tools are advertised and all others are refused.      |
| `MINDVAULT_CONFIRM_PAID_OPERATIONS` | no       | `off`     | `off`, `usdc`, or `all`. Requires `confirmPaid: true` on tools that spend, independently of network. An unrecognized value is an error, not a fallback. |
| `MINDVAULT_HTTP_TIMEOUT_MS`         | no       | `15000`   | Request deadline for the MindVault API and sponsored-account service. `0` disables.                                                                     |
| `MINDVAULT_HORIZON_TIMEOUT_MS`      | no       | `15000`   | Request deadline for Horizon balance/account reads. `0` disables.                                                                                       |
| `MINDVAULT_SOROBAN_TIMEOUT_MS`      | no       | `20000`   | Request deadline for Soroban RPC calls. `0` disables.                                                                                                   |
| `MINDVAULT_PAYMENT_TIMEOUT_MS`      | no       | `45000`   | Request deadline for x402 paid fetches, which include on-chain settlement. `0` disables.                                                                |
| `MINDVAULT_RETRY_ATTEMPTS`          | no       | `3`       | Total attempts (including the first) for idempotent MCP calls. `1` disables retrying.                                                                   |
| `MINDVAULT_RETRY_BASE_DELAY_MS`     | no       | `250`     | Backoff delay before the first retry; doubles each attempt.                                                                                             |
| `MINDVAULT_RETRY_MAX_DELAY_MS`      | no       | `4000`    | Ceiling on the backoff delay before jitter is applied.                                                                                                  |
| `MINDVAULT_PREVIEW_MAX_BYTES`       | no       | `8192`    | Byte ceiling for a `mindvault_preview` response. `0` disables; values below `1024` are raised to it.                                                    |
| `MINDVAULT_PREVIEW_FIELD_MAX_CHARS` | no       | `1000`    | Character ceiling for each free-text preview field (`title`, `description`). `0` disables.                                                              |

Timeouts are enforced with `AbortController`. Retries apply to idempotent calls only — catalog `GET`s, Horizon reads, and Soroban `getTransaction` — and never to x402 payments, which could settle twice. See [`mcp-timeouts-retries.md`](./mcp-timeouts-retries.md) for budgets, policy, and tuning guidance.

On mainnet, MCP tools that mutate state or spend funds (`mindvault_buy`, `mindvault_publish`, `mindvault_register`, `mindvault_register_onchain`, `mindvault_setup_wallet`, `mindvault_reset`, `mindvault_update_metadata`, `mindvault_set_price`, `mindvault_transfer_ownership`, `mindvault_set_listed`) require either `confirmMainnet: true` on the tool call or `MINDVAULT_ALLOW_MAINNET=1`. Read-only tools are unrestricted. See [`mainnet-deployment-checklist.md`](./mainnet-deployment-checklist.md#mcp-mainnet-guardrails).

### MCP read-only mode

`MINDVAULT_READ_ONLY=1` turns the MCP server into a catalog browser. It is set on the server process and cannot be lifted by a tool argument — unlike `confirmMainnet`, which an agent supplies from inside the very call you wanted to prevent.

Two things change together. `tools/list` advertises only tools whose definition declares `readOnlyHint: true`, so an agent does not plan around a tool it cannot use; and the dispatcher refuses every other tool, so a client working from a cached tool list — or guessing a name — is still stopped. The refusal names the tools that remain available.

Read-only classification comes from the `readOnlyHint` annotation each tool already advertises, so a tool added later is covered by whatever it declares about itself.

```
MINDVAULT_READ_ONLY=1
```

Browsing, search, preview, registry lookups, wallet info, purchase history, and the diagnostic tools stay available. Everything that mutates state, spends funds, or changes stored credentials is refused — including dry runs, which are exempt from the paid-operation policy below but not from this one: read-only mode is about what the server is for, not about what a call costs.

### MCP paid-operation confirmation

`MINDVAULT_CONFIRM_PAID_OPERATIONS` requires an explicit `confirmPaid: true` before a tool spends from the agent wallet. It is independent of the network (unlike the mainnet guardrail, which never fires on testnet) and of the amount (unlike `MINDVAULT_MAX_AUTO_PAY_USDC`, which stops one large purchase but not a hundred small ones).

| Value  | Effect                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`  | Default. No confirmation required. The mainnet guardrail and the auto-pay ceiling still apply.                                                             |
| `usdc` | `mindvault_publish` and `mindvault_buy` require `confirmPaid: true`.                                                                                       |
| `all`  | Additionally `mindvault_register_onchain`, `mindvault_update_metadata`, `mindvault_set_price`, `mindvault_transfer_ownership`, and `mindvault_set_listed`. |

```
MINDVAULT_CONFIRM_PAID_OPERATIONS=usdc
```

Dry runs (`dryRun: true` on publish or buy) are never gated — they submit no payment, and requiring confirmation would mean confirming a spend in order to find out what the spend would be. `mindvault_setup_wallet` is not gated either: account creation runs through the sponsored-account service, so the agent's own wallet funds nothing.

The policies compose rather than replace one another. A mainnet buy above the auto-pay ceiling with `MINDVAULT_CONFIRM_PAID_OPERATIONS=usdc` must satisfy all three guardrails; `confirmPaid` does not stand in for `confirmMainnet`, or the reverse.

An unrecognized value (`true`, `1`, `yes`) raises an error on the first paid call rather than silently falling back to `off`. A typo in a safety setting that quietly disables it is worse than one that fails loudly.

---

## Mainnet-Specific Notes

When deploying to mainnet, change:

- `NETWORK` → `stellar:mainnet`
- `SOROBAN_RPC_URL` → `https://soroban-mainnet.stellar.org`
- `VAULT_REGISTRY_CONTRACT_ID` / `REGISTRY_CONTRACT_ID` → your mainnet contract ID (requires redeployment)
- `PAY_TO` → your mainnet wallet address
- `BASE_URL` → your production domain

See [`docs/mainnet-deployment-checklist.md`](./mainnet-deployment-checklist.md) for the full migration guide.
