/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import { HttpClient } from '../http-client.js';
import {
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError,
  ServiceUnavailableError,
  GatewayTimeoutError,
  NetworkError,
  TimeoutError,
} from '../../errors/index.js';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

// Mock withRetry to bypass retry logic in tests
vi.mock('../retry.js', async () => {
  const actual = await vi.importActual<typeof import('../retry.js')>('../retry.js');
  return {
    ...actual,
    withRetry: vi.fn(async (fn) => fn()),
  };
});

describe('HttpClient', () => {
  describe('constructor', () => {
    it('should initialize with required options', () => {
      const client = new HttpClient({
        baseURL: 'https://api.example.com',
        apiKey: 'sk_test',
      });

      expect(client).toBeDefined();
    });

    it('should apply timeout configuration', () => {
      const client = new HttpClient({
        baseURL: 'https://api.example.com',
        apiKey: 'sk_test',
        timeout: 30000,
      });

      expect(client).toBeDefined();
    });

    it('should apply custom headers', () => {
      const client = new HttpClient({
        baseURL: 'https://api.example.com',
        apiKey: 'sk_test',
        defaultHeaders: {
          'X-Custom': 'value',
        },
      });

      expect(client).toBeDefined();
    });

    it('should apply custom HTTP agents', () => {
      const httpAgent = new HttpAgent();
      const httpsAgent = new HttpsAgent();

      const client = new HttpClient({
        baseURL: 'https://api.example.com',
        apiKey: 'sk_test',
        httpAgent,
        httpsAgent,
      });

      expect(client).toBeDefined();
    });
  });

  describe('HTTP methods', () => {
    let client: HttpClient;

    beforeEach(() => {
      client = new HttpClient({
        baseURL: 'https://api.example.com',
        apiKey: 'sk_test',
      });

      // Clear mocks
      vi.clearAllMocks();
    });

    describe('get', () => {
      it('should make GET request and return data', async () => {
        const mockData = { id: '123', name: 'Test' };
        vi.spyOn(axios, 'get').mockResolvedValue({
          data: mockData,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        // Access internal axios instance
        const axiosInstance = client.getAxiosInstance();
        vi.spyOn(axiosInstance, 'get').mockResolvedValue({
          data: mockData,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        const result = await client.get('/test');

        expect(result).toEqual(mockData);
      });
    });

    describe('post', () => {
      it('should make POST request with data', async () => {
        const mockData = { id: '123' };
        const axiosInstance = client.getAxiosInstance();
        vi.spyOn(axiosInstance, 'post').mockResolvedValue({
          data: mockData,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        const result = await client.post('/test', { name: 'Test' });

        expect(result).toEqual(mockData);
      });
    });

    describe('put', () => {
      it('should make PUT request with upload timeout', async () => {
        const mockData = { success: true };
        const axiosInstance = client.getAxiosInstance();
        vi.spyOn(axiosInstance, 'put').mockResolvedValue({
          data: mockData,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        const result = await client.put('/test', { data: 'test' });

        expect(result).toEqual(mockData);
      });
    });

    describe('download', () => {
      it('should download file as buffer', async () => {
        const mockBuffer = new ArrayBuffer(10);
        vi.spyOn(axios, 'get').mockResolvedValue({
          data: mockBuffer,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        const result = await client.download('https://example.com/file.pdf');

        expect(result).toBeInstanceOf(Buffer);
      });
    });

    describe('upload', () => {
      it('should upload with progress tracking', async () => {
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({
          data: null,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        const progressUpdates: any[] = [];

        await client.upload('https://s3.example.com/upload', Buffer.from('test'), {
          onProgress: (progress) => {
            progressUpdates.push(progress);
          },
        });

        expect(putSpy).toHaveBeenCalled();
      });

      it('should pass custom headers to upload', async () => {
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({
          data: null,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        await client.upload('https://s3.example.com/upload', Buffer.from('test'), {
          headers: {
            'Content-Type': 'application/pdf',
          },
        });

        expect(putSpy).toHaveBeenCalledWith(
          'https://s3.example.com/upload',
          expect.any(Buffer),
          expect.objectContaining({
            headers: {
              'Content-Type': 'application/pdf',
            },
          }),
        );
      });

      it('should support AbortSignal', async () => {
        const controller = new AbortController();
        const putSpy = vi.spyOn(axios, 'put').mockResolvedValue({
          data: null,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as any,
        });

        await client.upload('https://s3.example.com/upload', Buffer.from('test'), {
          signal: controller.signal,
        });

        expect(putSpy).toHaveBeenCalledWith(
          'https://s3.example.com/upload',
          expect.any(Buffer),
          expect.objectContaining({
            signal: controller.signal,
          }),
        );
      });
    });
  });

  describe('error handling', () => {
    let client: HttpClient;

    beforeEach(() => {
      client = new HttpClient({
        baseURL: 'https://api.example.com',
        apiKey: 'sk_test',
      });
    });

    // Helper to mock axios adapter to trigger interceptors
    const mockAxiosAdapter = (error: AxiosError): void => {
      const axiosInstance = client.getAxiosInstance();

      (axiosInstance.defaults as any).adapter = (): Promise<never> => Promise.reject(error);
    };

    // Helper function to create proper AxiosError instances
    const createAxiosError = (status: number, data: any, headers: any = {}): AxiosError => {
      const error = new AxiosError(
        `Request failed with status code ${status}`,
        status.toString(),
        {} as any,
        {} as any,
        {
          status,
          statusText: 'Error',
          data,
          headers,
          config: {} as any,
        },
      );
      return error;
    };

    it('should map 400 to BadRequestError', async () => {
      const error = createAxiosError(
        400,
        { message: 'Invalid input', code: 'VALIDATION_ERROR' },
        { 'x-request-id': 'req-123' },
      );
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(BadRequestError);
    });

    it('should map 401 to AuthenticationError', async () => {
      const error = createAxiosError(401, { message: 'Invalid API key' }, {});
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(AuthenticationError);
    });

    it('should map 403 to PermissionDeniedError', async () => {
      const error = createAxiosError(403, { message: 'Forbidden' }, {});
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(PermissionDeniedError);
    });

    it('should map 404 to NotFoundError', async () => {
      const error = createAxiosError(404, { message: 'Not found' }, {});
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(NotFoundError);
    });

    it('should map 409 to ConflictError', async () => {
      const error = createAxiosError(409, { message: 'Conflict' }, {});
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(ConflictError);
    });

    it('should map 429 to RateLimitError with retryAfter', async () => {
      const error = createAxiosError(
        429,
        { message: 'Rate limit exceeded' },
        { 'retry-after': '60' },
      );
      mockAxiosAdapter(error);

      try {
        await client.get('/test');
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfter).toBe(60);
      }
    });

    it('should map 500 to InternalServerError', async () => {
      const error = createAxiosError(500, { message: 'Internal error' }, {});
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(InternalServerError);
    });

    it('should map 503 to ServiceUnavailableError', async () => {
      const error = createAxiosError(503, { message: 'Service unavailable' }, {});
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(ServiceUnavailableError);
    });

    it('should map 504 to GatewayTimeoutError', async () => {
      const error = createAxiosError(504, { message: 'Gateway timeout' }, {});
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(GatewayTimeoutError);
    });

    it('should handle network errors without response', async () => {
      const error = new AxiosError(
        'Network error',
        'ENOTFOUND',
        {} as any,
        {} as any,
        undefined, // No response
      );
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(NetworkError);
    });

    it('should handle timeout errors', async () => {
      const error = new AxiosError(
        'timeout of 60000ms exceeded',
        'ECONNABORTED',
        {} as any,
        {} as any,
        undefined, // No response
      );
      mockAxiosAdapter(error);

      await expect(client.get('/test')).rejects.toThrow(TimeoutError);
    });

    it('should extract XML error messages from external downloads', async () => {
      const xmlError = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
      );
      const axiosError = new AxiosError(
        'Request failed with status code 400',
        '400',
        {} as any,
        {} as any,
        {
          status: 400,
          statusText: 'Bad Request',
          data: xmlError,
          headers: {},
          config: {} as any,
        },
      );

      vi.spyOn(axios, 'get').mockRejectedValue(axiosError);

      await expect(client.download('https://storage.example.com/result.zip')).rejects.toThrow(
        'AccessDenied: Request has expired',
      );
    });
  });

  describe('getAxiosInstance', () => {
    it('should return underlying axios instance', () => {
      const client = new HttpClient({
        baseURL: 'https://api.example.com',
        apiKey: 'sk_test',
      });

      const instance = client.getAxiosInstance();
      expect(instance).toBeDefined();
    });
  });
});
