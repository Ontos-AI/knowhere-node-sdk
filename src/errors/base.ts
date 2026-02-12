/**
 * Base error class for all Knowhere SDK errors
 */
export class KnowhereError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowhereError';
    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Network-related errors
 */
export class NetworkError extends KnowhereError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Request timeout error
 */
export class TimeoutError extends NetworkError {
  constructor(message: string = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Polling timeout error
 */
export class PollingTimeoutError extends KnowhereError {
  constructor(
    message: string = 'Polling timed out',
    public readonly elapsedMs: number,
  ) {
    super(message);
    this.name = 'PollingTimeoutError';
  }
}

/**
 * ZIP checksum verification failed
 */
export class ChecksumError extends KnowhereError {
  constructor(
    message: string = 'Checksum verification failed',
    public readonly expected?: string,
    public readonly actual?: string,
  ) {
    super(message);
    this.name = 'ChecksumError';
  }
}

/**
 * Raised when the caller provides invalid arguments
 */
export class ValidationError extends KnowhereError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Raised when an object is in an unexpected state for the operation
 */
export class InvalidStateError extends KnowhereError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}
