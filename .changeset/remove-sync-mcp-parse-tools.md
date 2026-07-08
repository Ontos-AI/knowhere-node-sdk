---
"@ontos-ai/knowhere-mcp": major
---

Remove the blocking `knowhere_parse_url` and `knowhere_parse_file` tools from the MCP server. Agents should use the async parse tools and poll `knowhere_async_get_job_status` before reading parsed results.
