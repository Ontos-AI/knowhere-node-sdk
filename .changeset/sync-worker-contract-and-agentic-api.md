---
'@ontos-ai/knowhere-sdk': minor
---

Sync SDK with current worker ZIP contract and agentic retrieval API:

- Add `DocNav` types for `doc_nav.json` with section tree and resource summaries
- Expose `HIERARCHY` field on manifest from current worker output
- Add `documentTopSummary` to all chunk types
- Mark legacy fields (`tableType`, `chunksSlim`, `hierarchy`) as deprecated
- Add `useAgentic` parameter to retrieval query
- Add `answerText` and `referencedChunks` to retrieval response
