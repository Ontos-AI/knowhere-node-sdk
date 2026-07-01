import type { ApiVersionOptions } from './params.js';

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
 * Query parameters for GET /v1/documents.
 */
export interface DocumentListParams extends ApiVersionOptions {
  /** Retrieval namespace */
  namespace?: string;
  /** Page number (default: 1) */
  page?: number;
  /** Items per page (default: 50, maximum: 200) */
  pageSize?: number;
}

/**
 * Response from GET /v1/documents.
 */
export interface DocumentListResponse {
  /** Namespace listed by the API */
  namespace: string;
  /** Documents visible in the namespace */
  documents: Document[];
  /** Pagination metadata */
  pagination: DocumentListPagination;
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
 * Query parameters for GET /v1/documents/{document_id}/chunks.
 */
export interface DocumentChunkListParams extends ApiVersionOptions {
  /** Page number (default: 1) */
  page?: number;
  /** Items per page (default: 50, maximum: 200) */
  pageSize?: number;
  /** Optional chunk type filter */
  chunkType?: DocumentChunkType;
  /** Set true to include 7-day asset URLs for media chunks */
  includeAssetUrls?: boolean;
}

/**
 * Query parameters for GET /v1/documents/{document_id}/chunks/{document_chunk_id}.
 */
export interface DocumentChunkGetParams extends ApiVersionOptions {
  /** Set true to include 7-day asset URLs for media chunks */
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
  /** 7-day asset URL for media chunks when available */
  assetUrl?: string | null;
  /** Chunk creation timestamp */
  createdAt?: Date;
}

/**
 * Response from GET /v1/documents/{document_id}/chunks.
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
 * Response from GET /v1/documents/{document_id}/chunks/{document_chunk_id}.
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
