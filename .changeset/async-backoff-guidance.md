---
'@ontos-ai/knowhere-mcp': minor
---

Guide agents to poll asynchronous parse jobs with bounded exponential backoff, including a 120 second cap for large or OCR-heavy files that can take 10+ minutes to complete, and document the read-tool result directory path for direct chunk file access.

Change `knowhere_list_documents` to list published documents from the remote Knowhere API instead of local cache entries.
