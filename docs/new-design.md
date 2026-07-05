  # SDK Parsed Storage Redesign

  ## Summary
  Move parsed chunk read/sync behavior into the SDK so Notebook, CLI, and MCP share one model. Callers provide a parsed-document storage adapter; SDK reads storage first, falls back to Knowhere remote storage
  transparently, and schedules non-blocking storage sync on read misses. Parse flow is different: after parsing succeeds, SDK must sync to provided storage before the caller treats the document as complete/
  ready.

  ## Public SDK Shape
  - Keep `knowledge.readChunks`, `knowledge.grepChunks`, and `knowledge.getDocumentOutline` as the only public read methods; do not add public `readChunkPage`.
  - Extend `readChunks` with paged display params:
    - `page`, `pageSize`, `chunkType`, `assetUrlPolicy?: "none" | "durable"`.
    - Paged mode must not combine with scan-heavy filters like `sectionPath`, `startChunk`, `endChunk`, or `chunkId`.
  - Add storage configuration on the SDK/knowledge client, e.g. `knowledge.withParsedStorage({ storage, scheduler, limits })`.
  - Replace new usage of `cacheJobResult` with clearer methods:
    - `importJobResult` means explicit local import.
    - `syncParsedDocument` means write a parsed snapshot/assets to the configured storage.
    - Keep `cacheJobResult` only as deprecated compatibility alias.

  ## SDK Implementation
  - Define a `ParsedDocumentStorage` adapter for parsed snapshots, not just assets:
    - read/write manifest
    - read/write chunk pages
    - read/write durable assets
    - get asset URL
    - read/write sync progress metadata
  - Use `revisionKey = jobResultId ?? jobId` for freshness. Storage is valid only when its manifest revision matches the current remote revision.
  - Read flow:
    - resolve one document reference: `documentId`, `localDocumentId`, or `jobId`
    - try configured storage first
    - if missing/stale, read remote via `documents.listChunks`
    - return the requested bounded result immediately
    - schedule background sync into configured storage
  - Parse flow:
    - parse completes on Knowhere
    - SDK writes chunks/assets/manifest to configured storage
    - only then returns completion to the caller
  - Background sync must be resumable and Vercel-safe:
    - cursor/progress includes `documentId`, `revisionKey`, next chunk page, next asset index
    - bounded by page count, asset count, and deadline per step
    - final manifest is written only after all required pages/assets are present
    - partial snapshots are ignored by reads until manifest commit

  ## Grep And Outline
  - `grepChunks` supports only one specific document, never broad workspace/search scope.
  - Broad search continues to use Knowhere `retrieval.query`.
  - Remote grep streams `documents.listChunks(..., includeAssetUrls: false)` page by page, applies literal/regex matching SDK-side, and stops at `maxResults`, deadline, max pages, or end of document.
  - Grep response should include `truncated` and a continuation cursor when it stops early.
  - `getDocumentOutline` reads full outline from storage when available. On remote fallback, build a lightweight section outline from chunk `sectionPath` within configured page/deadline limits and mark it
  truncated if incomplete.

  ## Notebook Changes
  - Notebook uses SDK directly for chunk read/display/chat tooling; do not route this through MCP.
  - Notebook provides a Vercel Blob `ParsedDocumentStorage` adapter and an Upstash/Vercel-safe scheduler.
  - New Notebook parse/upload flow remains hidden behind `parsing`:
    - Knowhere parse success plus Blob sync success -> mark source `ready`
    - Knowhere parse failure -> mark source `failed`
    - Blob sync failure after parse success -> mark source `failed` with `failureStage: "storage_sync"`
  - Retry behavior:
    - parse failure retries parse/upload
    - `storage_sync` failure resumes sync from existing `documentId/jobId/revisionKey`, no reparse
  - Existing remote Knowhere documents are readable immediately:
    - SDK reads remote if Blob snapshot is missing/stale
    - Blob sync is non-blocking
    - missing Blob data must not produce zero chunks or non-ready behavior
  - User-visible asset URLs must be durable Notebook Blob URLs:
    - `readChunks` display calls use `assetUrlPolicy: "durable"`
    - only visible/cited assets are hardened synchronously
    - grep uses no asset URLs
    - if hardening fails, return text and omit the asset URL rather than exposing a presigned Knowhere URL

  ## CLI And MCP
  - CLI/MCP configure disk `ParsedDocumentStorage` explicitly.
  - CLI removes duplicate `documentId -> listChunks -> importJobResult` logic and delegates reads to SDK.
  - MCP continues delegating to SDK `readChunks`, `grepChunks`, and `getDocumentOutline`; update descriptions/tests for storage-first remote-fallback behavior.
  - Remote reads must not silently write local disk unless disk storage was explicitly configured.

  ## Database And Compatibility
  - Add a new Notebook migration only; do not edit existing migrations.
  - Store snapshot/cache metadata in `source_parse_results`, including at least:
    - `revision_key`
    - `sync_status` or equivalent
    - `failure_stage` / sync failure detail where appropriate
    - progress cursor for resumable sync if not stored elsewhere
  - Keep existing snapshot manifest shape compatible where possible, but treat committed manifest as the only readable snapshot marker.

  ## Test Plan
  - SDK:
    - storage hit reads without remote calls
    - stale/missing storage falls back to remote
    - remote reads schedule non-blocking sync
    - parse writes configured storage before completion
    - paged `readChunks` behavior and invalid param combinations
    - single-document bounded remote grep with truncation cursor
    - remote outline fallback and storage outline path
    - no implicit disk writes without configured disk storage
  - Notebook:
    - parse remains `parsing` until Blob sync completes
    - parse success plus Blob sync failure marks `failed` with `storage_sync`
    - retry of `storage_sync` resumes sync without reparsing
    - existing remote document with no Blob snapshot returns chunks from remote
    - missing/stale Blob never returns zero chunks for ready remote docs
    - displayed/chat citation assets are Blob URLs or omitted, never Knowhere presigned URLs
  - CLI/MCP:
    - remote document read/grep/outline works through SDK
    - disk storage is explicit
    - duplicate remote-to-local import path is removed
  - Verification:
    - run targeted SDK storage/read tests
    - run Notebook parse/sync/chunk/chat tests
    - run CLI read/inspect tests and MCP tests
    - run feasible typecheck/lint/test suites per repo
    - smoke test local Knowhere + Notebook: parse PDF, wait until ready, inspect Blob manifest/pages/assets, open chunks, chat with citation, verify durable Blob URLs

  ## Assumptions
  - `documents.listChunks` is the authoritative remote parsed read API for published parsed v2 documents.
  - `jobResultId ?? jobId` is sufficient as the revision key.
  - Full job-result ZIP loading is allowed for explicit import/sync workflows, but not for Notebook request-time reads.
  - Notebook request-time work is bounded to the requested page/window plus visible/cited asset hardening.
