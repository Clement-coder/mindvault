# Audit rotation restart recovery

The synchronous JSONL writer now journals each size-triggered rotation in `audit.jsonl.rotation-journal`. It moves the live log and numbered generations to `.rotation-stage-N` files before publishing the next generation names. On restart, the writer detects a journal and resumes the remaining steps before appending another event.

A staging journal is replayed by moving only sources that have not already been staged. A publishing journal is replayed by moving remaining staged files into numbered generation slots. This avoids treating a missing live file as missing history and prevents completed renames from being repeated.

Fault-injection tests model restarts at each rename boundary in both phases, as well as ordinary restarts. The generation limit still intentionally discards the oldest record generation. The file sink remains optional and does not change MCP client schemas.

**Durability caveat:** The implementation uses synchronous file operations and rename, but does not fsync files or directories; sudden power loss or filesystem corruption can still affect durability. CI tests are pending.
