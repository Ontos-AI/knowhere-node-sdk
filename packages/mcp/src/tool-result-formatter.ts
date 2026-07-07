import path from 'path';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

interface TextTag {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly text?: string;
}

interface PageAssetReference {
  readonly pageNum?: number;
  readonly artifactRef?: string;
  readonly assetUrl?: string;
  readonly contentType?: string;
  readonly width?: number;
  readonly height?: number;
}

interface ChunkFields {
  readonly position?: number;
  readonly chunkId?: string;
  readonly chunkType?: string;
  readonly sectionPath?: string;
  readonly chunkPath?: string;
  readonly filePath?: string;
  readonly assetUrl?: string;
  readonly pageNumbers?: readonly number[];
  readonly storageLocation?: string;
  readonly previewText: string;
  readonly metadata?: UnknownRecord;
}

export function createKnowhereToolResult(params: {
  readonly operation: string;
  readonly result: unknown;
}): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: formatOperationResult(params.operation, params.result),
      },
    ],
  };
}

function formatOperationResult(operation: string, result: unknown): string {
  const lines: string[] = [`<knowhere operation="${escapeAttribute(operation)}">`];

  switch (operation) {
    case 'parseUrl':
    case 'parseFile':
      appendBlockingParseResult(lines, result);
      break;
    case 'asyncParseUrl':
    case 'asyncParseFile':
      appendAsyncParseResult(lines, result);
      break;
    case 'jobStatus':
      appendJobStatusResult(lines, result);
      break;
    case 'listDocuments':
      appendListDocumentsResult(lines, result);
      break;
    case 'deleteDocument':
      appendDeleteDocumentResult(lines, result);
      break;
    case 'outline':
      appendOutlineResult(lines, result);
      break;
    case 'readChunks':
      appendReadChunksResult(lines, result);
      break;
    case 'grepChunks':
      appendGrepChunksResult(lines, result);
      break;
    case 'search':
      appendSearchResult(lines, result);
      break;
    default:
      appendTextTag(lines, 1, {
        name: 'summary',
        text: 'Operation completed.',
      });
      break;
  }

  lines.push('</knowhere>');
  return lines.join('\n');
}

function appendBlockingParseResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  appendDocument(lines, readRecord(response, 'document'), 1);
  appendParseSummary(lines, readRecord(response, 'result'), 1);
  appendAssetUrls(lines, readRecord(response, 'assetUrlsByFilePath'), 1);
}

function appendAsyncParseResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  const job: UnknownRecord | undefined = readRecord(response, 'job');
  appendSelfClosingTag(lines, 1, {
    name: 'job',
    attributes: {
      localDocumentId: readString(response, 'localDocumentId'),
      jobId: readString(job, 'jobId'),
      status: readString(job, 'status'),
      sourceType: readString(job, 'sourceType'),
      documentId: readString(job, 'documentId'),
      namespace: readString(job, 'namespace'),
      dataId: readString(job, 'dataId'),
    },
  });
}

function appendJobStatusResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  const job: UnknownRecord | undefined = readRecord(response, 'job');
  appendSelfClosingTag(lines, 1, {
    name: 'job',
    attributes: {
      jobId: readString(job, 'jobId'),
      status: readString(job, 'status'),
      sourceType: readString(job, 'sourceType'),
      documentId: readString(job, 'documentId'),
      namespace: readString(job, 'namespace'),
      isDone: readBoolean(job, 'isDone'),
      isFailed: readBoolean(job, 'isFailed'),
    },
  });

  const cache: UnknownRecord | undefined = readRecord(response, 'cache');
  lines.push(
    `${indent(1)}<cache${formatAttributes({
      status: readString(cache, 'status'),
      localDocumentId: readString(cache, 'localDocumentId'),
      error: readString(cache, 'error'),
    })}>`,
  );
  appendDocument(lines, readRecord(cache, 'document'), 2);
  lines.push(`${indent(1)}</cache>`);
}

function appendListDocumentsResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  const documents: readonly UnknownRecord[] = readRecordArray(response, 'documents');
  lines.push(
    `${indent(1)}<documents${formatAttributes({
      namespace: readString(response, 'namespace'),
      count: documents.length,
    })}>`,
  );
  for (const document of documents) {
    appendDocument(lines, document, 2);
  }
  appendPagination(lines, readRecord(response, 'pagination'), 2);
  lines.push(`${indent(1)}</documents>`);
}

function appendDeleteDocumentResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  lines.push(
    `${indent(1)}<deleteResult${formatAttributes({
      localDocumentId: readString(response, 'localDocumentId'),
    })}>`,
  );
  appendDocument(lines, readRecord(response, 'document'), 2);
  lines.push(`${indent(1)}</deleteResult>`);
}

function appendOutlineResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  appendDocument(lines, readRecord(response, 'document'), 1);
  lines.push(
    `${indent(1)}<outline${formatAttributes({
      totalChunks: readNumber(response, 'totalChunks'),
      truncated: readBoolean(response, 'truncated'),
      continuationCursor: readString(response, 'continuationCursor'),
    })}>`,
  );
  appendChunkCounts(
    lines,
    readRecord(response, 'typeCounts'),
    2,
    readNumber(response, 'totalChunks'),
  );
  const sectionTree: readonly UnknownRecord[] = readRecordArray(response, 'sectionTree');
  const sections: readonly UnknownRecord[] =
    sectionTree.length > 0 ? sectionTree : readRecordArray(response, 'sections');
  for (const section of sections) {
    appendSection(lines, section, 2);
  }
  lines.push(`${indent(1)}</outline>`);
}

function appendReadChunksResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  const document: UnknownRecord | undefined = readRecord(response, 'document');
  const storageRoot: string | undefined = readString(document, 'resultDirectoryPath');
  const chunks: readonly UnknownRecord[] = readRecordArray(response, 'chunks');
  appendDocument(lines, document, 1);
  appendPaginationSummary(lines, response, 1);
  lines.push(`${indent(1)}<chunks${formatAttributes({ count: chunks.length })}>`);
  for (const chunk of chunks) {
    appendChunk(lines, chunk, storageRoot, 2);
  }
  lines.push(`${indent(1)}</chunks>`);
}

function appendGrepChunksResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  const document: UnknownRecord | undefined = readRecord(response, 'document');
  const storageRoot: string | undefined = readString(document, 'resultDirectoryPath');
  const matches: readonly UnknownRecord[] = readRecordArray(response, 'matches');
  appendDocument(lines, document, 1);
  lines.push(
    `${indent(1)}<grep${formatAttributes({
      scannedChunks: readNumber(response, 'scannedChunks'),
      truncated: readBoolean(response, 'truncated'),
      continuationCursor: readString(response, 'continuationCursor'),
      count: matches.length,
    })}>`,
  );
  for (const match of matches) {
    appendGrepMatch(lines, match, storageRoot, 2);
  }
  lines.push(`${indent(1)}</grep>`);
}

function appendSearchResult(lines: string[], result: unknown): void {
  const response: UnknownRecord | undefined = toRecord(result);
  const references: readonly UnknownRecord[] = readRecordArray(response, 'references');
  const results: readonly UnknownRecord[] = readRecordArray(response, 'results');
  const hasPageAssets: boolean = references.some(isPageRecord) || results.some(isPageRecord);

  lines.push(
    `${indent(1)}<search${formatAttributes({
      namespace: readString(response, 'namespace'),
      query: readString(response, 'query'),
      referenceCount: references.length,
      resultCount: results.length,
    })}>`,
  );
  if (hasPageAssets) {
    appendTextTag(lines, 2, {
      name: 'instruction',
      text: 'Page results and references marked hasPageAssets="true" only include preview text here. Call knowhere_read_chunks with the documentId and chunkId to get readable page asset URLs and chunk storage locations.',
    });
  }
  appendOptionalTextTag(lines, 2, 'evidenceText', readString(response, 'evidenceText'));
  appendSearchReferences(lines, references, 2);
  appendSearchResults(lines, results, 2);
  lines.push(`${indent(1)}</search>`);
}

function appendParseSummary(
  lines: string[],
  result: UnknownRecord | undefined,
  depth: number,
): void {
  const manifest: UnknownRecord | undefined = readRecord(result, 'manifest');
  const statistics: UnknownRecord | undefined = readRecord(manifest, 'statistics');
  lines.push(
    `${indent(depth)}<parseResult${formatAttributes({
      jobId: readString(result, 'jobId') ?? readString(manifest, 'jobId'),
      documentId: readString(result, 'documentId'),
      namespace: readString(result, 'namespace'),
      sourceFileName: readString(manifest, 'sourceFileName'),
    })}>`,
  );
  appendChunkCounts(lines, statistics, depth + 1, readNumber(statistics, 'totalChunks'));
  lines.push(`${indent(depth)}</parseResult>`);
}

function appendAssetUrls(
  lines: string[],
  assetUrlsByFilePath: UnknownRecord | undefined,
  depth: number,
): void {
  if (!assetUrlsByFilePath) {
    return;
  }

  const entries: readonly [string, string][] = Object.entries(assetUrlsByFilePath).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  if (entries.length === 0) {
    return;
  }

  lines.push(`${indent(depth)}<assetUrls${formatAttributes({ count: entries.length })}>`);
  for (const [filePath, assetUrl] of entries) {
    appendSelfClosingTag(lines, depth + 1, {
      name: 'assetUrl',
      attributes: {
        filePath,
        assetUrl,
      },
    });
  }
  lines.push(`${indent(depth)}</assetUrls>`);
}

function appendDocument(lines: string[], document: UnknownRecord | undefined, depth: number): void {
  if (!document) {
    appendSelfClosingTag(lines, depth, { name: 'document' });
    return;
  }

  lines.push(
    `${indent(depth)}<document${formatAttributes({
      localDocumentId: readString(document, 'localDocumentId'),
      documentId: readString(document, 'documentId'),
      jobId: readString(document, 'jobId'),
      namespace: readString(document, 'namespace'),
      sourceFileName: readString(document, 'sourceFileName'),
      status: readString(document, 'status'),
      currentJobResultId: readString(document, 'currentJobResultId'),
      storageRoot: readString(document, 'resultDirectoryPath'),
    })}>`,
  );
  appendChunkCounts(
    lines,
    readRecord(document, 'typeCounts'),
    depth + 1,
    readNumber(document, 'chunkCount'),
  );
  lines.push(`${indent(depth)}</document>`);
}

function appendChunkCounts(
  lines: string[],
  counts: UnknownRecord | undefined,
  depth: number,
  totalChunks: number | undefined,
): void {
  appendSelfClosingTag(lines, depth, {
    name: 'chunkCounts',
    attributes: {
      total: totalChunks ?? readNumber(counts, 'totalChunks'),
      text: readNumber(counts, 'text') ?? readNumber(counts, 'textChunks'),
      image: readNumber(counts, 'image') ?? readNumber(counts, 'imageChunks'),
      table: readNumber(counts, 'table') ?? readNumber(counts, 'tableChunks'),
      page: readNumber(counts, 'page') ?? readNumber(counts, 'pageChunks'),
    },
  });
}

function appendPagination(
  lines: string[],
  pagination: UnknownRecord | undefined,
  depth: number,
): void {
  if (!pagination) {
    return;
  }
  appendSelfClosingTag(lines, depth, {
    name: 'pagination',
    attributes: {
      page: readNumber(pagination, 'page'),
      pageSize: readNumber(pagination, 'pageSize'),
      total: readNumber(pagination, 'total'),
      totalPages: readNumber(pagination, 'totalPages'),
    },
  });
}

function appendPaginationSummary(
  lines: string[],
  response: UnknownRecord | undefined,
  depth: number,
): void {
  appendSelfClosingTag(lines, depth, {
    name: 'pagination',
    attributes: {
      page: readNumber(response, 'page'),
      pageSize: readNumber(response, 'pageSize'),
      totalChunks: readNumber(response, 'totalChunks'),
      totalPages: readNumber(response, 'totalPages'),
      nextChunk: readNumber(response, 'nextChunk'),
    },
  });
}

function appendSection(lines: string[], section: UnknownRecord, depth: number): void {
  lines.push(
    `${indent(depth)}<section${formatAttributes({
      sectionPath: readString(section, 'sectionPath'),
      sectionTitle: readString(section, 'sectionTitle'),
      sectionLevel: readNumber(section, 'sectionLevel'),
      startChunk: readNumber(section, 'startChunk'),
      endChunk: readNumber(section, 'endChunk'),
      chunkCount: readNumber(section, 'chunkCount'),
    })}>`,
  );
  appendOptionalTextTag(lines, depth + 1, 'summary', readString(section, 'summary'));
  appendChunkCounts(
    lines,
    readRecord(section, 'typeCounts'),
    depth + 1,
    readNumber(section, 'chunkCount'),
  );
  for (const child of readRecordArray(section, 'children')) {
    appendSection(lines, child, depth + 1);
  }
  lines.push(`${indent(depth)}</section>`);
}

function appendChunk(
  lines: string[],
  chunk: UnknownRecord,
  storageRoot: string | undefined,
  depth: number,
): void {
  const fields: ChunkFields = readChunkFields(chunk, storageRoot);
  lines.push(
    `${indent(depth)}<chunk${formatAttributes({
      position: fields.position,
      chunkId: fields.chunkId,
      chunkType: fields.chunkType,
      sectionPath: fields.sectionPath,
      chunkPath: fields.chunkPath,
      filePath: isMediaChunk(fields.chunkType) ? fields.filePath : undefined,
      assetUrl: isMediaChunk(fields.chunkType) ? fields.assetUrl : undefined,
      pageNumbers: fields.pageNumbers?.join(','),
      storageLocation: fields.storageLocation,
    })}>`,
  );
  if (fields.chunkType === 'page') {
    appendPageAssets(lines, fields.metadata, depth + 1);
  }
  appendTextTag(lines, depth + 1, {
    name: 'previewText',
    text: fields.previewText,
  });
  lines.push(`${indent(depth)}</chunk>`);
}

function appendPageAssets(
  lines: string[],
  metadata: UnknownRecord | undefined,
  depth: number,
): void {
  const pageAssets: readonly PageAssetReference[] = readPageAssets(metadata);
  lines.push(`${indent(depth)}<pageAssets primary="true">`);
  for (const pageAsset of pageAssets) {
    appendSelfClosingTag(lines, depth + 1, {
      name: 'pageAsset',
      attributes: {
        pageNum: pageAsset.pageNum,
        artifactRef: pageAsset.artifactRef,
        assetUrl: pageAsset.assetUrl,
        contentType: pageAsset.contentType,
        width: pageAsset.width,
        height: pageAsset.height,
      },
    });
  }
  lines.push(`${indent(depth)}</pageAssets>`);
  appendTextTag(lines, depth, {
    name: 'instruction',
    text: createPageAssetInstruction(pageAssets),
  });
}

function appendGrepMatch(
  lines: string[],
  match: UnknownRecord,
  storageRoot: string | undefined,
  depth: number,
): void {
  const fields: ChunkFields = readChunkFields(match, storageRoot);
  lines.push(
    `${indent(depth)}<match${formatAttributes({
      position: fields.position,
      chunkId: fields.chunkId,
      chunkType: fields.chunkType,
      sectionPath: fields.sectionPath,
      chunkPath: fields.chunkPath,
      filePath: fields.filePath,
      storageLocation: fields.storageLocation,
      startOffset: readNumber(match, 'startOffset'),
      endOffset: readNumber(match, 'endOffset'),
    })}>`,
  );
  appendTextTag(lines, depth + 1, {
    name: 'snippet',
    text: readString(match, 'snippet') ?? '',
  });
  lines.push(`${indent(depth)}</match>`);
}

function appendSearchReferences(
  lines: string[],
  references: readonly UnknownRecord[],
  depth: number,
): void {
  lines.push(`${indent(depth)}<references${formatAttributes({ count: references.length })}>`);
  for (const reference of references) {
    appendSelfClosingTag(lines, depth + 1, {
      name: 'reference',
      attributes: {
        localDocumentId: readString(reference, 'localDocumentId'),
        documentId: readString(reference, 'documentId'),
        chunkId: readString(reference, 'chunkId'),
        chunkType: readString(reference, 'chunkType'),
        sectionPath: readString(reference, 'sectionPath'),
        score: readNumber(reference, 'score'),
        hasPageAssets: isPageRecord(reference) ? true : undefined,
      },
    });
  }
  lines.push(`${indent(depth)}</references>`);
}

function appendSearchResults(
  lines: string[],
  results: readonly UnknownRecord[],
  depth: number,
): void {
  lines.push(`${indent(depth)}<results${formatAttributes({ count: results.length })}>`);
  for (const result of results) {
    const chunkType: string | undefined = readString(result, 'chunkType');
    lines.push(
      `${indent(depth + 1)}<result${formatAttributes({
        localDocumentId: readString(result, 'localDocumentId'),
        documentId: readString(result, 'documentId'),
        chunkId: readString(result, 'chunkId'),
        chunkType,
        sectionPath: readString(result, 'sectionPath'),
        sourceFileName: readString(result, 'sourceFileName'),
        score: readNumber(result, 'score'),
        hasPageAssets: isPageRecord(result) ? true : undefined,
      })}>`,
    );
    appendTextTag(lines, depth + 2, {
      name: 'previewText',
      text: readString(result, 'content') ?? '',
    });
    lines.push(`${indent(depth + 1)}</result>`);
  }
  lines.push(`${indent(depth)}</results>`);
}

function readChunkFields(chunk: UnknownRecord, storageRoot: string | undefined): ChunkFields {
  const chunkType: string | undefined = readString(chunk, 'chunkType');
  const chunkPath: string | undefined =
    readString(chunk, 'sourceChunkPath') ?? readString(chunk, 'chunkPath');
  const filePath: string | undefined = readString(chunk, 'filePath');
  return {
    position: readNumber(chunk, 'position'),
    chunkId: readString(chunk, 'chunkId'),
    chunkType,
    sectionPath: readString(chunk, 'sectionPath'),
    chunkPath,
    filePath,
    assetUrl: readString(chunk, 'assetUrl'),
    pageNumbers: readNumberArray(chunk, 'pageNumbers'),
    storageLocation: createStorageLocation({
      storageRoot,
      chunkType,
      chunkPath,
      filePath,
    }),
    previewText: readString(chunk, 'readableContent') ?? readString(chunk, 'content') ?? '',
    metadata: readRecord(chunk, 'metadata'),
  };
}

function createStorageLocation(params: {
  readonly storageRoot: string | undefined;
  readonly chunkType: string | undefined;
  readonly chunkPath: string | undefined;
  readonly filePath: string | undefined;
}): string | undefined {
  if (!params.storageRoot) {
    return undefined;
  }

  const preferredPath: string | undefined =
    isMediaChunk(params.chunkType) && params.filePath ? params.filePath : params.chunkPath;
  if (!preferredPath) {
    return undefined;
  }

  const relativePath: string = stripLeadingPathSeparators(preferredPath);
  if (isMarkerStorageRoot(params.storageRoot)) {
    return `${stripTrailingPathSeparators(params.storageRoot)}/${relativePath}`;
  }

  return path.join(params.storageRoot, relativePath);
}

function createPageAssetInstruction(pageAssets: readonly PageAssetReference[]): string {
  if (pageAssets.length === 0) {
    return 'No page asset metadata was returned; rely on preview text only.';
  }

  if (pageAssets.some((pageAsset) => pageAsset.assetUrl !== undefined)) {
    return 'Open or fetch the listed assetUrl before relying on preview text.';
  }

  return 'A page asset exists, but it is not directly readable because no assetUrl was returned.';
}

function readPageAssets(metadata: UnknownRecord | undefined): readonly PageAssetReference[] {
  const rawPageAssets: unknown = metadata?.pageAssets ?? metadata?.page_assets ?? undefined;
  if (!Array.isArray(rawPageAssets)) {
    return [];
  }

  return rawPageAssets.filter(isRecord).map(
    (pageAsset): PageAssetReference => ({
      pageNum: readNumber(pageAsset, 'pageNum') ?? readNumber(pageAsset, 'page_num'),
      artifactRef: readString(pageAsset, 'artifactRef') ?? readString(pageAsset, 'artifact_ref'),
      assetUrl: readString(pageAsset, 'assetUrl') ?? readString(pageAsset, 'asset_url'),
      contentType: readString(pageAsset, 'contentType') ?? readString(pageAsset, 'content_type'),
      width: readNumber(pageAsset, 'width'),
      height: readNumber(pageAsset, 'height'),
    }),
  );
}

function appendOptionalTextTag(
  lines: string[],
  depth: number,
  name: string,
  text: string | undefined,
): void {
  if (text === undefined || text.length === 0) {
    return;
  }
  appendTextTag(lines, depth, { name, text });
}

function appendTextTag(lines: string[], depth: number, tag: TextTag): void {
  lines.push(
    `${indent(depth)}<${tag.name}${formatAttributes(tag.attributes)}>${escapeText(
      tag.text ?? '',
    )}</${tag.name}>`,
  );
}

function appendSelfClosingTag(lines: string[], depth: number, tag: TextTag): void {
  lines.push(`${indent(depth)}<${tag.name}${formatAttributes(tag.attributes)} />`);
}

function formatAttributes(
  attributes: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  if (!attributes) {
    return '';
  }

  const renderedAttributes: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    renderedAttributes.push(`${name}="${escapeAttribute(String(value))}"`);
  }

  return renderedAttributes.length > 0 ? ` ${renderedAttributes.join(' ')}` : '';
}

function isPageRecord(record: UnknownRecord): boolean {
  return readString(record, 'chunkType') === 'page';
}

function isMediaChunk(chunkType: string | undefined): boolean {
  return chunkType === 'image' || chunkType === 'table';
}

function isMarkerStorageRoot(storageRoot: string): boolean {
  return storageRoot.startsWith('parsed-storage:') || storageRoot.startsWith('remote:');
}

function stripLeadingPathSeparators(value: string): string {
  return value.replace(/^[\\/]+/, '');
}

function stripTrailingPathSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

function readRecord(record: UnknownRecord | undefined, key: string): UnknownRecord | undefined {
  return toRecord(record?.[key]);
}

function readRecordArray(record: UnknownRecord | undefined, key: string): readonly UnknownRecord[] {
  const value: unknown = record?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function readString(record: UnknownRecord | undefined, key: string): string | undefined {
  const value: unknown = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: UnknownRecord | undefined, key: string): number | undefined {
  const value: unknown = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: UnknownRecord | undefined, key: string): boolean | undefined {
  const value: unknown = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumberArray(
  record: UnknownRecord | undefined,
  key: string,
): readonly number[] | undefined {
  const value: unknown = record?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const numbers: number[] = value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item),
  );
  return numbers.length > 0 ? numbers : undefined;
}

function toRecord(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
