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
  readonly chunkPageSize?: number;
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
  readonly documentId?: string;
  readonly namespace?: string;
  readonly sourceFileName: string;
  readonly totalChunks: number;
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
