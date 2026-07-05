import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type {
  KnowhereParsedSnapshotChunkPage,
  KnowhereParsedSnapshotManifest,
  ParsedDocumentStorage,
  ParsedDocumentSyncProgress,
} from '../types/storage.js';

export class DiskParsedDocumentStorage implements ParsedDocumentStorage {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  async readManifest(params: {
    readonly documentId: string;
    readonly revisionKey: string;
  }): Promise<KnowhereParsedSnapshotManifest | null> {
    return this.readOptionalJson<KnowhereParsedSnapshotManifest>(
      this.getManifestPath(params.documentId, params.revisionKey),
    );
  }

  async writeManifest(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly manifest: KnowhereParsedSnapshotManifest;
  }): Promise<void> {
    await this.writeJson(
      this.getManifestPath(params.documentId, params.revisionKey),
      params.manifest,
    );
  }

  async readChunkPage(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly page: number;
  }): Promise<KnowhereParsedSnapshotChunkPage | null> {
    return this.readOptionalJson<KnowhereParsedSnapshotChunkPage>(
      this.getChunkPagePath(params.documentId, params.revisionKey, params.page),
    );
  }

  async writeChunkPage(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly page: KnowhereParsedSnapshotChunkPage;
  }): Promise<void> {
    await this.writeJson(
      this.getChunkPagePath(params.documentId, params.revisionKey, params.page.page),
      params.page,
    );
  }

  async writeAsset(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly sourcePath: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<{
    readonly sourcePath: string;
    readonly url?: string;
  }> {
    const assetPath = this.getAssetPath(params.documentId, params.revisionKey, params.sourcePath);
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.writeFile(assetPath, params.body);
    await this.writeJson(`${assetPath}.metadata.json`, {
      contentType: params.contentType,
      metadata: params.metadata ?? {},
    });
    return {
      sourcePath: params.sourcePath,
      url: toFileUrl(assetPath),
    };
  }

  async getAssetUrl(params: {
    readonly documentId: string;
    readonly revisionKey: string;
    readonly sourcePath: string;
  }): Promise<string | null> {
    const assetPath = this.getAssetPath(params.documentId, params.revisionKey, params.sourcePath);
    try {
      await fs.access(assetPath);
      return toFileUrl(assetPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async readSyncProgress(params: {
    readonly documentId: string;
    readonly revisionKey: string;
  }): Promise<ParsedDocumentSyncProgress | null> {
    return this.readOptionalJson<ParsedDocumentSyncProgress>(
      this.getProgressPath(params.documentId, params.revisionKey),
    );
  }

  async writeSyncProgress(params: ParsedDocumentSyncProgress): Promise<void> {
    await this.writeJson(this.getProgressPath(params.documentId, params.revisionKey), params);
  }

  private getManifestPath(documentId: string, revisionKey: string): string {
    return path.join(
      this.getRevisionDirectory(documentId, revisionKey),
      'manifest',
      'current.json',
    );
  }

  private getChunkPagePath(documentId: string, revisionKey: string, page: number): string {
    return path.join(
      this.getRevisionDirectory(documentId, revisionKey),
      'chunks',
      `page-${page}.json`,
    );
  }

  private getProgressPath(documentId: string, revisionKey: string): string {
    return path.join(this.getRevisionDirectory(documentId, revisionKey), 'sync-progress.json');
  }

  private getAssetPath(documentId: string, revisionKey: string, sourcePath: string): string {
    const normalizedSourcePath = normalizeRelativeStoragePath(sourcePath);
    const assetPath = path.resolve(
      this.getRevisionDirectory(documentId, revisionKey),
      'assets',
      normalizedSourcePath,
    );
    const assetsDirectory = path.resolve(
      this.getRevisionDirectory(documentId, revisionKey),
      'assets',
    );
    if (!isPathInsideDirectory(assetPath, assetsDirectory)) {
      throw new Error(`Parsed asset path resolves outside storage: ${sourcePath}`);
    }
    return assetPath;
  }

  private getRevisionDirectory(documentId: string, revisionKey: string): string {
    return path.join(this.rootDirectory, hashPathPart(documentId), hashPathPart(revisionKey));
  }

  private async readOptionalJson<T>(filePath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      flag: 'w',
    });
  }
}

function hashPathPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
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
