export type PageCitationAssetMimeType = 'image/png' | 'image/jpeg';

export type PageCitationAssetSource = 'client-rendered-pdf-page';

export interface PageCitationAsset {
  pageNum: number;
  key: string;
  assetUrl?: string;
  mimeType: PageCitationAssetMimeType;
  width: number;
  height: number;
  source: PageCitationAssetSource;
  variant: string;
}

export type PageCitationAssetWarningCode =
  | 'missing_document_id'
  | 'invalid_page_number'
  | 'source_fetch_failed'
  | 'renderer_unavailable'
  | 'render_failed'
  | 'storage_failed'
  | 'render_limit_exceeded'
  | 'index_write_failed';

export interface PageCitationAssetWarning {
  code: PageCitationAssetWarningCode;
  message: string;
  documentId?: string;
  jobId?: string;
  chunkId?: string;
  pageNum?: number;
  key?: string;
  cause?: string;
}

export interface PageCitationAssetTimeoutOptions {
  totalMs?: number;
  sourceFetchMs?: number;
  pageRenderMs?: number;
  storageOperationMs?: number;
}

export interface PageCitationAssetsOptions {
  storage?: KnowhereSdkStorage;
  renderer?: PageRenderer;
  variant?: string;
  format?: PageCitationAssetMimeType;
  scale?: number;
  quality?: number;
  strict?: boolean;
  maxPagesToRenderPerRun?: number;
  timeouts?: PageCitationAssetTimeoutOptions;
}

export type KnowhereSdkStorageBody = Uint8Array | ReadableStream<Uint8Array> | Blob;

export interface KnowhereSdkStorageObject {
  key: string;
  contentType?: string;
  body: KnowhereSdkStorageBody;
  metadata?: Readonly<Record<string, string>>;
}

export interface KnowhereSdkStorageHead {
  key: string;
  contentType?: string;
  contentLength?: number;
  metadata?: Readonly<Record<string, string>>;
}

export interface KnowhereSdkStorageWriteResult {
  key: string;
  url?: string;
}

export interface KnowhereSdkStorageReadResult {
  body: Uint8Array;
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface KnowhereSdkStorage {
  headObject(key: string): Promise<KnowhereSdkStorageHead | null>;
  writeObject(input: KnowhereSdkStorageObject): Promise<KnowhereSdkStorageWriteResult>;
  getObjectUrl?(
    key: string,
    options?: { expiresInSeconds?: number },
  ): Promise<string | null>;
  readObject?(key: string): Promise<KnowhereSdkStorageReadResult | null>;
  deleteObject?(key: string): Promise<void>;
  deletePrefix?(prefix: string): Promise<void>;
}

export interface RenderPageInput {
  source: Uint8Array;
  pageNum: number;
  format: PageCitationAssetMimeType;
  scale: number;
  quality?: number;
  signal?: AbortSignal;
}

export interface RenderedPage {
  body: Uint8Array;
  mimeType: PageCitationAssetMimeType;
  width: number;
  height: number;
}

export interface PageRenderer {
  renderPage(input: RenderPageInput): Promise<RenderedPage>;
}

export interface PageCitationAssetIndex {
  version: 1;
  documentId: string;
  namespace?: string;
  jobId: string;
  jobResultId?: string;
  variant: string;
  generatedAt: string;
  assets: readonly PageCitationAsset[];
}

export interface PageCitationAssetCurrentIndex {
  version: 1;
  documentId: string;
  namespace?: string;
  jobId: string;
  jobResultId?: string;
  variant: string;
  indexKey: string;
  updatedAt: string;
}
