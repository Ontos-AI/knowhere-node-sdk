import { createHash } from 'crypto';
import { ValidationError } from '../errors/index.js';
import { ArchiveCacheTransportError } from './archive-cache-transport-error.js';
import { prepareCachedArchive } from './parsed-document-archive-cache.js';
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
} from './parsed-document-storage.js';

export interface ArchiveEntry {
  readonly path: string;
  readonly contentLength?: number;
  readonly read: () => ReadableStream<Uint8Array>;
}

export interface ArchiveSource {
  readonly canSkipEntries: boolean;
  readonly identity: string;
  readonly downloadIdentity: string;
  readonly archiveCacheBypassed?: boolean;
  readonly isCached?: boolean;
  readonly entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>;
  readonly close: () => Promise<void>;
}

export interface StreamedSyncParams {
  readonly documentId: string;
  readonly revisionKey: string;
  readonly jobId: string;
  readonly resultUrl: string;
  readonly storage: ParsedDocumentStorage;
  readonly limits?: ParsedDocumentStorageLimits;
  readonly signal?: AbortSignal;
  readonly retainResultArchive?: boolean;
  readonly cacheResultArchive?: boolean;
  readonly verifyRevision?: () => Promise<void>;
}

/** Copies bounded streams concurrently and checkpoints only the contiguous successful prefix. */
export async function syncRemoteResultArchive(
  params: StreamedSyncParams,
): Promise<KnowledgeSyncParsedDocumentResponse> {
  params.signal?.throwIfAborted();
  validateArchiveSyncLimits(params.limits);
  const startedAt: number = Date.now();
  const maxEntries: number = params.limits?.maxEntriesPerSync ?? 100;
  const deadlineMs: number = params.limits?.archiveSyncDeadlineMs ?? 120_000;
  const checkpointFileInterval: number = params.limits?.checkpointFileInterval ?? 1;
  const checkpointIntervalMs: number = params.limits?.checkpointIntervalMs ?? 2_000;
  const controller: AbortController = new AbortController();
  const signal: AbortSignal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  const transferParams: StreamedSyncParams = { ...params, signal };
  const previous: ParsedDocumentSyncProgress | null = await params.storage.readSyncProgress(params);
  const source: ArchiveSource = await openArchive(transferParams, previous);
  const concurrency: number = source.canSkipEntries ? (params.limits?.maxConcurrentFiles ?? 1) : 1;
  const nextEntry: number =
    previous?.status === 'completed' ? 0 : (previous?.nextArchiveEntry ?? 0);
  const entryHashes: string[] = [];
  const successfulHashes: Map<number, string> = new Map();
  const running: Set<Promise<void>> = new Set();
  const paths: Set<string> = new Set();
  let entryIndex: number = 0;
  let startedEntries: number = 0;
  let successfulEntries: number = 0;
  let checkpointEntry: number = nextEntry;
  let checkpointAt: number = Date.now();
  let failure: Error | undefined;
  let archiveCacheBypassed: boolean | undefined = source.archiveCacheBypassed;

  async function flushProgress(
    isSegmentBoundary: boolean,
    isRecovering: boolean = false,
  ): Promise<void> {
    let contiguousEntry: number = checkpointEntry;
    while (successfulHashes.has(contiguousEntry)) {
      entryHashes[contiguousEntry] = successfulHashes.get(contiguousEntry)!;
      contiguousEntry += 1;
    }
    if (contiguousEntry === checkpointEntry) return;
    await params.storage.writeSyncProgress(
      {
        documentId: params.documentId,
        revisionKey: params.revisionKey,
        pinnedRevisionKey: params.revisionKey,
        archiveIdentity: source.identity,
        archiveCacheBypassed,
        archiveEntryHashes: entryHashes.slice(0, contiguousEntry),
        nextArchiveEntry: contiguousEntry,
        status: 'running',
        updatedAt: new Date().toISOString(),
      },
      { signal: isRecovering ? undefined : signal, isSegmentBoundary },
    );
    for (let index: number = checkpointEntry; index < contiguousEntry; index += 1)
      successfulHashes.delete(index);
    checkpointEntry = contiguousEntry;
    successfulEntries = successfulHashes.size;
    checkpointAt = Date.now();
  }

  function startEntry(entry: ArchiveEntry, index: number): void {
    const task: Promise<void> = copyEntry(transferParams, entry)
      .then(
        (hash: string): void => {
          successfulHashes.set(index, hash);
          successfulEntries += 1;
        },
        (error: unknown): void => {
          if (failure === undefined)
            failure = error instanceof Error ? error : new Error(String(error));
          controller.abort(error);
        },
      )
      .finally((): void => {
        running.delete(task);
      });
    running.add(task);
  }

  async function drainEntries(): Promise<void> {
    await Promise.all(running);
    if (failure !== undefined) throw failure;
    signal.throwIfAborted();
  }

  try {
    if (previous?.archiveIdentity && previous.archiveIdentity !== source.identity)
      throw new Error('Parsed result archive identity changed; start a new revision.');
    if (previous?.pinnedRevisionKey && previous.pinnedRevisionKey !== params.revisionKey)
      throw new Error('Parsed result revision changed while resuming archive sync.');
    for await (const entry of source.entries) {
      if (failure !== undefined) throw failure;
      signal.throwIfAborted();
      if (paths.has(entry.path)) throw new Error(`Duplicate parsed result path: ${entry.path}`);
      paths.add(entry.path);
      if (entryIndex < nextEntry) {
        const previousHash: string | undefined = previous?.archiveEntryHashes?.[entryIndex];
        if (!previousHash) throw new Error('Parsed archive checkpoint is missing an entry hash.');
        if (
          !source.canSkipEntries &&
          (await copyEntry(transferParams, entry, true)) !== previousHash
        )
          throw new Error('Parsed result archive entry changed while resuming.');
        entryHashes.push(previousHash);
        entryIndex += 1;
        continue;
      }
      if (
        startedEntries > 0 &&
        (startedEntries >= maxEntries || Date.now() - startedAt >= deadlineMs)
      ) {
        await drainEntries();
        await flushProgress(true);
        return { documentId: params.documentId, revisionKey: params.revisionKey, completed: false };
      }
      if (
        successfulEntries >= checkpointFileInterval ||
        Date.now() - checkpointAt >= checkpointIntervalMs
      ) {
        await drainEntries();
        await flushProgress(false);
      }
      startEntry(entry, entryIndex);
      entryIndex += 1;
      startedEntries += 1;
      if (running.size >= concurrency) await Promise.race(running);
    }
    await drainEntries();
    await flushProgress(true);
    await validateRequiredObjects(params, paths);
    await params.verifyRevision?.();
    signal.throwIfAborted();
    const commit: ParsedDocumentCommit = {
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
    await params.storage.writeSyncProgress(
      {
        documentId: params.documentId,
        revisionKey: params.revisionKey,
        pinnedRevisionKey: params.revisionKey,
        archiveIdentity: source.identity,
        archiveCacheBypassed,
        archiveEntryHashes: entryHashes,
        nextArchiveEntry: entryIndex,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      },
      { signal, isSegmentBoundary: true },
    );
    if (params.retainResultArchive && !source.isCached) {
      try {
        await retainArchive(transferParams, source.downloadIdentity);
      } catch {
        /* Optional archive retention never invalidates a committed snapshot. */
      }
    }
    return {
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      completed: true,
      commit,
    };
  } catch (error) {
    controller.abort(error);
    await Promise.all(running);
    const hasCacheTransportFailure: boolean =
      error instanceof ArchiveCacheTransportError || failure instanceof ArchiveCacheTransportError;
    if (hasCacheTransportFailure) archiveCacheBypassed = true;
    await flushProgress(true, true).catch((): void => undefined);
    if (hasCacheTransportFailure) {
      await persistArchiveCacheBypass(
        { ...params, signal: undefined },
        {
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          pinnedRevisionKey: params.revisionKey,
          archiveIdentity: source.identity,
          archiveEntryHashes: entryHashes.slice(0, checkpointEntry),
          nextArchiveEntry: checkpointEntry,
          status: 'running',
          updatedAt: new Date().toISOString(),
        },
      ).catch((): void => undefined);
    }
    throw failure ?? error;
  } finally {
    controller.abort();
    await Promise.all(running);
    await source.close();
  }
}

/** Validate configuration before job lookup, download, or storage writes. */
export function validateArchiveSyncLimits(limits: ParsedDocumentStorageLimits | undefined): void {
  const names: readonly (keyof ParsedDocumentStorageLimits)[] = [
    'maxEntriesPerSync',
    'archiveSyncDeadlineMs',
    'maxConcurrentFiles',
    'checkpointFileInterval',
    'checkpointIntervalMs',
  ];
  for (const name of names) {
    const value: number | undefined = limits?.[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new ValidationError(`${name} must be a positive safe integer.`);
  }
}

async function copyEntry(
  params: StreamedSyncParams,
  entry: ArchiveEntry,
  isVerification: boolean = false,
): Promise<string> {
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
  if (isVerification)
    await body.pipeTo(new WritableStream<Uint8Array>(), { signal: params.signal });
  else
    await writeStream(params.storage, {
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      path: entry.path,
      body,
      contentType: inferContentTypeFromPath(entry.path),
      contentLength: entry.contentLength,
      signal: params.signal,
    });
  return createHash('sha256').update(entry.path).update(hash.digest()).digest('hex');
}

async function openArchive(
  params: StreamedSyncParams,
  previous: ParsedDocumentSyncProgress | null,
): Promise<ArchiveSource> {
  const prepared: Awaited<ReturnType<typeof prepareCachedArchive>> | undefined =
    params.cacheResultArchive
      ? await prepareCachedArchive({
          ...params,
          archiveCacheBypassed: previous?.archiveCacheBypassed,
          onBypass: async (): Promise<void> => {
            await persistArchiveCacheBypass(params, previous);
          },
        })
      : undefined;
  try {
    return await openArchiveTransport(params, previous, prepared);
  } catch (error) {
    if (!prepared?.isCached) throw error;
    params.signal?.throwIfAborted();
    const bypass: ParsedDocumentSyncProgress = await persistArchiveCacheBypass(params, previous);
    return openArchive({ ...params, cacheResultArchive: false }, bypass);
  }
}

async function persistArchiveCacheBypass(
  params: StreamedSyncParams,
  previous: ParsedDocumentSyncProgress | null,
): Promise<ParsedDocumentSyncProgress> {
  const progress: ParsedDocumentSyncProgress = {
    ...(previous?.status === 'completed' ? {} : previous),
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    pinnedRevisionKey: params.revisionKey,
    archiveCacheBypassed: true,
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  await params.storage.writeSyncProgress(progress, { signal: params.signal });
  return progress;
}

async function openArchiveTransport(
  params: StreamedSyncParams,
  previous: ParsedDocumentSyncProgress | null,
  prepared: Awaited<ReturnType<typeof prepareCachedArchive>> | undefined,
): Promise<ArchiveSource> {
  const resultUrl: string = prepared?.resultUrl ?? params.resultUrl;
  const archiveCacheBypassed: boolean | undefined =
    prepared?.archiveCacheBypassed ?? previous?.archiveCacheBypassed;
  // Probe with GET, then cancel ignored Range responses before a reader can buffer them.
  let probe: Response = await fetch(resultUrl, {
    headers: { Range: 'bytes=0-0' },
    signal: params.signal,
  });
  if (!probe.ok) {
    await probe.body?.cancel();
    throw new Error(`Parsed result download failed (HTTP ${probe.status}).`);
  }
  if (prepared) probe = prepared.validateResponse(probe);
  const identity: string =
    prepared?.downloadIdentity ?? createDownloadIdentity(params.jobId, probe);
  const supportsRange: boolean = probe.status === 206 && probe.headers.has('content-range');
  await probe.body?.cancel();
  if (!supportsRange) {
    const { openSequentialArchive } = await import('./sequential-parsed-document-archive.js');
    const source: ArchiveSource = await openSequentialArchive(
      { ...params, resultUrl },
      identity,
      prepared?.isCached ? prepared.validateResponse : undefined,
    );
    return { ...source, archiveCacheBypassed };
  }
  const options: HttpOptions = {
    forceRangeRequests: true,
    preventHeadRequest: true,
    checkResourceChanges: true,
    fetch: async (input, init): Promise<Response> => {
      let response: Response;
      try {
        response = await fetch(input, { ...init, signal: params.signal });
      } catch (error) {
        params.signal?.throwIfAborted();
        if (prepared?.isCached)
          throw new ArchiveCacheTransportError(
            'Parsed result archive cache transport unavailable.',
          );
        throw error;
      }
      if (prepared?.isCached) return prepared.validateResponse(response);
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(`Parsed result Range request failed (HTTP ${response.status}).`);
      }
      return prepared ? prepared.validateResponse(response) : response;
    },
  };
  const reader = new ZipReader(new HttpRangeReader(resultUrl, options), {
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
      identity: previous?.archiveIdentity === identity ? identity : archiveIdentity,
      downloadIdentity: identity,
      archiveCacheBypassed,
      isCached: prepared?.isCached,
      canSkipEntries: previous?.archiveIdentity !== identity,
      entries: (function* (): Generator<ArchiveEntry> {
        for (const entry of files)
          yield {
            path: normalizeResultPath(entry.filename),
            contentLength: entry.uncompressedSize,
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

async function retainArchive(params: StreamedSyncParams, expectedIdentity: string): Promise<void> {
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
