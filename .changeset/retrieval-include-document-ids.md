---
"@ontos-ai/knowhere-sdk": minor
---

Add `includeDocumentIds` to retrieval queries so callers can restrict one request to an explicit document set. Empty arrays are preserved on the wire; omitted means unrestricted; exclusions still win.
