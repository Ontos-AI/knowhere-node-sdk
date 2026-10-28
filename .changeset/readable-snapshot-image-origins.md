---
'@ontos-ai/knowhere-sdk': minor
---

Add durable readable snapshot preparation and authenticated, pinned image access before full image replication completes. Prefer certified local image replicas and keep archive checkpoints, completeness validation, and full-copy commits independent from the readable marker.

Batch selected image URL capabilities through the immutable snapshot API, avoiding one API authorization request per page. Expose `getParsedDocumentObjectUrls` for authorized application resource readers without reading image bodies.
