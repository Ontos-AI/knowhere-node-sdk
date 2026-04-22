# Changelog

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
