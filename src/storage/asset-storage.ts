import JSZip from 'jszip';

import type {
  Chunk,
  ImageChunk,
  PageChunk,
  ParseResult,
  TableChunk,
  TextChunk,
} from '../types/result.js';
import type { PageCitationAsset } from '../types/page-citation-assets.js';
import type {
  KnowhereAssetStorageAdapter,
  KnowhereAssetStorageBody,
  KnowhereAssetStorageOptions,
  KnowhereAssetStorageResult,
} from '../types/storage.js';

interface StorageAsset {
  readonly sourcePath: string;
  readonly storageKey: string;
  readonly body: KnowhereAssetStorageBody;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
}

const pageCitationAssetsMetadataKey = 'pageAssets';
const defaultImageContentType = 'application/octet-stream';
const tableContentType = 'text/html; charset=utf-8';

export async function storeParseResultAssets(
  result: ParseResult,
  options?: KnowhereAssetStorageOptions,
): Promise<KnowhereAssetStorageResult> {
  if (!options) {
    return {
      result,
      assetUrlsByFilePath: {},
    };
  }

  const normalizedKeyPrefix = normalizeStorageKeyPrefix(options.keyPrefix);
  const assets = dedupeStorageAssets(
    await collectStorageAssets(result, normalizedKeyPrefix),
  );
  const assetUrlsByFilePath: Record<string, string> = {};

  for (const asset of assets) {
    const storedUrl = await storeAsset(asset, options.adapter, options.skipExisting ?? true);
    if (storedUrl) {
      assetUrlsByFilePath[asset.sourcePath] = storedUrl;
    }
  }

  if (Object.keys(assetUrlsByFilePath).length === 0) {
    return {
      result,
      assetUrlsByFilePath,
    };
  }

  return {
    result: rewriteResultAssetUrls(result, assetUrlsByFilePath),
    assetUrlsByFilePath,
  };
}

async function collectStorageAssets(result: ParseResult, keyPrefix: string): Promise<StorageAsset[]> {
  const resultZip = await loadResultZipForPageCitationAssets(result);
  return [
    ...result.imageChunks.flatMap((chunk) => collectImageStorageAsset(chunk, keyPrefix)),
    ...result.tableChunks.flatMap((chunk) => collectTableStorageAsset(chunk, keyPrefix)),
    ...(resultZip
      ? await collectPageCitationStorageAssets(result.pageChunks, keyPrefix, resultZip)
      : []),
  ];
}

function collectImageStorageAsset(chunk: ImageChunk, keyPrefix: string): StorageAsset[] {
  const sourcePath = normalizeResultAssetPath(chunk.filePath);
  if (!sourcePath) return [];

  return [
    {
      sourcePath,
      storageKey: `${keyPrefix}/${sourcePath}`,
      body: chunk.data,
      contentType: getImageContentType(chunk.filePath),
      metadata: {
        chunkId: chunk.chunkId,
        chunkType: chunk.type,
        sourcePath,
      },
    },
  ];
}

function collectTableStorageAsset(chunk: TableChunk, keyPrefix: string): StorageAsset[] {
  const sourcePath = normalizeResultAssetPath(chunk.filePath);
  if (!sourcePath) return [];

  return [
    {
      sourcePath,
      storageKey: `${keyPrefix}/${sourcePath}`,
      body: Buffer.from(chunk.html, 'utf8'),
      contentType: tableContentType,
      metadata: {
        chunkId: chunk.chunkId,
        chunkType: chunk.type,
        sourcePath,
      },
    },
  ];
}

async function collectPageCitationStorageAssets(
  chunks: readonly PageChunk[],
  keyPrefix: string,
  resultZip: JSZip,
): Promise<StorageAsset[]> {
  const assets: StorageAsset[] = [];

  for (const chunk of chunks) {
    const pageAssets = parsePageCitationAssets(chunk.metadata[pageCitationAssetsMetadataKey]);
    for (const pageAsset of pageAssets) {
      const sourcePath = normalizeResultAssetPath(pageAsset.artifactRef);
      if (!sourcePath) continue;

      const zipEntry = resultZip.file(sourcePath);
      if (!zipEntry) continue;

      assets.push({
        sourcePath,
        storageKey: `${keyPrefix}/${sourcePath}`,
        body: await zipEntry.async('uint8array'),
        contentType: pageAsset.contentType,
        metadata: getPageCitationAssetMetadata(chunk, pageAsset, sourcePath),
      });
    }
  }

  return assets;
}

function getPageCitationAssetMetadata(
  chunk: PageChunk,
  pageAsset: PageCitationAsset,
  sourcePath: string,
): Readonly<Record<string, string>> {
  return {
    chunkId: chunk.chunkId,
    chunkType: chunk.type,
    pageNum: String(pageAsset.pageNum),
    sourcePath,
  };
}

async function loadResultZipForPageCitationAssets(result: ParseResult): Promise<JSZip | null> {
  if (!hasPageCitationAssetReferences(result) || result.rawZip.length === 0) {
    return null;
  }

  try {
    return await JSZip.loadAsync(result.rawZip);
  } catch (cause) {
    throw new Error('Unable to read page citation assets from the Knowhere result ZIP.', {
      cause,
    });
  }
}

function hasPageCitationAssetReferences(result: ParseResult): boolean {
  return result.pageChunks.some(
    (chunk) => parsePageCitationAssets(chunk.metadata[pageCitationAssetsMetadataKey]).length > 0,
  );
}

function dedupeStorageAssets(assets: readonly StorageAsset[]): StorageAsset[] {
  const assetsBySourcePath = new Map<string, StorageAsset>();

  for (const asset of assets) {
    if (!assetsBySourcePath.has(asset.sourcePath)) {
      assetsBySourcePath.set(asset.sourcePath, asset);
    }
  }

  return [...assetsBySourcePath.values()];
}

async function storeAsset(
  asset: StorageAsset,
  adapter: KnowhereAssetStorageAdapter,
  skipExisting: boolean,
): Promise<string | null> {
  if (skipExisting && adapter.headObject) {
    const existing = await adapter.headObject(asset.storageKey);
    if (existing) {
      const existingUrl = existing.url ?? (await adapter.getObjectUrl?.(asset.storageKey));
      if (existingUrl) return existingUrl;
    }
  }

  const writeResult = await adapter.writeObject({
    key: asset.storageKey,
    body: asset.body,
    contentType: asset.contentType,
    metadata: asset.metadata,
  });
  return writeResult.url ?? (await adapter.getObjectUrl?.(writeResult.key)) ?? null;
}

function rewriteResultAssetUrls(
  result: ParseResult,
  assetUrlsByFilePath: Readonly<Record<string, string>>,
): ParseResult {
  const chunks = result.chunks.map((chunk) => rewriteChunkAssetUrls(chunk, assetUrlsByFilePath));
  result.chunks.splice(0, result.chunks.length, ...chunks);
  refreshStaticChunkCollections(result);
  return result;
}

function rewriteChunkAssetUrls(
  chunk: Chunk,
  assetUrlsByPath: Readonly<Record<string, string>>,
): Chunk {
  if (chunk.type === 'image' || chunk.type === 'table') {
    const sourcePath = normalizeResultAssetPath(chunk.filePath);
    const assetUrl = sourcePath ? assetUrlsByPath[sourcePath] : undefined;
    if (!assetUrl) return chunk;
    return {
      ...chunk,
      assetUrl,
    };
  }

  if (chunk.type === 'page') {
    const pageAssets = parsePageCitationAssets(chunk.metadata[pageCitationAssetsMetadataKey]);
    if (pageAssets.length === 0) return chunk;

    const rewrittenPageAssets = pageAssets.map((pageAsset) => {
      const sourcePath = normalizeResultAssetPath(pageAsset.artifactRef);
      const assetUrl = sourcePath ? assetUrlsByPath[sourcePath] : undefined;
      return assetUrl ? { ...pageAsset, assetUrl } : pageAsset;
    });

    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        [pageCitationAssetsMetadataKey]: rewrittenPageAssets,
      },
    };
  }

  return chunk;
}

function parsePageCitationAssets(value: unknown): PageCitationAsset[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): PageCitationAsset[] => {
    if (!isRecord(item)) return [];
    const pageNum = item.pageNum;
    const artifactRef = item.artifactRef;
    const contentType = item.contentType;
    const source = item.source;

    if (typeof pageNum !== 'number' || !Number.isSafeInteger(pageNum) || pageNum <= 0) return [];
    if (typeof artifactRef !== 'string') return [];
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') return [];
    if (source !== 'knowhere-rendered-page-citation-source') return [];

    return [
      {
        pageNum,
        artifactRef,
        assetUrl: typeof item.assetUrl === 'string' ? item.assetUrl : undefined,
        contentType,
        width: typeof item.width === 'number' ? item.width : undefined,
        height: typeof item.height === 'number' ? item.height : undefined,
        source,
      },
    ];
  });
}

function normalizeStorageKeyPrefix(value: string): string {
  const normalized = normalizeStoragePath(value, { allowDotPrefix: false });
  if (!normalized) {
    throw new Error('storageAdapter keyPrefix must be a non-empty relative POSIX path.');
  }
  return normalized;
}

function normalizeResultAssetPath(value: string | undefined): string | null {
  return normalizeStoragePath(value, { allowDotPrefix: true });
}

function normalizeStoragePath(
  value: string | undefined,
  options: { readonly allowDotPrefix: boolean },
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) return null;
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null;

  const normalized = options.allowDotPrefix
    ? trimmed.replaceAll('\\', '/').replace(/^\.\/+/, '')
    : trimmed.replaceAll('\\', '/');

  if (normalized.length === 0) return null;

  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;

  return parts.join('/');
}

type StaticChunkCollections = {
  textChunks: TextChunk[];
  imageChunks: ImageChunk[];
  tableChunks: TableChunk[];
  pageChunks: PageChunk[];
};

function refreshStaticChunkCollections(result: ParseResult): void {
  replaceStaticChunkCollection(
    result,
    'textChunks',
    result.chunks.filter((chunk): chunk is TextChunk => chunk.type === 'text'),
  );
  replaceStaticChunkCollection(
    result,
    'imageChunks',
    result.chunks.filter((chunk): chunk is ImageChunk => chunk.type === 'image'),
  );
  replaceStaticChunkCollection(
    result,
    'tableChunks',
    result.chunks.filter((chunk): chunk is TableChunk => chunk.type === 'table'),
  );
  replaceStaticChunkCollection(
    result,
    'pageChunks',
    result.chunks.filter((chunk): chunk is PageChunk => chunk.type === 'page'),
  );
}

function replaceStaticChunkCollection<Key extends keyof StaticChunkCollections>(
  result: ParseResult,
  property: Key,
  value: StaticChunkCollections[Key],
): void {
  const descriptor = Object.getOwnPropertyDescriptor(result, property);
  if (!descriptor || descriptor.get || descriptor.writable !== true) return;

  Object.defineProperty(result, property, {
    ...descriptor,
    value,
  });
}

function getImageContentType(filePath: string): string {
  const extension = filePath.split('.').at(-1)?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'svg') return 'image/svg+xml';
  return defaultImageContentType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
