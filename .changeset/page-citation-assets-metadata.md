---
"@ontos-ai/knowhere-sdk": major
"@ontos-ai/knowhere-mcp": major
---

Preserve page citation asset descriptors only in chunk metadata, remove the deprecated SDK-side page citation asset generation options, and split local-cache/server-safe result handling into explicit `knowledge.parseToLocalCache(...)`, `knowledge.importJobResult(...)`, and `knowledge.loadJobResult(...)` methods.
