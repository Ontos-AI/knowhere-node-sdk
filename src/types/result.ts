import type { PageCitationAsset, PageCitationAssetWarning } from './page-citation-assets.js';

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
  /** Number of page chunks */
  pageChunks?: number;
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
  /** Processing completion date (optional: only present if emitted by the worker) */
  processingDate?: Date;
  /** Worker-side processing metadata emitted by manifest v2 */
  processing?: ProcessingMetadata;
  /** Statistics */
  statistics: Statistics;
  /** Legacy file index from earlier ZIP manifests */
  files?: FileIndex;
  /**
   * Document hierarchy emitted by the current worker.
   *
   * The key remains all-caps at runtime because ``keysToCamel()`` only
   * transforms snake_case keys.
   */
  HIERARCHY?: Record<string, unknown>;
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
 * A single image or table resource entry in ``doc_nav.json``.
 */
export interface DocNavResourceItem {
  path: string;
  summary?: string;
}

/**
 * Image and table resource summaries from ``doc_nav.json``.
 */
export interface DocNavResources {
  images: DocNavResourceItem[];
  tables: DocNavResourceItem[];
}

/**
 * A document section in the ``doc_nav.json`` navigation tree.
 */
export interface DocNavSection {
  title: string;
  path: string;
  level: number;
  summary?: string;
  chunkCount: number;
  children: DocNavSection[];
}

/**
 * Top-level document navigation structure from ``doc_nav.json``.
 */
export interface DocNav {
  sections: DocNavSection[];
  resources?: DocNavResources;
}

/**
 * Known worker metadata fields for a chunk.
 *
 * All fields are optional.  Unknown fields added by future worker
 * versions are accessible through the index signature.
 */
export interface ChunkMetadata {
  length?: number;
  pageNums?: number[];
  entities?: Record<string, unknown>[];
  tokens?: string[];
  keywords?: string[];
  summary?: string;
  connectTo?: ConnectTo[];
  filePath?: string;
  originalName?: string;
  tableType?: string;
  documentTopSummary?: string;
  /** Allow forward-compatible access to unknown fields. */
  [key: string]: unknown;
}

/**
 * Base chunk properties
 */
export interface BaseChunk {
  /** Unique chunk identifier */
  chunkId: string;
  /** Chunk type */
  type: 'text' | 'image' | 'table' | 'page';
  /** Content source marker. Page chunks normally expose summaries as content. */
  contentSource?: string;
  /** Main content */
  content: string;
  /** Relative path in ZIP */
  path: string;
  /** Worker metadata for this chunk */
  metadata: ChunkMetadata;
}

/**
 * Minimal chunk representation emitted in chunks_slim.json (legacy).
 */
export interface SlimChunk {
  type: 'text' | 'image' | 'table' | 'page';
  path: string;
  content: string;
}

/**
 * Text chunk
 */
export interface TextChunk extends BaseChunk {
  type: 'text';
}

/**
 * Image chunk
 */
export interface ImageChunk extends BaseChunk {
  type: 'image';
  /** Relative file path in ZIP */
  filePath: string;
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
  /** Relative file path in ZIP */
  filePath: string;
  /** HTML representation */
  html: string;
  /** Save table HTML to disk */
  save(directory: string): Promise<string>;
}

/**
 * Page chunk
 */
export interface PageChunk extends BaseChunk {
  type: 'page';
  /** Rendered source-page citation assets attached by the SDK when requested. */
  pageAssets?: readonly PageCitationAsset[];
}

/**
 * Union type of all chunk types
 */
export type Chunk = TextChunk | ImageChunk | TableChunk | PageChunk;

/**
 * Complete parse result
 */
export interface ParseResult {
  /** Manifest metadata */
  manifest: Manifest;
  /** All chunks */
  chunks: Chunk[];
  /** Document navigation tree from doc_nav.json (current worker output) */
  docNav?: DocNav;
  /** Full document as Markdown (if available) */
  fullMarkdown?: string;
  /** Raw ZIP buffer */
  rawZip: Buffer;
  /** Non-fatal page citation asset diagnostics emitted by SDK-side generation. */
  pageCitationAssetWarnings?: readonly PageCitationAssetWarning[];

  // Legacy — the current worker no longer emits these files
  /** @deprecated Current worker no longer emits chunks_slim.json */
  chunksSlim?: SlimChunk[];
  /** @deprecated Current worker no longer emits hierarchy.json */
  hierarchy?: unknown;
  /** @deprecated Table-of-contents hierarchy hints (if available) */
  tocHierarchies?: unknown;
  /** @deprecated Knowledge-base CSV export (if available) */
  kbCsv?: string;
  /** @deprecated Pre-rendered hierarchy HTML view (if available) */
  hierarchyViewHtml?: string;

  /** Text chunks only */
  readonly textChunks: TextChunk[];
  /** Image chunks only */
  readonly imageChunks: ImageChunk[];
  /** Table chunks only */
  readonly tableChunks: TableChunk[];
  /** Page chunks only */
  readonly pageChunks: PageChunk[];
  /** Job ID */
  readonly jobId: string;
  /** Effective retrieval namespace when loaded from a job result */
  namespace?: string;
  /** Canonical document identifier when loaded from a job result */
  documentId?: string;
  /** Statistics */
  readonly statistics: Statistics;

  /** Find a specific chunk by ID */
  getChunk(chunkId: string): Chunk | undefined;
  /** Save all results to a directory */
  save(directory: string): Promise<string>;
}
