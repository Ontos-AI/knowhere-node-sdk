/* eslint-disable @typescript-eslint/no-explicit-any */
 
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { promises as fs } from 'fs';
import { join } from 'path';
import { parseResult, verifyChecksum } from '../result-parser.js';
import { ChecksumError, KnowhereError } from '../../errors/index.js';
import type { HttpClient } from '../http-client.js';
import type { Manifest, Chunk } from '../../types/result.js';
import { createHash } from 'crypto';

// Test helper: Create mock result ZIP
async function createMockResultZip(
  options: {
    includeImages?: boolean;
    includeTables?: boolean;
    includeFullMarkdown?: boolean;
    includeHierarchy?: boolean;
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
  const chunks: Partial<Chunk>[] = [
    {
      chunkId: 'chunk-001',
      type: 'text',
      content: 'This is sample text content for testing.',
      path: 'page-1',
      length: 250,
      tokens: 45,
      keywords: ['test', 'sample'],
      summary: 'Sample text chunk',
    },
  ];

  if (options.includeImages) {
    chunks.push({
      chunkId: 'chunk-002',
      type: 'image',
      content: 'Image description',
      path: 'page-2',
      length: 1,
      filePath: 'images/image-001.jpg',
      summary: 'Test image',
    });
    // Add actual image file
    zip.file('images/image-001.jpg', Buffer.from('fake-jpg-data'));
  }

  if (options.includeTables) {
    chunks.push({
      chunkId: 'chunk-003',
      type: 'table',
      content: 'Table content as text',
      path: 'page-3',
      length: 1,
      filePath: 'tables/table-001.html',
      tableType: 'data',
      summary: 'Test table',
    });
    // Add actual table file
    zip.file('tables/table-001.html', '<table><tr><td>Test Data</td></tr></table>');
  }

  zip.file('chunks.json', JSON.stringify(chunks));

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
    } as unknown as HttpClient;

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
