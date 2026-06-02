---
"@ontos-ai/knowhere-sdk": patch
---

Make `RetrievalResult.score` nullable (`number | null`) to align with the updated API contract.

The agentic retrieval route now returns `null` for `score` on chunks found
only through KG navigation (no BM25 discovery score available). Consumers
should treat `null` as "no score available" rather than assuming high relevance.
