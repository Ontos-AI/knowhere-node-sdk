import { createHash } from 'crypto';
import { ValidationError } from '../errors/index.js';
import type { Jobs } from '../resources/jobs.js';
import type {
  JobSnapshot,
  JobSnapshotDelivery,
  JobSnapshotObject,
  JobSnapshotObjectAccess,
  JobSnapshotObjectAccessBatch,
} from '../types/job.js';
import type {
  ParsedDocumentObject,
  ParsedDocumentObjectParams,
  ParsedDocumentRevisionParams,
  ParsedDocumentReadableSnapshot,
  ParsedDocumentStorage,
} from '../types/storage.js';
import {
  normalizeResultPath,
  parsedDocumentCommitPath,
  readParsedDocumentCommit,
} from './parsed-document-storage.js';

const readablePath: string = '.knowhere-sdk/readable.json';
const requiredCorePaths: readonly string[] = [
  'manifest.json',
  'chunks.json',
  'doc_nav.json',
  'source.pdf',
];
const checksumPattern: RegExp = /^[a-f0-9]{64}$/;
const maxObjectAccessPaths: number = 200;

/** Owns the separate readable barrier; never writes a full commit or archive progress. */
export class ReadableParsedDocumentSnapshots {
  constructor(
    private readonly jobs: Jobs,
    private readonly storage: ParsedDocumentStorage,
  ) {}

  async prepare(
    snapshot: JobSnapshot,
    signal?: AbortSignal,
  ): Promise<ParsedDocumentReadableSnapshot> {
    signal?.throwIfAborted();
    const existing: ParsedDocumentReadableSnapshot | null = await this.readDescriptor({
      documentId: snapshot.documentId,
      revisionKey: snapshot.snapshotId,
    });
    if (existing) validateIdentity(snapshot, existing);
    const received: JobSnapshotDelivery =
      existing ??
      (await this.jobs.getSnapshotDelivery(snapshot.jobId, snapshot.snapshotId, { signal }));
    validateIdentity(snapshot, received);
    validateInventory(received.objects);
    const delivery: JobSnapshotDelivery = {
      ...received,
      objects: received.objects.map(
        (object: JobSnapshotObject): JobSnapshotObject => ({
          path: object.path,
          sizeBytes: object.sizeBytes,
          checksumSha256: object.checksumSha256,
          contentType: object.contentType,
          kind: object.kind,
        }),
      ),
    };
    for (const object of delivery.objects) {
      signal?.throwIfAborted();
      if (object.kind === 'image') continue;
      const params: ParsedDocumentObjectParams = {
        documentId: snapshot.documentId,
        revisionKey: snapshot.snapshotId,
        path: object.path,
      };
      const stored: ParsedDocumentObject | null = await this.storage.readObject(params);
      if (stored && matchesIntegrity(stored.body, object)) continue;
      const body: Uint8Array = await this.downloadObject(delivery, object, signal);
      signal?.throwIfAborted();
      await this.storage.writeObject({ ...params, body, contentType: object.contentType });
    }
    await this.validateCore(delivery);
    signal?.throwIfAborted();
    if (existing) return existing;
    const readable: ParsedDocumentReadableSnapshot = {
      version: 1,
      documentId: snapshot.documentId,
      revisionKey: snapshot.snapshotId,
      snapshotId: snapshot.snapshotId,
      jobId: snapshot.jobId,
      jobResultId: snapshot.jobResultId,
      checksum: snapshot.checksum,
      stage: snapshot.stage,
      objects: delivery.objects,
      readableAt: new Date().toISOString(),
    };
    await this.storage.writeObject({
      documentId: snapshot.documentId,
      revisionKey: snapshot.snapshotId,
      path: readablePath,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify(readable)),
    });
    return readable;
  }

  async readDescriptor(params: {
    readonly documentId: string;
    readonly revisionKey: string;
  }): Promise<ParsedDocumentReadableSnapshot | null> {
    const object: ParsedDocumentObject | null = await this.storage.readObject({
      ...params,
      path: readablePath,
    });
    if (!object) return null;
    const payload: unknown = JSON.parse(Buffer.from(object.body).toString('utf8'));
    if (
      !isRecord(payload) ||
      payload.version !== 1 ||
      payload.documentId !== params.documentId ||
      payload.revisionKey !== params.revisionKey ||
      payload.snapshotId !== params.revisionKey ||
      typeof payload.jobId !== 'string' ||
      !payload.jobId ||
      typeof payload.jobResultId !== 'string' ||
      !payload.jobResultId ||
      typeof payload.checksum !== 'string' ||
      !checksumPattern.test(payload.checksum) ||
      (payload.stage !== 'baseline' && payload.stage !== 'final') ||
      typeof payload.readableAt !== 'string' ||
      !Number.isFinite(Date.parse(payload.readableAt))
    )
      throw new ValidationError('Invalid readable parsed snapshot identity.');
    validateInventory(payload.objects);
    return payload as unknown as ParsedDocumentReadableSnapshot;
  }

  async readObject(
    params: ParsedDocumentObjectParams & { readonly signal?: AbortSignal },
  ): Promise<ParsedDocumentObject | null> {
    params.signal?.throwIfAborted();
    const path: string = validateObjectPath(params.path);
    const descriptor: ParsedDocumentReadableSnapshot | null = await this.readDescriptor(params);
    if (!descriptor && !(await readParsedDocumentCommit({ ...params, storage: this.storage })))
      return null;
    const object: JobSnapshotObject | undefined = descriptor?.objects.find(
      (candidate: JobSnapshotObject): boolean => candidate.path === path,
    );
    if (descriptor && !object) return null;
    const stored: ParsedDocumentObject | null = await this.storage.readObject({ ...params, path });
    params.signal?.throwIfAborted();
    if (stored) {
      if (object && !matchesIntegrity(stored.body, object))
        throw new ValidationError(`Parsed snapshot replica integrity check failed: ${path}`);
      return {
        ...stored,
        contentType: object?.contentType ?? stored.contentType,
        contentLength: stored.body.byteLength,
      };
    }
    if (!descriptor || !object || object.kind !== 'image') return null;
    const body: Uint8Array = await this.downloadObject(descriptor, object, params.signal);
    params.signal?.throwIfAborted();
    return {
      documentId: params.documentId,
      revisionKey: params.revisionKey,
      path,
      body,
      contentType: object.contentType,
      contentLength: body.byteLength,
    };
  }

  async getObjectUrl(
    params: ParsedDocumentObjectParams & { readonly signal?: AbortSignal },
  ): Promise<string | null> {
    params.signal?.throwIfAborted();
    const path: string = validateObjectPath(params.path);
    const descriptor: ParsedDocumentReadableSnapshot | null = await this.readDescriptor(params);
    if (!descriptor && !(await readParsedDocumentCommit({ ...params, storage: this.storage })))
      return null;
    const object: JobSnapshotObject | undefined = descriptor?.objects.find(
      (candidate: JobSnapshotObject): boolean => candidate.path === path,
    );
    if (descriptor && !object) return null;
    if (
      descriptor &&
      object?.kind === 'image' &&
      !(await this.hasCertifiedReplica(descriptor, params.signal))
    )
      return (await this.resolveObjectAccess(descriptor, object, params.signal)).downloadUrl;
    const localUrl: string | null | undefined = await this.storage.getObjectUrl?.({
      ...params,
      path,
    });
    params.signal?.throwIfAborted();
    if (localUrl) return localUrl;
    if (!descriptor || !object || object.kind !== 'image') return null;
    return (await this.resolveObjectAccess(descriptor, object, params.signal)).downloadUrl;
  }

  async getObjectUrls(
    params: ParsedDocumentRevisionParams & {
      readonly paths: readonly string[];
      readonly signal?: AbortSignal;
    },
  ): Promise<Readonly<Record<string, string | null>>> {
    params.signal?.throwIfAborted();
    const requestedPaths: Map<string, string> = new Map(
      params.paths.map((path: string): [string, string] => [path, validateObjectPath(path)]),
    );
    if (requestedPaths.size === 0) return {};
    const paths: Set<string> = new Set(requestedPaths.values());
    const urls: Map<string, string | null> = new Map();
    const descriptor: ParsedDocumentReadableSnapshot | null = await this.readDescriptor(params);
    params.signal?.throwIfAborted();
    const hasFullCopy: boolean = descriptor
      ? await this.hasCertifiedReplica(descriptor, params.signal)
      : (await readParsedDocumentCommit({ ...params, storage: this.storage })) !== null;
    params.signal?.throwIfAborted();
    const inventory: Map<string, JobSnapshotObject> = new Map(
      descriptor?.objects.map((object): [string, JobSnapshotObject] => [object.path, object]) ?? [],
    );
    const resolved = await Promise.all(
      [...paths].map(
        async (
          path,
        ): Promise<{
          readonly path: string;
          readonly url: string | null;
          readonly needsOrigin: boolean;
        }> => {
          params.signal?.throwIfAborted();
          const object: JobSnapshotObject | undefined = inventory.get(path);
          if (descriptor ? !object : !hasFullCopy) return { path, url: null, needsOrigin: false };
          if (hasFullCopy || object?.kind !== 'image') {
            const localUrl: string | null | undefined = await this.storage.getObjectUrl?.({
              documentId: params.documentId,
              revisionKey: params.revisionKey,
              path,
            });
            params.signal?.throwIfAborted();
            if (localUrl) return { path, url: localUrl, needsOrigin: false };
          }
          params.signal?.throwIfAborted();
          return { path, url: null, needsOrigin: Boolean(descriptor && object?.kind === 'image') };
        },
      ),
    );
    for (const entry of resolved) urls.set(entry.path, entry.url);
    const originPaths: readonly string[] = resolved
      .filter((entry) => entry.needsOrigin)
      .map((entry) => entry.path);
    if (descriptor) {
      for (let offset: number = 0; offset < originPaths.length; offset += maxObjectAccessPaths) {
        const batchPaths: readonly string[] = originPaths.slice(
          offset,
          offset + maxObjectAccessPaths,
        );
        const batchUrls: ReadonlyMap<string, string> = await this.resolveObjectUrls(
          descriptor,
          batchPaths,
          params.signal,
        );
        for (const [path, url] of batchUrls) urls.set(path, url);
      }
    }
    params.signal?.throwIfAborted();
    return Object.fromEntries(
      [...requestedPaths].map(([requested, path]): [string, string | null] => [
        requested,
        urls.get(path) ?? null,
      ]),
    );
  }

  private async resolveObjectUrls(
    identity: JobSnapshotDelivery,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    signal?.throwIfAborted();
    const access: JobSnapshotObjectAccessBatch = await this.jobs.getSnapshotObjectsAccess(
      identity.jobId,
      identity.snapshotId,
      paths,
      { signal },
    );
    if (!isRecord(access)) throw new ValidationError('Invalid pinned snapshot capability batch.');
    validateIdentity(identity, access);
    if (!Array.isArray(access.objects) || access.objects.length !== paths.length)
      throw new ValidationError('Incomplete pinned snapshot capability batch.');
    const requested: Set<string> = new Set(paths);
    const urls: Map<string, string> = new Map();
    for (const object of access.objects) {
      if (
        !isRecord(object) ||
        typeof object.path !== 'string' ||
        !requested.has(object.path) ||
        urls.has(object.path)
      )
        throw new ValidationError('Unexpected or duplicate pinned snapshot capability path.');
      validateObjectCapability(object.path, object);
      urls.set(object.path, object.downloadUrl);
    }
    signal?.throwIfAborted();
    return urls;
  }

  private async hasCertifiedReplica(
    descriptor: ParsedDocumentReadableSnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const stored: ParsedDocumentObject | null = await this.storage.readObject({
      documentId: descriptor.documentId,
      revisionKey: descriptor.revisionKey,
      path: parsedDocumentCommitPath,
    });
    signal?.throwIfAborted();
    if (!stored) return false;
    const commit: unknown = JSON.parse(Buffer.from(stored.body).toString('utf8'));
    if (
      !isRecord(commit) ||
      commit.version !== 1 ||
      commit.documentId !== descriptor.documentId ||
      commit.revisionKey !== descriptor.revisionKey ||
      (commit.source !== 'resultZip' && commit.source !== 'remoteReconstruction') ||
      typeof commit.committedAt !== 'string' ||
      !Number.isFinite(Date.parse(commit.committedAt))
    )
      throw new ValidationError('Invalid full-copy parsed snapshot certificate.');
    let hasPinnedIdentity: boolean = true;
    for (const field of ['snapshotId', 'jobResultId', 'checksum', 'stage'] as const) {
      if (commit[field] === undefined) {
        hasPinnedIdentity = false;
        continue;
      }
      if (commit[field] !== descriptor[field])
        throw new ValidationError(`Full-copy parsed snapshot certificate differs at ${field}.`);
    }
    return hasPinnedIdentity;
  }

  private async downloadObject(
    identity: JobSnapshotDelivery,
    object: JobSnapshotObject,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const access: JobSnapshotObjectAccess = await this.resolveObjectAccess(
      identity,
      object,
      signal,
    );
    const body: Uint8Array = await this.jobs.downloadSnapshotObject(access, { signal });
    signal?.throwIfAborted();
    if (!matchesIntegrity(body, object))
      throw new ValidationError(`Parsed snapshot object integrity check failed: ${object.path}`);
    return body;
  }

  private async resolveObjectAccess(
    identity: JobSnapshotDelivery,
    object: JobSnapshotObject,
    signal?: AbortSignal,
  ): Promise<JobSnapshotObjectAccess> {
    signal?.throwIfAborted();
    const access: JobSnapshotObjectAccess = await this.jobs.getSnapshotObjectAccess(
      identity.jobId,
      identity.snapshotId,
      object.path,
      { signal },
    );
    validateIdentity(identity, access);
    validateObjectCapability(object.path, access);
    signal?.throwIfAborted();
    return access;
  }

  private async validateCore(delivery: JobSnapshotDelivery): Promise<void> {
    const payloads: Map<string, Record<string, unknown>> = new Map();
    for (const entry of delivery.objects) {
      if (entry.kind === 'image') continue;
      const object: ParsedDocumentObject | null = await this.storage.readObject({
        documentId: delivery.documentId,
        revisionKey: delivery.snapshotId,
        path: entry.path,
      });
      if (!object || !matchesIntegrity(object.body, entry))
        throw new ValidationError(
          `Persisted readable snapshot core integrity check failed: ${entry.path}`,
        );
      if (!['manifest.json', 'chunks.json', 'doc_nav.json'].includes(entry.path)) continue;
      const payload: unknown = JSON.parse(Buffer.from(object.body).toString('utf8'));
      if (!isRecord(payload))
        throw new ValidationError(`Invalid readable snapshot core: ${entry.path}`);
      payloads.set(entry.path, payload);
    }
    const manifest: Record<string, unknown> = payloads.get('manifest.json')!;
    if (
      (manifest.job_id ?? manifest.jobId) !== delivery.jobId ||
      ((manifest.job_result_id ?? manifest.jobResultId) !== undefined &&
        (manifest.job_result_id ?? manifest.jobResultId) !== delivery.jobResultId)
    )
      throw new ValidationError(
        'Readable snapshot manifest identity differs from its pinned origin.',
      );
    const chunks: unknown = payloads.get('chunks.json')?.chunks;
    if (!Array.isArray(chunks) || chunks.some((chunk: unknown): boolean => !isRecord(chunk)))
      throw new ValidationError('Invalid readable snapshot chunks.json.');
    const navigation: unknown = payloads.get('doc_nav.json')?.sections;
    if (!Array.isArray(navigation))
      throw new ValidationError('Invalid readable snapshot navigation.');
    const references: Set<string> = new Set();
    if (isRecord(manifest.files))
      for (const path of Object.values(manifest.files))
        if (typeof path === 'string') references.add(validateObjectPath(path));
    collectReferences(chunks, references);
    collectReferences(payloads.get('doc_nav.json'), references);
    for (const chunk of chunks as Record<string, unknown>[]) {
      const kind: unknown = chunk.type ?? chunk.chunk_type ?? chunk.chunkType;
      if ((kind === 'image' || kind === 'table') && typeof chunk.path === 'string')
        references.add(validateObjectPath(chunk.path));
    }
    const paths: Set<string> = new Set(delivery.objects.map((object): string => object.path));
    for (const path of references)
      if (!paths.has(path))
        throw new ValidationError(
          `Readable snapshot image or essential reference has no pinned origin: ${path}`,
        );
  }
}

function validateObjectCapability(
  path: string,
  access: unknown,
): asserts access is Pick<JobSnapshotObjectAccess, 'path' | 'downloadUrl' | 'expiresAt'> {
  if (
    !isRecord(access) ||
    access.path !== path ||
    typeof access.downloadUrl !== 'string' ||
    !/^https?:\/\//i.test(access.downloadUrl) ||
    !(access.expiresAt instanceof Date) ||
    !Number.isFinite(access.expiresAt.getTime()) ||
    access.expiresAt.getTime() <= Date.now()
  )
    throw new ValidationError('Invalid pinned snapshot object capability.');
}

function validateIdentity(
  expected: Omit<JobSnapshotDelivery, 'objects'>,
  actual: Omit<JobSnapshotDelivery, 'objects'>,
): void {
  for (const field of ['snapshotId', 'jobId', 'jobResultId', 'documentId', 'checksum'] as const)
    if (typeof actual[field] !== 'string' || !actual[field] || actual[field] !== expected[field])
      throw new ValidationError(`Parsed snapshot origin identity differs at ${field}.`);
}

function validateInventory(value: unknown): asserts value is readonly JobSnapshotObject[] {
  if (!Array.isArray(value))
    throw new ValidationError('Invalid readable snapshot object inventory.');
  const objects: Map<string, JobSnapshotObject> = new Map();
  for (const candidate of value as unknown[]) {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== 'string' ||
      !Number.isSafeInteger(candidate.sizeBytes) ||
      (candidate.sizeBytes as number) < 0 ||
      typeof candidate.checksumSha256 !== 'string' ||
      !checksumPattern.test(candidate.checksumSha256) ||
      typeof candidate.contentType !== 'string' ||
      !candidate.contentType ||
      (candidate.kind !== 'essential' && candidate.kind !== 'image')
    )
      throw new ValidationError('Invalid readable snapshot object inventory member.');
    const path: string = validateObjectPath(candidate.path);
    if (path !== candidate.path || objects.has(path))
      throw new ValidationError(`Duplicate or noncanonical readable snapshot object path: ${path}`);
    if (candidate.kind === 'image' && !isImagePath(path))
      throw new ValidationError(`Non-image readable snapshot object cannot skip copying: ${path}`);
    objects.set(path, candidate as unknown as JobSnapshotObject);
  }
  for (const path of requiredCorePaths)
    if (objects.get(path)?.kind !== 'essential')
      throw new ValidationError(`Readable snapshot essential object is missing: ${path}`);
}

function validateObjectPath(path: string): string {
  const normalized: string = normalizeResultPath(path);
  if (
    normalized === '.knowhere-sdk' ||
    normalized.startsWith('.knowhere-sdk/') ||
    normalized === 'result.zip'
  )
    throw new ValidationError(`Reserved parsed snapshot object path: ${path}`);
  return normalized;
}

function matchesIntegrity(body: Uint8Array, object: JobSnapshotObject): boolean {
  return (
    body.byteLength === object.sizeBytes &&
    createHash('sha256').update(body).digest('hex') === object.checksumSha256
  );
}

function collectReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) collectReferences(item, references);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      if (['file_path', 'filePath', 'artifact_ref', 'artifactRef'].includes(key))
        references.add(validateObjectPath(child));
      if (key === 'path' && /^(?:images|tables|page_pdfs)\//.test(child))
        references.add(validateObjectPath(child));
      if (['ref', 'content', 'summary'].includes(key)) {
        for (const match of child.matchAll(/\[((?:images|tables)\/[^\]\r\n]+)\]/g))
          references.add(validateObjectPath(match[1]));
        for (const match of child.matchAll(/\]\(((?:images|tables)\/[^)\r\n]+)\)/g))
          references.add(validateObjectPath(match[1]));
      }
    } else collectReferences(child, references);
  }
}

function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|tiff?)$/i.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
