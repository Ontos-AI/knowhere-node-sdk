import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JobResult } from '../../types/job.js';
import type { DocumentChunkListParams, DocumentChunkListResponse } from '../../types/document.js';
import type { Knowhere } from '../../client.js';
import type {
  ParsedDocumentObject,
  ParsedDocumentStorage,
  ParsedDocumentSyncProgress,
  ParsedDocumentWriteObjectParams,
  ParsedDocumentWriteObjectStreamParams,
  ParsedDocumentWriteObjectResult,
} from '../../types/storage.js';
import { Knowledge } from '../knowledge.js';
import { NotFoundError } from '../../errors/index.js';

interface Fixture {
  readonly archive: Uint8Array;
  readonly objects: Map<string, Uint8Array>;
  readonly progress: ParsedDocumentSyncProgress[];
  readonly storage: ParsedDocumentStorage;
  readonly knowledge: Knowledge;
  readonly jobsLoad: ReturnType<typeof vi.fn>;
  readonly jobsGet: Mock<() => Promise<Partial<JobResult>>>;
  readonly requests: Array<{
    readonly url: string;
    readonly method: string;
    readonly range: string | null;
  }>;
  readonly streamWrites: string[];
  readonly scheduledTasks: Array<() => Promise<void>>;
  readonly listChunks: Mock<
    (
      documentId: string,
      params?: DocumentChunkListParams,
    ) => Promise<Partial<DocumentChunkListResponse>>
  >;
}

async function createFixture(
  options: {
    readonly streaming?: boolean;
    readonly supportsRange?: boolean;
    readonly maxEntries?: number;
    readonly missingChunks?: boolean;
    readonly corrupt?: boolean;
    readonly corruptImage?: boolean;
    readonly descriptors?: boolean;
    readonly extraEntries?: number;
    readonly missingMetadataAsset?: boolean;
    readonly entries?: Readonly<Record<string, string | Uint8Array>>;
    readonly maxPages?: number;
    readonly remotePageSize?: number;
  } = {},
): Promise<Fixture> {
  const zip = new JSZip();
  if (options.entries) {
    for (const [path, body] of Object.entries(options.entries)) zip.file(path, body);
  } else {
    zip.file(
      'manifest.json',
      JSON.stringify({
        version: '2.0',
        job_id: 'job_test',
        source_file_name: 'test.pdf',
        statistics: { total_chunks: 0 },
      }),
    );
    if (!options.missingChunks)
      zip.file(
        'chunks.json',
        options.missingMetadataAsset
          ? JSON.stringify({
              chunks: [
                {
                  type: 'image',
                  path: 'images/missing.png',
                  metadata: { file_path: 'images/missing.png' },
                },
              ],
            })
          : '{"chunks":[]}',
      );
    zip.file('full.md', 'original markdown\n');
    zip.file('images/test.png', new Uint8Array(256 * 1024).fill(23));
    for (let index = 0; index < (options.extraEntries ?? 0); index += 1)
      zip.file(`assets/${index}.bin`, new Uint8Array([index]));
  }
  const archive = options.corrupt
    ? new Uint8Array([1, 2, 3])
    : await zip.generateAsync({
        type: 'uint8array',
        compression: options.corruptImage ? 'STORE' : 'DEFLATE',
        streamFiles: options.descriptors,
      });
  const objects = new Map<string, Uint8Array>();
  const progress: ParsedDocumentSyncProgress[] = [];
  const streamWrites: string[] = [];
  const storage: ParsedDocumentStorage = {
    readObject(params): Promise<ParsedDocumentObject | null> {
      const body = objects.get(params.path);
      return Promise.resolve(body ? { ...params, body } : null);
    },
    writeObject(params) {
      objects.set(params.path, params.body);
      return Promise.resolve(params);
    },
    readSyncProgress() {
      return Promise.resolve(progress.at(-1) ?? null);
    },
    writeSyncProgress(value) {
      progress.push(value);
      return Promise.resolve();
    },
  };
  if (options.streaming !== false) {
    Object.assign(storage, {
      async writeObjectStream(
        params: Omit<ParsedDocumentWriteObjectParams, 'body'> & {
          readonly body: ReadableStream<Uint8Array>;
        },
      ) {
        streamWrites.push(params.path);
        const parts: Uint8Array[] = [];
        for await (const part of params.body) parts.push(part);
        objects.set(params.path, Buffer.concat(parts));
        return params;
      },
    });
  }
  if (options.corruptImage) {
    const marker = Buffer.from(archive).indexOf('images/test.png');
    if (marker < 0) throw new Error('Missing image fixture');
    archive[marker + 'images/test.png'.length + 1] ^= 1;
  }
  const requests: Fixture['requests'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const range = headers.get('range');
      requests.push({ url, method, range });
      if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 403 }));
      if (options.supportsRange !== false && range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) throw new Error('Invalid test range');
        const start = match[1] ? Number(match[1]) : Math.max(0, archive.length - Number(match[2]));
        const end =
          match[1] && match[2]
            ? Math.min(Number(match[2]), archive.length - 1)
            : archive.length - 1;
        return Promise.resolve(
          new Response(archive.slice(start, end + 1), {
            status: 206,
            headers: {
              'content-range': `bytes ${start}-${end}/${archive.length}`,
              'content-length': String(end - start + 1),
              'accept-ranges': 'bytes',
              etag: '"test-archive"',
            },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              for (let start = 0; start < archive.length; start += 127)
                controller.enqueue(archive.slice(start, start + 127));
              controller.close();
            },
          }),
          { headers: { 'content-length': String(archive.length), etag: '"test-archive"' } },
        ),
      );
    }),
  );
  const jobsLoad = vi.fn(() => {
    throw new Error('jobs.load must never run');
  });
  const jobsGet: Fixture['jobsGet'] = vi.fn<() => Promise<Partial<JobResult>>>(() =>
    Promise.resolve({
      jobId: 'job_test',
      documentId: 'doc_test',
      isDone: true,
      status: 'done',
      resultUrl: `https://archive.example/result.zip?signature=${jobsGet.mock.calls.length}`,
    }),
  );
  const listChunks = vi.fn<
    (
      documentId: string,
      params?: DocumentChunkListParams,
    ) => Promise<Partial<DocumentChunkListResponse>>
  >(() =>
    Promise.resolve({
      documentId: 'doc_test',
      namespace: 'test',
      jobId: 'job_test',
      jobResultId: 'revision_test',
      chunks: [],
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
    }),
  );
  const client = {
    jobs: { get: jobsGet, load: jobsLoad },
    documents: { listChunks },
  } as unknown as Knowhere;
  const scheduledTasks: Array<() => Promise<void>> = [];
  const knowledge = new Knowledge(client).withParsedStorage({
    scheduler: {
      schedule(task): void {
        scheduledTasks.push(task);
      },
    },
    storage,
    limits: {
      maxEntriesPerSync: options.maxEntries,
      maxPagesPerSync: options.maxPages,
      remotePageSize: options.remotePageSize,
    },
  });
  return {
    archive,
    objects,
    progress,
    storage,
    knowledge,
    jobsLoad,
    jobsGet,
    requests,
    streamWrites,
    scheduledTasks,
    listChunks,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('streamed remote parsed document sync', () => {
  it('streams exact entry bytes to the optional stream sink without loading ParseResult or issuing HEAD', async () => {
    const fixture = await createFixture();
    const result = await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' });
    expect(result.completed).toBe(true);
    expect(fixture.jobsLoad).not.toHaveBeenCalled();
    expect(fixture.streamWrites).toEqual([
      'manifest.json',
      'chunks.json',
      'full.md',
      'images/test.png',
    ]);
    expect(
      fixture.requests.every((request) => request.method === 'GET' && request.range !== null),
    ).toBe(true);
    expect(Buffer.from(fixture.objects.get('full.md')!).toString()).toBe('original markdown\n');
    expect(fixture.objects.has('result.zip')).toBe(false);
    expect(fixture.progress.at(-1)).toMatchObject({
      status: 'completed',
      pinnedRevisionKey: 'revision_test',
      nextArchiveEntry: 4,
    });
    expect(typeof fixture.progress.at(-1)?.archiveIdentity).toBe('string');
  });

  it('supports byte-only sinks and retains the exact original ZIP only when requested', async () => {
    const fixture = await createFixture({ streaming: false });
    const result = await fixture.knowledge.syncParsedDocument({
      documentId: 'doc_test',
      retainResultArchive: true,
    });
    expect(result.completed).toBe(true);
    expect(Buffer.from(fixture.objects.get('result.zip')!)).toEqual(Buffer.from(fixture.archive));
    expect(Buffer.from(fixture.objects.get('images/test.png')!)).toEqual(
      Buffer.alloc(256 * 1024, 23),
    );
  });

  it('checkpoints a bounded batch, refreshes the signed URL and resumes after the last successful entry', async () => {
    const fixture = await createFixture({ maxEntries: 2 });
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(2);
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    expect(fixture.jobsGet).toHaveBeenCalledTimes(2);
    expect(new Set(fixture.requests.map((request) => request.url)).size).toBe(2);
    expect(fixture.streamWrites).toEqual([
      'manifest.json',
      'chunks.json',
      'full.md',
      'images/test.png',
    ]);
  });

  it('streams sequentially when the object server ignores Range', async () => {
    const fixture = await createFixture({ supportsRange: false, maxEntries: 2 });
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    expect(fixture.streamWrites).toEqual([
      'manifest.json',
      'chunks.json',
      'full.md',
      'images/test.png',
    ]);
    expect(fixture.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('retains the last successful checkpoint after a storage interruption', async () => {
    const fixture = await createFixture();
    const writeStream = fixture.storage.writeObjectStream!.bind(fixture.storage);
    fixture.storage.writeObjectStream = vi.fn(
      async (params: ParsedDocumentWriteObjectStreamParams) => {
        if (params.path === 'chunks.json') throw new Error('storage interrupted');
        return writeStream(params);
      },
    );
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      'storage interrupted',
    );
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(1);
    fixture.storage.writeObjectStream = writeStream;
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    expect(fixture.streamWrites.filter((path) => path === 'manifest.json')).toHaveLength(1);
  });

  it('rejects incomplete ZIPs without silently reconstructing or committing', async () => {
    const fixture = await createFixture({ missingChunks: true });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /chunks.json/,
    );
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
    expect(fixture.listChunks).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid ZIP data', async () => {
    const fixture = await createFixture({ corrupt: true });
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' }),
    ).rejects.toThrow();
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('rejects an explicit revision mismatch without writing the new revision under the old key', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test', revisionKey: 'old_revision' }),
    ).rejects.toThrow(/revision/i);
    expect(fixture.objects.size).toBe(0);
  });

  it('honors cancellation before downloading or writing', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test', signal: controller.signal }),
    ).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.objects.size).toBe(0);
  });

  it('rejects a changed archive identity when resuming an existing checkpoint', async () => {
    const fixture = await createFixture({ maxEntries: 2 });
    await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' });
    fixture.progress.push({ ...fixture.progress.at(-1)!, archiveIdentity: 'different-archive' });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /identity changed/,
    );
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('does not commit when publication switches during a copy', async () => {
    const fixture = await createFixture();
    fixture.listChunks.mockResolvedValueOnce({
      documentId: 'doc_test',
      namespace: 'test',
      jobId: 'job_test',
      jobResultId: 'revision_test',
      chunks: [],
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
    });
    fixture.listChunks.mockResolvedValue({ jobId: 'job_new', jobResultId: 'revision_new' });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /revision changed/,
    );
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('retries a failed expired URL with a fresh signed URL on the next invocation', async () => {
    const fixture = await createFixture();
    const download = vi.mocked(fetch);
    download.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 403 })));
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /403/,
    );
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    expect(fixture.jobsGet).toHaveBeenCalledTimes(2);
  });

  it('rejects corrupt entry bytes without Range support', async () => {
    const fixture = await createFixture({ supportsRange: false, corruptImage: true });
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' }),
    ).rejects.toThrow();
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('validates CRC for sequential ZIP data descriptors', async () => {
    const fixture = await createFixture({
      supportsRange: false,
      corruptImage: true,
      descriptors: true,
    });
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' }),
    ).rejects.toThrow();
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('reports unavailable temporary disk as a typed error without committing', async () => {
    const fixture = await createFixture({ supportsRange: false });
    vi.stubEnv('TMPDIR', '/nonexistent-knowhere-sdk-test-directory');
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' }),
    ).rejects.toMatchObject({ name: 'ParsedDocumentArchiveError', code: 'ARCHIVE_SPOOL_FAILED' });
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('uses the default 100-entry batch bound', async () => {
    const fixture = await createFixture({ extraEntries: 100 });
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(100);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('checks the default 120-second budget between entries', async () => {
    const fixture = await createFixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const writeStream = fixture.storage.writeObjectStream!.bind(fixture.storage);
    fixture.storage.writeObjectStream = async (
      params,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      const result = await writeStream(params);
      now.mockReturnValue(120_001);
      return result;
    };
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(1);
  });

  it('cancels a sequential copy and resumes from its successful checkpoint', async () => {
    const fixture = await createFixture({ supportsRange: false });
    const controller = new AbortController();
    const writeStream = fixture.storage.writeObjectStream!.bind(fixture.storage);
    fixture.storage.writeObjectStream = async (
      params,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      const result = await writeStream(params);
      controller.abort();
      return result;
    };
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test', signal: controller.signal }),
    ).rejects.toThrow();
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(1);
    fixture.storage.writeObjectStream = writeStream;
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    expect(fixture.streamWrites.filter((path) => path === 'manifest.json')).toHaveLength(1);
  });

  it('uses remote reconstruction when a published job has expired from the API', async () => {
    const fixture = await createFixture();
    fixture.jobsGet.mockRejectedValue(new NotFoundError('Job no longer available'));
    const result = await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' });
    expect(result.completed).toBe(true);
    expect(result.commit?.source).toBe('remoteReconstruction');
    expect(fixture.jobsLoad).not.toHaveBeenCalled();
  });

  it('preserves a successful archive checkpoint when background scheduling records a failure', async () => {
    const fixture = await createFixture();
    const writeStream = fixture.storage.writeObjectStream!.bind(fixture.storage);
    fixture.storage.writeObjectStream = async (
      params,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.path === 'chunks.json') throw new Error('temporary storage failure');
      return writeStream(params);
    };
    await fixture.knowledge.readChunks({ documentId: 'doc_test' });
    await fixture.scheduledTasks[0]?.();
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(1);
    fixture.storage.writeObjectStream = writeStream;
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    expect(fixture.streamWrites.filter((path) => path === 'manifest.json')).toHaveLength(1);
  });

  it('does not retain a different archive returned after the snapshot is committed', async () => {
    const fixture = await createFixture();
    const originalFetch = fetch;
    vi.stubGlobal(
      'fetch',
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!new Headers(init?.headers).has('range'))
          return Promise.resolve(
            new Response(new Uint8Array([9]), {
              headers: { etag: '"changed"', 'content-length': '1' },
            }),
          );
        return originalFetch(input, init);
      },
    );
    expect(
      (
        await fixture.knowledge.syncParsedDocument({
          documentId: 'doc_test',
          retainResultArchive: true,
        })
      ).completed,
    ).toBe(true);
    expect(fixture.objects.has('result.zip')).toBe(false);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(true);
  });

  it('rebuilds a completed snapshot when explicitly synced again', async () => {
    const fixture = await createFixture({ maxEntries: 2 });
    await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' });
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    fixture.objects.delete('manifest.json');
    fixture.objects.delete('images/test.png');
    fixture.objects.set('full.md', Buffer.from('corrupt markdown'));
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect(fixture.progress.at(-1)?.nextArchiveEntry).toBe(2);
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
    expect(fixture.objects.get('images/test.png')?.length).toBe(256 * 1024);
    expect(Buffer.from(fixture.objects.get('full.md')!).toString()).toBe('original markdown\n');
  });

  it('requires image files referenced by worker metadata.file_path', async () => {
    const fixture = await createFixture({ missingMetadataAsset: true });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /images\/missing.png/,
    );
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('rejects a revision switch between remote reconstruction pages', async () => {
    const fixture = await createFixture();
    fixture.jobsGet.mockResolvedValue({ isDone: true });
    const original = {
      documentId: 'doc_test',
      namespace: 'test',
      jobId: 'job_test',
      jobResultId: 'revision_test',
      chunks: [],
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 1 },
    };
    fixture.listChunks
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, jobId: 'job_new', jobResultId: 'revision_new' });
    await expect(
      fixture.knowledge.syncParsedDocument({
        documentId: 'doc_test',
        revisionKey: 'revision_test',
      }),
    ).rejects.toThrow(/revision/i);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('honors cancellation when falling back to remote reconstruction', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    fixture.jobsGet.mockReturnValue(
      Promise.resolve().then(() => {
        controller.abort();
        return { isDone: true };
      }),
    );
    await expect(
      fixture.knowledge.syncParsedDocument({ documentId: 'doc_test', signal: controller.signal }),
    ).rejects.toThrow();
    expect(fixture.objects.size).toBe(0);
  });

  it('checks the published revision again before committing a remote reconstruction', async () => {
    const fixture = await createFixture();
    fixture.jobsGet.mockResolvedValue({ isDone: true });
    const original = {
      documentId: 'doc_test',
      namespace: 'test',
      jobId: 'job_test',
      jobResultId: 'revision_test',
      chunks: [],
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 1 },
    };
    fixture.listChunks
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, jobId: 'job_new', jobResultId: 'revision_new' });
    await expect(
      fixture.knowledge.syncParsedDocument({
        documentId: 'doc_test',
        revisionKey: 'revision_test',
      }),
    ).rejects.toThrow(/revision/i);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('commits a valid snapshot even if optional archive retention fails', async () => {
    const fixture = await createFixture();
    const writeStream = fixture.storage.writeObjectStream!.bind(fixture.storage);
    fixture.storage.writeObjectStream = async (
      params,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.path === 'result.zip') throw new Error('optional archive unavailable');
      return writeStream(params);
    };
    const result = await fixture.knowledge.syncParsedDocument({
      documentId: 'doc_test',
      retainResultArchive: true,
    });
    expect(result.completed).toBe(true);
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(true);
  });
});

describe('streaming snapshot validation and compatibility', () => {
  it.each([
    {
      localDocumentId: undefined,
      documentId: 'doc_test',
      revisionKey: undefined,
      expectedId: 'doc_test',
    },
    {
      localDocumentId: 'local_test',
      documentId: undefined,
      revisionKey: 'revision_fixed',
      expectedId: 'local_test',
    },
    {
      localDocumentId: undefined,
      documentId: undefined,
      revisionKey: undefined,
      expectedId: 'job_test',
    },
  ])(
    'streams a direct job reference into the intended document and revision: $expectedId',
    async ({ localDocumentId, documentId, revisionKey, expectedId }) => {
      const fixture = await createFixture();
      fixture.jobsGet.mockResolvedValue({
        isDone: true,
        documentId,
        resultUrl: 'https://archive.example/job.zip',
      });
      const result = await fixture.knowledge.syncParsedDocument({
        jobId: 'job_test',
        localDocumentId,
        revisionKey,
      });
      expect(result).toMatchObject({
        documentId: expectedId,
        revisionKey: revisionKey ?? 'job_test',
        completed: true,
      });
      expect(fixture.jobsLoad).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isDone: false, resultUrl: 'https://archive.example/job.zip' },
    { isDone: true, resultUrl: undefined },
  ])('rejects unavailable direct job archives: %j', async (job) => {
    const fixture = await createFixture();
    fixture.jobsGet.mockResolvedValue(job);
    await expect(fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).rejects.toThrow(
      /unavailable/,
    );
    expect(fixture.objects.size).toBe(0);
  });

  it('requires a document reference and configured storage', async () => {
    const fixture = await createFixture();
    await expect(fixture.knowledge.syncParsedDocument({})).rejects.toThrow(/required/);
    await expect(
      new Knowledge({} as Knowhere).syncParsedDocument({ documentId: 'doc_test' }),
    ).rejects.toThrow(/not configured/);
  });

  it.each([
    { manifest: [], chunks: { chunks: [] }, error: /manifest.json/ },
    { manifest: { job_id: 'other_job' }, chunks: { chunks: [] }, error: /job identity/ },
    { manifest: { job_id: 'job_test' }, chunks: null, error: /chunks.json/ },
    { manifest: { job_id: 'job_test' }, chunks: { wrong: [] }, error: /chunks.json/ },
    {
      manifest: { job_id: 'job_test' },
      chunks: { chunks: [4] },
      error: /Invalid parsed result chunk/,
    },
    {
      manifest: { job_id: 'job_test', files: { image: 'images/missing.png' } },
      chunks: [],
      error: /images\/missing.png/,
    },
  ])(
    'validates archive metadata before committing: $error',
    async ({ manifest, chunks, error }) => {
      const fixture = await createFixture({
        entries: {
          'manifest.json': JSON.stringify(manifest),
          'chunks.json': JSON.stringify(chunks),
        },
      });
      await expect(
        fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' }),
      ).rejects.toThrow(error);
      expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
    },
  );

  it('accepts legacy chunk arrays and validates all supported media reference shapes', async () => {
    const chunks = [
      { type: 'text', content: 'text', path: 'Chapter' },
      { type: 'image', file_path: 'images/test.png', metadata: {} },
      { type: 'image', filePath: 'images/test.png', metadata: {} },
      { chunk_type: 'image', path: 'images/test.png', metadata: {} },
      { chunkType: 'table', path: 'tables/test.html', metadata: {} },
      { type: 'image', metadata: { filePath: 'images/test.png' } },
      {
        type: 'text',
        metadata: {
          page_assets: [
            null,
            { artifact_ref: 'images/test.png' },
            { artifactRef: 'images/test.png' },
            { other: 'ignored' },
          ],
        },
      },
      { type: 'text', metadata: { pageAssets: [{ artifactRef: 'images/test.png' }] } },
    ];
    const fixture = await createFixture({
      entries: {
        'manifest.json': JSON.stringify({
          jobId: 'job_test',
          files: { image: 'images/test.png', ignored: 4 },
        }),
        'chunks.json': JSON.stringify(chunks),
        'images/test.png': new Uint8Array([8]),
        'tables/test.html': '<table></table>',
      },
    });
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      true,
    );
  });

  it('rejects colliding normalized ZIP paths', async () => {
    const fixture = await createFixture({
      entries: {
        'manifest.json': '{"job_id":"job_test"}',
        'chunks.json': '[]',
        'full.md': 'first',
        './full.md': 'second',
      },
    });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /Duplicate/,
    );
  });

  it('rejects missing persisted metadata after an adapter reports a write', async () => {
    const fixture = await createFixture();
    const write = fixture.storage.writeObjectStream!.bind(fixture.storage);
    fixture.storage.writeObjectStream = async (
      params,
    ): Promise<ParsedDocumentWriteObjectResult> => {
      const result = await write(params);
      fixture.objects.delete('manifest.json');
      return result;
    };
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /not persisted/,
    );
    expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
  });

  it('rejects a checkpoint pinned to another revision', async () => {
    const fixture = await createFixture();
    fixture.progress.push({
      documentId: 'doc_test',
      revisionKey: 'revision_test',
      pinnedRevisionKey: 'other_revision',
      nextArchiveEntry: 0,
      status: 'running',
      updatedAt: new Date().toISOString(),
    });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /revision changed/,
    );
  });

  it('rejects an incomplete entry-hash checkpoint before skipping Range entries', async () => {
    const fixture = await createFixture({ maxEntries: 2 });
    await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' });
    fixture.progress.push({ ...fixture.progress.at(-1)!, archiveEntryHashes: undefined });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /missing an entry hash/,
    );
  });

  it('verifies sequential retry hashes before continuing after a checkpoint', async () => {
    const fixture = await createFixture({ supportsRange: false, maxEntries: 2 });
    await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' });
    fixture.progress.push({
      ...fixture.progress.at(-1)!,
      archiveEntryHashes: ['changed', 'changed'],
    });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /entry changed/,
    );
  });

  it('rejects a server that stops honoring Range after the probe', async () => {
    const fixture = await createFixture();
    const original = fetch;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls += 1;
        return calls === 1 ? original(input, init) : Promise.resolve(new Response(fixture.archive));
      },
    );
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /Range request failed/,
    );
  });

  it.each([403, 200])(
    'rejects an unavailable or changed sequential source after the probe: %s',
    async (status) => {
      const fixture = await createFixture({ supportsRange: false });
      const original = fetch;
      vi.stubGlobal(
        'fetch',
        (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Headers(init?.headers).has('range')
            ? original(input, init)
            : Promise.resolve(
                new Response(fixture.archive, {
                  status,
                  headers: {
                    etag: '"different"',
                    'content-length': String(fixture.archive.length),
                  },
                }),
              ),
      );
      await expect(
        fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' }),
      ).rejects.toThrow();
      expect(fixture.objects.has('.knowhere-sdk/commit.json')).toBe(false);
    },
  );

  it('keeps a valid snapshot when optional archive retention returns HTTP 403', async () => {
    const fixture = await createFixture();
    const original = fetch;
    vi.stubGlobal(
      'fetch',
      (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Headers(init?.headers).has('range')
          ? original(input, init)
          : Promise.resolve(new Response(null, { status: 403 })),
    );
    expect(
      (
        await fixture.knowledge.syncParsedDocument({
          documentId: 'doc_test',
          retainResultArchive: true,
        })
      ).completed,
    ).toBe(true);
    expect(fixture.objects.has('result.zip')).toBe(false);
  });

  it('propagates job API failures instead of silently reconstructing', async () => {
    const fixture = await createFixture();
    fixture.jobsGet.mockRejectedValue(new Error('Job API offline'));
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      'Job API offline',
    );
    expect(fixture.listChunks).toHaveBeenCalledTimes(1);
  });

  it('rejects a job belonging to another document', async () => {
    const fixture = await createFixture();
    fixture.jobsGet.mockResolvedValue({
      isDone: true,
      documentId: 'other_doc',
      resultUrl: 'https://archive.example/result.zip',
    });
    await expect(fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).rejects.toThrow(
      /document identity/,
    );
  });

  it('reconstructs documents without a published job in bounded resumable pages', async () => {
    const fixture = await createFixture({ maxPages: 1, remotePageSize: 1 });
    fixture.listChunks.mockImplementation((_documentId, params) =>
      Promise.resolve({
        documentId: 'doc_test',
        namespace: 'test',
        jobResultId: 'revision_test',
        chunks: [],
        pagination: {
          page: params?.page ?? 1,
          pageSize: params?.pageSize ?? 1,
          total: 2,
          totalPages: 2,
        },
      }),
    );
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect(fixture.progress.at(-1)?.nextChunkPage).toBe(2);
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect(
      (await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).commit?.source,
    ).toBe('remoteReconstruction');
    expect(fixture.jobsGet).not.toHaveBeenCalled();
  });
});
