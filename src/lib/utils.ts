import type { JobStatus, JobResult } from '../types/job.js';
import { TERMINAL_JOB_STATUSES } from '../constants.js';

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert snake_case to camelCase
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Convert camelCase to snake_case
 */
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert object keys from snake_case to camelCase
 */
export function keysToCamel<T = unknown>(obj: unknown): T {
  if (obj === null || obj === undefined) {
    return obj as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => keysToCamel(item)) as T;
  }

  if (typeof obj === 'object' && obj.constructor === Object) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[snakeToCamel(key)] = keysToCamel(value);
    }
    return result as T;
  }

  return obj as T;
}

/**
 * Convert object keys from camelCase to snake_case
 */
export function keysToSnake<T = unknown>(obj: unknown): T {
  if (obj === null || obj === undefined) {
    return obj as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => keysToSnake(item)) as T;
  }

  if (typeof obj === 'object' && obj.constructor === Object) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[camelToSnake(key)] = keysToSnake(value);
    }
    return result as T;
  }

  return obj as T;
}

/**
 * Parse ISO date strings in object
 */
export function parseDates<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item: unknown) => parseDates(item)) as T;
  }

  if (typeof obj === 'object' && obj.constructor === Object) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Convert known date fields
      if (
        (key.endsWith('At') || key.endsWith('Date')) &&
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T/.test(value)
      ) {
        result[key] = new Date(value);
      } else {
        result[key] = parseDates(value);
      }
    }
    return result as T;
  }

  return obj;
}

/**
 * Check if job status is terminal
 */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Add readonly getters to JobResult
 */
export function enrichJobResult(jobResult: JobResult): JobResult {
  Object.defineProperties(jobResult, {
    isTerminal: {
      get(this: JobResult) {
        return isTerminalStatus(this.status);
      },
      enumerable: true,
    },
    isDone: {
      get(this: JobResult) {
        return this.status === 'done';
      },
      enumerable: true,
    },
    isFailed: {
      get(this: JobResult) {
        return this.status === 'failed';
      },
      enumerable: true,
    },
  });
  return jobResult;
}

/**
 * Sanitize file path to prevent directory traversal
 */
export function sanitizePath(path: string): string {
  // Remove leading slashes
  let sanitized = path.replace(/^\/+/, '');

  // Remove ../ and ..\
  sanitized = sanitized.replace(/\.\.(\/|\\)/g, '');

  // Normalize slashes
  sanitized = sanitized.replace(/\\/g, '/');

  return sanitized;
}

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  const match = filename.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Generate random jitter for retry delay
 */
export function jitter(value: number, percent: number = 0.2): number {
  const randomFactor = 1 + (Math.random() * 2 - 1) * percent;
  return Math.round(value * randomFactor);
}
