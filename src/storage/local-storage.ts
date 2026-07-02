import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

import type {
  KnowhereSdkStorage,
  KnowhereSdkStorageHead,
  KnowhereSdkStorageObject,
  KnowhereSdkStorageReadResult,
  KnowhereSdkStorageWriteResult,
} from '../types/page-citation-assets.js';

const DEFAULT_STORAGE_DIRECTORY = path.join(
  os.homedir(),
  '.knowhere-node-sdk',
  'page-citation-assets',
);

interface StoredObjectMetadata {
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface LocalKnowhereSdkStorageOptions {
  rootDirectory?: string;
  publicBaseUrl?: string;
}

export class LocalKnowhereSdkStorage implements KnowhereSdkStorage {
  private readonly rootDirectory: string;
  private readonly publicBaseUrl?: string;

  constructor(options: LocalKnowhereSdkStorageOptions = {}) {
    this.rootDirectory = path.resolve(options.rootDirectory ?? DEFAULT_STORAGE_DIRECTORY);
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '');
  }

  async headObject(key: string): Promise<KnowhereSdkStorageHead | null> {
    const objectPath = this.resolveObjectPath(key);
    try {
      const stat = await fs.stat(objectPath);
      const storedMetadata = await this.readMetadata(objectPath);
      return {
        key,
        contentType: storedMetadata.contentType,
        contentLength: stat.size,
        metadata: storedMetadata.metadata,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeObject(input: KnowhereSdkStorageObject): Promise<KnowhereSdkStorageWriteResult> {
    const objectPath = this.resolveObjectPath(input.key);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, await readStorageBody(input.body));
    await this.writeMetadata(objectPath, {
      contentType: input.contentType,
      metadata: input.metadata,
    });
    const url = await this.getObjectUrl(input.key);
    return {
      key: input.key,
      url: url ?? undefined,
    };
  }

  getObjectUrl(key: string): Promise<string | null> {
    this.resolveObjectPath(key);
    if (!this.publicBaseUrl) {
      return Promise.resolve(null);
    }

    return Promise.resolve(
      `${this.publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`,
    );
  }

  async readObject(key: string): Promise<KnowhereSdkStorageReadResult | null> {
    const objectPath = this.resolveObjectPath(key);
    try {
      const body = await fs.readFile(objectPath);
      const storedMetadata = await this.readMetadata(objectPath);
      return {
        body,
        contentType: storedMetadata.contentType,
        metadata: storedMetadata.metadata,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const objectPath = this.resolveObjectPath(key);
    await fs.rm(objectPath, { force: true });
    await fs.rm(this.getMetadataPath(objectPath), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const prefixPath = this.resolvePrefixPath(prefix);
    await fs.rm(prefixPath, { recursive: true, force: true });
  }

  private resolveObjectPath(key: string): string {
    validateStorageKey(key);
    const objectPath = path.resolve(this.rootDirectory, key);
    if (!isPathInsideDirectory(objectPath, this.rootDirectory)) {
      throw new Error(`Storage key resolves outside the storage root: ${key}`);
    }
    return objectPath;
  }

  private resolvePrefixPath(prefix: string): string {
    validateStoragePrefix(prefix);
    const prefixPath = path.resolve(this.rootDirectory, prefix);
    if (!isPathInsideDirectory(prefixPath, this.rootDirectory)) {
      throw new Error(`Storage prefix resolves outside the storage root: ${prefix}`);
    }
    return prefixPath;
  }

  private getMetadataPath(objectPath: string): string {
    return `${objectPath}.metadata.json`;
  }

  private async readMetadata(objectPath: string): Promise<StoredObjectMetadata> {
    try {
      const raw = await fs.readFile(this.getMetadataPath(objectPath), 'utf8');
      return normalizeStoredMetadata(JSON.parse(raw));
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw error;
    }
  }

  private async writeMetadata(
    objectPath: string,
    metadata: StoredObjectMetadata,
  ): Promise<void> {
    if (!metadata.contentType && !metadata.metadata) {
      await fs.rm(this.getMetadataPath(objectPath), { force: true });
      return;
    }

    await fs.writeFile(this.getMetadataPath(objectPath), JSON.stringify(metadata, null, 2));
  }
}

export function createLocalKnowhereSdkStorage(
  options?: LocalKnowhereSdkStorageOptions,
): LocalKnowhereSdkStorage {
  return new LocalKnowhereSdkStorage(options);
}

function validateStorageKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('\0') ||
    path.posix.normalize(key) !== key ||
    key.split('/').some((segment) => segment.length === 0 || segment === '..' || segment === '.')
  ) {
    throw new Error(
      'Storage key must be a relative POSIX path without empty, traversal, or absolute segments',
    );
  }
}

function validateStoragePrefix(prefix: string): void {
  if (prefix.length === 0) {
    throw new Error('Storage prefix is required');
  }
  validateStorageKey(prefix.endsWith('/') ? `${prefix}__prefix_marker__` : prefix);
}

async function readStorageBody(body: Uint8Array | ReadableStream<Uint8Array> | Blob): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (isBlob(body)) {
    return Buffer.from(await body.arrayBuffer());
  }

  return readReadableStream(body);
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

async function readReadableStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];

  while (true) {
    const result = await reader.read();
    if (result.done) {
      return Buffer.concat(chunks);
    }
    chunks.push(Buffer.from(result.value));
  }
}

function normalizeStoredMetadata(value: unknown): StoredObjectMetadata {
  if (!isPlainRecord(value)) {
    return {};
  }

  return {
    contentType: typeof value.contentType === 'string' ? value.contentType : undefined,
    metadata: normalizeMetadataMap(value.metadata),
  };
}

function normalizeMetadataMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const metadata: Record<string, string> = {};
  for (const [key, metadataValue] of Object.entries(value)) {
    if (typeof metadataValue === 'string') {
      metadata[key] = metadataValue;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && value.constructor === Object;
}

function isPathInsideDirectory(targetPath: string, parentDirectory: string): boolean {
  const relativePath = path.relative(parentDirectory, targetPath);
  return (
    relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 'ENOENT';
}

function hasErrorCode(error: unknown): error is { readonly code: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error;
}
