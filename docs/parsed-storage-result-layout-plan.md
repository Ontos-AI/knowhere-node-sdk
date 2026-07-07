# Parsed Storage Result Layout Plan

## Summary

The SDK-provided parsed storage layout should match the Knowhere result ZIP
layout. The SDK should stop inventing a second parsed snapshot format such as
`manifest/current.json` plus `chunks/page-N.json`, and its read methods should
operate directly on the expanded result files that Knowhere already produces:

```text
manifest.json
chunks.json
full.md
doc_nav.json
hierarchy.json
chunks_slim.json
toc_hierarchies.json
kb.csv
hierarchy_view.html
page_citation_assets/...
images/...
tables/...
```

Storage adapters still choose the physical prefix for a workspace, document, and
revision. Inside that prefix, the SDK should preserve the result-relative paths
from the ZIP. The SDK should not rewrite `page_citation_assets/...`,
`images/...`, `tables/...`, or JSON filenames into SDK-specific directories.

## Problem

The current SDK parsed-storage snapshot diverges from the Knowhere result
contract:

```text
manifest/current.json
index.json
chunks/page-1.json
chunks/page-2.json
assets/...
```

That second layout creates extra SDK-only knowledge:

- callers and adapters need to understand chunk pages even though Knowhere
  results use `chunks.json`
- `readChunks` reads all snapshot chunk pages before slicing a requested
  display page
- Notebook page viewing can spend many Blob reads before it can render page 1
- MCP/local-cache docs already describe expanded results with `chunks.json`,
  while parsed storage uses a different shape

The module is shallow in the wrong place: storage adapters expose semantic
methods such as `readChunkPage`, while the SDK still owns the complexity of
interpreting the result. The better seam is a result-file storage adapter plus
SDK-owned result loading and read logic.

## Target Layout

For each `{ documentId, revisionKey }`, the storage adapter resolves a private
physical prefix. `revisionKey` is the freshness key for a parsed document
revision and is defined as `jobResultId ?? jobId`. The SDK unzips the Knowhere
result and writes the expanded result files under that prefix without changing
result-relative paths:

```text
<adapter-prefix>/
  manifest.json
  chunks.json
  full.md
  doc_nav.json
  hierarchy.json
  chunks_slim.json
  toc_hierarchies.json
  kb.csv
  hierarchy_view.html
  page_citation_assets/page-1.png
  images/...
  tables/...
```

The SDK should treat `manifest.json` plus `chunks.json` as the minimum result
contract, but a storage revision is only committed after every file emitted by the
result has been written to storage. Optional files are present only when
Knowhere emitted them. The stored JSON/file shapes should follow the Knowhere
result contract, not the SDK's internal normalized TypeScript model.

SDK operational metadata must not pollute the result layout. Put progress and
commit metadata outside the expanded result directory, for example:

```text
<adapter-prefix>/.knowhere-sdk/sync-progress.json
<adapter-prefix>/.knowhere-sdk/commit.json
```

or keep it in an adapter side channel. The commit marker must be written last.
Reads must only consider a storage revision committed when the SDK has written every
result file and the commit marker. Partial or failed writes must be ignored by
`readChunks`, `grepChunks`, and `getDocumentOutline`.

For v1, commit metadata should stay minimal. `commit.json` should include:

```json
{
  "version": 1,
  "documentId": "doc_...",
  "revisionKey": "job_result_or_job_id",
  "source": "resultZip",
  "committedAt": "2026-07-07T00:00:00.000Z"
}
```

`source` should distinguish authoritative result ZIP sync from minimal remote
reconstruction, for example `resultZip` or `remoteReconstruction`. Sync progress
metadata should only track what is needed to distinguish committed, in-progress,
stale, and failed storage states.

## Storage Interface Direction

Replace the page-specific parsed-storage interface with a smaller file/object
interface. The adapter should not know about SDK chunk semantics, outlines, or
grep behavior. It only receives result-relative paths and maps them to complete
physical storage paths.

Proposed public seam:

```ts
interface ParsedDocumentStorage {
  readObject(params: ParsedDocumentObjectParams): Promise<ParsedDocumentObject | null>;
  writeObject(params: ParsedDocumentWriteObjectParams): Promise<ParsedDocumentWriteResult>;
  headObject?(params: ParsedDocumentObjectParams): Promise<ParsedDocumentObjectHead | null>;
  getObjectUrl?(params: ParsedDocumentObjectParams): Promise<string | null>;
  deletePrefix?(params: ParsedDocumentRevisionParams): Promise<void>;
  readSyncProgress(
    params: ParsedDocumentRevisionParams,
  ): Promise<ParsedDocumentSyncProgress | null>;
  writeSyncProgress(params: ParsedDocumentSyncProgress): Promise<void>;
}
```

Where `ParsedDocumentObjectParams` includes:

```text
documentId
revisionKey
path
```

The SDK owns all result-relative paths under `path`. Adapters may remap those
paths to absolute Blob keys, filesystem paths, S3 keys, or another backing
store. That remapping is private to the adapter and must not change the logical
layout observed by SDK methods.

Keep scheduling outside the storage adapter:

```ts
interface ParsedDocumentSyncScheduler {
  schedule(task: () => Promise<void>): void | Promise<void>;
}
```

The configured SDK seam should remain
`knowledge.withParsedStorage({ storage, scheduler, limits })`. Notebook already
has a QStash-backed scheduler that ignores the non-serializable closure and
enqueues `/api/sources/parsed-sync`; OpenWriting already has a bounded
fire-and-forget scheduler. The SDK should continue to expose
`syncParsedDocument(...).completed` so durable schedulers can re-enqueue bounded
segments until the result layout is committed.

## SDK Method Behavior

### Parse/import flow

When the SDK has a Knowhere result ZIP or expanded `ParseResult`:

1. Unzip the result and write the expanded files to parsed storage using their
   original result-relative paths.
2. Parse or inspect the result through the existing ZIP/directory parser as
   needed for return values.
3. Preserve asset URL fields emitted by the result or remote API. Storage-hit
   reads may replace those URLs with adapter-provided object URLs when the
   corresponding result-relative asset object exists.
4. Write the expanded result layout to parsed storage:
   - `manifest.json`
   - `chunks.json`
   - optional sidecar files
   - binary/text assets at their original result paths
5. Write the commit marker after all emitted result files and assets are
   present.
6. Return parse/import completion only after storage sync succeeds.

The SDK already has the job-result path for this flow: `Jobs.load(jobId)`
resolves the job, downloads `resultUrl`, and parses the result ZIP.
`Knowledge.loadJobResult` and `Knowledge.syncParsedDocument({ jobId })` already
enter storage sync through this path. Keep that as the canonical result source
for completed jobs.

### Remote read-miss sync

When `readChunks`, `grepChunks`, or `getDocumentOutline` miss storage and fall
back to a published remote document:

1. Return the requested remote result promptly.
2. Schedule non-blocking storage sync.
3. Resolve the current published `jobId` for the `documentId`, then use the
   same job-result path as parse/import to sync the authoritative result ZIP.
   The current code already has the needed information path: `documents.listChunks`
   returns `jobId`/`jobResultId`, and `Knowledge` has a helper that reads
   `documents.listChunks(page=1, pageSize=1)` to discover the published job.
4. If the job result is unavailable and the only usable remote source is
   `documents.listChunks`, reconstruct a
   minimal expanded result:
   - `manifest.json` with document, revision, source, and count metadata
   - `chunks.json` serialized from the complete remote chunk list
   - asset URLs preserved from the remote chunk payload
   - optional files omitted

The reconstructed layout still uses the same filenames as the Knowhere result
directory. It is a minimal result, not a second SDK snapshot format.

### `readChunks`

Storage hit:

1. Verify the commit marker and revision freshness.
2. Read `manifest.json` and `chunks.json`.
3. Build the indexed chunks in memory.
4. Apply `chunkType`, `page`, `pageSize`, and scan filters.
5. Resolve asset URLs from storage object URLs when available.
6. Return the SDK read response.

This may read one larger logical `chunks.json` file, but it avoids SDK-level
chunk-page semantics and matches the Knowhere result contract. Do not add a
private SDK `chunks.index.json` for v1; keep `chunks.json` as the canonical
source of truth.

Storage adapters may internally split large `chunks.json` writes into multiple
physical objects for their own performance or platform limits. That must remain
an adapter-private optimization: SDK core methods still ask for logical
`chunks.json` as a whole unless a later storage adapter exposes transparent
range/page reads behind the same logical path.

Remote miss:

1. Read only the requested remote page for display reads.
2. Schedule background sync.
3. Do not block the display response on durable storage sync.

### `grepChunks`

Storage hit reads `chunks.json` once, then scans locally with the current
bounded grep rules and continuation cursor. Remote miss keeps the existing
remote page scan and schedules background sync.

### `getDocumentOutline`

Storage hit should prefer `doc_nav.json` when present. If absent, build the
outline from `chunks.json`. Remote miss keeps the bounded remote outline
fallback and schedules background sync.

## Compatibility Plan

This is a breaking storage-interface change. Do not keep legacy paged snapshot
read or write compatibility in the new implementation. All new reads and writes
should use the result layout directly, and Notebook, CLI, MCP, and OpenWriting
adapters should move to the object-path interface in the same migration window.
Track the breaking interface change in GitHub before implementation starts.

## Notebook Impact

Notebook should continue to provide only a storage adapter and scheduler. It
should not know whether the SDK reads `chunks.json`, `doc_nav.json`, or assets.
The Blob adapter may physically split a large logical `chunks.json` into
multiple Blob objects for platform limits, but that split must stay behind the
adapter. The SDK and Notebook call sites should still observe a single logical
result-relative path named `chunks.json`.

Expected improvement for page viewing:

```text
current storage hit:
  read manifest/current.json
  read chunks/page-1.json
  read chunks/page-2.json
  ...
  slice page 1

target storage hit:
  read commit metadata
  read manifest.json
  read chunks.json
  slice page 1
```

For very large documents, this trades many small object reads for one canonical
result read. That matches the Knowhere contract and removes the current
SDK-only pagination layout from request-time display reads.

Notebook can still decide to bypass storage for page viewing if product UX
requires remote-first rendering, but that becomes a caller policy decision, not
a storage-layout workaround.

## Implementation Steps

1. Document the new result-layout contract in SDK types and docs.
2. Introduce object-path storage methods and disk adapter support.
3. Update parsed-storage sync to write expanded result files instead of paged
   chunk pages.
4. Update `syncParsedDocument({ documentId })` to resolve the published job id
   and use the existing result-by-job path before falling back to
   `listChunks` reconstruction.
5. Update storage-hit reads to load through the existing result parser path.
6. Update asset URL handling to preserve original result-relative asset paths.
7. Update MCP docs that currently mention local expanded `chunks.json` so parsed
   storage and local cache use the same vocabulary.
8. Update Notebook's Blob adapter after the SDK exposes the result-layout
   interface.
9. Update OpenWriting's S3 adapter and page asset materialization path to use
   `readObject`/`writeObject`/`getObjectUrl` with result-relative paths instead
   of `getAssetUrl`/`writeAsset`.
10. Add a changeset and migration notes because this changes the public
    `ParsedDocumentStorage` adapter interface.

## Test Plan

SDK:

- parses a result ZIP and writes `manifest.json`, `chunks.json`, optional files,
  and assets to parsed storage without changing result-relative paths
- writes the commit marker last and ignores incomplete result-layout storage
- `syncParsedDocument({ jobId })` uses the result ZIP path
- `syncParsedDocument({ documentId })` resolves the current published job id and
  then uses the result ZIP path when available
- storage hit for `readChunks({ page, pageSize })` reads `chunks.json`, not
  `chunks/page-N.json`
- storage hit for page-image chunks returns durable asset URLs from result paths
- `grepChunks` and `getDocumentOutline` work from result-layout storage
- missing/stale/uncommitted storage falls back to remote and schedules sync
- disk storage round-trips the result layout

Notebook integration:

- Blob adapter maps SDK result paths into workspace/document/revision prefixes
- page viewer no longer reads every legacy chunk page before rendering page 1
- storage-hit chat citation assets return Notebook-owned durable asset URLs
  when the adapter can resolve them; remote fallback keeps Knowhere-provided
  asset URLs
- background sync writes committed result-layout storage before marking a parse
  ready

MCP/CLI:

- local cache and parsed storage both expose result-directory semantics
- remote fallback still uses `remote:<documentId>` markers until storage is
  synced
- OpenWriting S3 storage maps result-relative object paths into per-user private
  keys without exposing `userID` through the SDK storage interface
