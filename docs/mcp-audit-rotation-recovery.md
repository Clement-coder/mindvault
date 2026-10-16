# Audit rotation restart recovery

Audit logging uses numbered JSONL generations (`audit.jsonl`, `.1`, `.2`, etc.). A process may stop after the live file is renamed to `.1` but before the next append. On restart, a missing live file is a valid state: the writer creates a new live file without copying `.1` back, avoiding duplicate entries.

Focused regression tests simulate restart after moving the live file, after shifting an older generation, and after a normal append. They verify records in those scenarios remain distinct.

**Limitation:** These scenarios do not yet prove crash safety at every rotation boundary, especially when removing the oldest generation or during multi-step generation shifts. A fully crash-safe scheme needs an explicit recovery protocol or durable rotation journal. This branch should not be merged as a complete resolution of #1043 until those cases are implemented and verified.
