/**
 * Job status
 */
export type JobStatus =
  | 'pending'
  | 'waiting-file'
  | 'running'
  | 'converting'
  | 'done'
  | 'failed';

/**
 * Job creation response
 */
export interface Job {
  /** Unique job identifier */
  jobId: string;
  /** Current job status */
  status: JobStatus;
  /** Source type (file or url) */
  sourceType: string;
  /** Optional custom data identifier */
  dataId?: string;
  /** Job creation timestamp */
  createdAt: Date;
  /** Presigned URL for file upload (if sourceType is 'file') */
  uploadUrl?: string;
  /** Headers to include in upload request */
  uploadHeaders?: Record<string, string>;
  /** Upload URL expiration time in seconds */
  expiresIn?: number;
}

/**
 * Job error details
 */
export interface JobError {
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Request ID for debugging */
  requestId: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

/**
 * Job status response with full details
 */
export interface JobResult {
  /** Unique job identifier */
  jobId: string;
  /** Current job status */
  status: JobStatus;
  /** Source type (file or url) */
  sourceType: string;
  /** Optional custom data identifier */
  dataId?: string;
  /** Job creation timestamp */
  createdAt: Date;
  /** Processing progress information */
  progress?: Record<string, unknown>;
  /** Error details (if job failed) */
  error?: JobError;
  /** Result metadata */
  result?: Record<string, unknown>;
  /** Presigned URL to download result ZIP */
  resultUrl?: string;
  /** Result URL expiration timestamp */
  resultUrlExpiresAt?: Date;
  /** Original file name */
  fileName?: string;
  /** File extension */
  fileExtension?: string;
  /** Model used for parsing */
  model?: string;
  /** Whether OCR was enabled */
  ocrEnabled?: boolean;
  /** Processing duration in seconds */
  durationSeconds?: number;
  /** Credits consumed */
  creditsSpent?: number;

  /** Whether the job is in a terminal state (done or failed) */
  readonly isTerminal: boolean;
  /** Whether the job completed successfully */
  readonly isDone: boolean;
  /** Whether the job failed */
  readonly isFailed: boolean;
}
