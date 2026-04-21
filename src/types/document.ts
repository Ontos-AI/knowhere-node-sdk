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
  /** Document creation timestamp */
  createdAt?: Date;
  /** Last update timestamp */
  updatedAt?: Date;
  /** Archive timestamp, when archived */
  archivedAt?: Date;
}

/**
 * Response from GET /v1/documents.
 */
export interface DocumentListResponse {
  /** Namespace listed by the API */
  namespace: string;
  /** Documents visible in the namespace */
  documents: Document[];
}
