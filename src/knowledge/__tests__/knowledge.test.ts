import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Knowledge } from '../knowledge.js';
import type { Knowhere } from '../../client.js';
import type {
  Chunk,
  DocumentChunkListResponse,
  ParseResult,
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

    const response = await knowledge.parse({
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
      knowledge.parse({
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

  it('should still allow manual completed job result caching', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, jobsLoad } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });

    const cached = await knowledge.cacheJobResult({
      jobId: 'job-1',
      localDocumentId: 'local-report',
      verifyChecksum: false,
    });

    expect(jobsLoad).toHaveBeenCalledWith('job-1', { verifyChecksum: false });
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

  it('should sync a remote document id into the local cache before reads', async () => {
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
      pageSize: 1,
    });
    expect(jobsLoad).toHaveBeenCalledWith('job_remote', { verifyChecksum: undefined });
    expect(read.document).toMatchObject({
      localDocumentId: 'doc_remote',
      documentId: 'doc_remote',
      namespace: 'support-center',
      jobId: 'job_remote',
      sourceFileName: 'job_remote.md',
      chunkCount: 3,
    });
    expect(read.chunks.map((chunk) => chunk.chunkId)).toEqual(['chunk-intro']);
    expect(outline.sections.map((section) => section.sectionPath)).toEqual(['Intro', 'Revenue']);
    expect(grep.matches[0]).toMatchObject({
      chunkId: 'chunk-intro',
      sectionPath: 'Intro',
    });
    expect(documents).toHaveLength(1);
    await expectFileExists(path.join(cacheDirectory, 'documents', 'doc_remote', 'manifest.json'));
    await expectFileExists(path.join(cacheDirectory, 'documents', 'doc_remote', 'chunks.json'));
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
    ).rejects.toThrow('Cannot sync server document doc_missing_job');
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

  it('should search through Knowhere API retrieval', async () => {
    const cacheDirectory = await createTempDirectory();
    const { client, retrievalQuery } = createClient(createParseResult());
    const knowledge = new Knowledge(client, { cacheDirectory });
    await knowledge.parse({
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

  it('should cache server-provided page assets without SDK-side rendering', async () => {
    const cacheDirectory = await createTempDirectory();
    const parseResult = createPageParseResultWithAssets();
    const { client, jobsLoad, documentsGetPageCitationSource } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory });

    const cached = await knowledge.cacheJobResult({
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

  async function createKnowledgeWithCachedResult(
    parseResult = createParseResult(),
  ): Promise<Knowledge> {
    const cacheDirectory = await createTempDirectory();
    const { client } = createClient(parseResult);
    const knowledge = new Knowledge(client, { cacheDirectory });
    await knowledge.parse({
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
  const documentsListChunks = vi.fn().mockImplementation(
    (_documentId: string): Promise<DocumentChunkListResponse> =>
      Promise.resolve({
        documentId: 'doc_remote',
        namespace: 'support-center',
        jobId: 'job_remote',
        jobResultId: 'jres_remote',
        chunks: [],
        pagination: {
          page: 1,
          pageSize: 1,
          total: 0,
          totalPages: 1,
        },
      }),
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
  const pageChunks = chunks.filter((chunk): chunk is Extract<Chunk, { type: 'page' }> => chunk.type === 'page');

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
