# MCP Package Provenance

Issue [#586](https://github.com/mind-vault-1/mindvault/issues/586).

A published tarball says what it is — `name`, `version` — and nothing about
where it came from. Anyone who installs `@mindvault/mcp` and wants to know
which commit produced it, whether it was built in CI or on somebody's laptop,
or whether the `dist/` they received matches this repository at that commit,
has no way to find out.

For an MCP server that holds a Stellar secret key and signs x402 payments, that
is a gap worth closing.

## What ships

`provenance.json` is written into the package root and included in the tarball
via the `files` allowlist.

```json
{
  "schemaVersion": "1.0.0",
  "name": "@mindvault/mcp",
  "version": "1.0.0",
  "buildTime": "2026-08-29T12:00:00Z",
  "source": {
    "repository": "https://github.com/mind-vault-1/mindvault",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "ref": "main",
    "dirty": false
  },
  "builder": {
    "type": "github-actions",
    "id": "mind-vault-1/mindvault/actions/runs/42",
    "nodeVersion": "v20.11.0",
    "platform": "linux-x64"
  },
  "artifacts": [{ "path": "dist/index.js", "sha256": "…", "bytes": 128374 }],
  "artifactsDigest": "…"
}
```

| Field             | Why it is there                                                         |
| ----------------- | ----------------------------------------------------------------------- |
| `source.commit`   | The single most useful field: what code this is                         |
| `source.ref`      | Branch or tag, so a release can be tied to a tag                        |
| `source.dirty`    | `true` means the commit does **not** describe what was published        |
| `builder.type`    | `local` in a published artifact usually means someone published by hand |
| `artifacts`       | A sha256 per built file, so a tarball can be compared to a rebuild      |
| `artifactsDigest` | One digest for the build as a whole                                     |

## Generating it

```
pnpm --filter @mindvault/mcp build
pnpm --filter @mindvault/mcp provenance
pnpm --filter @mindvault/mcp prepublish:check
```

Order matters. The record digests `dist/`, so generating it before the build
describes the previous one — which the `provenance:coverage` check catches.

Commit and ref come from `git` locally and from `GITHUB_SHA` / `GITHUB_REF_NAME`
in CI. `dirty` is computed from `git status --porcelain` over the `mcp/`
directory only: an unrelated edit elsewhere in the monorepo does not make this
artifact untrustworthy.

## Determinism

Two builds of identical inputs produce a byte-identical record except for
`buildTime`:

- Artifacts are sorted by path, so the order files were read in does not matter.
- `buildTime` is truncated to whole seconds.
- `artifactsDigest` is computed over `path:sha256` lines rather than over file
  bytes, so it changes when a file is **renamed, added or removed** — not only
  when contents change.

That last point is what makes the digest worth checking: a record whose file
list was edited by hand no longer matches its own digest.

## Verifying an installed package

```
$ cat node_modules/@mindvault/mcp/provenance.json | jq -r '.source.commit'
$ git -C /path/to/mindvault rev-parse HEAD    # should match
$ sha256sum node_modules/@mindvault/mcp/dist/index.js
```

Compare the last value against the matching `artifacts[].sha256`. A mismatch
means the `dist/` you have is not the `dist/` the record describes.

## Relationship to npm `--provenance`

They are complementary and both are worth having.

|                     | `provenance.json`               | npm `--provenance`                     |
| ------------------- | ------------------------------- | -------------------------------------- |
| Trust model         | Self-reported                   | Cryptographically attested by Sigstore |
| Requires CI         | No                              | Yes                                    |
| Says what was built | Yes — commit, ref, file digests | Repository and workflow only           |
| Available offline   | Yes, inside the tarball         | Via the registry                       |

`--provenance` proves the tarball came from a particular CI run; this file says
what that run was building. Publish from CI with both.

## What it is not

- **Not a signature.** Anyone who can edit the tarball can edit the record.
  Its value is catching mistakes — a stale version, a dirty tree, a
  half-rebuilt `dist/` — not defeating an attacker.
- **Not a lockfile.** It records what was built, not what it was built against.
- **Not a substitute for `--provenance`.** See above.

## Coverage

- [`mcp/src/provenance.test.ts`](../mcp/src/provenance.test.ts) — record
  construction, determinism, repository-URL normalisation, builder detection,
  and every pre-publish check including the stale-record and tampered-digest
  cases
