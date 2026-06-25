import { createHash } from 'crypto';
import os from 'os';
import { promises as fs } from 'fs';
import path from 'path';

import { parseResultDirectory, saveExpandedParseResult } from '../lib/result-parser.js';
import type { ParseResult } from '../types/index.js';
import type {
  LocalKnowledgeDocument,
  KnowledgeAsyncCacheStatus,
  KnowledgeChunkType,
} from './types.js';

const STORE_VERSION = 1;
const LOCAL_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface StoredKnowledgeDocument {
  localDocumentId: string;
  jobId: string;
  documentId?: string;
  namespace?: string;
  sourceFileName: string;
  chunkCount: number;
  typeCounts: Record<KnowledgeChunkType, number>;
  resultDirectoryPath: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredAsyncParseJob {
  jobId: string;
  localDocumentId?: string;
  cacheStatus: KnowledgeAsyncCacheStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LocalKnowledgeAsyncParseJob {
  jobId: string;
  localDocumentId?: string;
  cacheStatus: KnowledgeAsyncCacheStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface StoreIndex {
  version: number;
  documents: StoredKnowledgeDocument[];
  asyncParseJobs?: StoredAsyncParseJob[];
}

export class LocalKnowledgeStore {
  private readonly cacheDirectory: string;
  private readonly indexPath: string;
  private readonly resultCache = new Map<string, ParseResult>();

  constructor(cacheDirectory?: string) {
    this.cacheDirectory =
      cacheDirectory ?? path.join(os.homedir(), '.knowhere-node-sdk', 'knowledge');
    this.indexPath = path.join(this.cacheDirectory, 'index.json');
  }

  async saveResult(
    result: ParseResult,
    options?: { localDocumentId?: string },
  ): Promise<LocalKnowledgeDocument> {
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    const now = new Date();
    const index = await this.readIndex();
    const localDocumentId = validateLocalDocumentId(
      options?.localDocumentId ?? createLocalDocumentId(result),
    );
    const resultDirectoryPath = this.getResultDirectoryPath(localDocumentId);
    await fs.rm(resultDirectoryPath, { recursive: true, force: true });
    await saveExpandedParseResult(result, resultDirectoryPath);
    this.resultCache.set(localDocumentId, result);

    const existing = index.documents.find(
      (document) => document.localDocumentId === localDocumentId,
    );

    const stored: StoredKnowledgeDocument = {
      localDocumentId,
      jobId: result.jobId,
      documentId: result.documentId,
      namespace: result.namespace,
      sourceFileName: result.manifest.sourceFileName,
      chunkCount: result.chunks.length,
      typeCounts: countChunkTypes(result),
      resultDirectoryPath,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const nextDocuments = [
      stored,
      ...index.documents.filter((document) => document.localDocumentId !== localDocumentId),
    ];
    const asyncParseJobs = (index.asyncParseJobs ?? []).map((job) =>
      job.jobId === result.jobId
        ? {
            ...job,
            localDocumentId,
            cacheStatus: 'cached' as const,
            updatedAt: now.toISOString(),
          }
        : job,
    );
    await this.writeIndex({
      version: STORE_VERSION,
      documents: nextDocuments,
      asyncParseJobs,
    });
    return toLocalKnowledgeDocument(stored);
  }

  async saveAsyncParseJob(params: { jobId: string; localDocumentId?: string }): Promise<void> {
    const now = new Date().toISOString();
    const index = await this.readIndex();
    const localDocumentId = params.localDocumentId
      ? validateLocalDocumentId(params.localDocumentId)
      : undefined;
    const existing = (index.asyncParseJobs ?? []).find((job) => job.jobId === params.jobId);
    const stored: StoredAsyncParseJob = {
      jobId: params.jobId,
      localDocumentId: localDocumentId ?? existing?.localDocumentId,
      cacheStatus: existing?.cacheStatus ?? 'pending',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.writeIndex({
      version: STORE_VERSION,
      documents: index.documents,
      asyncParseJobs: [
        stored,
        ...(index.asyncParseJobs ?? []).filter((job) => job.jobId !== params.jobId),
      ],
    });
  }

  async getAsyncParseJob(jobId: string): Promise<StoredAsyncParseJob | undefined> {
    const index = await this.readIndex();
    return (index.asyncParseJobs ?? []).find((job) => job.jobId === jobId);
  }

  async listRecoverableAsyncParseJobs(): Promise<LocalKnowledgeAsyncParseJob[]> {
    const index = await this.readIndex();
    return (index.asyncParseJobs ?? [])
      .filter((job) => job.cacheStatus === 'pending' || job.cacheStatus === 'not_available')
      .map(toLocalKnowledgeAsyncParseJob);
  }

  async updateAsyncParseJobCacheStatus(params: {
    jobId: string;
    cacheStatus: KnowledgeAsyncCacheStatus;
    localDocumentId?: string;
  }): Promise<void> {
    const index = await this.readIndex();
    const localDocumentId = params.localDocumentId
      ? validateLocalDocumentId(params.localDocumentId)
      : undefined;
    const existing = (index.asyncParseJobs ?? []).find((job) => job.jobId === params.jobId);
    if (!existing) {
      return;
    }

    const now = new Date().toISOString();
    const stored: StoredAsyncParseJob = {
      ...existing,
      localDocumentId: localDocumentId ?? existing.localDocumentId,
      cacheStatus: params.cacheStatus,
      updatedAt: now,
    };

    await this.writeIndex({
      version: STORE_VERSION,
      documents: index.documents,
      asyncParseJobs: [
        stored,
        ...(index.asyncParseJobs ?? []).filter((job) => job.jobId !== params.jobId),
      ],
    });
  }

  async listDocuments(): Promise<LocalKnowledgeDocument[]> {
    const index = await this.readIndex();
    return index.documents.map(toLocalKnowledgeDocument);
  }

  async getDocument(localDocumentId: string): Promise<LocalKnowledgeDocument | undefined> {
    validateLocalDocumentId(localDocumentId);
    const index = await this.readIndex();
    const stored = index.documents.find((document) => document.localDocumentId === localDocumentId);
    return stored ? toLocalKnowledgeDocument(stored) : undefined;
  }

  async loadResult(localDocumentId: string): Promise<{
    document: LocalKnowledgeDocument;
    result: ParseResult;
  }> {
    const document = await this.getDocument(localDocumentId);
    if (!document) {
      throw new Error(`Local Knowhere document not found: ${localDocumentId}`);
    }

    const cachedResult = this.resultCache.get(localDocumentId);
    if (cachedResult) {
      return { document, result: cachedResult };
    }

    const result = await this.loadStoredResult(document);
    result.namespace = document.namespace;
    result.documentId = document.documentId;
    this.resultCache.set(localDocumentId, result);
    return { document, result };
  }

  private getResultDirectoryPath(localDocumentId: string): string {
    const documentsDirectory = path.resolve(this.cacheDirectory, 'documents');
    const resultDirectoryPath = path.resolve(documentsDirectory, localDocumentId);

    if (!isPathInsideDirectory(resultDirectoryPath, documentsDirectory)) {
      throw new Error(`Local Knowhere document ID resolves outside the cache: ${localDocumentId}`);
    }

    return resultDirectoryPath;
  }

  private async loadStoredResult(document: LocalKnowledgeDocument): Promise<ParseResult> {
    return parseResultDirectory(document.resultDirectoryPath);
  }

  private async readIndex(): Promise<StoreIndex> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as StoreIndex;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.documents)) {
        return { version: STORE_VERSION, documents: [], asyncParseJobs: [] };
      }
      return {
        version: STORE_VERSION,
        documents: parsed.documents,
        asyncParseJobs: Array.isArray(parsed.asyncParseJobs) ? parsed.asyncParseJobs : [],
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { version: STORE_VERSION, documents: [], asyncParseJobs: [] };
      }
      throw error;
    }
  }

  private async writeIndex(index: StoreIndex): Promise<void> {
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
  }
}

function validateLocalDocumentId(localDocumentId: string): string {
  if (
    !LOCAL_DOCUMENT_ID_PATTERN.test(localDocumentId) ||
    localDocumentId.includes('..') ||
    path.basename(localDocumentId) !== localDocumentId
  ) {
    throw new Error(
      'Local Knowhere document ID must be a safe slug containing only letters, numbers, dots, underscores, or hyphens',
    );
  }

  return localDocumentId;
}

function isPathInsideDirectory(targetPath: string, parentDirectory: string): boolean {
  const relativePath = path.relative(parentDirectory, targetPath);
  return (
    relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function createLocalDocumentId(result: ParseResult): string {
  const hash = createHash('sha256')
    .update(result.jobId)
    .update('\0')
    .update(result.manifest.sourceFileName)
    .digest('hex')
    .slice(0, 16);
  return `local_${hash}`;
}

function countChunkTypes(result: ParseResult): Record<KnowledgeChunkType, number> {
  return result.chunks.reduce<Record<KnowledgeChunkType, number>>(
    (counts, chunk) => {
      counts[chunk.type] += 1;
      return counts;
    },
    { text: 0, image: 0, table: 0 },
  );
}

function toLocalKnowledgeDocument(stored: StoredKnowledgeDocument): LocalKnowledgeDocument {
  return {
    localDocumentId: stored.localDocumentId,
    jobId: stored.jobId,
    documentId: stored.documentId,
    namespace: stored.namespace,
    sourceFileName: stored.sourceFileName,
    chunkCount: stored.chunkCount,
    typeCounts: stored.typeCounts,
    resultDirectoryPath: stored.resultDirectoryPath,
    createdAt: new Date(stored.createdAt),
    updatedAt: new Date(stored.updatedAt),
  };
}

function toLocalKnowledgeAsyncParseJob(stored: StoredAsyncParseJob): LocalKnowledgeAsyncParseJob {
  return {
    ...stored,
    createdAt: new Date(stored.createdAt),
    updatedAt: new Date(stored.updatedAt),
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
