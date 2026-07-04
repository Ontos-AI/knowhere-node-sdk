---
"@ontos-ai/knowhere-sdk": minor
"@ontos-ai/knowhere-mcp": minor
---

Move parsed document reads to a storage-first SDK model with remote chunk fallback.

Adds parsed snapshot storage types, `knowledge.withParsedStorage(...)`,
`knowledge.syncParsedDocument(...)`, paged `readChunks(...)` display params,
durable asset URL hardening, bounded remote grep/outline fallback, and explicit
disk parsed storage for MCP cache-directory usage.
