/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Knowhere } from '../client.js';
import { KnowhereError } from '../errors/base.js';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import type { ParseResult, TextChunk } from '../types/result.js';

describe('Knowhere Client', () => {
  // Store original env
  const originalEnv = process.env.KNOWHERE_API_KEY;

  beforeEach(() => {
    // Clean up env before each test
    delete process.env.KNOWHERE_API_KEY;
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv) {
      process.env.KNOWHERE_API_KEY = originalEnv;
    } else {
      delete process.env.KNOWHERE_API_KEY;
    }
  });

  describe('constructor', () => {
    it('should initialize with explicit API key', () => {
      const client = new Knowhere({ apiKey: 'sk_test_123' });
      expect(client).toBeDefined();
      expect(client.jobs).toBeDefined();
    });

    it('should initialize with environment variable API key', () => {
      process.env.KNOWHERE_API_KEY = 'sk_env_456';
      const client = new Knowhere();
      expect(client).toBeDefined();
      expect(client.jobs).toBeDefined();
    });

    it('should throw error when API key is missing', () => {
      delete process.env.KNOWHERE_API_KEY;
      expect(() => new Knowhere()).toThrow(KnowhereError);
      expect(() => new Knowhere()).toThrow('API key is required');
    });

    it('should use default base URL when not provided', () => {
      const client = new Knowhere({ apiKey: 'sk_test' });
      expect(client).toBeDefined();
    });

    it('should use custom base URL when provided', () => {
      const client = new Knowhere({
        apiKey: 'sk_test',
        baseURL: 'https://custom.api.com',
      });
      expect(client).toBeDefined();
    });

    it('should apply timeout configuration', () => {
      const client = new Knowhere({
        apiKey: 'sk_test',
        timeout: 30000,
        uploadTimeout: 300000,
      });
      expect(client).toBeDefined();
    });

    it('should apply max retries configuration', () => {
      const client = new Knowhere({
        apiKey: 'sk_test',
        maxRetries: 3,
      });
      expect(client).toBeDefined();
    });

    it('should apply custom headers', () => {
      const client = new Knowhere({
        apiKey: 'sk_test',
        defaultHeaders: {
          'X-Custom-Header': 'value',
        },
      });
      expect(client).toBeDefined();
    });

    it('should apply custom HTTP agents', () => {
      const httpAgent = new HttpAgent();
      const httpsAgent = new HttpsAgent();
      const client = new Knowhere({
        apiKey: 'sk_test',
        httpAgent,
        httpsAgent,
      });
      expect(client).toBeDefined();
    });
  });

  describe('parse', () => {
    let client: Knowhere;

    beforeEach(() => {
      client = new Knowhere({ apiKey: 'sk_test' });

      // Mock the jobs methods
      vi.spyOn(client.jobs, 'create').mockResolvedValue({
        jobId: 'job-123',
        status: 'pending',
        sourceType: 'url',
        createdAt: new Date('2024-01-15T10:00:00Z'),
      });

      vi.spyOn(client.jobs, 'upload').mockResolvedValue(undefined);

      vi.spyOn(client.jobs, 'wait').mockResolvedValue({
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        resultUrl: 'https://s3.amazonaws.com/result.zip',
        isTerminal: true,
        isDone: true,
        isFailed: false,
      });

      const textChunk: TextChunk = {
        chunkId: 'chunk-001',
        type: 'text',
        content: 'Sample content',
        path: 'page-1',
        length: 100,
        tokens: 20,
      };

      const mockParseResult: ParseResult = {
        jobId: 'job-123',
        manifest: {
          version: '1.0',
          jobId: 'job-123',
          sourceFileName: 'test.pdf',
          processingDate: new Date('2024-01-15T10:00:00Z'),
          statistics: {
            totalChunks: 5,
            textChunks: 3,
            imageChunks: 1,
            tableChunks: 1,
            totalPages: 3,
          },
          files: {
            manifest: 'manifest.json',
            chunks: 'chunks.json',
          },
        },
        chunks: [textChunk],
        textChunks: [textChunk],
        imageChunks: [],
        tableChunks: [],
        statistics: {
          totalChunks: 1,
          textChunks: 1,
          imageChunks: 0,
          tableChunks: 0,
        },
        rawZip: Buffer.from(''),
        getChunk: vi.fn(),
        save: vi.fn(),
      };

      vi.spyOn(client.jobs, 'load').mockResolvedValue(mockParseResult);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should parse document from URL', async () => {
      const result = await client.parse({
        url: 'https://example.com/doc.pdf',
      });

      expect(result).toBeDefined();
      expect(result.chunks).toBeInstanceOf(Array);
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(client.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'url',
          sourceUrl: 'https://example.com/doc.pdf',
        }),
      );
    });

    it('should parse document from file path', async () => {
      const result = await client.parse({
        file: './test.pdf',
      });

      expect(result).toBeDefined();
      expect(client.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'file',
        }),
      );
      expect(client.jobs.upload).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({
          file: './test.pdf',
        }),
      );
    });

    it('should parse document from Buffer', async () => {
      const buffer = Buffer.from('mock pdf content');
      const result = await client.parse({
        file: buffer,
        fileName: 'test.pdf',
      });

      expect(result).toBeDefined();
      expect(client.jobs.upload).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({
          file: buffer,
        }),
      );
    });

    it('should throw error if both url and file are missing', async () => {
      await expect(client.parse({})).rejects.toThrow(KnowhereError);
      await expect(client.parse({})).rejects.toThrow('Either url or file must be provided');
    });

    it('should throw error if both url and file are provided', async () => {
      await expect(
        client.parse({
          url: 'https://example.com/doc.pdf',
          file: './test.pdf',
        }),
      ).rejects.toThrow(KnowhereError);
      await expect(
        client.parse({
          url: 'https://example.com/doc.pdf',
          file: './test.pdf',
        }),
      ).rejects.toThrow('Only one of url or file can be provided');
    });

    it('should pass parsing parameters correctly', async () => {
      await client.parse({
        url: 'https://example.com/doc.pdf',
        model: 'advanced',
        ocr: true,
        docType: 'pdf',
        smartTitleParse: true,
        summaryImage: true,
        summaryTable: true,
        summaryText: true,
      });

      expect(client.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          parsingParams: {
            model: 'advanced',
            ocrEnabled: true,
            docType: 'pdf',
            smartTitleParse: true,
            summaryImage: true,
            summaryTable: true,
            summaryTxt: true,
          },
        }),
      );
    });

    it('should handle upload progress callback', async () => {
      const progressUpdates: number[] = [];

      await client.parse({
        file: './test.pdf',
        onUploadProgress: ({ percent }) => {
          progressUpdates.push(percent);
        },
      });

      expect(client.jobs.upload).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({
          onProgress: expect.any(Function),
        }),
      );
    });

    it('should handle poll progress callback', async () => {
      await client.parse({
        url: 'https://example.com/doc.pdf',
        onPollProgress: ({ status: _status }) => {
          // Progress callback
        },
      });

      expect(client.jobs.wait).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({
          onProgress: expect.any(Function),
        }),
      );
    });

    it('should pass poll interval and timeout', async () => {
      await client.parse({
        url: 'https://example.com/doc.pdf',
        pollInterval: 5000,
        pollTimeout: 120000,
      });

      expect(client.jobs.wait).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({
          pollInterval: 5000,
          pollTimeout: 120000,
        }),
      );
    });

    it('should support AbortSignal for cancellation', async () => {
      const controller = new AbortController();

      // Mock jobs.wait to check for abort signal
      vi.spyOn(client.jobs, 'wait').mockImplementation(async (_jobId, options) => {
        // Check if signal is already aborted
        if (options?.signal?.aborted) {
          throw new Error('Aborted');
        }

        // Listen for abort event
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('Aborted'));
          });
        });
      });

      const promise = client.parse({
        url: 'https://example.com/doc.pdf',
        signal: controller.signal,
      });

      // Abort immediately
      controller.abort();

      await expect(promise).rejects.toThrow();
    });

    it('should handle webhook configuration', async () => {
      await client.parse({
        url: 'https://example.com/doc.pdf',
        webhookUrl: 'https://myapp.com/webhook',
      });

      expect(client.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          webhook: {
            url: 'https://myapp.com/webhook',
          },
        }),
      );
    });

    it('should handle dataId parameter', async () => {
      await client.parse({
        url: 'https://example.com/doc.pdf',
        dataId: 'custom-id-123',
      });

      expect(client.jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          dataId: 'custom-id-123',
        }),
      );
    });
  });
});
