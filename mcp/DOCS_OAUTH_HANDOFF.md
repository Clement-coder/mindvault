# OAuth-style External Auth Handoff

This document describes a simple OAuth-style external authorization handoff pattern suitable for the MindVault MCP server. It is intentionally framework-agnostic and focuses on operator and integrator guidance: how the MCP can accept a short-lived external auth token via a browser flow and continue acting on behalf of the user.

Scope

- Location: this file is scoped to the `mcp/` package.
- Goal: document the handoff patterns and recommended endpoints for implementers and operators.

Background

- The MCP often acts as a bridge between interactive clients (browsers/agents) and backend services that require authentication.
- An OAuth-style handoff lets a browser user authenticate with an external provider (or operator UI), then hand a short-lived credential back to the MCP to attach to subsequent tool calls.

Recommended pattern

1. Start authorization
   - Client opens the operator UI or a special `/auth/start` endpoint which responds with a redirect URL to the external provider and a local `state` token.
   - The server stores a short-lived `state` value (UUID) mapped to a transient session (in-memory or redis) and returns the provider redirect URL.

2. External provider completes
   - Provider redirects back to a server callback, e.g. `/auth/callback?state=<state>&code=<code>`.
   - The server validates `state` matches the stored session, exchanges `code` for an access token (or accepted ephemeral token), and associates the token with the session.

3. Handoff to MCP agent client
   - The operator UI shows a short-lived agent token or a one-time code the user pastes into the client.
   - Alternatively the server provides a deep-link back to a browser-based agent endpoint with the token in the fragment portion (`#`) to avoid sending it to the server logs.

4. Using the token with MCP tools
   - The MCP accepts the token as an Authorization header (Bearer) or via a dedicated tool argument for tools that accept delegated credentials.
   - Tokens must be scoped and short-lived. The MCP should validate tokens on each use (local verification or via the provider) and never persist long-term without operator consent.

Security recommendations

- Use `state` to tie the callback to the original flow and prevent CSRF.
- Prefer the fragment (`#`) deep-link to avoid sending tokens to logs or servers that do not need them.
- Keep tokens short-lived (e.g. 60–300s) and bind them to the agent action where feasible.
- Use TLS everywhere and same-site cookies when applicable.
- Log only metadata (success/failure, user id) and never log tokens or secrets.

Examples

- Minimal operator UI flow
  - GET `/auth/start` → server returns { redirect: "https://provider/authorize?...&state=..." }
  - Provider → GET `/auth/callback?state=...&code=...`
  - Server exchanges `code` and shows one-time token: `mv-one-time:abc123` for client copy/paste.

MCP Integration notes

- The MCP can implement a read-only acceptance of such tokens by checking `Authorization: Bearer mv-one-time:...` and mapping it to a temporary in-memory session for the duration of the token.
- For the initial 2% change, prefer documenting the pattern and adding a minimal `auth` helper that recognizes `mv-one-time:` prefixes and treats them as non-persistent ephemeral tokens.

Tests and validation

- No code changes required for validation of `mcp/` in this documentation-only patch. If you later implement the helper, add unit tests to `mcp/src/` and include validation entries in `validation.ts`.

Next steps (optional)

- Implement a small `/auth/start` and `/auth/callback` pair under `mcp/scripts/` or `mcp/src/` with mock provider exchange for local testing.
- Add an ephemeral token parser and a unit test that accepts `mv-one-time:` bearer tokens for tool calls that support delegated auth.

</content>
