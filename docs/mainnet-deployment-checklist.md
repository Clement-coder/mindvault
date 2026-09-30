# Mainnet Deployment Checklist

Use this checklist when moving a MindVault deployment from Stellar testnet to mainnet.

Legend:
- 🔒 Involves a secret or private key — handle with care
- ⚠️ Irreversible or high-impact action
- 🧪 Testnet-only — skip or remove on mainnet

---

## 1. Prerequisites

- [ ] Node.js 20+ installed on the deployment target
- [ ] `pnpm` installed globally
- [ ] `stellar` CLI installed (`cargo install stellar-cli` or via package manager)
- [ ] Supabase project created and accessible
- [ ] OpenRouter account with billing enabled and API key ready 🔒
- [ ] Circle or another USDC issuer account for mainnet USDC

---

## 2. Stellar Wallets

### 2a. Create mainnet wallets

The platform requires two wallets: a **platform wallet** (receives fees) and an **agent wallet** (pays for verification).

```bash
# Generate platform wallet
cd server && pnpm generate-wallet

# Generate agent wallet (run again — use a different output)
pnpm generate-wallet
```

Record both `publicKey` and `secretKey` values. Store secret keys in a secrets manager (e.g. AWS Secrets Manager, 1Password). 🔒

### 2b. Fund wallets with mainnet XLM

Each Stellar account requires a minimum balance (~1 XLM base reserve). Fund both wallets via an exchange or Stellar anchor.

```bash
# Verify balance after funding
stellar account show --network mainnet --account <PUBLIC_KEY>
```

### 2c. Establish USDC trustlines

On mainnet, USDC is issued by Circle. The asset code is `USDC`, issuer is `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`.

```bash
stellar tx new change-trust \
  --asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
  --source <AGENT_SECRET_KEY> \
  --network mainnet \
  --build-only | stellar tx sign --sign-with-key <AGENT_SECRET_KEY> | stellar tx send --network mainnet
```

Repeat for the platform wallet if it also needs a trustline.

### 2d. Fund agent wallet with USDC

The agent wallet pays $0.10 USDC per content verification. Deposit sufficient USDC (e.g. $5–$10 to start). ⚠️

---

## 3. Soroban Contract

### 3a. Build the contract

```bash
cd contract
cargo test                                        # confirm tests pass
stellar contract build --manifest-path Cargo.toml
```

### 3b. Deploy to mainnet ⚠️

```bash
# Create and fund a deployer identity if you don't have one
stellar keys generate deployer --network mainnet
# Fund it with XLM from an exchange

stellar contract deploy \
  --wasm target/wasm32v1-none/release/vault_registry.wasm \
  --source deployer \
  --network mainnet
```

Record the printed contract ID. This is your mainnet `VAULT_REGISTRY_CONTRACT_ID`. ⚠️ Deployments are permanent and cannot be undone.

### 3c. Regenerate TypeScript bindings

```bash
cd /path/to/mindvault
VAULT_REGISTRY_CONTRACT_ID=<MAINNET_CONTRACT_ID> STELLAR_NETWORK=mainnet pnpm contract:bindings
```

Commit the updated `packages/registry-client/src/generated/index.ts`.

---

## 4. Supabase

- [ ] Create storage bucket named `resources` (or the value of `SUPABASE_STORAGE_BUCKET`) with appropriate access policies
- [ ] Run migrations against the production database:

```bash
cd server
DATABASE_URL=<PROD_DATABASE_URL> pnpm db:migrate
```

- [ ] Confirm all tables exist: `publishers`, `resources`, `payments`, `verifications`

---

## 5. Environment Variables

Update `server/.env` (or your secrets manager / deployment environment) with mainnet values. Testnet-only values are marked 🧪.

| Variable | Testnet value 🧪 | Mainnet value |
|----------|-----------------|---------------|
| `NETWORK` | `stellar:testnet` | `stellar:mainnet` |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | `https://soroban-mainnet.stellar.org` |
| `FACILITATOR_URL` | `https://www.x402.org/facilitator` | Confirm with x402.org — mainnet facilitator URL may differ |
| `VAULT_REGISTRY_CONTRACT_ID` | `CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4` 🧪 | Your deployed mainnet contract ID |
| `REGISTRY_CONTRACT_ID` | same as above 🧪 | Same as `VAULT_REGISTRY_CONTRACT_ID` |
| `PAY_TO` | testnet platform wallet 🧪 | mainnet platform wallet address |
| `AGENT_SECRET_KEY` | testnet agent secret 🔒🧪 | mainnet agent secret 🔒 |
| `REGISTRY_SECRET_KEY` | testnet deployer secret 🔒🧪 | mainnet deployer secret 🔒 |
| `BASE_URL` | `http://localhost:4021` | `https://your-production-domain.com` |
| `DATABASE_URL` | local / testnet Supabase 🧪 | production Supabase connection string 🔒 |
| `SUPABASE_URL` | testnet project 🧪 | production project URL |
| `SUPABASE_SERVICE_KEY` | testnet service key 🔒🧪 | production service key 🔒 |
| `OPENROUTER_API_KEY` | any valid key 🔒 | production key with billing 🔒 |

See [`docs/environment-variables.md`](./environment-variables.md) for full variable descriptions.

---

## 6. x402 Facilitator

- [ ] Confirm that the x402 facilitator at `FACILITATOR_URL` supports mainnet Stellar payments
- [ ] The testnet facilitator (`x402.org/facilitator`) sponsors fees. On mainnet, transaction fees are paid by the submitting account — ensure the agent wallet holds enough XLM for fees (0.00001 XLM per operation; a safety buffer of 1 XLM is sufficient for thousands of transactions)
- [ ] Test a manual payment end-to-end with a small amount before going live ⚠️

---

## 7. Final Smoke Tests

Run these against the deployed mainnet server before announcing availability.

```bash
BASE=https://your-production-domain.com

# Health check
curl -s $BASE/health | jq .

# 402 on a real resource
curl -i $BASE/resources/<RESOURCE_ID>
# Expected: HTTP/1.1 402 Payment Required
# Expected header: PAYMENT-REQUIRED: eyJ...

# Browse catalog
curl -s $BASE/resources | jq '.[].title'

# Agent status
curl -s $BASE/agent/status | jq .agent
```

- [ ] Health check returns `{"status":"ok"}`
- [ ] Paywalled resource returns `402` with `PAYMENT-REQUIRED` header
- [ ] `BASE_URL` in responses matches production domain (not `localhost`)
- [ ] Agent wallet address in `/agent/status` matches mainnet `PAY_TO`

---

## 8. Post-Deployment

- [ ] Rotate testnet secrets — do not reuse them in production 🔒
- [ ] Set up monitoring / alerting for server errors and failed payment settlements
- [ ] Verify on [Stellar Expert (mainnet)](https://stellar.expert/explorer/public) that the contract is visible and the platform wallet address is correct
- [ ] Update README links to point to the production deployment

---

## MCP mainnet guardrails

When the MCP server runs with `STELLAR_NETWORK=mainnet` (or x402 `stellar:pubnet`), tools that **mutate state or spend funds** require an explicit confirmation. Read-only tools stay unrestricted.

**Gated tools:** `mindvault_setup_wallet`, `mindvault_register`, `mindvault_publish`, `mindvault_buy`, `mindvault_register_onchain`, `mindvault_reset`, `mindvault_update_metadata`, `mindvault_set_price`, `mindvault_transfer_ownership`, `mindvault_set_listed`.

**Confirm either:**

1. Pass `confirmMainnet: true` on the tool call, or
2. Set `MINDVAULT_ALLOW_MAINNET=1` on the MCP process (unlocks all gated tools for that process).

**Safer defaults for `MINDVAULT_ALLOW_MAINNET` (#606):** the env override is parsed fail-safe. Only `1` / `true` / `yes` widen the policy to process-wide `allow-all`; everything else — unset, empty, `0` / `false` / `no` / `off`, and any unrecognized value — keeps per-call confirmation. A set value that unlocks nothing (an unexpanded `$MINDVAULT_ALLOW_MAINNET` template placeholder, `on`, `enabled`, a typo) is reported as a startup **warning** so the deployment mistake surfaces immediately; explicit denials stay quiet because they state intent. A typo in a safety setting fails towards *more* confirmation, never less.

Without confirmation the tool returns a deterministic, agent-safe error (no secrets). Diagnostics also appear in `mindvault_registry_info` (`network`, `x402Network`, `mainnetDiagnostics`).

```json
{ "resourceId": "res-001", "confirmMainnet": true }
```

See also: [`docs/environment-variables.md`](./environment-variables.md) (`STELLAR_NETWORK`, `MINDVAULT_ALLOW_MAINNET`).

