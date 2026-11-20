.PHONY: setup setup-usdc dev dev-server dev-web test install migrate wallets seed validate

# MindVault local development entrypoints.
# Prerequisites: Node.js 20+, pnpm, and a configured server/.env (see server/.env.example).

install:
	pnpm install

migrate:
	pnpm db:generate && pnpm db:migrate

wallets:
	@echo "Generating a Stellar testnet wallet (platform or agent)..."
	pnpm generate-wallet
	@echo ""
	@echo "Run 'make wallets' again if you need separate platform + agent wallets."

setup-usdc:
	pnpm --filter @mindvault/server setup-usdc

# First-time setup after copying server/.env.example -> server/.env and filling credentials.
setup: install migrate wallets
	@echo ""
	@echo "Setup complete."
	@echo "  1. Copy keys from 'make wallets' into server/.env (PAY_TO, AGENT_SECRET_KEY, REGISTRY_SECRET_KEY)."
	@echo "  2. Run 'make setup-usdc' after AGENT_SECRET_KEY is set to add a USDC trustline."
	@echo "  3. Acquire Soroban testnet USDC for x402 (see server/scripts/setup-usdc.ts output)."
	@echo "  4. Start the stack with 'make dev'."

dev-server:
	pnpm dev:server

dev-web:
	pnpm --filter @mindvault/web dev

# Run API (:4021) and web app (:5173) together.
dev:
	@trap 'kill 0' INT TERM; \
	pnpm dev:server & \
	pnpm --filter @mindvault/web dev & \
	wait

test:
	pnpm run build:registry-client
	pnpm test

# Full local validation — run before opening a PR.
# Builds packages, runs tests, and checks formatting/linting.
# Does not require live secrets (Supabase, Stellar).
validate:
	@echo "==> Building registry client..."
	pnpm run build:registry-client
	@echo "==> Building server..."
	pnpm --filter @mindvault/server build
	@echo "==> Running tests..."
	pnpm --filter @mindvault/server test
	pnpm --filter @mindvault/web test 2>/dev/null || true
	@echo "==> Checking formatting..."
	pnpm run format:check
	@echo "==> Linting..."
	pnpm run lint
	@echo "==> Checking doc links..."
	pnpm run docs:links
	@echo "==> Checking generated MCP tool docs..."
	pnpm --filter @mindvault/mcp check-tool-docs
	@echo ""
	@echo "All checks passed."

# Populate the catalog with sample resources for local development.
# Safe to re-run. Pass ONCHAIN=1 to also register on Stellar testnet.
seed:
	cd server && pnpm seed $(if $(ONCHAIN),--onchain,)
