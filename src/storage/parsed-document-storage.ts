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
  readonly signal?: AbortSignal;
  readonly beforeCommit?: () => Promise<void>;
}): Promise<{
  readonly result: ParseResult;
  readonly documentId: string;
  readonly revisionKey: string;
  readonly commit: ParsedDocumentCommit;
}> {
  const documentId = params.documentId ?? params.result.documentId ?? params.result.jobId;
  const revisionKey = params.revisionKey ?? params.result.jobId;
  for await (const object of collectResultLayoutObjects(params.result)) {
    params.signal?.throwIfAborted();
    await params.storage.writeObject({
      documentId,
      revisionKey,
      ...object,
    });
  }

  await params.beforeCommit?.();
  params.signal?.throwIfAborted();
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

async function* collectResultLayoutObjects(
  result: ParseResult,
): AsyncGenerator<ParsedDocumentWriteObjectParamsWithoutRevision> {
  const storedPaths: Set<string> = new Set();
  let zip: JSZip | undefined;
  try {
    zip = await JSZip.loadAsync(result.rawZip);
  } catch {
    /* Synthetic ParseResults may have no original ZIP. */
  }
  if (zip) {
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry.name === 'result.zip') continue;
      const path: string = normalizeResultPath(entry.name);
      if (isSdkMetadataPath(path)) continue;
      storedPaths.add(path);
      yield {
        path,
        body: await entry.async('nodebuffer'),
        contentType: inferContentTypeFromPath(path),
      };
    }
  }
  for (const object of generateMissingResultObjects(result, storedPaths)) yield object;
}

function* generateMissingResultObjects(
  result: ParseResult,
  storedPaths: ReadonlySet<string>,
): Generator<ParsedDocumentWriteObjectParamsWithoutRevision> {
  if (!storedPaths.has('manifest.json')) yield createJsonObject('manifest.json', result.manifest);
  if (!storedPaths.has('chunks.json'))
    yield createJsonObject('chunks.json', keysToSnake(serializeChunks(result.chunks)));
  if (!storedPaths.has('doc_nav.json') && result.docNav)
    yield createJsonObject('doc_nav.json', result.docNav);
  if (!storedPaths.has('full.md') && result.fullMarkdown)
    yield createTextObject('full.md', result.fullMarkdown, markdownContentType);
  if (!storedPaths.has('chunks_slim.json') && result.chunksSlim)
    yield createJsonObject('chunks_slim.json', { chunks: result.chunksSlim });
  if (!storedPaths.has('hierarchy.json') && result.hierarchy)
    yield createJsonObject('hierarchy.json', result.hierarchy);
  if (!storedPaths.has('toc_hierarchies.json') && result.tocHierarchies)
    yield createJsonObject('toc_hierarchies.json', result.tocHierarchies);
  if (!storedPaths.has('kb.csv') && result.kbCsv)
    yield createTextObject('kb.csv', result.kbCsv, csvContentType);
  if (!storedPaths.has('hierarchy_view.html') && result.hierarchyViewHtml)
    yield createTextObject('hierarchy_view.html', result.hierarchyViewHtml, htmlContentType);
  for (const chunk of result.imageChunks) {
    const path: string = normalizeResultPath(chunk.filePath);
    if (storedPaths.has(path)) continue;
    yield {
      path,
      body: chunk.data,
      contentType: inferContentTypeFromPath(path),
      metadata: { chunkId: chunk.chunkId, chunkType: chunk.type, sourcePath: chunk.filePath },
    };
  }
  for (const chunk of result.tableChunks) {
    const path: string = normalizeResultPath(chunk.filePath);
    if (storedPaths.has(path)) continue;
    yield {
      path,
      body: Buffer.from(chunk.html, 'utf8'),
      contentType: htmlContentType,
      metadata: { chunkId: chunk.chunkId, chunkType: chunk.type, sourcePath: chunk.filePath },
    };
  }
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

export function inferContentTypeFromPath(filePath: string): string {
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

export function normalizeResultPath(value: string): string {
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
