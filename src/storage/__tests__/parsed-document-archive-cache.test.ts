import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ParsedDocumentObject,
  ParsedDocumentStorage,
  ParsedDocumentWriteObjectResult,
} from '../../types/storage.js';
import { prepareCachedArchive } from '../parsed-document-archive-cache.js';

interface CacheFixture {
  readonly storage: ParsedDocumentStorage;
  readonly objects: Map<string, Uint8Array>;
  readonly requests: Array<{ readonly url: string; readonly range: string | null }>;
  readonly archive: Uint8Array;
  readonly getStorageVersion: () => string;
}

function createFixture(): CacheFixture {
  const archive: Uint8Array = new TextEncoder().encode('complete archive bytes');
  const objects: Map<string, Uint8Array> = new Map();
  const requests: CacheFixture['requests'] = [];
  let storageVersion: string = '"storage-0"';
  let urlSequence: number = 0;
  const storage: ParsedDocumentStorage = {
    readObject(params): Promise<ParsedDocumentObject | null> {
      const body: Uint8Array | undefined = objects.get(params.path);
      return Promise.resolve(body ? { ...params, body } : null);
    },
    writeObject(params): Promise<ParsedDocumentWriteObjectResult> {
      objects.set(params.path, params.body);
      return Promise.resolve(params);
    },
    async writeObjectStream(params): Promise<ParsedDocumentWriteObjectResult> {
      const parts: Uint8Array[] = [];
      for await (const chunk of params.body) parts.push(chunk);
      const body: Uint8Array = Buffer.concat(parts);
      objects.set(params.path, body);
      storageVersion = '"storage-1"';
      return { ...params, entityTag: storageVersion };
    },
    headObject(params) {
      const body: Uint8Array | undefined = objects.get(params.path);
      return Promise.resolve(
        body ? { ...params, contentLength: body.length, entityTag: storageVersion } : null,
      );
    },
    getObjectUrl(): Promise<string> {
      urlSequence += 1;
      return Promise.resolve(`https://cache.example/result.zip?signature=${urlSequence}`);
    },
    readSyncProgress(): Promise<null> {
      return Promise.resolve(null);
    },
    writeSyncProgress(): Promise<void> {
      return Promise.resolve();
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url: string =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const range: string | null = new Headers(init?.headers).get('range');
      requests.push({ url, range });
      const isCache: boolean = url.startsWith('https://cache.example/');
      const body: Uint8Array = isCache ? (objects.get('result.zip') ?? new Uint8Array()) : archive;
      const entityTag: string = isCache ? storageVersion : '"origin-version"';
      if (range)
        return Promise.resolve(
          new Response(body.slice(0, 1), {
            status: 206,
            headers: {
              etag: entityTag,
              'content-length': '1',
              'content-range': `bytes 0-0/${body.length}`,
            },
          }),
        );
      return Promise.resolve(
        new Response(body, { headers: { etag: entityTag, 'content-length': String(body.length) } }),
      );
    }),
  );
  return { storage, objects, requests, archive, getStorageVersion: (): string => storageVersion };
}

const document = {
  documentId: 'document-test',
  revisionKey: 'revision-test',
  jobId: 'job-test',
  resultUrl: 'https://origin.example/result.zip?signature=1',
} as const;

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('prepareCachedArchive', (): void => {
  it('streams the origin once and publishes a version-bound completion marker afterward', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();

    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });

    expect(prepared.isCached).toBe(true);
    expect(prepared.resultUrl).toMatch(/^https:\/\/cache\.example\//);
    expect(new Uint8Array(fixture.objects.get('result.zip')!)).toEqual(fixture.archive);
    expect(
      fixture.requests.filter(
        (request): boolean => request.url.includes('origin') && !request.range,
      ),
    ).toHaveLength(1);
    const markers: string[] = [...fixture.objects.keys()].filter((path): boolean =>
      path.startsWith('.knowhere-sdk/archive-cache/'),
    );
    expect(markers).toHaveLength(1);
    const marker: unknown = JSON.parse(Buffer.from(fixture.objects.get(markers[0])!).toString());
    expect(marker).toMatchObject({
      version: 1,
      jobId: document.jobId,
      revisionKey: document.revisionKey,
      originIdentity: prepared.downloadIdentity,
      contentLength: fixture.archive.length,
      sha256: createHash('sha256').update(fixture.archive).digest('hex'),
      storageEntityTag: fixture.getStorageVersion(),
    });
    expect(JSON.stringify(marker)).not.toContain('signature=');
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('reuses a persisted marker across invocations with freshly signed transport URLs', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const first = await prepareCachedArchive({ ...document, storage: fixture.storage });
    const second = await prepareCachedArchive({
      ...document,
      storage: fixture.storage,
      resultUrl: 'https://origin.example/result.zip?signature=2',
    });

    expect(second.isCached).toBe(true);
    expect(second.resultUrl).not.toBe(first.resultUrl);
    expect(second.downloadIdentity).toBe(first.downloadIdentity);
    expect(
      fixture.requests.filter(
        (request): boolean => request.url.includes('origin') && !request.range,
      ),
    ).toHaveLength(1);
    expect(fixture.requests.some((request): boolean => request.url.endsWith('signature=2'))).toBe(
      true,
    );
  });

  it('honors a previous bypass without attempting cache storage again', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const headObject = vi.spyOn(fixture.storage, 'headObject');
    const writeObjectStream = vi.spyOn(fixture.storage, 'writeObjectStream');
    const onBypass = vi.fn((): Promise<void> => Promise.resolve());

    const prepared = await prepareCachedArchive({
      ...document,
      storage: fixture.storage,
      archiveCacheBypassed: true,
      onBypass,
    });

    expect(prepared.archiveCacheBypassed).toBe(true);
    expect(prepared.resultUrl).toBe(document.resultUrl);
    expect(headObject).not.toHaveBeenCalled();
    expect(writeObjectStream).not.toHaveBeenCalled();
    expect(onBypass).not.toHaveBeenCalled();
  });

  it('persists bypass before falling back when streaming storage is unavailable', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const storage: ParsedDocumentStorage = { ...fixture.storage, writeObjectStream: undefined };
    let hasBypassed: boolean = false;

    const prepared = await prepareCachedArchive({
      ...document,
      storage,
      onBypass: (): Promise<void> => {
        hasBypassed = true;
        return Promise.resolve();
      },
    });

    expect(hasBypassed).toBe(true);
    expect(prepared.isCached).toBe(false);
    expect(prepared.archiveCacheBypassed).toBe(true);
    expect(fixture.objects.size).toBe(0);
  });

  it('rejects changed CDN versions before exposing a cached range', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });

    expect(
      (): Response =>
        prepared.validateResponse(
          new Response(new Uint8Array([1]), {
            status: 206,
            headers: {
              etag: '"stale-cdn-version"',
              'content-range': `bytes 0-0/${fixture.archive.length}`,
              'content-length': '1',
            },
          }),
        ),
    ).toThrow(/version/);
  });

  it('cancels a cached response when its version headers are rejected', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });
    const cancel = vi.fn();
    const response: Response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 206,
      headers: { etag: '"stale-version"' },
    });

    expect((): Response => prepared.validateResponse(response)).toThrow(/version/);
    expect(cancel).toHaveBeenCalledOnce();
    expect((): Response => prepared.validateResponse(response)).toThrow(
      expect.objectContaining({ name: 'ArchiveCacheTransportError' }),
    );
  });

  it('rejects a mismatched cached range total before consuming bytes', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });

    expect(
      (): Response =>
        prepared.validateResponse(
          new Response(new Uint8Array([1]), {
            status: 206,
            headers: {
              etag: fixture.getStorageVersion(),
              'content-range': 'bytes 0-0/99999',
              'content-length': '1',
            },
          }),
        ),
    ).toThrow(/length/);
  });

  it('rejects truncated cached range streams', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });
    const response: Response = prepared.validateResponse(
      new Response(new Uint8Array([1]), {
        status: 206,
        headers: {
          etag: fixture.getStorageVersion(),
          'content-range': `bytes 0-1/${fixture.archive.length}`,
          'content-length': '2',
        },
      }),
    );

    await expect(response.arrayBuffer()).rejects.toThrow(/length/);
  });

  it('bypasses stale cache HEAD versions and preserves canonical upstream identity', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const first = await prepareCachedArchive({ ...document, storage: fixture.storage });
    vi.spyOn(fixture.storage, 'headObject').mockImplementation((params) =>
      Promise.resolve({
        ...params,
        entityTag: '"stale-head"',
        contentLength: fixture.archive.length,
      }),
    );
    const onBypass = vi.fn((): Promise<void> => Promise.resolve());

    const prepared = await prepareCachedArchive({
      ...document,
      storage: fixture.storage,
      onBypass,
    });

    expect(prepared.isCached).toBe(false);
    expect(prepared.downloadIdentity).toBe(first.downloadIdentity);
    expect(onBypass).toHaveBeenCalledOnce();
  });

  it('does not publish a marker after an interrupted archive upload', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    vi.spyOn(fixture.storage, 'writeObjectStream').mockImplementation(async (params) => {
      const reader: ReadableStreamDefaultReader<Uint8Array> = params.body.getReader();
      await reader.read();
      await reader.cancel();
      throw new Error('Interrupted storage upload');
    });
    const onBypass = vi.fn((): Promise<void> => Promise.resolve());

    const prepared = await prepareCachedArchive({
      ...document,
      storage: fixture.storage,
      onBypass,
    });

    expect(prepared.archiveCacheBypassed).toBe(true);
    expect(
      [...fixture.objects.keys()].some((path): boolean => path.includes('archive-cache')),
    ).toBe(false);
    expect(onBypass).toHaveBeenCalledOnce();
  });

  it('bypasses a cache transport that ignores Range requests', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url: string =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('cache.example'))
          return new Response(fixture.archive, {
            headers: {
              etag: fixture.getStorageVersion(),
              'content-length': String(fixture.archive.length),
            },
          });
        return originalFetch(input, init);
      },
    );

    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });

    expect(prepared.isCached).toBe(false);
    expect(prepared.archiveCacheBypassed).toBe(true);
  });

  it('rejects a cache probe that sends a larger range than the requested byte', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url: string =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('cache.example'))
          return new Response(fixture.archive, {
            status: 206,
            headers: {
              etag: fixture.getStorageVersion(),
              'content-length': String(fixture.archive.length),
              'content-range': `bytes 0-${fixture.archive.length - 1}/${fixture.archive.length}`,
            },
          });
        return originalFetch(input, init);
      },
    );

    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });

    expect(prepared.isCached).toBe(false);
    expect(prepared.archiveCacheBypassed).toBe(true);
  });

  it('bypasses an origin without a strong validator', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response: Response = await originalFetch(input, init);
        response.headers.set('etag', 'W/"weak-origin"');
        return response;
      },
    );

    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });

    expect(prepared.archiveCacheBypassed).toBe(true);
    expect(fixture.objects.size).toBe(0);
  });

  it('does not trust malformed persisted cache metadata', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    await prepareCachedArchive({ ...document, storage: fixture.storage });
    const markerPath: string | undefined = [...fixture.objects.keys()].find((path): boolean =>
      path.startsWith('.knowhere-sdk/archive-cache/'),
    );
    fixture.objects.set(markerPath!, Buffer.from('{"version":1,"status":"completed"}'));

    const prepared = await prepareCachedArchive({ ...document, storage: fixture.storage });

    expect(prepared.archiveCacheBypassed).toBe(true);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('propagates bypass persistence failure before allowing upstream fallback', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const storage: ParsedDocumentStorage = { ...fixture.storage, getObjectUrl: undefined };

    await expect(
      prepareCachedArchive({
        ...document,
        storage,
        onBypass: (): Promise<void> => Promise.reject(new Error('Checkpoint unavailable')),
      }),
    ).rejects.toThrow('Checkpoint unavailable');
  });

  it('bounds unavailable storage work to thirty seconds', async (): Promise<void> => {
    vi.useFakeTimers();
    const fixture: CacheFixture = createFixture();
    vi.spyOn(fixture.storage, 'headObject').mockImplementation(
      () => new Promise((): void => undefined),
    );
    const onBypass = vi.fn((): Promise<void> => Promise.resolve());

    const preparation = prepareCachedArchive({ ...document, storage: fixture.storage, onBypass });
    await vi.advanceTimersByTimeAsync(30_001);
    const prepared = await preparation;

    expect(prepared.archiveCacheBypassed).toBe(true);
    expect(onBypass).toHaveBeenCalledOnce();
  });

  it('includes the origin probe in the thirty-second cache budget', async (): Promise<void> => {
    vi.useFakeTimers();
    const fixture: CacheFixture = createFixture();
    vi.stubGlobal('fetch', (): Promise<Response> => new Promise((): void => undefined));
    const onBypass = vi.fn((): Promise<void> => Promise.resolve());
    let hasFinished: boolean = false;
    const preparation = prepareCachedArchive({
      ...document,
      storage: fixture.storage,
      onBypass,
    }).then((prepared) => {
      hasFinished = true;
      return prepared;
    });

    await vi.advanceTimersByTimeAsync(30_001);

    expect(hasFinished).toBe(true);
    const prepared = await preparation;
    expect(prepared.archiveCacheBypassed).toBe(true);
    expect(prepared.downloadIdentity).toBeUndefined();
    expect(onBypass).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight upload and waits for its cleanup before bypassing', async (): Promise<void> => {
    vi.useFakeTimers();
    const fixture: CacheFixture = createFixture();
    let releaseCleanup: (() => void) | undefined;
    let hasSettled: boolean = false;
    let hasSettledBeforeBypass: boolean = false;
    vi.spyOn(fixture.storage, 'writeObjectStream').mockImplementation(
      (params): Promise<ParsedDocumentWriteObjectResult> =>
        new Promise((_resolve, reject): void => {
          params.signal!.addEventListener('abort', (): void => {
            releaseCleanup = (): void => {
              hasSettled = true;
              reject(new Error('Upload aborted after cleanup'));
            };
          });
        }),
    );
    const onBypass = vi.fn((): Promise<void> => {
      hasSettledBeforeBypass = hasSettled;
      return Promise.resolve();
    });
    const preparation = prepareCachedArchive({ ...document, storage: fixture.storage, onBypass });

    await vi.advanceTimersByTimeAsync(30_001);

    expect(releaseCleanup).toBeDefined();
    const bypassCallsBeforeCleanup: number = onBypass.mock.calls.length;
    releaseCleanup!();
    expect((await preparation).archiveCacheBypassed).toBe(true);
    expect(bypassCallsBeforeCleanup).toBe(0);
    expect(hasSettledBeforeBypass).toBe(true);
    expect(onBypass).toHaveBeenCalledOnce();
  });

  it('fails when origin bytes no longer match the pinned download identity', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const originalFetch: typeof fetch = fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!new Headers(init?.headers).has('range'))
          return new Response(fixture.archive, {
            headers: { etag: '"changed-origin"', 'content-length': String(fixture.archive.length) },
          });
        return originalFetch(input, init);
      },
    );

    await expect(prepareCachedArchive({ ...document, storage: fixture.storage })).rejects.toThrow(
      /origin.*identity/i,
    );
    expect(
      [...fixture.objects.keys()].some((path): boolean => path.includes('archive-cache')),
    ).toBe(false);
  });

  it('does not disguise cancellation as an optional cache bypass', async (): Promise<void> => {
    const fixture: CacheFixture = createFixture();
    const controller: AbortController = new AbortController();
    controller.abort(new Error('Caller cancelled'));
    const onBypass = vi.fn((): Promise<void> => Promise.resolve());

    await expect(
      prepareCachedArchive({
        ...document,
        storage: fixture.storage,
        signal: controller.signal,
        onBypass,
      }),
    ).rejects.toThrow('Caller cancelled');
    expect(onBypass).not.toHaveBeenCalled();
  });
});
