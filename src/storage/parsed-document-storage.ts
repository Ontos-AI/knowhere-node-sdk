import JSZip from 'jszip';

import { keysToSnake } from '../lib/utils.js';
import type { Chunk, ParseResult } from '../types/result.js';
import type {
  ParsedDocumentCommit,
  ParsedDocumentCommitSource,
  ParsedDocumentObject,
  ParsedDocumentObjectParams,
  ParsedDocumentStorage,
  ParsedDocumentWriteObjectParams,
} from '../types/storage.js';

export const parsedDocumentCommitPath = '.knowhere-sdk/commit.json';

const jsonContentType = 'application/json; charset=utf-8';
const markdownContentType = 'text/markdown; charset=utf-8';
const csvContentType = 'text/csv; charset=utf-8';
const htmlContentType = 'text/html; charset=utf-8';
const binaryContentType = 'application/octet-stream';

interface RawChunk {
  readonly chunkId: string;
  readonly type: string;
  readonly contentSource?: string;
  readonly content: string;
  readonly path: string;
  readonly metadata: Record<string, unknown>;
  readonly filePath?: string;
  readonly assetUrl?: string;
}

export async function syncParseResultToParsedDocumentStorage(params: {
  readonly result: ParseResult;
  readonly storage: ParsedDocumentStorage;
  readonly documentId?: string;
  readonly revisionKey?: string;
  readonly source?: ParsedDocumentCommitSource;
}): Promise<{
  readonly result: ParseResult;
  readonly documentId: string;
  readonly revisionKey: string;
  readonly commit: ParsedDocumentCommit;
}> {
  const documentId = params.documentId ?? params.result.documentId ?? params.result.jobId;
  const revisionKey = params.revisionKey ?? params.result.jobId;
  const objects = await collectResultLayoutObjects(params.result);

  for (const object of objects) {
    await params.storage.writeObject({
      documentId,
      revisionKey,
      ...object,
    });
  }

  const commit: ParsedDocumentCommit = {
    version: 1,
    documentId,
    revisionKey,
    source: params.source ?? 'resultZip',
    committedAt: new Date().toISOString(),
  };
  await writeParsedDocumentJsonObject(params.storage, {
    documentId,
    revisionKey,
    path: parsedDocumentCommitPath,
    value: commit,
  });

  return {
    result: params.result,
    documentId,
    revisionKey,
    commit,
  };
}

export async function readParsedDocumentCommit(params: {
  readonly storage: ParsedDocumentStorage;
  readonly documentId: string;
  readonly revisionKey: string;
}): Promise<ParsedDocumentCommit | null> {
  const object = await params.storage.readObject({
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    path: parsedDocumentCommitPath,
  });
  if (!object) {
    return null;
  }
  const commit = readJsonObject<ParsedDocumentCommit>(object);
  return commit.revisionKey === params.revisionKey && commit.documentId === params.documentId
    ? commit
    : null;
}

export function readJsonObject<T>(object: ParsedDocumentObject): T {
  return JSON.parse(Buffer.from(object.body).toString('utf8')) as T;
}

async function collectResultLayoutObjects(
  result: ParseResult,
): Promise<ParsedDocumentWriteObjectParamsWithoutRevision[]> {
  const objectsByPath = new Map<string, ParsedDocumentWriteObjectParamsWithoutRevision>();
  const rawZipObjects = await collectRawZipObjects(result.rawZip);
  for (const object of rawZipObjects) {
    objectsByPath.set(object.path, object);
  }

  for (const object of collectGeneratedResultObjects(result)) {
    if (!objectsByPath.has(object.path)) {
      objectsByPath.set(object.path, object);
    }
  }

  return [...objectsByPath.values()].filter((object) => !isSdkMetadataPath(object.path));
}

async function collectRawZipObjects(
  rawZip: Buffer,
): Promise<ParsedDocumentWriteObjectParamsWithoutRevision[]> {
  try {
    const zip = await JSZip.loadAsync(rawZip);
    const objects: ParsedDocumentWriteObjectParamsWithoutRevision[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry.name === 'result.zip') {
        continue;
      }
      objects.push({
        path: normalizeResultPath(entry.name),
        body: new Uint8Array(await entry.async('nodebuffer')),
        contentType: inferContentTypeFromPath(entry.name),
      });
    }
    return objects;
  } catch {
    return [];
  }
}

function collectGeneratedResultObjects(
  result: ParseResult,
): ParsedDocumentWriteObjectParamsWithoutRevision[] {
  const objects: ParsedDocumentWriteObjectParamsWithoutRevision[] = [
    createJsonObject('manifest.json', result.manifest),
    createJsonObject('chunks.json', keysToSnake(serializeChunks(result.chunks))),
  ];

  if (result.docNav) {
    objects.push(createJsonObject('doc_nav.json', result.docNav));
  }
  if (result.fullMarkdown) {
    objects.push(createTextObject('full.md', result.fullMarkdown, markdownContentType));
  }
  if (result.chunksSlim) {
    objects.push(createJsonObject('chunks_slim.json', { chunks: result.chunksSlim }));
  }
  if (result.hierarchy) {
    objects.push(createJsonObject('hierarchy.json', result.hierarchy));
  }
  if (result.tocHierarchies) {
    objects.push(createJsonObject('toc_hierarchies.json', result.tocHierarchies));
  }
  if (result.kbCsv) {
    objects.push(createTextObject('kb.csv', result.kbCsv, csvContentType));
  }
  if (result.hierarchyViewHtml) {
    objects.push(
      createTextObject('hierarchy_view.html', result.hierarchyViewHtml, htmlContentType),
    );
  }

  for (const chunk of result.imageChunks) {
    objects.push({
      path: normalizeResultPath(chunk.filePath),
      body: new Uint8Array(chunk.data),
      contentType: inferContentTypeFromPath(chunk.filePath),
      metadata: {
        chunkId: chunk.chunkId,
        chunkType: chunk.type,
        sourcePath: chunk.filePath,
      },
    });
  }

  for (const chunk of result.tableChunks) {
    objects.push({
      path: normalizeResultPath(chunk.filePath),
      body: Buffer.from(chunk.html, 'utf8'),
      contentType: htmlContentType,
      metadata: {
        chunkId: chunk.chunkId,
        chunkType: chunk.type,
        sourcePath: chunk.filePath,
      },
    });
  }

  return objects;
}

function serializeChunks(chunks: readonly Chunk[]): { readonly chunks: readonly RawChunk[] } {
  return {
    chunks: chunks.map((chunk): RawChunk => {
      const rawChunk: RawChunk = {
        chunkId: chunk.chunkId,
        type: chunk.type,
        contentSource: chunk.contentSource,
        content: chunk.content,
        path: chunk.path,
        metadata: chunk.metadata,
      };

      if (chunk.type === 'image' || chunk.type === 'table') {
        return {
          ...rawChunk,
          filePath: chunk.filePath,
          assetUrl: chunk.assetUrl,
        };
      }

      return rawChunk;
    }),
  };
}

async function writeParsedDocumentJsonObject(
  storage: ParsedDocumentStorage,
  params: ParsedDocumentObjectParams & { readonly value: unknown },
): Promise<void> {
  await storage.writeObject({
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    path: params.path,
    body: Buffer.from(JSON.stringify(params.value, null, 2), 'utf8'),
    contentType: jsonContentType,
  });
}

function createJsonObject(
  path: string,
  value: unknown,
): ParsedDocumentWriteObjectParamsWithoutRevision {
  return {
    path,
    body: Buffer.from(JSON.stringify(value, null, 2), 'utf8'),
    contentType: jsonContentType,
  };
}

function createTextObject(
  path: string,
  value: string,
  contentType: string,
): ParsedDocumentWriteObjectParamsWithoutRevision {
  return {
    path,
    body: Buffer.from(value, 'utf8'),
    contentType,
  };
}

function inferContentTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) return jsonContentType;
  if (lower.endsWith('.md')) return markdownContentType;
  if (lower.endsWith('.csv')) return csvContentType;
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return htmlContentType;
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return binaryContentType;
}

function normalizeResultPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid parsed result path: ${value}`);
  }
  return normalized;
}

function isSdkMetadataPath(path: string): boolean {
  return path === '.knowhere-sdk' || path.startsWith('.knowhere-sdk/');
}

type ParsedDocumentWriteObjectParamsWithoutRevision = Omit<
  ParsedDocumentWriteObjectParams,
  'documentId' | 'revisionKey'
>;
