/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pollJobStatus } from '../polling.js';
import { PollingTimeoutError, JobFailedError } from '../../errors/index.js';

describe('Polling', () => {
  let mockHttpClient: any;

  beforeEach(() => {
    mockHttpClient = {
      get: vi.fn(),
    };

    // Clear mocks
    vi.clearAllMocks();
  });

  describe('pollJobStatus', () => {
    it('should poll until job is done', async () => {
      let callCount = 0;
      mockHttpClient.get.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({
            jobId: 'job-123',
            status: 'running',
            sourceType: 'url',
            createdAt: new Date(),
            isTerminal: false,
            isDone: false,
            isFailed: false,
          });
        } else {
          return Promise.resolve({
            jobId: 'job-123',
            status: 'done',
            sourceType: 'url',
            createdAt: new Date(),
            resultUrl: 'https://s3.example.com/result.zip',
            isTerminal: true,
            isDone: true,
            isFailed: false,
          });
        }
      });

      const result = await pollJobStatus(mockHttpClient, 'job-123', {
        pollInterval: 10,
      });

      expect(result.status).toBe('done');
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should throw error when job fails', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'failed',
        sourceType: 'url',
        createdAt: new Date(),
        error: {
          code: 'PARSING_ERROR',
          message: 'Failed to parse',
          requestId: 'req-123',
        },
        isTerminal: true,
        isDone: false,
        isFailed: true,
      });

      await expect(pollJobStatus(mockHttpClient, 'job-123')).rejects.toThrow(JobFailedError);

      await expect(pollJobStatus(mockHttpClient, 'job-123')).rejects.toThrow('Failed to parse');
    });

    it('should throw error when job fails without error details', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'failed',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: true,
        isDone: false,
        isFailed: true,
      });

      await expect(pollJobStatus(mockHttpClient, 'job-123')).rejects.toThrow(JobFailedError);

      await expect(pollJobStatus(mockHttpClient, 'job-123')).rejects.toThrow('Job job-123 failed');
    });

    it('should timeout if poll timeout exceeded', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'running',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: false,
        isDone: false,
        isFailed: false,
      });

      await expect(
        pollJobStatus(mockHttpClient, 'job-123', {
          pollInterval: 10,
          pollTimeout: 50,
        }),
      ).rejects.toThrow(PollingTimeoutError);
    });

    it('should call progress callback during polling', async () => {
      let callCount = 0;
      mockHttpClient.get.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          jobId: 'job-123',
          status: callCount < 3 ? 'running' : 'done',
          sourceType: 'url',
          createdAt: new Date(),
          isTerminal: callCount >= 3,
          isDone: callCount >= 3,
          isFailed: false,
        });
      });

      const progressUpdates: any[] = [];

      await pollJobStatus(mockHttpClient, 'job-123', {
        pollInterval: 10,
        onProgress: (progress) => {
          progressUpdates.push(progress);
        },
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0]).toHaveProperty('status');
      expect(progressUpdates[0]).toHaveProperty('elapsedSeconds');
      expect(progressUpdates[0]).toHaveProperty('jobResult');
    });

    it('should support AbortSignal', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'running',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: false,
        isDone: false,
        isFailed: false,
      });

      const controller = new AbortController();

      const promise = pollJobStatus(mockHttpClient, 'job-123', {
        pollInterval: 10,
        signal: controller.signal,
      });

      // Abort after a short delay
      setTimeout(() => controller.abort(), 20);

      await expect(promise).rejects.toThrow('Polling aborted');
    });

    it('should use default poll interval when not provided', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: true,
        isDone: true,
        isFailed: false,
      });

      const result = await pollJobStatus(mockHttpClient, 'job-123');

      expect(result.status).toBe('done');
    });

    it('should use default poll timeout when not provided', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        isTerminal: true,
        isDone: true,
        isFailed: false,
      });

      const result = await pollJobStatus(mockHttpClient, 'job-123');

      expect(result.status).toBe('done');
    });

    it('should handle job status without terminal flag properly', async () => {
      mockHttpClient.get.mockResolvedValue({
        jobId: 'job-123',
        status: 'done',
        sourceType: 'url',
        createdAt: new Date(),
        // Simulate enrichJobResult will add these flags
      });

      // The enrichJobResult function should be called inside pollJobStatus
      const result = await pollJobStatus(mockHttpClient, 'job-123');

      expect(result).toBeDefined();
      expect(result.jobId).toBe('job-123');
    });
  });
});
