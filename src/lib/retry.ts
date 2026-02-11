import {
  INITIAL_RETRY_DELAY,
  MAX_RETRY_DELAY,
  RETRY_DELAY_BASE,
  RETRYABLE_STATUS_CODES,
} from '../constants.js';
import { jitter } from './utils.js';

/**
 * Type guard for objects with optional nested properties
 */
interface ErrorWithResponse {
  response?: {
    status?: number;
    data?: {
      code?: string;
    };
    headers?: Record<string, string>;
  };
  statusCode?: number;
  code?: string;
}

/**
 * Check if error should be retried
 */
export function shouldRetry(error: unknown, attempt: number, maxRetries: number): boolean {
  // Check if we've exceeded max retries
  if (attempt >= maxRetries) {
    return false;
  }

  // Check if it's a retryable error
  if (isRetryableError(error)) {
    return true;
  }

  return false;
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: unknown): boolean {
  // Network errors are retryable
  if (
    error instanceof Error &&
    (error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('ECONNREFUSED'))
  ) {
    return true;
  }

  // Check status code
  const errorWithResponse = error as ErrorWithResponse;
  const statusCode = errorWithResponse?.response?.status ?? errorWithResponse?.statusCode;
  if (statusCode && typeof statusCode === 'number' && RETRYABLE_STATUS_CODES.has(statusCode)) {
    // For 429, only retry if there's a retry-after header or it's not a quota error
    if (statusCode === 429) {
      const code = errorWithResponse?.response?.data?.code ?? errorWithResponse?.code;
      const retryAfter = errorWithResponse?.response?.headers?.['retry-after'];
      // Don't retry quota errors without retry-after
      if (code === 'QUOTA_EXCEEDED' && !retryAfter) {
        return false;
      }
      return true;
    }

    // For 409, only retry if it's an ABORTED error
    if (statusCode === 409) {
      const code = errorWithResponse?.response?.data?.code ?? errorWithResponse?.code;
      return code === 'ABORTED';
    }

    return true;
  }

  return false;
}

/**
 * Calculate retry delay with exponential backoff
 */
export function calculateRetryDelay(attempt: number): number {
  // delay = min(INITIAL_RETRY_DELAY * 2^attempt + jitter, MAX_RETRY_DELAY)
  const baseDelay = INITIAL_RETRY_DELAY * Math.pow(RETRY_DELAY_BASE, attempt);
  const delayWithJitter = jitter(baseDelay);
  return Math.min(delayWithJitter, MAX_RETRY_DELAY);
}

/**
 * Get retry-after value from error
 */
export function getRetryAfter(error: unknown): number | undefined {
  const errorWithResponse = error as ErrorWithResponse;
  const retryAfter = errorWithResponse?.response?.headers?.['retry-after'];
  if (!retryAfter || typeof retryAfter !== 'string') {
    return undefined;
  }

  // Try parsing as number (seconds)
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000; // Convert to milliseconds
  }

  // Try parsing as date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return undefined;
}

/**
 * Execute function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!shouldRetry(error, attempt, maxRetries)) {
        throw error;
      }

      // Calculate delay
      let delay = calculateRetryDelay(attempt);

      // Use retry-after if available
      const retryAfter = getRetryAfter(error);
      if (retryAfter !== undefined) {
        delay = retryAfter;
      }

      // Notify about retry
      if (onRetry) {
        onRetry(attempt + 1, error);
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
