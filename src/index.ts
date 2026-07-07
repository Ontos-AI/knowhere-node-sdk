// Main client
export { Knowhere, Knowhere as default } from './client.js';

// Version
export { VERSION } from './version.js';

// Types
export type {
  // Client types
  AuthTokenProvider,
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
  DocumentPageCitationSource,
  DocumentListPagination,
  DocumentListParams,
  DocumentListResponse,
  // Retrieval types
  RetrievalChannel,
  RetrievalChunkType,
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
  DocumentMetadata,
  WebhookConfig,
  CreateJobParams,
  UploadParams,
  WaitOptions,
  LoadOptions,
  ParseParams,
  UploadProgress,
  PollProgress,
  KnowhereAssetStorageAdapter,
  KnowhereAssetStorageBody,
  KnowhereAssetStorageHead,
  KnowhereAssetStorageObject,
  KnowhereAssetStorageOptions,
  KnowhereAssetStorageResult,
  KnowhereAssetStorageWriteResult,
  ParsedDocumentCommit,
  ParsedDocumentCommitSource,
  ParsedDocumentObject,
  ParsedDocumentObjectHead,
  ParsedDocumentObjectParams,
  ParsedDocumentStorage,
  ParsedDocumentStorageConfig,
  ParsedDocumentStorageDocument,
  ParsedDocumentStorageLimits,
  ParsedDocumentRevisionParams,
  ParsedDocumentSyncProgress,
  ParsedDocumentSyncScheduler,
  ParsedDocumentWriteObjectParams,
  ParsedDocumentWriteObjectResult,
  PageCitationAsset,
  PageCitationAssetContentType,
  PageCitationAssetSource,
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
  PageChunk,
  KnowledgeChunkType,
  KnowledgeAsyncJobStatusResponse,
  KnowledgeAsyncParseParams,
  KnowledgeAsyncParseResponse,
  KnowledgeCacheDocumentParams,
  KnowledgeCacheJobResultParams,
  KnowledgeDocumentReference,
  KnowledgeImportJobResultParams,
  KnowledgeJobResultResponse,
  KnowledgeLoadJobResultParams,
  KnowledgeParseParams,
  LocalKnowledgeDocument,
  LocalKnowledgeParseResponse,
  KnowledgeOutline,
  KnowledgeSection,
  KnowledgeParsedStorageOptions,
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
  KnowledgeSyncParsedDocumentParams,
  KnowledgeSyncParsedDocumentResponse,
} from './types/index.js';

export { storeParseResultAssets } from './storage/asset-storage.js';
export { DiskParsedDocumentStorage } from './storage/disk-parsed-document-storage.js';
export { syncParseResultToParsedDocumentStorage } from './storage/parsed-document-storage.js';

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
