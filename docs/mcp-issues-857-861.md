# MCP issues 857-861

## Sponsored mutation ceilings

`mindvault_buy` continues to enforce `MINDVAULT_MAX_AUTO_PAY_USDC`. Registry registration also checks the unsigned transaction fee against `MINDVAULT_MAX_AUTO_FEE_STROOPS` (default `100000`) before signing. A rejected fee is never signed or submitted.

## Deterministic upstream errors

HTTP 5xx responses preserve their upstream source in the stable `Source · Category · HTTP` line. Transport aborts and timeout errors remain distinct from ordinary network failures, so Horizon outages and Soroban RPC deadlines can be diagnosed independently.

## Large receipt exports

`mindvault_export_receipts` participates in `MINDVAULT_TOOL_TIMEOUTS`, for example `export_receipts=120000`. The override is resolved through the same `timeoutForTool` path as publish and registration.

## Network-bound state restores

Wallet profiles record their Stellar network. Restore validates every network-bound profile against the active MCP network before replacing in-memory state or writing to disk. A mismatched backup fails without modifying the current state.
