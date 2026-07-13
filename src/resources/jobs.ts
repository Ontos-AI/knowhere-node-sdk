import { BaseResource } from './base.js';
import type { Job, JobResult } from '../types/job.js';
import type { CreateJobParams, UploadParams, WaitOptions, LoadOptions } from '../types/params.js';
import type { ParseResult } from '../types/result.js';
import {
  mergeDocumentMetadataDefaults,
  NODE_SDK_DOCUMENT_METADATA_DEFAULTS,
} from '../lib/document-metadata.js';
import { uploadFile } from '../lib/upload.js';
import { pollJobStatus } from '../lib/polling.js';
import { parseResult } from '../lib/result-parser.js';
import { enrichJobResult, enrichParseResult } from '../lib/utils.js';
import { InvalidStateError, NotFoundError } from '../errors/index.js';

/**
 * Jobs resource for managing parsing jobs
 */
export class Jobs extends BaseResource {
  private pendingUploadJobs = new Map<string, Job>();

  /**
   * Create a new parsing job.
   *
   * Auto-attaches `documentMetadata.createdByClient` / `clientVersion` for
   * OSS telemetry. Caller-provided metadata keys win; defaults fill gaps only.
   */
  async create(params: CreateJobParams): Promise<Job> {
    const documentMetadata = mergeDocumentMetadataDefaults(
      NODE_SDK_DOCUMENT_METADATA_DEFAULTS,
      params.documentMetadata,
    );
    const job = await this.httpClient.post<Job>(this.endpoint('/jobs'), {
      ...params,
      documentMetadata,
    });
    if (job.uploadUrl) {
      this.pendingUploadJobs.set(job.jobId, job);
    }
    return job;
  }

  /**
   * Get job status
   */
  async get(jobId: string): Promise<JobResult> {
    const jobResult = await this.httpClient.get<JobResult>(this.endpoint(`/jobs/${jobId}`));
    enrichJobResult(jobResult);
    return jobResult;
  }

  /**
   * Upload file for a job
   */
  async upload(jobOrId: string | Job, params: UploadParams): Promise<void> {
    const response = this.resolveUploadJob(jobOrId);

    if (!response.uploadUrl) {
      throw new NotFoundError(
        'Upload URL not available for this job. Pass the Job object returned from create() or a direct upload URL string.',
      );
    }

    // Upload file to presigned URL
    await uploadFile(this.httpClient, response.uploadUrl, params.file, {
      headers: response.uploadHeaders,
      onProgress: params.onProgress,
      signal: params.signal,
    });

    this.pendingUploadJobs.delete(response.jobId);
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
  async load(jobResultOrIdOrUrl: JobResult | string, options?: LoadOptions): Promise<ParseResult> {
    const jobResult = await this.resolveLoadJobResult(jobResultOrIdOrUrl);

    // Check if job is done
    if (!jobResult.isDone) {
      throw new Error(`Job ${jobResult.jobId} is not done yet (status: ${jobResult.status})`);
    }

    // Check if result URL is available
    if (!jobResult.resultUrl) {
      throw new NotFoundError('Result URL not available');
    }

    // Parse result
    const result = await parseResult(this.httpClient, jobResult.resultUrl, options);
    return enrichParseResult(result, jobResult);
  }

  private isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
  }

  private resolveUploadJob(jobOrId: string | Job): Job {
    if (typeof jobOrId !== 'string') {
      if (jobOrId.uploadUrl) {
        this.pendingUploadJobs.set(jobOrId.jobId, jobOrId);
      }
      return jobOrId;
    }

    if (this.isHttpUrl(jobOrId)) {
      return {
        jobId: 'direct-upload-url',
        status: 'waiting-file',
        sourceType: 'file',
        createdAt: new Date(0),
        uploadUrl: jobOrId,
      };
    }

    const cachedJob = this.pendingUploadJobs.get(jobOrId);
    if (cachedJob) {
      return cachedJob;
    }

    throw new InvalidStateError(
      `Upload URL not available for job ${jobOrId}. Pass the Job object returned from create() or a direct upload URL string.`,
    );
  }

  private async resolveLoadJobResult(jobResultOrIdOrUrl: JobResult | string): Promise<JobResult> {
    if (typeof jobResultOrIdOrUrl !== 'string') {
      enrichJobResult(jobResultOrIdOrUrl);
      return jobResultOrIdOrUrl;
    }

    if (this.isHttpUrl(jobResultOrIdOrUrl)) {
      return {
        jobId: 'direct-result-url',
        status: 'done',
        sourceType: 'file',
        createdAt: new Date(0),
        resultUrl: jobResultOrIdOrUrl,
        resultUrlExpiresAt: new Date(0),
        isTerminal: true,
        isDone: true,
        isFailed: false,
      };
    }

    return this.get(jobResultOrIdOrUrl);
  }
}
