import { createHash } from 'crypto';

import type { Knowhere } from '../client.js';
import type {
  Chunk,
  DocNavSection,
  DocumentChunkListResponse,
  ParseResult,
  RetrievalResult,
} from '../types/index.js';
import { ValidationError } from '../errors/index.js';
import { LocalKnowledgeStore } from './local-store.js';
import type {
  IndexedKnowledgeChunk,
  KnowledgeAsyncCacheResult,
  KnowledgeAsyncJobStatusResponse,
  KnowledgeAsyncParseParams,
  KnowledgeAsyncParseResponse,
  KnowledgeCacheJobResultParams,
  KnowledgeCacheDocumentParams,
  KnowledgeDocumentReference,
  KnowledgeGrepMatch,
  KnowledgeGrepParams,
  KnowledgeGrepResponse,
  KnowledgeOutline,
  KnowledgeParseParams,
  KnowledgeReadChunk,
  KnowledgeReadParams,
  KnowledgeReadResponse,
  KnowledgeSearchParams,
  KnowledgeSearchReference,
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
  KnowledgeSection,
  KnowledgeStartupRecoveryResponse,
  KnowledgeChunkType,
  LocalKnowledgeDocument,
  LocalKnowledgeParseResponse,
} from './types.js';

const DEFAULT_READ_LIMIT = 12;
const MAX_READ_LIMIT = 40;
const DEFAULT_GREP_LIMIT = 20;
const MAX_GREP_LIMIT = 50;
const DEFAULT_CONTEXT_CHARS = 80;
const SAFE_LOCAL_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REMOTE_DOCUMENT_ID_PATTERN = /^doc[_-]/;

export class Knowledge {
  private readonly client: Knowhere;
  private readonly store: LocalKnowledgeStore;

  constructor(client: Knowhere, options?: { cacheDirectory?: string }) {
    this.client = client;
    this.store = new LocalKnowledgeStore(options?.cacheDirectory);
  }

  withCacheDirectory(cacheDirectory: string): Knowledge {
    return new Knowledge(this.client, { cacheDirectory });
  }

  async parse(params: KnowledgeParseParams): Promise<LocalKnowledgeParseResponse> {
    const result = await this.client.parse(params);
    const document = await this.store.saveResult(result, {
      localDocumentId: params.localDocumentId,
    });
    return { document, result };
  }

  async startParse(params: KnowledgeAsyncParseParams): Promise<KnowledgeAsyncParseResponse> {
    const job = await this.client.startParse(params);
    await this.store.saveAsyncParseJob({
      jobId: job.jobId,
      localDocumentId: params.localDocumentId,
    });
    return {
      job,
      localDocumentId: params.localDocumentId,
    };
  }

  async getJobStatus(jobId: string): Promise<KnowledgeAsyncJobStatusResponse> {
    const job = await this.client.jobs.get(jobId);
    return {
      job,
      cache: await this.resolveAsyncCache(jobId, job.isDone, job.isFailed),
    };
  }

  async recoverPendingAsyncParseJobs(): Promise<KnowledgeStartupRecoveryResponse> {
    const jobs = await this.store.listRecoverableAsyncParseJobs();
    const results: KnowledgeAsyncJobStatusResponse[] = [];
    for (const job of jobs) {
      results.push(await this.getJobStatus(job.jobId));
    }
    return {
      checkedJobs: jobs.length,
      results,
    };
  }

  async cacheJobResult(
    params: KnowledgeCacheJobResultParams,
  ): Promise<LocalKnowledgeParseResponse> {
    const result = await this.client.jobs.load(params.jobId, {
      verifyChecksum: params.verifyChecksum,
    });
    const document = await this.store.saveResult(result, {
      localDocumentId: params.localDocumentId,
    });
    return { document, result };
  }

  async cacheDocument(params: KnowledgeCacheDocumentParams): Promise<LocalKnowledgeParseResponse> {
    if (!params.documentId) {
      throw new ValidationError('documentId is required');
    }

    const existing: LocalKnowledgeDocument | undefined = await this.findLocalDocumentByRemoteId(
      params.documentId,
    );
    const jobId: string = await this.getPublishedDocumentJobId(params.documentId);
    return this.cacheJobResult({
      jobId,
      localDocumentId:
        params.localDocumentId ??
        existing?.localDocumentId ??
        createLocalDocumentIdForRemote(params.documentId),
    });
  }

  private async resolveAsyncCache(
    jobId: string,
    isDone: boolean,
    isFailed: boolean,
  ): Promise<KnowledgeAsyncCacheResult> {
    const trackedJob = await this.store.getAsyncParseJob(jobId);
    if (!trackedJob) {
      return { status: 'untracked' };
    }

    if (trackedJob.cacheStatus === 'cached' && trackedJob.localDocumentId) {
      const existingDocument = await this.store.getDocument(trackedJob.localDocumentId);
      if (existingDocument) {
        return {
          status: 'already_cached',
          localDocumentId: trackedJob.localDocumentId,
          document: existingDocument,
        };
      }
    }

    if (isFailed) {
      await this.store.updateAsyncParseJobCacheStatus({
        jobId,
        cacheStatus: 'failed',
      });
      return {
        status: 'failed',
        localDocumentId: trackedJob.localDocumentId,
      };
    }

    if (!isDone) {
      return {
        status: 'pending',
        localDocumentId: trackedJob.localDocumentId,
      };
    }

    try {
      const cached = await this.cacheJobResult({
        jobId,
        localDocumentId: trackedJob.localDocumentId,
      });
      return {
        status: 'cached',
        localDocumentId: cached.document.localDocumentId,
        document: cached.document,
      };
    } catch (error) {
      await this.store.updateAsyncParseJobCacheStatus({
        jobId,
        cacheStatus: 'not_available',
      });
      return {
        status: 'not_available',
        localDocumentId: trackedJob.localDocumentId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listDocuments(): Promise<LocalKnowledgeDocument[]> {
    return this.store.listDocuments();
  }

  async getDocumentOutline(
    reference: string | KnowledgeDocumentReference,
  ): Promise<KnowledgeOutline> {
    const { document, result } = await this.loadReadableResult(reference);
    const chunks = indexChunks(result);
    const sections = buildFlatSections(result, chunks);
    const sectionTree =
      result.docNav?.sections && result.docNav.sections.length > 0
        ? result.docNav.sections.map((section) =>
            toKnowledgeSection(section, chunks, result.manifest.sourceFileName),
          )
        : nestSections(sections);

    return {
      document,
      totalChunks: chunks.length,
      typeCounts: document.typeCounts,
      sections,
      sectionTree,
    };
  }

  async readChunks(params: KnowledgeReadParams): Promise<KnowledgeReadResponse> {
    const { document, result } = await this.loadReadableResult(params);
    const limit = clampLimit(params.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const chunks = indexChunks(result).filter((chunk) => matchesReadScope(chunk, params));
    const selected = selectReadWindow(chunks, params, limit);
    const lastSelected = selected[selected.length - 1];
    const nextChunk =
      lastSelected && selected.length < chunks.length
        ? chunks[chunks.indexOf(lastSelected) + 1]?.position
        : undefined;

    return {
      document,
      chunks: selected.map(toReadChunk),
      nextChunk,
    };
  }

  async grepChunks(params: KnowledgeGrepParams): Promise<KnowledgeGrepResponse> {
    if (!params.pattern) {
      throw new ValidationError('pattern is required');
    }

    const { document, result } = await this.loadReadableResult(params);
    const maxResults = clampLimit(params.maxResults, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
    const contextChars = params.contextChars ?? DEFAULT_CONTEXT_CHARS;
    const matcher = createMatcher(params);
    const scopedChunks = indexChunks(result).filter((chunk) => matchesGrepScope(chunk, params));
    const matches: KnowledgeGrepMatch[] = [];
    let scannedChunks = 0;

    for (const chunk of scopedChunks) {
      scannedChunks += 1;
      const chunkMatches = matcher(chunk.content);
      for (const match of chunkMatches) {
        matches.push({
          position: chunk.position,
          chunkId: chunk.chunkId,
          chunkType: chunk.chunkType,
          sectionPath: chunk.sectionPath,
          sourceChunkPath: chunk.sourceChunkPath,
          filePath: chunk.filePath,
          startOffset: match.startOffset,
          endOffset: match.endOffset,
          snippet: buildSnippet(chunk.content, match.startOffset, match.endOffset, contextChars),
        });
        if (matches.length >= maxResults) {
          return { document, matches, scannedChunks, truncated: true };
        }
      }
    }

    return { document, matches, scannedChunks, truncated: false };
  }

  async search(params: KnowledgeSearchParams): Promise<KnowledgeSearchResponse> {
    const localDocuments = await this.resolveSearchDocuments(params.localDocumentIds);
    const rawResponse = await this.client.retrieval.query({
      query: params.query,
      namespace: params.namespace,
      topK: params.topK,
      useAgentic: params.useAgentic ?? false,
    });
    const documentByServerId = new Map(
      localDocuments
        .filter((document) => document.documentId)
        .map((document) => [document.documentId as string, document]),
    );

    return {
      namespace: rawResponse.namespace,
      query: rawResponse.query,
      evidenceText: rawResponse.evidenceText,
      references: [
        ...rawResponse.referencedChunks.map(
          (reference): KnowledgeSearchReference => ({
            localDocumentId: reference.documentId
              ? documentByServerId.get(reference.documentId)?.localDocumentId
              : undefined,
            documentId: reference.documentId,
            chunkId: reference.chunkId,
            sectionPath: reference.sectionPath,
            chunkType: reference.chunkType,
          }),
        ),
        ...rawResponse.results.map((result) => toResultReference(result, documentByServerId)),
      ],
      results: rawResponse.results.map((result) =>
        toRemoteSearchResult(result, documentByServerId),
      ),
      rawResponse,
    };
  }

  private async resolveSearchDocuments(
    localDocumentIds: string[] | undefined,
  ): Promise<LocalKnowledgeDocument[]> {
    const documents = await this.store.listDocuments();
    if (!localDocumentIds || localDocumentIds.length === 0) {
      return documents;
    }

    const requested = new Set(localDocumentIds);
    return documents.filter((document) => requested.has(document.localDocumentId));
  }

  private async loadReadableResult(reference: string | KnowledgeDocumentReference): Promise<{
    document: LocalKnowledgeDocument;
    result: ParseResult;
  }> {
    const normalized: KnowledgeDocumentReference = normalizeDocumentReference(reference);
    if (normalized.documentId) {
      return this.cacheDocument({
        documentId: normalized.documentId,
        localDocumentId: normalized.localDocumentId,
      });
    }

    if (normalized.jobId) {
      return this.cacheJobResult({
        jobId: normalized.jobId,
        localDocumentId: normalized.localDocumentId,
      });
    }

    if (!normalized.localDocumentId) {
      throw new ValidationError('localDocumentId, documentId, or jobId is required');
    }

    const document = await this.store.getDocument(normalized.localDocumentId);
    if (document) {
      return this.store.loadResult(normalized.localDocumentId);
    }

    if (looksLikeRemoteDocumentId(normalized.localDocumentId)) {
      return this.cacheDocument({
        documentId: normalized.localDocumentId,
        localDocumentId: createLocalDocumentIdForRemote(normalized.localDocumentId),
      });
    }

    throw new Error(`Local Knowhere document not found: ${normalized.localDocumentId}`);
  }

  private async findLocalDocumentByRemoteId(
    documentId: string,
  ): Promise<LocalKnowledgeDocument | undefined> {
    const documents = await this.store.listDocuments();
    return documents.find((document) => document.documentId === documentId);
  }

  private async getPublishedDocumentJobId(documentId: string): Promise<string> {
    const response: DocumentChunkListResponse = await this.client.documents.listChunks(documentId, {
      page: 1,
      pageSize: 1,
    });
    if (!response.jobId) {
      throw new Error(
        `Cannot sync server document ${documentId}: current published job id was not returned.`,
      );
    }
    return response.jobId;
  }
}

function normalizeDocumentReference(
  reference: string | KnowledgeDocumentReference,
): KnowledgeDocumentReference {
  if (typeof reference === 'string') {
    return { localDocumentId: reference };
  }
  return reference;
}

function looksLikeRemoteDocumentId(value: string): boolean {
  return REMOTE_DOCUMENT_ID_PATTERN.test(value);
}

function createLocalDocumentIdForRemote(documentId: string): string {
  if (
    SAFE_LOCAL_DOCUMENT_ID_PATTERN.test(documentId) &&
    !documentId.includes('..') &&
    !documentId.includes('/') &&
    !documentId.includes('\\')
  ) {
    return documentId;
  }

  const hash = createHash('sha256').update(documentId).digest('hex').slice(0, 16);
  return `remote_${hash}`;
}

function indexChunks(result: ParseResult): IndexedKnowledgeChunk[] {
  return result.chunks.map((chunk, index) => {
    const filePath = getChunkFilePath(chunk);
    const readableContent = getReadableChunkContent(chunk);
    return {
      source: chunk,
      position: index + 1,
      chunkId: chunk.chunkId,
      chunkType: chunk.type,
      contentSource: chunk.contentSource,
      content: chunk.content,
      readableContent,
      sectionPath: normalizeSectionPath(chunk.path, result.manifest.sourceFileName),
      sourceChunkPath: chunk.path,
      filePath,
      pageNumbers: getChunkPageNumbers(chunk.metadata),
      metadata: chunk.metadata,
    };
  });
}

function getReadableChunkContent(chunk: Chunk): string {
  if (chunk.type !== 'page') {
    return chunk.content;
  }

  const summary = chunk.metadata.summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary : chunk.content;
}

function getChunkPageNumbers(metadata: Record<string, unknown>): number[] | undefined {
  const value = metadata.pageNums;
  if (!Array.isArray(value)) {
    return undefined;
  }

  const pageNumbers = value.filter(
    (pageNumber): pageNumber is number => Number.isInteger(pageNumber) && pageNumber > 0,
  );
  return pageNumbers.length > 0
    ? [...new Set(pageNumbers)].sort((left, right) => left - right)
    : undefined;
}

function getChunkFilePath(chunk: Chunk): string | undefined {
  if (chunk.type === 'image' || chunk.type === 'table') {
    return chunk.filePath;
  }

  const filePath = chunk.metadata.filePath;
  return typeof filePath === 'string' ? filePath : undefined;
}

function normalizeSectionPath(path: string, sourceFileName?: string): string {
  if (!path) {
    return '';
  }
  if (path.startsWith('images/') || path.startsWith('tables/')) {
    return path;
  }
  const parts = path.split('/').filter(Boolean);
  if (sourceFileName) {
    const fileNameIndex = parts.indexOf(sourceFileName);
    if (fileNameIndex >= 0) {
      return parts.slice(fileNameIndex + 1).join(' / ') || sourceFileName;
    }
  }
  if (parts.length <= 1) {
    return parts[0] ?? '';
  }
  return parts.slice(1).join(' / ');
}

function buildFlatSections(
  result: ParseResult,
  chunks: IndexedKnowledgeChunk[],
): KnowledgeSection[] {
  if (result.docNav?.sections && result.docNav.sections.length > 0) {
    return flattenSections(
      result.docNav.sections.map((section) =>
        toKnowledgeSection(section, chunks, result.manifest.sourceFileName),
      ),
    );
  }

  const byPath = new Map<string, KnowledgeSection>();
  for (const chunk of chunks) {
    const path = chunk.sectionPath || chunk.sourceChunkPath;
    const existing = byPath.get(path);
    if (existing) {
      addChunkToSection(existing, chunk);
    } else {
      byPath.set(path, createSectionFromChunk(path, chunk));
    }
  }

  return [...byPath.values()].sort(compareSections);
}

function toKnowledgeSection(
  section: DocNavSection,
  chunks: IndexedKnowledgeChunk[],
  sourceFileName?: string,
): KnowledgeSection {
  const sectionPath = normalizeSectionPath(section.path, sourceFileName);
  const scopedChunks = chunks.filter((chunk) => isInSection(chunk.sectionPath, sectionPath));
  const children = section.children.map((child) =>
    toKnowledgeSection(child, chunks, sourceFileName),
  );
  return {
    sectionPath,
    sectionTitle: section.title,
    sectionLevel: section.level,
    summary: section.summary,
    startChunk: minPosition(scopedChunks),
    endChunk: maxPosition(scopedChunks),
    chunkCount: scopedChunks.length,
    typeCounts: countIndexedTypes(scopedChunks),
    children,
  };
}

function createSectionFromChunk(pathValue: string, chunk: IndexedKnowledgeChunk): KnowledgeSection {
  const parts = pathValue.split(' / ').filter(Boolean);
  return {
    sectionPath: pathValue,
    sectionTitle: parts[parts.length - 1] ?? pathValue,
    sectionLevel: Math.max(parts.length, 1),
    startChunk: chunk.position,
    endChunk: chunk.position,
    chunkCount: 1,
    typeCounts: { text: 0, image: 0, table: 0, page: 0, [chunk.chunkType]: 1 },
    children: [],
  };
}

function addChunkToSection(section: KnowledgeSection, chunk: IndexedKnowledgeChunk): void {
  section.startChunk = Math.min(section.startChunk ?? chunk.position, chunk.position);
  section.endChunk = Math.max(section.endChunk ?? chunk.position, chunk.position);
  section.chunkCount += 1;
  section.typeCounts[chunk.chunkType] += 1;
}

function flattenSections(sections: KnowledgeSection[]): KnowledgeSection[] {
  return sections.flatMap((section) => [section, ...flattenSections(section.children)]);
}

function nestSections(sections: KnowledgeSection[]): KnowledgeSection[] {
  const clonedSections: KnowledgeSection[] = sections.map((section) => ({
    ...section,
    children: [],
  }));
  const byPath = new Map(clonedSections.map((section) => [section.sectionPath, section]));
  const roots: KnowledgeSection[] = [];

  for (const section of clonedSections) {
    const parentPath = getParentSectionPath(section.sectionPath);
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    if (parent) {
      parent.children.push(section);
    } else {
      roots.push(section);
    }
  }

  return roots;
}

function getParentSectionPath(sectionPath: string): string | undefined {
  const parts = sectionPath.split(' / ').filter(Boolean);
  if (parts.length <= 1) {
    return undefined;
  }
  return parts.slice(0, -1).join(' / ');
}

function compareSections(left: KnowledgeSection, right: KnowledgeSection): number {
  return (
    (left.startChunk ?? Number.MAX_SAFE_INTEGER) - (right.startChunk ?? Number.MAX_SAFE_INTEGER)
  );
}

function minPosition(chunks: IndexedKnowledgeChunk[]): number | undefined {
  if (chunks.length === 0) {
    return undefined;
  }
  return Math.min(...chunks.map((chunk) => chunk.position));
}

function maxPosition(chunks: IndexedKnowledgeChunk[]): number | undefined {
  if (chunks.length === 0) {
    return undefined;
  }
  return Math.max(...chunks.map((chunk) => chunk.position));
}

function countIndexedTypes(chunks: IndexedKnowledgeChunk[]): Record<KnowledgeChunkType, number> {
  return chunks.reduce<Record<KnowledgeChunkType, number>>(
    (counts, chunk) => {
      counts[chunk.chunkType] += 1;
      return counts;
    },
    { text: 0, image: 0, table: 0, page: 0 },
  );
}

function isInSection(chunkSectionPath: string, sectionPath: string): boolean {
  return chunkSectionPath === sectionPath || chunkSectionPath.startsWith(`${sectionPath} / `);
}

function clampLimit(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  return Math.min(Math.max(Math.floor(value), 1), maxValue);
}

function matchesReadScope(chunk: IndexedKnowledgeChunk, params: KnowledgeReadParams): boolean {
  if (params.chunkId && chunk.chunkId !== params.chunkId) {
    return false;
  }
  if (params.chunkType && chunk.chunkType !== params.chunkType) {
    return false;
  }
  if (params.sectionPath && !isInSection(chunk.sectionPath, params.sectionPath)) {
    return false;
  }
  return true;
}

function selectReadWindow(
  chunks: IndexedKnowledgeChunk[],
  params: KnowledgeReadParams,
  limit: number,
): IndexedKnowledgeChunk[] {
  if (params.chunkId) {
    return chunks.slice(0, limit);
  }

  const startChunk = params.startChunk ?? chunks[0]?.position ?? 1;
  const endChunk = params.endChunk ?? Number.MAX_SAFE_INTEGER;
  return chunks
    .filter((chunk) => chunk.position >= startChunk && chunk.position <= endChunk)
    .slice(0, limit);
}

function toReadChunk(chunk: IndexedKnowledgeChunk): KnowledgeReadChunk {
  return {
    position: chunk.position,
    chunkId: chunk.chunkId,
    chunkType: chunk.chunkType,
    contentSource: chunk.contentSource,
    content: chunk.content,
    readableContent: chunk.readableContent,
    sectionPath: chunk.sectionPath,
    sourceChunkPath: chunk.sourceChunkPath,
    filePath: chunk.filePath,
    pageNumbers: chunk.pageNumbers,
    metadata: chunk.metadata,
  };
}

function matchesGrepScope(chunk: IndexedKnowledgeChunk, params: KnowledgeGrepParams): boolean {
  if (params.chunkType && chunk.chunkType !== params.chunkType) {
    return false;
  }
  if (params.sectionPathPrefix && !chunk.sectionPath.startsWith(params.sectionPathPrefix)) {
    return false;
  }
  return true;
}

function createMatcher(
  params: KnowledgeGrepParams,
): (content: string) => KnowledgeGrepMatchOffset[] {
  if (params.isRegex) {
    const flags = params.isCaseSensitive ? 'g' : 'gi';
    const regex = new RegExp(params.pattern, flags);
    return (content) => {
      const matches: KnowledgeGrepMatchOffset[] = [];
      for (const match of content.matchAll(regex)) {
        const startOffset = match.index ?? 0;
        const text = match[0] ?? '';
        matches.push({ startOffset, endOffset: startOffset + text.length });
        if (text.length === 0) {
          break;
        }
      }
      return matches;
    };
  }

  const needle = params.isCaseSensitive ? params.pattern : params.pattern.toLowerCase();
  return (content) => {
    const haystack = params.isCaseSensitive ? content : content.toLowerCase();
    const matches: KnowledgeGrepMatchOffset[] = [];
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      matches.push({ startOffset: index, endOffset: index + needle.length });
      index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
    }
    return matches;
  };
}

interface KnowledgeGrepMatchOffset {
  startOffset: number;
  endOffset: number;
}

function buildSnippet(
  content: string,
  startOffset: number,
  endOffset: number,
  contextChars: number,
): string {
  const start = Math.max(0, startOffset - contextChars);
  const end = Math.min(content.length, endOffset + contextChars);
  return content.slice(start, end);
}

function toResultReference(
  result: RetrievalResult,
  documentByServerId: Map<string, LocalKnowledgeDocument>,
): KnowledgeSearchReference {
  const documentId = result.source.documentId ?? undefined;
  return {
    localDocumentId: documentId ? documentByServerId.get(documentId)?.localDocumentId : undefined,
    documentId,
    sectionPath: result.source.sectionPath ?? undefined,
    chunkType: result.chunkType,
    score: result.score,
  };
}

function toRemoteSearchResult(
  result: RetrievalResult,
  documentByServerId: Map<string, LocalKnowledgeDocument>,
): KnowledgeSearchResult {
  const documentId = result.source.documentId ?? undefined;
  return {
    localDocumentId: documentId ? documentByServerId.get(documentId)?.localDocumentId : undefined,
    documentId,
    chunkType: result.chunkType,
    content: result.content,
    score: result.score,
    sectionPath: result.source.sectionPath ?? undefined,
    sourceFileName: result.source.sourceFileName ?? undefined,
  };
}
