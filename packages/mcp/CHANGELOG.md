# @ontos-ai/knowhere-mcp

## 2.1.3

### Patch Changes

- [#113](https://github.com/Ontos-AI/knowhere-node-sdk/pull/113) [`e2bc39a`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/e2bc39a8ad97547590ffc843986bb4e3fba6d035) Thanks [@suguanYang](https://github.com/suguanYang)! - Improve MCP read guidance for page assets and default durable asset URLs for display reads.

- Updated dependencies [[`cebe98a`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/cebe98ad6dd997b481e0a4536c3fb26ef4594cfb)]:
  - @ontos-ai/knowhere-sdk@2.1.3

## 2.1.2

### Patch Changes

- [#115](https://github.com/Ontos-AI/knowhere-node-sdk/pull/115) [`8b7ccca`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/8b7cccaadef54396dcfece2c2ba260e3bf0c20ec) Thanks [@suguanYang](https://github.com/suguanYang)! - Replace the SDK parsed-document storage adapter with a result-relative object interface and store committed parsed results as expanded Knowhere result files (`manifest.json`, `chunks.json`, optional sidecars, and assets) instead of SDK-specific paged snapshots.

  Remove `assetUrlPolicy` from `knowledge.readChunks` and the MCP `knowhere_read_chunks` schema. SDK remote chunk reads now always request asset URLs from Knowhere, return those remote asset URLs directly on storage misses, and only rewrite asset URLs to storage object URLs when a configured parsed storage already has the corresponding object.

- Updated dependencies [[`8b7ccca`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/8b7cccaadef54396dcfece2c2ba260e3bf0c20ec)]:
  - @ontos-ai/knowhere-sdk@2.1.2

## 2.1.1

### Patch Changes

- [#111](https://github.com/Ontos-AI/knowhere-node-sdk/pull/111) [`5577c2d`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/5577c2de974a5425e048e36da0a2ca5885743c75) Thanks [@suguanYang](https://github.com/suguanYang)! - Preserve page citation asset descriptors only in chunk metadata, remove the deprecated SDK-side page citation asset generation options, and split local-cache/server-safe result handling into explicit `knowledge.parseToLocalCache(...)`, `knowledge.importJobResult(...)`, and `knowledge.loadJobResult(...)` methods.

- [#111](https://github.com/Ontos-AI/knowhere-node-sdk/pull/111) [`2d006ae`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/2d006ae8e21db6e1a27e88c91f1a250da7e1f541) Thanks [@suguanYang](https://github.com/suguanYang)! - Move parsed document reads to a storage-first SDK model with remote chunk fallback.

  Adds parsed snapshot storage types, `knowledge.withParsedStorage(...)`,
  `knowledge.syncParsedDocument(...)`, paged `readChunks(...)` display params,
  durable asset URL hardening, bounded remote grep/outline fallback, and explicit
  disk parsed storage for MCP cache-directory usage.

- Updated dependencies [[`5577c2d`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/5577c2de974a5425e048e36da0a2ca5885743c75), [`2d006ae`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/2d006ae8e21db6e1a27e88c91f1a250da7e1f541)]:
  - @ontos-ai/knowhere-sdk@2.1.1

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
