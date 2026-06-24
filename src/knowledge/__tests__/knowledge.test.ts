import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Knowledge } from '../knowledge.js';
import type { Knowhere } from '../../client.js';
import type { ParseResult, TextChunk, TableChunk } from '../../types/index.js';

describe('Knowledge', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
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
    expect(response.document.typeCounts).toEqual({ text: 2, image: 0, table: 1 });
    expect(documents).toHaveLength(1);
    expect(documents[0]?.sourceFileName).toBe('report.md');
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

  it('should search locally without calling remote retrieval', async () => {
    const knowledge = await createKnowledgeWithCachedResult();

    const response = await knowledge.search({
      query: 'margin',
      localDocumentIds: ['local-report'],
      topK: 2,
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      localDocumentId: 'local-report',
      chunkId: 'chunk-margin',
      sectionPath: 'Revenue',
      score: 2,
    });
    expect(response.references[0]?.chunkId).toBe('chunk-margin');
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
} {
  const parse = vi.fn().mockResolvedValue(parseResult);
  return {
    client: {
      parse,
      retrieval: {
        query: vi.fn(),
      },
    } as unknown as Knowhere,
    parse,
  };
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
