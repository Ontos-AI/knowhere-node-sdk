---
'@ontos-ai/knowhere-sdk': patch
'@ontos-ai/knowhere-mcp': patch
---

Replace the SDK parsed-document storage adapter with a result-relative object interface and store committed parsed results as expanded Knowhere result files (`manifest.json`, `chunks.json`, optional sidecars, and assets) instead of SDK-specific paged snapshots.

Remove `assetUrlPolicy` from `knowledge.readChunks` and the MCP `knowhere_read_chunks` schema. SDK remote chunk reads now always request asset URLs from Knowhere, return those remote asset URLs directly on storage misses, and only rewrite asset URLs to storage object URLs when a configured parsed storage already has the corresponding object.
