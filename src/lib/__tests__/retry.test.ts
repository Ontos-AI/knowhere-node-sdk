import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldRetry, calculateRetryDelay, getRetryAfter, withRetry } from '../retry.js';
import { INITIAL_RETRY_DELAY, MAX_RETRY_DELAY } from '../../constants.js';

describe('retry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('shouldRetry', () => {
    it('should return false if max retries exceeded', () => {
      const error = new Error('test');
      expect(shouldRetry(error, 5, 5)).toBe(false);
      expect(shouldRetry(error, 10, 5)).toBe(false);
    });

    it('should retry network errors', () => {
      const errors = [
        new Error('ECONNRESET'),
        new Error('ETIMEDOUT'),
        new Error('ENOTFOUND'),
        new Error('ECONNREFUSED'),
      ];

      for (const error of errors) {
        expect(shouldRetry(error, 0, 3)).toBe(true);
      }
    });

    it('should retry retryable status codes', () => {
      const retryableErrors = [
        { response: { status: 409, data: { code: 'ABORTED' } } },
        { response: { status: 429, headers: { 'retry-after': '60' } } },
        { response: { status: 503 } },
        { response: { status: 504 } },
      ];

      for (const error of retryableErrors) {
        expect(shouldRetry(error, 0, 3)).toBe(true);
      }
    });

    it('should not retry non-retryable status codes', () => {
      const nonRetryableErrors = [
        { response: { status: 400 } },
        { response: { status: 401 } },
        { response: { status: 403 } },
        { response: { status: 404 } },
        { response: { status: 500 } },
      ];

      for (const error of nonRetryableErrors) {
        expect(shouldRetry(error, 0, 3)).toBe(false);
      }
    });

    it('should not retry 429 with QUOTA_EXCEEDED and no retry-after', () => {
      const error = {
        response: {
          status: 429,
          data: { code: 'QUOTA_EXCEEDED' },
        },
      };
      expect(shouldRetry(error, 0, 3)).toBe(false);
    });

    it('should only retry 409 with ABORTED code', () => {
      const abortedError = {
        response: {
          status: 409,
          data: { code: 'ABORTED' },
        },
      };
      const otherError = {
        response: {
          status: 409,
          data: { code: 'CONFLICT' },
        },
      };
      expect(shouldRetry(abortedError, 0, 3)).toBe(true);
      expect(shouldRetry(otherError, 0, 3)).toBe(false);
    });

    it('should retry transformed 429 quota errors when retryAfter is already parsed', () => {
      const error = {
        statusCode: 429,
        code: 'QUOTA_EXCEEDED',
        retryAfter: 30,
      };

      expect(shouldRetry(error, 0, 3)).toBe(true);
    });
  });

  describe('calculateRetryDelay', () => {
    it('should calculate exponential backoff', () => {
      const delay0 = calculateRetryDelay(0);
      const delay1 = calculateRetryDelay(1);
      const delay2 = calculateRetryDelay(2);

      // Each delay should be roughly 2x the base delay (with jitter)
      expect(delay0).toBeGreaterThan(0);
      expect(delay1).toBeGreaterThan(delay0 * 0.8); // Account for jitter
      expect(delay2).toBeGreaterThan(delay1 * 0.8);
    });

    it('should not exceed MAX_RETRY_DELAY', () => {
      const delay = calculateRetryDelay(100); // Very high attempt
      expect(delay).toBeLessThanOrEqual(MAX_RETRY_DELAY);
    });

    it('should start from INITIAL_RETRY_DELAY', () => {
      const delay = calculateRetryDelay(0);
      // Should be around INITIAL_RETRY_DELAY ±20% for jitter
      expect(delay).toBeGreaterThanOrEqual(INITIAL_RETRY_DELAY * 0.8);
      expect(delay).toBeLessThanOrEqual(INITIAL_RETRY_DELAY * 1.2);
    });
  });

  describe('getRetryAfter', () => {
    it('should use parsed retryAfter from transformed SDK errors', () => {
      const error = {
        retryAfter: 30,
      };

      expect(getRetryAfter(error)).toBe(30000);
    });

    it('should parse numeric retry-after (seconds)', () => {
      const error = {
        response: {
          headers: {
            'retry-after': '60',
          },
        },
      };
      const result = getRetryAfter(error);
      expect(result).toBe(60000); // 60 seconds = 60000ms
    });

    it('should parse date retry-after', () => {
      const futureDate = new Date(Date.now() + 5000).toUTCString();
      const error = {
        response: {
          headers: {
            'retry-after': futureDate,
          },
        },
      };
      const result = getRetryAfter(error);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(6000); // Should be ~5000ms
    });

    it('should return undefined for missing retry-after', () => {
      const error = {
        response: {
          headers: {},
        },
      };
      expect(getRetryAfter(error)).toBeUndefined();
    });

    it('should return undefined for invalid retry-after', () => {
      const error = {
        response: {
          headers: {
            'retry-after': 'invalid',
          },
        },
      };
      expect(getRetryAfter(error)).toBeUndefined();
    });

    it('should handle error without response', () => {
      const error = new Error('test');
      expect(getRetryAfter(error)).toBeUndefined();
    });
  });

  describe('withRetry', () => {
    it('should honor parsed retryAfter on transformed errors', async () => {
      vi.useFakeTimers();

      const fn = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({
          statusCode: 429,
          code: 'RESOURCE_EXHAUSTED',
          retryAfter: 30,
        })
        .mockResolvedValueOnce('ok');

      const promise = withRetry(fn, 1);

      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(29999);
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
