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
 * Retrieval query parameters.
 */
export interface RetrievalQueryParams {
  /** Search query text */
  query: string;
  /** Retrieval namespace. Defaults to the server's default namespace when omitted. */
  namespace?: string;
  /** Maximum number of results to return */
  topK?: number;
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
  documentId?: string;
  /** Original source file name */
  sourceFileName?: string;
  /** Human-readable section path */
  sectionPath?: string;
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
 * Response from POST /v1/retrieval/query.
 */
export interface RetrievalQueryResponse {
  /** Namespace searched by the API */
  namespace: string;
  /** Echoed query text */
  query: string;
  /** Ranked retrieval results */
  results: RetrievalResult[];
}
