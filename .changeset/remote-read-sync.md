---
'@ontos-ai/knowhere-sdk': minor
'@ontos-ai/knowhere-mcp': minor
---

Add remote document and completed job references to local read helpers. Published document IDs now resolve the current published job ID and cache the parser result ZIP before outline/read/grep operations, and the MCP read tools accept document IDs and job IDs directly while no longer exposing the redundant manual cache-job tool. Async parse/status tool descriptions now guide agents to poll long-running parse jobs with bounded exponential backoff for large or OCR-heavy files.
