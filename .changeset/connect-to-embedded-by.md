---
"@ontos-ai/knowhere-sdk": patch
---

Align `ConnectTo.relation` with the API schema: add `embedded_by` (and reserved relation values), `targetDocumentId`, and `position`. Drop unused `score`/`keywords` fields that the API no longer emits.
