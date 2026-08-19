---
"@ontos-ai/knowhere-sdk": patch
"@ontos-ai/knowhere-mcp": patch
---

Copy source-chunk `pageNumbers` onto `knowledge.grepChunks` matches so clients can label citations without a follow-up `readChunks` call.
