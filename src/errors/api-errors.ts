import { KnowhereError } from './base.js';

/**
 * Base class for all API errors
 */
export class APIError extends KnowhereError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly requestId?: string,
    public readonly details?: Record<string, unknown>,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'APIError';
  }
}

/**
 * 400 Bad Request
 */
export class BadRequestError extends APIError {
  constructor(
    message: string,
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 400, code, requestId, details, body);
    this.name = 'BadRequestError';
  }
}

/**
 * 401 Unauthorized
 */
export class AuthenticationError extends APIError {
  constructor(
    message: string = 'Authentication failed',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 401, code, requestId, details, body);
    this.name = 'AuthenticationError';
  }
}

/**
 * 402 Payment Required
 */
export class PaymentRequiredError extends APIError {
  constructor(
    message: string = 'Payment required',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 402, code, requestId, details, body);
    this.name = 'PaymentRequiredError';
  }
}

/**
 * 403 Forbidden
 */
export class PermissionDeniedError extends APIError {
  constructor(
    message: string = 'Permission denied',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 403, code, requestId, details, body);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * 404 Not Found
 */
export class NotFoundError extends APIError {
  constructor(
    message: string = 'Resource not found',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 404, code, requestId, details, body);
    this.name = 'NotFoundError';
  }
}

/**
 * 409 Conflict
 */
export class ConflictError extends APIError {
  constructor(
    message: string = 'Conflict',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 409, code, requestId, details, body);
    this.name = 'ConflictError';
  }
}

/**
 * 429 Rate Limit Exceeded
 */
export class RateLimitError extends APIError {
  constructor(
    message: string = 'Rate limit exceeded',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
    public readonly retryAfter?: number,
  ) {
    super(message, 429, code, requestId, details, body);
    this.name = 'RateLimitError';
  }
}

/**
 * 500 Internal Server Error
 */
export class InternalServerError extends APIError {
  constructor(
    message: string = 'Internal server error',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 500, code, requestId, details, body);
    this.name = 'InternalServerError';
  }
}

/**
 * 502/503 Service Unavailable
 */
export class ServiceUnavailableError extends APIError {
  constructor(
    message: string = 'Service unavailable',
    statusCode: number = 503,
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, statusCode, code, requestId, details, body);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * 504 Gateway Timeout
 */
export class GatewayTimeoutError extends APIError {
  constructor(
    message: string = 'Gateway timeout',
    code?: string,
    requestId?: string,
    details?: Record<string, unknown>,
    body?: unknown,
  ) {
    super(message, 504, code, requestId, details, body);
    this.name = 'GatewayTimeoutError';
  }
}

/**
 * Create appropriate error based on status code
 */
export function createAPIError(
  statusCode: number,
  message: string,
  code?: string,
  requestId?: string,
  details?: Record<string, unknown>,
  body?: unknown,
  retryAfter?: number,
): APIError {
  switch (statusCode) {
    case 400:
      return new BadRequestError(message, code, requestId, details, body);
    case 401:
      return new AuthenticationError(message, code, requestId, details, body);
    case 402:
      return new PaymentRequiredError(message, code, requestId, details, body);
    case 403:
      return new PermissionDeniedError(message, code, requestId, details, body);
    case 404:
      return new NotFoundError(message, code, requestId, details, body);
    case 409:
      return new ConflictError(message, code, requestId, details, body);
    case 429:
      return new RateLimitError(message, code, requestId, details, body, retryAfter);
    case 500:
      return new InternalServerError(message, code, requestId, details, body);
    case 502:
    case 503:
      return new ServiceUnavailableError(message, statusCode, code, requestId, details, body);
    case 504:
      return new GatewayTimeoutError(message, code, requestId, details, body);
    default:
      return new APIError(message, statusCode, code, requestId, details, body);
  }
}
