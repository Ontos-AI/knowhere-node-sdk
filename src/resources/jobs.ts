import { BaseResource } from './base.js';
import type { Job, JobResult } from '../types/job.js';
import type {
  CreateJobParams,
  UploadParams,
  WaitOptions,
  LoadOptions,
} from '../types/params.js';
import type { ParseResult } from '../types/result.js';
import { uploadFile } from '../lib/upload.js';
import { pollJobStatus } from '../lib/polling.js';
import { parseResult } from '../lib/result-parser.js';
import { enrichJobResult } from '../lib/utils.js';
import { NotFoundError } from '../errors/index.js';

/**
 * Jobs resource for managing parsing jobs
 */
export class Jobs extends BaseResource {
  /**
   * Create a new parsing job
   */
  async create(params: CreateJobParams): Promise<Job> {
    const job = await this.httpClient.post<Job>('/v1/jobs', params);
    return job;
  }

  /**
   * Get job status
   */
  async get(jobId: string): Promise<JobResult> {
    const jobResult = await this.httpClient.get<JobResult>(`/v1/jobs/${jobId}`);
    enrichJobResult(jobResult);
    return jobResult;
  }

  /**
   * Upload file for a job
   */
  async upload(jobId: string, params: UploadParams): Promise<void> {
    // Get job details - note: need to fetch job (not jobResult) to get upload URL
    // In practice, the upload URL is only available immediately after job creation
    // So this method should be called with the Job object from create()
    const response = await this.httpClient.get<Job>(`/v1/jobs/${jobId}`);

    if (!response.uploadUrl) {
      throw new NotFoundError('Upload URL not available for this job');
    }

    // Upload file to presigned URL
    await uploadFile(this.httpClient, response.uploadUrl, params.file, {
      headers: response.uploadHeaders,
      onProgress: params.onProgress,
      signal: params.signal,
    });
  }

  /**
   * Wait for job completion
   */
  async wait(jobId: string, options?: WaitOptions): Promise<JobResult> {
    return pollJobStatus(this.httpClient, jobId, options);
  }

  /**
   * Load parse result from completed job
   */
  async load(jobId: string, options?: LoadOptions): Promise<ParseResult> {
    // Get job result
    const jobResult = await this.get(jobId);

    // Check if job is done
    if (!jobResult.isDone) {
      throw new Error(`Job ${jobId} is not done yet (status: ${jobResult.status})`);
    }

    // Check if result URL is available
    if (!jobResult.resultUrl) {
      throw new NotFoundError('Result URL not available');
    }

    // Parse result
    return parseResult(this.httpClient, jobResult.resultUrl, options);
  }
}
