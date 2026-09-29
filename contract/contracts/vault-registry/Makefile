default: build

all: test

test: build
	cargo test

build:
	stellar contract build
	@ls -l target/wasm32v1-none/release/*.wasm

fmt:
	cargo fmt --all

clean:
	cargo clean

# Run all locally-verifiable pre-deploy checks in one step.
# Mirrors what .github/workflows/contract-ci.yml enforces in CI:
#   1. cargo test   — full test suite including event-schema and workflow tests
#   2. optimized build + WASM size guard (budget: 36,864 bytes)
#   3. no_std compatibility check
#
# See docs/contract-upgrade-checklist.md for the full deployment checklist,
# including network, contract ID, and client binding regeneration steps that
# cannot be automated here.
# Print the storage footprint report (see docs/contract-storage-footprint.md).
# The same test also enforces the per-entry budgets during `make test`.
footprint:
	cargo test storage_footprint_report -- --nocapture

preflight:
	@echo "==> [1/3] Running tests..."
	cargo test
	@echo "==> [2/3] Building optimized WASM..."
	stellar contract build --manifest-path Cargo.toml --optimize
	@WASM=target/wasm32v1-none/release/vault_registry.wasm; \
	SIZE=$$(stat -c%s "$$WASM" 2>/dev/null || stat -f%z "$$WASM"); \
	MAX=114688; \
	echo "    WASM size: $$SIZE bytes (budget: $$MAX bytes)"; \
	if [ "$$SIZE" -gt "$$MAX" ]; then \
	  echo "    ERROR: WASM over budget by $$(( $$SIZE - $$MAX )) bytes."; \
	  echo "    Optimize the contract or raise MAX_SIZE in .github/workflows/contract-ci.yml."; \
	  exit 1; \
	fi; \
	echo "    OK: within budget."
	@echo "==> [3/3] Checking no_std compatibility..."
	cargo build --release --target wasm32-unknown-unknown --no-default-features
	@echo "==> preflight passed."

.PHONY: default all test build fmt clean footprint preflight
