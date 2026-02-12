import type { HttpClient } from './http-client.js';
import type { JobResult } from '../types/job.js';
import type { WaitOptions, PollProgress } from '../types/params.js';
import {
  DEFAULT_POLL_INTERVAL,
  DEFAULT_POLL_TIMEOUT,
  MAX_POLL_INTERVAL,
  POLL_INTERVAL_INCREASE_THRESHOLD,
  POLL_INTERVAL_MULTIPLIER,
} from '../constants.js';
import { PollingTimeoutError, JobFailedError } from '../errors/index.js';
import { enrichJobResult, sleep } from './utils.js';

/**
 * Poll job status until completion or timeout
 */
export async function pollJobStatus(
  httpClient: HttpClient,
  jobId: string,
  options?: WaitOptions,
): Promise<JobResult> {
  const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const pollTimeout = options?.pollTimeout ?? DEFAULT_POLL_TIMEOUT;
  const onProgress = options?.onProgress;
  const signal = options?.signal;

  const startTime = Date.now();
  let currentInterval = pollInterval;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check for abort
    if (signal?.aborted) {
      throw new Error('Polling aborted');
    }

    // Get job status
    const jobResult = await httpClient.get<JobResult>(`/v1/jobs/${jobId}`);
    enrichJobResult(jobResult);

    const elapsed = Date.now() - startTime;
    const elapsedSeconds = Math.floor(elapsed / 1000);

    // Notify progress
    if (onProgress) {
      const progress: PollProgress = {
        status: jobResult.status,
        elapsedSeconds,
        jobResult,
      };
      onProgress(progress);
    }

    // Check if terminal
    if (jobResult.isTerminal) {
      if (jobResult.isDone) {
        return jobResult;
      }
      if (jobResult.isFailed && jobResult.error) {
        throw new JobFailedError(jobResult.error.message, jobResult.error.code, jobResult);
      }
      // Should not reach here, but handle gracefully
      throw new JobFailedError(
        `Job ${jobId} failed with status ${jobResult.status}`,
        'UNKNOWN_ERROR',
        jobResult,
      );
    }

    // Check timeout
    if (elapsed >= pollTimeout) {
      throw new PollingTimeoutError(`Polling timeout after ${elapsedSeconds} seconds`, elapsed);
    }

    // Adaptive backoff: increase interval after threshold
    if (elapsed > POLL_INTERVAL_INCREASE_THRESHOLD) {
      currentInterval = Math.min(currentInterval * POLL_INTERVAL_MULTIPLIER, MAX_POLL_INTERVAL);
    }

    // Wait before next poll
    await sleep(currentInterval);
  }
}
