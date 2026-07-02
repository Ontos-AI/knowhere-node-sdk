import { describe, it, expect, vi, afterEach } from 'vitest';

import { PageCitationAssetGenerationError, ValidationError } from '../../errors/index.js';
import { enrichParseResultWithPageCitationAssets } from '../workflow.mjs';
import type {
  Chunk,
  DocumentPageCitationSource,
  KnowhereSdkStorage,
  KnowhereSdkStorageHead,
  KnowhereSdkStorageObject,
  KnowhereSdkStorageReadResult,
  KnowhereSdkStorageWriteResult,
  PageRenderer,
  ParseResult,
  RenderPageInput,
  RenderedPage,
} from '../../types/index.js';

describe('page citation asset workflow', () => {
  afterEach(() => {
    vi.doUnmock('../../page-renderer-pdfjs.js');
    vi.unstubAllGlobals();
  });

  it('renders and attaches assets for page chunks only', async () => {
    const storage = new MemoryStorage();
    const renderer = new FakeRenderer();
    const documents = createDocumentsClient();
    stubSourceFetch();

    const result = await enrichParseResultWithPageCitationAssets({
      result: createParseResult([
        createPageChunk('page-1', [1]),
        createTextChunk('text-1'),
        createImageChunk('image-1'),
        createTableChunk('table-1'),
        createPageChunk('page-2', [2]),
      ]),
      documents,
      options: { storage, renderer },
    });

    expect(renderer.renderedPageNums).toEqual([1, 2]);
    expect(getPageChunks(result)[0]?.pageAssets?.[0]).toMatchObject({
      pageNum: 1,
      mimeType: 'image/png',
      width: 101,
      height: 201,
    });
    expect(result.textChunks[0]).not.toHaveProperty('pageAssets');
    expect(result.imageChunks[0]).not.toHaveProperty('pageAssets');
    expect(result.tableChunks[0]).not.toHaveProperty('pageAssets');
    expect(storage.getJsonObjects().some((entry) => entry.key.endsWith('/index.json'))).toBe(true);
  });

  it('attaches cached assets without rendering or fetching the source', async () => {
    const storage = new MemoryStorage();
    const renderer = new FakeRenderer();
    const result = createParseResult([createPageChunk('page-1', [1])]);
    const key = expectedAssetKey(result, 1);
    storage.seedObject(key, {
      contentType: 'image/png',
      metadata: {
        pageNum: '1',
        width: '300',
        height: '400',
        mimeType: 'image/png',
      },
    });
    const documents = createDocumentsClient();
    const fetchMock = stubSourceFetch();

    const enriched = await enrichParseResultWithPageCitationAssets({
      result,
      documents,
      options: { storage, renderer },
    });

    expect(renderer.renderedPageNums).toEqual([]);
    expect(documents.calls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPageChunks(enriched)[0]?.pageAssets?.[0]).toMatchObject({
      pageNum: 1,
      width: 300,
      height: 400,
    });
  });

  it('returns warnings and preserves parse success for partial render failures', async () => {
    const storage = new MemoryStorage();
    const renderer = new FakeRenderer({ failedPageNums: [2] });
    stubSourceFetch();

    const result = await enrichParseResultWithPageCitationAssets({
      result: createParseResult([createPageChunk('page-1', [1]), createPageChunk('page-2', [2])]),
      documents: createDocumentsClient(),
      options: { storage, renderer },
    });

    expect(getPageChunks(result)[0]?.pageAssets).toHaveLength(1);
    expect(getPageChunks(result)[1]?.pageAssets).toBeUndefined();
    expect(result.pageCitationAssetWarnings?.map((warning) => warning.code)).toContain(
      'render_failed',
    );
  });

  it('returns warnings and preserves parse success for source failures', async () => {
    const storage = new MemoryStorage();
    const renderer = new FakeRenderer();
    const documents = {
      getPageCitationSource: vi.fn().mockRejectedValue(new Error('source missing')),
    };

    const result = await enrichParseResultWithPageCitationAssets({
      result: createParseResult([createPageChunk('page-1', [1])]),
      documents,
      options: { storage, renderer },
    });

    expect(documents.getPageCitationSource).toHaveBeenCalledWith('doc-1');
    expect(renderer.renderedPageNums).toEqual([]);
    expect(getPageChunks(result)[0]?.pageAssets).toBeUndefined();
    expect(result.pageCitationAssetWarnings?.[0]).toMatchObject({
      code: 'source_fetch_failed',
    });
  });

  it('returns warnings and preserves parse success for storage write failures', async () => {
    const storage = new WriteFailingStorage();
    const renderer = new FakeRenderer();
    stubSourceFetch();

    const result = await enrichParseResultWithPageCitationAssets({
      result: createParseResult([createPageChunk('page-1', [1])]),
      documents: createDocumentsClient(),
      options: { storage, renderer },
    });

    expect(renderer.renderedPageNums).toEqual([1]);
    expect(getPageChunks(result)[0]?.pageAssets).toBeUndefined();
    expect(result.pageCitationAssetWarnings?.[0]).toMatchObject({
      code: 'storage_failed',
    });
  });

  it('attaches written assets when storage URLs are unavailable', async () => {
    const storage = new UrlFailingStorage();
    const renderer = new FakeRenderer();
    stubSourceFetch();

    const result = await enrichParseResultWithPageCitationAssets({
      result: createParseResult([createPageChunk('page-1', [1])]),
      documents: createDocumentsClient(),
      options: { storage, renderer },
    });

    expect(getPageChunks(result)[0]?.pageAssets?.[0]).toMatchObject({
      pageNum: 1,
      assetUrl: undefined,
      key: expectedAssetKey(result, 1),
    });
    expect(result.pageCitationAssetWarnings).toBeUndefined();
  });

  it('fails in strict mode when generation returns warnings', async () => {
    const storage = new MemoryStorage();
    const renderer = new FakeRenderer({ failedPageNums: [1] });
    stubSourceFetch();

    await expect(
      enrichParseResultWithPageCitationAssets({
        result: createParseResult([createPageChunk('page-1', [1])]),
        documents: createDocumentsClient(),
        options: { storage, renderer, strict: true },
      }),
    ).rejects.toBeInstanceOf(PageCitationAssetGenerationError);
  });

  it('limits new renders after cache checks and writes only concrete assets to the index', async () => {
    const storage = new MemoryStorage();
    const renderer = new FakeRenderer();
    stubSourceFetch();

    const result = await enrichParseResultWithPageCitationAssets({
      result: createParseResult([createPageChunk('page-1', [1]), createPageChunk('page-2', [2])]),
      documents: createDocumentsClient(),
      options: { storage, renderer, maxPagesToRenderPerRun: 1 },
    });
    const index = storage
      .getJsonObjects()
      .find((entry) => entry.key.endsWith('/index.json'))?.value;

    expect(renderer.renderedPageNums).toEqual([1]);
    expect(result.pageCitationAssetWarnings?.map((warning) => warning.code)).toContain(
      'render_limit_exceeded',
    );
    expect(index).toMatchObject({
      version: 1,
      assets: [expect.objectContaining({ pageNum: 1 })],
    });
    expect(JSON.stringify(index)).not.toContain('status');
    expect(JSON.stringify(index)).not.toContain('placeholder');
  });

  it('rejects when documentId is missing for page chunks', async () => {
    await expect(
      enrichParseResultWithPageCitationAssets({
        result: createParseResult([createPageChunk('page-1', [1])], { documentId: undefined }),
        documents: createDocumentsClient(),
        options: { storage: new MemoryStorage(), renderer: new FakeRenderer() },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not require documentId when no page chunks are present', async () => {
    const documents: ReturnType<typeof createDocumentsClient> = createDocumentsClient();
    const renderer: FakeRenderer = new FakeRenderer();

    const result: ParseResult = await enrichParseResultWithPageCitationAssets({
      result: createParseResult(
        [createTextChunk('text-1'), createImageChunk('image-1'), createTableChunk('table-1')],
        { documentId: undefined },
      ),
      documents,
      options: { storage: new MemoryStorage(), renderer },
    });

    expect(result.pageCitationAssetWarnings).toBeUndefined();
    expect(documents.calls).toEqual([]);
    expect(renderer.renderedPageNums).toEqual([]);
  });

  it('does not close a caller-provided closeable renderer', async () => {
    const storage = new MemoryStorage();
    const renderer = new CloseableFakeRenderer();
    stubSourceFetch();

    await enrichParseResultWithPageCitationAssets({
      result: createParseResult([createPageChunk('page-1', [1])]),
      documents: createDocumentsClient(),
      options: { storage, renderer },
    });

    expect(renderer.renderedPageNums).toEqual([1]);
    expect(renderer.closeCalls).toBe(0);
  });

  it('closes the SDK-created default renderer after generation', async () => {
    const storage = new MemoryStorage();
    const renderer = new CloseableFakeRenderer();
    vi.doMock('../../page-renderer-pdfjs.js', () => ({
      createPdfJsPageRenderer: (): CloseableFakeRenderer => renderer,
    }));
    stubSourceFetch();

    await enrichParseResultWithPageCitationAssets({
      result: createParseResult([createPageChunk('page-1', [1])]),
      documents: createDocumentsClient(),
      options: { storage },
    });

    expect(renderer.renderedPageNums).toEqual([1]);
    expect(renderer.closeCalls).toBe(1);
  });
});

class MemoryStorage implements KnowhereSdkStorage {
  private readonly objects = new Map<
    string,
    {
      readonly body: Uint8Array;
      readonly contentType?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    }
  >();

  headObject(key: string): Promise<KnowhereSdkStorageHead | null> {
    const object = this.objects.get(key);
    if (!object) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      key,
      contentType: object.contentType,
      contentLength: object.body.byteLength,
      metadata: object.metadata,
    });
  }

  async writeObject(input: KnowhereSdkStorageObject): Promise<KnowhereSdkStorageWriteResult> {
    this.objects.set(input.key, {
      body: await readBody(input.body),
      contentType: input.contentType,
      metadata: input.metadata,
    });
    return {
      key: input.key,
      url: `memory://${input.key}`,
    };
  }

  getObjectUrl(key: string): Promise<string | null> {
    return Promise.resolve(this.objects.has(key) ? `memory://${key}` : null);
  }

  readObject(key: string): Promise<KnowhereSdkStorageReadResult | null> {
    const object = this.objects.get(key);
    if (!object) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      body: object.body,
      contentType: object.contentType,
      metadata: object.metadata,
    });
  }

  seedObject(
    key: string,
    options: { contentType?: string; metadata?: Readonly<Record<string, string>> },
  ): void {
    this.objects.set(key, {
      body: new Uint8Array([1]),
      contentType: options.contentType,
      metadata: options.metadata,
    });
  }

  getJsonObjects(): Array<{ key: string; value: unknown }> {
    return [...this.objects.entries()]
      .filter((entry) => entry[1].contentType === 'application/json')
      .map(([key, object]) => {
        const value: unknown = JSON.parse(Buffer.from(object.body).toString('utf8'));
        return { key, value };
      });
  }
}

class WriteFailingStorage extends MemoryStorage {
  writeObject(): Promise<KnowhereSdkStorageWriteResult> {
    return Promise.reject(new Error('write failed'));
  }
}

class UrlFailingStorage extends MemoryStorage {
  async writeObject(input: KnowhereSdkStorageObject): Promise<KnowhereSdkStorageWriteResult> {
    await super.writeObject(input);
    return { key: input.key };
  }

  getObjectUrl(): Promise<string | null> {
    return Promise.reject(new Error('url failed'));
  }
}

class FakeRenderer implements PageRenderer {
  readonly renderedPageNums: number[] = [];
  private readonly failedPageNums: ReadonlySet<number>;

  constructor(options: { failedPageNums?: readonly number[] } = {}) {
    this.failedPageNums = new Set(options.failedPageNums ?? []);
  }

  renderPage(input: RenderPageInput): Promise<RenderedPage> {
    this.renderedPageNums.push(input.pageNum);
    if (this.failedPageNums.has(input.pageNum)) {
      throw new Error(`failed page ${input.pageNum}`);
    }
    return Promise.resolve({
      body: new Uint8Array([input.pageNum]),
      mimeType: input.format,
      width: 100 + input.pageNum,
      height: 200 + input.pageNum,
    });
  }
}

class CloseableFakeRenderer extends FakeRenderer {
  closeCalls: number = 0;

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

function createDocumentsClient(): {
  calls: string[];
  getPageCitationSource(documentId: string): Promise<DocumentPageCitationSource>;
} {
  const calls: string[] = [];
  return {
    calls,
    getPageCitationSource(documentId: string): Promise<DocumentPageCitationSource> {
      calls.push(documentId);
      return Promise.resolve({
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
    },
  };
}

function stubSourceFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(new Uint8Array([37, 80, 68, 70])),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function createParseResult(
  chunks: Chunk[],
  options: { documentId?: string } = {},
): ParseResult {
  const textChunks = chunks.filter(
    (chunk): chunk is Extract<Chunk, { type: 'text' }> => chunk.type === 'text',
  );
  const imageChunks = chunks.filter(
    (chunk): chunk is Extract<Chunk, { type: 'image' }> => chunk.type === 'image',
  );
  const tableChunks = chunks.filter(
    (chunk): chunk is Extract<Chunk, { type: 'table' }> => chunk.type === 'table',
  );
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
        textChunks: textChunks.length,
        imageChunks: imageChunks.length,
        tableChunks: tableChunks.length,
        pageChunks: pageChunks.length,
      },
    },
    chunks,
    rawZip: Buffer.alloc(0),
    namespace: 'support-center',
    documentId: 'documentId' in options ? options.documentId : 'doc-1',
    textChunks,
    imageChunks,
    tableChunks,
    pageChunks,
    jobId: 'job-1',
    statistics: {
      totalChunks: chunks.length,
      textChunks: textChunks.length,
      imageChunks: imageChunks.length,
      tableChunks: tableChunks.length,
      pageChunks: pageChunks.length,
    },
    getChunk: (chunkId: string) => chunks.find((chunk) => chunk.chunkId === chunkId),
    save: vi.fn(),
  };
}

function getPageChunks(result: ParseResult): Array<Extract<Chunk, { type: 'page' }>> {
  return result.chunks.filter(
    (chunk): chunk is Extract<Chunk, { type: 'page' }> => chunk.type === 'page',
  );
}

function createPageChunk(chunkId: string, pageNums: readonly number[]): Chunk {
  return {
    chunkId,
    type: 'page',
    content: `Summary ${chunkId}`,
    contentSource: 'summary',
    path: `report.pdf/${chunkId}`,
    metadata: { pageNums: [...pageNums] },
  };
}

function createTextChunk(chunkId: string): Chunk {
  return {
    chunkId,
    type: 'text',
    content: `Text ${chunkId}`,
    contentSource: 'content',
    path: `report.pdf/${chunkId}`,
    metadata: {},
  };
}

function createImageChunk(chunkId: string): Chunk {
  return {
    chunkId,
    type: 'image',
    content: `Image ${chunkId}`,
    contentSource: 'caption',
    path: `report.pdf/${chunkId}`,
    filePath: `images/${chunkId}.png`,
    data: Buffer.from([1]),
    metadata: { pageNums: [99] },
    format: 'png',
    save: vi.fn(),
  };
}

function createTableChunk(chunkId: string): Chunk {
  return {
    chunkId,
    type: 'table',
    content: `Table ${chunkId}`,
    contentSource: 'summary',
    path: `report.pdf/${chunkId}`,
    filePath: `tables/${chunkId}.html`,
    html: '<table></table>',
    metadata: { page_nums: [100] },
    save: vi.fn(),
  };
}

function expectedAssetKey(result: ParseResult, pageNum: number): string {
  return [
    'page-citation-assets',
    'documents',
    result.documentId,
    'jobs',
    result.jobId,
    'variants',
    'default',
    'scale-1',
    `page-${String(pageNum).padStart(6, '0')}.png`,
  ].join('/');
}

async function readBody(body: Uint8Array | ReadableStream<Uint8Array> | Blob): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    }
    chunks.push(result.value);
  }
}
