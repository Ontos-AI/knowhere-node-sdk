---
"@ontos-ai/knowhere-sdk": patch
"@ontos-ai/knowhere-mcp": patch
---

Auto-attach official `created_by_client` / `client_version` document metadata on job creates so OSS telemetry can attribute client mix. Caller-provided metadata still wins.
