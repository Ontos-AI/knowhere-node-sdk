# Changelog

## 0.9.0

### Minor Changes

- [#101](https://github.com/Ontos-AI/knowhere-node-sdk/pull/101) [`ae30b28`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/ae30b28036b31e1c9f3c1a22b49f282d73e7d2a3) Thanks [@suguanYang](https://github.com/suguanYang)! - Add remote document and completed job references to local read helpers. Published document IDs now resolve the current published job ID and cache the parser result ZIP before outline/read/grep operations, and the MCP read tools accept document IDs and job IDs directly while no longer exposing the redundant manual cache-job tool.

## 0.8.0

### Minor Changes

- [#99](https://github.com/Ontos-AI/knowhere-node-sdk/pull/99) [`1abc74b`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/1abc74b4b35f38ba1748781da78e9b5e07552c45) Thanks [@suguanYang](https://github.com/suguanYang)! - Add `documentMetadata` parse/job creation support and preserve planned `documentId` on job creation responses.

## 0.7.0

### Minor Changes

- [#93](https://github.com/Ontos-AI/knowhere-node-sdk/pull/93) [`f238240`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/f2382405df0d9222772e1c70d5dd93bce1dbaa75) Thanks [@suguanYang](https://github.com/suguanYang)! - Add SDK-owned local knowledge tools for parse-result caching, outline, read,
  grep, and search, plus a separate MCP wrapper package that exposes those SDK
  tools over stdio. Add dashboard-login support for the stdio MCP package and a
  dynamic bearer-token provider for short-lived SDK authentication flows.

### Patch Changes

- [#95](https://github.com/Ontos-AI/knowhere-node-sdk/pull/95) [`ce518a5`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/ce518a5c90e85d2c0ca3c2c6bd27309f648e8826) Thanks [@suguanYang](https://github.com/suguanYang)! - Include the repository root in the pnpm workspace (`pnpm-workspace.yaml`) so
  Changesets can resolve the root `@ontos-ai/knowhere-sdk` package during the
  release flow. Previously `changeset version` failed with "Found changeset for
  package @ontos-ai/knowhere-sdk which is not in the workspace", blocking the
  release PR and publish.

## 0.6.0

### Minor Changes

- [#84](https://github.com/Ontos-AI/knowhere-node-sdk/pull/84) [`448e026`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/448e026090c42a12741cdf0f656deb5ec49fe419) Thanks [@EricNGOntos](https://github.com/EricNGOntos)! - Add agentic context fields (evidenceText, stopReason, failureReason) to RetrievalQueryResponse

### Patch Changes

- [#90](https://github.com/Ontos-AI/knowhere-node-sdk/pull/90) [`1d62d1c`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/1d62d1c31fbb32b265fc5694a43b16ab689d61c1) Thanks [@EricNGOntos](https://github.com/EricNGOntos)! - Make `RetrievalResult.score` nullable (`number | null`) to align with the updated API contract.

  The agentic retrieval route now returns `null` for `score` on chunks found
  only through KG navigation (no BM25 discovery score available). Consumers
  should treat `null` as "no score available" rather than assuming high relevance.

## 0.5.1

### Patch Changes

- [#85](https://github.com/Ontos-AI/knowhere-node-sdk/pull/85) [`25b8c30`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/25b8c303c0e0fb19965c45c0ca83651eb46d7e3c) Thanks [@suguanYang](https://github.com/suguanYang)! - Sync retrieval response types with the current API contract, including evidence text, stop/failure reasons, and typed referenced chunks.

## 0.5.0

### Minor Changes

- [#82](https://github.com/Ontos-AI/knowhere-node-sdk/pull/82) [`c454a57`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/c454a57e50a15e6b48de8d7ad4d4dc10909d7cdc) Thanks [@suguanYang](https://github.com/suguanYang)! - Sync SDK with current worker ZIP contract and agentic retrieval API:
  - Add `DocNav` types for `doc_nav.json` with section tree and resource summaries
  - Expose `HIERARCHY` field on manifest from current worker output
  - Add `documentTopSummary` to all chunk types
  - Mark legacy fields (`tableType`, `chunksSlim`, `hierarchy`) as deprecated
  - Add `useAgentic` parameter to retrieval query
  - Add `answerText` and `referencedChunks` to retrieval response

## 0.4.0

### Minor Changes

- [#69](https://github.com/Ontos-AI/knowhere-node-sdk/pull/69) [`ff5810e`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/ff5810e2b586e1e699618819870703b8528f025f) Thanks [@suguanYang](https://github.com/suguanYang)! - Add document chunk list and get helpers for current document revisions.

## 0.3.1

### Patch Changes

- [#66](https://github.com/Ontos-AI/knowhere-node-sdk/pull/66) [`9dc15d3`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/9dc15d349e70c6a560c07004d14f11492e8ded87) Thanks [@suguanYang](https://github.com/suguanYang)! - Harden the public open-source surface for the Node SDK by adding community
  files and templates, cleaning the README wording, and updating the runtime
  Axios dependency to a non-vulnerable range.

- [#47](https://github.com/Ontos-AI/knowhere-node-sdk/pull/47) [`1171b1a`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/1171b1af9e74f85d481a0dab3b91a3daba53fed9) Thanks [@dependabot](https://github.com/apps/dependabot)! - Refresh the ESLint 10 toolchain and add the explicit flat-config dependency
  needed by the new lint setup.

- [#68](https://github.com/Ontos-AI/knowhere-node-sdk/pull/68) [`c0e047c`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/c0e047cb73866a12b26ba8623ce2b1736f747193) Thanks [@suguanYang](https://github.com/suguanYang)! - Refresh the TypeScript ESLint toolchain and update tests to satisfy the
  stricter lint rules introduced by the newer release.

## 0.3.0

### Minor Changes

- [#63](https://github.com/Ontos-AI/knowhere-node-sdk/pull/63) [`a4120b0`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/a4120b0f356ab35f46333a74c27464e359e7314c) Thanks [@suguanYang](https://github.com/suguanYang)! - Add retrieval query and canonical document lifecycle resources, including the new retrieval response contract with `result.source.*`.

## 0.2.1

### Patch Changes

- [#53](https://github.com/Ontos-AI/knowhere-node-sdk/pull/53) [`765204b`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/765204b5354cd2cdc052e532113751dbf242d324) Thanks [@suguanYang](https://github.com/suguanYang)! - Update `TextChunk.tokens` to match the current API payload shape of `string[]`, and normalize legacy numeric token values out of parsed results so the runtime contract matches the published TypeScript types.

## 0.2.0

### Minor Changes

- [#44](https://github.com/Ontos-AI/knowhere-node-sdk/pull/44) [`74f9a79`](https://github.com/Ontos-AI/knowhere-node-sdk/commit/74f9a794f0cdc11fa286d711710cbf9296497304) Thanks [@suguanYang](https://github.com/suguanYang)! - Rename the published SDK package to `@ontos-ai/knowhere-sdk` and move releases to a Changesets-managed release PR workflow with manual beta snapshot publishes.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-02-12

### Fixed

- Corrected documentation links from `https://knowhereto.ai/docs` to `https://docs.knowhereto.ai`
- Removed references to non-existent files:
  - API.md (API reference)
  - examples/progress.ts (progress tracking example)
  - CONTRIBUTING.md (contributing guide)

## [0.1.0] - 2026-02-12

### Added

- Initial release
- Core SDK functionality for Knowhere document parsing API
- Jobs resource API with full CRUD operations
- High-level `parse()` method for simplified document parsing
- Stream-based file uploads with multipart/form-data support
- Automatic retries with exponential backoff (configurable)
- Adaptive polling for job status with configurable intervals
- Advanced parsing parameters (page ranges, OCR settings, document intelligence)
- Complete TypeScript type definitions with full IntelliSense support
- Comprehensive error handling hierarchy:
  - `KnowhereError` - Base error class
  - `APIError` - HTTP and API errors
  - `ValidationError` - Input validation errors
  - `NetworkError` - Network connectivity errors
  - `JobError` - Job-specific errors
  - `ParseError` - Result parsing errors
- Result parsing from ZIP archives with automatic extraction
- Comprehensive test coverage (199 tests, 90.66% coverage)
- Full support for CommonJS and ES Modules

### Changed

- Updated Node.js requirement to >=20.19.0 (for Vitest 4 compatibility)
- Migrated from ESLint 8 to ESLint 9 with flat config format
- Upgraded TypeScript ESLint from v7 to v8
- Upgraded Vitest to v4.0.18
- Upgraded @types/node to v25.2.3

### Infrastructure

- Added package-lock.json to git for CI dependency caching
- Configured comprehensive pre-publish checks (lint, typecheck, test, build)
- Set up dual-format builds (CJS + ESM) with TypeScript declarations
- Configured ESLint with strict TypeScript rules
- Set up Prettier for consistent code formatting
- Configured Vitest with v8 coverage reporting
