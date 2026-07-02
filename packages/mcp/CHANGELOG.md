# @ontos-ai/knowhere-mcp

## 2.1.0

### Minor Changes

- [#105](https://github.com/Ontos-AI/knowhere-node-sdk/pull/105) [`7d8f05b`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/7d8f05ba7b6dddd252206347be31a568abca22bb) Thanks [@suguanYang](https://github.com/suguanYang)! - Change `knowhere_list_documents` to list published documents from the remote Knowhere API instead of local cache entries.

## 2.0.0

### Major Changes

- Move the MCP wrapper to the SDK 2.0.0 v2-only page-memory API behavior. MCP
  parse operations now follow the SDK's `/v2` API flow, while local read,
  outline, grep, and search tools can still inspect legacy v1 result ZIP chunk
  formats.

## 0.4.2

### Patch Changes

- Updated dependencies [[`85bdcc2`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/85bdcc277c75d60cd9a470eb67c5927c09b187cf)]:
  - @ontos-ai/knowhere-sdk@0.10.0

## 0.4.1

### Patch Changes

- [#103](https://github.com/Ontos-AI/knowhere-node-sdk/pull/103) [`bb8b4d0`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/bb8b4d037465aef1f32726902932500405e9c12d) Thanks [@suguanYang](https://github.com/suguanYang)! - Guide agents to poll asynchronous parse jobs with bounded exponential backoff, including a 120 second cap for large or OCR-heavy files that can take 10+ minutes to complete, and document the read-tool result directory path for direct chunk file access.

## 0.4.0

### Minor Changes

- [#101](https://github.com/Ontos-AI/knowhere-node-sdk/pull/101) [`ae30b28`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/ae30b28036b31e1c9f3c1a22b49f282d73e7d2a3) Thanks [@suguanYang](https://github.com/suguanYang)! - Add remote document and completed job references to local read helpers. Published document IDs now resolve the current published job ID and cache the parser result ZIP before outline/read/grep operations, and the MCP read tools accept document IDs and job IDs directly while no longer exposing the redundant manual cache-job tool.

### Patch Changes

- Updated dependencies [[`ae30b28`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/ae30b28036b31e1c9f3c1a22b49f282d73e7d2a3)]:
  - @ontos-ai/knowhere-sdk@0.9.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`1abc74b`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/1abc74b4b35f38ba1748781da78e9b5e07552c45)]:
  - @ontos-ai/knowhere-sdk@0.8.0

## 0.3.0

### Minor Changes

- [#97](https://github.com/Ontos-AI/knowhere-node-sdk/pull/97) [`ba79b06`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/ba79b0603410611da8c26874e047915b1e955898) Thanks [@suguanYang](https://github.com/suguanYang)! - Use a single base URL for the MCP client. `--base-url` / `KNOWHERE_BASE_URL`
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

## 0.2.0

### Minor Changes

- [#93](https://github.com/Ontos-AI/knowhere-node-sdk/pull/93) [`f238240`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/f2382405df0d9222772e1c70d5dd93bce1dbaa75) Thanks [@suguanYang](https://github.com/suguanYang)! - Add SDK-owned local knowledge tools for parse-result caching, outline, read,
  grep, and search, plus a separate MCP wrapper package that exposes those SDK
  tools over stdio. Add dashboard-login support for the stdio MCP package and a
  dynamic bearer-token provider for short-lived SDK authentication flows.

- [#94](https://github.com/Ontos-AI/knowhere-node-sdk/pull/94) [`f7c95eb`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/f7c95eb0d6cf37be5c85a85e93e052fc48bc9b3b) Thanks [@suguanYang](https://github.com/suguanYang)! - Apply Dashboard login permissions to the stdio MCP server so read-only tokens
  expose only query and document-read tools while full-access tokens keep parse
  and delete tools available.

### Patch Changes

- Updated dependencies [[`f238240`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/f2382405df0d9222772e1c70d5dd93bce1dbaa75), [`ce518a5`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/ce518a5c90e85d2c0ca3c2c6bd27309f648e8826)]:
  - @ontos-ai/knowhere-sdk@0.7.0
