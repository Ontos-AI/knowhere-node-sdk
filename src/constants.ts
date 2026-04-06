/**
 * Default API base URL
 */
export const DEFAULT_BASE_URL = 'https://api.knowhereto.ai';

/**
 * Default request timeout (60 seconds)
 */
export const DEFAULT_TIMEOUT = 60000;

/**
 * Default upload timeout (10 minutes)
 */
export const DEFAULT_UPLOAD_TIMEOUT = 600000;

/**
 * Default maximum retry attempts
 */
export const DEFAULT_MAX_RETRIES = 5;

/**
 * Default polling interval (10 seconds)
 */
export const DEFAULT_POLL_INTERVAL = 10000;

/**
 * Maximum polling interval (30 seconds)
 */
export const MAX_POLL_INTERVAL = 30000;

/**
 * Default polling timeout (30 minutes)
 */
export const DEFAULT_POLL_TIMEOUT = 1800000;

/**
 * Time threshold to start increasing poll interval (60 seconds)
 */
export const POLL_INTERVAL_INCREASE_THRESHOLD = 60000;

/**
 * Poll interval multiplier for adaptive backoff
 */
export const POLL_INTERVAL_MULTIPLIER = 1.2;

/**
 * Initial retry delay (500ms)
 */
export const INITIAL_RETRY_DELAY = 500;

/**
 * Maximum retry delay (30 seconds)
 */
export const MAX_RETRY_DELAY = 30000;

/**
 * Retry delay base for exponential backoff
 */
export const RETRY_DELAY_BASE = 2;

/**
 * Maximum jitter for retry delay (±20%)
 */
export const RETRY_JITTER = 0.2;

/**
 * HTTP status codes that should be retried
 */
export const RETRYABLE_STATUS_CODES = new Set([409, 429, 502, 503, 504]);

/**
 * Terminal job statuses
 */
export const TERMINAL_JOB_STATUSES = new Set(['done', 'failed']);

/**
 * Environment variable names
 */
export const ENV = {
  API_KEY: 'KNOWHERE_API_KEY',
  BASE_URL: 'KNOWHERE_BASE_URL',
  LOG_LEVEL: 'KNOWHERE_LOG_LEVEL',
} as const;
