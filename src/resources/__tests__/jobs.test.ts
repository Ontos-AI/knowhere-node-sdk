/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Jobs } from '../jobs.js';
import { NotFoundError } from '../../errors/index.js';
import type { HttpClient } from '../../lib/http-client.js';

// Mock the dependencies
vi.mock('../../lib/upload.js', () => ({
  uploadFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/polling.js', () => ({
  pollJobStatus: vi.fn(),
}));

vi.mock('../../lib/result-parser.js', () => ({
  parseResult: vi.fn(),
}));

vi.mock('../../lib/utils.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/utils.js')>('../../lib/utils.js');
  return {
    ...actual,
    enrichJobResult: vi.fn((jobResult: any) => {
      jobResult.isTerminal = ['done', 'failed'].includes(jobResult.status);
      jobResult.isDone = jobResult.status === 'done';
      jobResult.isFailed = jobResult.status === 'failed';
    }),
  };
});

import { uploadFile } from '../../lib/upload.js';
import { pollJobStatus } from '../../lib/polling.js';
import { parseResult } from '../../lib/result-parser.js';
import { enrichJobResult } from '../../lib/utils.js';

describe('Jobs Resource', () => {
  let jobs: Jobs;
  let mockHttpClient: any;

  beforeEach(() => {
    mockHttpClient = {
      post: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    jobs = new Jobs(mockHttpClient as HttpClient);

    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create job with URL source', async () => {
      const mockResponse = {
        jobId: 'job-123',
        status: 'pending',
        sourceType: 'url',
        createdAt: new Date('2024-01-15T10:00:00Z'),
      };

      mockHttpClient.post.mockResolvedValue(mockResponse);

      const result = await jobs.create({
        sourceType: 'url',
        sourceUrl: 'https://example.com/doc.pdf',
      });

      expect(result.jobId).toBe('job-123');
      expect(result.status).toBe('pending');
      expect(mockHttpClient.post).toHaveBeenCalledWith('/v1/jobs', {
        sourceType: 'url',
        sourceUrl: 'https://example.com/doc.pdf',
      });
    });

    it('should create job with file source', async () => {
      const mockResponse = {
        jobId: 'job-456',
        status: 'waiting-file',
        sourceType: 'file',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        uploadUrl: 'https://s3.amazonaws.com/presigned-url',
        uploadHeaders: { 'Content-Type': 'application/pdf' },
        expiresIn: 3600,
      };

      mockHttpClient.post.mockResolvedValue(mockResponse);

      const result = await jobs.create({
        sourceType: 'file',
        fileName: 'document.pdf',
      });

      expect(result.jobId).toBe('job-456');
      expect(result.uploadUrl).toBeDefined();
      expect(result.uploadUrl).toBe('https://s3.amazonaws.com/presigned-url');
      expect(result.uploadHeaders).toBeDefined();
    });

    it('should include parsing parameters', async () => {
      mockHttpClient.post.mockResolvedValue({
        jobId: 'job-789',
        status: 'pending',
        sourceType: 'url',
        createdAt: new Date(),
      });

      await jobs.create({
        sourceType: 'url',
        sourceUrl: 'https://example.com/doc.pdf',
        parsingParams: {
          model: 'advanced',
          ocrEnabled: true,
          smartTitleParse: true,
        },
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        '/v1/jobs',
        expect.objectContaining({
          parsingParams: {
            model: 'advanced',
            ocrEnabled: true,
            smartTitleParse: true,
          },
        }),
      );
    });

    it('should include webhook configuration', async () => {
      mockHttpClient.post.mockResolvedValue({
        jobId: 'job-abc',
        status: 'pending',
        sourceType: 'url',
        createdAt: new Date(),
      });

      await jobs.create({
        sourceType: 'url',
        sourceUrl: 'https://example.com/doc.pdf',
        webhook: {
          url: 'https://myapp.com/webhook',
        },
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        '/v1/jobs',
        expect.objectContaining({
          webhook: { url: 'https://myapp.com/webhook' },
        }),
      );
    });

    it('should include dataId when provided', async () => {
      mockHttpClient.post.mockResolvedValue({
        jobId: 'job-def',
        status: 'pending',
        sourceType: 'url',
        createdAt: new Date(),
      });

      await jobs.create({
        sourceType: 'url',
        sourceUrl: 'https://example.com/doc.pdf',
        dataId: 'custom-123',
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith(
        '/v1/jobs',
        expect.objectContaining({
          dataId: 'custom-123',
        }),
      );
    });
  });

  describe('get', () => {
    it('should fetch job status', async () => {
      const mockResponse = {
        jobId: 'job-123',
        status: 'running',
        sourceType: 'url',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        progress: { stage: 'parsing', percent: 50 },
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await jobs.get('job-123');

      expect(result.jobId).toBe('job-123');
      expect(result.status).toBe('running');
      expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/jobs/job-123');
      expect(enrichJobResult).toHaveBeenCalledWith(mockResponse);
    });

    it('should enrich JobResult with computed properties', async () => {
      const mockResponse = {
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        resultUrl: 'https://s3.amazonaws.com/result.zip',
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await jobs.get('job-123');

      expect(enrichJobResult).toHaveBeenCalled();
      expect(result.isTerminal).toBe(true);
      expect(result.isDone).toBe(true);
      expect(result.isFailed).toBe(false);
    });

    it('should handle failed job status', async () => {
      const mockResponse = {
        jobId: 'job-123',
        status: 'failed',
        sourceType: 'url',
        createdAt: new Date(),
        error: {
          code: 'PARSING_ERROR',
          message: 'Failed to parse document',
          requestId: 'req-abc',
        },
      };

      mockHttpClient.get.mockResolvedValue(mockResponse);

      const result = await jobs.get('job-123');

      expect(result.isFailed).toBe(true);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('PARSING_ERROR');
    });
  });

  describe('upload', () => {
    it('should upload file from path', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        uploadUrl: 'https://s3.amazonaws.com/presigned-url',
        uploadHeaders: { 'Content-Type': 'application/pdf' },
      });

      await jobs.upload('job-123', {
        file: './test.pdf',
      });

      expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/jobs/job-123');
      expect(uploadFile).toHaveBeenCalledWith(
        mockHttpClient,
        'https://s3.amazonaws.com/presigned-url',
        './test.pdf',
        expect.objectContaining({
          headers: { 'Content-Type': 'application/pdf' },
        }),
      );
    });

    it('should upload Buffer', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        uploadUrl: 'https://s3.amazonaws.com/presigned-url',
      });

      const buffer = Buffer.from('mock pdf content');

      await jobs.upload('job-123', {
        file: buffer,
      });

      expect(uploadFile).toHaveBeenCalledWith(
        mockHttpClient,
        'https://s3.amazonaws.com/presigned-url',
        buffer,
        expect.any(Object),
      );
    });

    it('should throw error if upload URL not available', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        // uploadUrl missing
      });

      await expect(
        jobs.upload('job-123', {
          file: './test.pdf',
        }),
      ).rejects.toThrow(NotFoundError);
      await expect(
        jobs.upload('job-123', {
          file: './test.pdf',
        }),
      ).rejects.toThrow('Upload URL not available');
    });

    it('should pass progress callback to uploadFile', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        uploadUrl: 'https://s3.amazonaws.com/presigned-url',
      });

      const onProgress = vi.fn();

      await jobs.upload('job-123', {
        file: './test.pdf',
        onProgress,
      });

      expect(uploadFile).toHaveBeenCalledWith(
        mockHttpClient,
        'https://s3.amazonaws.com/presigned-url',
        './test.pdf',
        expect.objectContaining({
          onProgress,
        }),
      );
    });

    it('should pass abort signal to uploadFile', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        uploadUrl: 'https://s3.amazonaws.com/presigned-url',
      });

      const controller = new AbortController();

      await jobs.upload('job-123', {
        file: './test.pdf',
        signal: controller.signal,
      });

      expect(uploadFile).toHaveBeenCalledWith(
        mockHttpClient,
        'https://s3.amazonaws.com/presigned-url',
        './test.pdf',
        expect.objectContaining({
          signal: controller.signal,
        }),
      );
    });
  });

  describe('wait', () => {
    it('should poll until job is done', async () => {
      const mockJobResult = {
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        resultUrl: 'https://s3.amazonaws.com/result.zip',
        isTerminal: true,
        isDone: true,
        isFailed: false,
      };

      (pollJobStatus as any).mockResolvedValue(mockJobResult);

      const result = await jobs.wait('job-123', {
        pollInterval: 100,
      });

      expect(result.status).toBe('done');
      expect(pollJobStatus).toHaveBeenCalledWith(
        mockHttpClient,
        'job-123',
        expect.objectContaining({
          pollInterval: 100,
        }),
      );
    });

    it('should pass polling options to pollJobStatus', async () => {
      const mockJobResult = {
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: true,
        isDone: true,
        isFailed: false,
      };

      (pollJobStatus as any).mockResolvedValue(mockJobResult);

      const onProgress = vi.fn();

      await jobs.wait('job-123', {
        pollInterval: 5000,
        pollTimeout: 120000,
        onProgress,
      });

      expect(pollJobStatus).toHaveBeenCalledWith(
        mockHttpClient,
        'job-123',
        expect.objectContaining({
          pollInterval: 5000,
          pollTimeout: 120000,
          onProgress,
        }),
      );
    });

    it('should support AbortSignal', async () => {
      const mockJobResult = {
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: true,
        isDone: true,
        isFailed: false,
      };

      (pollJobStatus as any).mockResolvedValue(mockJobResult);

      const controller = new AbortController();

      await jobs.wait('job-123', {
        signal: controller.signal,
      });

      expect(pollJobStatus).toHaveBeenCalledWith(
        mockHttpClient,
        'job-123',
        expect.objectContaining({
          signal: controller.signal,
        }),
      );
    });
  });

  describe('load', () => {
    it('should download and parse result ZIP', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        resultUrl: 'https://s3.amazonaws.com/result.zip',
        isTerminal: true,
        isDone: true,
        isFailed: false,
      });

      const mockParseResult = {
        jobId: 'job-123',
        manifest: {
          version: '1.0',
          jobId: 'job-123',
          sourceFileName: 'test.pdf',
          processingDate: new Date(),
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
        chunks: [],
        textChunks: [],
        imageChunks: [],
        tableChunks: [],
        statistics: {
          totalChunks: 0,
          textChunks: 0,
          imageChunks: 0,
          tableChunks: 0,
        },
        getChunk: vi.fn(),
        save: vi.fn(),
      };

      (parseResult as any).mockResolvedValue(mockParseResult);

      const result = await jobs.load('job-123');

      expect(result).toBeDefined();
      expect(result.jobId).toBe('job-123');
      expect(parseResult).toHaveBeenCalledWith(
        mockHttpClient,
        'https://s3.amazonaws.com/result.zip',
        undefined,
      );
    });

    it('should throw error if job is not done', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'running',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: false,
        isDone: false,
        isFailed: false,
      });

      await expect(jobs.load('job-123')).rejects.toThrow(
        'Job job-123 is not done yet (status: running)',
      );
    });

    it('should throw error if result URL not available', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        // resultUrl missing
        isTerminal: true,
        isDone: true,
        isFailed: false,
      });

      await expect(jobs.load('job-123')).rejects.toThrow(NotFoundError);
      await expect(jobs.load('job-123')).rejects.toThrow('Result URL not available');
    });

    it('should pass load options to parseResult', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        resultUrl: 'https://s3.amazonaws.com/result.zip',
        isTerminal: true,
        isDone: true,
        isFailed: false,
      });

      const mockParseResult = {
        jobId: 'job-123',
        manifest: {} as any,
        chunks: [],
        textChunks: [],
        imageChunks: [],
        tableChunks: [],
        statistics: {
          totalChunks: 0,
          textChunks: 0,
          imageChunks: 0,
          tableChunks: 0,
        },
        getChunk: vi.fn(),
        save: vi.fn(),
      };

      (parseResult as any).mockResolvedValue(mockParseResult);

      await jobs.load('job-123', {
        verifyChecksum: true,
      });

      expect(parseResult).toHaveBeenCalledWith(
        mockHttpClient,
        'https://s3.amazonaws.com/result.zip',
        expect.objectContaining({
          verifyChecksum: true,
        }),
      );
    });
  });
});
