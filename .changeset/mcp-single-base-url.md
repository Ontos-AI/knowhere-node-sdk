---
"@ontos-ai/knowhere-mcp": minor
---

Use a single base URL for the MCP client. `--base-url` / `KNOWHERE_BASE_URL`
now takes the Knowhere site base (default `https://knowhereto.ai`), and the API
(`<base>/api`), login (`<base>/mcp/login`), and OAuth token/revoke
(`<base>/api/oauth/*`) routes are all derived from it. This matches the
Knowhere CLI's configuration model.

BREAKING: the `--dashboard-url` flag and `KNOWHERE_DASHBOARD_URL` env var are
removed, and the separate API-base option is folded into `--base-url`. The
stored auth file now records `baseUrl` instead of `dashboardUrl`/`apiBaseUrl`,
so existing logins are invalidated — run `knowhere-mcp login` again. Token and
revoke calls now target `/api/oauth/*` (the dashboard keeps `/api/mcp/*` as
aliases).
