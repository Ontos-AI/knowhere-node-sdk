import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type {
  ParsedDocumentObject,
  ParsedDocumentObjectHead,
  ParsedDocumentObjectParams,
  ParsedDocumentRevisionParams,
  ParsedDocumentStorage,
  ParsedDocumentSyncProgress,
  ParsedDocumentWriteObjectParams,
  ParsedDocumentWriteObjectResult,
} from '../types/storage.js';

const syncProgressPath = '.knowhere-sdk/sync-progress.json';

interface StoredObjectMetadata {
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export class DiskParsedDocumentStorage implements ParsedDocumentStorage {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  async readObject(params: ParsedDocumentObjectParams): Promise<ParsedDocumentObject | null> {
    const objectPath = this.getObjectPath(params);
    try {
      const body = await fs.readFile(objectPath);
      const metadata = await this.readObjectMetadata(objectPath);
      return {
        ...params,
        body,
        contentType: metadata?.contentType,
        contentLength: body.byteLength,
        metadata: metadata?.metadata,
        url: toFileUrl(objectPath),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeObject(
    params: ParsedDocumentWriteObjectParams,
  ): Promise<ParsedDocumentWriteObjectResult> {
    const objectPath = this.getObjectPath(params);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, params.body);
    await this.writeObjectMetadata(objectPath, {
      contentType: params.contentType,
      metadata: params.metadata,
    });
    return {
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      path: params.path,
      url: toFileUrl(objectPath),
    };
  }

  async headObject(params: ParsedDocumentObjectParams): Promise<ParsedDocumentObjectHead | null> {
    const objectPath = this.getObjectPath(params);
    try {
      const stat = await fs.stat(objectPath);
      const metadata = await this.readObjectMetadata(objectPath);
      return {
        ...params,
        contentType: metadata?.contentType,
        contentLength: stat.size,
        metadata: metadata?.metadata,
        url: toFileUrl(objectPath),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getObjectUrl(params: ParsedDocumentObjectParams): Promise<string | null> {
    const head = await this.headObject(params);
    return head?.url ?? null;
  }

  async deletePrefix(params: ParsedDocumentRevisionParams): Promise<void> {
    await fs.rm(this.getRevisionDirectory(params.documentId, params.revisionKey), {
      recursive: true,
      force: true,
    });
  }

  async readSyncProgress(
    params: ParsedDocumentRevisionParams,
  ): Promise<ParsedDocumentSyncProgress | null> {
    return this.readOptionalJson<ParsedDocumentSyncProgress>({
      ...params,
      path: syncProgressPath,
    });
  }

  async writeSyncProgress(params: ParsedDocumentSyncProgress): Promise<void> {
    await this.writeObject({
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      path: syncProgressPath,
      body: Buffer.from(JSON.stringify(params, null, 2), 'utf8'),
      contentType: 'application/json; charset=utf-8',
    });
  }

  private getObjectPath(params: ParsedDocumentObjectParams): string {
    const revisionDirectory = this.getRevisionDirectory(params.documentId, params.revisionKey);
    const objectPath = path.resolve(revisionDirectory, normalizeRelativeStoragePath(params.path));
    if (!isPathInsideDirectory(objectPath, revisionDirectory)) {
      throw new Error(`Parsed document object path resolves outside storage: ${params.path}`);
    }
    return objectPath;
  }

  private getRevisionDirectory(documentId: string, revisionKey: string): string {
    return path.join(this.rootDirectory, hashPathPart(documentId), hashPathPart(revisionKey));
  }

  private async readOptionalJson<T>(params: ParsedDocumentObjectParams): Promise<T | null> {
    const object = await this.readObject(params);
    if (!object) {
      return null;
    }
    return JSON.parse(Buffer.from(object.body).toString('utf8')) as T;
  }

  private async readObjectMetadata(filePath: string): Promise<StoredObjectMetadata | null> {
    try {
      return JSON.parse(
        await fs.readFile(getMetadataPath(filePath), 'utf8'),
      ) as StoredObjectMetadata;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeObjectMetadata(
    filePath: string,
    metadata: StoredObjectMetadata,
  ): Promise<void> {
    await fs.writeFile(getMetadataPath(filePath), JSON.stringify(metadata, null, 2), {
      encoding: 'utf8',
      flag: 'w',
    });
  }
}

function getMetadataPath(filePath: string): string {
  return `${filePath}.metadata.json`;
}

function hashPathPart(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error('Parsed document storage path part must be a non-empty value.');
  }
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

function normalizeRelativeStoragePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid parsed storage path: ${value}`);
  }
  return normalized;
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toFileUrl(filePath: string): string {
  return `file://${filePath}`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
