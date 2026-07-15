import type { ReadStream } from 'fs';
import type { KnowhereAssetStorageOptions } from './storage.js';

/**
 * Parsing model options
 */
export type ParsingModel = 'base' | 'advanced';

/**
 * Document type options
 */
export type DocType = 'auto' | 'pdf' | 'docx' | 'txt' | 'md';

/**
 * Parsing configuration parameters
 */
export interface ParsingParams {
  /** Parsing model to use (default: 'base') */
  model?: ParsingModel;
  /** Enable OCR for scanned documents (default: false) */
  ocrEnabled?: boolean;
  /** Knowledge base directory */
  kbDir?: string;
  /** Document type hint (default: 'auto') */
  docType?: DocType;
  /** Enable smart title parsing (default: false) */
  smartTitleParse?: boolean;
  /** Generate image summaries (default: false) */
  summaryImage?: boolean;
  /** Generate table summaries (default: false) */
  summaryTable?: boolean;
  /** Generate text summaries (default: false) */
  summaryTxt?: boolean;
  /** Additional fragment description */
  addFragDesc?: string;
}

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  /** Webhook URL to notify on job completion */
  url: string;
}

/**
 * Per-provider BYOK credentials and routing overrides.
 */
export interface LlmProviderConfig {
  /** Provider API key */
  apiKey?: string;
  /** Model identifier */
  model?: string;
  /** Provider base URL override */
  baseUrl?: string;
}

/**
 * Bring-your-own-key LLM configuration for text and vision providers.
 *
 * - `provider`: shared multimodal credentials for both channels
 * - `text` / `vision`: per-channel overrides (win over `provider`)
 * - a channel with neither a slot nor `provider` keeps server defaults
 */
export interface LlmConfig {
  /** Shared multimodal credentials for both text and vision */
  provider?: LlmProviderConfig;
  /** Text / chat provider credentials (overrides provider) */
  text?: LlmProviderConfig;
  /** Vision / VLM provider credentials (overrides provider) */
  vision?: LlmProviderConfig;
}

/**
 * Client-provided display metadata copied onto the published document.
 */
export type DocumentMetadata = Record<string, unknown>;

/**
 * Job creation parameters
 */
export interface CreateJobParams {
  /** Source type: 'file' for upload, 'url' for remote document */
  sourceType: 'file' | 'url';
  /** Source URL (required if sourceType is 'url') */
  sourceUrl?: string;
  /** File name (required if sourceType is 'file') */
  fileName?: string;
  /** Optional custom data identifier */
  dataId?: string;
  /** Retrieval namespace for the canonical document */
  namespace?: string;
  /** Existing document identifier when updating a published document */
  documentId?: string;
  /** Display metadata to copy onto the published document */
  documentMetadata?: DocumentMetadata;
  /** Parsing configuration */
  parsingParams?: ParsingParams;
  /** Bring-your-own-key LLM credentials for this job */
  llmConfig?: LlmConfig;
  /** Webhook configuration */
  webhook?: WebhookConfig;
}

/**
 * File upload parameters
 */
export interface UploadParams {
  /** File to upload (path, Buffer, Stream, or Uint8Array) */
  file: string | Buffer | ReadStream | Uint8Array;
  /** Upload progress callback */
  onProgress?: (progress: UploadProgress) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Wait options for polling
 */
export interface WaitOptions {
  /** Polling interval in milliseconds (default: 10000) */
  pollInterval?: number;
  /** Maximum wait time in milliseconds (default: 1800000 = 30 minutes) */
  pollTimeout?: number;
  /** Progress callback */
  onProgress?: (status: PollProgress) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Load options for result parsing
 */
export interface LoadOptions {
  /** Whether to verify ZIP checksum (default: true) */
  verifyChecksum?: boolean;
}

/**
 * High-level parse parameters
 */
export interface ParseParams {
  /** Source URL (mutually exclusive with file) */
  url?: string;
  /** File to parse (path, Buffer, Stream, or Uint8Array) */
  file?: string | Buffer | ReadStream | Uint8Array;
  /** File name (auto-inferred for file paths and fs.ReadStream with a path) */
  fileName?: string;
  /** Parsing model (default: 'base') */
  model?: ParsingModel;
  /** Enable OCR (default: false) */
  ocr?: boolean;
  /** Document type hint */
  docType?: DocType;
  /** Enable smart title parsing */
  smartTitleParse?: boolean;
  /** Generate image summaries */
  summaryImage?: boolean;
  /** Generate table summaries */
  summaryTable?: boolean;
  /** Generate text summaries */
  summaryTxt?: boolean;
  /** Custom data identifier */
  dataId?: string;
  /** Retrieval namespace for the canonical document */
  namespace?: string;
  /** Existing document identifier when updating a published document */
  documentId?: string;
  /** Display metadata to copy onto the published document */
  documentMetadata?: DocumentMetadata;
  /** Additional fragment description */
  addFragDesc?: string;
  /** Knowledge base directory */
  kbDir?: string;
  /** Polling interval in milliseconds */
  pollInterval?: number;
  /** Maximum wait time in milliseconds */
  pollTimeout?: number;
  /** Whether to verify ZIP checksum (default: true) */
  verifyChecksum?: boolean;
  /**
   * Optional asset storage adapter used to copy parsed media and page citation
   * assets into application-owned storage before the result is returned.
   */
  storageAdapter?: KnowhereAssetStorageOptions;
  /** Bring-your-own-key LLM credentials for this parse */
  llmConfig?: LlmConfig;
  /** Webhook configuration */
  webhook?: WebhookConfig;
  /** Upload progress callback */
  onUploadProgress?: (progress: UploadProgress) => void;
  /** Poll progress callback */
  onPollProgress?: (status: PollProgress) => void;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Upload progress information
 */
export interface UploadProgress {
  /** Bytes uploaded */
  loaded: number;
  /** Total bytes (may be undefined for streams) */
  total?: number;
  /** Upload percentage (0-100) */
  percent: number;
}

/**
 * Polling progress information
 */
export interface PollProgress {
  /** Current job status */
  status: import('./job.js').JobStatus;
  /** Elapsed time in seconds */
  elapsedSeconds: number;
  /** Current job result */
  jobResult: import('./job.js').JobResult;
}
