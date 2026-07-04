import { createHash } from 'crypto';

import type { Knowhere } from '../client.js';
import type {
  Chunk,
  DocumentChunk,
  DocNavSection,
  DocumentChunkListResponse,
  ParseResult,
  RetrievalResult,
} from '../types/index.js';
import { ValidationError } from '../errors/index.js';
import { storeParseResultAssets } from '../storage/asset-storage.js';
import { syncParseResultToParsedDocumentStorage } from '../storage/parsed-document-storage.js';
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
  KnowledgeImportJobResultParams,
  KnowledgeJobResultResponse,
  KnowledgeLoadJobResultParams,
  KnowledgeOutline,
  KnowledgeParseParams,
  KnowledgeParsedStorageOptions,
  KnowledgeReadChunk,
  KnowledgeReadParams,
  KnowledgeReadResponse,
  KnowledgeSearchParams,
  KnowledgeSearchReference,
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
  KnowledgeSection,
  KnowledgeStartupRecoveryResponse,
  KnowledgeSyncParsedDocumentParams,
  KnowledgeSyncParsedDocumentResponse,
  KnowledgeChunkType,
  LocalKnowledgeDocument,
  LocalKnowledgeParseResponse,
} from './types.js';
import type {
  KnowhereParsedSnapshotChunk,
  KnowhereParsedSnapshotChunkPage,
  KnowhereParsedSnapshotManifest,
  ParsedDocumentAssetUrlPolicy,
  ParsedDocumentStorageConfig,
  ParsedDocumentStorageLimits,
} from '../types/storage.js';

const DEFAULT_READ_LIMIT = 12;
const MAX_READ_LIMIT = 40;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;
const DEFAULT_GREP_LIMIT = 20;
const MAX_GREP_LIMIT = 50;
const DEFAULT_CONTEXT_CHARS = 80;
const DEFAULT_REMOTE_SCAN_PAGE_SIZE = 100;
const DEFAULT_MAX_SYNC_PAGES = 10;
const DEFAULT_MAX_SYNC_ASSETS = 20;
const DEFAULT_SYNC_DEADLINE_MS = 8000;
const DEFAULT_GREP_MAX_PAGES = 50;
const DEFAULT_GREP_DEADLINE_MS = 8000;
const DEFAULT_OUTLINE_MAX_PAGES = 50;
const DEFAULT_OUTLINE_DEADLINE_MS = 8000;
const SAFE_LOCAL_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REMOTE_DOCUMENT_ID_PATTERN = /^doc[_-]/;

export class Knowledge {
  private readonly client: Knowhere;
  private readonly store: LocalKnowledgeStore;
  private readonly cacheDirectory: string | undefined;
  private readonly parsedStorageConfig: ParsedDocumentStorageConfig | undefined;

  constructor(
    client: Knowhere,
    options?: {
      cacheDirectory?: string;
      parsedStorage?: ParsedDocumentStorageConfig;
    },
  ) {
    this.client = client;
    this.cacheDirectory = options?.cacheDirectory;
    this.parsedStorageConfig = options?.parsedStorage;
    this.store = new LocalKnowledgeStore(options?.cacheDirectory);
  }

  withCacheDirectory(cacheDirectory: string): Knowledge {
    return new Knowledge(this.client, {
      cacheDirectory,
      parsedStorage: this.parsedStorageConfig,
    });
  }

  withParsedStorage(parsedStorage: KnowledgeParsedStorageOptions): Knowledge {
    return new Knowledge(this.client, {
      cacheDirectory: this.cacheDirectory,
      parsedStorage,
    });
  }

  async parseToLocalCache(params: KnowledgeParseParams): Promise<LocalKnowledgeParseResponse> {
    const loadedResult = params.storageAdapter
      ? await this.parseWithoutClientStorageAdapter(params)
      : await this.client.parse(params);
    const storedAssets = await storeParseResultAssets(loadedResult, params.storageAdapter);
    const syncedStorage = await this.syncParseResultToConfiguredStorage(storedAssets.result);
    const result = syncedStorage.result;
    const document = await this.store.saveResult(result, {
      localDocumentId: params.localDocumentId,
    });
    return {
      document,
      result,
      assetUrlsByFilePath: storedAssets.assetUrlsByFilePath,
      parsedSnapshot: storedAssets.snapshot,
    };
  }

  /** @deprecated Use parseToLocalCache for local cache imports or the top-level client.parse for server-safe parsing. */
  async parse(params: KnowledgeParseParams): Promise<LocalKnowledgeParseResponse> {
    return this.parseToLocalCache(params);
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

  async loadJobResult(params: KnowledgeLoadJobResultParams): Promise<KnowledgeJobResultResponse> {
    const loadedResult = await this.client.jobs.load(params.jobId, {
      verifyChecksum: params.verifyChecksum,
    });
    const storedAssets = await storeParseResultAssets(loadedResult, params.storageAdapter);
    const syncedStorage = await this.syncParseResultToConfiguredStorage(storedAssets.result);
    const result = syncedStorage.result;
    return {
      result,
      assetUrlsByFilePath: storedAssets.assetUrlsByFilePath,
      parsedSnapshot: syncedStorage.snapshot ?? storedAssets.snapshot,
    };
  }

  async importJobResult(
    params: KnowledgeImportJobResultParams,
  ): Promise<LocalKnowledgeParseResponse> {
    const stored = await this.loadJobResult(params);
    const result = stored.result;
    const document = await this.store.saveResult(result, {
      localDocumentId: params.localDocumentId,
    });
    return {
      document,
      result,
      assetUrlsByFilePath: stored.assetUrlsByFilePath,
      parsedSnapshot: stored.parsedSnapshot,
    };
  }

  /** @deprecated Use importJobResult for local cache imports or loadJobResult for server-safe loads. */
  async cacheJobResult(
    params: KnowledgeCacheJobResultParams,
  ): Promise<LocalKnowledgeParseResponse> {
    return this.importJobResult(params);
  }

  async syncParsedDocument(
    params: KnowledgeSyncParsedDocumentParams,
  ): Promise<KnowledgeSyncParsedDocumentResponse> {
    const normalized = normalizeDocumentReference(params);
    const parsedStorageConfig = this.requireParsedStorageConfig();

    if (normalized.documentId) {
      return this.syncRemoteDocumentToParsedStorage({
        documentId: normalized.documentId,
        revisionKey: params.revisionKey,
        parsedStorageConfig,
      });
    }

    if (normalized.jobId) {
      const loadedResult = await this.client.jobs.load(normalized.jobId);
      const synced = await syncParseResultToParsedDocumentStorage({
        result: loadedResult,
        storage: parsedStorageConfig.storage,
        documentId: loadedResult.documentId ?? normalized.localDocumentId ?? normalized.jobId,
        revisionKey: params.revisionKey ?? normalized.jobId,
        chunkPageSize: parsedStorageConfig.limits?.chunkPageSize,
      });
      return {
        documentId: synced.documentId,
        revisionKey: synced.revisionKey,
        completed: true,
        manifest: synced.snapshot?.manifest,
      };
    }

    if (!normalized.localDocumentId) {
      throw new ValidationError('localDocumentId, documentId, or jobId is required');
    }

    const { result } = await this.store.loadResult(normalized.localDocumentId);
    const synced = await syncParseResultToParsedDocumentStorage({
      result,
      storage: parsedStorageConfig.storage,
      documentId: result.documentId ?? normalized.localDocumentId,
      revisionKey: params.revisionKey ?? result.jobId,
      chunkPageSize: parsedStorageConfig.limits?.chunkPageSize,
    });
    return {
      documentId: synced.documentId,
      revisionKey: synced.revisionKey,
      completed: true,
      manifest: synced.snapshot?.manifest,
    };
  }

  private async syncParseResultToConfiguredStorage(result: ParseResult): Promise<{
    result: ParseResult;
    snapshot?: Awaited<ReturnType<typeof syncParseResultToParsedDocumentStorage>>['snapshot'];
  }> {
    const parsedStorageConfig = this.parsedStorageConfig;
    if (!parsedStorageConfig) {
      return { result };
    }

    const synced = await syncParseResultToParsedDocumentStorage({
      result,
      storage: parsedStorageConfig.storage,
      chunkPageSize: parsedStorageConfig.limits?.chunkPageSize,
    });
    return {
      result: synced.result,
      snapshot: synced.snapshot,
    };
  }

  private async parseWithoutClientStorageAdapter(
    params: KnowledgeParseParams,
  ): Promise<ParseResult> {
    const parseParams: KnowledgeParseParams = { ...params };
    delete parseParams.localDocumentId;
    delete parseParams.storageAdapter;
    return this.client.parse(parseParams);
  }

  async cacheDocument(params: KnowledgeCacheDocumentParams): Promise<LocalKnowledgeParseResponse> {
    if (!params.documentId) {
      throw new ValidationError('documentId is required');
    }

    const existing: LocalKnowledgeDocument | undefined = await this.findLocalDocumentByRemoteId(
      params.documentId,
    );
    const jobId: string = await this.getPublishedDocumentJobId(params.documentId);
    return this.importJobResult({
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
      const cached = await this.importJobResult({
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
    const normalized = normalizeDocumentReference(reference);
    if (normalized.documentId) {
      return this.getRemoteDocumentOutline(normalized.documentId, normalized.revisionKey);
    }

    if (
      normalized.localDocumentId &&
      looksLikeRemoteDocumentId(normalized.localDocumentId) &&
      !(await this.store.getDocument(normalized.localDocumentId))
    ) {
      return this.getRemoteDocumentOutline(normalized.localDocumentId, normalized.revisionKey);
    }

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
    validateReadParams(params);
    const normalized = normalizeDocumentReference(params);
    if (normalized.documentId) {
      return this.readRemoteDocumentChunks(normalized.documentId, params);
    }

    if (
      normalized.localDocumentId &&
      looksLikeRemoteDocumentId(normalized.localDocumentId) &&
      !(await this.store.getDocument(normalized.localDocumentId))
    ) {
      return this.readRemoteDocumentChunks(normalized.localDocumentId, params);
    }

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

    const normalized = normalizeDocumentReference(params);
    if (normalized.documentId) {
      return this.grepRemoteDocumentChunks(normalized.documentId, params);
    }

    if (
      normalized.localDocumentId &&
      looksLikeRemoteDocumentId(normalized.localDocumentId) &&
      !(await this.store.getDocument(normalized.localDocumentId))
    ) {
      return this.grepRemoteDocumentChunks(normalized.localDocumentId, params);
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
      return this.importJobResult({
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

  private async readRemoteDocumentChunks(
    documentId: string,
    params: KnowledgeReadParams,
  ): Promise<KnowledgeReadResponse> {
    const explicitRevisionKey = params.revisionKey ?? params.jobId;
    if (explicitRevisionKey) {
      const stored = await this.tryReadChunksFromParsedStorage({
        documentId,
        revisionKey: explicitRevisionKey,
        params,
      });
      if (stored) {
        return stored;
      }
    }

    if (hasScanReadFilters(params)) {
      return this.scanRemoteDocumentChunks(documentId, params);
    }

    const pageParams = getReadPageParams(params);
    const remotePage = await this.client.documents.listChunks(documentId, {
      page: pageParams.page,
      pageSize: pageParams.pageSize,
      chunkType: params.chunkType,
      includeAssetUrls: shouldRequestRemoteAssetUrls(
        params.assetUrlPolicy,
        this.parsedStorageConfig,
      ),
    });
    const revisionKey = getRemoteRevisionKey(remotePage);
    const stored = await this.tryReadChunksFromParsedStorage({
      documentId,
      revisionKey,
      params,
    });
    if (stored) {
      return stored;
    }

    const chunks = await this.toRemoteReadChunks({
      documentId,
      revisionKey,
      chunks: remotePage.chunks,
      assetUrlPolicy: params.assetUrlPolicy,
    });
    this.scheduleParsedStorageSync(documentId, revisionKey);
    return {
      document: createRemoteKnowledgeDocument({
        documentId,
        response: remotePage,
        revisionKey,
      }),
      chunks,
      page: remotePage.pagination.page,
      pageSize: remotePage.pagination.pageSize,
      totalChunks: remotePage.pagination.total,
      totalPages: remotePage.pagination.totalPages,
    };
  }

  private async scanRemoteDocumentChunks(
    documentId: string,
    params: KnowledgeReadParams,
  ): Promise<KnowledgeReadResponse> {
    const explicitRevisionKey = params.revisionKey ?? params.jobId;
    if (explicitRevisionKey) {
      const stored = await this.tryReadChunksFromParsedStorage({
        documentId,
        revisionKey: explicitRevisionKey,
        params,
      });
      if (stored) {
        return stored;
      }
    }

    const limit = clampLimit(params.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const limits = getParsedStorageLimits(this.parsedStorageConfig?.limits);
    const firstPage = await this.client.documents.listChunks(documentId, {
      page: 1,
      pageSize: limits.remotePageSize,
      chunkType: params.chunkType,
      includeAssetUrls: shouldRequestRemoteAssetUrls(
        params.assetUrlPolicy,
        this.parsedStorageConfig,
      ),
    });
    const revisionKey = getRemoteRevisionKey(firstPage);
    const stored = await this.tryReadChunksFromParsedStorage({
      documentId,
      revisionKey,
      params,
    });
    if (stored) {
      return stored;
    }

    const selected: DocumentChunk[] = [];
    let scannedPages = 0;
    let page = 1;
    let response = firstPage;
    const startedAt = Date.now();

    while (true) {
      scannedPages += 1;
      selected.push(...response.chunks.filter((chunk) => matchesRemoteReadScope(chunk, params)));
      if (
        selected.length >= limit ||
        response.pagination.page >= response.pagination.totalPages ||
        scannedPages >= limits.outlineMaxPages ||
        Date.now() - startedAt >= limits.outlineDeadlineMs
      ) {
        break;
      }

      page += 1;
      response = await this.client.documents.listChunks(documentId, {
        page,
        pageSize: limits.remotePageSize,
        chunkType: params.chunkType,
        includeAssetUrls: shouldRequestRemoteAssetUrls(
          params.assetUrlPolicy,
          this.parsedStorageConfig,
        ),
      });
    }

    const chunks = await this.toRemoteReadChunks({
      documentId,
      revisionKey,
      chunks: selected.slice(0, limit),
      assetUrlPolicy: params.assetUrlPolicy,
    });
    this.scheduleParsedStorageSync(documentId, revisionKey);
    return {
      document: createRemoteKnowledgeDocument({
        documentId,
        response: firstPage,
        revisionKey,
      }),
      chunks,
      nextChunk: selected.length > limit ? toChunkPosition(selected[limit]) : undefined,
      totalChunks: firstPage.pagination.total,
      totalPages: firstPage.pagination.totalPages,
    };
  }

  private async grepRemoteDocumentChunks(
    documentId: string,
    params: KnowledgeGrepParams,
  ): Promise<KnowledgeGrepResponse> {
    const explicitRevisionKey = params.revisionKey ?? params.jobId;
    if (explicitRevisionKey && !params.continuationCursor) {
      const stored = await this.tryGrepChunksFromParsedStorage({
        documentId,
        revisionKey: explicitRevisionKey,
        params,
      });
      if (stored) {
        return stored;
      }
    }

    const maxResults = clampLimit(params.maxResults, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
    const contextChars = params.contextChars ?? DEFAULT_CONTEXT_CHARS;
    const matcher = createMatcher(params);
    const limits = getParsedStorageLimits(this.parsedStorageConfig?.limits);
    const cursor = parseContinuationCursor(params.continuationCursor);
    const startPage = cursor?.documentId === documentId ? cursor.nextPage : 1;
    const firstPage = await this.client.documents.listChunks(documentId, {
      page: startPage,
      pageSize: limits.remotePageSize,
      chunkType: params.chunkType,
      includeAssetUrls: false,
    });
    const revisionKey = getRemoteRevisionKey(firstPage);
    const stored =
      startPage === 1
        ? await this.tryGrepChunksFromParsedStorage({
            documentId,
            revisionKey,
            params,
          })
        : null;
    if (stored) {
      return stored;
    }

    const matches: KnowledgeGrepMatch[] = [];
    let scannedChunks = 0;
    let scannedPages = 0;
    let response = firstPage;
    let page = startPage;
    const startedAt = Date.now();

    while (true) {
      scannedPages += 1;
      for (const [chunkIndex, chunk] of response.chunks.entries()) {
        if (
          response.pagination.page === startPage &&
          cursor?.nextChunkIndex !== undefined &&
          chunkIndex < cursor.nextChunkIndex
        ) {
          continue;
        }
        if (!matchesGrepScope(toIndexedRemoteChunk(chunk), params)) {
          continue;
        }
        scannedChunks += 1;
        const chunkMatches = matcher(chunk.content ?? '');
        for (const [matchIndex, match] of chunkMatches.entries()) {
          if (
            response.pagination.page === startPage &&
            cursor?.nextChunkIndex === chunkIndex &&
            cursor.nextMatchIndex !== undefined &&
            matchIndex < cursor.nextMatchIndex
          ) {
            continue;
          }
          matches.push({
            position: toChunkPosition(chunk),
            chunkId: chunk.chunkId,
            chunkType: chunk.chunkType,
            sectionPath: chunk.sectionPath ?? '',
            sourceChunkPath: chunk.sourceChunkPath ?? chunk.sectionPath ?? '',
            filePath: chunk.filePath ?? undefined,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            snippet: buildSnippet(
              chunk.content ?? '',
              match.startOffset,
              match.endOffset,
              contextChars,
            ),
          });
          if (matches.length >= maxResults) {
            const continuationCursor = createGrepContinuationCursor({
              documentId,
              revisionKey,
              response,
              chunkIndex,
              matchIndex,
              chunkMatchCount: chunkMatches.length,
            });
            this.scheduleParsedStorageSync(documentId, revisionKey);
            return {
              document: createRemoteKnowledgeDocument({
                documentId,
                response: firstPage,
                revisionKey,
              }),
              matches,
              scannedChunks,
              truncated: continuationCursor !== undefined,
              continuationCursor,
            };
          }
        }
      }

      const shouldStop =
        response.pagination.page >= response.pagination.totalPages ||
        scannedPages >= limits.grepMaxPages ||
        Date.now() - startedAt >= limits.grepDeadlineMs;
      if (shouldStop) {
        const truncated = response.pagination.page < response.pagination.totalPages;
        this.scheduleParsedStorageSync(documentId, revisionKey);
        return {
          document: createRemoteKnowledgeDocument({
            documentId,
            response: firstPage,
            revisionKey,
          }),
          matches,
          scannedChunks,
          truncated,
          continuationCursor: truncated
            ? createContinuationCursor({
                documentId,
                revisionKey,
                nextPage: response.pagination.page + 1,
              })
            : undefined,
        };
      }

      page += 1;
      response = await this.client.documents.listChunks(documentId, {
        page,
        pageSize: limits.remotePageSize,
        chunkType: params.chunkType,
        includeAssetUrls: false,
      });
    }
  }

  private async getRemoteDocumentOutline(
    documentId: string,
    revisionKeyOverride?: string,
  ): Promise<KnowledgeOutline> {
    if (revisionKeyOverride) {
      const stored = await this.tryReadOutlineFromParsedStorage(documentId, revisionKeyOverride);
      if (stored) {
        return stored;
      }
    }

    const limits = getParsedStorageLimits(this.parsedStorageConfig?.limits);
    const firstPage = await this.client.documents.listChunks(documentId, {
      page: 1,
      pageSize: limits.remotePageSize,
      includeAssetUrls: false,
    });
    const revisionKey = getRemoteRevisionKey(firstPage);
    const stored = await this.tryReadOutlineFromParsedStorage(documentId, revisionKey);
    if (stored) {
      return stored;
    }

    const chunks: IndexedKnowledgeChunk[] = [];
    let page = 1;
    let response = firstPage;
    let scannedPages = 0;
    const startedAt = Date.now();

    while (true) {
      scannedPages += 1;
      chunks.push(...response.chunks.map(toIndexedRemoteChunk));
      if (
        response.pagination.page >= response.pagination.totalPages ||
        scannedPages >= limits.outlineMaxPages ||
        Date.now() - startedAt >= limits.outlineDeadlineMs
      ) {
        break;
      }
      page += 1;
      response = await this.client.documents.listChunks(documentId, {
        page,
        pageSize: limits.remotePageSize,
        includeAssetUrls: false,
      });
    }

    const truncated = response.pagination.page < response.pagination.totalPages;
    const sections = buildFlatSectionsFromIndexedChunks(chunks);
    this.scheduleParsedStorageSync(documentId, revisionKey);
    return {
      document: createRemoteKnowledgeDocument({
        documentId,
        response: firstPage,
        revisionKey,
        typeCounts: countIndexedTypes(chunks),
      }),
      totalChunks: firstPage.pagination.total,
      typeCounts: countIndexedTypes(chunks),
      sections,
      sectionTree: nestSections(sections),
      truncated,
      continuationCursor: truncated
        ? createContinuationCursor({
            documentId,
            revisionKey,
            nextPage: response.pagination.page + 1,
          })
        : undefined,
    };
  }

  private async tryReadChunksFromParsedStorage(params: {
    documentId: string;
    revisionKey: string;
    params: KnowledgeReadParams;
  }): Promise<KnowledgeReadResponse | null> {
    const parsedStorageConfig = this.parsedStorageConfig;
    if (!parsedStorageConfig) {
      return null;
    }

    const manifest = await this.readFreshParsedStorageManifest(
      params.documentId,
      params.revisionKey,
    );
    if (!manifest) {
      return null;
    }

    const pageParams = getReadPageParams(params.params);
    const indexedChunks = await this.readStoredSnapshotChunks({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      manifest,
      chunkType: params.params.chunkType,
    });
    if (!indexedChunks) {
      return null;
    }

    const scopedChunks = indexedChunks.filter((chunk) => matchesReadScope(chunk, params.params));
    const selected = hasScanReadFilters(params.params)
      ? selectReadWindow(
          scopedChunks,
          params.params,
          clampLimit(params.params.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT),
        )
      : scopedChunks.slice(
          (pageParams.page - 1) * pageParams.pageSize,
          pageParams.page * pageParams.pageSize,
        );
    const visibleChunks = applyAssetUrlPolicyToReadChunks(
      selected.map(toReadChunk),
      params.params.assetUrlPolicy,
    );
    const totalChunks = scopedChunks.length;
    return {
      document: createStoredKnowledgeDocument({
        documentId: params.documentId,
        manifest,
        revisionKey: params.revisionKey,
        typeCounts: countIndexedTypes(indexedChunks),
      }),
      chunks: visibleChunks,
      page: hasScanReadFilters(params.params) ? undefined : pageParams.page,
      pageSize: hasScanReadFilters(params.params) ? undefined : pageParams.pageSize,
      totalChunks,
      totalPages: Math.max(1, Math.ceil(totalChunks / pageParams.pageSize)),
      nextChunk: getNextChunkPosition(scopedChunks, selected),
    };
  }

  private async tryGrepChunksFromParsedStorage(params: {
    documentId: string;
    revisionKey: string;
    params: KnowledgeGrepParams;
  }): Promise<KnowledgeGrepResponse | null> {
    const parsedStorageConfig = this.parsedStorageConfig;
    if (!parsedStorageConfig) {
      return null;
    }

    const manifest = await this.readFreshParsedStorageManifest(
      params.documentId,
      params.revisionKey,
    );
    if (!manifest) {
      return null;
    }

    const indexedChunks = await this.readStoredSnapshotChunks({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      manifest,
      chunkType: params.params.chunkType,
    });
    if (!indexedChunks) {
      return null;
    }

    const maxResults = clampLimit(params.params.maxResults, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
    const contextChars = params.params.contextChars ?? DEFAULT_CONTEXT_CHARS;
    const matcher = createMatcher(params.params);
    const scopedChunks = indexedChunks.filter((chunk) => matchesGrepScope(chunk, params.params));
    const matches: KnowledgeGrepMatch[] = [];
    let scannedChunks = 0;

    for (const chunk of scopedChunks) {
      scannedChunks += 1;
      for (const match of matcher(chunk.content)) {
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
          return {
            document: createStoredKnowledgeDocument({
              documentId: params.documentId,
              manifest,
              revisionKey: params.revisionKey,
              typeCounts: countIndexedTypes(indexedChunks),
            }),
            matches,
            scannedChunks,
            truncated: true,
          };
        }
      }
    }

    return {
      document: createStoredKnowledgeDocument({
        documentId: params.documentId,
        manifest,
        revisionKey: params.revisionKey,
        typeCounts: countIndexedTypes(indexedChunks),
      }),
      matches,
      scannedChunks,
      truncated: false,
    };
  }

  private async tryReadOutlineFromParsedStorage(
    documentId: string,
    revisionKey: string,
  ): Promise<KnowledgeOutline | null> {
    const manifest = await this.readFreshParsedStorageManifest(documentId, revisionKey);
    if (!manifest) {
      return null;
    }

    const indexedChunks = await this.readStoredSnapshotChunks({
      documentId,
      revisionKey,
      manifest,
    });
    if (!indexedChunks) {
      return null;
    }

    const sections = buildFlatSectionsFromIndexedChunks(indexedChunks);
    const typeCounts = countIndexedTypes(indexedChunks);
    return {
      document: createStoredKnowledgeDocument({
        documentId,
        manifest,
        revisionKey,
        typeCounts,
      }),
      totalChunks: manifest.totalChunks,
      typeCounts,
      sections,
      sectionTree: nestSections(sections),
      truncated: false,
    };
  }

  private async readFreshParsedStorageManifest(
    documentId: string,
    revisionKey: string,
  ): Promise<KnowhereParsedSnapshotManifest | null> {
    const parsedStorageConfig = this.parsedStorageConfig;
    if (!parsedStorageConfig) {
      return null;
    }

    const manifest = await parsedStorageConfig.storage.readManifest({
      documentId,
      revisionKey,
    });
    if (!manifest || !isFreshManifest(manifest, revisionKey)) {
      return null;
    }
    return manifest;
  }

  private async readStoredSnapshotChunks(params: {
    documentId: string;
    revisionKey: string;
    manifest: KnowhereParsedSnapshotManifest;
    chunkType?: KnowledgeChunkType;
  }): Promise<IndexedKnowledgeChunk[] | null> {
    const parsedStorageConfig = this.parsedStorageConfig;
    if (!parsedStorageConfig) {
      return null;
    }

    const chunks: IndexedKnowledgeChunk[] = [];
    for (const pageReference of params.manifest.chunkPages) {
      const page = await parsedStorageConfig.storage.readChunkPage({
        documentId: params.documentId,
        revisionKey: params.revisionKey,
        page: pageReference.page,
        chunkType: params.chunkType,
      });
      if (!page) {
        return null;
      }
      chunks.push(
        ...page.chunks
          .filter((chunk) => !params.chunkType || chunk.chunkType === params.chunkType)
          .map(toIndexedSnapshotChunk),
      );
    }
    return chunks.sort((left, right) => left.position - right.position);
  }

  private async toRemoteReadChunks(params: {
    documentId: string;
    revisionKey: string;
    chunks: readonly DocumentChunk[];
    assetUrlPolicy: ParsedDocumentAssetUrlPolicy | undefined;
  }): Promise<KnowledgeReadChunk[]> {
    const readChunks = params.chunks.map((chunk) => toRemoteReadChunk(chunk));
    if (params.assetUrlPolicy === 'durable') {
      return this.hardenReadChunkAssetUrls({
        documentId: params.documentId,
        revisionKey: params.revisionKey,
        chunks: readChunks,
      });
    }
    return applyAssetUrlPolicyToReadChunks(readChunks, params.assetUrlPolicy);
  }

  private async hardenReadChunkAssetUrls(params: {
    documentId: string;
    revisionKey: string;
    chunks: readonly KnowledgeReadChunk[];
  }): Promise<KnowledgeReadChunk[]> {
    const parsedStorageConfig = this.parsedStorageConfig;
    if (!parsedStorageConfig) {
      return applyAssetUrlPolicyToReadChunks(params.chunks, 'none');
    }

    const hardenedChunks: KnowledgeReadChunk[] = [];
    for (const chunk of params.chunks) {
      hardenedChunks.push(
        await hardenReadChunkAssetUrls({
          storageConfig: parsedStorageConfig,
          documentId: params.documentId,
          revisionKey: params.revisionKey,
          chunk,
        }),
      );
    }
    return hardenedChunks;
  }

  private scheduleParsedStorageSync(documentId: string, revisionKey: string): void {
    const parsedStorageConfig = this.parsedStorageConfig;
    if (!parsedStorageConfig) {
      return;
    }

    const scheduler = parsedStorageConfig.scheduler ?? defaultParsedStorageScheduler;
    const task = async (): Promise<void> => {
      try {
        await this.syncRemoteDocumentToParsedStorage({
          documentId,
          revisionKey,
          parsedStorageConfig,
        });
      } catch (error) {
        await parsedStorageConfig.storage.writeSyncProgress({
          documentId,
          revisionKey,
          nextChunkPage: 1,
          nextAssetIndex: 0,
          status: 'failed',
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void Promise.resolve(scheduler.schedule(task)).catch(() => undefined);
  }

  private async syncRemoteDocumentToParsedStorage(params: {
    documentId: string;
    revisionKey?: string;
    parsedStorageConfig: ParsedDocumentStorageConfig;
  }): Promise<KnowledgeSyncParsedDocumentResponse> {
    const limits = getParsedStorageLimits(params.parsedStorageConfig.limits);
    const existingProgress = params.revisionKey
      ? await params.parsedStorageConfig.storage.readSyncProgress({
          documentId: params.documentId,
          revisionKey: params.revisionKey,
        })
      : null;
    let nextPage = existingProgress?.status === 'running' ? existingProgress.nextChunkPage : 1;
    let response = await this.client.documents.listChunks(params.documentId, {
      page: nextPage,
      pageSize: limits.remotePageSize,
      includeAssetUrls: true,
    });
    const revisionKey = params.revisionKey ?? getRemoteRevisionKey(response);
    if (params.revisionKey && getRemoteRevisionKey(response) !== params.revisionKey) {
      response = await this.client.documents.listChunks(params.documentId, {
        page: 1,
        pageSize: limits.remotePageSize,
        includeAssetUrls: true,
      });
      nextPage = 1;
    }

    const totalPages = response.pagination.totalPages;
    const chunkPages: KnowhereParsedSnapshotChunkPage[] = [];
    let syncedPages = 0;
    const startedAt = Date.now();

    while (nextPage <= totalPages) {
      if (syncedPages > 0) {
        response = await this.client.documents.listChunks(params.documentId, {
          page: nextPage,
          pageSize: limits.remotePageSize,
          includeAssetUrls: true,
        });
      }

      const readChunks = await this.hardenReadChunkAssetUrls({
        documentId: params.documentId,
        revisionKey,
        chunks: response.chunks.map(toRemoteReadChunk),
      });
      const page = toSnapshotChunkPageFromReadChunks({
        response,
        revisionKey,
        chunks: readChunks,
      });
      await params.parsedStorageConfig.storage.writeChunkPage({
        documentId: params.documentId,
        revisionKey,
        page,
      });
      chunkPages.push(page);
      nextPage += 1;
      syncedPages += 1;
      await params.parsedStorageConfig.storage.writeSyncProgress({
        documentId: params.documentId,
        revisionKey,
        nextChunkPage: nextPage,
        nextAssetIndex: 0,
        status: 'running',
        updatedAt: new Date().toISOString(),
      });

      if (
        syncedPages >= limits.maxPagesPerSync ||
        Date.now() - startedAt >= limits.syncDeadlineMs
      ) {
        return {
          documentId: params.documentId,
          revisionKey,
          completed: false,
        };
      }
    }

    const manifest = createRemoteSnapshotManifest({
      response,
      revisionKey,
      chunkPages,
    });
    await params.parsedStorageConfig.storage.writeManifest({
      documentId: params.documentId,
      revisionKey,
      manifest,
    });
    await params.parsedStorageConfig.storage.writeSyncProgress({
      documentId: params.documentId,
      revisionKey,
      nextChunkPage: totalPages + 1,
      nextAssetIndex: 0,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    });
    return {
      documentId: params.documentId,
      revisionKey,
      completed: true,
      manifest,
    };
  }

  private requireParsedStorageConfig(): ParsedDocumentStorageConfig {
    if (!this.parsedStorageConfig) {
      throw new ValidationError('parsed document storage is not configured');
    }
    return this.parsedStorageConfig;
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

interface NormalizedParsedStorageLimits {
  readonly chunkPageSize: number;
  readonly remotePageSize: number;
  readonly maxPagesPerSync: number;
  readonly maxAssetsPerSync: number;
  readonly syncDeadlineMs: number;
  readonly grepMaxPages: number;
  readonly grepDeadlineMs: number;
  readonly outlineMaxPages: number;
  readonly outlineDeadlineMs: number;
}

interface ContinuationCursor {
  readonly documentId: string;
  readonly revisionKey: string;
  readonly nextPage: number;
  readonly nextChunkIndex?: number;
  readonly nextMatchIndex?: number;
}

const defaultParsedStorageScheduler = {
  schedule(task: () => Promise<void>): void {
    void task();
  },
};

function getParsedStorageLimits(
  limits: ParsedDocumentStorageLimits | undefined,
): NormalizedParsedStorageLimits {
  return {
    chunkPageSize: clampLimit(limits?.chunkPageSize, DEFAULT_REMOTE_SCAN_PAGE_SIZE, MAX_PAGE_SIZE),
    remotePageSize: clampLimit(
      limits?.remotePageSize,
      DEFAULT_REMOTE_SCAN_PAGE_SIZE,
      MAX_PAGE_SIZE,
    ),
    maxPagesPerSync: clampLimit(limits?.maxPagesPerSync, DEFAULT_MAX_SYNC_PAGES, 1000),
    maxAssetsPerSync: clampLimit(limits?.maxAssetsPerSync, DEFAULT_MAX_SYNC_ASSETS, 1000),
    syncDeadlineMs: clampLimit(limits?.syncDeadlineMs, DEFAULT_SYNC_DEADLINE_MS, 60000),
    grepMaxPages: clampLimit(limits?.grepMaxPages, DEFAULT_GREP_MAX_PAGES, 1000),
    grepDeadlineMs: clampLimit(limits?.grepDeadlineMs, DEFAULT_GREP_DEADLINE_MS, 60000),
    outlineMaxPages: clampLimit(limits?.outlineMaxPages, DEFAULT_OUTLINE_MAX_PAGES, 1000),
    outlineDeadlineMs: clampLimit(limits?.outlineDeadlineMs, DEFAULT_OUTLINE_DEADLINE_MS, 60000),
  };
}

function validateReadParams(params: KnowledgeReadParams): void {
  const usesPagedDisplay =
    params.page !== undefined ||
    params.pageSize !== undefined ||
    params.assetUrlPolicy !== undefined;
  if (!usesPagedDisplay) {
    return;
  }

  if (
    params.sectionPath !== undefined ||
    params.startChunk !== undefined ||
    params.endChunk !== undefined ||
    params.chunkId !== undefined
  ) {
    throw new ValidationError(
      'page, pageSize, and assetUrlPolicy cannot be combined with sectionPath, startChunk, endChunk, or chunkId',
    );
  }
}

function hasScanReadFilters(params: KnowledgeReadParams): boolean {
  return (
    params.sectionPath !== undefined ||
    params.startChunk !== undefined ||
    params.endChunk !== undefined ||
    params.chunkId !== undefined
  );
}

function getReadPageParams(params: KnowledgeReadParams): {
  readonly page: number;
  readonly pageSize: number;
} {
  return {
    page: clampLimit(params.page, 1, Number.MAX_SAFE_INTEGER),
    pageSize: clampLimit(params.pageSize ?? params.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

function shouldRequestRemoteAssetUrls(
  assetUrlPolicy: ParsedDocumentAssetUrlPolicy | undefined,
  parsedStorageConfig: ParsedDocumentStorageConfig | undefined,
): boolean {
  return assetUrlPolicy === 'durable' && parsedStorageConfig !== undefined;
}

function getRemoteRevisionKey(response: DocumentChunkListResponse): string {
  const revisionKey = response.jobResultId ?? response.jobId;
  if (!revisionKey) {
    throw new Error(
      `Cannot read server document ${response.documentId}: current published revision was not returned.`,
    );
  }
  return revisionKey;
}

function createRemoteKnowledgeDocument(params: {
  readonly documentId: string;
  readonly response: DocumentChunkListResponse;
  readonly revisionKey: string;
  readonly typeCounts?: Record<KnowledgeChunkType, number>;
}): LocalKnowledgeDocument {
  return {
    localDocumentId: params.documentId,
    jobId: params.response.jobId ?? params.revisionKey,
    documentId: params.documentId,
    namespace: params.response.namespace,
    sourceFileName: params.documentId,
    chunkCount: params.response.pagination.total,
    typeCounts: params.typeCounts ?? countRemoteChunkTypes(params.response.chunks),
    resultDirectoryPath: `remote:${params.documentId}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function createStoredKnowledgeDocument(params: {
  readonly documentId: string;
  readonly manifest: KnowhereParsedSnapshotManifest;
  readonly revisionKey: string;
  readonly typeCounts: Record<KnowledgeChunkType, number>;
}): LocalKnowledgeDocument {
  return {
    localDocumentId: params.documentId,
    jobId: params.manifest.jobId || params.revisionKey,
    documentId: params.manifest.documentId ?? params.documentId,
    namespace: params.manifest.namespace,
    sourceFileName: params.manifest.sourceFileName,
    chunkCount: params.manifest.totalChunks,
    typeCounts: params.typeCounts,
    resultDirectoryPath: `parsed-storage:${params.documentId}`,
    createdAt: new Date(params.manifest.createdAt),
    updatedAt: new Date(params.manifest.createdAt),
  };
}

function isFreshManifest(manifest: KnowhereParsedSnapshotManifest, revisionKey: string): boolean {
  return (manifest.revisionKey ?? manifest.jobId) === revisionKey;
}

function toRemoteReadChunk(chunk: DocumentChunk): KnowledgeReadChunk {
  const metadata = cloneMetadata(chunk.metadata);
  return {
    position: toChunkPosition(chunk),
    chunkId: chunk.chunkId,
    chunkType: chunk.chunkType,
    contentSource: chunk.contentSource ?? undefined,
    content: chunk.content ?? '',
    readableContent: getReadableRemoteChunkContent(chunk, metadata),
    sectionPath: chunk.sectionPath ?? '',
    sourceChunkPath: chunk.sourceChunkPath ?? chunk.sectionPath ?? '',
    filePath: chunk.filePath ?? undefined,
    assetUrl: chunk.assetUrl ?? undefined,
    pageNumbers: getChunkPageNumbers(metadata),
    metadata,
  };
}

function getReadableRemoteChunkContent(
  chunk: DocumentChunk,
  metadata: Record<string, unknown>,
): string {
  if (chunk.chunkType !== 'page') {
    return chunk.content ?? '';
  }

  const summary = metadata.summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary : (chunk.content ?? '');
}

function toIndexedRemoteChunk(chunk: DocumentChunk): IndexedKnowledgeChunk {
  const readChunk = toRemoteReadChunk(chunk);
  return toIndexedReadChunk(readChunk);
}

function toIndexedSnapshotChunk(chunk: KnowhereParsedSnapshotChunk): IndexedKnowledgeChunk {
  return toIndexedReadChunk({
    position: chunk.sortOrder,
    chunkId: chunk.chunkId,
    chunkType: chunk.chunkType as KnowledgeChunkType,
    contentSource: chunk.contentSource,
    content: chunk.content,
    readableContent:
      chunk.chunkType === 'page' &&
      typeof chunk.metadata.summary === 'string' &&
      chunk.metadata.summary.trim().length > 0
        ? chunk.metadata.summary
        : chunk.content,
    sectionPath: chunk.sectionPath ?? '',
    sourceChunkPath: chunk.sourceChunkPath,
    filePath: chunk.filePath,
    assetUrl: chunk.assetUrl,
    pageNumbers: getChunkPageNumbers(chunk.metadata),
    metadata: cloneMetadata(chunk.metadata),
  });
}

function toIndexedReadChunk(chunk: KnowledgeReadChunk): IndexedKnowledgeChunk {
  return {
    source: createSyntheticChunk(chunk),
    position: chunk.position,
    chunkId: chunk.chunkId,
    chunkType: chunk.chunkType,
    contentSource: chunk.contentSource,
    content: chunk.content,
    readableContent: chunk.readableContent,
    sectionPath: chunk.sectionPath,
    sourceChunkPath: chunk.sourceChunkPath,
    filePath: chunk.filePath,
    assetUrl: chunk.assetUrl,
    pageNumbers: chunk.pageNumbers,
    metadata: chunk.metadata,
  };
}

function createSyntheticChunk(chunk: KnowledgeReadChunk): Chunk {
  return {
    chunkId: chunk.chunkId,
    type: chunk.chunkType,
    contentSource: chunk.contentSource,
    content: chunk.content,
    path: chunk.sourceChunkPath,
    metadata: chunk.metadata,
  } as Chunk;
}

function toChunkPosition(chunk: DocumentChunk | undefined): number {
  return chunk ? chunk.sortOrder + 1 : 1;
}

function buildFlatSectionsFromIndexedChunks(chunks: IndexedKnowledgeChunk[]): KnowledgeSection[] {
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

function matchesRemoteReadScope(chunk: DocumentChunk, params: KnowledgeReadParams): boolean {
  return matchesReadScope(toIndexedRemoteChunk(chunk), params);
}

function getNextChunkPosition(
  chunks: readonly IndexedKnowledgeChunk[],
  selected: readonly IndexedKnowledgeChunk[],
): number | undefined {
  const lastSelected = selected[selected.length - 1];
  if (!lastSelected || selected.length >= chunks.length) {
    return undefined;
  }
  return chunks[chunks.indexOf(lastSelected) + 1]?.position;
}

function applyAssetUrlPolicyToReadChunks(
  chunks: readonly KnowledgeReadChunk[],
  assetUrlPolicy: ParsedDocumentAssetUrlPolicy | undefined,
): KnowledgeReadChunk[] {
  if (assetUrlPolicy !== 'none') {
    return chunks.map((chunk) => ({
      ...chunk,
      metadata: cloneMetadata(chunk.metadata),
    }));
  }

  return chunks.map((chunk) => ({
    ...chunk,
    assetUrl: undefined,
    metadata: removeAssetUrlsFromMetadata(chunk.metadata),
  }));
}

async function hardenReadChunkAssetUrls(params: {
  readonly storageConfig: ParsedDocumentStorageConfig;
  readonly documentId: string;
  readonly revisionKey: string;
  readonly chunk: KnowledgeReadChunk;
}): Promise<KnowledgeReadChunk> {
  const metadata = cloneMetadata(params.chunk.metadata);
  const assetUrl = await hardenPrimaryAssetUrl(params, metadata);
  const pageAssets = await hardenPageAssetUrls(params, metadata);
  if (pageAssets) {
    metadata.pageAssets = pageAssets;
  }

  return {
    ...params.chunk,
    assetUrl,
    metadata,
  };
}

async function hardenPrimaryAssetUrl(
  params: {
    readonly storageConfig: ParsedDocumentStorageConfig;
    readonly documentId: string;
    readonly revisionKey: string;
    readonly chunk: KnowledgeReadChunk;
  },
  metadata: Record<string, unknown>,
): Promise<string | undefined> {
  if (!params.chunk.assetUrl || !params.chunk.filePath) {
    return undefined;
  }

  return writeDurableAssetUrl({
    storageConfig: params.storageConfig,
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    sourcePath: params.chunk.filePath,
    sourceUrl: params.chunk.assetUrl,
    fallbackContentType: inferContentTypeFromPath(params.chunk.filePath),
    metadata: {
      chunkId: params.chunk.chunkId,
      chunkType: params.chunk.chunkType,
      sourcePath: params.chunk.filePath,
      ...stringifyFlatMetadata(metadata),
    },
  });
}

async function hardenPageAssetUrls(
  params: {
    readonly storageConfig: ParsedDocumentStorageConfig;
    readonly documentId: string;
    readonly revisionKey: string;
    readonly chunk: KnowledgeReadChunk;
  },
  metadata: Record<string, unknown>,
): Promise<unknown[] | undefined> {
  const pageAssets = toUnknownArray(metadata.pageAssets);
  if (!pageAssets) {
    return undefined;
  }

  const hardenedAssets: unknown[] = [];
  for (const pageAsset of pageAssets) {
    if (!isRecord(pageAsset)) {
      hardenedAssets.push(pageAsset);
      continue;
    }

    const artifactRef = pageAsset.artifactRef;
    const sourceUrl = pageAsset.assetUrl;
    if (typeof artifactRef !== 'string' || typeof sourceUrl !== 'string') {
      hardenedAssets.push(removeAssetUrlField(pageAsset));
      continue;
    }

    const durableUrl = await writeDurableAssetUrl({
      storageConfig: params.storageConfig,
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      sourcePath: artifactRef,
      sourceUrl,
      fallbackContentType:
        typeof pageAsset.contentType === 'string'
          ? pageAsset.contentType
          : inferContentTypeFromPath(artifactRef),
      metadata: {
        chunkId: params.chunk.chunkId,
        chunkType: params.chunk.chunkType,
        sourcePath: artifactRef,
      },
    });
    const rest = removeAssetUrlField(pageAsset);
    hardenedAssets.push(durableUrl ? { ...rest, assetUrl: durableUrl } : rest);
  }

  return hardenedAssets;
}

async function writeDurableAssetUrl(params: {
  readonly storageConfig: ParsedDocumentStorageConfig;
  readonly documentId: string;
  readonly revisionKey: string;
  readonly sourcePath: string;
  readonly sourceUrl: string;
  readonly fallbackContentType: string;
  readonly metadata: Readonly<Record<string, string>>;
}): Promise<string | undefined> {
  const existingUrl = await params.storageConfig.storage.getAssetUrl({
    documentId: params.documentId,
    revisionKey: params.revisionKey,
    sourcePath: params.sourcePath,
  });
  if (existingUrl) {
    return existingUrl;
  }

  try {
    const fetched = await fetchAsset(params.sourceUrl, params.fallbackContentType);
    const written = await params.storageConfig.storage.writeAsset({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      sourcePath: params.sourcePath,
      body: fetched.body,
      contentType: fetched.contentType,
      metadata: params.metadata,
    });
    return (
      written.url ??
      (await params.storageConfig.storage.getAssetUrl({
        documentId: params.documentId,
        revisionKey: params.revisionKey,
        sourcePath: params.sourcePath,
      })) ??
      undefined
    );
  } catch {
    return undefined;
  }
}

async function fetchAsset(
  sourceUrl: string,
  fallbackContentType: string,
): Promise<{
  readonly body: Uint8Array;
  readonly contentType: string;
}> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Unable to fetch parsed asset: ${response.status}`);
  }

  return {
    body: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? fallbackContentType,
  };
}

function removeAssetUrlsFromMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const cloned = cloneMetadata(metadata);
  const pageAssets = toUnknownArray(cloned.pageAssets);
  if (!pageAssets) {
    return cloned;
  }

  cloned.pageAssets = pageAssets.map((pageAsset) => {
    if (!isRecord(pageAsset)) {
      return pageAsset;
    }
    return removeAssetUrlField(pageAsset);
  });
  return cloned;
}

function removeAssetUrlField(value: Record<string, unknown>): Record<string, unknown> {
  const cloned = { ...value };
  delete cloned.assetUrl;
  return cloned;
}

function toSnapshotChunkPageFromReadChunks(params: {
  readonly response: DocumentChunkListResponse;
  readonly revisionKey: string;
  readonly chunks: readonly KnowledgeReadChunk[];
}): KnowhereParsedSnapshotChunkPage {
  return {
    version: 1,
    jobId: params.response.jobId ?? params.revisionKey,
    revisionKey: params.revisionKey,
    documentId: params.response.documentId,
    namespace: params.response.namespace,
    sourceFileName: params.response.documentId,
    page: params.response.pagination.page,
    pageSize: params.response.pagination.pageSize,
    total: params.response.pagination.total,
    totalPages: params.response.pagination.totalPages,
    chunks: params.chunks.map(toSnapshotChunkFromReadChunk),
  };
}

function toSnapshotChunkFromReadChunk(chunk: KnowledgeReadChunk): KnowhereParsedSnapshotChunk {
  return {
    id: chunk.chunkId,
    chunkId: chunk.chunkId,
    chunkType: chunk.chunkType,
    contentSource: chunk.contentSource,
    content: chunk.content,
    sectionPath: chunk.sectionPath,
    sourceChunkPath: chunk.sourceChunkPath,
    filePath: chunk.filePath,
    sortOrder: chunk.position,
    metadata: cloneMetadata(chunk.metadata),
    assetUrl: chunk.assetUrl,
  };
}

function createRemoteSnapshotManifest(params: {
  readonly response: DocumentChunkListResponse;
  readonly revisionKey: string;
  readonly chunkPages: readonly KnowhereParsedSnapshotChunkPage[];
}): KnowhereParsedSnapshotManifest {
  return {
    version: 1,
    kind: 'knowhere-parsed-result-snapshot',
    jobId: params.response.jobId ?? params.revisionKey,
    revisionKey: params.revisionKey,
    documentId: params.response.documentId,
    namespace: params.response.namespace,
    sourceFileName: params.response.documentId,
    totalChunks: params.response.pagination.total,
    typeCounts: countSnapshotPagesTypes(params.chunkPages),
    chunkPageSize: params.response.pagination.pageSize,
    chunkPages: Array.from({ length: params.response.pagination.totalPages }, (_, index) => ({
      page: index + 1,
      pageSize: params.response.pagination.pageSize,
      chunkCount:
        index + 1 === params.response.pagination.totalPages
          ? params.response.pagination.total -
            params.response.pagination.pageSize * (params.response.pagination.totalPages - 1)
          : params.response.pagination.pageSize,
      key: `parsed/chunks/page-${index + 1}.json`,
    })),
    assetUrlsByFilePath: {},
    createdAt: new Date().toISOString(),
  };
}

function countSnapshotPagesTypes(
  pages: readonly KnowhereParsedSnapshotChunkPage[],
): Record<KnowledgeChunkType, number> {
  return pages
    .flatMap((page) => page.chunks)
    .reduce<Record<KnowledgeChunkType, number>>(
      (counts, chunk) => {
        const chunkType = chunk.chunkType as KnowledgeChunkType;
        counts[chunkType] += 1;
        return counts;
      },
      { text: 0, image: 0, table: 0, page: 0 },
    );
}

function countRemoteChunkTypes(
  chunks: readonly DocumentChunk[],
): Record<KnowledgeChunkType, number> {
  return chunks.reduce<Record<KnowledgeChunkType, number>>(
    (counts, chunk) => {
      counts[chunk.chunkType] += 1;
      return counts;
    },
    { text: 0, image: 0, table: 0, page: 0 },
  );
}

function createContinuationCursor(cursor: ContinuationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function createGrepContinuationCursor(params: {
  readonly documentId: string;
  readonly revisionKey: string;
  readonly response: DocumentChunkListResponse;
  readonly chunkIndex: number;
  readonly matchIndex: number;
  readonly chunkMatchCount: number;
}): string | undefined {
  if (params.matchIndex + 1 < params.chunkMatchCount) {
    return createContinuationCursor({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      nextPage: params.response.pagination.page,
      nextChunkIndex: params.chunkIndex,
      nextMatchIndex: params.matchIndex + 1,
    });
  }

  if (params.chunkIndex + 1 < params.response.chunks.length) {
    return createContinuationCursor({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      nextPage: params.response.pagination.page,
      nextChunkIndex: params.chunkIndex + 1,
      nextMatchIndex: 0,
    });
  }

  if (params.response.pagination.page < params.response.pagination.totalPages) {
    return createContinuationCursor({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      nextPage: params.response.pagination.page + 1,
      nextChunkIndex: 0,
      nextMatchIndex: 0,
    });
  }

  return undefined;
}

function parseContinuationCursor(value: string | undefined): ContinuationCursor | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const documentId = parsed.documentId;
    const revisionKey = parsed.revisionKey;
    const nextPage = parsed.nextPage;
    const nextChunkIndex = parsed.nextChunkIndex;
    const nextMatchIndex = parsed.nextMatchIndex;
    if (
      typeof documentId !== 'string' ||
      typeof revisionKey !== 'string' ||
      typeof nextPage !== 'number' ||
      !Number.isInteger(nextPage) ||
      nextPage < 1 ||
      !isOptionalNonNegativeInteger(nextChunkIndex) ||
      !isOptionalNonNegativeInteger(nextMatchIndex)
    ) {
      return null;
    }
    return {
      documentId,
      revisionKey,
      nextPage,
      nextChunkIndex,
      nextMatchIndex,
    };
  } catch {
    return null;
  }
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
  );
}

function cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return { ...metadata };
}

function stringifyFlatMetadata(metadata: Record<string, unknown>): Record<string, string> {
  const entries = Object.entries(metadata).flatMap(([key, value]): Array<[string, string]> => {
    if (typeof value === 'string') {
      return [[key, value]];
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return [[key, String(value)]];
    }
    return [];
  });
  return Object.fromEntries(entries);
}

function toUnknownArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function inferContentTypeFromPath(filePath: string): string {
  const extension = filePath.split('.').at(-1)?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'html' || extension === 'htm') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      assetUrl: getChunkAssetUrl(chunk),
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
  const values = [metadata.pageNums, metadata.page_nums].filter(Array.isArray);
  const pageNumbers = values.flatMap((value) =>
    value.filter(
      (pageNumber): pageNumber is number => Number.isInteger(pageNumber) && pageNumber > 0,
    ),
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

function getChunkAssetUrl(chunk: Chunk): string | undefined {
  return chunk.type === 'image' || chunk.type === 'table' ? chunk.assetUrl : undefined;
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
    assetUrl: chunk.assetUrl,
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
    chunkId: result.chunkId,
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
    chunkId: result.chunkId,
    chunkType: result.chunkType,
    content: result.content,
    score: result.score,
    sectionPath: result.source.sectionPath ?? undefined,
    sourceFileName: result.source.sourceFileName ?? undefined,
  };
}
