# Metadata Hash Format

MindVault anchors a resource's off-chain content on-chain through a digest.
When the server registers a resource it writes a compact JSON metadata pointer
into the vault-registry contract:

```json
{ "title": "Intro to Stellar Consensus", "description": "…", "contentHash": "9f86d081…" }
```

`contentHash` is what makes the anchor useful: a buyer can hash the bytes they
received and compare them against what the chain says they should have got.
That comparison only works if everyone spells a digest the same way — otherwise
`SHA256:AB…`, `sha256-ab…` and `ab…` describe identical bytes but compare
unequal.

This page fixes that format. It is implemented in
[`mcp/src/metadataHash.ts`](../mcp/src/metadataHash.ts) and enforced wherever
the MCP server accepts a digest.

---

## Supported formats

| Algorithm | Digest length      | Example                                                            |
| --------- | ------------------ | ------------------------------------------------------------------ |
| `sha256`  | 64 hex characters  | `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08` |
| `sha512`  | 128 hex characters | `ee26b0dd4af7e749…0028a8ff`                                        |

Each digest may be written:

- **bare** — `9f86d081…` (the algorithm is inferred from the length)
- **prefixed with `:`** — `sha256:9f86d081…`
- **prefixed with `-`** — `sha256-9f86d081…`

Hex digits are case-insensitive, and surrounding whitespace is ignored.

### Canonical form

Every accepted spelling normalizes to lowercase `"<algorithm>:<hex>"`:

```
9F86D081…  →  sha256:9f86d081…
sha256-9F86D081…  →  sha256:9f86d081…
```

**Always compare digests in canonical form.** `mindvault_check_consistency`
canonicalizes both sides before comparing, so a case or prefix difference is
never reported as a mismatch.

### What is rejected

| Input                                   | Reason (`code`)                                              |
| --------------------------------------- | ------------------------------------------------------------ |
| `9f86d081…` truncated to 63 chars       | `invalid_length`                                             |
| 96 hex characters                       | `invalid_length` — matches no supported algorithm            |
| `sha512:<64 hex>`                       | `invalid_length` — length contradicts the declared algorithm |
| `zzzz…` (64 chars)                      | `invalid_characters` — hex only (`0-9`, `a-f`)               |
| `n4bQgYhMfWWaL+qgxVrQFaO/Txs…` (base64) | `invalid_characters`                                         |
| `md5:<32 hex>`                          | `unknown_algorithm`                                          |
| `ipfs://Qm…`                            | `unknown_algorithm`                                          |
| `""` / `"   "`                          | `empty`                                                      |
| a number, object, or `null`             | `not_a_string`                                               |

Errors are deterministic and agent-safe: they name the field, state the reason,
and restate the expected shape. The rejected value is never echoed back.

```
expectedMetadataHash is 63 hex characters, which matches no supported digest
(sha256=64, sha512=128). Expected sha256 (64 hex chars) or sha512 (128 hex
chars), optionally prefixed with "sha256:"/"sha512:" (or "-"); case-insensitive.
```

---

## Where the format applies

| Tool                          | Argument                          | Notes                                                                                            |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `mindvault_check_consistency` | `expectedMetadataHash` (optional) | Compared against the `contentHash` anchored on-chain                                             |
| `mindvault_preview_metadata_hash` | `resourceId`                  | Reports the anchored digest (or why there is none) without a comparison — see below              |
| `mindvault_tx_status`         | `txHash`                          | A Stellar transaction hash is a sha256 digest; normalized to bare lowercase hex for the RPC call |

### Verifying an anchor

Pass the digest you computed over the content you received:

```json
{
  "resourceId": "swcn98besxpp6t1u8e77fqz3",
  "expectedMetadataHash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

The report gains a `metadataHash` block:

```json
{
  "metadataHash": {
    "onchain": "sha256:9f86d081…",
    "algorithm": "sha256",
    "present": true,
    "valid": true,
    "reason": null,
    "expected": "sha256:9f86d081…",
    "matches": true
  }
}
```

- `present: false` — the on-chain pointer carries no `contentHash` (for example
  it is a bare IPFS URI rather than the server's JSON pointer). The rest of the
  consistency report is still produced.
- `valid: false` — a `contentHash` is anchored but is not in the fixed format;
  `reason` explains which rule it broke.
- `matches: false` — the anchor is well-formed but differs from your digest,
  and the field is also listed under `mismatches`.

Omit `expectedMetadataHash` and you still get `present`/`valid`/`algorithm` for
the anchor, without a comparison.

A malformed `expectedMetadataHash` is rejected before any lookup happens —
comparing against a digest that is not in the fixed format could only produce a
misleading "mismatch".

### Previewing an anchor before buying

`mindvault_preview_metadata_hash` reads the same on-chain pointer and reports
the digest (or the deterministic reason there is none) without comparing it
against anything:

```json
{
  "resourceId": "swcn98besxpp6t1u8e77fqz3",
  "pointer": { "source": "on-chain", "present": true },
  "report": {
    "present": true,
    "valid": true,
    "canonical": "sha256:9f86d081…",
    "algorithm": "sha256",
    "reason": null
  }
}
```

Use it to fetch the anchor before you have the content, then pass the same
digest as `expectedMetadataHash` to `mindvault_check_consistency` once you do.
An unregistered resource id is an error (the resource must exist on-chain for
there to be a pointer); a registered resource whose pointer is a bare URI or
malformed JSON is a successful report with `present: false` / `valid: false`.

---

## Related

- [MCP tool argument validation contract](mcp-tool-arguments.md)
- [Resource publish lifecycle](resource-publish-lifecycle.md)
- [Reconciliation](reconciliation.md) — server-side drift detection between the DB and the registry
