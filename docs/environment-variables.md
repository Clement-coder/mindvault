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

| Variable                        | Required | Default   | Description                                                                                             |
| ------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK`               | no       | `testnet` | MCP deployment target (`testnet` or `mainnet` / `pubnet` / `public`).                                   |
| `MINDVAULT_ALLOW_MAINNET`       | no       | unset     | Set to `1` / `true` to allow gated MCP mutations and buys on mainnet without per-call `confirmMainnet`. |
| `MINDVAULT_HTTP_TIMEOUT_MS`     | no       | `15000`   | Request deadline for the MindVault API and sponsored-account service. `0` disables.                     |
| `MINDVAULT_HORIZON_TIMEOUT_MS`  | no       | `15000`   | Request deadline for Horizon balance/account reads. `0` disables.                                       |
| `MINDVAULT_SOROBAN_TIMEOUT_MS`  | no       | `20000`   | Request deadline for Soroban RPC calls. `0` disables.                                                   |
| `MINDVAULT_PAYMENT_TIMEOUT_MS`  | no       | `45000`   | Request deadline for x402 paid fetches, which include on-chain settlement. `0` disables.                |
| `MINDVAULT_RETRY_ATTEMPTS`      | no       | `3`       | Total attempts (including the first) for idempotent MCP calls. `1` disables retrying.                   |
| `MINDVAULT_RETRY_BASE_DELAY_MS` | no       | `250`     | Backoff delay before the first retry; doubles each attempt.                                             |
| `MINDVAULT_RETRY_MAX_DELAY_MS`  | no       | `4000`    | Ceiling on the backoff delay before jitter is applied.                                                  |
| `MINDVAULT_CORRELATION_ID`      | no       | unset     | When set, pins a single correlation id (`x-request-id`) for all outbound requests from the MCP process. Unset (default): each tool call gets its own id. |

Timeouts are enforced with `AbortController`. Retries apply to idempotent calls only — catalog `GET`s, Horizon reads, and Soroban `getTransaction` — and never to x402 payments, which could settle twice. See [`mcp-timeouts-retries.md`](./mcp-timeouts-retries.md) for budgets, policy, and tuning guidance.

On mainnet, MCP tools that mutate state or spend funds (`mindvault_buy`, `mindvault_publish`, `mindvault_register`, `mindvault_register_onchain`, `mindvault_setup_wallet`, `mindvault_reset`, `mindvault_update_metadata`, `mindvault_set_price`, `mindvault_transfer_ownership`, `mindvault_set_listed`) require either `confirmMainnet: true` on the tool call or `MINDVAULT_ALLOW_MAINNET=1`. Read-only tools are unrestricted. See [`mainnet-deployment-checklist.md`](./mainnet-deployment-checklist.md#mcp-mainnet-guardrails).

---

## Mainnet-Specific Notes

When deploying to mainnet, change:

- `NETWORK` → `stellar:mainnet`
- `SOROBAN_RPC_URL` → `https://soroban-mainnet.stellar.org`
- `VAULT_REGISTRY_CONTRACT_ID` / `REGISTRY_CONTRACT_ID` → your mainnet contract ID (requires redeployment)
- `PAY_TO` → your mainnet wallet address
- `BASE_URL` → your production domain

See [`docs/mainnet-deployment-checklist.md`](./mainnet-deployment-checklist.md) for the full migration guide.
