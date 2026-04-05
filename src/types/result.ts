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
  processingDate: Date;
  /** Statistics */
  statistics: Statistics;
  /** File index */
  files: FileIndex;
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
}

/**
 * Text chunk
 */
export interface TextChunk extends BaseChunk {
  type: 'text';
  /** Content length */
  length: number;
  /** Tokens or token count, depending on backend payload */
  tokens?: number | string[];
  /** Extracted keywords */
  keywords?: string[];
  /** Generated summary */
  summary?: string;
  /** Related chunk IDs */
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
  /** Full document as Markdown (if available) */
  fullMarkdown?: string;
  /** Document hierarchy (if available) */
  hierarchy?: unknown;
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
