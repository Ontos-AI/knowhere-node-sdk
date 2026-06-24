// Main client
export { Knowhere, Knowhere as default } from './client.js';

// Version
export { VERSION } from './version.js';

// Types
export type {
  // Client types
  KnowhereOptions,
  // Job types
  Job,
  JobResult,
  JobStatus,
  JobError,
  // Document types
  Document,
  DocumentChunk,
  DocumentChunkGetParams,
  DocumentChunkListParams,
  DocumentChunkListResponse,
  DocumentChunkPagination,
  DocumentChunkResponse,
  DocumentChunkType,
  DocumentListResponse,
  // Retrieval types
  RetrievalChannel,
  RetrievalFilterMode,
  RetrievalSectionExclusion,
  RetrievalQueryParams,
  RetrievalSource,
  RetrievalResult,
  RetrievalReferencedChunk,
  RetrievalQueryResponse,
  // Parameter types
  ParsingParams,
  ParsingModel,
  DocType,
  WebhookConfig,
  CreateJobParams,
  UploadParams,
  WaitOptions,
  LoadOptions,
  ParseParams,
  UploadProgress,
  PollProgress,
  // Result types
  ParseResult,
  Manifest,
  Statistics,
  FileIndex,
  Chunk,
  BaseChunk,
  TextChunk,
  ImageChunk,
  TableChunk,
  KnowledgeChunkType,
  KnowledgeAsyncJobStatusResponse,
  KnowledgeAsyncParseParams,
  KnowledgeAsyncParseResponse,
  KnowledgeCacheJobResultParams,
  KnowledgeParseParams,
  LocalKnowledgeDocument,
  LocalKnowledgeParseResponse,
  KnowledgeOutline,
  KnowledgeSection,
  KnowledgeReadParams,
  KnowledgeReadChunk,
  KnowledgeReadResponse,
  KnowledgeGrepParams,
  KnowledgeGrepMatch,
  KnowledgeGrepResponse,
  KnowledgeSearchParams,
  KnowledgeSearchReference,
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
  KnowledgeStartupRecoveryResponse,
} from './types/index.js';

// Errors
export {
  // Base errors
  KnowhereError,
  NetworkError,
  TimeoutError,
  PollingTimeoutError,
  ChecksumError,
  ValidationError,
  InvalidStateError,
  // API errors
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
  // Job errors
  JobFailedError,
} from './errors/index.js';

// Resources (for advanced usage)
export { Jobs, Retrieval, Documents } from './resources/index.js';
export { Knowledge, LocalKnowledgeStore } from './knowledge/index.js';
