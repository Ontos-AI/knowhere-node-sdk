import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import type { Agent as HttpAgent } from 'http';
import type { Agent as HttpsAgent } from 'https';
import { VERSION } from '../version.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import { NetworkError, TimeoutError, createAPIError } from '../errors/index.js';
import { keysToCamel, keysToSnake, parseDates } from './utils.js';
import { withRetry, getRetryAfter } from './retry.js';

export interface HttpClientOptions {
  baseURL: string;
  apiKey: string;
  timeout?: number;
  uploadTimeout?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  httpAgent?: HttpAgent;
  httpsAgent?: HttpsAgent;
}

/**
 * HTTP client wrapper around axios with retry logic and error handling
 */
export class HttpClient {
  private axios: AxiosInstance;
  private maxRetries: number;
  private uploadTimeout: number;
  private httpAgent?: HttpAgent;
  private httpsAgent?: HttpsAgent;

  constructor(options: HttpClientOptions) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.uploadTimeout = options.uploadTimeout ?? 600000;
    this.httpAgent = options.httpAgent;
    this.httpsAgent = options.httpsAgent;

    this.axios = axios.create({
      baseURL: options.baseURL,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': `knowhere-node-sdk/${VERSION}`,
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        ...options.defaultHeaders,
      },
      httpAgent: options.httpAgent,
      httpsAgent: options.httpsAgent,
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor - convert camelCase to snake_case
    this.axios.interceptors.request.use(
      (config) => {
        if (config.data && typeof config.data === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion
          config.data = keysToSnake(config.data) as unknown as typeof config.data;
        }
        return config;
      },
      (error: AxiosError) => {
        return Promise.reject(this.handleError(error));
      },
    );

    // Response interceptor - convert snake_case to camelCase and parse dates
    this.axios.interceptors.response.use(
      (response: AxiosResponse) => {
        if (response.data && typeof response.data === 'object') {
          let data = keysToCamel(response.data);
          data = parseDates(data);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion
          response.data = data as unknown as typeof response.data;
        }
        return response;
      },
      (error: AxiosError) => {
        return Promise.reject(this.handleError(error));
      },
    );
  }

  private handleError(error: AxiosError): Error {
    // Network errors
    if (!error.response) {
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        return new TimeoutError('Request timed out');
      }
      return new NetworkError(error.message || 'Network error', error);
    }

    // API errors
    const { status, data, headers } = error.response;
    const errorData = this.normalizeErrorData(data);
    const errorObject = this.getErrorObject(errorData);
    const message = this.getErrorMessage(errorObject, status);
    const code = this.getErrorCode(errorObject);
    const requestId =
      (headers['x-request-id'] as string | undefined) ??
      (typeof errorObject?.request_id === 'string' ? errorObject.request_id : undefined);
    const details =
      errorObject?.details &&
      typeof errorObject.details === 'object' &&
      errorObject.details.constructor === Object
        ? (errorObject.details as Record<string, unknown>)
        : undefined;

    // Extract retry-after for rate limits
    let retryAfter: number | undefined;
    if (status === 429) {
      const retryAfterMs = getRetryAfter(error);
      retryAfter = retryAfterMs !== undefined ? Math.ceil(retryAfterMs / 1000) : undefined;
    }

    return createAPIError(status, message, code, requestId, details, data, retryAfter);
  }

  private getErrorObject(errorData: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!errorData) {
      return undefined;
    }

    const nestedError = errorData.error;
    if (nestedError && typeof nestedError === 'object' && nestedError.constructor === Object) {
      return nestedError as Record<string, unknown>;
    }

    return errorData;
  }

  private normalizeErrorData(data: unknown): Record<string, unknown> | undefined {
    if (data && typeof data === 'object' && data.constructor === Object) {
      return data as Record<string, unknown>;
    }

    const decoded = this.decodeErrorPayload(data);
    if (!decoded) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(decoded) as unknown;
      if (parsed && typeof parsed === 'object' && parsed.constructor === Object) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON payloads are handled below.
    }

    const xmlCode = decoded.match(/<Code>([^<]+)<\/Code>/i)?.[1];
    const xmlMessage = decoded.match(/<Message>([^<]+)<\/Message>/i)?.[1];
    if (xmlCode || xmlMessage) {
      return {
        code: xmlCode,
        message: [xmlCode, xmlMessage].filter(Boolean).join(': '),
      };
    }

    return {
      message: decoded.slice(0, 300),
    };
  }

  private decodeErrorPayload(data: unknown): string | undefined {
    if (typeof data === 'string') {
      return data.trim();
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString('utf8').trim();
    }

    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8').trim();
    }

    if (Buffer.isBuffer(data)) {
      return data.toString('utf8').trim();
    }

    return undefined;
  }

  private getErrorMessage(errorData: Record<string, unknown> | undefined, status: number): string {
    if (!errorData) {
      return `HTTP ${status} error`;
    }

    return typeof errorData.message === 'string'
      ? errorData.message
      : typeof errorData.error === 'string'
        ? errorData.error
        : `HTTP ${status} error`;
  }

  private getErrorCode(errorData: Record<string, unknown> | undefined): string | undefined {
    if (!errorData) {
      return undefined;
    }

    return typeof errorData.code === 'string' ? errorData.code : undefined;
  }

  private async requestExternal<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw this.handleError(error);
      }

      throw error;
    }
  }

  /**
   * GET request
   */
  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return withRetry(
      async () => {
        const response = await this.axios.get<T>(url, config);
        return response.data;
      },
      this.maxRetries,
      (attempt, error) => {
        console.warn(`Retry attempt ${attempt} for GET ${url}:`, error);
      },
    );
  }

  /**
   * POST request
   */
  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return withRetry(
      async () => {
        const response = await this.axios.post<T>(url, data, config);
        return response.data;
      },
      this.maxRetries,
      (attempt, error) => {
        console.warn(`Retry attempt ${attempt} for POST ${url}:`, error);
      },
    );
  }

  /**
   * PUT request (typically for uploads, no retry)
   */
  async put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.axios.put<T>(url, data, {
      ...config,
      timeout: this.uploadTimeout,
    });
    return response.data;
  }

  /**
   * Download file as buffer
   */
  async download(url: string, config?: AxiosRequestConfig): Promise<Buffer> {
    return withRetry(
      async () => {
        return this.requestExternal(async () => {
          const response = await axios.get<ArrayBuffer>(url, {
            ...config,
            responseType: 'arraybuffer',
            timeout: config?.timeout ?? this.uploadTimeout,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
          });
          return Buffer.from(response.data);
        });
      },
      this.maxRetries,
      (attempt, error) => {
        console.warn(`Retry attempt ${attempt} for download ${url}:`, error);
      },
    );
  }

  /**
   * Upload file with progress tracking
   */
  async upload(
    url: string,
    data: unknown,
    options?: {
      headers?: Record<string, string>;
      onProgress?: (progress: { loaded: number; total?: number; percent: number }) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    await this.requestExternal(async () => {
      await axios.put(url, data, {
        headers: {
          ...options?.headers,
        },
        timeout: this.uploadTimeout,
        signal: options?.signal,
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent,
        onUploadProgress: (progressEvent) => {
          if (options?.onProgress) {
            const loaded = progressEvent.loaded;
            const total = progressEvent.total;
            const percent = total ? Math.round((loaded / total) * 100) : 0;
            options.onProgress({ loaded, total, percent });
          }
        },
      });
    });
  }

  /**
   * Get the underlying axios instance
   */
  getAxiosInstance(): AxiosInstance {
    return this.axios;
  }
}
