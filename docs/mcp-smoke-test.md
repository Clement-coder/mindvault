# MCP Smoke Test

An end-to-end smoke script that boots the MindVault MCP server over stdio and
drives the full agent flow — **set up wallet → register → publish → preview →
buy** — exactly as an MCP client would. It exits non-zero the moment any tool
call fails, so it works as a fast pre-release or CI gate for the MCP surface.

Source: [`mcp/scripts/smoke.ts`](../mcp/scripts/smoke.ts) (orchestration core in
[`mcp/src/smoke.ts`](../mcp/src/smoke.ts), mock upstreams in
[`mcp/scripts/mock-server.ts`](../mcp/scripts/mock-server.ts)).

## Running it

```bash
# From the repo root
pnpm --filter @mindvault/mcp smoke              # default: mock target
pnpm --filter @mindvault/mcp smoke -- --target mock
pnpm --filter @mindvault/mcp smoke -- --target testnet

# Or from mcp/
cd mcp && pnpm smoke
```

The target can also be set with `SMOKE_TARGET=mock|testnet`.

## Targets

### `mock` (default)

Runs against an in-process HTTP stub ([`mock-server.ts`](../mcp/scripts/mock-server.ts))
that stands in for the sponsored-account service, Stellar Horizon, and the vault
API. This target needs **no network access, no funded wallet, and no live
backend**, and its output is deterministic — ideal for CI.

The paid endpoints (`/verify-content`, `GET /resources/:id`) return `200`
directly, so the x402 payment wrapper passes through without a real on-chain
payment. Upstreams are addressed via `*.localhost` hosts so the server's own
network-config validation still resolves to testnet.

### `testnet`

Runs against the real hosted backend on Stellar **testnet** (the MCP server's
defaults). The publisher wallet created during the run must hold testnet USDC to
pay the verification fee on publish and the price on buy — fund it from the
[Circle testnet faucet](https://faucet.circle.com) as described in
[mcp-quickstart.md](mcp-quickstart.md#2-funding-the-agent-wallet). Because it
touches live services, this target is slower and not deterministic.

## What it guarantees

- **Non-zero exit on failure.** Any tool result flagged `isError` (or carrying
  the server's `Error:` marker) stops the run and returns exit code `1`. A clean
  run of all five steps returns `0`.
- **Deterministic, safe output.** Failure messages are fixed-format and never
  echo secrets — the smoke driver only surfaces the server's own tool text,
  which excludes wallet secret keys and API keys.
- **Isolation.** The child MCP server runs with `HOME` pointed at a temp
  directory, so the run never reads or writes the operator's real
  `~/.mindvault/state.json`.

## Install smoke (`smoke:install`)

A second, narrower check answers a different question: **does the server an
agent actually installs start up and serve its tools?**

```bash
pnpm --filter @mindvault/mcp build          # produces dist/index.js
pnpm --filter @mindvault/mcp smoke:install  # default: the built dist entry
pnpm --filter @mindvault/mcp smoke:install -- --entry src   # sources via tsx
```

Source: [`mcp/scripts/install-smoke.ts`](../mcp/scripts/install-smoke.ts), with
the scenario in [`mcp/src/installSmoke.ts`](../mcp/src/installSmoke.ts).

It launches the exact command the README tells an operator to configure —
`node mcp/dist/index.js` over stdio — and then:

1. lists the tools and checks the ones a new agent needs are advertised;
2. runs `mindvault_verify_install` and requires a clean report;
3. reads the catalog, twice (plain, and sorted with `sort: price_asc`);
4. searches, previews, and looks a resource up on the registry;
5. exports receipts and checks the document carries its schema version.

Every call is served by the in-process fixtures in
[`mcp/src/mock.ts`](../mcp/src/mock.ts) (`MINDVAULT_MOCK=1`), so the run needs no
network, no funded wallet, and no live backend, and `HOME` plus the purchase
store are redirected into a temp directory. The scenario is **read-only** — it
never publishes, pays, or writes on-chain — so it is safe to run against any
configuration.

### Why it exists

The rest of the suite never starts the process. Unit tests import modules, the
integration harness wires an in-memory transport to an already-imported server,
and the tarball test reads packaging metadata. A server that compiles, passes
every test, and packs correctly could still fail to boot — and did: a duplicated
`server.connect(transport)` threw "already started" on startup, breaking every
real install while CI stayed green. This check is the gate for that class of
failure, and it runs in CI on every PR ([`.github/workflows/pr.yml`](../.github/workflows/pr.yml)).

### The two smoke tests

|             | `smoke`                              | `smoke:install`                          |
| ----------- | ------------------------------------ | ---------------------------------------- |
| Entry point | `src/index.ts` via tsx               | `dist/index.js` (the documented install) |
| Scenario    | publish → preview → buy (write path) | list → verify → browse → export (read)   |
| Fixtures    | local HTTP stub over `*.localhost`   | in-process `MINDVAULT_MOCK=1`            |
| Needs build | no                                   | yes                                      |
| Runs in CI  | no                                   | yes                                      |

## Tests

The orchestration core is unit-tested in
[`mcp/src/smoke.test.ts`](../mcp/src/smoke.test.ts) (happy path, first-failure
short-circuit, soft-error handling, and transport failure) and the install
scenario in [`mcp/src/installSmoke.test.ts`](../mcp/src/installSmoke.test.ts)
(healthy install, missing tools, unset fixtures, rejected sort argument). Both
run as part of `pnpm --filter @mindvault/mcp test` and the root `pnpm test`.

For SDK-level coverage of `listTools` / `callTool` against the real server
handlers (with mocked fetch/registry), see
[mcp-integration-harness.md](mcp-integration-harness.md).

## Offline fixture generation

The `MINDVAULT_MOCK=1` in-process fixtures live in
[`mcp/src/mock.ts`](../mcp/src/mock.ts). A companion script serialises them to
static JSON files under `mcp/fixtures/` so tests and tooling can load
pre-generated data without booting any process:

```bash
pnpm --filter @mindvault/mcp generate-fixtures
# or from mcp/
pnpm generate-fixtures
```

Source: [`mcp/scripts/generate-fixtures.ts`](../mcp/scripts/generate-fixtures.ts).

The command is **idempotent** — running it twice produces bit-for-bit identical
output. Commit the generated files so CI and contributors always have them
without needing to run the command first.

### Output files

| File                             | Contents                                              |
| -------------------------------- | ----------------------------------------------------- |
| `fixtures/catalog.json`          | Catalog resources (`GET /resources` shape)            |
| `fixtures/registry.json`         | On-chain registry resources (Soroban `list` shape)    |
| `fixtures/agent-status.json`     | Verification agent status (`GET /agent/status` shape) |
| `fixtures/horizon-balances.json` | Horizon account balances (`GET /accounts/:pk` shape)  |

Each file carries a `_meta.generatedBy` field so it is always clear where the
data came from.

### Keeping fixtures in sync

The fixture files are derived from `MOCK_CATALOG_RESOURCES` and
`MOCK_REGISTRY_RESOURCES` exported from `mock.ts`. If you edit those constants,
regenerate the fixtures:

```bash
pnpm --filter @mindvault/mcp generate-fixtures
git add mcp/fixtures/
```

The test suite enforces alignment: `src/generateFixtures.test.ts` loads the
generated files and asserts their `resources` arrays match the in-memory
constants exactly — so a stale `fixtures/` directory fails the tests.
