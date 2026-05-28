/**
 * Section exclusion for follow-up retrieval queries.
 */
export interface RetrievalSectionExclusion {
  /** Document containing the section to exclude */
  documentId: string;
  /** Human-readable section path to exclude */
  sectionPath: string;
}

/**
 * Supported retrieval channel names.
 */
export type RetrievalChannel = 'path' | 'content' | 'term';

/**
 * Path filtering mode for retrieval queries.
 */
export type RetrievalFilterMode = 'delete' | 'keep';

/**
 * Retrieval query parameters.
 */
export interface RetrievalQueryParams {
  /** Search query text */
  query: string;
  /** Retrieval namespace. Defaults to the server's default namespace when omitted. */
  namespace?: string;
  /** Maximum number of results to return */
  topK?: number;
  /**
   * Force retrieval mode.
   *
   * - ``true``  — agentic (LLM navigation + answer synthesis)
   * - ``false`` — legacy 3-channel RRF only
   * - ``undefined`` / omitted — server default
   */
  useAgentic?: boolean;
  /** Chunk type filter: 1=all, 2=text, 3=image, 4=table, 5=text+image, 6=text+table */
  dataType?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Path keywords for include/exclude filtering */
  signalPaths?: string[];
  /** Signal path filter mode */
  filterMode?: RetrievalFilterMode;
  /** Retrieval channels to run. Defaults to all channels when omitted. */
  channels?: RetrievalChannel[];
  /** Per-channel weight overrides for reciprocal-rank fusion */
  channelWeights?: Partial<Record<RetrievalChannel, number>>;
  /** Enable LLM reranking after channel fusion */
  rerank?: boolean;
  /** Minimum retrieval score threshold after fusion */
  threshold?: number;
  /** Override the internal per-channel recall count */
  internalRecallK?: number;
  /** Documents to exclude for this request only */
  excludeDocumentIds?: string[];
  /** Document sections to exclude for this request only */
  excludeSections?: RetrievalSectionExclusion[];
}

/**
 * Caller-facing source reference attached to a retrieval result.
 */
export interface RetrievalSource {
  /** Stable document identifier */
  documentId?: string | null;
  /** Original source file name */
  sourceFileName?: string | null;
  /** Human-readable section path */
  sectionPath?: string | null;
}

/**
 * Canonical chunk result returned by retrieval query.
 */
export interface RetrievalResult {
  /** Knowledge content to use directly in the caller's answer */
  content: string;
  /** Chunk type, for example text, image, or table */
  chunkType: string;
  /** Retrieval score returned by the API */
  score: number;
  /** Presigned asset URL for media chunks when available */
  assetUrl?: string;
  /** Source reference for this result */
  source: RetrievalSource;
}

/**
 * Cited evidence chunk returned by agentic retrieval.
 */
export interface RetrievalReferencedChunk {
  /** Parser-provided chunk identifier */
  chunkId: string;
  /** Stable document identifier */
  documentId: string;
  /** Chunk type, for example text, image, or table */
  chunkType: string;
  /** Human-readable section path */
  sectionPath: string;
  /** Generated artifact file path for media chunks */
  filePath?: string | null;
  /** Published job identifier for the referenced chunk */
  jobId?: string | null;
  /** Presigned asset URL for media chunks when available */
  assetUrl?: string | null;
}

/**
 * Response from POST /v1/retrieval/query.
 */
export interface RetrievalQueryResponse {
  /** Namespace searched by the API */
  namespace: string;
  /** Echoed query text */
  query: string;
  /** Retrieval router path used by the API for this query */
  routerUsed: string;
  /** LLM-generated natural-language answer, or null when no answer was produced */
  answerText: string | null;
  /** Cited evidence chunks with asset URLs when available */
  referencedChunks: RetrievalReferencedChunk[];
  /** Rendered evidence context used by agentic answer synthesis */
  evidenceText?: string;
  /** Agentic termination reason when provided by the API */
  stopReason?: string;
  /** Semantic failure reason when no answer could be produced */
  failureReason?: string;
  /** Ranked retrieval results */
  results: RetrievalResult[];
}
