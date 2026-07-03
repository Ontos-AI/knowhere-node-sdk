import type { ParseParams } from '../types/params.js';
import type { Job, JobResult } from '../types/job.js';
import type {
  Chunk,
  DocumentChunkType,
  PageCitationAsset,
  ParseResult,
} from '../types/index.js';

export type KnowledgeChunkType = DocumentChunkType;

export interface KnowledgeParseParams extends ParseParams {
  /** Optional stable local identifier for this parsed result copy. */
  localDocumentId?: string;
}

export interface LocalKnowledgeDocument {
  /** Stable local identifier used by local outline/read/grep methods. */
  localDocumentId: string;
  /** Server parse job identifier. */
  jobId: string;
  /** Server canonical document identifier when publication returned one. */
  documentId?: string;
  /** Server retrieval namespace when available. */
  namespace?: string;
  /** Original source file name from the parse manifest. */
  sourceFileName: string;
  /** Number of chunks in the locally cached parse result. */
  chunkCount: number;
  /** Chunk counts grouped by type. */
  typeCounts: Record<KnowledgeChunkType, number>;
  /** Local cache directory containing expanded Knowhere result files and assets. */
  resultDirectoryPath: string;
  /** Cache creation time. */
  createdAt: Date;
  /** Last cache write time. */
  updatedAt: Date;
}

export interface LocalKnowledgeParseResponse {
  document: LocalKnowledgeDocument;
  result: ParseResult;
}

export interface KnowledgeAsyncParseParams extends ParseParams {
  /** Optional stable local identifier to use when this job result is cached later. */
  localDocumentId?: string;
}

export interface KnowledgeAsyncParseResponse {
  job: Job;
  localDocumentId?: string;
}

export type KnowledgeAsyncCacheStatus =
  | 'pending'
  | 'cached'
  | 'already_cached'
  | 'untracked'
  | 'not_available'
  | 'failed';

export interface KnowledgeAsyncCacheResult {
  status: KnowledgeAsyncCacheStatus;
  localDocumentId?: string;
  document?: LocalKnowledgeDocument;
  error?: string;
}

export interface KnowledgeAsyncJobStatusResponse {
  job: JobResult;
  cache: KnowledgeAsyncCacheResult;
}

export interface KnowledgeStartupRecoveryResponse {
  checkedJobs: number;
  results: KnowledgeAsyncJobStatusResponse[];
}

export interface KnowledgeCacheJobResultParams {
  jobId: string;
  localDocumentId?: string;
  verifyChecksum?: boolean;
  /** @deprecated Ignored. Page citation assets are provided by the server. */
  pageCitationAssets?: ParseParams['pageCitationAssets'];
}

export interface KnowledgeCacheDocumentParams {
  /** Canonical Knowhere document identifier from published retrieval results. */
  documentId: string;
  /** Optional local cache identifier to use for the localized document copy. */
  localDocumentId?: string;
}

export interface KnowledgeDocumentReference {
  /** Stable local identifier used by cached outline/read/grep methods. */
  localDocumentId?: string;
  /** Canonical Knowhere document identifier from published retrieval results. */
  documentId?: string;
  /** Server parse job identifier whose completed result should be cached before reading. */
  jobId?: string;
}

export interface KnowledgeSection {
  sectionPath: string;
  sectionTitle: string;
  sectionLevel: number;
  summary?: string;
  startChunk?: number;
  endChunk?: number;
  chunkCount: number;
  typeCounts: Record<KnowledgeChunkType, number>;
  children: KnowledgeSection[];
}

export interface KnowledgeOutline {
  document: LocalKnowledgeDocument;
  totalChunks: number;
  typeCounts: Record<KnowledgeChunkType, number>;
  sections: KnowledgeSection[];
  sectionTree: KnowledgeSection[];
}

export interface KnowledgeReadParams extends KnowledgeDocumentReference {
  sectionPath?: string;
  startChunk?: number;
  endChunk?: number;
  chunkId?: string;
  chunkType?: KnowledgeChunkType;
  limit?: number;
}

export interface KnowledgeReadChunk {
  position: number;
  chunkId: string;
  chunkType: KnowledgeChunkType;
  /** Content source marker. Page chunks normally expose summaries as content. */
  contentSource?: string;
  content: string;
  /** Display-safe text. For page chunks this prefers metadata.summary. */
  readableContent: string;
  sectionPath: string;
  sourceChunkPath: string;
  filePath?: string;
  pageNumbers?: number[];
  pageAssets?: readonly PageCitationAsset[];
  metadata: Record<string, unknown>;
}

export interface KnowledgeReadResponse {
  document: LocalKnowledgeDocument;
  chunks: KnowledgeReadChunk[];
  nextChunk?: number;
}

export interface KnowledgeGrepParams extends KnowledgeDocumentReference {
  pattern: string;
  isRegex?: boolean;
  isCaseSensitive?: boolean;
  maxResults?: number;
  chunkType?: KnowledgeChunkType;
  sectionPathPrefix?: string;
  contextChars?: number;
}

export interface KnowledgeGrepMatch {
  position: number;
  chunkId: string;
  chunkType: KnowledgeChunkType;
  sectionPath: string;
  sourceChunkPath: string;
  filePath?: string;
  startOffset: number;
  endOffset: number;
  snippet: string;
}

export interface KnowledgeGrepResponse {
  document: LocalKnowledgeDocument;
  matches: KnowledgeGrepMatch[];
  scannedChunks: number;
  truncated: boolean;
}

export interface KnowledgeSearchParams {
  query: string;
  namespace?: string;
  topK?: number;
  localDocumentIds?: string[];
  useAgentic?: boolean;
}

export interface KnowledgeSearchReference {
  localDocumentId?: string;
  documentId?: string;
  chunkId?: string;
  sectionPath?: string;
  chunkType?: string;
  score?: number | null;
}

export interface KnowledgeSearchResponse {
  namespace?: string;
  query: string;
  evidenceText?: string | null;
  references: KnowledgeSearchReference[];
  results: KnowledgeSearchResult[];
  rawResponse: unknown;
}

export interface KnowledgeSearchResult {
  localDocumentId?: string;
  documentId?: string;
  chunkId?: string;
  chunkType?: string;
  content: string;
  score: number | null;
  sectionPath?: string;
  sourceFileName?: string;
}

export interface IndexedKnowledgeChunk {
  source: Chunk;
  position: number;
  chunkId: string;
  chunkType: KnowledgeChunkType;
  contentSource?: string;
  content: string;
  readableContent: string;
  sectionPath: string;
  sourceChunkPath: string;
  filePath?: string;
  pageNumbers?: number[];
  pageAssets?: readonly PageCitationAsset[];
  metadata: Record<string, unknown>;
}
