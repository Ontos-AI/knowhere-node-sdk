---
'@ontos-ai/knowhere-sdk': minor
---

Stream remote parsed-document ZIP entries into storage without loading a full ParseResult. Add optional stream sinks, resumable entry checkpoints, bounded sync batches, cancellation, revision/archive validation, and optional exact ZIP retention. Preserve result-relative object paths and commit markers. Extract existing ParseResult snapshots lazily without duplicate asset buffers. Servers without Range support use a sequential reader and temporary disk for final ZIP integrity validation.
