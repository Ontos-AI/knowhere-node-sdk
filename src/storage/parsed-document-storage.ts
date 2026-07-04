import { storeParseResultAssets } from './asset-storage.js';
import type { ParseResult } from '../types/result.js';
import type {
  KnowhereAssetStorageAdapter,
  KnowhereAssetStorageHead,
  KnowhereAssetStorageObject,
  KnowhereAssetStorageWriteResult,
  KnowhereParsedSnapshot,
  KnowhereParsedSnapshotChunkPage,
  KnowhereParsedSnapshotManifest,
  ParsedDocumentStorage,
} from '../types/storage.js';

const parsedStorageKeyPrefix = 'parsed';
const manifestStoragePath = 'manifest/current.json';
const indexStoragePath = 'index.json';
const chunkPagePathPattern = /^chunks\/page-(\d+)\.json$/;

export async function syncParseResultToParsedDocumentStorage(params: {
  readonly result: ParseResult;
  readonly storage: ParsedDocumentStorage;
  readonly documentId?: string;
  readonly revisionKey?: string;
  readonly chunkPageSize?: number;
}): Promise<{
  readonly result: ParseResult;
  readonly snapshot?: KnowhereParsedSnapshot;
  readonly documentId: string;
  readonly revisionKey: string;
}> {
  const documentId = params.documentId ?? params.result.documentId ?? params.result.jobId;
  const revisionKey = params.revisionKey ?? params.result.jobId;
  const adapter = createParsedDocumentObjectStorageAdapter({
    storage: params.storage,
    documentId,
    revisionKey,
  });
  const stored = await storeParseResultAssets(params.result, {
    adapter,
    keyPrefix: parsedStorageKeyPrefix,
    chunkPageSize: params.chunkPageSize,
    revisionKey,
  });
  return {
    result: stored.result,
    snapshot: stored.snapshot,
    documentId,
    revisionKey,
  };
}

function createParsedDocumentObjectStorageAdapter(params: {
  readonly storage: ParsedDocumentStorage;
  readonly documentId: string;
  readonly revisionKey: string;
}): KnowhereAssetStorageAdapter {
  return {
    writeObject: (input) => writeParsedStorageObject(params, input),
    headObject: (key) => headParsedStorageObject(params, key),
    getObjectUrl: (key) => getParsedStorageObjectUrl(params, key),
  };
}

async function writeParsedStorageObject(
  params: {
    readonly storage: ParsedDocumentStorage;
    readonly documentId: string;
    readonly revisionKey: string;
  },
  input: KnowhereAssetStorageObject,
): Promise<KnowhereAssetStorageWriteResult> {
  const storagePath = stripParsedStorageKeyPrefix(input.key);
  if (storagePath === manifestStoragePath) {
    const manifest = JSON.parse(
      Buffer.from(input.body).toString('utf8'),
    ) as KnowhereParsedSnapshotManifest;
    await params.storage.writeManifest({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      manifest,
    });
    return { key: input.key };
  }

  if (storagePath === indexStoragePath) {
    return { key: input.key };
  }

  const chunkPageMatch = storagePath.match(chunkPagePathPattern);
  if (chunkPageMatch) {
    const page = JSON.parse(
      Buffer.from(input.body).toString('utf8'),
    ) as KnowhereParsedSnapshotChunkPage;
    await params.storage.writeChunkPage({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      page,
    });
    return { key: input.key };
  }

  const stored = await params.storage.writeAsset({
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    sourcePath: storagePath,
    body: input.body,
    contentType: input.contentType,
    metadata: input.metadata,
  });
  return {
    key: input.key,
    url: stored.url,
  };
}

async function headParsedStorageObject(
  params: {
    readonly storage: ParsedDocumentStorage;
    readonly documentId: string;
    readonly revisionKey: string;
  },
  key: string,
): Promise<KnowhereAssetStorageHead | null> {
  const storagePath = stripParsedStorageKeyPrefix(key);
  if (
    storagePath === manifestStoragePath ||
    storagePath === indexStoragePath ||
    chunkPagePathPattern.test(storagePath)
  ) {
    return null;
  }

  const url = await params.storage.getAssetUrl({
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    sourcePath: storagePath,
  });
  return url
    ? {
        key,
        url,
      }
    : null;
}

async function getParsedStorageObjectUrl(
  params: {
    readonly storage: ParsedDocumentStorage;
    readonly documentId: string;
    readonly revisionKey: string;
  },
  key: string,
): Promise<string | null> {
  const storagePath = stripParsedStorageKeyPrefix(key);
  if (
    storagePath === manifestStoragePath ||
    storagePath === indexStoragePath ||
    chunkPagePathPattern.test(storagePath)
  ) {
    return null;
  }

  return params.storage.getAssetUrl({
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    sourcePath: storagePath,
  });
}

function stripParsedStorageKeyPrefix(key: string): string {
  const prefix = `${parsedStorageKeyPrefix}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}
