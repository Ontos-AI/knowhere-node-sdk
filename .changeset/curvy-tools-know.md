---
"@ontos-ai/knowhere-sdk": minor
"@ontos-ai/knowhere-mcp": minor
---

Add SDK-owned local knowledge tools for parse-result caching, outline, read,
grep, and search, plus a separate MCP wrapper package that exposes those SDK
tools over stdio. Add dashboard-login support for the stdio MCP package and a
dynamic bearer-token provider for short-lived SDK authentication flows.
