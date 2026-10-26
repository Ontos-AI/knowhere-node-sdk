import type { ParseResult } from './result.js';

export type KnowhereAssetStorageBody = Uint8Array;

export interface KnowhereAssetStorageObject {
  readonly key: string;
  readonly body: KnowhereAssetStorageBody;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface KnowhereAssetStorageHead {
  readonly key: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly url?: string;
}

export interface KnowhereAssetStorageWriteResult {
  readonly key: string;
  readonly url?: string;
}

export interface KnowhereAssetStorageAdapter {
  writeObject(input: KnowhereAssetStorageObject): Promise<KnowhereAssetStorageWriteResult>;
  headObject?(key: string): Promise<KnowhereAssetStorageHead | null>;
  getObjectUrl?(key: string): Promise<string | null>;
}

export interface KnowhereAssetStorageOptions {
  readonly adapter: KnowhereAssetStorageAdapter;
  readonly keyPrefix: string;
  readonly skipExisting?: boolean;
}

export interface KnowhereAssetStorageResult {
  readonly result: ParseResult;
  readonly assetUrlsByFilePath: Readonly<Record<string, string>>;
}

export interface ParsedDocumentStorageDocument {
  readonly documentId: string;
  readonly revisionKey: string;
}

export type ParsedDocumentRevisionParams = ParsedDocumentStorageDocument;

export interface ParsedDocumentObjectParams extends ParsedDocumentRevisionParams {
  readonly path: string;
}

export interface ParsedDocumentObjectHead extends ParsedDocumentObjectParams {
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly url?: string;
}

export interface ParsedDocumentObject extends ParsedDocumentObjectHead {
  readonly body: KnowhereAssetStorageBody;
}

export interface ParsedDocumentWriteObjectParams extends ParsedDocumentObjectParams {
  readonly body: KnowhereAssetStorageBody;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Stream sinks must consume the body before resolving and reject partial writes. */
export interface ParsedDocumentWriteObjectStreamParams extends Omit<
  ParsedDocumentWriteObjectParams,
  'body'
> {
  readonly body: ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface ParsedDocumentWriteObjectResult extends ParsedDocumentObjectParams {
  readonly url?: string;
}

export type ParsedDocumentCommitSource = 'resultZip' | 'remoteReconstruction';

export interface ParsedDocumentCommit {
  readonly snapshotId?: string;
  readonly jobResultId?: string;
  readonly checksum?: string;
  readonly stage?: 'baseline' | 'final';
  readonly version: 1;
  readonly documentId: string;
  readonly revisionKey: string;
  readonly source: ParsedDocumentCommitSource;
  readonly committedAt: string;
}

export interface ParsedDocumentSyncProgress {
  readonly documentId: string;
  readonly revisionKey: string;
  readonly snapshotChecksum?: string;
  readonly upstreamJobResultId?: string;
  readonly nextChunkPage?: number;
  readonly pinnedRevisionKey?: string;
  readonly archiveIdentity?: string;
  readonly nextArchiveEntry?: number;
  /** Content hashes for verifying a sequential retry without a strong HTTP validator. */
  readonly archiveEntryHashes?: readonly string[];
  readonly status: 'running' | 'completed' | 'failed';
  readonly updatedAt: string;
  readonly error?: string;
}

export interface ParsedDocumentStorage {
  readObject(params: ParsedDocumentObjectParams): Promise<ParsedDocumentObject | null>;
  writeObject(params: ParsedDocumentWriteObjectParams): Promise<ParsedDocumentWriteObjectResult>;
  writeObjectStream?(
    params: ParsedDocumentWriteObjectStreamParams,
  ): Promise<ParsedDocumentWriteObjectResult>;
  headObject?(params: ParsedDocumentObjectParams): Promise<ParsedDocumentObjectHead | null>;
  getObjectUrl?(params: ParsedDocumentObjectParams): Promise<string | null>;
  deletePrefix?(params: ParsedDocumentRevisionParams): Promise<void>;
  readSyncProgress(
    params: ParsedDocumentRevisionParams,
  ): Promise<ParsedDocumentSyncProgress | null>;
  writeSyncProgress(params: ParsedDocumentSyncProgress): Promise<void>;
}

export interface ParsedDocumentSyncScheduler {
  schedule(task: () => Promise<void>): void | Promise<void>;
}

export interface ParsedDocumentStorageLimits {
  /** ZIP entries copied per invocation (default 100). */
  readonly maxEntriesPerSync?: number;
  /** ZIP copy budget checked between entries (default 120000ms). */
  readonly archiveSyncDeadlineMs?: number;
  readonly remotePageSize?: number;
  readonly maxPagesPerSync?: number;
  readonly syncDeadlineMs?: number;
  readonly grepMaxPages?: number;
  readonly grepDeadlineMs?: number;
  readonly outlineMaxPages?: number;
  readonly outlineDeadlineMs?: number;
}

export interface ParsedDocumentStorageConfig {
  readonly storage: ParsedDocumentStorage;
  readonly scheduler?: ParsedDocumentSyncScheduler;
  readonly limits?: ParsedDocumentStorageLimits;
}
