# Support Bundle Export (`mindvault_support_bundle`)

`mindvault_support_bundle` produces one document an agent or operator can attach
to a support ticket for a single incident without first scrubbing it by hand.
An incident is identified by the correlation ID of the failing tool call
(#572): the audit log stamps that ID on the call's `start`, on every network
request it made, and on its `success` or `error`, so the bundle is exactly the
material belonging to that one call. It gathers the matched audit entries, the
request traces, the metrics snapshot, profile metadata and the incident's time
range, and applies the redaction rules below before anything is returned.

Source: [`mcp/src/supportBundle.ts`](../mcp/src/supportBundle.ts).

The tool is local and read-only: no network calls, no wallet required, no state
changes. It is the natural next call after a tool fails and returns a
correlation ID in its error message (see
[correlation IDs](mcp-correlation-ids.md)).

## Arguments

| Argument     | Type    | Meaning                                                                                |
| ------------ | ------- | -------------------------------------------------------------------------------------- |
| `incidentId` | string  | Required. The correlation ID (typically `mv-…`) of the incident to scope the bundle to |
| `auditLines` | integer | Matched audit entries to include (0 to 500, default 200); 0 omits the audit section    |

`incidentId` is required and a missing or blank value is rejected: the tool
never produces an unscooped dump by accident. It is usually a correlation ID
minted by the server (format `mv-…`, see
[`mcp/src/correlation.ts`](../mcp/src/correlation.ts)), but any id string is
accepted so bundles can also be scoped to an id from an external system.

## What is included

Every section is scoped to `incidentId` and bounded:

- `incident` — the requested id (echoed as `incidentId` and `correlationId`),
  whether it has the `mv-…` correlation-id shape, the number of matched audit
  and network entries, and the first and last timestamps covered. A `note`
  explains an empty result.
- `logs.entries` — the audit entries whose `correlationId` equals the incident
  id, oldest first, capped at `auditLines`. Only the last 512 KiB of
  `MINDVAULT_AUDIT_LOG_FILE` is read, and `logs.truncated` is true when older
  history was omitted by that bound or by the line cap.
- `traces.entries` — the matched network-audit entries (those carrying a
  `method`/`source` shape: `endpoint`, `status`, `duration`, `source`), which
  are the incident's request traces.
- `metrics` — the `mindvault_metrics` snapshot, reporting `enabled: false` when
  `MINDVAULT_METRICS` is off.
- `profiles.entries` — each profile as `name`, `active`, `hasWallet`,
  `publicKey` and `hasApiKey`.
- `redaction` — the `rules` applied and the `maskedFields` paths (for example
  `logs.entries[1].details.leaked`) that were replaced.

Public keys, contract ids and network ids are kept on purpose. A bundle that
hides `GDNK…` and `CDQK…` cannot show that the wallet is on one network and the
registry on another, which is the most common thing a bundle is opened to find.

## What is never included

- Wallet secret keys and publisher API keys: profiles carry the public key
  only, so key material is never read into the bundle.
- Data from any other incident: only entries whose `correlationId` equals
  `incidentId` are included, so unrelated calls and users are out of scope.
- Credential-named fields and long opaque strings inside matched entries: the
  object redactor masks field names containing `secret`, `key`, `token`,
  `password`, `bearer` or `authorization`, and strips long secret-shaped
  strings.
- Anything shaped like a Stellar secret key (`S` followed by 55 base32
  characters): a final sweep replaces it wherever it appears in the serialised
  document.
- Unrelated environment variables and unrelated user data: they are never read.

## The envelope

```json
{
  "schema": "mindvault.support-bundle/v1",
  "generatedAt": "2026-09-25T12:01:00.000Z",
  "incidentId": "mv-mfs0w0-i0-3z4y1q",
  "incident": {
    "incidentId": "mv-mfs0w0-i0-3z4y1q",
    "correlationId": "mv-mfs0w0-i0-3z4y1q",
    "isCorrelationId": true,
    "matchedEntries": 3,
    "matchedNetworkEntries": 1,
    "firstTimestamp": "2026-09-25T12:00:00.000Z",
    "lastTimestamp": "2026-09-25T12:00:02.000Z",
    "note": null
  },
  "logs": {
    "requested": 200,
    "returned": 3,
    "truncated": false,
    "entries": [
      { "timestamp": "2026-09-25T12:00:00.000Z", "status": "start", "toolName": "mindvault_buy" }
    ]
  },
  "metrics": {
    "enabled": false,
    "since": null,
    "toolDurationBudgetMs": null,
    "totals": {},
    "payments": {},
    "tools": {}
  },
  "profiles": {
    "active": "default",
    "entries": [
      {
        "name": "default",
        "active": true,
        "hasWallet": true,
        "publicKey": "GDNK…",
        "hasApiKey": true
      }
    ]
  },
  "traces": {
    "returned": 1,
    "entries": [
      {
        "timestamp": "2026-09-25T12:00:01.500Z",
        "method": "GET",
        "endpoint": "https://horizon-testnet.stellar.org/accounts/GDNK…",
        "status": 200,
        "duration": 42,
        "source": "horizon"
      }
    ]
  },
  "redaction": {
    "maskedFields": [],
    "rules": [
      "Only audit and network entries whose correlationId equals the incident id are included; ..."
    ]
  }
}
```

The tool advertises an `outputSchema`, so the same object also arrives as MCP
`structuredContent`.

## Filing a report

1. Quote the correlation ID from the failed tool call's error message.
2. Call `mindvault_support_bundle` with `incidentId` set to that ID (raise
   `auditLines` if the failure is a few calls back).
3. Skim `redaction.maskedFields` and `profiles`; if you still see something you
   do not want to share, there is nothing else to remove.
4. Attach the JSON. `incident` and `traces` show what the call did and where it
   went, so a maintainer can usually answer from the bundle alone.

## Tests

`mcp/src/supportBundle.test.ts` asserts that a missing or blank `incidentId`
throws, that an entry logged under another correlation id is never included,
and that a no-match case returns an empty `entries` array plus a `note`. It
places a wallet secret and a publisher API key in a profile and in an
audit-log line and asserts they are absent from the serialised output while the
public key and contract id survive. It checks the builder is deterministic for
a fixed input, that `auditLines` clamps to the 500 cap and reports truncation,
and that the produced payload validates against the advertised output schema.
