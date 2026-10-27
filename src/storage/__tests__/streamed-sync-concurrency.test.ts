import { createHash } from 'crypto';
import JSZip from 'jszip';
import { ZipReader, type FileEntry } from '@zip.js/zip.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Knowledge } from '../../knowledge/knowledge.js';
import type { Knowhere } from '../../client.js';
import type {
  ParsedDocumentObject,
  ParsedDocumentObjectHead,
  ParsedDocumentStorage,
  ParsedDocumentStorageLimits,
  ParsedDocumentSyncProgress,
  ParsedDocumentWriteObjectStreamParams,
  ParsedDocumentWriteObjectResult,
} from '../../types/storage.js';
import { syncRemoteResultArchive } from '../streamed-parsed-document-sync.js';

interface Fixture {
  readonly storage: ParsedDocumentStorage;
  readonly objects: Map<string, Uint8Array>;
  readonly progress: ParsedDocumentSyncProgress[];
  readonly started: string[];
  readonly finished: string[];
  readonly lengths: Map<string, number | undefined>;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly sync: (limits?: ParsedDocumentStorageLimits, signal?: AbortSignal) => Promise<unknown>;
  readonly getPeak: () => number;
}

async function createFixture(
  options: {
    readonly sequential?: boolean;
    readonly originSequential?: boolean;
    readonly cache?: boolean;
    readonly failPath?: string;
    readonly wrapErrors?: boolean;
    readonly onStart?: (path: string) => void;
    readonly delays?: Readonly<Record<string, number>>;
  } = {},
): Promise<Fixture> {
  const zip: JSZip = new JSZip();
  zip.file('manifest.json', '{"job_id":"job"}');
  zip.file('chunks.json', '[]');
  for (let index: number = 0; index < 8; index += 1) zip.file(`file-${index}.txt`, `body-${index}`);
  const archive: Uint8Array = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  });
  const fetchMock: ReturnType<typeof vi.fn> = vi.fn(
    (input: unknown, init?: RequestInit): Promise<Response> => {
      const range: string | null = new Headers(init?.headers).get('range');
      const isSequentialOrigin: boolean =
        options.originSequential === true &&
        typeof input === 'string' &&
        input.startsWith('https://archive.example/');
      const match: RegExpExecArray | null =
        range && !options.sequential && !isSequentialOrigin
          ? /^bytes=(\d*)-(\d*)$/.exec(range)
          : null;
      const start: number = match?.[1] ? Number(match[1]) : 0;
      const end: number = match?.[2]
        ? Math.min(Number(match[2]), archive.length - 1)
        : archive.length - 1;
      return Promise.resolve(
        new Response(archive.slice(start, end + 1), {
          status: match ? 206 : 200,
          headers: {
            etag: '"archive"',
            'content-length': String(end - start + 1),
            ...(match ? { 'content-range': `bytes ${start}-${end}/${archive.length}` } : {}),
          },
        }),
      );
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  const objects: Map<string, Uint8Array> = new Map();
  const progress: ParsedDocumentSyncProgress[] = [];
  const started: string[] = [];
  const finished: string[] = [];
  const lengths: Map<string, number | undefined> = new Map();
  let active: number = 0;
  let peak: number = 0;
  const storage: ParsedDocumentStorage = {
    readObject(params): Promise<ParsedDocumentObject | null> {
      const body: Uint8Array | undefined = objects.get(params.path);
      return Promise.resolve(body ? { ...params, body } : null);
    },
    writeObject(params) {
      objects.set(params.path, params.body);
      return Promise.resolve(params);
    },
    async writeObjectStream(params: ParsedDocumentWriteObjectStreamParams) {
      started.push(params.path);
      options.onStart?.(params.path);
      lengths.set(
        params.path,
        'contentLength' in params ? Number(params.contentLength) : undefined,
      );
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.delays?.[params.path] ?? 2),
        );
        if (params.path === options.failPath) throw new Error(`write failed: ${params.path}`);
        const parts: Uint8Array[] = [];
        for await (const part of params.body) {
          params.signal?.throwIfAborted();
          parts.push(part);
        }
        objects.set(params.path, Buffer.concat(parts));
        finished.push(params.path);
        return { ...params, entityTag: '"archive"' };
      } catch (error) {
        if (options.wrapErrors) throw new Error('Storage adapter write failed', { cause: error });
        throw error;
      } finally {
        active -= 1;
      }
    },
    readSyncProgress: () => Promise.resolve(progress.at(-1) ?? null),
    writeSyncProgress: (value) => {
      progress.push(value);
      return Promise.resolve();
    },
  };
  if (options.cache) {
    storage.headObject = (params): Promise<ParsedDocumentObjectHead | null> => {
      const body: Uint8Array | undefined = objects.get(params.path);
      return Promise.resolve(
        body ? { ...params, contentLength: body.length, entityTag: '"archive"' } : null,
      );
    };
    storage.getObjectUrl = (): Promise<string | null> =>
      Promise.resolve('https://cache.example/result.zip');
  }
  return {
    storage,
    objects,
    progress,
    started,
    finished,
    lengths,
    fetch: fetchMock,
    getPeak: (): number => peak,
    sync: (limits, signal): Promise<unknown> =>
      syncRemoteResultArchive({
        documentId: 'document',
        revisionKey: 'revision',
        jobId: 'job',
        resultUrl: 'https://archive.example/result.zip',
        storage,
        limits,
        signal,
      }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bounded parsed archive concurrency', () => {
  it('copies Range entries concurrently and provides the expected uncompressed length', async () => {
    const fixture: Fixture = await createFixture({ delays: { 'manifest.json': 20 } });
    await fixture.sync({ maxConcurrentFiles: 3, checkpointFileInterval: 4 });
    expect(fixture.getPeak()).toBe(3);
    expect(fixture.lengths.get('manifest.json')).toBe(Buffer.byteLength('{"job_id":"job"}'));
    expect(fixture.progress.at(-1)).toMatchObject({ status: 'completed', nextArchiveEntry: 10 });
  });

  it('batches checkpoints and stops scheduling while the checkpoint is blocked', async () => {
    const fixture: Fixture = await createFixture();
    let releaseCheckpoint: (() => void) | undefined;
    const checkpointGate: Promise<void> = new Promise((resolve) => {
      releaseCheckpoint = resolve;
    });
    let markCheckpoint: (() => void) | undefined;
    const checkpointStarted: Promise<void> = new Promise((resolve) => {
      markCheckpoint = resolve;
    });
    fixture.storage.writeSyncProgress = async (value): Promise<void> => {
      fixture.progress.push(value);
      if (fixture.progress.length === 1) {
        markCheckpoint?.();
        await checkpointGate;
      }
    };
    const sync: Promise<unknown> = fixture.sync({
      maxConcurrentFiles: 3,
      checkpointFileInterval: 4,
    });
    await checkpointStarted;
    const startedAtCheckpoint: number = fixture.started.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(fixture.started.length).toBe(startedAtCheckpoint);
    releaseCheckpoint?.();
    await sync;
    const running: ParsedDocumentSyncProgress[] = fixture.progress.filter(
      (value) => value.status === 'running',
    );
    expect(running.length).toBeLessThan(10);
    expect(running[0].nextArchiveEntry).toBeGreaterThanOrEqual(4);
    expect(running[0].nextArchiveEntry).toBeLessThanOrEqual(6);
  });

  it('flushes only the contiguous successful prefix and settles all writes after a failure', async () => {
    const fixture: Fixture = await createFixture({ failPath: 'file-0.txt' });
    const writeStream: ParsedDocumentStorage['writeObjectStream'] =
      fixture.storage.writeObjectStream?.bind(fixture.storage);
    if (!writeStream) throw new Error('Failure fixture requires stream storage.');
    let confirmPrefix: (() => void) | undefined;
    const prefixCompleted: Promise<void> = new Promise((resolve) => {
      confirmPrefix = resolve;
    });
    const successfulPaths: Set<string> = new Set();
    fixture.storage.writeObjectStream = async (
      params: ParsedDocumentWriteObjectStreamParams,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.path === 'file-0.txt') await prefixCompleted;
      const result: ParsedDocumentWriteObjectResult = await writeStream(params);
      successfulPaths.add(params.path);
      if (successfulPaths.has('manifest.json') && successfulPaths.has('chunks.json'))
        confirmPrefix?.();
      return result;
    };
    await expect(
      fixture.sync({ maxConcurrentFiles: 3, checkpointFileInterval: 20 }),
    ).rejects.toThrow(/write failed/);
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(2);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
    const writesAtReturn: number = fixture.finished.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(fixture.finished.length).toBe(writesAtReturn);
  });

  it('flushes a successful prefix on caller cancellation and settles active writes', async () => {
    const controller: AbortController = new AbortController();
    const fixture: Fixture = await createFixture({ delays: { 'chunks.json': 30 } });
    const writeStream: ParsedDocumentStorage['writeObjectStream'] =
      fixture.storage.writeObjectStream?.bind(fixture.storage);
    if (!writeStream) throw new Error('Cancellation fixture requires stream storage.');
    const successfulPaths: Set<string> = new Set();
    let confirmPrefix: (() => void) | undefined;
    const prefixCompleted: Promise<void> = new Promise((resolve) => {
      confirmPrefix = resolve;
    });
    let confirmPendingWrite: (() => void) | undefined;
    const pendingWriteStarted: Promise<void> = new Promise((resolve) => {
      confirmPendingWrite = resolve;
    });
    const cancelled: Promise<void> = new Promise((resolve) => {
      controller.signal.addEventListener('abort', (): void => resolve(), { once: true });
    });
    let pendingWrites: number = 0;
    let settledWrites: number = 0;
    fixture.storage.writeObjectStream = async (
      params: ParsedDocumentWriteObjectStreamParams,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.path === 'manifest.json' || params.path === 'chunks.json') {
        const result: ParsedDocumentWriteObjectResult = await writeStream(params);
        successfulPaths.add(params.path);
        if (successfulPaths.size === 2) confirmPrefix?.();
        return result;
      }
      pendingWrites += 1;
      confirmPendingWrite?.();
      try {
        await cancelled;
        params.signal?.throwIfAborted();
        throw new Error('Cancellation signal was not propagated to the active write.');
      } finally {
        pendingWrites -= 1;
        settledWrites += 1;
      }
    };
    const sync: Promise<unknown> = fixture.sync(
      { maxConcurrentFiles: 3, checkpointFileInterval: 20 },
      controller.signal,
    );
    const rejectedSync: Promise<void> = expect(sync).rejects.toThrow(/Caller stopped/);
    await Promise.all([prefixCompleted, pendingWriteStarted]);
    expect(successfulPaths).toEqual(new Set(['manifest.json', 'chunks.json']));
    expect(fixture.finished).toHaveLength(2);
    expect(pendingWrites).toBeGreaterThan(0);
    controller.abort(new Error('Caller stopped'));
    await rejectedSync;
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(2);
    expect(fixture.finished).toHaveLength(2);
    expect(pendingWrites).toBe(0);
    expect(settledWrites).toBeGreaterThan(0);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('rejects a producer failure while its writable is locked without hanging the sink', async () => {
    const fixture: Fixture = await createFixture();
    let rejectProducer: (() => void) | undefined;
    const producerRejected: Promise<void> = new Promise((resolve) => {
      rejectProducer = resolve;
    });
    let heldWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const entry: FileEntry = {
      filename: 'manifest.json',
      directory: false,
      uncompressedSize: 16,
      signature: 0,
      getData(writable: WritableStream<Uint8Array>): Promise<void> {
        heldWriter = writable.getWriter();
        void heldWriter.closed.catch((): void => undefined);
        rejectProducer?.();
        return Promise.reject(new Error('Locked producer failed'));
      },
    } as FileEntry;
    vi.spyOn(ZipReader.prototype, 'getEntries').mockResolvedValue([entry]);
    fixture.storage.writeObjectStream = async (
      params: ParsedDocumentWriteObjectStreamParams,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      await params.body.pipeTo(new WritableStream<Uint8Array>());
      return params;
    };
    const result: Promise<string> = fixture.sync().then(
      (): string => 'completed',
      (error: unknown): string => (error instanceof Error ? error.message : 'unknown failure'),
    );
    try {
      await producerRejected;
      const state: string = await Promise.race([
        result,
        new Promise<string>((resolve) => setImmediate((): void => resolve('pending'))),
      ]);
      expect(state).toBe('Locked producer failed');
    } finally {
      await heldWriter?.abort(new Error('Release held producer fixture'));
      heldWriter?.releaseLock();
      await result;
    }
  });

  it('rejects a late producer error after body EOF before checkpointing successful bytes', async () => {
    const fixture: Fixture = await createFixture();
    const entry: FileEntry = {
      filename: 'manifest.json',
      directory: false,
      uncompressedSize: 16,
      signature: 0,
      async getData(writable: WritableStream<Uint8Array>): Promise<void> {
        const writer: WritableStreamDefaultWriter<Uint8Array> = writable.getWriter();
        try {
          await writer.write(Buffer.from('{"job_id":"job"}'));
          await writer.close();
        } finally {
          writer.releaseLock();
        }
        throw new Error('Late producer failed');
      },
    } as FileEntry;
    vi.spyOn(ZipReader.prototype, 'getEntries').mockResolvedValue([
      entry,
      { ...entry, filename: 'chunks.json' },
    ]);
    await expect(fixture.sync({ maxEntriesPerSync: 1 })).rejects.toThrow('Late producer failed');
    expect(fixture.progress).toHaveLength(0);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('waits for Range producer cleanup before returning an incomplete segment', async () => {
    const fixture: Fixture = await createFixture();
    let startCleanup: (() => void) | undefined;
    const cleanupStarted: Promise<void> = new Promise((resolve) => {
      startCleanup = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate: Promise<void> = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    let hasCleanedProducer: boolean = false;
    const entry: FileEntry = {
      filename: 'manifest.json',
      directory: false,
      uncompressedSize: 16,
      signature: 0,
      async getData(writable: WritableStream<Uint8Array>): Promise<void> {
        const writer: WritableStreamDefaultWriter<Uint8Array> = writable.getWriter();
        try {
          await writer.write(Buffer.from('{"job_id":"job"}'));
          await writer.close();
        } finally {
          writer.releaseLock();
          startCleanup?.();
          await cleanupGate;
          hasCleanedProducer = true;
        }
      },
    } as FileEntry;
    vi.spyOn(ZipReader.prototype, 'getEntries').mockResolvedValue([
      entry,
      { ...entry, filename: 'chunks.json' },
    ]);
    const sync: Promise<unknown> = fixture.sync({ maxEntriesPerSync: 1 });
    try {
      await cleanupStarted;
      const state: string = await Promise.race([
        sync.then((): string => 'returned'),
        new Promise<string>((resolve) => setImmediate((): void => resolve('waiting'))),
      ]);
      expect(state).toBe('waiting');
      expect(hasCleanedProducer).toBe(false);
      expect(fixture.progress).toHaveLength(0);
    } finally {
      releaseCleanup?.();
      await sync;
    }
    expect(hasCleanedProducer).toBe(true);
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(1);
    expect(await sync).toMatchObject({ completed: false });
  });

  it('counts started entries against the segment limit and marks its checkpoint boundary', async () => {
    const fixture: Fixture = await createFixture();
    const options: Array<{ readonly isSegmentBoundary?: boolean } | undefined> = [];
    fixture.storage.writeSyncProgress = (value, checkpointOptions): Promise<void> => {
      fixture.progress.push(value);
      options.push(checkpointOptions);
      return Promise.resolve();
    };
    expect(
      await fixture.sync({
        maxConcurrentFiles: 3,
        checkpointFileInterval: 20,
        maxEntriesPerSync: 4,
      }),
    ).toMatchObject({ completed: false });
    expect(fixture.started).toHaveLength(4);
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(4);
    expect(options.at(-1)?.isSegmentBoundary).toBe(true);
  });

  it('forces sequential archive sources to use one active entry', async () => {
    const fixture: Fixture = await createFixture({ sequential: true });
    await fixture.sync({ maxConcurrentFiles: 4, checkpointFileInterval: 4 });
    expect(fixture.getPeak()).toBe(1);
    expect(fixture.lengths.get('manifest.json')).toBe(Buffer.byteLength('{"job_id":"job"}'));
  });

  it('flushes on the elapsed checkpoint interval before starting more entries', async () => {
    const fixture: Fixture = await createFixture({
      delays: { 'manifest.json': 10, 'chunks.json': 10 },
    });
    await fixture.sync({
      maxConcurrentFiles: 2,
      checkpointFileInterval: 50,
      checkpointIntervalMs: 3,
    });
    expect(fixture.progress[0].nextArchiveEntry).toBe(2);
    expect(fixture.progress.filter((value) => value.status === 'running').length).toBeGreaterThan(
      1,
    );
  });

  it.each([
    'maxConcurrentFiles',
    'checkpointFileInterval',
    'checkpointIntervalMs',
    'maxEntriesPerSync',
    'archiveSyncDeadlineMs',
  ] as const)('rejects invalid %s before any network access', async (name) => {
    const fixture: Fixture = await createFixture();
    await expect(fixture.sync({ [name]: 0 })).rejects.toThrow(new RegExp(name));
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('uses one full origin fetch when caching and retaining the archive together', async () => {
    const fixture: Fixture = await createFixture({ cache: true });
    await syncRemoteResultArchive({
      documentId: 'document',
      revisionKey: 'revision',
      jobId: 'job',
      resultUrl: 'https://archive.example/result.zip',
      storage: fixture.storage,
      cacheResultArchive: true,
      retainResultArchive: true,
    });
    expect(fixture.started.filter((path) => path === 'result.zip')).toHaveLength(1);
    const fullFetches: number = fixture.fetch.mock.calls.filter((call: readonly unknown[]) => {
      const init: RequestInit | undefined = call[1] as RequestInit | undefined;
      return !new Headers(init?.headers).has('range');
    }).length;
    expect(fullFetches).toBe(1);
  });

  it('verifies progressive cached bytes without downloading the full origin twice', async () => {
    const fixture: Fixture = await createFixture({ cache: true });
    const response: Response = await fetch('https://archive.example/result.zip');
    const archive: Uint8Array = new Uint8Array(await response.arrayBuffer());
    fixture.fetch.mockClear();
    await syncRemoteResultArchive({
      documentId: 'document',
      revisionKey: 'snapshot',
      jobId: 'job',
      resultUrl: 'https://archive.example/result.zip',
      storage: fixture.storage,
      cacheResultArchive: true,
      retainResultArchive: true,
      snapshot: {
        snapshotId: 'snapshot',
        stage: 'baseline',
        documentId: 'document',
        jobId: 'job',
        jobResultId: 'result',
        checksum: createHash('sha256').update(archive).digest('hex'),
        resultUrl: 'https://archive.example/result.zip',
        resultUrlExpiresAt: new Date('2030-01-01'),
      },
    });
    const originDownloads: number = fixture.fetch.mock.calls.filter(
      (call: readonly unknown[]) =>
        String(call[0]).includes('archive.example') &&
        !new Headers((call[1] as RequestInit | undefined)?.headers).has('range'),
    ).length;
    expect(originDownloads).toBe(1);
    expect(Array.from(fixture.objects.get('result.zip') ?? [])).toEqual(Array.from(archive));
  });

  it('verifies a legacy sequential checkpoint when resuming through cached Range transport', async () => {
    const options = { sequential: true, cache: true };
    const fixture: Fixture = await createFixture(options);
    await fixture.sync({ maxEntriesPerSync: 2 });
    const checkpoint: string | undefined = fixture.progress.at(-1)?.archiveIdentity;
    options.sequential = false;
    await syncRemoteResultArchive({
      documentId: 'document',
      revisionKey: 'revision',
      jobId: 'job',
      resultUrl: 'https://archive.example/result.zip',
      storage: fixture.storage,
      cacheResultArchive: true,
    });
    expect(fixture.progress.at(-1)).toMatchObject({
      status: 'completed',
      archiveIdentity: checkpoint,
    });
    expect(fixture.started.filter((path) => path === 'manifest.json')).toHaveLength(1);
    expect(fixture.started.filter((path) => path === 'chunks.json')).toHaveLength(1);
  });

  it('resumes cached Range checkpoints through sequential origin after persistent cache bypass', async () => {
    const fixture: Fixture = await createFixture({ cache: true, originSequential: true });
    const sync = (maxEntriesPerSync: number): Promise<unknown> =>
      syncRemoteResultArchive({
        documentId: 'document',
        revisionKey: 'revision',
        jobId: 'job',
        resultUrl: 'https://archive.example/result.zip',
        storage: fixture.storage,
        cacheResultArchive: true,
        limits: { maxEntriesPerSync },
      });
    expect(await sync(1)).toMatchObject({ completed: false });
    const checkpoint: ParsedDocumentSyncProgress | undefined = fixture.progress.at(-1);
    fixture.storage.getObjectUrl = (): Promise<null> => Promise.resolve(null);
    expect(await sync(1)).toMatchObject({ completed: false });
    expect(await sync(100)).toMatchObject({ completed: true });
    expect(typeof checkpoint?.archiveDownloadIdentity).toBe('string');
    for (const progress of fixture.progress) {
      expect(progress.archiveIdentity).toBe(checkpoint?.archiveIdentity);
      expect(progress.archiveDownloadIdentity).toBe(checkpoint?.archiveDownloadIdentity);
    }
    expect(fixture.progress.at(-1)?.archiveCacheBypassed).toBe(true);
    expect(fixture.started.filter((path) => path === 'manifest.json')).toHaveLength(1);
    expect(fixture.started.filter((path) => path === 'chunks.json')).toHaveLength(1);
    expect(await sync(1)).toMatchObject({ completed: false });
    expect(fixture.progress.at(-1)).toMatchObject({
      archiveIdentity: checkpoint?.archiveIdentity,
      archiveDownloadIdentity: checkpoint?.archiveDownloadIdentity,
      nextArchiveEntry: 1,
    });
  });

  it.each(['changed origin', 'missing origin proof', 'changed saved prefix'] as const)(
    'rejects sequential fallback from cached Range with %s',
    async (mode) => {
      const fixture: Fixture = await createFixture({ cache: true, originSequential: true });
      const sync = (): Promise<unknown> =>
        syncRemoteResultArchive({
          documentId: 'document',
          revisionKey: 'revision',
          jobId: 'job',
          resultUrl: 'https://archive.example/result.zip',
          storage: fixture.storage,
          cacheResultArchive: true,
          limits: { maxEntriesPerSync: 1 },
        });
      await sync();
      fixture.storage.getObjectUrl = (): Promise<null> => Promise.resolve(null);
      const checkpoint: ParsedDocumentSyncProgress = fixture.progress.at(-1)!;
      if (mode === 'changed origin') {
        const originalFetch: typeof fetch = fetch;
        vi.stubGlobal(
          'fetch',
          async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const response: Response = await originalFetch(input, init);
            const headers: Headers = new Headers(response.headers);
            headers.set('etag', '"changed-origin"');
            return new Response(response.body, { status: response.status, headers });
          },
        );
      } else {
        fixture.progress.push({
          ...checkpoint,
          ...(mode === 'missing origin proof'
            ? { archiveDownloadIdentity: undefined }
            : { archiveEntryHashes: ['different saved entry hash'] }),
        });
      }
      await expect(sync()).rejects.toThrow(
        mode === 'changed saved prefix' ? /entry changed while resuming/ : /identity changed/,
      );
      expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
      expect(fixture.started.filter((path) => path !== 'result.zip')).toHaveLength(1);
    },
  );

  it('retains cached origin proof when extraction failure persists bypass before sequential resume', async () => {
    let isInvalid: boolean = false;
    const fixture: Fixture = await createFixture({
      cache: true,
      originSequential: true,
      wrapErrors: true,
      onStart: (path): void => {
        if (path === 'file-0.txt') isInvalid = true;
      },
    });
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response: Response = await originalFetch(input, init);
        if (typeof input !== 'string' || !input.startsWith('https://cache.example/') || !isInvalid)
          return response;
        const headers: Headers = new Headers(response.headers);
        headers.set('etag', '"changed-cache"');
        return new Response(response.body, { status: response.status, headers });
      },
    );
    const sync = (): Promise<unknown> =>
      syncRemoteResultArchive({
        documentId: 'document',
        revisionKey: 'revision',
        jobId: 'job',
        resultUrl: 'https://archive.example/result.zip',
        storage: fixture.storage,
        cacheResultArchive: true,
      });
    await expect(sync()).rejects.toThrow();
    const checkpoint: ParsedDocumentSyncProgress | undefined = fixture.progress.at(-1);
    expect(checkpoint).toMatchObject({
      archiveCacheBypassed: true,
      nextArchiveEntry: 2,
    });
    expect(typeof checkpoint?.archiveDownloadIdentity).toBe('string');
    expect(await sync()).toMatchObject({ completed: true });
    expect(fixture.progress.at(-1)).toMatchObject({
      archiveIdentity: checkpoint?.archiveIdentity,
      archiveDownloadIdentity: checkpoint?.archiveDownloadIdentity,
    });
  });

  it('accepts cached Range responses with stable entity tags and changing Last-Modified metadata', async () => {
    let hasStartedSnapshot: boolean = false;
    const fixture: Fixture = await createFixture({
      cache: true,
      onStart: (path): void => {
        if (path !== 'result.zip') hasStartedSnapshot = true;
      },
    });
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response: Response = await originalFetch(input, init);
        const url: string =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://cache.example/')) return response;
        const headers: Headers = new Headers(response.headers);
        headers.set(
          'last-modified',
          hasStartedSnapshot ? 'Tue, 01 Oct 2024 00:00:01 GMT' : 'Tue, 01 Oct 2024 00:00:00 GMT',
        );
        return new Response(response.body, { status: response.status, headers });
      },
    );
    expect(
      await syncRemoteResultArchive({
        documentId: 'document',
        revisionKey: 'revision',
        jobId: 'job',
        resultUrl: 'https://archive.example/result.zip',
        storage: fixture.storage,
        cacheResultArchive: true,
        limits: { maxConcurrentFiles: 3, checkpointFileInterval: 4 },
      }),
    ).toMatchObject({ completed: true });
    expect(fixture.progress.at(-1)?.archiveCacheBypassed).toBe(false);
  });

  it('preserves origin Range checks when Last-Modified changes during extraction', async () => {
    let hasStartedSnapshot: boolean = false;
    const fixture: Fixture = await createFixture({
      onStart: (): void => {
        hasStartedSnapshot = true;
      },
    });
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response: Response = await originalFetch(input, init);
        const headers: Headers = new Headers(response.headers);
        headers.set(
          'last-modified',
          hasStartedSnapshot ? 'Tue, 01 Oct 2024 00:00:01 GMT' : 'Tue, 01 Oct 2024 00:00:00 GMT',
        );
        return new Response(response.body, { status: response.status, headers });
      },
    );
    await expect(fixture.sync({ maxConcurrentFiles: 3 })).rejects.toThrow('HTTP resource changed');
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('falls back to the origin if cached transport changes during archive setup', async () => {
    const fixture: Fixture = await createFixture({ cache: true });
    const originalFetch: typeof fetch = fetch;
    let cacheRequests: number = 0;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response: Response = await originalFetch(input, init);
        if (
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).startsWith('https://cache.example/')
        ) {
          cacheRequests += 1;
          if (cacheRequests > 2) {
            const headers: Headers = new Headers(response.headers);
            headers.set('etag', '"changed-cache"');
            return new Response(response.body, { status: response.status, headers });
          }
        }
        return response;
      },
    );
    expect(
      await syncRemoteResultArchive({
        documentId: 'document',
        revisionKey: 'revision',
        jobId: 'job',
        resultUrl: 'https://archive.example/result.zip',
        storage: fixture.storage,
        cacheResultArchive: true,
      }),
    ).toMatchObject({ completed: true });
    expect(fixture.progress.at(-1)?.archiveCacheBypassed).toBe(true);
  });

  it.each([
    ['etag', false],
    ['etag', true],
    ['http', false],
    ['http', true],
    ['network', false],
    ['network', true],
  ] as const)(
    'persists cache bypass after transport %s failure with adapter wrapping %s',
    async (mode, wrapErrors) => {
      let isInvalid: boolean = false;
      const fixture: Fixture = await createFixture({
        cache: true,
        wrapErrors,
        onStart: (path): void => {
          if (path === 'file-0.txt') isInvalid = true;
        },
      });
      const originalFetch: typeof fetch = fetch;
      vi.stubGlobal(
        'fetch',
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const response: Response = await originalFetch(input, init);
          if (
            (typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url
            ).startsWith('https://cache.example/') &&
            isInvalid
          ) {
            if (mode === 'http') return new Response(null, { status: 503 });
            if (mode === 'network') throw new Error('Cache transport unavailable');
            const headers: Headers = new Headers(response.headers);
            headers.set('etag', '"changed-cache"');
            return new Response(response.body, { status: response.status, headers });
          }
          return response;
        },
      );
      const sync = (): Promise<unknown> =>
        syncRemoteResultArchive({
          documentId: 'document',
          revisionKey: 'revision',
          jobId: 'job',
          resultUrl: 'https://archive.example/result.zip',
          storage: fixture.storage,
          cacheResultArchive: true,
        });
      await expect(sync()).rejects.toThrow();
      expect(fixture.progress.at(-1)?.archiveCacheBypassed).toBe(true);
      expect(await sync()).toMatchObject({ completed: true });
    },
  );

  it('preserves a storage failure with a cyclic cause without hanging recovery', async () => {
    const fixture: Fixture = await createFixture();
    const error: Error = new Error('Cyclic storage failure');
    error.cause = error;
    fixture.storage.writeObjectStream = (): Promise<ParsedDocumentWriteObjectResult> =>
      Promise.reject(error);
    await expect(fixture.sync()).rejects.toBe(error);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('rejects a changed sequential origin after cache bypass without an initial identity', async () => {
    const fixture: Fixture = await createFixture({ sequential: true });
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response: Response = await originalFetch(input, init);
        if (!new Headers(init?.headers).has('range')) {
          const headers: Headers = new Headers(response.headers);
          headers.set('etag', '"changed-origin"');
          return new Response(response.body, { status: response.status, headers });
        }
        return response;
      },
    );
    await expect(
      syncRemoteResultArchive({
        documentId: 'document',
        revisionKey: 'revision',
        jobId: 'job',
        resultUrl: 'https://archive.example/result.zip',
        storage: fixture.storage,
        cacheResultArchive: true,
      }),
    ).rejects.toThrow(/identity changed/);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('persists cache bypass before extracting when the adapter has no cache capabilities', async () => {
    const fixture: Fixture = await createFixture();
    await syncRemoteResultArchive({
      documentId: 'document',
      revisionKey: 'revision',
      jobId: 'job',
      resultUrl: 'https://archive.example/result.zip',
      storage: fixture.storage,
      cacheResultArchive: true,
    });
    expect(fixture.progress[0].archiveCacheBypassed).toBe(true);
    expect(fixture.progress.at(-1)?.archiveCacheBypassed).toBe(true);
  });

  it('validates limits before resolving a remote document reference', async () => {
    const listChunks = vi.fn();
    const client: Knowhere = { documents: { listChunks } } as unknown as Knowhere;
    const fixture: Fixture = await createFixture();
    const knowledge: Knowledge = new Knowledge(client).withParsedStorage({
      storage: fixture.storage,
      limits: { maxConcurrentFiles: 0 },
    });
    await expect(knowledge.syncParsedDocument({ documentId: 'document' })).rejects.toThrow(
      /maxConcurrentFiles/,
    );
    expect(listChunks).not.toHaveBeenCalled();
  });
});
