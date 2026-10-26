# Streaming parsed document snapshots

`knowledge.syncParsedDocument({ documentId })` resolves the published revision and
refreshes its signed job-result URL on every invocation. It reads the ZIP central
directory over HTTP Range GETs and copies each result file to storage before
extracting another file. The default remote path does not call `jobs.load()` or
construct a `ParseResult`. Signed GET URLs do not require HEAD authorization.

The snapshot preserves the exact uncompressed bytes and result-relative paths
from the archive. `.knowhere-sdk/commit.json` retains its existing version 1
format and is written after all files, required asset references, ZIP checksums,
and the published revision have been verified. Corrupt archives and identity
changes are errors. A missing job/archive uses the existing bounded remote-chunk
reconstruction path; a corrupt or failed archive download does not silently
replace the result with a reconstruction.

## Storage adapter

Existing `ParsedDocumentStorage` adapters remain supported. They receive one
entry at a time through `writeObject`. An adapter can add:

```typescript
writeObjectStream?(params: ParsedDocumentWriteObjectStreamParams):
  Promise<ParsedDocumentWriteObjectResult>;
```

The parameters match `writeObject` except `body` is a Web
`ReadableStream<Uint8Array>`, with optional `signal: AbortSignal`. Consume the
entire body with backpressure before resolving. Reject an interrupted or partial
write; expose the completed object only when the write succeeds. The SDK advances
the checkpoint after that successful write. The byte-only fallback buffers one
entry at a time, so its peak memory depends on the largest individual entry.

## Batches and retries

```typescript
const knowledge = client.knowledge.withParsedStorage({
  storage,
  limits: {
    maxEntriesPerSync: 100,
    archiveSyncDeadlineMs: 120_000,
  },
});

const result = await knowledge.syncParsedDocument({
  documentId,
  revisionKey,
  signal: abortController.signal,
  retainResultArchive: true,
});
if (!result.completed) {
  // Persist or re-enqueue this same document/revision for another invocation.
}
```

Each invocation copies at most 100 new entries by default and checks its 120-second
budget between entries. `completed: false` leaves the last successful entry
checkpoint available for the next invocation. `nextArchiveEntry` is a zero-based
index of the next snapshot entry, excluding directories, nested `result.zip`,
and reserved SDK metadata. `pinnedRevisionKey`, `archiveIdentity`, and
`archiveEntryHashes` prevent reuse of a checkpoint for different archive content.
Do not change a requested revision after beginning a copy. Explicit revision
mismatches fail before writing; publication is checked again before committing.

With HTTP Range support, retries skip completed entries after validating archive
identity and central-directory metadata. Without Range support, retries read the
source sequentially again and verify completed entry hashes before continuing.
Caller cancellation rejects and preserves the last successful checkpoint.
An explicit sync after a completed checkpoint starts a fresh bounded transfer,
so callers can rebuild a snapshot whose persisted objects are missing or corrupt.
Re-enqueued running or failed transfers continue from their successful checkpoint.
Existing remote-chunk limits (`remotePageSize`, `maxPagesPerSync`, and
`syncDeadlineMs`) continue to bound reconstruction when no archive is available.

## Optional original ZIP

`retainResultArchive: true` streams the exact source archive to `result.zip` after
a valid snapshot is committed. Retention is optional; its failure cannot
invalidate the committed snapshot. Use a stream-capable adapter to retain a
large archive without buffering it. A byte-only adapter must buffer that optional
ZIP object. The default does not retain `result.zip`.

## Servers without Range support

The SDK first probes support with a ranged GET and cancels an ignored Range body.
It lazily loads a Node.js sequential ZIP reader when the server does not return a
valid 206 response. Files are streamed directly to the storage adapter. The
compressed source is also written to an SDK-owned temporary file so the final
central directory can validate entry CRCs and sizes, including data descriptors.
Temporary disk capacity must accommodate the compressed archive. SDK-created
files are removed in `finally`, including cancellation and failed writes.
Unavailable temporary storage throws `ParsedDocumentArchiveError` with
`code: 'ARCHIVE_SPOOL_FAILED'` and prevents a commit; there is no whole-archive
memory fallback. The normal HTTP Range path does not create temporary files.

`@zip.js/zip.js` supplies the Range reader. Its `ZipReaderStream` convenience
wrapper buffers the source before extraction, so the no-Range path instead uses
`unzipper` for sequential extraction and zip.js for the final central-directory
check. Source: [zip.js ZipReaderStream documentation](https://github.com/gildas-lormeau/zip.js/blob/master/index.d.ts),
[unzipper documentation](https://github.com/ZJONSSON/node-unzipper).

## Validation

Run `pnpm build` followed by
`node scripts/validation/streamed-sync-memory.mjs` to generate synthetic archives
and validate them in independent Node subprocesses with a streaming discard sink.
The harness uses the default 100-entry batch size, validates every image is copied
exactly once, rejects calls to `jobs.load`, requires ranged GETs, and asserts peak
RSS below 512 MiB. It creates and removes its own synthetic temporary fixtures.

Measured on the development host with Node.js 26.7.0 and a fresh subprocess per row. Baseline is
sampled after SDK import and fixture-server setup, immediately before copying:

| Archive per job | Images per job | Concurrent jobs | Baseline RSS |   Peak RSS | Peak increase |
| --------------- | -------------: | --------------: | -----------: | ---------: | ------------: |
| 281.16 MiB      |            922 |               1 |    41.19 MiB | 175.95 MiB |    134.76 MiB |
| 562.31 MiB      |          1,844 |               1 |    41.80 MiB | 248.89 MiB |    207.09 MiB |
| 281.16 MiB      |            922 |               2 |    41.86 MiB | 225.91 MiB |    184.04 MiB |

Each row completed all files with the default 100-entry batches and no
whole-archive GET. The two concurrent jobs share one process and stream a combined
562 MiB. The measurements include the local HTTP server, metadata/checkpoint
allocations, and garbage-collection/native-allocation variance; they do not
establish a safe concurrency limit for a deployed application. Storage adapters
must preserve stream backpressure for the same memory behavior.

The complete `pnpm test:ci` run passes 380 tests and all configured coverage
thresholds (75.45% branches, 85.95% statements, 88.88% functions, 86.60% lines).
The streaming and lazy ParseResult storage modules each have 100% line coverage.
`pnpm lint`, `pnpm typecheck`, `pnpm format:check`, and `pnpm build` also pass;
lint reports three pre-existing warnings in unrelated tests.
