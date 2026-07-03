import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { storeParseResultAssets } from '../asset-storage.js';
import type {
  KnowhereAssetStorageAdapter,
  KnowhereAssetStorageHead,
  KnowhereAssetStorageObject,
  KnowhereAssetStorageWriteResult,
} from '../../types/storage.js';
import type {
  Chunk,
  ImageChunk,
  PageChunk,
  ParseResult,
  TableChunk,
  TextChunk,
} from '../../types/result.js';

describe('storeParseResultAssets', () => {
  it('stores image, table, and page citation assets and rewrites display URLs', async () => {
    const result = await createParseResultWithAssets();
    const writes: Array<{
      readonly key: string;
      readonly bodyText: string;
      readonly contentType: string;
    }> = [];
    const writeObject = vi.fn(
      (input: KnowhereAssetStorageObject): Promise<KnowhereAssetStorageWriteResult> => {
        writes.push({
          key: input.key,
          bodyText: Buffer.from(input.body).toString('utf8'),
          contentType: input.contentType,
        });
        return Promise.resolve({
          key: input.key,
          url: `https://blob.example/${input.key}`,
        });
      },
    );
    const adapter: KnowhereAssetStorageAdapter = {
      writeObject,
    };

    const stored = await storeParseResultAssets(result, {
      adapter,
      keyPrefix: 'workspaces/workspace-1/sources/source-1/parsed-result',
    });

    expect(stored.assetUrlsByFilePath).toEqual({
      'images/chart.png':
        'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/images/chart.png',
      'page_citation_assets/page-1.png':
        'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
      'tables/revenue.html':
        'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/tables/revenue.html',
    });
    expect(writes).toEqual([
      {
        key: 'workspaces/workspace-1/sources/source-1/parsed-result/images/chart.png',
        bodyText: 'chart-image',
        contentType: 'image/png',
      },
      {
        key: 'workspaces/workspace-1/sources/source-1/parsed-result/tables/revenue.html',
        bodyText: '<table>Revenue</table>',
        contentType: 'text/html; charset=utf-8',
      },
      {
        key: 'workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
        bodyText: 'page-one-image',
        contentType: 'image/png',
      },
    ]);
    expect(stored.result.imageChunks[0]?.assetUrl).toBe(
      'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/images/chart.png',
    );
    expect(stored.result.tableChunks[0]?.assetUrl).toBe(
      'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/tables/revenue.html',
    );
    expect(stored.result.pageChunks[0]?.metadata.pageAssets).toEqual([
      expect.objectContaining({
        pageNum: 1,
        artifactRef: 'page_citation_assets/page-1.png',
        assetUrl:
          'https://blob.example/workspaces/workspace-1/sources/source-1/parsed-result/page_citation_assets/page-1.png',
      }),
    ]);
    expect(stored.result.pageChunks[0]).not.toHaveProperty('pageAssets');
  });

  it('uses existing storage URLs when skipExisting is enabled', async () => {
    const result = createParseResult([
      {
        chunkId: 'image-1',
        type: 'image',
        content: 'Chart summary',
        path: 'report/images/chart.png',
        filePath: 'images/chart.png',
        data: Buffer.from('chart-image'),
        metadata: {},
        format: 'png',
        save: vi.fn(),
      },
    ]);
    const headObject = vi.fn(
      (key: string): Promise<KnowhereAssetStorageHead | null> =>
        Promise.resolve({
          key,
          url: `https://blob.example/existing/${key}`,
        }),
    );
    const writeObject = vi.fn(
      (input: KnowhereAssetStorageObject): Promise<KnowhereAssetStorageWriteResult> =>
        Promise.resolve({
        key: input.key,
        url: `https://blob.example/${input.key}`,
        }),
    );
    const adapter: KnowhereAssetStorageAdapter = {
      headObject,
      writeObject,
    };

    const stored = await storeParseResultAssets(result, {
      adapter,
      keyPrefix: 'parsed-result',
    });

    expect(writeObject).not.toHaveBeenCalled();
    expect(stored.assetUrlsByFilePath).toEqual({
      'images/chart.png': 'https://blob.example/existing/parsed-result/images/chart.png',
    });
    expect(stored.result.imageChunks[0]?.assetUrl).toBe(
      'https://blob.example/existing/parsed-result/images/chart.png',
    );
  });

  it('rejects unsafe storage key prefixes and ignores unsafe asset refs', async () => {
    const result = createParseResult([
      {
        chunkId: 'image-1',
        type: 'image',
        content: 'Chart summary',
        path: 'report/images/chart.png',
        filePath: '../chart.png',
        data: Buffer.from('chart-image'),
        metadata: {},
        format: 'png',
        save: vi.fn(),
      },
    ]);
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

    await expect(
      storeParseResultAssets(result, {
        adapter,
        keyPrefix: '../parsed-result',
      }),
    ).rejects.toThrow(/keyPrefix/);

    const stored = await storeParseResultAssets(result, {
      adapter,
      keyPrefix: 'parsed-result',
    });

    expect(writeObject).not.toHaveBeenCalled();
    expect(stored.assetUrlsByFilePath).toEqual({});
  });
});

async function createParseResultWithAssets(): Promise<ParseResult> {
  const zip = new JSZip();
  zip.file('page_citation_assets/page-1.png', Buffer.from('page-one-image'));

  return createParseResult(
    [
      {
        chunkId: 'image-1',
        type: 'image',
        content: 'Chart summary',
        path: 'report/images/chart.png',
        filePath: 'images/chart.png',
        data: Buffer.from('chart-image'),
        metadata: {},
        format: 'png',
        save: vi.fn(),
      },
      {
        chunkId: 'table-1',
        type: 'table',
        content: '<table>Revenue</table>',
        path: 'report/tables/revenue.html',
        filePath: 'tables/revenue.html',
        html: '<table>Revenue</table>',
        metadata: {},
        save: vi.fn(),
      },
      {
        chunkId: 'page-1',
        type: 'page',
        content: 'Page one summary',
        contentSource: 'summary',
        path: 'report/Page 1',
        metadata: {
          pageNums: [1],
          pageAssets: [
            {
              pageNum: 1,
              artifactRef: 'page_citation_assets/page-1.png',
              contentType: 'image/png',
              width: 120,
              height: 240,
              source: 'knowhere-rendered-page-citation-source',
            },
          ],
        },
      },
    ],
    Buffer.from(await zip.generateAsync({ type: 'arraybuffer' })),
  );
}

function createParseResult(chunks: readonly Chunk[], rawZip: Buffer = Buffer.alloc(0)): ParseResult {
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
        pageChunks: chunks.filter((chunk) => chunk.type === 'page').length,
      },
    },
    chunks: [...chunks],
    rawZip,
    textChunks: chunks.filter((chunk): chunk is TextChunk => chunk.type === 'text'),
    imageChunks: chunks.filter((chunk): chunk is ImageChunk => chunk.type === 'image'),
    tableChunks: chunks.filter((chunk): chunk is TableChunk => chunk.type === 'table'),
    pageChunks: chunks.filter((chunk): chunk is PageChunk => chunk.type === 'page'),
    jobId: 'job-1',
    statistics: {
      totalChunks: chunks.length,
      textChunks: chunks.filter((chunk) => chunk.type === 'text').length,
      imageChunks: chunks.filter((chunk) => chunk.type === 'image').length,
      tableChunks: chunks.filter((chunk) => chunk.type === 'table').length,
      pageChunks: chunks.filter((chunk) => chunk.type === 'page').length,
    },
    getChunk: (chunkId: string) => chunks.find((chunk) => chunk.chunkId === chunkId),
    save: vi.fn(),
  };
}
