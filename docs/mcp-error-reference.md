# MCP Error Reference

Failures reach an agent from four different subsystems — the MindVault API, the
x402 payment layer, Horizon, and the Soroban vault-registry — and each has its
own failure vocabulary. Left raw, they surface as opaque text (`Browse failed:
{"error":"..."}`, a bare `fetch failed`) that tells an agent nothing about
whether to retry, re-fund the wallet, fix its arguments, or stop.

The MCP server normalizes all of them into one structured shape, implemented in
[`mcp/src/errorMapping.ts`](../mcp/src/errorMapping.ts).

## The shape

Every mapped error is exactly three lines:

```text
<operation>: <detail>
Source: <service> · Category: <category>[ · HTTP <status>]
Next: <one imperative recovery step>
```

For example:

```text
Buy failed [402]: payment rejected
Source: x402 payment · Category: payment · HTTP 402
Next: Payment was required or rejected. Check the wallet with mindvault_wallet_info, fund it with USDC, and retry.
```

Line 1 keeps the operation label the tool has always used, so existing clients
that match on `Browse failed` / `Preview failed` keep working. Line 2 is a
human-readable classification, and line 3 is always present and actionable.

Mapped failures also include an MCP `structuredContent.troubleshooting` object,
so clients can branch without parsing any text. Its versioned shape is:

```json
{
  "schema": "mindvault.troubleshooting/v1",
  "source": "api",
  "category": "rate_limit",
  "status": 429,
  "summary": "Browse failed: too many requests",
  "detail": "too many requests",
  "action": "Rate limited. Wait for the window to pass before retrying."
}
```

`status` is `null` for failures without an HTTP response, and `detail` is
`null` when the source did not supply a separate detail string. The text
response remains unchanged for MCP clients that do not consume structured
content.

The mapping is a pure function of `(source, status, payload)` — the same failure
always produces the same text, so agent behavior is reproducible.

## Sources

| Source                      | What it covers                                            |
| --------------------------- | --------------------------------------------------------- |
| `MindVault API`             | Catalog, publisher, resource, and registration endpoints  |
| `x402 payment`              | Paid fetches for `mindvault_buy` and publish verification |
| `Horizon`                   | Wallet balance and account lookups                        |
| `Soroban RPC`               | `mindvault_tx_status` and registry transport              |
| `vault-registry contract`   | Contract-level rejections from the registry client        |
| `sponsored-account service` | Sponsored wallet creation                                 |

## Categories

| Category     | Trigger                               | Next step given to the agent                                  |
| ------------ | ------------------------------------- | ------------------------------------------------------------- |
| `network`    | Thrown transport error (DNS, refused) | Check connectivity and retry; idempotent reads auto-retry     |
| `timeout`    | Aborted request, HTTP 408 / 504       | Retry, or raise `MINDVAULT_HTTP_TIMEOUT_MS`                   |
| `payment`    | HTTP 402                              | Check the wallet, fund it with USDC, retry                    |
| `validation` | HTTP 400 / 422 (and other 4xx)        | Correct the invalid arguments and call again                  |
| `auth`       | HTTP 401 / 403                        | Run `mindvault_register`, or switch profile — see below       |
| `not_found`  | HTTP 404, or a missing registry entry | Confirm the id with browse/search, or register on-chain       |
| `conflict`   | HTTP 409                              | Already in the requested state — no action needed             |
| `rate_limit` | HTTP 429                              | Wait for the window, then retry                               |
| `server`     | HTTP 5xx                              | Retry shortly; if it persists the service is down             |
| `contract`   | Non-NotFound contract rejection       | Verify contract ID and network with `mindvault_registry_info` |
| `unknown`    | Anything unclassified                 | Retry once, then report the summary                           |

## Rejected publisher API keys

`auth` covers three different situations, and the `Next:` line distinguishes
them so an agent does not retry a credential that can never work again.

| Situation                                | What the agent sees                                                   |
| ---------------------------------------- | --------------------------------------------------------------------- |
| No key stored (never registered)         | "Credentials are missing or not accepted. Run `mindvault_register` …" |
| Stored key rejected as unknown (401)     | The key is reported **revoked**, naming the profile it came from      |
| Stored key valid but not the owner (403) | The key is reported valid but **not authorized** for that resource    |

A key that was rotated from another session, revoked server-side, or whose
publisher record was deleted still sits in `~/.mindvault/state.json`, so the
agent keeps sending it and keeps getting a bare `401 Invalid API key`. The
mapper detects that the failed request carried a stored publisher key and says
so:

```
Publish failed: Invalid API key (publisher API key for profile "publisher" was rejected as unknown)
Source: MindVault API · Category: auth · HTTP 401
Next: The publisher API key stored in profile "publisher" is no longer accepted — it was revoked, rotated from another session, or its publisher record was removed. The stored key cannot be revived: run mindvault_register to obtain a new one, mindvault_use_profile to switch to a profile whose key still works, or mindvault_restore_state to restore a backup that holds a valid key.
```

Note what is **not** suggested: `mindvault_rotate_publisher_key` needs a working
key to rotate, so it cannot recover a revoked one.

The classification line stays `Category: auth` in all three cases, so existing
agent branches on the category keep working — the difference is carried by the
summary and the next step.

## Request signature clock skew

When signatures are enforced (`REQUIRE_REQUEST_SIGNATURE=true` on the server), a
signed mutation whose `X-Timestamp` falls outside the server's tolerance window
is rejected with `401 "Request timestamp outside allowed window"`. That is a
**system-clock** problem, not a credential problem — the MCP server signs with
its own `Date.now()`, and a skewed local clock makes every signed request stale.
The mapper detects the message before the revoked-key branch and says so:

```text
Publish failed: Request timestamp outside allowed window (request signature timestamp rejected as outside the allowed window)
Source: MindVault API · Category: auth · HTTP 401
Next: The request signature was rejected because its timestamp fell outside the accepted 5-minute window — the local clock is probably skewed, not the key. Sync the system clock (e.g. enable NTP), then retry; the message disappears once the clocks agree.
```

The other signature 401s (`Missing X-Timestamp`, `Missing X-Signature`,
`Invalid request signature`) are signing bugs and stay on the generic auth/revoked
path. See [request-signature.md](./request-signature.md#client-side-clock-skew-diagnostics).

## API health preflight before mutations

`mindvault_register`, `mindvault_publish` (non-dry-run), and
`mindvault_rotate_publisher_key` mutate server-side state, so they run a light
reachability probe (`GET /resources`) first. When the MindVault API is down the
tool call is refused up front instead of failing mid-mutation with a bare
transport error:

```text
mindvault_register was not attempted because the MindVault API is not reachable (Returned HTTP 503).
Source: MindVault API · Category: network
Next: Check network connectivity to the MindVault API and retry; if it stays down the mutation cannot succeed, so defer it.
```

Dry-run publish skips the probe and does not touch the network. Dry-run buy also
skips this generic probe, but reads `GET /resources/{id}/meta` to obtain the
quoted price and apply the same automatic-payment ceiling as a live buy. It
does not submit a payment.

## Soft failures are not errors

Outcomes that are expected rather than broken stay **successful** tool results
with `isError` unset. The clearest case is an on-chain miss: `mindvault_registry_lookup`
for an unregistered resource returns JSON with `found: false` and a `next` field
carrying the same recovery action a hard error would have given. An empty on-chain
page from `mindvault_registry_list` is also a soft success: JSON with `count: 0`,
a `message` explaining the range is empty, and `resources: []` (not an MCP error).

```json
{
  "source": "on-chain",
  "found": false,
  "resourceId": "res-missing",
  "message": "Resource \"res-missing\" is not registered on-chain. …",
  "next": "The resource is not registered on-chain. Publish it, or run mindvault_register_onchain to register an already-verified resource."
}
```

## Sponsored-account outages

`mindvault_setup_wallet` depends on a single external service — the
sponsored-account service that mints and funds the Stellar account — so an
outage there blocks an agent at its first call. That failure carries an extra
diagnostics line between the summary and `Next:`:

```
mindvault_setup_wallet failed to create wallet: service temporarily unavailable
Service: https://stellar-sponsored-agent-account.onrender.com · Endpoint: POST /create · Status: 503 · Issue: unavailable · Reachable: yes · Retryable: yes
Source: sponsored-account service · Category: server · HTTP 503
Next: The account sponsorship service is unavailable; it may be restarting. Wait for it to come back and retry. No wallet was persisted locally, so retrying is safe — but it creates a NEW account: if the service already funded one before failing, that account is orphaned (its secret key was never delivered) and cannot be recovered or spent.
```

`Issue` is the field to branch on:

| Issue          | When                                                   | Retryable         |
| -------------- | ------------------------------------------------------ | ----------------- |
| `unreachable`  | DNS failure, refused connection — nothing answered     | yes               |
| `timeout`      | Connected, but no response within the budget           | yes               |
| `unavailable`  | 502 / 503 / 504 — the service is down or restarting    | yes               |
| `rate_limited` | 429                                                    | yes, after a wait |
| `server_error` | Any other 5xx                                          | yes               |
| `rejected`     | Any 4xx other than 429 — a decision about this request | no                |
| `unknown`      | Anything unclassifiable                                | yes, once         |

`Reachable: no` means the service never produced a response, so there is no
`Status:` field — the two most common outages (the host being unreachable and
the request timing out) never reach the HTTP path at all.

`Retryable: no` means repeating the identical call will fail the same way; the
guidance then names the configuration to fix rather than a wait to sit out. When
the service sends a `Retry-After` header, its value is echoed as `Retry-After:
<n>s` and repeated in the guidance.

### Half-completed creation (#839)

This page used to say wallet creation "is never partially applied: every outage
above leaves no wallet behind, so a retry is safe." The second half is true. The
first half is not something this server can know.

Account creation is one non-idempotent POST. When it times out, or answers 5xx
from a hop in front of the service, the request may already have been processed:
the account can be minted and funded while the reply carrying its **secret key**
is lost. Nothing is persisted locally either way, so retrying is safe for the
agent — but it mints a _new_ account, and the earlier one is **orphaned**:
without its secret key nobody can spend from it, ever. The guidance says so
rather than implying there is a funded wallet to go and find.

`unreachable` is the one case where nothing can have run, and its guidance says
that plainly.

A 200 is also not proof the service finished. A half-completed creation can
answer with an address whose secret key is missing, malformed, or belongs to a
different account. Persisting that gives the agent a wallet it cannot sign for,
and everything downstream reports it as healthy — `mindvault_wallet_info` shows
the address, queries Horizon, and reports a real balance for funds the agent can
never spend. So the keypair is verified before anything is stored: the address
must be derivable from the secret key received with it.

```
mindvault_setup_wallet refused the wallet returned by https://sponsor.example:
the response carried the address GABC… but no secret key, so this agent cannot
sign for it. Nothing was persisted — the local keystore is unchanged. If the
service already funded that account, it is orphaned: without the matching secret
key nobody can spend from it, and retrying creates a new account rather than
recovering it. …
```

The same check runs over the _stored_ keypair whenever `mindvault_wallet_info`
reports a balance, because a profile can reach that broken shape through a
hand-edited state file or a backup restored from another profile:

```
USDC Balance: 25.0
⚠ Keystore: This profile's stored secret key does not own this address (…).
Any balance shown here is NOT spendable by this agent: payments will fail at
signing. Run mindvault_import_wallet with the correct secret key, or
mindvault_setup_wallet to create a new wallet.
```

`mindvault_wallet_info`'s structured output carries the same fact as
`ownsAddress`, so an agent can branch on it without parsing prose.

Finally, a failed state-file write no longer reports success: when the wallet is
created but `~/.mindvault/state.json` cannot be written, the reply says the
wallet is in memory only and will be lost when the server stops, and points at
`mindvault_backup_state`.

### What is withheld

The service's error body is quoted only through its conventional message fields
(`error`, `message`, `detail`, `reason`), bounded to 200 characters and passed
through the same secret redaction as the startup diagnostics. A body with none
of those fields is summarized by shape — `an error body with no message field
(2 fields withheld)` — so an upstream stack trace or internal error code cannot
reach the agent. Credentials embedded in `SPONSORED_ACCOUNT_URL` are stripped
from the `Service:` field for the same reason.

## Relationship to the MCP error result

Mapping decides the _text_ and structured troubleshooting payload. The CallTool
handler owns the envelope (see
[mcp-integration-harness.md](mcp-integration-harness.md#error-handling-contract)):
a thrown tool error becomes `isError: true` with the text prefixed `Error:`, and
the message passes through `safeErrorMessage` so no wallet secret or API key can
appear in it. Mapped errors add `structuredContent.troubleshooting`; unmapped
errors retain the existing text-only envelope.

## Coverage

- [`mcp/src/errorMapping.test.ts`](../mcp/src/errorMapping.test.ts) — the pure mapper
- [`mcp/src/toolErrors.test.ts`](../mcp/src/toolErrors.test.ts) — real tools emitting
  the mapped shape for network failure, 402, contract NotFound, and validation
- [`mcp/src/sponsoredDiagnostics.test.ts`](../mcp/src/sponsoredDiagnostics.test.ts) —
  sponsored-account outage classification, redaction, and `Retry-After` parsing
