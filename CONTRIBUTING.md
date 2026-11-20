# Contributing to MindVault

Thanks for your interest in building MindVault! This guide gets you from a fresh
clone to a running stack and a first pull request.

MindVault is a payment-protected vault for digital resources on Stellar, using
HTTP 402 and the x402 protocol. Everything runs on **Stellar testnet** — no real
funds are at risk.

## Repository layout

```
mindvault/
  server/     Express backend, x402 middleware, Supabase, verification agent
  web/        React frontend, Stellar wallet connection, Tailwind   (imported separately)
  mcp/        MCP server for AI agent access                        (imported separately)
  contract/   Soroban smart contracts (Rust) — on-chain vault registry
```

This is a **pnpm workspace** for the JavaScript/TypeScript packages. `contract/`
is a separate Rust/Cargo workspace managed with the Stellar CLI.

## Prerequisites

- **Node.js 20+** and **pnpm** (`npm i -g pnpm`)
- **Rust** + the **Stellar CLI** for contract work — see
  [Stellar setup](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)
- A **Supabase** project (free tier) for the backend
- Stellar testnet wallets funded with USDC from [faucet.circle.com](https://faucet.circle.com)

## Local setup

See the complete **[Local Setup Guide](docs/local-setup.md)** to get from a fresh clone to a running server and web app.

## Smart contract development

```bash
pnpm contract:build  # build the wasm (stellar contract build)
pnpm contract:test   # cargo test

# or directly inside contract/
cd contract && cargo test
```

If your contract change alters the on-chain ABI (new methods, changed arguments,
updated structs), regenerate the TypeScript bindings so consumers stay in sync:

```bash
pnpm contract:bindings   # regenerates packages/registry-client/src/generated/
```

See [`docs/registry-client-bindings.md`](docs/registry-client-bindings.md) for
the full regeneration workflow, which files to commit, and how `server/`, `web/`,
and `mcp/` consume the bindings.

See [`contract/README.md`](contract/README.md) for the registry interface and
deployment steps.

## Running the integrated flow locally

This walks through the full publish → verify → buy cycle on your local machine.

```bash
# 1. Start the backend
pnpm dev:server        # http://localhost:4021

# 2. Register a publisher
curl -s -X POST http://localhost:4021/publishers \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com","walletAddress":"G..."}' \
  | tee /tmp/publisher.json
# Save the returned apiKey

# 3. Publish a link resource (verification fee paid automatically by the agent wallet)
curl -s -X POST http://localhost:4021/resources \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <apiKey>" \
  -d '{"title":"My Dataset","price":"0.50","externalUrl":"https://example.com/data.csv"}' \
  | tee /tmp/resource.json
# Save the returned id

# 4. Check verification status
curl -s http://localhost:4021/resources/<id>/verification

# 5. Access the resource (triggers 402 → payment → delivery)
#    Any x402-capable client handles this automatically.
#    To test manually, use the e2e script:
pnpm --filter server e2e-test

# 6. (Optional) Transfer ownership on-chain
#    a. Build the unsigned tx
curl -s -X POST http://localhost:4021/resources/<id>/ownership/prepare \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <apiKey>" \
  -d '{"newOwnerWallet":"G<new-owner-address>"}' \
  | tee /tmp/prepare.json
# Returns { unsignedXdr, networkPassphrase }

#    b. Sign the XDR with the owner's key (e.g. using stellar-sdk or Freighter),
#       then submit:
curl -s -X POST http://localhost:4021/resources/<id>/ownership \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <apiKey>" \
  -d '{
    "signedXdr": "<base64-xdr>",
    "newOwnerWallet": "G<new-owner-address>",
    "newPublisherId": "<new-publisher-id>"
  }'
# On success: DB publisherId, walletAddress, and onchainTxHash are updated.
```

## Working on a change

1. **Fork** and create a branch: `git checkout -b feat/short-description`
2. Keep changes focused — one logical change per PR.
3. **Install git hooks** (once per clone — runs automatically via `pnpm install`):
   ```bash
   pnpm install
   ```
   Husky installs a **pre-commit** hook that runs ESLint and Prettier on staged files
   via [lint-staged](https://github.com/lint-staged/lint-staged), and a **commit-msg**
   hook that validates [Conventional Commits](https://www.conventionalcommits.org/)
   message formatting (matching the PR title linter in CI).
4. Run the full validation suite before pushing:
   ```bash
   make validate
   ```
   This builds the registry client and server, runs tests, checks formatting/linting,
   and verifies doc links — all without requiring live secrets. If you only changed
   contracts, run `pnpm contract:test` separately (requires Rust + Stellar CLI).
5. Use clear commit messages (e.g. `feat: add catalog search`, `fix: cors header`).
6. Use Conventional Commits formatting for your PR titles (e.g., `feat: add catalog search` or `fix(auth): cors header`). PR titles are automatically linted, and non-conforming titles will fail CI. Commit messages are checked locally by the `commit-msg` hook.
7. Open a PR against `main` describing **what** changed and **why**, and how you
   tested it.

### Git hooks troubleshooting

| Symptom                        | Fix                                                                   |
| ------------------------------ | --------------------------------------------------------------------- |
| Hooks not running after clone  | Run `pnpm install` (triggers the `prepare` script)                    |
| Need to skip hooks temporarily | `git commit --no-verify` (use sparingly — CI will still catch issues) |
| Commit message rejected        | Use `type: description` format, e.g. `feat: add PWA manifest`         |

## Good first issues

These are drawn from the README's "What Is Not Yet Built" — great starting points:

- **Search & filtering** on the catalog (`server/` + `web/`)
- **Recurring access / time-limited leases** instead of per-request payment
- **Refund mechanism** (potentially a Soroban escrow contract under `contract/`)
- **Rate limiting** on the API
- **Wire the backend to `vault-registry`** — record resources on-chain at publish
  time and read prices from the registry
- **TypeScript bindings** for the contract via `stellar contract bindings typescript`

If you want to take something larger on, open an issue first so we can align on
the approach.

## Labels & triage

Issues and PRs use a small, consistent label taxonomy — `area:`, `type:`,
`difficulty:`, and `wave:` (open-source contributor cohorts). The canonical set
lives in [`.github/labels.yml`](.github/labels.yml) and the full triage guide is
in [`docs/LABELS.md`](docs/LABELS.md). Browse the `good first issue` and current
`wave:` labels to find a starting point.

## Releases

MindVault uses automated releases powered by [release-please](https://github.com/google-github-actions/release-please-action). Releases are triggered automatically when commits following [Conventional Commits](https://www.conventionalcommits.org/) are merged to `main`.

- **feat:** triggers a minor version bump (e.g., 1.0.0 → 1.1.0)
- **fix:** triggers a patch version bump (e.g., 1.0.0 → 1.0.1)
- **chore:** and other types do not trigger version bumps

The release workflow:
1. Detects new commits on `main`
2. Determines the next semantic version based on commit types
3. Creates a git tag and GitHub release
4. Generates/updates `CHANGELOG.md` with release notes

No manual release steps are required—just follow the Conventional Commits format for your PR titles and commit messages.

For changes to the MCP tools, prompts, resources, schemas, annotations, or
transport behavior, follow the [MCP protocol change policy](docs/mcp-protocol-change-policy.md)
and [MCP package publish checklist](docs/mcp-publish-checklist.md). The latter
distinguishes the repository's GitHub release workflow from optional npm
publishing of `@mindvault/mcp`.

## Security

- Never commit secrets. Only `*.env.example` files belong in git.
- All payments are testnet only; do not point this at mainnet.
- Found a vulnerability? Open an issue describing the impact (avoid posting a
  working exploit publicly).

### Secret scanning (gitleaks)

Every push and pull request runs [gitleaks](https://github.com/gitleaks/gitleaks)
via GitHub Actions. The scanner looks for Stellar secret keys (`S...`), Supabase
service keys, API keys, and other common secret patterns.

**If CI fails on your PR:**

1. **Do not merge** until the finding is resolved.
2. Identify the leaked value in the gitleaks job log (file + line).
3. **Remove the secret from git history** if it was ever committed:
   - If the PR is not merged yet, amend or rebase to drop the offending commit.
   - If the secret reached `main`, rotate it immediately (generate a new Stellar
     keypair, rotate Supabase service key, etc.) — removing it from git does not
     revoke a key that was already exposed.
4. Replace real values with placeholders in tracked files (see `server/.env.example`).
5. Re-run locally before pushing:
   ```bash
   docker run --rm -v "$(pwd):/path" zricethezav/gitleaks:latest \
     detect --source /path --config /path/.gitleaks.toml --verbose
   ```

Placeholder patterns in `server/.env.example` (e.g. `G...`, `S...`, `eyJ...`) are
allowlisted in `.gitleaks.toml` and will not fail the scan.

Happy building. ⚡
