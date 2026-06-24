import type { ParseParams } from '../types/params.js';
import type { Job, JobResult } from '../types/job.js';
import type { Chunk, DocumentChunkType, ParseResult } from '../types/index.js';

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
  /** Local cache file path for the raw parse-result ZIP. */
  resultZipPath: string;
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

export interface KnowledgeAsyncJobStatusResponse {
  job: JobResult;
}

export interface KnowledgeCacheJobResultParams {
  jobId: string;
  localDocumentId?: string;
  verifyChecksum?: boolean;
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

export interface KnowledgeReadParams {
  localDocumentId: string;
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
  content: string;
  sectionPath: string;
  sourceChunkPath: string;
  filePath?: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeReadResponse {
  document: LocalKnowledgeDocument;
  chunks: KnowledgeReadChunk[];
  nextChunk?: number;
}

export interface KnowledgeGrepParams {
  localDocumentId: string;
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
  useRemote?: boolean;
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
  content: string;
  sectionPath: string;
  sourceChunkPath: string;
  filePath?: string;
  metadata: Record<string, unknown>;
}
