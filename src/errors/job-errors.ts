import { KnowhereError } from './base.js';
import type { JobResult } from '../types/job.js';

/**
 * Job execution failed
 */
export class JobFailedError extends KnowhereError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly jobResult: JobResult,
  ) {
    super(message);
    this.name = 'JobFailedError';
  }
}
