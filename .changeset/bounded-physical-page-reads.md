---
'@ontos-ai/knowhere-sdk': minor
---

Add bounded physical-page reads and complete snapshot summaries for local and stored parsed snapshots. Select chunks before rich normalization and asset URL hydration, preserve physical pages and chunk identity, and expose a body-free document index with explicit embedded ownership for progressive readers. Add `knowledge.getDocumentSummary(reference)` to load the complete verified metadata index independently of rich chunk construction, table/image files, navigation bodies, and asset URL generation; remote-only references require a prepared or synchronized snapshot.
