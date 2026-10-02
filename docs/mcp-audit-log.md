# MCP Audit Log

`MINDVAULT_AUDIT_LOG=1` records every tool call, network request, payment and
on-chain submission the server makes, with secrets redacted. Entries go to
stderr, and optionally to a rotating JSONL file
([#592](https://github.com/mind-vault-1/mindvault/issues/592)).

## Configuration

| Variable                        | Default   | Description                                    |
| ------------------------------- | --------- | ---------------------------------------------- |
| `MINDVAULT_AUDIT_LOG`           | unset     | Set `1` to enable audit logging                |
| `MINDVAULT_AUDIT_LOG_FILE`      | unset     | Path to a JSONL file. Unset = stderr only      |
| `MINDVAULT_AUDIT_LOG_MAX_BYTES` | `5242880` | Rotate once the live file would exceed this    |
| `MINDVAULT_AUDIT_LOG_MAX_FILES` | `4`       | Rotated generations kept besides the live file |

```json
{
  "mcpServers": {
    "mindvault": {
      "command": "node",
      "args": ["/absolute/path/to/mindvault/mcp/dist/index.js"],
      "env": {
        "MINDVAULT_AUDIT_LOG": "1",
        "MINDVAULT_AUDIT_LOG_FILE": "/var/log/mindvault/audit.jsonl"
      }
    }
  }
}
```

The file sink is opt-in. Without `MINDVAULT_AUDIT_LOG_FILE` nothing changes:
entries go to stderr and whoever runs the server captures them or does not.

## Why a file, and why JSONL

stderr is fine to watch and useless to keep. The stderr form is pretty-printed
across several lines, which cannot be read back line by line, and an agent left
running for a week produces a log nobody captured and nobody bounded.

The file is [JSON Lines](https://jsonlines.org): exactly one compact JSON object
per line. `tail`, `jq -c`, `grep` and any line-oriented log shipper work on it
directly.

```
$ jq -c 'select(.status == "error")' audit.jsonl
$ jq -r 'select(.toolName == "x402-payment") | .txHash' audit.jsonl
```

Newlines inside a value are escaped by the serialiser, so one entry can never
become two lines — the invariant the format rests on.

Both sinks receive the same entries. stderr keeps its indented form for humans
watching a live session; the file gets one line per entry for everything else.

## Rotation

Numbered suffixes, deliberately:

```
audit.jsonl      ← live
audit.jsonl.1    ← most recently rotated
audit.jsonl.2
audit.jsonl.3
audit.jsonl.4    ← oldest kept; the next rotation deletes it
```

It is obvious from a directory listing which file is newest, and it needs no
index or manifest that could disagree with what is on disk.

- Rotation happens **before** a write that would exceed the limit, so
  `MINDVAULT_AUDIT_LOG_MAX_BYTES` is a real ceiling rather than a threshold the
  file is allowed to pass.
- A single entry larger than the whole budget is still written. Truncating an
  audit record would be worse than briefly exceeding a size target.
- `MINDVAULT_AUDIT_LOG_MAX_FILES=0` keeps no history: the live file is
  discarded on rotation.
- Restarting the server **appends** to an existing log rather than truncating
  it, so a restart does not destroy the previous session's trail.
- The minimum accepted size is 1 KiB. A smaller value falls back to the
  default, because rotating on every line would produce thousands of files.

## Failure handling

A read-only directory or a full disk disables the file sink, reports once on
stderr, and leaves the server running. Failing a paid tool call over a logging
problem trades a small loss for a large one.

A malformed size or count falls back to the default rather than failing
startup: the audit log is a diagnostic, and a typo in its tuning must not stop
the server from serving.

## Secrets

Entries are redacted before they are written — API keys, Stellar secret keys,
payment headers and authorization payloads. That applies to both sinks. See
[`mcp/src/redaction.ts`](../mcp/src/redaction.ts).

The file still contains resource IDs, transaction hashes, wallet addresses and
endpoints. Treat it as sensitive operational data: put it somewhere with
appropriate permissions rather than a world-readable temp directory.

## Coverage

- [`mcp/src/auditLog.test.ts`](../mcp/src/auditLog.test.ts) — entry shapes and
  redaction
- [`mcp/src/auditLogRotation.test.ts`](../mcp/src/auditLogRotation.test.ts) —
  JSONL formatting, rotation boundaries, generation shifting, entry
  preservation across rotations, and filesystem-failure handling
