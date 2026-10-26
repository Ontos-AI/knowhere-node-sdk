import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncParseResultToParsedDocumentStorage } from '../parsed-document-storage.js';
import type { ParseResult } from '../../types/result.js';
import type { ParsedDocumentStorage } from '../../types/storage.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lazy ParseResult snapshot writes', () => {
  it('writes each ZIP entry before extracting the next entry', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', '{}');
    zip.file('chunks.json', '{"chunks":[]}');
    zip.file('image.png', new Uint8Array(1024));
    const rawZip = await zip.generateAsync({ type: 'nodebuffer' });
    const events: string[] = [];
    const originalLoad = JSZip.loadAsync.bind(JSZip);
    vi.spyOn(JSZip, 'loadAsync').mockImplementation(async (data, options) => {
      const archive = await originalLoad(data, options);
      for (const entry of Object.values(archive.files)) {
        const originalAsync = entry.async.bind(entry);
        vi.spyOn(entry, 'async').mockImplementation((...args) => {
          events.push(`read:${entry.name}`);
          return originalAsync(...args);
        });
      }
      return archive;
    });
    const storage: ParsedDocumentStorage = {
      readObject: () => Promise.resolve(null),
      writeObject: (params) => {
        events.push(`write:${params.path}`);
        return Promise.resolve(params);
      },
      readSyncProgress: () => Promise.resolve(null),
      writeSyncProgress: () => Promise.resolve(),
    };
    const result = {
      jobId: 'test',
      rawZip,
      chunks: [],
      imageChunks: [],
      tableChunks: [],
      manifest: {},
    } as unknown as ParseResult;
    await syncParseResultToParsedDocumentStorage({ result, storage });
    expect(events.indexOf('write:manifest.json')).toBeLessThan(events.indexOf('read:chunks.json'));
  });

  it('does not regenerate image buffers already present in the raw ZIP', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', '{}');
    zip.file('chunks.json', '{"chunks":[]}');
    zip.file('images/image.png', new Uint8Array([3]));
    const rawZip = await zip.generateAsync({ type: 'nodebuffer' });
    const image = {
      filePath: 'images/image.png',
      chunkId: 'image',
      type: 'image',
      get data(): Buffer {
        throw new Error('duplicate image materialized');
      },
    };
    const result = {
      jobId: 'test',
      rawZip,
      chunks: [],
      imageChunks: [image],
      tableChunks: [],
      manifest: {},
    } as unknown as ParseResult;
    const storage: ParsedDocumentStorage = {
      readObject: () => Promise.resolve(null),
      writeObject: (params) => Promise.resolve(params),
      readSyncProgress: () => Promise.resolve(null),
      writeSyncProgress: () => Promise.resolve(),
    };
    await expect(
      syncParseResultToParsedDocumentStorage({ result, storage }),
    ).resolves.toMatchObject({ revisionKey: 'test' });
  });
});

describe('snapshot fallback objects and archive preservation', () => {
  it('generates missing sidecars and media without replacing existing ZIP objects', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', '{"original":true}');
    zip.file('chunks.json', '{"chunks":[]}');
    zip.file('tables/existing.html', '<table>original</table>');
    zip.file('.knowhere-sdk/untrusted.json', 'ignored');
    zip.file('result.zip', 'ignored');
    const rawZip = await zip.generateAsync({ type: 'nodebuffer' });
    const imageBytes = Buffer.from([1, 2, 3]);
    const result = {
      jobId: 'test',
      rawZip,
      chunks: [],
      manifest: { generated: true },
      fullMarkdown: '# fallback',
      chunksSlim: [{ chunk_id: 'test' }],
      hierarchy: { root: [] },
      tocHierarchies: [{ title: 'Test' }],
      kbCsv: 'title,content',
      hierarchyViewHtml: '<html></html>',
      imageChunks: [
        { filePath: 'images/generated.png', data: imageBytes, chunkId: 'image', type: 'image' },
      ],
      tableChunks: [
        {
          filePath: 'tables/existing.html',
          html: 'replacement',
          chunkId: 'existing',
          type: 'table',
        },
        { filePath: 'tables/new.html', html: '<table>new</table>', chunkId: 'new', type: 'table' },
      ],
    } as unknown as ParseResult;
    const objects = new Map<string, Uint8Array>();
    const storage: ParsedDocumentStorage = {
      readObject: () => Promise.resolve(null),
      writeObject: (params) => {
        objects.set(params.path, params.body);
        return Promise.resolve(params);
      },
      readSyncProgress: () => Promise.resolve(null),
      writeSyncProgress: () => Promise.resolve(),
    };
    await syncParseResultToParsedDocumentStorage({ result, storage });
    expect(Buffer.from(objects.get('manifest.json')!).toString()).toBe('{"original":true}');
    expect(Buffer.from(objects.get('tables/existing.html')!).toString()).toBe(
      '<table>original</table>',
    );
    expect(Buffer.from(objects.get('tables/new.html')!).toString()).toBe('<table>new</table>');
    expect(objects.get('images/generated.png')).toBe(imageBytes);
    expect(
      [
        'full.md',
        'chunks_slim.json',
        'hierarchy.json',
        'toc_hierarchies.json',
        'kb.csv',
        'hierarchy_view.html',
      ].every((path) => objects.has(path)),
    ).toBe(true);
    expect(objects.has('.knowhere-sdk/untrusted.json')).toBe(false);
    expect(objects.has('result.zip')).toBe(false);
  });

  it('preserves MIME types and bytes for archived sidecars and media formats', async () => {
    const paths = {
      'data.csv': 'text/csv; charset=utf-8',
      'table.htm': 'text/html; charset=utf-8',
      'image.jpg': 'image/jpeg',
      'image.jpeg': 'image/jpeg',
      'image.gif': 'image/gif',
      'image.webp': 'image/webp',
      'image.svg': 'image/svg+xml',
      'unknown.bin': 'application/octet-stream',
    };
    const zip = new JSZip();
    zip.file('manifest.json', '{}');
    zip.file('chunks.json', '[]');
    for (const path of Object.keys(paths)) zip.file(path, `original:${path}`);
    const rawZip = await zip.generateAsync({ type: 'nodebuffer' });
    const objects = new Map<string, { readonly body: Uint8Array; readonly contentType: string }>();
    const result = {
      jobId: 'test',
      rawZip,
      chunks: [],
      imageChunks: [],
      tableChunks: [],
      manifest: {},
    } as unknown as ParseResult;
    const storage: ParsedDocumentStorage = {
      readObject: () => Promise.resolve(null),
      writeObject: (params) => {
        objects.set(params.path, params);
        return Promise.resolve(params);
      },
      readSyncProgress: () => Promise.resolve(null),
      writeSyncProgress: () => Promise.resolve(),
    };
    await syncParseResultToParsedDocumentStorage({ result, storage });
    for (const [path, contentType] of Object.entries(paths)) {
      expect(objects.get(path)?.contentType).toBe(contentType);
      expect(Buffer.from(objects.get(path)!.body).toString()).toBe(`original:${path}`);
    }
  });

  it('rejects unsafe generated paths and never commits a partial snapshot', async () => {
    const rawZip = await new JSZip().generateAsync({ type: 'nodebuffer' });
    const result = {
      jobId: 'test',
      rawZip,
      chunks: [],
      imageChunks: [{ filePath: '../outside.png', data: Buffer.from([1]) }],
      tableChunks: [],
      manifest: {},
    } as unknown as ParseResult;
    const paths: string[] = [];
    const storage: ParsedDocumentStorage = {
      readObject: () => Promise.resolve(null),
      writeObject: (params) => {
        paths.push(params.path);
        return Promise.resolve(params);
      },
      readSyncProgress: () => Promise.resolve(null),
      writeSyncProgress: () => Promise.resolve(),
    };
    await expect(syncParseResultToParsedDocumentStorage({ result, storage })).rejects.toThrow(
      /Invalid parsed result path/,
    );
    expect(paths).not.toContain('.knowhere-sdk/commit.json');
  });
});
