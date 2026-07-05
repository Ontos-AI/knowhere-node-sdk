/* eslint-disable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  parseResult,
  parseResultDirectory,
  saveExpandedParseResult,
  verifyChecksum,
} from '../result-parser.js';
import { ChecksumError, KnowhereError } from '../../errors/index.js';
import type { Manifest } from '../../types/result.js';
import { createHash } from 'crypto';

// Test helper: Create mock result ZIP
async function createMockResultZip(
  options: {
    includeImages?: boolean;
    includeTables?: boolean;
    includeFullMarkdown?: boolean;
    includeHierarchy?: boolean;
    wrapChunks?: boolean;
    useMetadata?: boolean;
    useLegacyNumericTokens?: boolean;
  } = {},
): Promise<Buffer> {
  const zip = new JSZip();

  // Create manifest
  const files: Record<string, string> = {
    manifest: 'manifest.json',
    chunks: 'chunks.json',
  };

  if (options.includeFullMarkdown) {
    files.fullMarkdown = 'full.md';
  }

  if (options.includeHierarchy) {
    files.hierarchy = 'hierarchy.json';
  }

  const manifest: Partial<Manifest> = {
    version: '1.0',
    jobId: 'job-test-123',
    dataId: 'custom-id',
    sourceFileName: 'test.pdf',
    processingDate: new Date('2024-01-15T10:00:00Z'),
    statistics: {
      totalChunks: 3,
      textChunks: 1,
      imageChunks: options.includeImages ? 1 : 0,
      tableChunks: options.includeTables ? 1 : 0,
      totalPages: 10,
    },
    files,
  };

  zip.file('manifest.json', JSON.stringify(manifest));

  // Create chunks
  const chunks: Array<Record<string, unknown>> = [
    options.useMetadata
      ? {
          chunkId: 'chunk-001',
          type: 'text',
          content: 'This is sample text content for testing.',
          path: 'page-1',
          metadata: {
            length: 250,
            tokens: ['token-a', 'token-b'],
            keywords: ['test', 'sample'],
            summary: 'Sample text chunk',
            relationships: ['chunk-002'],
          },
        }
      : {
          chunkId: 'chunk-001',
          type: 'text',
          content: 'This is sample text content for testing.',
          path: 'page-1',
          length: 250,
          tokens: options.useLegacyNumericTokens ? 45 : ['token-a', 'token-b'],
          keywords: ['test', 'sample'],
          summary: 'Sample text chunk',
        },
  ];

  if (options.includeImages) {
    chunks.push(
      options.useMetadata
        ? {
            chunkId: 'chunk-002',
            type: 'image',
            content: 'Image description',
            path: 'page-2',
            metadata: {
              length: 1,
              filePath: 'images/image-001.jpg',
              summary: 'Test image',
            },
          }
        : {
            chunkId: 'chunk-002',
            type: 'image',
            content: 'Image description',
            path: 'page-2',
            length: 1,
            filePath: 'images/image-001.jpg',
            summary: 'Test image',
          },
    );
    // Add actual image file
    zip.file('images/image-001.jpg', Buffer.from('fake-jpg-data'));
  }

  if (options.includeTables) {
    chunks.push(
      options.useMetadata
        ? {
            chunkId: 'chunk-003',
            type: 'table',
            content: 'Table content as text',
            path: 'page-3',
            metadata: {
              length: 1,
              filePath: 'tables/table-001.html',
              tableType: 'data',
              summary: 'Test table',
            },
          }
        : {
            chunkId: 'chunk-003',
            type: 'table',
            content: 'Table content as text',
            path: 'page-3',
            length: 1,
            filePath: 'tables/table-001.html',
            tableType: 'data',
            summary: 'Test table',
          },
    );
    // Add actual table file
    zip.file('tables/table-001.html', '<table><tr><td>Test Data</td></tr></table>');
  }

  zip.file('chunks.json', JSON.stringify(options.wrapChunks ? { chunks } : chunks));

  // Add optional files
  if (options.includeFullMarkdown) {
    zip.file('full.md', '# Test Document\n\nThis is the full markdown content.');
  }

  if (options.includeHierarchy) {
    zip.file(
      'hierarchy.json',
      JSON.stringify({
        type: 'document',
        children: [{ type: 'section', title: 'Introduction' }],
      }),
    );
  }

  return await zip.generateAsync({ type: 'nodebuffer' });
}

async function createOptimizedResultZip(): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    'manifest.json',
    JSON.stringify({
      version: '2.0',
      job_id: 'job-optimized-123',
      source_file_name: 'optimized.pdf',
      processing_date: '2026-04-09T06:28:02.673039Z',
      processing: {
        page_count: 12,
        billing_status: 'charged',
        cost: {
          micro_dollars: 60000,
          credits: 0.06,
        },
        timing: {
          started_at: '2026-04-09T06:27:15.589286Z',
          completed_at: '2026-04-09T06:28:02.621594Z',
          duration_ms: 47032,
        },
      },
      statistics: {
        total_chunks: 3,
        text_chunks: 1,
        image_chunks: 1,
        table_chunks: 1,
        total_pages: null,
      },
    }),
  );

  zip.file(
    'chunks.json',
    JSON.stringify({
      chunks: [
        {
          chunk_id: 'chunk-text-001',
          type: 'text',
          content: 'Text chunk with embedded resources.',
          path: 'Default_Root/optimized.pdf-->Section 1',
          metadata: {
            length: 35,
            summary: '',
            page_nums: [1, 2],
            tokens: ['Text', 'chunk'],
            keywords: ['optimized'],
            connect_to: [
              {
                target: 'chunk-image-001',
                relation: 'embeds',
                ref: '[images/image-001.jpg]',
              },
            ],
          },
        },
        {
          chunk_id: 'chunk-image-001',
          type: 'image',
          content: '[images/image-001.jpg]',
          path: 'images/image-001.jpg',
          metadata: {
            length: 1,
            summary: 'Optimized image chunk',
            page_nums: [2],
            file_path: 'images/image-001.jpg',
            keywords: [],
            tokens: [],
          },
        },
        {
          chunk_id: 'chunk-table-001',
          type: 'table',
          content: '<table><tr><td>Optimized</td></tr></table>',
          path: 'tables/table-001.html',
          metadata: {
            length: 1,
            summary: 'Optimized table chunk',
            page_nums: [3],
            file_path: 'tables/table-001.html',
            keywords: ['optimized'],
            tokens: [],
          },
        },
      ],
    }),
  );

  zip.file(
    'chunks_slim.json',
    JSON.stringify({
      chunks: [
        {
          type: 'text',
          path: 'Default_Root/optimized.pdf-->Section 1',
          content: 'Text chunk with embedded resources.',
          summary: '',
        },
      ],
    }),
  );
  zip.file('full.md', '# Optimized Result\n\nBody');
  zip.file('hierarchy.json', JSON.stringify({ Default_Root: { 'optimized.pdf': {} } }));
  zip.file('toc_hierarchies.json', JSON.stringify([{ toc_range: [1, 3], scan_range: [1, 10] }]));
  zip.file('kb.csv', 'chunk_id,type\nchunk-text-001,text\n');
  zip.file('hierarchy_view.html', '<html><body>Optimized hierarchy view</body></html>');
  zip.file('images/image-001.jpg', Buffer.from('fake-jpg-data'));
  zip.file('tables/table-001.html', '<table><tr><td>Optimized</td></tr></table>');

  return await zip.generateAsync({ type: 'nodebuffer' });
}

// Test helper: Create malicious ZIP with path traversal
async function createMaliciousZip(): Promise<Buffer> {
  const zip = new JSZip();

  const manifest = {
    version: '1.0',
    job_id: 'job-malicious',
    statistics: { total_chunks: 1 },
  };

  zip.file('manifest.json', JSON.stringify(manifest));

  const chunks = [
    {
      chunk_id: 'chunk-001',
      type: 'image',
      file_path: '../../../etc/passwd', // Path traversal attempt
    },
  ];

  zip.file('chunks.json', JSON.stringify(chunks));
  // Store the file with a safe name, not the malicious one
  // This simulates a scenario where chunks.json has a malicious path
  // but the actual file in ZIP is stored safely
  zip.file('etc/passwd', 'safe content');

  return await zip.generateAsync({ type: 'nodebuffer' });
}

// Test helper: Create ZIP without manifest
async function createZipWithoutManifest(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('chunks.json', JSON.stringify([]));
  return await zip.generateAsync({ type: 'nodebuffer' });
}

describe('Result Parser', () => {
  let mockHttpClient: any;
  const testOutputDir = join(__dirname, '../../../test-output');

  beforeEach(() => {
    mockHttpClient = {
      download: vi.fn(),
    };

    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up test output
    try {
      await fs.rm(testOutputDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('parseResult', () => {
    it('should parse valid ZIP archive', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result).toBeDefined();
      expect(result.manifest).toBeDefined();
      expect(result.chunks).toBeInstanceOf(Array);
      expect(result.textChunks.length).toBeGreaterThan(0);
    });

    it('should extract manifest.json', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.manifest.jobId).toBe('job-test-123');
      expect(result.manifest.version).toBe('1.0');
      expect(result.manifest.statistics).toBeDefined();
      expect(result.manifest.statistics.totalChunks).toBe(3);
    });

    it('should extract chunks.json', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].chunkId).toBe('chunk-001');
      expect(result.chunks[0].type).toBe('text');
      expect(result.chunks[0].content).toBeDefined();
    });

    it('should extract wrapped chunks.json payloads', async () => {
      const mockZipBuffer = await createMockResultZip({
        wrapChunks: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].chunkId).toBe('chunk-001');
    });

    it('should extract chunk file paths from nested metadata', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
        includeTables: true,
        useMetadata: true,
        wrapChunks: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.imageChunks[0].filePath).toBe('images/image-001.jpg');
      expect(result.tableChunks[0].filePath).toBe('tables/table-001.html');
    });

    it('should extract image chunks with data', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.imageChunks.length).toBeGreaterThan(0);
      expect(result.imageChunks[0].data).toBeInstanceOf(Buffer);
      expect(result.imageChunks[0].filePath).toBe('images/image-001.jpg');
    });

    it('should extract table chunks with HTML', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeTables: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.tableChunks.length).toBeGreaterThan(0);
      expect(result.tableChunks[0].html).toBeDefined();
      expect(result.tableChunks[0].html).toContain('<table>');
    });

    it('should expose page chunks and content source metadata', async () => {
      const zip = new JSZip();
      zip.file(
        'manifest.json',
        JSON.stringify({
          job_id: 'job-page-123',
          source_file_name: 'manual.pdf',
          statistics: {
            total_chunks: 1,
            text_chunks: 0,
            image_chunks: 0,
            table_chunks: 0,
            page_chunks: 1,
          },
        }),
      );
      zip.file(
        'chunks.json',
        JSON.stringify({
          chunks: [
            {
              chunk_id: 'page-4-6',
              type: 'page',
              content_source: 'summary',
              content: 'Summary for pages 4 through 6.',
              path: 'manual.pdf/Chapter 1',
              metadata: {
                summary: 'Summary for pages 4 through 6.',
                page_nums: [4, 5, 6],
                entities: [{ text: 'Knowhere', type: 'product' }],
                page_assets: [
                  {
                    page_num: 4,
                    artifact_ref: 'page_citation_assets/page-4.png',
                    asset_url: 'https://assets.example/page-4.png',
                    content_type: 'image/png',
                    width: 1200,
                    height: 1800,
                    source: 'knowhere-rendered-page-citation-source',
                  },
                ],
              },
            },
          ],
        }),
      );
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.statistics.pageChunks).toBe(1);
      expect(result.pageChunks).toHaveLength(1);
      expect(result.pageChunks[0].type).toBe('page');
      expect(result.pageChunks[0].contentSource).toBe('summary');
      expect(result.pageChunks[0].metadata.pageNums).toEqual([4, 5, 6]);
      expect(result.pageChunks[0].metadata.pageAssets).toEqual([
        {
          pageNum: 4,
          artifactRef: 'page_citation_assets/page-4.png',
          assetUrl: 'https://assets.example/page-4.png',
          contentType: 'image/png',
          width: 1200,
          height: 1800,
          source: 'knowhere-rendered-page-citation-source',
        },
      ]);
      expect(result.pageChunks[0]).not.toHaveProperty('pageAssets');
      expect(result.textChunks).toHaveLength(0);
    });

    it('should ignore unsupported top-level page assets on page chunks', async () => {
      const zip = new JSZip();
      zip.file(
        'manifest.json',
        JSON.stringify({
          job_id: 'job-page-123',
          source_file_name: 'manual.pdf',
          statistics: {
            total_chunks: 1,
            text_chunks: 0,
            image_chunks: 0,
            table_chunks: 0,
            page_chunks: 1,
          },
        }),
      );
      zip.file(
        'chunks.json',
        JSON.stringify({
          chunks: [
            {
              chunk_id: 'page-4',
              type: 'page',
              content: 'Summary for page 4.',
              path: 'manual.pdf/Page 4',
              metadata: {
                summary: 'Summary for page 4.',
                page_nums: [4],
              },
              page_assets: [
                {
                  page_num: 4,
                  artifact_ref: 'page_citation_assets/page-4.png',
                  asset_url: 'https://assets.example/page-4.png',
                  content_type: 'image/png',
                  width: 1200,
                  height: 1800,
                  source: 'knowhere-rendered-page-citation-source',
                },
              ],
            },
          ],
        }),
      );
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.pageChunks[0]).not.toHaveProperty('pageAssets');
      expect(result.pageChunks[0].metadata).toEqual({
        summary: 'Summary for page 4.',
        pageNums: [4],
      });
    });

    it('should extract full markdown if present', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeFullMarkdown: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.fullMarkdown).toBeDefined();
      expect(typeof result.fullMarkdown).toBe('string');
      expect(result.fullMarkdown).toContain('# Test Document');
    });

    it('should extract hierarchy if present', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeHierarchy: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.hierarchy).toBeDefined();
      expect(result.hierarchy).toHaveProperty('type', 'document');
    });

    it('should sanitize file paths to prevent Zip Slip', async () => {
      const maliciousZip = await createMaliciousZip();
      mockHttpClient.download.mockResolvedValue(maliciousZip);

      // The parser should sanitize the malicious path '../../../etc/passwd' to 'etc/passwd'
      // Since the ZIP has a file at 'etc/passwd', it should find it successfully
      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result).toBeDefined();
      expect(result.imageChunks.length).toBe(1);
      // The original filePath from chunks.json is preserved
      expect(result.imageChunks[0].filePath).toBe('../../../etc/passwd');
      // But the data was loaded from the sanitized path 'etc/passwd'
      expect(result.imageChunks[0].data).toBeDefined();
      expect(result.imageChunks[0].data.toString()).toBe('safe content');
    });

    it('should handle missing manifest gracefully', async () => {
      const invalidZip = await createZipWithoutManifest();
      mockHttpClient.download.mockResolvedValue(invalidZip);

      await expect(
        parseResult(mockHttpClient, 'https://s3.example.com/result.zip'),
      ).rejects.toThrow(KnowhereError);

      await expect(
        parseResult(mockHttpClient, 'https://s3.example.com/result.zip'),
      ).rejects.toThrow('manifest.json not found in ZIP');
    });

    it('should handle corrupted ZIP', async () => {
      const corruptedZip = Buffer.from('not a zip file');
      mockHttpClient.download.mockResolvedValue(corruptedZip);

      await expect(
        parseResult(mockHttpClient, 'https://s3.example.com/result.zip'),
      ).rejects.toThrow();
    });

    it('should handle missing image file in ZIP', async () => {
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify({ jobId: 'test', statistics: {} }));
      zip.file(
        'chunks.json',
        JSON.stringify([
          {
            chunkId: 'chunk-001',
            type: 'image',
            filePath: 'images/missing.jpg',
          },
        ]),
      );
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      await expect(
        parseResult(mockHttpClient, 'https://s3.example.com/result.zip'),
      ).rejects.toThrow(KnowhereError);

      await expect(
        parseResult(mockHttpClient, 'https://s3.example.com/result.zip'),
      ).rejects.toThrow('Image file not found');
    });

    it('should handle missing table file in ZIP', async () => {
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify({ jobId: 'test', statistics: {} }));
      zip.file(
        'chunks.json',
        JSON.stringify([
          {
            chunkId: 'chunk-001',
            type: 'table',
            filePath: 'tables/missing.html',
          },
        ]),
      );
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      await expect(
        parseResult(mockHttpClient, 'https://s3.example.com/result.zip'),
      ).rejects.toThrow(KnowhereError);

      await expect(
        parseResult(mockHttpClient, 'https://s3.example.com/result.zip'),
      ).rejects.toThrow('Table file not found');
    });

    it('should include rawZip in result', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.rawZip).toBeInstanceOf(Buffer);
      expect(result.rawZip.length).toBe(mockZipBuffer.length);
    });

    it('should convert snake_case keys to camelCase', async () => {
      const zip = new JSZip();
      zip.file(
        'manifest.json',
        JSON.stringify({
          job_id: 'test-123',
          source_file_name: 'test.pdf',
          processing_date: '2024-01-15T10:00:00Z',
          statistics: {
            total_chunks: 1,
          },
        }),
      );
      zip.file(
        'chunks.json',
        JSON.stringify([
          {
            chunk_id: 'chunk-001',
            type: 'text',
            content: 'test',
          },
        ]),
      );
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.manifest.jobId).toBe('test-123');
      expect(result.manifest.sourceFileName).toBe('test.pdf');
      expect(result.chunks[0].chunkId).toBe('chunk-001');
    });

    it('should parse date fields', async () => {
      const zip = new JSZip();
      zip.file(
        'manifest.json',
        JSON.stringify({
          jobId: 'test-123',
          processingDate: '2024-01-15T10:00:00Z',
          statistics: {},
        }),
      );
      zip.file('chunks.json', JSON.stringify([]));
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.manifest.processingDate).toBeInstanceOf(Date);
    });

    it('should expose optimized payload metadata and sidecar assets from the current worker ZIP', async () => {
      const optimizedZipBuffer = await createOptimizedResultZip();
      mockHttpClient.download.mockResolvedValue(optimizedZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.manifest.version).toBe('2.0');
      expect(result.manifest.processing?.pageCount).toBe(12);
      expect(result.manifest.processing?.timing?.startedAt).toBeInstanceOf(Date);
      expect(result.chunksSlim).toBeDefined();
      expect(result.chunksSlim!.length).toBe(1);
      expect(result.chunksSlim![0].type).toBe('text');
      expect(result.chunksSlim![0].content).toBe('Text chunk with embedded resources.');
      expect(result.kbCsv).toContain('chunk_id,type');
      expect(result.tocHierarchies).toEqual([{ tocRange: [1, 3], scanRange: [1, 10] }]);
      expect(result.hierarchyViewHtml).toContain('Optimized hierarchy view');
    });
  });

  describe('ParseResult methods', () => {
    it('should get chunk by ID', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      const chunk = result.getChunk('chunk-001');
      expect(chunk).toBeDefined();
      expect(chunk?.chunkId).toBe('chunk-001');
    });

    it('should return undefined for non-existent chunk', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      const chunk = result.getChunk('non-existent');
      expect(chunk).toBeUndefined();
    });

    it('should save all results to directory', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
        includeTables: true,
        includeFullMarkdown: true,
        includeHierarchy: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      const savedPath = await result.save(testOutputDir);

      expect(savedPath).toBe(testOutputDir);

      // Verify files were created
      const manifestExists = await fs
        .access(join(testOutputDir, 'manifest.json'))
        .then(() => true)
        .catch(() => false);
      expect(manifestExists).toBe(true);

      const chunksExists = await fs
        .access(join(testOutputDir, 'chunks.json'))
        .then(() => true)
        .catch(() => false);
      expect(chunksExists).toBe(true);

      const fullMdExists = await fs
        .access(join(testOutputDir, 'full.md'))
        .then(() => true)
        .catch(() => false);
      expect(fullMdExists).toBe(true);

      const hierarchyExists = await fs
        .access(join(testOutputDir, 'hierarchy.json'))
        .then(() => true)
        .catch(() => false);
      expect(hierarchyExists).toBe(true);

      const imageExists = await fs
        .access(join(testOutputDir, 'images/image-001.jpg'))
        .then(() => true)
        .catch(() => false);
      expect(imageExists).toBe(true);

      const tableExists = await fs
        .access(join(testOutputDir, 'tables/table-001.html'))
        .then(() => true)
        .catch(() => false);
      expect(tableExists).toBe(true);
    });

    it('should save optimized sidecar result files when present', async () => {
      const optimizedZipBuffer = await createOptimizedResultZip();
      mockHttpClient.download.mockResolvedValue(optimizedZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      await result.save(testOutputDir);

      const chunksSlimExists = await fs
        .access(join(testOutputDir, 'chunks_slim.json'))
        .then(() => true)
        .catch(() => false);
      expect(chunksSlimExists).toBe(true);

      const kbCsvExists = await fs
        .access(join(testOutputDir, 'kb.csv'))
        .then(() => true)
        .catch(() => false);
      expect(kbCsvExists).toBe(true);

      const tocHierarchiesExists = await fs
        .access(join(testOutputDir, 'toc_hierarchies.json'))
        .then(() => true)
        .catch(() => false);
      expect(tocHierarchiesExists).toBe(true);

      const hierarchyViewExists = await fs
        .access(join(testOutputDir, 'hierarchy_view.html'))
        .then(() => true)
        .catch(() => false);
      expect(hierarchyViewExists).toBe(true);
    });

    it('should save expanded result files without storing a raw ZIP', async () => {
      const optimizedZipBuffer = await createOptimizedResultZip();
      mockHttpClient.download.mockResolvedValue(optimizedZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      await saveExpandedParseResult(result, testOutputDir);

      const resultZipExists = await fs
        .access(join(testOutputDir, 'result.zip'))
        .then(() => true)
        .catch(() => false);
      const tableHtml = await fs.readFile(join(testOutputDir, 'tables/table-001.html'), 'utf8');
      const reloaded = await parseResultDirectory(testOutputDir);

      expect(resultZipExists).toBe(false);
      expect(tableHtml).toContain('Optimized');
      expect(reloaded.manifest.sourceFileName).toBe('optimized.pdf');
      expect(reloaded.chunks).toHaveLength(3);
      expect(reloaded.tableChunks[0].html).toContain('Optimized');
      expect(reloaded.rawZip.length).toBe(0);
    });

    it('should preserve server-provided page citation asset files when saving expanded results', async () => {
      const zip = new JSZip();
      zip.file(
        'manifest.json',
        JSON.stringify({
          job_id: 'job-page-assets',
          source_file_name: 'manual.pdf',
          statistics: {
            total_chunks: 1,
            text_chunks: 0,
            image_chunks: 0,
            table_chunks: 0,
            page_chunks: 1,
          },
        }),
      );
      zip.file(
        'chunks.json',
        JSON.stringify({
          chunks: [
            {
              chunk_id: 'page-1',
              type: 'page',
              content: 'Page one summary.',
              path: 'manual.pdf/Page 1',
              metadata: {
                page_nums: [1],
                page_assets: [
                  {
                    page_num: 1,
                    artifact_ref: 'page_citation_assets/page-1.png',
                    content_type: 'image/png',
                    width: 120,
                    height: 240,
                    source: 'knowhere-rendered-page-citation-source',
                  },
                ],
              },
            },
          ],
        }),
      );
      zip.file('page_citation_assets/page-1.png', Buffer.from('server-page-png'));
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      await saveExpandedParseResult(result, testOutputDir);

      const savedPageAsset = await fs.readFile(
        join(testOutputDir, 'page_citation_assets/page-1.png'),
      );
      const savedChunks = JSON.parse(
        await fs.readFile(join(testOutputDir, 'chunks.json'), 'utf8'),
      ) as {
        chunks: [
          {
            metadata: {
              page_assets: Array<Record<string, unknown>>;
            };
          },
        ];
      };

      expect(savedPageAsset.toString()).toBe('server-page-png');
      expect(savedChunks.chunks[0].metadata.page_assets).toEqual([
        expect.objectContaining({
          artifact_ref: 'page_citation_assets/page-1.png',
        }),
      ]);
      expect(savedChunks.chunks[0]).not.toHaveProperty('page_assets');
    });

    it('should save rewritten page citation asset metadata after raw ZIP extraction', async () => {
      const zip = new JSZip();
      zip.file(
        'manifest.json',
        JSON.stringify({
          job_id: 'job-page-assets',
          source_file_name: 'manual.pdf',
          statistics: {
            total_chunks: 1,
            text_chunks: 0,
            image_chunks: 0,
            table_chunks: 0,
            page_chunks: 1,
          },
        }),
      );
      zip.file(
        'chunks.json',
        JSON.stringify({
          chunks: [
            {
              chunk_id: 'page-1',
              type: 'page',
              content: 'Page one summary.',
              path: 'manual.pdf/Page 1',
              metadata: {
                page_assets: [
                  {
                    page_num: 1,
                    artifact_ref: 'page_citation_assets/page-1.png',
                    content_type: 'image/png',
                    source: 'knowhere-rendered-page-citation-source',
                  },
                ],
              },
            },
          ],
        }),
      );
      zip.file('page_citation_assets/page-1.png', Buffer.from('server-page-png'));
      mockHttpClient.download.mockResolvedValue(await zip.generateAsync({ type: 'nodebuffer' }));
      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');
      const pageAssets = result.pageChunks[0]?.metadata.pageAssets;
      const firstPageAsset: unknown = Array.isArray(pageAssets) ? pageAssets[0] : undefined;
      if (
        Array.isArray(pageAssets) &&
        typeof firstPageAsset === 'object' &&
        firstPageAsset !== null
      ) {
        pageAssets[0] = {
          ...firstPageAsset,
          assetUrl: 'https://blob.example/page_citation_assets/page-1.png',
        };
      }

      await saveExpandedParseResult(result, testOutputDir);

      const savedChunks = JSON.parse(
        await fs.readFile(join(testOutputDir, 'chunks.json'), 'utf8'),
      ) as {
        chunks: [
          {
            metadata: {
              page_assets: Array<Record<string, unknown>>;
            };
          },
        ];
      };

      expect(savedChunks.chunks[0].metadata.page_assets).toEqual([
        expect.objectContaining({
          asset_url: 'https://blob.example/page_citation_assets/page-1.png',
        }),
      ]);
    });

    it('should expose jobId property', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.jobId).toBe('job-test-123');
    });

    it('should expose statistics property', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.statistics).toBeDefined();
      expect(result.statistics.totalChunks).toBe(3);
      expect(result.statistics.totalPages).toBe(10);
    });

    it('should filter textChunks correctly', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
        includeTables: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.textChunks.length).toBe(1);
      expect(result.textChunks[0].type).toBe('text');
    });

    it('should filter imageChunks correctly', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
        includeTables: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.imageChunks.length).toBe(1);
      expect(result.imageChunks[0].type).toBe('image');
    });

    it('should filter tableChunks correctly', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
        includeTables: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.tableChunks.length).toBe(1);
      expect(result.tableChunks[0].type).toBe('table');
    });
  });

  describe('ImageChunk methods', () => {
    it('should save image to file', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      const imagePath = await result.imageChunks[0].save(testOutputDir);

      expect(imagePath).toBe(join(testOutputDir, 'images/image-001.jpg'));

      const imageExists = await fs
        .access(imagePath)
        .then(() => true)
        .catch(() => false);
      expect(imageExists).toBe(true);
    });

    it('should detect image format from file extension', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.imageChunks[0].format).toBe('jpg');
    });
  });

  describe('TableChunk methods', () => {
    it('should save HTML table to file', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeTables: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      const tablePath = await result.tableChunks[0].save(testOutputDir);

      expect(tablePath).toBe(join(testOutputDir, 'tables/table-001.html'));

      const tableExists = await fs
        .access(tablePath)
        .then(() => true)
        .catch(() => false);
      expect(tableExists).toBe(true);

      const content = await fs.readFile(tablePath, 'utf-8');
      expect(content).toContain('<table>');
    });
  });

  describe('Current worker contract (doc_nav, HIERARCHY)', () => {
    async function createCurrentContractZip(): Promise<Buffer> {
      const zip = new JSZip();

      zip.file(
        'manifest.json',
        JSON.stringify({
          version: '2.0',
          job_id: 'job-current-123',
          source_file_name: 'current.pdf',
          processing_date: '2026-05-01T00:00:00Z',
          HIERARCHY: {
            Default_Root: {
              'current.pdf': {
                sections: ['Introduction', 'Methods'],
              },
            },
          },
          statistics: {
            total_chunks: 2,
            text_chunks: 1,
            image_chunks: 1,
            table_chunks: 0,
            total_pages: null,
          },
        }),
      );

      zip.file(
        'chunks.json',
        JSON.stringify({
          chunks: [
            {
              chunk_id: 'text-with-dts',
              type: 'text',
              content: 'Section overview.',
              path: 'Default_Root/current.pdf-->Introduction',
              metadata: {
                length: 15,
                summary: 'Intro text',
                page_nums: [1],
                tokens: ['overview'],
                keywords: [],
              },
            },
            {
              chunk_id: 'image-with-dts',
              type: 'image',
              content: '[images/diagram.png]',
              path: 'images/diagram.png',
              metadata: {
                length: 1,
                summary: 'Architecture diagram',
                page_nums: [2],
                file_path: 'images/diagram.png',
              },
            },
          ],
        }),
      );

      zip.file(
        'doc_nav.json',
        JSON.stringify({
          sections: [
            {
              title: 'Introduction',
              path: 'Default_Root/current.pdf-->Introduction',
              level: 1,
              summary: 'Overview of the topic',
              chunk_count: 2,
              children: [
                {
                  title: 'Background',
                  path: 'Default_Root/current.pdf-->Introduction-->Background',
                  level: 2,
                  summary: 'Historical context',
                  chunk_count: 1,
                  children: [],
                },
              ],
            },
          ],
          resources: {
            images: [{ path: 'images/diagram.png', summary: 'Architecture overview' }],
            tables: [],
          },
        }),
      );

      zip.file('images/diagram.png', Buffer.from('fake-png-data'));
      zip.file('full.md', '# Current Result\n\nBody');

      return await zip.generateAsync({ type: 'nodebuffer' });
    }

    it('should parse doc_nav.json', async () => {
      const zipBuffer = await createCurrentContractZip();
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.docNav).toBeDefined();
      expect(result.docNav?.sections).toHaveLength(1);
      expect(result.docNav?.sections[0].title).toBe('Introduction');
      expect(result.docNav?.sections[0].level).toBe(1);
      expect(result.docNav?.sections[0].chunkCount).toBe(2);
      expect(result.docNav?.sections[0].children).toHaveLength(1);
      expect(result.docNav?.sections[0].children[0].title).toBe('Background');
      expect(result.docNav?.resources?.images).toHaveLength(1);
      expect(result.docNav?.resources?.images[0].path).toBe('images/diagram.png');
    });

    it('should leave docNav undefined when doc_nav.json is missing', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.docNav).toBeUndefined();
    });

    it('should write doc_nav.json in save()', async () => {
      const zipBuffer = await createCurrentContractZip();
      mockHttpClient.download.mockResolvedValue(zipBuffer);
      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      await result.save(testOutputDir);

      const docNavExists = await fs
        .access(join(testOutputDir, 'doc_nav.json'))
        .then(() => true)
        .catch(() => false);
      expect(docNavExists).toBe(true);
    });

    it('should expose manifest HIERARCHY field', async () => {
      const zipBuffer = await createCurrentContractZip();
      mockHttpClient.download.mockResolvedValue(zipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.manifest.HIERARCHY).toBeDefined();
      expect(result.manifest.HIERARCHY?.Default_Root).toBeDefined();
    });

    it('should parse successfully without chunks_slim.json', async () => {
      const mockZipBuffer = await createMockResultZip({
        includeImages: true,
        includeTables: true,
        useMetadata: true,
        wrapChunks: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.chunksSlim).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should expose raw metadata on chunks', async () => {
      const mockZipBuffer = await createMockResultZip({
        useMetadata: true,
        wrapChunks: true,
      });
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.textChunks[0].metadata).toBeDefined();
      expect(result.textChunks[0].metadata.length).toBe(250);
      expect(result.textChunks[0].metadata.tokens).toEqual(['token-a', 'token-b']);
    });

    it('should parse successfully without hierarchy.json', async () => {
      const mockZipBuffer = await createMockResultZip();
      mockHttpClient.download.mockResolvedValue(mockZipBuffer);

      const result = await parseResult(mockHttpClient, 'https://s3.example.com/result.zip');

      expect(result.hierarchy).toBeUndefined();
      expect(result.manifest).toBeDefined();
    });
  });

  describe('verifyChecksum', () => {
    it('should verify valid checksum', () => {
      const data = Buffer.from('test data');
      const hash = createHash('sha256').update(data).digest('hex');

      expect(() => verifyChecksum(data, hash)).not.toThrow();
    });

    it('should throw error on checksum mismatch', () => {
      const data = Buffer.from('test data');
      const invalidHash = 'invalid-checksum-hash';

      expect(() => verifyChecksum(data, invalidHash)).toThrow(ChecksumError);
      expect(() => verifyChecksum(data, invalidHash)).toThrow('Checksum verification failed');
    });

    it('should include expected and actual checksums in error', () => {
      const data = Buffer.from('test data');
      const expectedHash = 'expected-hash';
      const actualHash = createHash('sha256').update(data).digest('hex');

      try {
        verifyChecksum(data, expectedHash);
        expect.fail('Should have thrown ChecksumError');
      } catch (error) {
        expect(error).toBeInstanceOf(ChecksumError);
        if (error instanceof ChecksumError) {
          expect(error.expected).toBe(expectedHash);
          expect(error.actual).toBe(actualHash);
        }
      }
    });
  });
});
