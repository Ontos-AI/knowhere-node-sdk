import { createHash, type Hash } from 'crypto';
import { ArchiveCacheTransportError } from './archive-cache-transport-error.js';
import type {
  ParsedDocumentObject,
  ParsedDocumentObjectHead,
  ParsedDocumentObjectParams,
  ParsedDocumentStorage,
  ParsedDocumentWriteObjectResult,
} from '../types/storage.js';

interface ArchiveCacheParams {
  readonly storage: ParsedDocumentStorage;
  readonly documentId: string;
  readonly revisionKey: string;
  readonly jobId: string;
  readonly resultUrl: string;
  readonly signal?: AbortSignal;
  readonly archiveCacheBypassed?: boolean;
  readonly onBypass?: () => Promise<void>;
}

interface PreparedArchive {
  readonly resultUrl: string;
  readonly downloadIdentity: string | undefined;
  readonly archiveCacheBypassed: boolean;
  readonly isCached: boolean;
  readonly validateResponse: (response: Response) => Response;
}

interface ArchiveCacheMarker {
  readonly version: 1;
  readonly jobId: string;
  readonly revisionKey: string;
  readonly originIdentity: string;
  readonly contentLength: number;
  readonly sha256: string;
  readonly storageEntityTag: string;
}

interface ArchiveOrigin {
  readonly identity: string;
  readonly contentLength: number | undefined;
  readonly entityTag: string | null;
}

interface ArchiveCacheObjectVersion {
  readonly contentLength: number;
  readonly entityTag: string;
}

const ARCHIVE_CACHE_TIMEOUT_MS: number = 30_000;

class ArchiveOriginIntegrityError extends Error {}

/** Cache metadata records a complete ZIP transfer, never a completed document sync. */
export async function prepareCachedArchive(params: ArchiveCacheParams): Promise<PreparedArchive> {
  params.signal?.throwIfAborted();
  if (params.archiveCacheBypassed) return createFallback(params);
  if (
    !params.storage.writeObjectStream ||
    !params.storage.headObject ||
    !params.storage.getObjectUrl
  ) {
    await params.onBypass?.();
    return createFallback(params);
  }

  const controller: AbortController = new AbortController();
  const signal: AbortSignal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  const mutations: Set<Promise<unknown>> = new Set();
  let rejectCancellation: (() => void) | undefined;
  const cancellation: Promise<never> = new Promise((_resolve, reject): void => {
    rejectCancellation = (): void => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error('Parsed result archive cache was cancelled.', { cause: reason }),
      );
    };
    signal.addEventListener('abort', rejectCancellation, { once: true });
  });
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    controller.abort(new Error('Parsed result archive cache exceeded its thirty-second budget.'));
  }, ARCHIVE_CACHE_TIMEOUT_MS);
  let origin: ArchiveOrigin | undefined;
  const preparation: Promise<PreparedArchive> = (async (): Promise<PreparedArchive> => {
    origin = await probeArchiveOrigin({ ...params, signal });
    signal.throwIfAborted();
    if (!hasStrongEntityTag(origin.entityTag) || origin.contentLength === undefined)
      throw new Error('Parsed result archive cache requires a strong origin version and length.');
    return prepareArchiveCache(params, origin, signal, mutations);
  })();
  try {
    return await Promise.race([preparation, cancellation]);
  } catch (error) {
    controller.abort(error);
    // Stream adapters must reject on abort after releasing their network resources. Wait for
    // their cleanup before fallback can start a second transfer against the same capacity.
    await Promise.allSettled([...mutations]);
    params.signal?.throwIfAborted();
    if (error instanceof ArchiveOriginIntegrityError) throw error;
    // Persist this decision before the caller starts the old upstream stream path.
    await params.onBypass?.();
    return createFallback(params, origin);
  } finally {
    clearTimeout(timer);
    if (rejectCancellation) signal.removeEventListener('abort', rejectCancellation);
  }
}

function createFallback(params: ArchiveCacheParams, origin?: ArchiveOrigin): PreparedArchive {
  return {
    resultUrl: params.resultUrl,
    downloadIdentity: origin?.identity,
    archiveCacheBypassed: true,
    isCached: false,
    validateResponse(response: Response): Response {
      if (origin && createOriginIdentity(params.jobId, response) !== origin.identity)
        rejectResponse(
          response,
          new ArchiveOriginIntegrityError('Parsed result origin archive identity changed.'),
        );
      return response;
    },
  };
}

async function probeArchiveOrigin(params: ArchiveCacheParams): Promise<ArchiveOrigin> {
  const response: Response = await fetch(params.resultUrl, {
    headers: { Range: 'bytes=0-0' },
    signal: params.signal,
  });
  try {
    if (!response.ok) throw new Error(`Parsed result download failed (HTTP ${response.status}).`);
    return {
      identity: createOriginIdentity(params.jobId, response),
      contentLength: readOriginLength(response),
      entityTag: response.headers.get('etag'),
    };
  } finally {
    await response.body?.cancel();
  }
}

async function prepareArchiveCache(
  params: ArchiveCacheParams,
  origin: ArchiveOrigin,
  signal: AbortSignal,
  mutations: Set<Promise<unknown>>,
): Promise<PreparedArchive> {
  const object: ParsedDocumentObjectParams = { ...params, path: 'result.zip' };
  const initialHead: ParsedDocumentObjectHead | null = await params.storage.headObject!(object);
  signal.throwIfAborted();
  let marker: ArchiveCacheMarker | null = null;
  if (initialHead) {
    const version: ArchiveCacheObjectVersion = readObjectVersion(initialHead);
    const stored: ParsedDocumentObject | null = await params.storage.readObject({
      ...object,
      path: createMarkerPath(origin.identity, version.entityTag),
    });
    signal.throwIfAborted();
    if (stored) marker = readMarker(stored, params, origin, version);
  }
  if (!marker) marker = await storeArchive(params, origin, signal, mutations);
  signal.throwIfAborted();
  const resultUrl: string | null = await params.storage.getObjectUrl!(object);
  signal.throwIfAborted();
  if (!resultUrl) throw new Error('Parsed result archive cache has no readable object URL.');
  const validateResponse = (response: Response): Response =>
    validateCachedResponse(response, marker, params.signal);
  const response: Response = await fetch(resultUrl, {
    headers: { Range: 'bytes=0-0', 'If-Match': marker.storageEntityTag },
    signal,
  });
  try {
    if (
      response.headers.get('content-range') !== `bytes 0-0/${marker.contentLength}` ||
      response.headers.get('content-length') !== '1'
    )
      rejectResponse(
        response,
        new ArchiveCacheTransportError('Parsed result archive cache probe exceeded one byte.'),
      );
    const validated: Response = validateResponse(response);
    // The probe is exactly one byte. Reading it also checks a truncated CDN response.
    await validated.arrayBuffer();
  } catch (error) {
    await response.body?.cancel().catch((): void => undefined);
    throw error;
  }
  signal.throwIfAborted();
  return {
    resultUrl,
    downloadIdentity: origin.identity,
    archiveCacheBypassed: false,
    isCached: true,
    validateResponse,
  };
}

async function storeArchive(
  params: ArchiveCacheParams,
  origin: ArchiveOrigin,
  signal: AbortSignal,
  mutations: Set<Promise<unknown>>,
): Promise<ArchiveCacheMarker> {
  const response: Response = await fetch(params.resultUrl, {
    headers: { 'If-Match': origin.entityTag! },
    signal,
  });
  if (signal.aborted) {
    await response.body?.cancel();
    signal.throwIfAborted();
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 412)
      throw new ArchiveOriginIntegrityError('Parsed result origin archive identity changed.');
    throw new Error(`Parsed result archive cache download failed (HTTP ${response.status}).`);
  }
  if (createOriginIdentity(params.jobId, response) !== origin.identity) {
    await response.body.cancel();
    throw new ArchiveOriginIntegrityError('Parsed result origin archive identity changed.');
  }
  const hash: Hash = createHash('sha256');
  let contentLength: number = 0;
  let hasCompleted: boolean = false;
  const body: ReadableStream<Uint8Array> = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        signal.throwIfAborted();
        contentLength += chunk.length;
        if (contentLength > origin.contentLength!)
          throw new ArchiveOriginIntegrityError('Parsed result origin archive length changed.');
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush(): void {
        if (contentLength !== origin.contentLength)
          throw new ArchiveOriginIntegrityError('Parsed result origin archive length changed.');
        hasCompleted = true;
      },
    }),
  );
  const object: ParsedDocumentObjectParams = { ...params, path: 'result.zip' };
  let write: ParsedDocumentWriteObjectResult;
  try {
    signal.throwIfAborted();
    write = await settleMutation(
      params.storage.writeObjectStream!({
        ...object,
        body,
        contentType: 'application/zip',
        contentLength: origin.contentLength,
        signal,
      }),
      mutations,
    );
  } catch (error) {
    await body.cancel(error).catch((): void => undefined);
    throw error;
  }
  signal.throwIfAborted();
  if (!hasCompleted)
    throw new Error('Parsed result archive cache sink did not consume the stream.');
  if (!hasStrongEntityTag(write.entityTag))
    throw new Error('Parsed result archive cache requires a strong object version.');
  const head: ParsedDocumentObjectHead | null = await params.storage.headObject!(object);
  signal.throwIfAborted();
  if (!head) throw new Error('Parsed result archive cache was not persisted.');
  const actualVersion: ArchiveCacheObjectVersion = readObjectVersion(head);
  if (write.entityTag !== actualVersion.entityTag || actualVersion.contentLength !== contentLength)
    throw new Error('Parsed result archive cache object version or length changed during upload.');
  const marker: ArchiveCacheMarker = {
    version: 1,
    jobId: params.jobId,
    revisionKey: params.revisionKey,
    originIdentity: origin.identity,
    contentLength,
    sha256: hash.digest('hex'),
    storageEntityTag: actualVersion.entityTag,
  };
  signal.throwIfAborted();
  await settleMutation(
    params.storage.writeObject({
      ...object,
      path: createMarkerPath(origin.identity, actualVersion.entityTag),
      body: Buffer.from(JSON.stringify(marker)),
      contentType: 'application/json; charset=utf-8',
    }),
    mutations,
  );
  signal.throwIfAborted();
  return marker;
}

async function settleMutation<Value>(
  mutation: Promise<Value>,
  mutations: Set<Promise<unknown>>,
): Promise<Value> {
  mutations.add(mutation);
  try {
    return await mutation;
  } finally {
    mutations.delete(mutation);
  }
}

function readMarker(
  object: ParsedDocumentObject,
  params: ArchiveCacheParams,
  origin: ArchiveOrigin,
  version: ArchiveCacheObjectVersion,
): ArchiveCacheMarker {
  const value: unknown = JSON.parse(Buffer.from(object.body).toString('utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('jobId' in value) ||
    value.jobId !== params.jobId ||
    !('revisionKey' in value) ||
    value.revisionKey !== params.revisionKey ||
    !('originIdentity' in value) ||
    value.originIdentity !== origin.identity ||
    !('contentLength' in value) ||
    value.contentLength !== origin.contentLength ||
    value.contentLength !== version.contentLength ||
    !('storageEntityTag' in value) ||
    value.storageEntityTag !== version.entityTag ||
    !('sha256' in value) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error('Parsed result archive cache completion marker is invalid.');
  return {
    version: 1,
    jobId: params.jobId,
    revisionKey: params.revisionKey,
    originIdentity: origin.identity,
    contentLength: version.contentLength,
    storageEntityTag: version.entityTag,
    sha256: value.sha256,
  };
}

function readObjectVersion(object: ParsedDocumentObjectHead): ArchiveCacheObjectVersion {
  if (!hasStrongEntityTag(object.entityTag) || !isPositiveInteger(object.contentLength))
    throw new Error('Parsed result archive cache requires a strong object version and length.');
  return { entityTag: object.entityTag, contentLength: object.contentLength };
}

function validateCachedResponse(
  response: Response,
  marker: ArchiveCacheMarker,
  signal: AbortSignal | undefined,
): Response {
  if (response.headers.get('etag') !== marker.storageEntityTag)
    rejectResponse(
      response,
      new ArchiveCacheTransportError('Parsed result archive cache response version changed.'),
    );
  if (response.status !== 206 || !response.body)
    rejectResponse(
      response,
      new ArchiveCacheTransportError('Parsed result archive cache requires a ranged response.'),
    );
  const range: RegExpExecArray | null = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get('content-range') ?? '',
  );
  const contentLength: number = Number(response.headers.get('content-length'));
  if (
    !range ||
    Number(range[3]) !== marker.contentLength ||
    Number(range[1]) > Number(range[2]) ||
    Number(range[2]) >= marker.contentLength ||
    contentLength !== Number(range[2]) - Number(range[1]) + 1
  )
    rejectResponse(
      response,
      new ArchiveCacheTransportError('Parsed result archive cache response length changed.'),
    );
  let actualLength: number = 0;
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller): void {
          signal?.throwIfAborted();
          actualLength += chunk.length;
          if (actualLength > contentLength)
            throw new ArchiveCacheTransportError(
              'Parsed result archive cache response length changed.',
            );
          controller.enqueue(chunk);
        },
        flush(): void {
          if (actualLength !== contentLength)
            throw new ArchiveCacheTransportError(
              'Parsed result archive cache response length changed.',
            );
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

function rejectResponse(response: Response, error: Error): never {
  void response.body?.cancel(error).catch((): void => undefined);
  throw error;
}

function createMarkerPath(originIdentity: string, entityTag: string): string {
  const identity: string = createHash('sha256')
    .update(JSON.stringify([originIdentity, entityTag]))
    .digest('hex');
  return `.knowhere-sdk/archive-cache/${identity}.json`;
}

function createOriginIdentity(jobId: string, response: Response): string {
  // Keep legacy checkpoints stable when switching between upstream and cached transports.
  return createHash('sha256')
    .update(
      JSON.stringify([
        jobId,
        response.headers.get('etag'),
        response.headers.get('last-modified'),
        response.headers.get('content-range')?.split('/').at(-1) ??
          response.headers.get('content-length'),
      ]),
    )
    .digest('hex');
}

function readOriginLength(response: Response): number | undefined {
  const value: number = Number(
    response.headers.get('content-range')?.split('/').at(-1) ??
      response.headers.get('content-length'),
  );
  return isPositiveInteger(value) ? value : undefined;
}

function hasStrongEntityTag(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('W/');
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
