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
      details?: Record<string, unknown>;
      error?: {
        code?: string;
        details?: Record<string, unknown>;
      };
    };
    headers?: Record<string, string>;
  };
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
  retryAfter?: unknown;
}

function getErrorCode(error: unknown): string | undefined {
  const errorWithResponse = error as ErrorWithResponse;
  return (
    errorWithResponse?.response?.data?.error?.code ??
    errorWithResponse?.response?.data?.code ??
    errorWithResponse?.code
  );
}

function getErrorDetails(error: unknown): Record<string, unknown> | undefined {
  const errorWithResponse = error as ErrorWithResponse;
  return (
    errorWithResponse?.response?.data?.error?.details ??
    errorWithResponse?.response?.data?.details ??
    errorWithResponse?.details
  );
}

function getBodyRetryAfter(error: unknown): number | undefined {
  const details = getErrorDetails(error);
  if (!details) {
    return undefined;
  }

  const rawRetryAfter = details.retry_after ?? details.retryAfter;
  if (typeof rawRetryAfter === 'number' && Number.isFinite(rawRetryAfter) && rawRetryAfter >= 0) {
    return rawRetryAfter * 1000;
  }

  if (typeof rawRetryAfter === 'string') {
    const parsed = Number.parseFloat(rawRetryAfter);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * 1000;
    }
  }

  return undefined;
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
    const code = getErrorCode(error);

    // For 429, only retry when the server provides an explicit retry hint.
    if (statusCode === 429) {
      const retryAfter = getRetryAfter(error);
      return retryAfter !== undefined;
    }

    // For 409, only retry if it's an ABORTED error
    if (statusCode === 409) {
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

  // Transformed SDK errors (for example RateLimitError) already carry a parsed
  // retryAfter value in seconds. Preserve that instead of forcing callers to
  // depend on the original transport-layer response object.
  if (
    typeof errorWithResponse?.retryAfter === 'number' &&
    Number.isFinite(errorWithResponse.retryAfter) &&
    errorWithResponse.retryAfter >= 0
  ) {
    return errorWithResponse.retryAfter * 1000;
  }

  // Match the Python SDK by preferring structured body hints from
  // error.details.retry_after before falling back to transport headers.
  const bodyRetryAfter = getBodyRetryAfter(error);
  if (bodyRetryAfter !== undefined) {
    return bodyRetryAfter;
  }

  const retryAfter = errorWithResponse?.response?.headers?.['retry-after'];
  if (!retryAfter || typeof retryAfter !== 'string') {
    return undefined;
  }

  // Try parsing as number (seconds)
  const seconds = Number.parseFloat(retryAfter);
  if (!Number.isNaN(seconds)) {
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
