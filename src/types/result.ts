/**
 * Statistics about the parsed document
 */
export interface Statistics {
  /** Total number of chunks */
  totalChunks: number;
  /** Number of text chunks */
  textChunks: number;
  /** Number of image chunks */
  imageChunks: number;
  /** Number of table chunks */
  tableChunks: number;
  /** Total number of pages (if applicable) */
  totalPages?: number;
}

/**
 * File index mapping chunk IDs to file paths
 */
export interface FileIndex {
  [chunkId: string]: string;
}

/**
 * Processing cost details emitted by manifest v2
 */
export interface ProcessingCost {
  microDollars?: number;
  credits?: number;
}

/**
 * Processing timing details emitted by manifest v2
 */
export interface ProcessingTiming {
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
}

/**
 * Processing metadata emitted by manifest v2
 */
export interface ProcessingMetadata {
  pageCount?: number;
  billingStatus?: string;
  cost?: ProcessingCost;
  timing?: ProcessingTiming;
}

/**
 * Manifest containing metadata about the parse result
 */
export interface Manifest {
  /** Manifest version */
  version: string;
  /** Job ID */
  jobId: string;
  /** Custom data ID */
  dataId?: string;
  /** Original source file name */
  sourceFileName: string;
  /** Processing completion date */
  /** Processing completion date (optional: only present if emitted by the worker) */
  processingDate?: Date;
  /** Worker-side processing metadata emitted by manifest v2 */
  processing?: ProcessingMetadata;
  /** Statistics */
  statistics: Statistics;
  /** Legacy file index from earlier ZIP manifests */
  files?: FileIndex;
}

/**
 * Chunk relationship entry (metadata.connect_to per schema v2.1)
 */
export interface ConnectTo {
  /** Target chunk_id */
  target: string;
  /** Relationship type */
  relation: 'embeds' | 'related';
  /** Placeholder ref in content, e.g. '[images/a.png]' (embeds only) */
  ref?: string;
  /** Semantic similarity score (related only) */
  score?: number;
  /** Shared keywords (related only) */
  keywords?: string[];
}

/**
 * Base chunk properties
 */
export interface BaseChunk {
  /** Unique chunk identifier */
  chunkId: string;
  /** Chunk type */
  type: 'text' | 'image' | 'table';
  /** Main content */
  content: string;
  /** Relative path in ZIP */
  path: string;
  /** Page numbers spanned by this chunk when provided by the backend */
  pageNums?: number[];
}

/**
 * Minimal chunk representation emitted in chunks_slim.json
 */
export interface SlimChunk {
  type: 'text' | 'image' | 'table';
  path: string;
  content: string;
  summary?: string;
}

/**
 * Text chunk
 */
export interface TextChunk extends BaseChunk {
  type: 'text';
  /** Content length */
  length: number;
  /** Extracted tokens from the current backend payload */
  tokens?: string[];
  /** Extracted keywords */
  keywords?: string[];
  /** Generated summary */
  summary?: string;
  /** Chunk relationships (schema v2.1: metadata.connect_to) */
  connectTo?: ConnectTo[];
  /**
   * @deprecated Use connectTo instead. Retained for backward compatibility.
   * Previously populated from metadata.relationships which is no longer emitted by the API.
   */
  relationships?: string[];
}

/**
 * Image chunk
 */
export interface ImageChunk extends BaseChunk {
  type: 'image';
  /** Content length */
  length: number;
  /** Relative file path in ZIP */
  filePath: string;
  /** Generated summary */
  summary?: string;
  /** Image data buffer */
  data: Buffer;
  /** Image format (derived from file extension) */
  readonly format: string;
  /** Save image to disk */
  save(directory: string): Promise<string>;
}

/**
 * Table chunk
 */
export interface TableChunk extends BaseChunk {
  type: 'table';
  /** Content length */
  length: number;
  /** Relative file path in ZIP */
  filePath: string;
  /** Table type */
  tableType?: string;
  /** Generated summary */
  summary?: string;
  /** HTML representation */
  html: string;
  /** Save table HTML to disk */
  save(directory: string): Promise<string>;
}

/**
 * Union type of all chunk types
 */
export type Chunk = TextChunk | ImageChunk | TableChunk;

/**
 * Complete parse result
 */
export interface ParseResult {
  /** Manifest metadata */
  manifest: Manifest;
  /** All chunks */
  chunks: Chunk[];
  /** Minimal chunk projection from chunks_slim.json (if available) */
  chunksSlim?: SlimChunk[];
  /** Full document as Markdown (if available) */
  fullMarkdown?: string;
  /** Document hierarchy (if available) */
  hierarchy?: unknown;
  /** Table-of-contents hierarchy hints (if available) */
  tocHierarchies?: unknown;
  /** Knowledge-base CSV export (if available) */
  kbCsv?: string;
  /** Pre-rendered hierarchy HTML view (if available) */
  hierarchyViewHtml?: string;
  /** Raw ZIP buffer */
  rawZip: Buffer;

  /** Text chunks only */
  readonly textChunks: TextChunk[];
  /** Image chunks only */
  readonly imageChunks: ImageChunk[];
  /** Table chunks only */
  readonly tableChunks: TableChunk[];
  /** Job ID */
  readonly jobId: string;
  /** Statistics */
  readonly statistics: Statistics;

  /** Find a specific chunk by ID */
  getChunk(chunkId: string): Chunk | undefined;
  /** Save all results to a directory */
  save(directory: string): Promise<string>;
}
