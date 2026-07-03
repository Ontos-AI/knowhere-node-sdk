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
