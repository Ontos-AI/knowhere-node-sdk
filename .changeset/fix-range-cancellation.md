---
'@ontos-ai/knowhere-sdk': patch
---

Cancel all Range reads and owned decoder output streams when an archive read fails or synchronization is aborted. This prevents cache validation failures from waiting indefinitely on decoder cleanup, preserves contiguous checkpoints and cache bypass for retry, and reports non-206 cache responses with their HTTP status.

Abort invalid prefetched Range responses before a decoder reads them, and propagate archive transport cancellation to storage adapters waiting for capacity. Preserve cached-setup fallback and retry checkpoints.

Tag beta releases with the checked-out source commit when the workflow dispatch ref differs from the selected build ref.
