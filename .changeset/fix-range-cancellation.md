---
"@ontos-ai/knowhere-sdk": patch
---

Cancel all Range reads and owned decoder output streams when an archive read fails or synchronization is aborted. This prevents cache validation failures from waiting indefinitely on decoder cleanup, preserves contiguous checkpoints and cache bypass for retry, and reports non-206 cache responses with their HTTP status.
