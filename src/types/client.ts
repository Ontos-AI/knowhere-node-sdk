import type { Agent as HttpAgent } from 'http';
import type { Agent as HttpsAgent } from 'https';

export type AuthTokenProvider = () => string | Promise<string>;

export type KnowhereApiVersion = 'v1' | 'v2';

/**
 * Configuration options for the Knowhere client
 */
export interface KnowhereOptions {
  /** API authentication key (defaults to KNOWHERE_API_KEY env var) */
  apiKey?: string;
  /** Dynamic bearer token provider for short-lived non-API-key auth flows */
  authTokenProvider?: AuthTokenProvider;
  /** API base URL (defaults to https://api.knowhereto.ai) */
  baseURL?: string;
  /** API route version to use by default (default: 'v1') */
  apiVersion?: KnowhereApiVersion;
  /** Request timeout in milliseconds (default: 60000) */
  timeout?: number;
  /** Upload timeout in milliseconds (default: 600000) */
  uploadTimeout?: number;
  /** Maximum number of retry attempts (default: 5) */
  maxRetries?: number;
  /** Additional headers to include in all requests */
  defaultHeaders?: Record<string, string>;
  /** Custom HTTP agent for HTTP requests */
  httpAgent?: HttpAgent;
  /** Custom HTTPS agent for HTTPS requests */
  httpsAgent?: HttpsAgent;
}
