/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, it, expect } from 'vitest';
import {
  KnowhereError,
  NetworkError,
  TimeoutError,
  PollingTimeoutError,
  ChecksumError,
  ValidationError,
  InvalidStateError,
} from '../base.js';
import {
  APIError,
  BadRequestError,
  AuthenticationError,
  PaymentRequiredError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError,
  ServiceUnavailableError,
  GatewayTimeoutError,
  createAPIError,
} from '../api-errors.js';
import { JobFailedError } from '../job-errors.js';

describe('Error Classes', () => {
  describe('KnowhereError', () => {
    it('should create base error', () => {
      const error = new KnowhereError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('KnowhereError');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(KnowhereError);
    });
  });

  describe('NetworkError', () => {
    it('should create network error', () => {
      const error = new NetworkError('Connection failed');
      expect(error.message).toBe('Connection failed');
      expect(error.name).toBe('NetworkError');
      expect(error).toBeInstanceOf(KnowhereError);
      expect(error).toBeInstanceOf(NetworkError);
    });

    it('should include cause error', () => {
      const cause = new Error('ECONNRESET');
      const error = new NetworkError('Connection failed', cause);
      expect(error.cause).toBe(cause);
    });
  });

  describe('TimeoutError', () => {
    it('should create timeout error', () => {
      const error = new TimeoutError();
      expect(error.message).toBe('Request timed out');
      expect(error.name).toBe('TimeoutError');
      expect(error).toBeInstanceOf(NetworkError);
    });

    it('should accept custom message', () => {
      const error = new TimeoutError('Custom timeout');
      expect(error.message).toBe('Custom timeout');
    });
  });

  describe('PollingTimeoutError', () => {
    it('should create polling timeout error', () => {
      const error = new PollingTimeoutError('Polling timeout', 300000);
      expect(error.message).toBe('Polling timeout');
      expect(error.name).toBe('PollingTimeoutError');
      expect(error.elapsedMs).toBe(300000);
      expect(error).toBeInstanceOf(KnowhereError);
    });

    it('should use default message', () => {
      const error = new PollingTimeoutError(undefined as any, 300000);
      expect(error.message).toBe('Polling timed out');
    });
  });

  describe('ChecksumError', () => {
    it('should create checksum error', () => {
      const error = new ChecksumError('Checksum mismatch', 'abc123', 'def456');
      expect(error.message).toBe('Checksum mismatch');
      expect(error.name).toBe('ChecksumError');
      expect(error.expected).toBe('abc123');
      expect(error.actual).toBe('def456');
      expect(error).toBeInstanceOf(KnowhereError);
    });

    it('should use default message', () => {
      const error = new ChecksumError();
      expect(error.message).toBe('Checksum verification failed');
    });
  });

  describe('ValidationError', () => {
    it('should create ValidationError with message', () => {
      const error = new ValidationError('Invalid parameter');
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toBeInstanceOf(KnowhereError);
      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('Invalid parameter');
    });
  });

  describe('InvalidStateError', () => {
    it('should create InvalidStateError with message', () => {
      const error = new InvalidStateError('Invalid state');
      expect(error).toBeInstanceOf(InvalidStateError);
      expect(error).toBeInstanceOf(KnowhereError);
      expect(error.name).toBe('InvalidStateError');
      expect(error.message).toBe('Invalid state');
    });
  });

  describe('APIError', () => {
    it('should create API error with all fields', () => {
      const error = new APIError(
        'API error',
        400,
        'INVALID_REQUEST',
        'req-123',
        { field: 'email' },
        { error: 'details' },
      );

      expect(error.message).toBe('API error');
      expect(error.name).toBe('APIError');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('INVALID_REQUEST');
      expect(error.requestId).toBe('req-123');
      expect(error.details).toEqual({ field: 'email' });
      expect(error.body).toEqual({ error: 'details' });
      expect(error).toBeInstanceOf(KnowhereError);
    });
  });

  describe('BadRequestError', () => {
    it('should create 400 error', () => {
      const error = new BadRequestError('Invalid input', 'VALIDATION_ERROR', 'req-123', {
        field: 'email',
        issue: 'invalid format',
      });

      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('BadRequestError');
      expect(error.message).toBe('Invalid input');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.requestId).toBe('req-123');
      expect(error.details).toEqual({
        field: 'email',
        issue: 'invalid format',
      });
      expect(error).toBeInstanceOf(APIError);
    });
  });

  describe('AuthenticationError', () => {
    it('should create 401 error', () => {
      const error = new AuthenticationError('Invalid API key', 'INVALID_API_KEY', 'req-123');

      expect(error.statusCode).toBe(401);
      expect(error.name).toBe('AuthenticationError');
      expect(error.message).toBe('Invalid API key');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new AuthenticationError();
      expect(error.message).toBe('Authentication failed');
    });
  });

  describe('PaymentRequiredError', () => {
    it('should create 402 error', () => {
      const error = new PaymentRequiredError('Payment required', 'INSUFFICIENT_CREDITS', 'req-123');

      expect(error.statusCode).toBe(402);
      expect(error.name).toBe('PaymentRequiredError');
      expect(error.message).toBe('Payment required');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new PaymentRequiredError();
      expect(error.message).toBe('Payment required');
    });
  });

  describe('PermissionDeniedError', () => {
    it('should create 403 error', () => {
      const error = new PermissionDeniedError('Access denied', 'FORBIDDEN', 'req-123');

      expect(error.statusCode).toBe(403);
      expect(error.name).toBe('PermissionDeniedError');
      expect(error.message).toBe('Access denied');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new PermissionDeniedError();
      expect(error.message).toBe('Permission denied');
    });
  });

  describe('NotFoundError', () => {
    it('should create 404 error', () => {
      const error = new NotFoundError('Resource not found', 'NOT_FOUND', 'req-123');

      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('NotFoundError');
      expect(error.message).toBe('Resource not found');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new NotFoundError();
      expect(error.message).toBe('Resource not found');
    });
  });

  describe('ConflictError', () => {
    it('should create 409 error', () => {
      const error = new ConflictError('Conflict', 'CONFLICT', 'req-123');

      expect(error.statusCode).toBe(409);
      expect(error.name).toBe('ConflictError');
      expect(error.message).toBe('Conflict');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new ConflictError();
      expect(error.message).toBe('Conflict');
    });
  });

  describe('RateLimitError', () => {
    it('should create 429 error with retryAfter', () => {
      const error = new RateLimitError(
        'Rate limit exceeded',
        'RATE_LIMIT',
        'req-123',
        undefined,
        undefined,
        60,
      );

      expect(error.statusCode).toBe(429);
      expect(error.name).toBe('RateLimitError');
      expect(error.message).toBe('Rate limit exceeded');
      expect(error.retryAfter).toBe(60);
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new RateLimitError();
      expect(error.message).toBe('Rate limit exceeded');
    });
  });

  describe('InternalServerError', () => {
    it('should create 500 error', () => {
      const error = new InternalServerError('Server error', 'INTERNAL_ERROR', 'req-123');

      expect(error.statusCode).toBe(500);
      expect(error.name).toBe('InternalServerError');
      expect(error.message).toBe('Server error');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new InternalServerError();
      expect(error.message).toBe('Internal server error');
    });
  });

  describe('ServiceUnavailableError', () => {
    it('should create 503 error', () => {
      const error = new ServiceUnavailableError(
        'Service unavailable',
        503,
        'SERVICE_UNAVAILABLE',
        'req-123',
      );

      expect(error.statusCode).toBe(503);
      expect(error.name).toBe('ServiceUnavailableError');
      expect(error.message).toBe('Service unavailable');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should support 502 status code', () => {
      const error = new ServiceUnavailableError('Bad gateway', 502, 'BAD_GATEWAY', 'req-123');

      expect(error.statusCode).toBe(502);
    });

    it('should use default message and status', () => {
      const error = new ServiceUnavailableError();
      expect(error.message).toBe('Service unavailable');
      expect(error.statusCode).toBe(503);
    });
  });

  describe('GatewayTimeoutError', () => {
    it('should create 504 error', () => {
      const error = new GatewayTimeoutError('Gateway timeout', 'GATEWAY_TIMEOUT', 'req-123');

      expect(error.statusCode).toBe(504);
      expect(error.name).toBe('GatewayTimeoutError');
      expect(error.message).toBe('Gateway timeout');
      expect(error).toBeInstanceOf(APIError);
    });

    it('should use default message', () => {
      const error = new GatewayTimeoutError();
      expect(error.message).toBe('Gateway timeout');
    });
  });

  describe('JobFailedError', () => {
    it('should create job failed error', () => {
      const jobResult = {
        jobId: 'job-123',
        status: 'failed' as const,
        sourceType: 'url',
        createdAt: new Date(),
        error: {
          code: 'PARSING_ERROR',
          message: 'Failed to parse',
          requestId: 'req-abc',
        },
        isTerminal: true,
        isDone: false,
        isFailed: true,
      };

      const error = new JobFailedError('Job failed', 'PARSING_ERROR', jobResult);

      expect(error.message).toBe('Job failed');
      expect(error.name).toBe('JobFailedError');
      expect(error.code).toBe('PARSING_ERROR');
      expect(error.jobResult).toBe(jobResult);
      expect(error).toBeInstanceOf(KnowhereError);
    });
  });

  describe('createAPIError', () => {
    it('should create BadRequestError for 400', () => {
      const error = createAPIError(400, 'Bad request');
      expect(error).toBeInstanceOf(BadRequestError);
      expect(error.statusCode).toBe(400);
    });

    it('should create AuthenticationError for 401', () => {
      const error = createAPIError(401, 'Unauthorized');
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.statusCode).toBe(401);
    });

    it('should create PaymentRequiredError for 402', () => {
      const error = createAPIError(402, 'Payment required');
      expect(error).toBeInstanceOf(PaymentRequiredError);
      expect(error.statusCode).toBe(402);
    });

    it('should create PermissionDeniedError for 403', () => {
      const error = createAPIError(403, 'Forbidden');
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect(error.statusCode).toBe(403);
    });

    it('should create NotFoundError for 404', () => {
      const error = createAPIError(404, 'Not found');
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.statusCode).toBe(404);
    });

    it('should create ConflictError for 409', () => {
      const error = createAPIError(409, 'Conflict');
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.statusCode).toBe(409);
    });

    it('should create RateLimitError for 429', () => {
      const error = createAPIError(
        429,
        'Rate limit',
        undefined,
        undefined,
        undefined,
        undefined,
        60,
      );
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.statusCode).toBe(429);
      expect((error as RateLimitError).retryAfter).toBe(60);
    });

    it('should create InternalServerError for 500', () => {
      const error = createAPIError(500, 'Internal error');
      expect(error).toBeInstanceOf(InternalServerError);
      expect(error.statusCode).toBe(500);
    });

    it('should create ServiceUnavailableError for 502', () => {
      const error = createAPIError(502, 'Bad gateway');
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(error.statusCode).toBe(502);
    });

    it('should create ServiceUnavailableError for 503', () => {
      const error = createAPIError(503, 'Service unavailable');
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(error.statusCode).toBe(503);
    });

    it('should create GatewayTimeoutError for 504', () => {
      const error = createAPIError(504, 'Gateway timeout');
      expect(error).toBeInstanceOf(GatewayTimeoutError);
      expect(error.statusCode).toBe(504);
    });

    it('should create generic APIError for unknown status code', () => {
      const error = createAPIError(418, "I'm a teapot");
      expect(error).toBeInstanceOf(APIError);
      expect(error).not.toBeInstanceOf(BadRequestError);
      expect(error.statusCode).toBe(418);
    });

    it('should pass all parameters to created error', () => {
      const error = createAPIError(
        400,
        'Error message',
        'ERROR_CODE',
        'req-123',
        { key: 'value' },
        { body: 'data' },
      );

      expect(error.message).toBe('Error message');
      expect(error.code).toBe('ERROR_CODE');
      expect(error.requestId).toBe('req-123');
      expect(error.details).toEqual({ key: 'value' });
      expect(error.body).toEqual({ body: 'data' });
    });
  });
});
