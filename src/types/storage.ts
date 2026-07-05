import type { ParseResult } from './result.js';
import type { DocumentChunkType } from './document.js';

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
  readonly chunkPageSize?: number;
  readonly revisionKey?: string;
}

export interface KnowhereParsedSnapshotChunk {
  readonly id: string;
  readonly chunkId: string;
  readonly chunkType: string;
  readonly contentSource?: string;
  readonly content: string;
  readonly sectionPath?: string;
  readonly sourceChunkPath: string;
  readonly filePath?: string;
  readonly sortOrder: number;
  readonly metadata: Record<string, unknown>;
  readonly assetUrl?: string;
}

export interface KnowhereParsedSnapshotChunkPage {
  readonly version: 1;
  readonly jobId: string;
  readonly revisionKey?: string;
  readonly documentId?: string;
  readonly namespace?: string;
  readonly sourceFileName: string;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly chunks: readonly KnowhereParsedSnapshotChunk[];
}

export interface KnowhereParsedSnapshotChunkPageReference {
  readonly page: number;
  readonly pageSize: number;
  readonly chunkCount: number;
  readonly key: string;
  readonly url?: string;
}

export interface KnowhereParsedSnapshotManifest {
  readonly version: 1;
  readonly kind: 'knowhere-parsed-result-snapshot';
  readonly jobId: string;
  readonly revisionKey?: string;
  readonly documentId?: string;
  readonly namespace?: string;
  readonly sourceFileName: string;
  readonly totalChunks: number;
  readonly typeCounts?: Readonly<Partial<Record<DocumentChunkType, number>>>;
  readonly chunkPageSize: number;
  readonly chunkPages: readonly KnowhereParsedSnapshotChunkPageReference[];
  readonly assetUrlsByFilePath: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface KnowhereParsedSnapshot {
  readonly manifest: KnowhereParsedSnapshotManifest;
  readonly manifestKey: string;
  readonly manifestUrl?: string;
  readonly indexKey: string;
  readonly indexUrl?: string;
  readonly chunkPageUrlsByPage: Readonly<Record<number, string>>;
}

export interface KnowhereAssetStorageResult {
  readonly result: ParseResult;
  readonly assetUrlsByFilePath: Readonly<Record<string, string>>;
  readonly snapshot?: KnowhereParsedSnapshot;
}

export type ParsedDocumentAssetUrlPolicy = 'none' | 'durable';

export interface ParsedDocumentStorageDocument {
  readonly documentId: string;
  readonly revisionKey: string;
}

export type ParsedDocumentStorageManifestParams = ParsedDocumentStorageDocument;

export interface ParsedDocumentStorageChunkPageParams extends ParsedDocumentStorageDocument {
  readonly page: number;
  readonly chunkType?: DocumentChunkType;
}

export interface ParsedDocumentStorageAsset {
  readonly sourcePath: string;
  readonly body: KnowhereAssetStorageBody;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ParsedDocumentStorageAssetParams extends ParsedDocumentStorageDocument {
  readonly sourcePath: string;
}

export interface ParsedDocumentSyncProgress {
  readonly documentId: string;
  readonly revisionKey: string;
  readonly nextChunkPage: number;
  readonly nextAssetIndex: number;
  readonly status: 'running' | 'completed' | 'failed';
  readonly updatedAt: string;
  readonly error?: string;
}

export interface ParsedDocumentStorage {
  readManifest(
    params: ParsedDocumentStorageManifestParams,
  ): Promise<KnowhereParsedSnapshotManifest | null>;
  writeManifest(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly manifest: KnowhereParsedSnapshotManifest;
  }): Promise<void>;
  readChunkPage(
    params: ParsedDocumentStorageChunkPageParams,
  ): Promise<KnowhereParsedSnapshotChunkPage | null>;
  writeChunkPage(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly page: KnowhereParsedSnapshotChunkPage;
  }): Promise<void>;
  writeAsset(params: ParsedDocumentStorageDocument & ParsedDocumentStorageAsset): Promise<{
    readonly sourcePath: string;
    readonly url?: string;
  }>;
  getAssetUrl(params: ParsedDocumentStorageAssetParams): Promise<string | null>;
  readSyncProgress(
    params: ParsedDocumentStorageDocument,
  ): Promise<ParsedDocumentSyncProgress | null>;
  writeSyncProgress(params: ParsedDocumentSyncProgress): Promise<void>;
}

export interface ParsedDocumentSyncScheduler {
  schedule(task: () => Promise<void>): void | Promise<void>;
}

export interface ParsedDocumentStorageLimits {
  readonly chunkPageSize?: number;
  readonly remotePageSize?: number;
  readonly maxPagesPerSync?: number;
  readonly maxAssetsPerSync?: number;
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
