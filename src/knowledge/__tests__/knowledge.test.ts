import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import JSZip from 'jszip';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Knowledge } from '../knowledge.js';
import type { Knowhere } from '../../client.js';
import type {
  Chunk,
  DocumentChunk,
  DocumentChunkListParams,
  DocumentChunkListResponse,
  KnowhereAssetStorageAdapter,
  KnowhereAssetStorageObject,
  KnowhereAssetStorageWriteResult,
  ParseResult,
  ParsedDocumentCommit,
  ParsedDocumentObject,
  ParsedDocumentObjectParams,
  ParsedDocumentStorage,
  ParsedDocumentSyncProgress,
  ParsedDocumentWriteObjectParams,
  TextChunk,
  TableChunk,
} from '../../types/index.js';

describe('Knowledge', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    tempDirectories.length = 0;
  });

  it('should parse through the SDK and store a local document copy', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = createParseResult();
    const { client, parse } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory });

    const response = await knowledge.parseToLocalCache({
      url: 'https://example.com/report.md',
      namespace: 'support-center',
      localDocumentId: 'local-report',
    });
    const documents = await knowledge.listDocuments();

    expect(parse).toHaveBeenCalledWith({
      url: 'https://example.com/report.md',
      namespace: 'support-center',
      localDocumentId: 'local-report',
    });
    expect(response.document.localDocumentId).toBe('local-report');
    expect(response.document.jobId).toBe('job-1');
    expect(response.document.documentId).toBe('doc-1');
    expect(response.document.typeCounts).toEqual({ text: 2, image: 0, table: 1, page: 0 });
    expect(response.document.resultDirectoryPath).toBe(
      path.join(cacheDirectory, 'documents', 'local-report'),
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]?.sourceFileName).toBe('report.md');
    await expectFileExists(path.join(cacheDirectory, 'documents', 'local-report', 'manifest.json'));
    await expectFileExists(path.join(cacheDirectory, 'documents', 'local-report', 'chunks.json'));
    await expectFileExists(
      path.join(cacheDirectory, 'documents', 'local-report', 'tables', 'revenue.html'),
    );
    await expectFileMissing(path.join(cacheDirectory, 'local-report.zip'));
    await expectFileMissing(path.join(cacheDirectory, 'documents', 'local-report', 'result.zip'));
  });

  it('should keep the deprecated parse alias for compatibility', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = createParseResult();
    const { client, parse } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory });

    const response = await knowledge.parse({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });

    expect(parse).toHaveBeenCalledWith({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });
    expect(response.document.localDocumentId).toBe('local-report');
  });

  it('should reject local document ids that resolve outside the cache', async () => {
    const cacheDirectory = await createTempDirectory();
    const siblingDirectory = path.join(path.dirname(cacheDirectory), 'knowhere-victim');
    const parseResult = createParseResult();
    const { client } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory });

    tempDirectories.push(siblingDirectory);
    await mkdir(siblingDirectory, { recursive: true });
    await writeFile(path.join(siblingDirectory, 'sentinel.txt'), 'keep');

    await expect(
      knowledge.parseToLocalCache({
        url: 'https://example.com/report.md',
        localDocumentId: `../../${path.basename(siblingDirectory)}`,
      }),
    ).rejects.toThrow(/safe slug/);

    await expectFileExists(path.join(siblingDirectory, 'sentinel.txt'));
  });

  it('should start async parses without waiting for results', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, startParse } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const response = await knowledge.startParse({
      file: './report.md',
      localDocumentId: 'local-report',
    });

    expect(startParse).toHaveBeenCalledWith({
      file: './report.md',
      localDocumentId: 'local-report',
    });
    expect(response).toEqual({
      job: {
        jobId: 'job-1',
        status: 'waiting-file',
        sourceType: 'file',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      localDocumentId: 'local-report',
    });
  });

  it('should auto-cache completed async job results while fetching status', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, jobsGet, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    await knowledge.startParse({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });
    const status = await knowledge.getJobStatus('job-1');
    const secondStatus = await knowledge.getJobStatus('job-1');
    const documents = await knowledge.listDocuments();

    expect(jobsGet).toHaveBeenCalledWith('job-1');
    expect(jobsLoad).toHaveBeenCalledOnce();
    expect(jobsLoad).toHaveBeenCalledWith('job-1', { verifyChecksum: undefined });
    expect(status.job).toMatchObject({
      jobId: 'job-1',
      status: 'done',
      isDone: true,
    });
    expect(status.cache).toMatchObject({
      status: 'cached',
      localDocumentId: 'local-report',
    });
    expect(status.cache.document?.localDocumentId).toBe('local-report');
    expect(secondStatus.cache).toMatchObject({
      status: 'already_cached',
      localDocumentId: 'local-report',
    });
    expect(documents).toHaveLength(1);
  });

  it('should import a completed job result into the local cache', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const cached = await knowledge.importJobResult({
      jobId: 'job-1',
      localDocumentId: 'local-report',
      verifyChecksum: false,
    });

    expect(jobsLoad).toHaveBeenCalledWith('job-1', { verifyChecksum: false });
    expect(cached.document.localDocumentId).toBe('local-report');
  });

  it('should keep the deprecated job result cache alias for compatibility', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const cached = await knowledge.cacheJobResult({
      jobId: 'job-1',
      localDocumentId: 'local-report',
    });

    expect(jobsLoad).toHaveBeenCalledWith('job-1', { verifyChecksum: undefined });
    expect(cached.document.localDocumentId).toBe('local-report');
  });

  it('should recover and cache pending async parse jobs on startup', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, jobsGet, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    await knowledge.startParse({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });
    await knowledge.startParse({
      url: 'https://example.com/other-report.md',
      localDocumentId: 'local-other-report',
    });

    const recovered = await knowledge.recoverPendingAsyncParseJobs();
    const documents = await knowledge.listDocuments();

    expect(recovered.checkedJobs).toBe(2);
    expect(recovered.results.map((result) => result.cache.status)).toEqual(['cached', 'cached']);
    expect(jobsGet).toHaveBeenCalledTimes(2);
    expect(jobsLoad).toHaveBeenCalledTimes(2);
    expect(documents.map((document) => document.localDocumentId).sort()).toEqual([
      'local-other-report',
      'local-report',
    ]);
  });

  it('should build outline and range reads from the local parse result', async () => {
    const knowledge = await createKnowledgeWithCachedResult();

    const outline = await knowledge.getDocumentOutline('local-report');
    const read = await knowledge.readChunks({
      localDocumentId: 'local-report',
      sectionPath: 'Intro',
      limit: 1,
    });

    expect(outline.totalChunks).toBe(3);
    expect(outline.sections.map((section) => section.sectionPath)).toEqual(['Intro', 'Revenue']);
    expect(outline.sectionTree[0]?.sectionTitle).toBe('Intro');
    expect(read.chunks).toHaveLength(1);
    expect(read.chunks[0]).toMatchObject({
      position: 1,
      chunkId: 'chunk-intro',
      sectionPath: 'Intro',
      content: 'Alpha revenue introduction.',
    });
    expect(read.nextChunk).toBeUndefined();
  });

  it('should read a remote document id without importing into the local cache', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, documentsListChunks, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const read = await knowledge.readChunks({
      documentId: 'doc_remote',
      sectionPath: 'Intro',
      limit: 5,
    });
    const outline = await knowledge.getDocumentOutline('doc_remote');
    const grep = await knowledge.grepChunks({
      localDocumentId: 'doc_remote',
      pattern: 'Alpha',
      maxResults: 5,
    });
    const documents = await knowledge.listDocuments();

    expect(documentsListChunks).toHaveBeenCalledWith('doc_remote', {
      page: 1,
      pageSize: 100,
      chunkType: undefined,
      includeAssetUrls: true,
    });
    expect(jobsLoad).not.toHaveBeenCalled();
    expect(read.document).toMatchObject({
      localDocumentId: 'doc_remote',
      documentId: 'doc_remote',
      namespace: 'support-center',
      jobId: 'job_remote',
      sourceFileName: 'doc_remote',
      chunkCount: 3,
    });
    expect(read.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-intro']);
    expect(outline.sections.map((section) => section.sectionPath)).toEqual(['Intro', 'Revenue']);
    expect(grep.matches[0]).toMatchObject({
      chunkId: 'chunk-intro',
      sectionPath: 'Intro',
    });
    expect(documents).toHaveLength(0);
    await expectFileMissing(path.join(cacheDirectory, 'documents', 'doc_remote', 'manifest.json'));
    await expectFileMissing(path.join(cacheDirectory, 'documents', 'doc_remote', 'chunks.json'));
  });

  it('should read configured parsed storage for an explicit revision without remote calls', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = createParseResult();
    const storage = createInMemoryParsedStorage();
    storage.seedResult({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      result: parseResult,
    });
    const { client, documentsListChunks } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory }).withParsedStorage({ storage });

    const read = await knowledge.readChunks({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      page: 1,
      pageSize: 2,
    });

    expect(documentsListChunks).not.toHaveBeenCalled();
    expect(read.document.resultDirectoryPath).toBe('parsed-storage:doc_remote');
    expect(read.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-intro', 'chunk-table']);
    expect(read.chunks[1]?.assetUrl).toBe(
      'https://blob.example/doc_remote/jres_remote/tables/revenue.html',
    );
    expect(read.totalChunks).toBe(3);
  });

  it('should read committed parsed result objects concurrently after the commit gate', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = createParseResult();
    const storage = createInMemoryParsedStorage();
    const readEvents: string[] = [];
    const delayedResultPaths = new Set(['manifest.json', 'chunks.json', 'doc_nav.json']);
    const releaseByPath = new Map<string, () => void>();
    let shouldDelayResultReads = true;

    storage.seedResult({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      result: parseResult,
    });

    const readObject = storage.readObject.bind(storage);
    storage.readObject = async (
      params: ParsedDocumentObjectParams,
    ): Promise<ParsedDocumentObject | null> => {
      readEvents.push(`start:${params.path}`);
      if (delayedResultPaths.has(params.path) && shouldDelayResultReads) {
        await new Promise<void>((resolve) => {
          releaseByPath.set(params.path, resolve);
        });
      }

      const object = await readObject(params);
      readEvents.push(`finish:${params.path}`);
      return object;
    };

    const releaseDelayedReads = (): void => {
      shouldDelayResultReads = false;
      for (const release of releaseByPath.values()) {
        release();
      }
      releaseByPath.clear();
    };

    const { client, documentsListChunks } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory }).withParsedStorage({ storage });
    const readPromise = knowledge.readChunks({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      page: 1,
      pageSize: 2,
    });

    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const commitFinishIndex = readEvents.indexOf('finish:.knowhere-sdk/commit.json');
      const resultStartIndexes = ['manifest.json', 'chunks.json', 'doc_nav.json'].map(
        (objectPath) => readEvents.indexOf(`start:${objectPath}`),
      );

      expect(commitFinishIndex).toBeGreaterThanOrEqual(0);
      expect(resultStartIndexes.every((index) => index > commitFinishIndex)).toBe(true);
      expect(readEvents.filter((event) => event.startsWith('start:'))).toEqual([
        'start:.knowhere-sdk/commit.json',
        'start:manifest.json',
        'start:chunks.json',
        'start:doc_nav.json',
      ]);

      releaseDelayedReads();
      const read = await readPromise;

      expect(documentsListChunks).not.toHaveBeenCalled();
      expect(read.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-intro', 'chunk-table']);
    } finally {
      releaseDelayedReads();
    }
  });

  it('should hydrate stored page asset URLs from snake_case chunks metadata', async () => {
    const cacheDirectory = await createTempDirectory();
    const storage = createInMemoryParsedStorage();
    const { client, documentsListChunks } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory }).withParsedStorage({ storage });

    await writeParsedStorageJsonObjectForTest(storage, {
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      objectPath: 'manifest.json',
      value: {
        version: '2.0',
        jobId: 'job_remote',
        sourceFileName: 'report.pdf',
        statistics: {
          totalChunks: 1,
          textChunks: 0,
          imageChunks: 0,
          tableChunks: 0,
          pageChunks: 1,
        },
      },
    });
    await writeParsedStorageJsonObjectForTest(storage, {
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      objectPath: 'chunks.json',
      value: {
        chunks: [
          {
            chunk_id: 'page-1',
            type: 'page',
            content_source: 'summary',
            content: 'Page one summary.',
            path: 'report.pdf/Page 1',
            metadata: {
              summary: 'Page one summary.',
              page_nums: [1],
              custom_nested: {
                child_value: 'kept',
                list_items: [{ item_key: 'nested' }],
              },
              page_assets: [
                {
                  page_num: 1,
                  artifact_ref: 'page_citation_assets/page-1.png',
                  content_type: 'image/png',
                  width: 120,
                  height: 240,
                },
              ],
            },
          },
        ],
      },
    });
    await storage.writeObject({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      path: 'page_citation_assets/page-1.png',
      body: Buffer.from('page-one-image'),
      contentType: 'image/png',
    });
    await writeParsedStorageJsonObjectForTest(storage, {
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      objectPath: '.knowhere-sdk/commit.json',
      value: {
        version: 1,
        documentId: 'doc_remote',
        revisionKey: 'jres_remote',
        source: 'resultZip',
        committedAt: '2026-01-01T00:00:00.000Z',
      } satisfies ParsedDocumentCommit,
    });

    const read = await knowledge.readChunks({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      chunkType: 'page',
      limit: 1,
    });

    expect(documentsListChunks).not.toHaveBeenCalled();
    expect(read.chunks[0]?.pageNumbers).toEqual([1]);
    expect(read.chunks[0]?.metadata.customNested).toEqual({
      childValue: 'kept',
      listItems: [{ itemKey: 'nested' }],
    });
    expect(read.chunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        pageNum: 1,
        artifactRef: 'page_citation_assets/page-1.png',
        assetUrl: 'https://blob.example/doc_remote/jres_remote/page_citation_assets/page-1.png',
        contentType: 'image/png',
        width: 120,
        height: 240,
      }),
    ]);
    expect(read.chunks[0]?.metadata).not.toHaveProperty('page_assets');
    expect(read.chunks[0]?.metadata).not.toHaveProperty('custom_nested');
    expect(read.chunks[0]?.metadata.pageAssets).not.toEqual([
      expect.objectContaining({ artifact_ref: 'page_citation_assets/page-1.png' }),
    ]);
  });

  it('should fall back to remote chunks and schedule parsed storage sync on storage misses', async () => {
    const cacheDirectory = await createTempDirectory();
    const storage = createInMemoryParsedStorage();
    const scheduledTasks: Array<() => Promise<void>> = [];
    const scheduler = {
      schedule: vi.fn((task: () => Promise<void>): void => {
        scheduledTasks.push(task);
      }),
    };
    const { client, documentsListChunks, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory }).withParsedStorage({
      storage,
      scheduler,
      limits: {
        remotePageSize: 2,
        maxPagesPerSync: 10,
      },
    });

    const read = await knowledge.readChunks({
      documentId: 'doc_remote',
      page: 1,
      pageSize: 2,
    });

    expect(read.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-intro', 'chunk-table']);
    expect(read.chunks[1]?.assetUrl).toBe('https://assets.example/tables/revenue.html');
    expect(jobsLoad).not.toHaveBeenCalled();
    expect(scheduler.schedule).toHaveBeenCalledOnce();
    expect(storage.hasObject('doc_remote', 'jres_remote', 'manifest.json')).toBe(false);

    await scheduledTasks[0]?.();

    expect(documentsListChunks).toHaveBeenCalledWith('doc_remote', {
      page: 1,
      pageSize: 1,
      includeAssetUrls: true,
    });
    expect(jobsLoad).toHaveBeenCalledWith('job_remote');
    expect(storage.readJsonObject('doc_remote', 'jres_remote', 'manifest.json')).toMatchObject({
      jobId: 'job_remote',
      sourceFileName: 'job_remote.md',
    });
    const syncedChunks = storage.readJsonObject<{ readonly chunks?: readonly unknown[] }>(
      'doc_remote',
      'jres_remote',
      'chunks.json',
    );
    expect(Array.isArray(syncedChunks?.chunks)).toBe(true);
    expect(
      storage.readJsonObject('doc_remote', 'jres_remote', '.knowhere-sdk/commit.json'),
    ).toMatchObject({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      source: 'resultZip',
    });
    expect(storage.getProgress('doc_remote', 'jres_remote')?.status).toBe('completed');
  });

  it('should reconstruct minimal result layout when job-result sync is unavailable', async () => {
    const cacheDirectory = await createTempDirectory();
    const storage = createInMemoryParsedStorage();
    const scheduledTasks: Array<() => Promise<void>> = [];
    const scheduler = {
      schedule: vi.fn((task: () => Promise<void>): void => {
        scheduledTasks.push(task);
      }),
    };
    const { client, documentsListChunks, jobsLoad } = createClient(createParseResult());
    jobsLoad.mockRejectedValueOnce(new Error('job result unavailable'));
    const knowledge = new Knowledge(client, { cacheDirectory }).withParsedStorage({
      storage,
      scheduler,
      limits: {
        remotePageSize: 2,
        maxPagesPerSync: 10,
      },
    });

    await knowledge.readChunks({
      documentId: 'doc_remote',
      page: 1,
      pageSize: 2,
    });
    await scheduledTasks[0]?.();

    expect(documentsListChunks).toHaveBeenCalledWith('doc_remote', {
      page: 1,
      pageSize: 2,
      includeAssetUrls: true,
    });
    expect(
      storage.readJsonObject('doc_remote', 'jres_remote', '.knowhere-sdk/commit.json'),
    ).toMatchObject({
      source: 'remoteReconstruction',
    });
    expect(storage.getProgress('doc_remote', 'jres_remote')?.status).toBe('completed');
  });

  it('should sync configured parsed storage before parse returns', async () => {
    const cacheDirectory = await createTempDirectory();
    const storage = createInMemoryParsedStorage();
    const { client } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory }).withParsedStorage({ storage });

    const parsed = await knowledge.parseToLocalCache({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });

    expect(parsed.document.localDocumentId).toBe('local-report');
    expect(storage.getManifest('doc-1', 'job-1')).toMatchObject({
      jobId: 'job-1',
      sourceFileName: 'report.md',
    });
    const storedChunks = storage.readJsonObject<{
      readonly chunks?: ReadonlyArray<{ readonly chunk_id?: string }>;
    }>('doc-1', 'job-1', 'chunks.json');
    expect(storedChunks?.chunks?.some((chunk) => chunk.chunk_id === 'chunk-intro')).toBe(true);
    expect(storage.readJsonObject('doc-1', 'job-1', '.knowhere-sdk/commit.json')).toMatchObject({
      documentId: 'doc-1',
      revisionKey: 'job-1',
    });
    expect(storage.hasObject('doc-1', 'job-1', 'chunks/page-1.json')).toBe(false);
  });

  it('should reject paged read params combined with scan-heavy filters', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, documentsListChunks } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    await expect(
      knowledge.readChunks({
        documentId: 'doc_remote',
        page: 1,
        sectionPath: 'Intro',
      }),
    ).rejects.toThrow(/cannot be combined/);
    expect(documentsListChunks).not.toHaveBeenCalled();
  });

  it('should grep a remote document with truncation cursor while requesting asset URLs', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, documentsListChunks } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const grep = await knowledge.grepChunks({
      documentId: 'doc_remote',
      pattern: 'revenue',
      maxResults: 1,
    });

    expect(grep.matches).toHaveLength(1);
    expect(grep.truncated).toBe(true);
    expect(grep.continuationCursor).toEqual(expect.any(String));
    const resumed = await knowledge.grepChunks({
      documentId: 'doc_remote',
      pattern: 'revenue',
      maxResults: 1,
      continuationCursor: grep.continuationCursor,
    });
    expect(resumed.matches[0]?.chunkId).toBe('chunk-table');
    expect(documentsListChunks).toHaveBeenCalledWith('doc_remote', {
      page: 1,
      pageSize: 100,
      chunkType: undefined,
      includeAssetUrls: true,
    });
  });

  it('should fail clearly when a remote document id has no published job id', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, documentsListChunks } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    documentsListChunks.mockResolvedValueOnce({
      documentId: 'doc_missing_job',
      namespace: 'support-center',
      jobId: null,
      jobResultId: null,
      chunks: [],
      pagination: {
        page: 1,
        pageSize: 1,
        total: 0,
        totalPages: 0,
      },
    });

    await expect(
      knowledge.readChunks({
        documentId: 'doc_missing_job',
        limit: 5,
      }),
    ).rejects.toThrow('Cannot read server document doc_missing_job');
  });

  it('should sync a completed job id into the local cache before reads', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const read = await knowledge.readChunks({
      jobId: 'job-from-read',
      localDocumentId: 'local-from-job',
      sectionPath: 'Intro',
      limit: 1,
    });
    const documents = await knowledge.listDocuments();

    expect(jobsLoad).toHaveBeenCalledWith('job-from-read', { verifyChecksum: undefined });
    expect(read.document).toMatchObject({
      localDocumentId: 'local-from-job',
      jobId: 'job-from-read',
      sourceFileName: 'job-from-read.md',
      chunkCount: 3,
    });
    expect(read.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-intro']);
    expect(documents.map((document) => document.localDocumentId)).toEqual(['local-from-job']);
    await expectFileExists(
      path.join(cacheDirectory, 'documents', 'local-from-job', 'manifest.json'),
    );
  });

  it('should normalize parser-style doc navigation paths for outline and reads', async () => {
    const knowledge = await createKnowledgeWithCachedResult(createParseResultWithFullPaths());

    const outline = await knowledge.getDocumentOutline('local-report');
    const read = await knowledge.readChunks({
      localDocumentId: 'local-report',
      sectionPath: 'Intro',
      limit: 5,
    });

    expect(outline.sections[0]).toMatchObject({
      sectionPath: 'Intro',
      startChunk: 1,
      endChunk: 1,
      chunkCount: 1,
    });
    expect(read.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-intro']);
  });

  it('should grep literal and regex matches in local chunks', async () => {
    const knowledge = await createKnowledgeWithCachedResult();

    const literalResponse = await knowledge.grepChunks({
      localDocumentId: 'local-report',
      pattern: 'revenue',
      maxResults: 1,
    });
    const regexResponse = await knowledge.grepChunks({
      localDocumentId: 'local-report',
      pattern: 'Margin|Revenue',
      isRegex: true,
      isCaseSensitive: true,
      sectionPathPrefix: 'Revenue',
      chunkType: 'text',
    });

    expect(literalResponse.matches).toHaveLength(1);
    expect(literalResponse.matches[0]).toMatchObject({
      position: 1,
      chunkId: 'chunk-intro',
      startOffset: 6,
      endOffset: 13,
    });
    expect(literalResponse.truncated).toBe(true);
    expect(regexResponse.matches).toHaveLength(1);
    expect(regexResponse.matches[0]).toMatchObject({
      position: 3,
      chunkId: 'chunk-margin',
      sectionPath: 'Revenue',
    });
  });

  it('should copy page numbers onto grep matches from the source chunk', async () => {
    const knowledge = await createKnowledgeWithCachedResult(createPageParseResult());

    const grep = await knowledge.grepChunks({
      localDocumentId: 'local-report',
      pattern: 'Page one',
      maxResults: 1,
    });

    expect(grep.matches[0]).toMatchObject({
      chunkId: 'page-1',
      chunkType: 'page',
      pageNumbers: [1],
    });
  });

  it('should copy page numbers onto remote grep matches from listed chunks', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client } = createClient(createPageParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const grep = await knowledge.grepChunks({
      documentId: 'doc_remote',
      pattern: 'Page one',
      maxResults: 1,
    });

    expect(grep.matches[0]).toMatchObject({
      chunkId: 'page-1',
      chunkType: 'page',
      pageNumbers: [1],
    });
  });

  it('should copy page numbers onto grep matches from parsed storage', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = createPageParseResult();
    const storage = createInMemoryParsedStorage();
    storage.seedResult({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      result: parseResult,
    });
    const { client, documentsListChunks } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory }).withParsedStorage({
      storage,
    });

    const grep = await knowledge.grepChunks({
      documentId: 'doc_remote',
      pattern: 'Page one',
      maxResults: 1,
    });

    expect(grep.matches[0]).toMatchObject({
      chunkId: 'page-1',
      chunkType: 'page',
      pageNumbers: [1],
    });
    expect(documentsListChunks).toHaveBeenCalled();
  });

  it('should omit useAgentic when unset so API map-nav default applies', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, retrievalQuery } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });
    await knowledge.parseToLocalCache({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });

    await knowledge.search({
      query: 'margin',
      namespace: 'support-center',
      localDocumentIds: ['local-report'],
      topK: 2,
    });

    expect(retrievalQuery).toHaveBeenCalledWith({
      query: 'margin',
      namespace: 'support-center',
      topK: 2,
      useAgentic: undefined,
    });
  });

  it('should search through Knowhere API retrieval', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, retrievalQuery } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });
    await knowledge.parseToLocalCache({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });

    const response = await knowledge.search({
      query: 'margin',
      namespace: 'support-center',
      localDocumentIds: ['local-report'],
      topK: 2,
      useAgentic: true,
    });

    expect(retrievalQuery).toHaveBeenCalledWith({
      query: 'margin',
      namespace: 'support-center',
      topK: 2,
      useAgentic: true,
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      localDocumentId: 'local-report',
      documentId: 'doc-1',
      chunkId: 'chunk-margin',
      sectionPath: 'Revenue',
      score: 0.42,
    });
    expect(response.references[0]).toMatchObject({
      localDocumentId: 'local-report',
      documentId: 'doc-1',
      chunkId: 'chunk-margin',
    });
    expect(response.references[1]).toMatchObject({
      localDocumentId: 'local-report',
      documentId: 'doc-1',
      chunkId: 'chunk-margin',
    });
  });

  it('should reload local documents from expanded result files', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client } = createClient(createParseResult());
    const firstKnowledge = new Knowledge(client, { cacheDirectory });

    await firstKnowledge.parse({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });

    const secondKnowledge = new Knowledge(client, { cacheDirectory });
    const read = await secondKnowledge.readChunks({
      localDocumentId: 'local-report',
      chunkType: 'table',
      limit: 1,
    });
    const savedTable = await readFile(
      path.join(cacheDirectory, 'documents', 'local-report', 'tables', 'revenue.html'),
      'utf8',
    );

    expect(read.document.resultDirectoryPath).toBe(
      path.join(cacheDirectory, 'documents', 'local-report'),
    );
    expect(read.chunks).toHaveLength(1);
    expect(read.chunks[0]).toMatchObject({
      chunkId: 'chunk-table',
      filePath: 'tables/revenue.html',
      content: '<table><tr><td>Revenue</td></tr></table>',
    });
    expect(savedTable).toBe('<table><tr><td>Revenue</td></tr></table>');
  });

  it('should persist page assets from parse results into local read chunks', async () => {
    const knowledge = await createKnowledgeWithCachedResult(createPageParseResultWithAssets());

    const read = await knowledge.readChunks({
      localDocumentId: 'local-report',
      chunkType: 'page',
      limit: 1,
    });

    expect(read.chunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        pageNum: 1,
        artifactRef: 'page_citation_assets/page-1.png',
        width: 120,
        height: 240,
      }),
    ]);
    expect(read.chunks[0]).not.toHaveProperty('pageAssets');
  });

  it('should import server-provided page assets without SDK-side rendering', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = await createPageParseResultWithRawPageAsset();
    const { client, jobsLoad, documentsGetPageCitationSource } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory });

    const cached = await knowledge.importJobResult({
      jobId: 'job-1',
      localDocumentId: 'local-report',
    });
    const read = await knowledge.readChunks({
      localDocumentId: 'local-report',
      chunkType: 'page',
      limit: 1,
    });

    expect(jobsLoad).toHaveBeenCalledWith('job-1', { verifyChecksum: undefined });
    expect(documentsGetPageCitationSource).not.toHaveBeenCalled();
    expect(cached.result.pageChunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        pageNum: 1,
        artifactRef: 'page_citation_assets/page-1.png',
      }),
    ]);
    expect(cached.result.pageChunks[0]).not.toHaveProperty('pageAssets');
    expect(read.chunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        pageNum: 1,
        artifactRef: 'page_citation_assets/page-1.png',
        width: 120,
        height: 240,
      }),
    ]);
    expect(read.chunks[0]).not.toHaveProperty('pageAssets');
  });

  it('should load job result assets through a storage adapter without saving locally', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = await createPageParseResultWithRawPageAsset();
    const { client, jobsLoad } = createClient(parseResult);
    const writeObject = vi.fn(
      (input: KnowhereAssetStorageObject): Promise<KnowhereAssetStorageWriteResult> =>
        Promise.resolve({
          key: input.key,
          url: `https://blob.example/${input.key}`,
        }),
    );
    const adapter: KnowhereAssetStorageAdapter = {
      writeObject,
    };
    const knowledge = new Knowledge(client, { cacheDirectory });

    const loaded = await knowledge.loadJobResult({
      jobId: 'job-1',
      storageAdapter: {
        adapter,
        keyPrefix: 'workspaces/workspace-1/sources/source-1/parsed-result',
      },
    });
    const documents = await knowledge.listDocuments();

    expect(jobsLoad).toHaveBeenCalledWith('job-1', { verifyChecksum: undefined });
    expect(documents).toEqual([]);
    expect(loaded.assetUrlsByFilePath).toEqual({
      'page_citation_assets/page-1.png':
        'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
    });
    expect(loaded.result.pageChunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        artifactRef: 'page_citation_assets/page-1.png',
        assetUrl:
          'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
      }),
    ]);
    expect(loaded.result.pageChunks[0]).not.toHaveProperty('pageAssets');
    await expectFileMissing(path.join(cacheDirectory, 'documents'));
  });

  it('should import job result assets through a storage adapter and preserve metadata shape', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = await createPageParseResultWithRawPageAsset();
    const { client } = createClient(parseResult);
    const writeObject = vi.fn(
      (input: KnowhereAssetStorageObject): Promise<KnowhereAssetStorageWriteResult> =>
        Promise.resolve({
          key: input.key,
          url: `https://blob.example/${input.key}`,
        }),
    );
    const adapter: KnowhereAssetStorageAdapter = {
      writeObject,
    };
    const knowledge = new Knowledge(client, { cacheDirectory });

    const cached = await knowledge.importJobResult({
      jobId: 'job-1',
      localDocumentId: 'local-report',
      storageAdapter: {
        adapter,
        keyPrefix: 'workspaces/workspace-1/sources/source-1/parsed-result',
      },
    });
    const read = await knowledge.readChunks({
      localDocumentId: 'local-report',
      chunkType: 'page',
      limit: 1,
    });

    expect(cached.assetUrlsByFilePath).toEqual({
      'page_citation_assets/page-1.png':
        'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
    });
    expect(cached.result.pageChunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        artifactRef: 'page_citation_assets/page-1.png',
        assetUrl:
          'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
      }),
    ]);
    expect(cached.result.pageChunks[0]).not.toHaveProperty('pageAssets');
    expect(read.chunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        artifactRef: 'page_citation_assets/page-1.png',
        assetUrl:
          'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
      }),
    ]);
    expect(read.chunks[0]).not.toHaveProperty('pageAssets');
  });

  async function createKnowledgeWithCachedResult(
    parseResult = createParseResult(),
  ): Promise<Knowledge> {
    const cacheDirectory = await createTempDirectory();
    const { client } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory });
    await knowledge.parseToLocalCache({
      url: 'https://example.com/report.md',
      localDocumentId: 'local-report',
    });
    return knowledge;
  }

  async function createTempDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'knowhere-knowledge-'));
    tempDirectories.push(directory);
    return directory;
  }
});

function createClient(parseResult: ParseResult): {
  client: Knowhere;
  parse: ReturnType<typeof vi.fn>;
  startParse: ReturnType<typeof vi.fn>;
  jobsGet: ReturnType<typeof vi.fn>;
  jobsLoad: ReturnType<typeof vi.fn>;
  documentsListChunks: ReturnType<typeof vi.fn>;
  documentsGetPageCitationSource: ReturnType<typeof vi.fn>;
  retrievalQuery: ReturnType<typeof vi.fn>;
} {
  const parse = vi.fn().mockResolvedValue(parseResult);
  let startedJobCount = 0;
  const startParse = vi.fn().mockImplementation(() => {
    startedJobCount += 1;
    return Promise.resolve({
      jobId: startedJobCount === 1 ? 'job-1' : `job-${startedJobCount}`,
      status: 'waiting-file',
      sourceType: 'file',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });
  const jobsGet = vi.fn().mockImplementation((jobId: string) =>
    Promise.resolve({
      jobId,
      status: 'done',
      sourceType: 'url',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      resultUrl: 'https://example.com/result.zip',
      isTerminal: true,
      isDone: true,
      isFailed: false,
    }),
  );
  const jobsLoad = vi.fn().mockImplementation((jobId: string) =>
    Promise.resolve({
      ...parseResult,
      jobId,
      documentId: jobId === 'job_remote' ? 'doc_remote' : parseResult.documentId,
      manifest: {
        ...parseResult.manifest,
        jobId,
        sourceFileName: `${jobId}.md`,
      },
    }),
  );
  const documentsListChunks = vi
    .fn()
    .mockImplementation(
      (
        documentId: string,
        params?: DocumentChunkListParams,
      ): Promise<DocumentChunkListResponse> => {
        const page = params?.page ?? 1;
        const pageSize = params?.pageSize ?? 50;
        const chunks = toRemoteDocumentChunks(parseResult, documentId, params);
        const pageChunks = chunks.slice((page - 1) * pageSize, page * pageSize);
        return Promise.resolve({
          documentId,
          namespace: 'support-center',
          jobId: documentId === 'doc_remote' ? 'job_remote' : parseResult.jobId,
          jobResultId: documentId === 'doc_remote' ? 'jres_remote' : `jres_${parseResult.jobId}`,
          chunks: pageChunks,
          pagination: {
            page,
            pageSize,
            total: chunks.length,
            totalPages: Math.max(1, Math.ceil(chunks.length / pageSize)),
          },
        });
      },
    );
  const documentsGetPageCitationSource = vi.fn().mockResolvedValue({
    documentId: 'doc-1',
    namespace: 'support-center',
    jobId: 'job-1',
    jobResultId: 'jres-1',
    variant: 'normalized_pdf',
    fileName: 'report.pdf',
    contentType: 'application/pdf',
    url: 'https://assets.example/source.pdf',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const retrievalQuery = vi.fn().mockResolvedValue({
    namespace: 'support-center',
    query: 'margin',
    routerUsed: 'legacy',
    answerText: null,
    evidenceText: '[report.md / Revenue]\nMargin guidance improved.',
    referencedChunks: [
      {
        documentId: 'doc-1',
        chunkId: 'chunk-margin',
        chunkType: 'text',
        sectionPath: 'Revenue',
      },
    ],
    results: [
      {
        chunkId: 'chunk-margin',
        content: 'Margin guidance improved.',
        chunkType: 'text',
        score: 0.42,
        source: {
          documentId: 'doc-1',
          sourceFileName: 'report.md',
          sectionPath: 'Revenue',
        },
      },
    ],
  });
  return {
    client: {
      parse,
      startParse,
      jobs: {
        get: jobsGet,
        load: jobsLoad,
      },
      documents: {
        listChunks: documentsListChunks,
        getPageCitationSource: documentsGetPageCitationSource,
      },
      retrieval: {
        query: retrievalQuery,
      },
    } as unknown as Knowhere,
    parse,
    startParse,
    jobsGet,
    jobsLoad,
    documentsListChunks,
    documentsGetPageCitationSource,
    retrievalQuery,
  };
}

async function expectFileExists(filePath: string): Promise<void> {
  await expect(access(filePath)).resolves.toBeUndefined();
}

async function expectFileMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

function toRemoteDocumentChunks(
  result: ParseResult,
  documentId: string,
  params?: DocumentChunkListParams,
): DocumentChunk[] {
  return result.chunks
    .map((chunk, index): DocumentChunk => {
      const sectionPath = chunk.path.replace(`${result.manifest.sourceFileName}/`, '');
      const filePath =
        chunk.type === 'image' || chunk.type === 'table'
          ? chunk.filePath
          : typeof chunk.metadata.filePath === 'string'
            ? chunk.metadata.filePath
            : undefined;
      return {
        id: `${documentId}-${chunk.chunkId}`,
        chunkId: chunk.chunkId,
        chunkType: chunk.type,
        contentSource: chunk.contentSource,
        content: chunk.content,
        sectionPath,
        sourceChunkPath: chunk.path,
        filePath,
        sortOrder: index,
        metadata: chunk.metadata,
        assetUrl:
          params?.includeAssetUrls && (chunk.type === 'image' || chunk.type === 'table')
            ? chunk.assetUrl
            : undefined,
      };
    })
    .filter((chunk) => !params?.chunkType || chunk.chunkType === params.chunkType);
}

function createInMemoryParsedStorage(): ParsedDocumentStorage & {
  seedResult(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly result: ParseResult;
  }): void;
  hasObject(documentId: string, revisionKey: string, objectPath: string): boolean;
  readJsonObject<T>(documentId: string, revisionKey: string, objectPath: string): T | undefined;
  getManifest(documentId: string, revisionKey: string): unknown;
  getProgress(documentId: string, revisionKey: string): ParsedDocumentSyncProgress | undefined;
} {
  const objects = new Map<string, ParsedDocumentObject>();
  const progressByRevision = new Map<string, ParsedDocumentSyncProgress>();

  function getRevisionKey(documentId: string, revisionKey: string): string {
    return `${documentId}:${revisionKey}`;
  }

  function getObjectKey(documentId: string, revisionKey: string, objectPath: string): string {
    return `${getRevisionKey(documentId, revisionKey)}:${objectPath}`;
  }

  function writeObjectSync(params: ParsedDocumentWriteObjectParams): void {
    objects.set(getObjectKey(params.documentId, params.revisionKey, params.path), {
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      path: params.path,
      body: params.body,
      contentType: params.contentType,
      contentLength: params.body.byteLength,
      metadata: params.metadata,
      url: `https://blob.example/${params.documentId}/${params.revisionKey}/${params.path}`,
    });
  }

  function seedResult(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly result: ParseResult;
  }): void {
    writeJsonObjectSync(
      params.documentId,
      params.revisionKey,
      'manifest.json',
      params.result.manifest,
    );
    writeJsonObjectSync(params.documentId, params.revisionKey, 'chunks.json', {
      chunks: params.result.chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        type: chunk.type,
        contentSource: chunk.contentSource,
        content: chunk.content,
        path: chunk.path,
        metadata: chunk.metadata,
        filePath: chunk.type === 'image' || chunk.type === 'table' ? chunk.filePath : undefined,
        assetUrl: chunk.type === 'image' || chunk.type === 'table' ? chunk.assetUrl : undefined,
      })),
    });
    for (const chunk of params.result.chunks) {
      if (chunk.type === 'image') {
        writeObjectSync({
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          path: chunk.filePath,
          body: new Uint8Array(chunk.data),
          contentType: `image/${chunk.format}`,
          metadata: {
            chunkId: chunk.chunkId,
            chunkType: chunk.type,
            sourcePath: chunk.filePath,
          },
        });
      }
      if (chunk.type === 'table') {
        writeObjectSync({
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          path: chunk.filePath,
          body: Buffer.from(chunk.html, 'utf8'),
          contentType: 'text/html; charset=utf-8',
          metadata: {
            chunkId: chunk.chunkId,
            chunkType: chunk.type,
            sourcePath: chunk.filePath,
          },
        });
      }
    }
    if (params.result.docNav) {
      writeJsonObjectSync(
        params.documentId,
        params.revisionKey,
        'doc_nav.json',
        params.result.docNav,
      );
    }
    writeJsonObjectSync(params.documentId, params.revisionKey, '.knowhere-sdk/commit.json', {
      version: 1,
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      source: 'resultZip',
      committedAt: '2026-01-01T00:00:00.000Z',
    } satisfies ParsedDocumentCommit);
  }

  function writeJsonObjectSync(
    documentId: string,
    revisionKey: string,
    objectPath: string,
    value: unknown,
  ): void {
    writeObjectSync({
      documentId,
      revisionKey,
      path: objectPath,
      body: Buffer.from(JSON.stringify(value), 'utf8'),
      contentType: 'application/json; charset=utf-8',
    });
  }

  function readJsonObject<T>(
    documentId: string,
    revisionKey: string,
    objectPath: string,
  ): T | undefined {
    const object = objects.get(getObjectKey(documentId, revisionKey, objectPath));
    if (!object) return undefined;
    return JSON.parse(Buffer.from(object.body).toString('utf8')) as T;
  }

  return {
    seedResult,
    hasObject: (documentId: string, revisionKey: string, objectPath: string) =>
      objects.has(getObjectKey(documentId, revisionKey, objectPath)),
    readJsonObject,
    getManifest: (documentId: string, revisionKey: string) =>
      readJsonObject(documentId, revisionKey, 'manifest.json'),
    getProgress: (documentId: string, revisionKey: string) =>
      progressByRevision.get(getRevisionKey(documentId, revisionKey)),
    readObject: (params: ParsedDocumentObjectParams): Promise<ParsedDocumentObject | null> =>
      Promise.resolve(
        objects.get(getObjectKey(params.documentId, params.revisionKey, params.path)) ?? null,
      ),
    writeObject: (
      params: ParsedDocumentWriteObjectParams,
    ): Promise<{
      readonly documentId: string;
      readonly revisionKey: string;
      readonly path: string;
      readonly url?: string;
    }> => {
      writeObjectSync(params);
      const object = objects.get(getObjectKey(params.documentId, params.revisionKey, params.path));
      return Promise.resolve({
        documentId: params.documentId,
        revisionKey: params.revisionKey,
        path: params.path,
        url: object?.url,
      });
    },
    getObjectUrl: (params: ParsedDocumentObjectParams): Promise<string | null> =>
      Promise.resolve(
        objects.get(getObjectKey(params.documentId, params.revisionKey, params.path))?.url ?? null,
      ),
    readSyncProgress: (params): Promise<ParsedDocumentSyncProgress | null> =>
      Promise.resolve(
        progressByRevision.get(getRevisionKey(params.documentId, params.revisionKey)) ?? null,
      ),
    writeSyncProgress: (params): Promise<void> => {
      progressByRevision.set(getRevisionKey(params.documentId, params.revisionKey), params);
      return Promise.resolve();
    },
  };
}

async function writeParsedStorageJsonObjectForTest(
  storage: ParsedDocumentStorage,
  params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly objectPath: string;
    readonly value: unknown;
  },
): Promise<void> {
  await storage.writeObject({
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    path: params.objectPath,
    body: Buffer.from(JSON.stringify(params.value), 'utf8'),
    contentType: 'application/json; charset=utf-8',
  });
}

function createParseResult(): ParseResult {
  const chunks: [TextChunk, TableChunk, TextChunk] = [
    {
      chunkId: 'chunk-intro',
      type: 'text',
      content: 'Alpha revenue introduction.',
      path: 'report.md/Intro',
      metadata: { summary: 'Intro summary' },
    },
    {
      chunkId: 'chunk-table',
      type: 'table',
      content: '<table><tr><td>Revenue</td></tr></table>',
      path: 'report.md/Revenue',
      filePath: 'tables/revenue.html',
      assetUrl: 'https://assets.example/tables/revenue.html',
      html: '<table><tr><td>Revenue</td></tr></table>',
      metadata: { summary: 'Revenue table' },
      save: vi.fn(),
    },
    {
      chunkId: 'chunk-margin',
      type: 'text',
      content: 'Margin guidance improved.',
      path: 'report.md/Revenue',
      metadata: { summary: 'Margin summary' },
    },
  ];

  return {
    manifest: {
      version: '2.0',
      jobId: 'job-1',
      sourceFileName: 'report.md',
      statistics: {
        totalChunks: 3,
        textChunks: 2,
        imageChunks: 0,
        tableChunks: 1,
      },
    },
    chunks,
    docNav: {
      sections: [
        {
          title: 'Intro',
          path: 'Intro',
          level: 1,
          summary: 'Intro summary',
          chunkCount: 1,
          children: [],
        },
        {
          title: 'Revenue',
          path: 'Revenue',
          level: 1,
          summary: 'Revenue summary',
          chunkCount: 2,
          children: [],
        },
      ],
    },
    rawZip: Buffer.from('not-used-in-tests'),
    namespace: 'support-center',
    documentId: 'doc-1',
    textChunks: chunks.filter((chunk): chunk is TextChunk => chunk.type === 'text'),
    imageChunks: [],
    tableChunks: chunks.filter((chunk): chunk is TableChunk => chunk.type === 'table'),
    pageChunks: [],
    jobId: 'job-1',
    statistics: {
      totalChunks: 3,
      textChunks: 2,
      imageChunks: 0,
      tableChunks: 1,
    },
    getChunk: (chunkId: string) => chunks.find((chunk) => chunk.chunkId === chunkId),
    save: vi.fn(),
  };
}

function createParseResultWithFullPaths(): ParseResult {
  const result = createParseResult();
  result.chunks = result.chunks.map((chunk) => ({
    ...chunk,
    path: `project_kb/report.md/${chunk.path.replace('report.md/', '')}`,
  }));
  result.docNav = {
    sections: [
      {
        title: 'Intro',
        path: 'project_kb/report.md/Intro',
        level: 1,
        summary: 'Intro summary',
        chunkCount: 1,
        children: [],
      },
      {
        title: 'Revenue',
        path: 'project_kb/report.md/Revenue',
        level: 1,
        summary: 'Revenue summary',
        chunkCount: 2,
        children: [],
      },
    ],
  };
  return result;
}

function createPageParseResult(chunks: Chunk[] = [createPageChunk()]): ParseResult {
  const pageChunks = chunks.filter(
    (chunk): chunk is Extract<Chunk, { type: 'page' }> => chunk.type === 'page',
  );

  return {
    manifest: {
      version: '2.0',
      jobId: 'job-1',
      sourceFileName: 'report.pdf',
      statistics: {
        totalChunks: chunks.length,
        textChunks: chunks.filter((chunk) => chunk.type === 'text').length,
        imageChunks: chunks.filter((chunk) => chunk.type === 'image').length,
        tableChunks: chunks.filter((chunk) => chunk.type === 'table').length,
        pageChunks: pageChunks.length,
      },
    },
    chunks,
    rawZip: Buffer.from('not-used-in-tests'),
    namespace: 'support-center',
    documentId: 'doc-1',
    textChunks: chunks.filter((chunk): chunk is TextChunk => chunk.type === 'text'),
    imageChunks: [],
    tableChunks: [],
    pageChunks,
    jobId: 'job-1',
    statistics: {
      totalChunks: chunks.length,
      textChunks: chunks.filter((chunk) => chunk.type === 'text').length,
      imageChunks: chunks.filter((chunk) => chunk.type === 'image').length,
      tableChunks: chunks.filter((chunk) => chunk.type === 'table').length,
      pageChunks: pageChunks.length,
    },
    getChunk: (chunkId: string) => chunks.find((chunk) => chunk.chunkId === chunkId),
    save: vi.fn(),
  };
}

function createPageChunk(): Chunk {
  return {
    chunkId: 'page-1',
    type: 'page',
    content: 'Page one summary.',
    contentSource: 'summary',
    path: 'report.pdf/Page 1',
    metadata: { summary: 'Page one summary.', pageNums: [1] },
  };
}

function createPageParseResultWithAssets(): ParseResult {
  const chunks: Chunk[] = [
    {
      chunkId: 'page-1',
      type: 'page',
      content: 'Page one summary.',
      contentSource: 'summary',
      path: 'report.pdf/Page 1',
      metadata: {
        summary: 'Page one summary.',
        pageNums: [1],
        pageAssets: [
          {
            pageNum: 1,
            artifactRef: 'page_citation_assets/page-1.png',
            assetUrl: 'https://assets.example/page-1.png',
            contentType: 'image/png',
            width: 120,
            height: 240,
            source: 'knowhere-rendered-page-citation-source',
          },
        ],
      },
    },
  ];

  return createPageParseResult(chunks);
}

async function createPageParseResultWithRawPageAsset(): Promise<ParseResult> {
  const result = createPageParseResultWithAssets();
  const zip = new JSZip();
  zip.file('page_citation_assets/page-1.png', Buffer.from('page-one-image'));
  result.rawZip = Buffer.from(await zip.generateAsync({ type: 'arraybuffer' }));
  return result;
}
