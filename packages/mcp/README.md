# @handsoff/mcp

Model Context Protocol (MCP) server exposing Handsoff tools to MCP clients.

## Tools

### `buy`

Initiates a buy and returns a tool result describing the outcome.

#### Result schema

A buy can settle on-chain while the receipt write fails (partial settle). In that
case the receipt fields are omitted from the result. The `buy` tool's
`outputSchema` therefore marks the receipt fields as nullable/optional so that
`structuredContent` with missing receipt fields still validates against the
declared schema.

Fields that are always present (for example the transaction hash and status)
remain required. Only the receipt fields affected by a partial settle are
relaxed to nullable/optional.

#### Partial settle

When the on-chain settlement succeeds but the receipt write fails:

- the result is still returned (the buy is not rolled back),
- receipt fields are `null`/absent,
- clients should treat the missing receipt as a recoverable condition and may
  retry the receipt write.

## Smoke tests

The smoke and install-smoke tests must not bind to a fixed mock catalog id.
Fixture ids change whenever a fixture is added or a resource is migrated, which
would fail the smoke for reasons unrelated to the server. Instead, the smoke
resolves the catalog id dynamically from the current fixtures (for example by
reading the id from the loaded mock catalog rather than hard-coding it), so the
tests keep passing as fixtures evolve.

## Development

See the repository root for build and test instructions.
# MCP

Model Context Protocol (MCP) integration for the project.

## Request signing

Requests to the MCP endpoint are authenticated with an HMAC signature sent in
the `X-Request-Signature` header. The signature is computed over a canonical
representation of the request so that neither the body nor the query string can
be tampered with in transit.

### Canonical payload

The signed payload is the concatenation of the canonical query string and the
raw request body, separated by a newline:

```
<canonical-query>\n<raw-body>
```

- **Canonical query string**: the request's query parameters, sorted by key
  (and by value for repeated keys), percent-encoded with a stable encoding, and
  joined with `&`. Keys with no value are rendered as `key=`. If there are no
  query parameters, the canonical query string is empty.
- **Raw body**: the exact bytes of the request body. For requests without a
  body, this is empty.

Example:

```
GET /mcp/tools?sort=name&page=2

canonical-query: page=2&sort=name
raw-body:        (empty)
payload:         page=2&sort=name\n
```

### Signing

```
signature = hex(HMAC-SHA256(secret, payload))
```

### Verification

Verification recomputes the signature over the same canonical query string and
raw body, then compares it to the `X-Request-Signature` header using a
constant-time comparison. Because the query string is part of the signed
payload, replaying a request with altered query parameters (for example
changing `page` or `sort`) produces a different signature and is rejected.

### Notes

- Sign the canonical query string, not the raw one, so that parameter ordering
  does not affect the signature.
- Body-only signing is insufficient for GET-style calls: query parameters must
  be covered by the signature as well.
