/**
 * Job status
 */
export type JobStatus = 'pending' | 'waiting-file' | 'running' | 'converting' | 'done' | 'failed';

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
  /** Retrieval namespace for the canonical document */
  namespace?: string;
  /** Planned stable document identifier for this job, when returned by the API */
  documentId?: string;
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
  enhancement?: JobEnhancement;
  snapshots?: readonly JobSnapshot[];
  currentSnapshotId?: string;
  /** Unique job identifier */
  jobId: string;
  /** Current job status */
  status: JobStatus;
  /** Source type (file or url) */
  sourceType: string;
  /** Optional custom data identifier */
  dataId?: string;
  /** Retrieval namespace for the canonical document */
  namespace?: string;
  /** Stable document identifier for retrieval/document lifecycle APIs */
  documentId?: string;
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

/** Background work does not change an already completed ingestion job. */
export interface JobEnhancement {
  readonly status: 'pending' | 'running' | 'complete' | 'failed';
  readonly canRetry: boolean;
  readonly attempt: number;
  readonly error?: string | null;
}

/** Immutable archive generation; signed URL capabilities may be refreshed. */
export interface JobSnapshot {
  readonly snapshotId: string;
  readonly stage: 'baseline' | 'final';
  readonly jobId: string;
  readonly jobResultId: string;
  readonly documentId: string;
  readonly checksum: string;
  readonly resultUrl: string;
  readonly resultUrlExpiresAt: Date;
}

/** Immutable object inventory published with a snapshot, without expiring capabilities. */
export interface JobSnapshotObject {
  readonly path: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly contentType: string;
  readonly kind: 'essential' | 'image';
}

export interface JobSnapshotDelivery {
  readonly snapshotId: string;
  readonly jobId: string;
  readonly jobResultId: string;
  readonly documentId: string;
  readonly checksum: string;
  readonly objects: readonly JobSnapshotObject[];
}

/** Fresh capability resolved through the authenticated immutable snapshot route. */
export interface JobSnapshotObjectAccess extends Omit<JobSnapshotDelivery, 'objects'> {
  readonly path: string;
  readonly downloadUrl: string;
  readonly expiresAt: Date;
}

/** Capabilities for an exact set of immutable inventory members, sharing one snapshot pin. */
export interface JobSnapshotObjectAccessBatch extends Omit<JobSnapshotDelivery, 'objects'> {
  readonly objects: readonly Pick<JobSnapshotObjectAccess, 'path' | 'downloadUrl' | 'expiresAt'>[];
}

export interface JobEnhancementRetryResult {
  readonly jobId: string;
  readonly enhancement: JobEnhancement;
}
