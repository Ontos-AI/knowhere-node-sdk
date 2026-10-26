import { createHash } from 'crypto';
import type { JobSnapshot } from '../types/job.js';
import { HttpRangeReader, ZipReader, type FileEntry, type HttpOptions } from '@zip.js/zip.js';

import type { KnowledgeSyncParsedDocumentResponse } from '../knowledge/types.js';
import type {
  ParsedDocumentCommit,
  ParsedDocumentStorage,
  ParsedDocumentStorageLimits,
  ParsedDocumentSyncProgress,
  ParsedDocumentWriteObjectStreamParams,
} from '../types/storage.js';
import {
  inferContentTypeFromPath,
  normalizeResultPath,
  parsedDocumentCommitPath,
  readParsedDocumentCommit,
} from './parsed-document-storage.js';

export interface ArchiveEntry {
  readonly path: string;
  readonly read: () => ReadableStream<Uint8Array>;
}

export interface ArchiveSource {
  readonly readArchive?: () => ReadableStream<Uint8Array>;
  readonly canSkipEntries: boolean;
  readonly identity: string;
  readonly downloadIdentity: string;
  readonly entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>;
  readonly close: () => Promise<void>;
}

export interface StreamedSyncParams {
  readonly snapshot?: JobSnapshot;
  readonly documentId: string;
  readonly revisionKey: string;
  readonly jobId: string;
  readonly resultUrl: string;
  readonly storage: ParsedDocumentStorage;
  readonly limits?: ParsedDocumentStorageLimits;
  readonly signal?: AbortSignal;
  readonly retainResultArchive?: boolean;
  readonly verifyRevision?: () => Promise<void>;
}

/** Copies one entry at a time; no ParseResult or whole archive is materialized. */
export async function syncRemoteResultArchive(
  params: StreamedSyncParams,
): Promise<KnowledgeSyncParsedDocumentResponse> {
  params.signal?.throwIfAborted();
  const startedAt: number = Date.now();
  const maxEntries: number = Math.max(1, params.limits?.maxEntriesPerSync ?? 100);
  const deadlineMs: number = Math.max(1, params.limits?.archiveSyncDeadlineMs ?? 120_000);
  const previous: ParsedDocumentSyncProgress | null = await params.storage.readSyncProgress(params);
  const source: ArchiveSource = await openArchive(params);
  const entryHashes: string[] = [];
  const paths: Set<string> = new Set();
  let entryIndex: number = 0;
  let copiedEntries: number = 0;
  const nextEntry: number =
    previous?.status === 'completed' ? 0 : (previous?.nextArchiveEntry ?? 0);
  try {
    if (previous?.snapshotChecksum && previous.snapshotChecksum !== params.snapshot?.checksum)
      throw new Error('Parsed snapshot checksum changed within one generation.');
    if (
      previous?.upstreamJobResultId &&
      previous.upstreamJobResultId !== params.snapshot?.jobResultId
    )
      throw new Error('Parsed snapshot upstream revision changed within one generation.');
    if (previous?.archiveIdentity && previous.archiveIdentity !== source.identity) {
      throw new Error('Parsed result archive identity changed; start a new revision.');
    }
    if (previous?.pinnedRevisionKey && previous.pinnedRevisionKey !== params.revisionKey) {
      throw new Error('Parsed result revision changed while resuming archive sync.');
    }
    if (params.snapshot && previous?.status === 'completed') {
      const committed: ParsedDocumentCommit | null = await readParsedDocumentCommit(params);
      if (committed) {
        await verifyArchiveChecksum(
          params,
          source.downloadIdentity,
          previous.archiveEntryHashes ?? [],
          params.retainResultArchive,
        );
        return {
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          snapshot: params.snapshot,
          completed: true,
          commit: committed,
        };
      }
    }
    for await (const entry of source.entries) {
      params.signal?.throwIfAborted();
      if (paths.has(entry.path)) throw new Error(`Duplicate parsed result path: ${entry.path}`);
      paths.add(entry.path);
      if (
        entryIndex >= nextEntry &&
        copiedEntries > 0 &&
        (copiedEntries >= maxEntries || Date.now() - startedAt >= deadlineMs)
      ) {
        return {
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          snapshot: params.snapshot,
          completed: false,
        };
      }
      if (entryIndex < nextEntry && source.canSkipEntries) {
        const previousHash: string | undefined = previous?.archiveEntryHashes?.[entryIndex];
        if (!previousHash) throw new Error('Parsed archive checkpoint is missing an entry hash.');
        entryHashes.push(previousHash);
        entryIndex += 1;
        continue;
      }
      const hash = createHash('sha256');
      const body: ReadableStream<Uint8Array> = entry.read().pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller): void {
            params.signal?.throwIfAborted();
            hash.update(chunk);
            controller.enqueue(chunk);
          },
        }),
      );
      if (entryIndex < nextEntry) {
        await body.pipeTo(new WritableStream<Uint8Array>(), { signal: params.signal });
      } else {
        await writeStream(params.storage, {
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          path: entry.path,
          body,
          contentType: inferContentTypeFromPath(entry.path),
          signal: params.signal,
        });
      }
      const entryHash: string = createHash('sha256')
        .update(entry.path)
        .update(hash.digest())
        .digest('hex');
      if (entryIndex < nextEntry && previous?.archiveEntryHashes?.[entryIndex] !== entryHash) {
        throw new Error('Parsed result archive entry changed while resuming.');
      }
      entryHashes.push(entryHash);
      entryIndex += 1;
      if (entryIndex <= nextEntry) continue;
      copiedEntries += 1;
      await params.storage.writeSyncProgress({
        documentId: params.documentId,
        revisionKey: params.revisionKey,
        pinnedRevisionKey: params.revisionKey,
        snapshotChecksum: params.snapshot?.checksum,
        upstreamJobResultId: params.snapshot?.jobResultId,
        archiveIdentity: source.identity,
        archiveEntryHashes: [...entryHashes],
        nextArchiveEntry: entryIndex,
        status: 'running',
        updatedAt: new Date().toISOString(),
      });
    }
    await validateRequiredObjects(params, paths);
    if (params.snapshot && source.canSkipEntries)
      await verifyArchiveChecksum(params, source.downloadIdentity, entryHashes);
    await params.verifyRevision?.();
    params.signal?.throwIfAborted();
    const commit: ParsedDocumentCommit = {
      snapshotId: params.snapshot?.snapshotId,
      jobResultId: params.snapshot?.jobResultId,
      checksum: params.snapshot?.checksum,
      stage: params.snapshot?.stage,
      version: 1,
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      source: 'resultZip',
      committedAt: new Date().toISOString(),
    };
    await params.storage.writeObject({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      path: parsedDocumentCommitPath,
      body: Buffer.from(JSON.stringify(commit, null, 2)),
      contentType: 'application/json; charset=utf-8',
    });
    await params.storage.writeSyncProgress({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      pinnedRevisionKey: params.revisionKey,
      snapshotChecksum: params.snapshot?.checksum,
      upstreamJobResultId: params.snapshot?.jobResultId,
      archiveIdentity: source.identity,
      archiveEntryHashes: entryHashes,
      nextArchiveEntry: entryIndex,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    });
    if (params.retainResultArchive) {
      try {
        await retainArchive(params, source.downloadIdentity);
      } catch {
        /* Optional archive retention never invalidates a committed snapshot. */
      }
    }
    return {
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      completed: true,
      snapshot: params.snapshot,
      commit,
    };
  } finally {
    await source.close();
  }
}

async function openArchive(params: StreamedSyncParams): Promise<ArchiveSource> {
  // Probe with GET, then cancel ignored Range responses before a reader can buffer them.
  const probe: Response = await fetch(params.resultUrl, {
    headers: { Range: 'bytes=0-0' },
    signal: params.signal,
  });
  if (!probe.ok) {
    await probe.body?.cancel();
    throw new Error(`Parsed result download failed (HTTP ${probe.status}).`);
  }
  const identity: string = createDownloadIdentity(params.jobId, probe);
  const supportsRange: boolean = probe.status === 206 && probe.headers.has('content-range');
  await probe.body?.cancel();
  if (!supportsRange) {
    const { openSequentialArchive } = await import('./sequential-parsed-document-archive.js');
    return openSequentialArchive(params, identity);
  }
  const options: HttpOptions = {
    forceRangeRequests: true,
    preventHeadRequest: true,
    checkResourceChanges: true,
    fetch: async (input, init): Promise<Response> => {
      const response: Response = await fetch(input, { ...init, signal: params.signal });
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(`Parsed result Range request failed (HTTP ${response.status}).`);
      }
      return response;
    },
  };
  const reader = new ZipReader(new HttpRangeReader(params.resultUrl, options), {
    useWebWorkers: false,
    checkCrc32: true,
  });
  try {
    const entries = await reader.getEntries();
    const files: FileEntry[] = entries.filter(
      (entry): entry is FileEntry => !entry.directory && isSnapshotPath(entry.filename),
    );
    const archiveIdentity: string = createHash('sha256')
      .update(identity)
      .update(
        JSON.stringify(
          files.map((entry) => [entry.filename, entry.uncompressedSize, entry.signature]),
        ),
      )
      .digest('hex');
    return {
      identity: archiveIdentity,
      downloadIdentity: identity,
      canSkipEntries: true,
      entries: (function* (): Generator<ArchiveEntry> {
        for (const entry of files)
          yield {
            path: normalizeResultPath(entry.filename),
            read: (): ReadableStream<Uint8Array> => readRangeEntry(entry, params.signal),
          };
      })(),
      close: async (): Promise<void> => {
        await reader.close();
      },
    };
  } catch (error) {
    await reader.close();
    throw error;
  }
}

function readRangeEntry(
  entry: FileEntry,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  // The producer and sink run together. The TransformStream applies sink backpressure.
  void entry
    .getData(stream.writable, { signal, checkCrc32: true, useWebWorkers: false })
    .catch(async (error: unknown): Promise<void> => {
      try {
        await stream.writable.abort(error);
      } catch {
        /* Producer already aborted the stream. */
      }
    });
  return stream.readable;
}

async function writeStream(
  storage: ParsedDocumentStorage,
  params: ParsedDocumentWriteObjectStreamParams,
): Promise<void> {
  if (storage.writeObjectStream) {
    try {
      await storage.writeObjectStream(params);
    } catch (error) {
      await params.body.cancel(error).catch((): void => undefined);
      throw error;
    }
    return;
  }
  const parts: Uint8Array[] = [];
  for await (const part of params.body) {
    params.signal?.throwIfAborted();
    parts.push(part);
  }
  await storage.writeObject({ ...params, body: Buffer.concat(parts) });
}

async function validateRequiredObjects(
  params: StreamedSyncParams,
  paths: ReadonlySet<string>,
): Promise<void> {
  const required: Set<string> = new Set(['manifest.json', 'chunks.json']);
  for (const path of required)
    if (!paths.has(path)) throw new Error(`Required parsed result file missing: ${path}`);
  const manifestObject = await params.storage.readObject({ ...params, path: 'manifest.json' });
  const chunksObject = await params.storage.readObject({ ...params, path: 'chunks.json' });
  if (!manifestObject || !chunksObject)
    throw new Error('Required parsed result manifest.json or chunks.json was not persisted.');
  const manifest: unknown = JSON.parse(Buffer.from(manifestObject.body).toString('utf8'));
  const payload: unknown = JSON.parse(Buffer.from(chunksObject.body).toString('utf8'));
  if (!isRecord(manifest)) throw new Error('Invalid parsed result manifest.json.');
  const manifestJobId: unknown = manifest.job_id ?? manifest.jobId;
  if (manifestJobId !== params.jobId)
    throw new Error('Parsed result manifest job identity differs from the pinned job.');
  const manifestRevision: unknown = manifest.job_result_id ?? manifest.jobResultId;
  if (
    params.snapshot &&
    manifestRevision !== undefined &&
    manifestRevision !== params.snapshot.jobResultId
  )
    throw new Error('Parsed result manifest revision differs from the snapshot upstream revision.');
  const chunks: unknown = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? payload.chunks
      : undefined;
  if (!Array.isArray(chunks)) throw new Error('Invalid parsed result chunks.json.');
  if (isRecord(manifest.files))
    for (const path of Object.values(manifest.files))
      if (typeof path === 'string') required.add(normalizeResultPath(path));
  for (const chunk of chunks as unknown[]) {
    if (!isRecord(chunk)) throw new Error('Invalid parsed result chunk.');
    const metadata: unknown = chunk.metadata;
    const chunkType: unknown = chunk.type ?? chunk.chunk_type ?? chunk.chunkType;
    const filePath: unknown =
      chunk.file_path ??
      chunk.filePath ??
      (isRecord(metadata) ? (metadata.file_path ?? metadata.filePath) : undefined) ??
      (chunkType === 'image' || chunkType === 'table' ? chunk.path : undefined);
    if (typeof filePath === 'string') required.add(normalizeResultPath(filePath));
    if (!isRecord(metadata)) continue;
    const pageAssets: unknown = metadata.page_assets ?? metadata.pageAssets;
    if (!Array.isArray(pageAssets)) continue;
    for (const asset of pageAssets as unknown[])
      if (isRecord(asset)) {
        const ref: unknown = asset.artifact_ref ?? asset.artifactRef;
        if (typeof ref === 'string') required.add(normalizeResultPath(ref));
      }
  }
  for (const path of required)
    if (!paths.has(path)) throw new Error(`Required parsed result file missing: ${path}`);
}

async function verifyArchiveChecksum(
  params: StreamedSyncParams,
  identity: string,
  expectedEntryHashes: readonly string[],
  retainResultArchive = false,
): Promise<void> {
  const { openSequentialArchive } = await import('./sequential-parsed-document-archive.js');
  const source: ArchiveSource = await openSequentialArchive(params, identity);
  let entryIndex: number = 0;
  try {
    for await (const entry of source.entries) {
      const hash = createHash('sha256');
      for await (const part of entry.read()) {
        params.signal?.throwIfAborted();
        hash.update(part);
      }
      const entryHash: string = createHash('sha256')
        .update(entry.path)
        .update(hash.digest())
        .digest('hex');
      if (expectedEntryHashes[entryIndex] !== entryHash)
        throw new Error(
          'Parsed snapshot archive entry changed between extraction and checksum verification.',
        );
      entryIndex += 1;
    }
    if (entryIndex !== expectedEntryHashes.length)
      throw new Error('Parsed snapshot archive entry count changed during checksum verification.');
    // The sequential source verifies SHA-256 of the very bytes it extracted.
    // Retain those same verified compressed bytes; a new HTTP response is not proof.
    if (retainResultArchive && source.readArchive) {
      try {
        await writeStream(params.storage, {
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          path: 'result.zip',
          body: source.readArchive(),
          contentType: 'application/zip',
          signal: params.signal,
        });
      } catch {
        /* Optional archive retention never invalidates a committed snapshot. */
      }
    }
  } finally {
    await source.close();
  }
}

async function retainArchive(params: StreamedSyncParams, expectedIdentity: string): Promise<void> {
  if (params.snapshot) {
    const progress: ParsedDocumentSyncProgress | null =
      await params.storage.readSyncProgress(params);
    await verifyArchiveChecksum(params, expectedIdentity, progress?.archiveEntryHashes ?? [], true);
    return;
  }
  const response: Response = await fetch(params.resultUrl, { signal: params.signal });
  if (!response.ok || !response.body)
    throw new Error(`Optional archive download failed (HTTP ${response.status}).`);
  if (createDownloadIdentity(params.jobId, response) !== expectedIdentity) {
    await response.body.cancel();
    throw new Error('Optional result archive identity changed.');
  }
  await writeStream(params.storage, {
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    path: 'result.zip',
    body: response.body,
    contentType: 'application/zip',
    signal: params.signal,
  });
}

export function isSnapshotPath(path: string): boolean {
  const normalized: string = normalizeResultPath(path.replace(/\/$/, ''));
  return (
    normalized !== 'result.zip' &&
    normalized !== '.knowhere-sdk' &&
    !normalized.startsWith('.knowhere-sdk/')
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createDownloadIdentity(jobId: string, response: Response): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        jobId,
        response.headers.get('etag'),
        response.headers.get('last-modified'),
        response.headers.get('content-range')?.split('/').at(-1) ??
          response.headers.get('content-length'),
      ]),
    )
    .digest('hex');
}
