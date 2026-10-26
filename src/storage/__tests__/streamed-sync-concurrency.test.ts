import JSZip from 'jszip';
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
    readonly cache?: boolean;
    readonly failPath?: string;
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
    (_input: unknown, init?: RequestInit): Promise<Response> => {
      const range: string | null = new Headers(init?.headers).get('range');
      const match: RegExpExecArray | null =
        range && !options.sequential ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
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
    const fixture: Fixture = await createFixture({
      failPath: 'file-0.txt',
      delays: { 'manifest.json': 1, 'chunks.json': 1, 'file-0.txt': 30 },
    });
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
    const fixture: Fixture = await createFixture({
      delays: { 'file-0.txt': 30 },
      onStart: (path): void => {
        if (path === 'file-0.txt')
          setTimeout((): void => controller.abort(new Error('Caller stopped')), 5);
      },
    });
    await expect(
      fixture.sync({ maxConcurrentFiles: 3, checkpointFileInterval: 20 }, controller.signal),
    ).rejects.toThrow(/Caller stopped/);
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(2);
    const completedAtReturn: number = fixture.finished.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(fixture.finished).toHaveLength(completedAtReturn);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
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

  it.each(['etag', 'http', 'network'] as const)(
    'persists cache bypass after an entry transport %s failure and retries from the origin',
    async (mode) => {
      let isInvalid: boolean = false;
      const fixture: Fixture = await createFixture({
        cache: true,
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
