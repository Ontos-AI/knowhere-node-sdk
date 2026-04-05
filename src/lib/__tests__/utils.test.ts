import { describe, it, expect } from 'vitest';
import {
  sleep,
  snakeToCamel,
  camelToSnake,
  keysToCamel,
  keysToSnake,
  parseDates,
  enrichJobResult,
  sanitizePath,
  getFileExtension,
  jitter,
} from '../utils.js';
import type { JobResult } from '../../types/job.js';

describe('utils', () => {
  describe('sleep', () => {
    it('should sleep for specified duration', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some tolerance
    });
  });

  describe('snakeToCamel', () => {
    it('should convert snake_case to camelCase', () => {
      expect(snakeToCamel('hello_world')).toBe('helloWorld');
      expect(snakeToCamel('foo_bar_baz')).toBe('fooBarBaz');
      expect(snakeToCamel('already')).toBe('already');
    });
  });

  describe('camelToSnake', () => {
    it('should convert camelCase to snake_case', () => {
      expect(camelToSnake('helloWorld')).toBe('hello_world');
      expect(camelToSnake('fooBarBaz')).toBe('foo_bar_baz');
      expect(camelToSnake('already')).toBe('already');
    });
  });

  describe('keysToCamel', () => {
    it('should convert object keys from snake_case to camelCase', () => {
      const input = {
        first_name: 'John',
        last_name: 'Doe',
        email_address: 'john@example.com',
      };
      const expected = {
        firstName: 'John',
        lastName: 'Doe',
        emailAddress: 'john@example.com',
      };
      expect(keysToCamel(input)).toEqual(expected);
    });

    it('should handle nested objects', () => {
      const input = {
        user_info: {
          first_name: 'John',
          contact_info: {
            email_address: 'john@example.com',
          },
        },
      };
      const expected = {
        userInfo: {
          firstName: 'John',
          contactInfo: {
            emailAddress: 'john@example.com',
          },
        },
      };
      expect(keysToCamel(input)).toEqual(expected);
    });

    it('should handle arrays', () => {
      const input = [{ first_name: 'John' }, { first_name: 'Jane' }];
      const expected = [{ firstName: 'John' }, { firstName: 'Jane' }];
      expect(keysToCamel(input)).toEqual(expected);
    });

    it('should handle null and undefined', () => {
      expect(keysToCamel(null)).toBe(null);
      expect(keysToCamel(undefined)).toBe(undefined);
    });
  });

  describe('keysToSnake', () => {
    it('should convert object keys from camelCase to snake_case', () => {
      const input = {
        firstName: 'John',
        lastName: 'Doe',
        emailAddress: 'john@example.com',
      };
      const expected = {
        first_name: 'John',
        last_name: 'Doe',
        email_address: 'john@example.com',
      };
      expect(keysToSnake(input)).toEqual(expected);
    });

    it('should handle nested objects', () => {
      const input = {
        userInfo: {
          firstName: 'John',
          contactInfo: {
            emailAddress: 'john@example.com',
          },
        },
      };
      const expected = {
        user_info: {
          first_name: 'John',
          contact_info: {
            email_address: 'john@example.com',
          },
        },
      };
      expect(keysToSnake(input)).toEqual(expected);
    });
  });

  describe('parseDates', () => {
    it('should parse ISO date strings in fields ending with At or Date', () => {
      const input = {
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-16T12:45:00Z',
        birthDate: '2000-05-20T00:00:00Z',
        other: 'not a date',
      };
      const result = parseDates(input);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.other).toBe('not a date');
    });

    it('should handle nested objects', () => {
      const input = {
        user: {
          createdAt: '2024-01-15T10:30:00Z',
        },
      };
      const result = parseDates(input);
      expect(result.user.createdAt).toBeInstanceOf(Date);
    });

    it('should handle arrays', () => {
      const input = [{ createdAt: '2024-01-15T10:30:00Z' }, { createdAt: '2024-01-16T12:45:00Z' }];
      const result = parseDates(input);
      expect(result[0].createdAt).toBeInstanceOf(Date);
      expect(result[1].createdAt).toBeInstanceOf(Date);
    });
  });

  describe('enrichJobResult', () => {
    it('should be idempotent when called multiple times', () => {
      const jobResult = {
        jobId: 'job-123',
        status: 'done' as const,
        sourceType: 'file',
        createdAt: new Date(),
      } as unknown as JobResult;

      enrichJobResult(jobResult);
      expect(jobResult.isTerminal).toBe(true);
      expect(jobResult.isDone).toBe(true);
      expect(jobResult.isFailed).toBe(false);

      expect(() => enrichJobResult(jobResult)).not.toThrow();
      expect(jobResult.isTerminal).toBe(true);
      expect(jobResult.isDone).toBe(true);
      expect(jobResult.isFailed).toBe(false);
    });
  });

  describe('sanitizePath', () => {
    it('should remove leading slashes', () => {
      expect(sanitizePath('/path/to/file.txt')).toBe('path/to/file.txt');
      expect(sanitizePath('///path/to/file.txt')).toBe('path/to/file.txt');
    });

    it('should remove directory traversal attempts', () => {
      expect(sanitizePath('../../../etc/passwd')).toBe('etc/passwd');
      expect(sanitizePath('path/../to/file.txt')).toBe('path/to/file.txt');
    });

    it('should handle clean paths', () => {
      expect(sanitizePath('path/to/file.txt')).toBe('path/to/file.txt');
    });
  });

  describe('getFileExtension', () => {
    it('should extract file extension', () => {
      expect(getFileExtension('file.txt')).toBe('txt');
      expect(getFileExtension('document.pdf')).toBe('pdf');
      expect(getFileExtension('image.png')).toBe('png');
      expect(getFileExtension('path/to/file.jpg')).toBe('jpg');
    });

    it('should handle files without extension', () => {
      expect(getFileExtension('README')).toBe('');
      expect(getFileExtension('path/to/file')).toBe('');
    });

    it('should handle hidden files', () => {
      expect(getFileExtension('.gitignore')).toBe('gitignore');
    });
  });

  describe('jitter', () => {
    it('should add random jitter within ±20%', () => {
      const baseValue = 1000;
      const result = jitter(baseValue);
      const min = baseValue * 0.8;
      const max = baseValue * 1.2;
      expect(result).toBeGreaterThanOrEqual(min);
      expect(result).toBeLessThanOrEqual(max);
    });

    it('should return different values on multiple calls', () => {
      const results = Array.from({ length: 10 }, () => jitter(1000));
      const uniqueResults = new Set(results);
      // Very unlikely all 10 calls return the same value
      expect(uniqueResults.size).toBeGreaterThan(1);
    });
  });
});
