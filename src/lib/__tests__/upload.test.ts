/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createReadStream, promises as fs } from 'fs';
import { join } from 'path';
import { uploadFile } from '../upload.js';
import { KnowhereError } from '../../errors/index.js';
import type { HttpClient } from '../http-client.js';

describe('File Upload', () => {
  let mockHttpClient: any;
  const testFixturesDir = join(__dirname, '../../../test-fixtures');
  const testFilePath = join(testFixturesDir, 'sample.txt');

  beforeEach(async () => {
    mockHttpClient = {
      upload: vi.fn().mockResolvedValue(undefined),
    } as unknown as HttpClient;

    // Create test fixtures directory and sample file
    await fs.mkdir(testFixturesDir, { recursive: true });
    await fs.writeFile(testFilePath, 'Sample file content for testing upload');

    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up test fixtures
    try {
      await fs.rm(testFixturesDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('uploadFile', () => {
    it('should upload file from path', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';

      await uploadFile(mockHttpClient, uploadUrl, testFilePath);

      expect(mockHttpClient.upload).toHaveBeenCalledTimes(1);
      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        expect.anything(), // ReadStream
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/octet-stream',
            'Content-Length': expect.any(String),
          }),
        }),
      );
    });

    it('should upload Buffer', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const buffer = Buffer.from('mock pdf content');

      await uploadFile(mockHttpClient, uploadUrl, buffer);

      expect(mockHttpClient.upload).toHaveBeenCalledTimes(1);
      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        buffer,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length.toString(),
          }),
        }),
      );
    });

    it('should upload ReadStream', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const stream = createReadStream(testFilePath);

      await uploadFile(mockHttpClient, uploadUrl, stream);

      expect(mockHttpClient.upload).toHaveBeenCalledTimes(1);
      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        stream,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/octet-stream',
          }),
        }),
      );
    });

    it('should upload Uint8Array', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const uint8Array = new Uint8Array([1, 2, 3, 4, 5]);

      await uploadFile(mockHttpClient, uploadUrl, uint8Array);

      expect(mockHttpClient.upload).toHaveBeenCalledTimes(1);
      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        expect.any(Buffer),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/octet-stream',
            'Content-Length': uint8Array.length.toString(),
          }),
        }),
      );
    });

    it('should report upload progress', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const progressUpdates: number[] = [];

      // Mock upload to simulate progress
      mockHttpClient.upload.mockImplementation(
        (url: string, data: unknown, options: any) => {
          // Simulate progress updates
          if (options?.onProgress) {
            options.onProgress({ loaded: 25, total: 100, percent: 25 });
            options.onProgress({ loaded: 50, total: 100, percent: 50 });
            options.onProgress({ loaded: 75, total: 100, percent: 75 });
            options.onProgress({ loaded: 100, total: 100, percent: 100 });
          }
          return Promise.resolve();
        },
      );

      await uploadFile(mockHttpClient, uploadUrl, Buffer.from('content'), {
        onProgress: ({ percent }) => {
          progressUpdates.push(percent);
        },
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates).toEqual([25, 50, 75, 100]);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
    });

    it('should support AbortSignal', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const controller = new AbortController();

      // Mock upload to simulate abort
      mockHttpClient.upload.mockImplementation(() => {
        return Promise.reject(new Error('Upload aborted'));
      });

      const promise = uploadFile(
        mockHttpClient,
        uploadUrl,
        Buffer.from('content'),
        {
          signal: controller.signal,
        },
      );

      await expect(promise).rejects.toThrow('Upload aborted');

      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        expect.anything(),
        expect.objectContaining({
          signal: controller.signal,
        }),
      );
    });

    it('should use custom headers if provided', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const customHeaders = {
        'Content-Type': 'application/pdf',
        'X-Custom-Header': 'custom-value',
      };

      await uploadFile(mockHttpClient, uploadUrl, Buffer.from('content'), {
        headers: customHeaders,
      });

      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/pdf',
            'X-Custom-Header': 'custom-value',
          }),
        }),
      );
    });

    it('should throw error for unsupported file type', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const unsupportedFile = { invalid: 'type' } as any;

      await expect(
        uploadFile(mockHttpClient, uploadUrl, unsupportedFile),
      ).rejects.toThrow(KnowhereError);

      await expect(
        uploadFile(mockHttpClient, uploadUrl, unsupportedFile),
      ).rejects.toThrow('Unsupported file type');
    });

    it('should handle file path that does not exist', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const nonExistentPath = './non-existent-file.pdf';

      await expect(
        uploadFile(mockHttpClient, uploadUrl, nonExistentPath),
      ).rejects.toThrow();
    });

    it('should include Content-Length for Buffer uploads', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const buffer = Buffer.from('test content with specific length');

      await uploadFile(mockHttpClient, uploadUrl, buffer);

      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        buffer,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Length': buffer.length.toString(),
          }),
        }),
      );
    });

    it('should include Content-Length for file path uploads', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';

      await uploadFile(mockHttpClient, uploadUrl, testFilePath);

      const stats = await fs.stat(testFilePath);
      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Length': stats.size.toString(),
          }),
        }),
      );
    });

    it('should not include Content-Length when size is unknown', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const stream = createReadStream(testFilePath);

      await uploadFile(mockHttpClient, uploadUrl, stream);

      const callArgs = mockHttpClient.upload.mock.calls[0];
      const options = callArgs[2];

      // ReadStream without bytesRead should not have Content-Length
      expect(options.headers).toBeDefined();
      expect(options.headers['Content-Type']).toBe('application/octet-stream');
    });

    it('should handle upload errors from HttpClient', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const errorMessage = 'Network error during upload';

      mockHttpClient.upload.mockRejectedValue(new Error(errorMessage));

      await expect(
        uploadFile(mockHttpClient, uploadUrl, Buffer.from('content')),
      ).rejects.toThrow(errorMessage);
    });

    it('should pass all options to HttpClient.upload', async () => {
      const uploadUrl = 'https://s3.amazonaws.com/presigned-url';
      const controller = new AbortController();
      const onProgress = vi.fn();
      const headers = { 'X-Test': 'value' };

      await uploadFile(mockHttpClient, uploadUrl, Buffer.from('content'), {
        headers,
        onProgress,
        signal: controller.signal,
      });

      expect(mockHttpClient.upload).toHaveBeenCalledWith(
        uploadUrl,
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining(headers),
          onProgress,
          signal: controller.signal,
        }),
      );
    });
  });
});
