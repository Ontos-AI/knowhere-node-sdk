/**
 * Canonical document state returned by document lifecycle endpoints.
 */
export interface Document {
  /** Stable document identifier */
  documentId: string;
  /** Retrieval namespace */
  namespace: string;
  /** Current lifecycle status */
  status: string;
  /** Current published job result identifier */
  currentJobResultId?: string;
  /** Original source file name */
  sourceFileName?: string;
  /** Client-provided display metadata copied from the publishing job */
  documentMetadata?: Record<string, unknown>;
  /** Document creation timestamp */
  createdAt?: Date;
  /** Last update timestamp */
  updatedAt?: Date;
  /** Archive timestamp, when archived */
  archivedAt?: Date;
}

/**
 * Pagination metadata returned by document list endpoints.
 */
export interface DocumentListPagination {
  /** Current page number */
  page: number;
  /** Number of items requested per page */
  pageSize: number;
  /** Total matching documents */
  total: number;
  /** Total number of pages */
  totalPages: number;
}

/**
 * Query parameters for GET /v2/documents.
 */
export interface DocumentListParams {
  /** Retrieval namespace */
  namespace?: string;
  /** Page number (default: 1) */
  page?: number;
  /** Items per page (default: 50, maximum: 200) */
  pageSize?: number;
}

/**
 * Response from GET /v2/documents.
 */
export interface DocumentListResponse {
  /** Namespace listed by the API */
  namespace: string;
  /** Documents visible in the namespace */
  documents: Document[];
  /** Pagination metadata */
  pagination: DocumentListPagination;
}

/** A revision-fenced read of the initial directory; this never triggers refinement. */
export interface DocumentDirectoryParams {
  readonly jobResultId?: string;
  readonly namespace?: string;
}

/** One recognized chapter, including descendants available before Fine. */
export interface DocumentDirectorySection {
  readonly sectionId: string;
  readonly parentSectionId: string | null;
  readonly sectionPath: string;
  readonly sectionTitle: string | null;
  readonly sectionLevel: number;
  readonly sortOrder: number;
  /** Physical source pages, starting at one. */
  readonly pageNums: readonly number[];
}

/** Immutable initial directory. Version zero explicitly means not ready yet. */
export interface DocumentDirectoryResponse {
  readonly documentId: string;
  readonly jobId: string;
  readonly jobResultId: string;
  readonly namespace: string;
  readonly directoryVersion: 0 | 1;
  readonly directoryCommittedAt: Date | null;
  readonly sections: readonly DocumentDirectorySection[];
}

/** Raw webhook JSON, delivered independently of parse completion and Fine. */
export interface DocumentDirectoryReadyEvent {
  readonly event: 'job.document.directory_ready';
  readonly event_id: string;
  readonly status: 'completed';
  readonly job_id: string;
  readonly document_id: string;
  readonly job_result_id: string;
  readonly namespace: string;
  readonly directory_version: 1;
  readonly directory_committed_at: string;
  readonly completed_at: string;
}

/**
 * Document chunk types supported by document chunk endpoints.
 */
export type DocumentChunkType = 'text' | 'image' | 'table' | 'page';

/**
 * Pagination metadata returned by chunk list endpoints.
 */
export interface DocumentChunkPagination {
  /** Current page number */
  page: number;
  /** Number of items requested per page */
  pageSize: number;
  /** Total matching chunks */
  total: number;
  /** Total number of pages */
  totalPages: number;
}

/**
 * Query parameters for GET /v2/documents/{document_id}/chunks.
 */
export interface DocumentChunkListParams {
  /** Page number (default: 1) */
  page?: number;
  /** Items per page (default: 50, maximum: 200) */
  pageSize?: number;
  /** Optional chunk type filter */
  chunkType?: DocumentChunkType;
  /** Set true to include 7-day asset URLs for media and page citation assets */
  includeAssetUrls?: boolean;
}

/**
 * Query parameters for GET /v2/documents/{document_id}/chunks/{document_chunk_id}.
 */
export interface DocumentChunkGetParams {
  /** Set true to include 7-day asset URLs for media and page citation assets */
  includeAssetUrls?: boolean;
}

/**
 * One current-revision document chunk.
 */
export interface DocumentChunk {
  /** Stable document chunk row identifier */
  id: string;
  /** Parser-provided chunk identifier */
  chunkId: string;
  /** Chunk content type */
  chunkType: DocumentChunkType;
  /** Content source marker. Page chunks normally expose summaries as content. */
  contentSource?: string | null;
  /** Chunk text or generated summary content */
  content?: string | null;
  /** Parent section identifier */
  sectionId?: string | null;
  /** Parent section path */
  sectionPath?: string | null;
  /** Source path from the parser output */
  sourceChunkPath?: string | null;
  /** Generated artifact file path for media chunks */
  filePath?: string | null;
  /** Sort order within the document revision */
  sortOrder: number;
  /** Chunk metadata returned by the API */
  metadata: Record<string, unknown>;
  /** 7-day asset URL for media or page citation assets when available */
  assetUrl?: string | null;
  /** Chunk creation timestamp */
  createdAt?: Date;
}

/**
 * Response from GET /v2/documents/{document_id}/files/page-citation-source.
 */
export interface DocumentPageCitationSource {
  documentId: string;
  namespace?: string;
  jobId?: string;
  jobResultId?: string;
  variant?: string;
  fileName: string;
  contentType: string;
  url: string;
  expiresAt?: Date;
}

/**
 * Response from GET /v2/documents/{document_id}/chunks.
 */
export interface DocumentChunkListResponse {
  /** Stable document identifier */
  documentId: string;
  /** Retrieval namespace */
  namespace: string;
  /** Current published job result identifier */
  jobResultId?: string | null;
  /** Current published job identifier */
  jobId?: string | null;
  /** Current-revision chunks */
  chunks: DocumentChunk[];
  /** Pagination metadata */
  pagination: DocumentChunkPagination;
}

/**
 * Response from GET /v2/documents/{document_id}/chunks/{document_chunk_id}.
 */
export interface DocumentChunkResponse {
  /** Stable document identifier */
  documentId: string;
  /** Retrieval namespace */
  namespace: string;
  /** Current published job result identifier */
  jobResultId?: string | null;
  /** Current published job identifier */
  jobId?: string | null;
  /** Requested current-revision chunk */
  chunk: DocumentChunk;
}
