# MCP Package Publish Checklist

What to verify before publishing `@mindvault/mcp` to a registry, and how to
check it automatically.

Most of this is enforced by a script:

```bash
cd mcp
pnpm prepublish:check            # tests, build, manifest, bin, contents, deps, smoke readiness
pnpm prepublish:check --smoke    # also drive the server end to end against the mock backend
pnpm prepublish:check --skip-tests --skip-build   # static checks only, on an existing build
```

It prints one line per check and exits non-zero if any fail, so it can gate a
release locally or in CI. The rules live in
[`mcp/src/prepublish.ts`](../mcp/src/prepublish.ts) (pure, unit-tested) and the
runner in [`mcp/scripts/prepublish-check.ts`](../mcp/scripts/prepublish-check.ts).

---

## Known blocker

> `@mindvault/mcp` depends on `@mindvault/registry-client` with a `workspace:*`
> range, and that package is marked `"private": true`. `pnpm publish` rewrites
> the range to a real version, but nobody outside this repo can install a
> package that was never published. **The MCP package is not publishable until
> this is resolved** — publish `@mindvault/registry-client` first, bundle it
> into the MCP build, or inline what the server uses.

`pnpm prepublish:check` reports this as `deps:resolvable` and fails. That is the
check working, not a bug in the script.

---

## 1. Tests

- [ ] `pnpm --filter @mindvault/mcp test` is green
- [ ] The suite ran against the code you are shipping (no uncommitted changes)

Automated as the `tests` check. Skip with `--skip-tests` when you have just run
them.

## 2. Build

- [ ] `pnpm --filter @mindvault/mcp build` completes with no TypeScript errors
- [ ] `dist/` contains compiled JS and `.d.ts` files
- [ ] `dist/` is newer than every file in `src/` — a stale build ships old code
- [ ] `dist/` contains no test files (the build runs against `tsconfig.build.json`,
      which excludes `src/**/*.test.ts`; `tsconfig.json` still covers them so the
      editor and linter type-check tests)

Automated as `build`, `build:output`, and `build:fresh`.

## 3. Manifest

- [ ] `name` and a valid semver `version` — bump the version for every release
- [ ] `"private"` is not set
- [ ] `description`, `license`, and `repository` are present
- [ ] `"type": "module"` (the build emits ESM)
- [ ] `main` and `types` point into `dist/`
- [ ] `engines.node` declares the supported runtime (`>=20`)

Automated as the `manifest:*` checks.

## 4. Bin entrypoint

The MCP server is launched as a command by every client, so the entrypoint must
survive packaging:

- [ ] `bin` maps a command name to `dist/index.js` (never to `src/`)
- [ ] The file exists after the build
- [ ] The file is in the tarball
- [ ] The file starts with `#!/usr/bin/env node`

Automated as the `bin:*` checks.

Verify by hand after packing:

```bash
npm pack                                  # writes mindvault-mcp-<version>.tgz
npm install -g ./mindvault-mcp-1.0.0.tgz
mindvault-mcp                             # should start and wait on stdio
```

## 5. Package contents

- [ ] `files` allowlists `dist` — without it npm ships the whole directory
- [ ] `package.json` and `dist/` are in the tarball
- [ ] No `src/`, test files, or snapshots
- [ ] No `.env`, `.env.example`, or lockfiles
- [ ] No agent state (`state.json`) — it holds wallet secret keys

Automated as the `contents:*` checks, which read the real
`npm pack --dry-run --json` output.

Inspect the list yourself with:

```bash
cd mcp && npm pack --dry-run
```

## 6. Dependencies

- [ ] Every runtime dependency is installable from the registry
- [ ] `workspace:` ranges are published with `pnpm publish` (npm does not rewrite them)
- [ ] No workspace dependency is marked `private`

Automated as the `deps:*` checks. See [known blocker](#known-blocker).

## 7. Smoke test

- [ ] The offline smoke run passes: `MINDVAULT_MOCK=1 pnpm --filter @mindvault/mcp smoke`
- [ ] The packed tarball starts as a real MCP server in a client

The smoke driver boots the server and walks setup → register → publish →
preview → buy, failing on the first bad tool call. In mock mode it needs no
backend, no funds, and no network. Details in
[docs/mcp-smoke-test.md](mcp-smoke-test.md).

Automated as `smoke:script` / `smoke:driver` (readiness) and `smoke:run` (the
actual run, with `--smoke`).

## 7b. Provenance

- [ ] `pnpm --filter @mindvault/mcp provenance` has been run **after** the build
- [ ] `provenance.json` records the version being published and a full commit SHA
- [ ] The working tree was clean when it was generated
- [ ] Publishing from CI, so `--provenance` can attest the tarball as well

A published tarball otherwise says what it is but nothing about where it came
from. `provenance.json` ships inside the package and records the source commit
and ref, the repository, the build time, the builder (CI workflow or local),
the toolchain, and a sha256 for every built file. For an MCP server that holds
a Stellar secret key and signs payments, that is worth having.

It is a lightweight record, not a signed attestation. npm's `--provenance` flag
produces the cryptographically verifiable version and the two are
complementary: the flag proves the tarball came from a CI run, this file says
what that run was building.

```
pnpm --filter @mindvault/mcp build
pnpm --filter @mindvault/mcp provenance
pnpm --filter @mindvault/mcp prepublish:check
```

Order matters — the record digests `dist/`, so generating it before the build
describes the previous one. The `provenance:*` checks catch a record that is
present but stale, which is worse than none because it is believed.

Details in [docs/mcp-provenance.md](mcp-provenance.md).

## 8. Docs

- [ ] The [client configs](mcp-client-configs.md) match the shipped entrypoint
      and environment variables
- [ ] The [tool argument contract](mcp-tool-arguments.md) matches the tool
      surface — `validation.test.ts` fails if the two drift
- [ ] The README tool table lists any new tools

## 9. Release

- [ ] Version bumped, CHANGELOG/release notes written
- [ ] `pnpm prepublish:check --smoke` passes end to end
- [ ] Publish with `pnpm publish --access public` from `mcp/`
- [ ] Install the published package in a scratch directory and run it once
      before announcing it

---

## Check reference

| Check                           | What it means when it fails                                           |
| ------------------------------- | --------------------------------------------------------------------- |
| `tests`                         | The vitest suite failed — fix before anything else                    |
| `build`                         | `tsc` reported errors                                                 |
| `manifest:*`                    | A required package.json field is missing or wrong                     |
| `bin:declared` / `bin:built`    | No `bin`, or it points outside `dist/`                                |
| `bin:exists`                    | The build has not been run                                            |
| `bin:packed`                    | `files` excludes the entrypoint — the command would be missing        |
| `bin:shebang`                   | The entrypoint cannot execute as a command                            |
| `build:output`                  | `dist/` is empty                                                      |
| `build:fresh`                   | `dist/` is older than `src/` — rebuild                                |
| `contents:runtime`              | The tarball has no `dist/`                                            |
| `contents:no-*`                 | Sources, tests, env files, state, or lockfiles would be published     |
| `deps:workspace`                | Informational — publish with `pnpm publish`                           |
| `deps:resolvable`               | A workspace dependency is private and cannot be installed             |
| `provenance:packed`             | `provenance.json` is missing from the tarball — run `pnpm provenance` |
| `provenance:present`            | The record is absent or unparseable                                   |
| `provenance:schema`             | The record was written by an older tool — regenerate it               |
| `provenance:version` / `:name`  | The record is stale — regenerate after bumping the version            |
| `provenance:commit`             | No source commit recorded                                             |
| `provenance:repository`         | The recorded repository disagrees with package.json                   |
| `provenance:clean`              | Built from a dirty tree — the commit does not describe the build      |
| `provenance:digest`             | The file list was edited by hand or written by an older tool          |
| `provenance:coverage`           | The tarball carries built files the record does not know about        |
| `smoke:script` / `smoke:driver` | The smoke path is missing                                             |
| `smoke:run`                     | The end-to-end mock run failed                                        |
