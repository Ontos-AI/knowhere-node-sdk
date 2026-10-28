import { createHash } from 'crypto';
import { createServer, type Server } from 'http';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { Knowhere } from '../../client.js';
import { PermissionDeniedError, ValidationError } from '../../errors/index.js';
import type { JobSnapshot, JobSnapshotObjectAccessBatch } from '../../types/job.js';
import type {
  ParsedDocumentObject,
  ParsedDocumentStorage,
  ParsedDocumentSyncProgress,
  ParsedDocumentWriteObjectResult,
} from '../../types/storage.js';

interface InventoryObject {
  readonly path: string;
  readonly size_bytes: number;
  readonly checksum_sha256: string;
  readonly content_type: string;
  readonly kind: 'essential' | 'image';
}

interface ReadableFixture {
  readonly client: Knowhere;
  readonly knowledge: Knowhere['knowledge'];
  readonly storage: ParsedDocumentStorage;
  readonly objects: Map<string, Uint8Array>;
  readonly origins: Map<string, Uint8Array>;
  readonly inventory: InventoryObject[];
  readonly requests: string[];
  readonly batchRequests: string[][];
  readonly progress: Map<string, ParsedDocumentSyncProgress>;
  readonly snapshot: JobSnapshot;
  readonly setOriginSnapshot: (snapshotId: string) => void;
  readonly setCapabilityExpiration: (expiresAt: string) => void;
  readonly denyImageAccess: () => void;
  readonly setBatchResponsePaths: (paths: readonly string[]) => void;
  readonly setBatchIdentity: (identity: Readonly<Record<string, string | null>>) => void;
}

const servers: Server[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    servers.splice(0).map(
      (server: Server): Promise<void> =>
        new Promise((resolve, reject): void => {
          server.closeAllConnections();
          server.close((error): void => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function createFixture(omitArchivedImage: boolean = false): Promise<ReadableFixture> {
  const objects: Map<string, Uint8Array> = new Map();
  const progress: Map<string, ParsedDocumentSyncProgress> = new Map();
  const storage: ParsedDocumentStorage = {
    readObject(params): Promise<ParsedDocumentObject | null> {
      const body: Uint8Array | undefined = objects.get(`${params.revisionKey}/${params.path}`);
      return Promise.resolve(body ? { ...params, body } : null);
    },
    writeObject(params): Promise<ParsedDocumentWriteObjectResult> {
      objects.set(`${params.revisionKey}/${params.path}`, params.body);
      return Promise.resolve(params);
    },
    readSyncProgress(params): Promise<ParsedDocumentSyncProgress | null> {
      return Promise.resolve(progress.get(params.revisionKey) ?? null);
    },
    writeSyncProgress(params): Promise<void> {
      progress.set(params.revisionKey, params);
      return Promise.resolve();
    },
  };
  const origins: Map<string, Uint8Array> = new Map([
    [
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          job_id: 'job_readable',
          job_result_id: 'result_shared',
          source_file_name: 'manual.pdf',
          files: { source: 'source.pdf', navigation: 'doc_nav.json' },
          statistics: { total_chunks: 1 },
        }),
      ),
    ],
    [
      'chunks.json',
      Buffer.from(
        JSON.stringify({
          chunks: [
            {
              chunk_id: 'page_1',
              type: 'page',
              content: 'Pinned baseline text',
              path: 'manual.pdf/Page 1',
              metadata: {
                page_nums: [1],
                summary: 'Pinned baseline text',
                page_assets: [{ artifact_ref: 'images/page-1.jpg' }],
              },
            },
          ],
        }),
      ),
    ],
    ['doc_nav.json', Buffer.from(JSON.stringify({ sections: [] }))],
    ['source.pdf', Buffer.from('%PDF-pinned-original')],
    ['tables/table-1.html', Buffer.from('<table><tr><td>Essential table</td></tr></table>')],
    ['images/page-1.jpg', Buffer.from('pinned-image-bytes')],
  ]);
  const inventory: InventoryObject[] = [...origins].map(
    ([path, body]): InventoryObject => ({
      path,
      size_bytes: body.byteLength,
      checksum_sha256: createHash('sha256').update(body).digest('hex'),
      content_type: path.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream',
      kind: path.startsWith('images/') ? 'image' : 'essential',
    }),
  );
  const zip: JSZip = new JSZip();
  for (const [path, body] of origins)
    if (!omitArchivedImage || !path.startsWith('images/')) zip.file(path, body);
  const archive: Uint8Array = await zip.generateAsync({ type: 'uint8array' });
  const checksum: string = createHash('sha256').update(archive).digest('hex');
  const requests: string[] = [];
  const batchRequests: string[][] = [];
  let batchResponsePaths: readonly string[] | undefined;
  let batchIdentity: Readonly<Record<string, string | null>> = {};
  let originSnapshotId: string = 'snapshot_baseline';
  let capability: number = 0;
  let capabilityExpiration: string = '2030-01-01T00:00:00Z';
  let hasDeniedImageAccess: boolean = false;
  let baseURL: string = '';
  const server: Server = createServer((request, response): void => {
    const url: URL = new URL(request.url ?? '/', baseURL);
    requests.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);
    const identity = {
      snapshot_id: originSnapshotId,
      job_id: 'job_readable',
      job_result_id: 'result_shared',
      document_id: 'doc_readable',
      checksum,
    };
    if (url.pathname.startsWith('/v2/')) {
      if (request.headers.authorization !== 'Bearer test-key') {
        response.writeHead(403).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/readable')) {
        response.end(JSON.stringify({ ...identity, objects: inventory }));
        return;
      }
      if (url.pathname.endsWith('/objects/access') && request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer): void => {
          chunks.push(chunk);
        });
        request.on('end', (): void => {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            !body ||
            typeof body !== 'object' ||
            !('paths' in body) ||
            !Array.isArray(body.paths) ||
            !body.paths.every((path: unknown): path is string => typeof path === 'string')
          ) {
            response.writeHead(400).end();
            return;
          }
          batchRequests.push(body.paths);
          if (
            hasDeniedImageAccess &&
            body.paths.some((path): boolean => path.startsWith('images/'))
          ) {
            response
              .writeHead(403)
              .end(JSON.stringify({ error: { message: 'Owner access revoked' } }));
            return;
          }
          if (
            body.paths.some(
              (path): boolean => !inventory.some((object): boolean => object.path === path),
            )
          ) {
            response.writeHead(404).end();
            return;
          }
          response.end(
            JSON.stringify({
              ...identity,
              ...batchIdentity,
              objects: (batchResponsePaths ?? body.paths).map((path) => ({
                path,
                download_url: `${baseURL}/origin/${encodeURIComponent(path)}?token=${++capability}`,
                expires_at: capabilityExpiration,
              })),
            }),
          );
        });
        return;
      }
      if (url.pathname.endsWith('/objects')) {
        const path: string = url.searchParams.get('path') ?? '';
        if (hasDeniedImageAccess && path.startsWith('images/')) {
          response
            .writeHead(403)
            .end(JSON.stringify({ error: { message: 'Owner access revoked' } }));
          return;
        }
        if (!inventory.some((object): boolean => object.path === path)) {
          response.writeHead(404).end();
          return;
        }
        capability += 1;
        response.end(
          JSON.stringify({
            ...identity,
            path,
            download_url: `${baseURL}/origin/${encodeURIComponent(path)}?token=${capability}`,
            expires_at: capabilityExpiration,
          }),
        );
        return;
      }
      if (url.pathname === '/v2/jobs/job_readable') {
        response.end(
          JSON.stringify({
            job_id: 'job_readable',
            status: 'done',
            source_type: 'file',
            created_at: '2026-10-28T00:00:00Z',
            document_id: 'doc_readable',
            current_snapshot_id: 'snapshot_baseline',
            snapshots: [
              {
                ...identity,
                snapshot_id: 'snapshot_baseline',
                stage: 'baseline',
                result_url: `${baseURL}/result.zip`,
                result_url_expires_at: '2030-01-01T00:00:00Z',
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/v2/documents/doc_readable/chunks') {
        response.end(
          JSON.stringify({
            document_id: 'doc_readable',
            job_id: 'job_readable',
            job_result_id: 'result_shared',
            namespace: 'default',
            chunks: [],
            pagination: { page: 1, page_size: 1, total: 0, total_pages: 0 },
          }),
        );
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (url.pathname === '/result.zip') {
      response.writeHead(200, { 'content-length': archive.byteLength, etag: 'pinned-archive' });
      response.end(archive);
      return;
    }
    const body: Uint8Array | undefined = origins.get(
      decodeURIComponent(url.pathname.slice('/origin/'.length)),
    );
    response.writeHead(body ? 200 : 404);
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve): void => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address: ReturnType<Server['address']> = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture origin port');
  baseURL = `http://127.0.0.1:${address.port}`;
  const client: Knowhere = new Knowhere({ baseURL, apiKey: 'test-key', maxRetries: 0 });
  const snapshot: JobSnapshot = {
    snapshotId: 'snapshot_baseline',
    stage: 'baseline',
    jobId: 'job_readable',
    jobResultId: 'result_shared',
    documentId: 'doc_readable',
    checksum,
    resultUrl: `${baseURL}/result.zip`,
    resultUrlExpiresAt: new Date('2030-01-01'),
  };
  return {
    client,
    knowledge: client.knowledge.withParsedStorage({ storage, limits: { maxEntriesPerSync: 1 } }),
    storage,
    objects,
    origins,
    inventory,
    requests,
    batchRequests,
    progress,
    snapshot,
    setOriginSnapshot(snapshotId): void {
      originSnapshotId = snapshotId;
    },
    setCapabilityExpiration(expiresAt): void {
      capabilityExpiration = expiresAt;
    },
    denyImageAccess(): void {
      hasDeniedImageAccess = true;
    },
    setBatchResponsePaths(paths): void {
      batchResponsePaths = paths;
    },
    setBatchIdentity(identity): void {
      batchIdentity = identity;
    },
  };
}

const reference = { jobId: 'job_readable', revisionKey: 'snapshot_baseline' } as const;
const imageReference = {
  documentId: 'doc_readable',
  revisionKey: 'snapshot_baseline',
  path: 'images/page-1.jpg',
} as const;

function createFullCommit(fixture: ReadableFixture): Record<string, unknown> {
  return {
    version: 1,
    documentId: fixture.snapshot.documentId,
    revisionKey: fixture.snapshot.snapshotId,
    snapshotId: fixture.snapshot.snapshotId,
    jobResultId: fixture.snapshot.jobResultId,
    checksum: fixture.snapshot.checksum,
    stage: fixture.snapshot.stage,
    source: 'resultZip',
    committedAt: new Date().toISOString(),
  };
}

function updateOriginObject(fixture: ReadableFixture, path: string, body: Uint8Array): void {
  fixture.origins.set(path, body);
  const object: InventoryObject = {
    path,
    size_bytes: body.byteLength,
    checksum_sha256: createHash('sha256').update(body).digest('hex'),
    content_type: path.endsWith('.jpg') ? 'image/jpeg' : 'application/json',
    kind: path.startsWith('images/') ? 'image' : 'essential',
  };
  const index: number = fixture.inventory.findIndex(
    (candidate): boolean => candidate.path === path,
  );
  if (index < 0) fixture.inventory.push(object);
  else fixture.inventory[index] = object;
}

function addPageImages(fixture: ReadableFixture, count: number): readonly string[] {
  const paths: string[] = Array.from(
    { length: count },
    (_, index): string => `images/page-${index + 1}.jpg`,
  );
  for (const path of paths) updateOriginObject(fixture, path, Buffer.from(path));
  updateOriginObject(
    fixture,
    'chunks.json',
    Buffer.from(
      JSON.stringify({
        chunks: paths.map((path, index) => ({
          chunk_id: `page_${index + 1}`,
          type: 'page',
          content: `Page ${index + 1}`,
          path: `manual.pdf/Page ${index + 1}`,
          metadata: {
            page_nums: [index + 1],
            page_assets: [{ artifact_ref: path }, { artifact_ref: path }],
          },
        })),
      }),
    ),
  );
  return paths;
}

describe('readable snapshot storage boundary', (): void => {
  it('authorizes 188 selected page images in one batch without single capabilities or image bodies', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const paths: readonly string[] = addPageImages(fixture, 188);
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.objects.set(
      'snapshot_baseline/images/page-1.jpg',
      Buffer.from('damaged partial replica'),
    );
    fixture.storage.getObjectUrl = (params): Promise<string> =>
      Promise.resolve(`https://replica.example/${params.path}`);
    const imageReads: string[] = [];
    const readObject = fixture.storage.readObject.bind(fixture.storage);
    fixture.storage.readObject = (params): Promise<ParsedDocumentObject | null> => {
      if (params.path.startsWith('images/')) imageReads.push(params.path);
      return readObject(params);
    };
    fixture.requests.length = 0;
    const read = await fixture.knowledge.readChunks({ ...imageReference, pageSize: 200 });
    expect(read.chunks).toHaveLength(188);
    expect(read.chunks[187]?.metadata.pageAssets).toMatchObject([
      {
        artifactRef: paths[187],
      },
      {
        artifactRef: paths[187],
      },
    ]);
    expect(read.chunks[187]?.metadata.pageAssets).toHaveProperty(
      '0.assetUrl',
      expect.stringContaining('/origin/images%2Fpage-188.jpg'),
    );
    expect(read.chunks[187]?.metadata.pageAssets).toHaveProperty(
      '1.assetUrl',
      expect.stringContaining('/origin/images%2Fpage-188.jpg'),
    );
    expect(fixture.batchRequests).toEqual([paths]);
    expect(fixture.requests).toEqual([
      'POST /v2/jobs/job_readable/snapshots/snapshot_baseline/objects/access',
    ]);
    expect(imageReads).toEqual([]);
    const beforeMetadataOnly: number = fixture.requests.length;
    await fixture.knowledge.readChunks({
      ...imageReference,
      pageSize: 200,
      includeAssetUrls: false,
    });
    expect(fixture.requests).toHaveLength(beforeMetadataOnly);
  });

  it('resolves only selected page asset references for the requested page', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const paths: readonly string[] = addPageImages(fixture, 188);
    await fixture.knowledge.prepareReadableSnapshot(reference);
    await fixture.knowledge.readChunks({ ...imageReference, page: 2, pageSize: 100 });
    expect(fixture.batchRequests).toEqual([paths.slice(100)]);
  });

  it.each([
    { paths: [] },
    { paths: ['images/page-1.jpg', 'images/page-1.jpg'] },
    { paths: ['images/page-1.jpg', 'images/foreign.jpg'] },
    { paths: ['images/foreign.jpg'] },
  ])(
    'rejects incomplete or conflicting batch membership $paths',
    async ({ paths }): Promise<void> => {
      const fixture: ReadableFixture = await createFixture();
      await fixture.knowledge.prepareReadableSnapshot(reference);
      fixture.setBatchResponsePaths(paths);
      await expect(fixture.knowledge.readChunks(imageReference)).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );

  it.each(['snapshot_id', 'job_id', 'job_result_id', 'document_id', 'checksum'])(
    'rejects missing and conflicting %s in batch capabilities',
    async (field: string): Promise<void> => {
      const fixture: ReadableFixture = await createFixture();
      await fixture.knowledge.prepareReadableSnapshot(reference);
      for (const value of [null, 'foreign']) {
        fixture.setBatchIdentity({ [field]: value });
        await expect(fixture.knowledge.readChunks(imageReference)).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
    },
  );

  it('deduplicates public URL requests and splits more than 200 image paths into ordered batches', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const paths: readonly string[] = addPageImages(fixture, 401);
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.requests.length = 0;
    const urls = await fixture.knowledge.getParsedDocumentObjectUrls({
      ...imageReference,
      paths: [...paths, paths[0], 'images/unlisted.jpg'],
    });
    expect(Object.keys(urls)).toHaveLength(402);
    expect(urls[paths[400]]).toContain('/origin/images%2Fpage-401.jpg');
    expect(urls['images/unlisted.jpg']).toBeNull();
    expect(fixture.batchRequests).toEqual([
      paths.slice(0, 200),
      paths.slice(200, 400),
      paths.slice(400),
    ]);
    expect(fixture.requests).toHaveLength(3);
  });

  it('loads the readable descriptor and full certificate once for all URL paths without reading image bytes', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const paths: readonly string[] = addPageImages(fixture, 3);
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.objects.set(
      'snapshot_baseline/.knowhere-sdk/commit.json',
      Buffer.from(JSON.stringify(createFullCommit(fixture))),
    );
    fixture.storage.getObjectUrl = (params): Promise<string> =>
      Promise.resolve(`https://replica.example/${params.path}`);
    const reads: string[] = [];
    const readObject = fixture.storage.readObject.bind(fixture.storage);
    fixture.storage.readObject = (params): Promise<ParsedDocumentObject | null> => {
      reads.push(params.path);
      return readObject(params);
    };
    const requestCount: number = fixture.requests.length;
    expect(
      await fixture.knowledge.getParsedDocumentObjectUrls({ ...imageReference, paths }),
    ).toEqual(Object.fromEntries(paths.map((path) => [path, `https://replica.example/${path}`])));
    expect(reads).toEqual(['.knowhere-sdk/readable.json', '.knowhere-sdk/commit.json']);
    expect(fixture.requests).toHaveLength(requestCount);
  });

  it('resolves legacy full-copy URLs without requiring immutable delivery endpoints', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const paths: readonly string[] = ['images/page-1.jpg', 'source.pdf'];
    fixture.storage.getObjectUrl = (params): Promise<string> =>
      Promise.resolve(`https://replica.example/${params.path}`);
    expect(
      await fixture.knowledge.getParsedDocumentObjectUrls({ ...imageReference, paths }),
    ).toEqual(Object.fromEntries(paths.map((path) => [path, null])));
    fixture.objects.set(
      'snapshot_baseline/.knowhere-sdk/commit.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          documentId: imageReference.documentId,
          revisionKey: imageReference.revisionKey,
          source: 'resultZip',
          committedAt: new Date().toISOString(),
        }),
      ),
    );
    expect(
      await fixture.knowledge.getParsedDocumentObjectUrls({ ...imageReference, paths }),
    ).toEqual(Object.fromEntries(paths.map((path) => [path, `https://replica.example/${path}`])));
    expect(fixture.requests).toEqual([]);
  });

  it('rejects a conflicting full-copy pin before returning batch image URLs', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.objects.set(
      'snapshot_baseline/.knowhere-sdk/commit.json',
      Buffer.from(
        JSON.stringify({
          ...createFullCommit(fixture),
          checksum: '0'.repeat(64),
        }),
      ),
    );
    fixture.storage.getObjectUrl = (params): Promise<string> =>
      Promise.resolve(`https://replica.example/${params.path}`);
    const requestCount: number = fixture.requests.length;
    await expect(
      fixture.knowledge.getParsedDocumentObjectUrls({
        ...imageReference,
        paths: [imageReference.path],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.requests).toHaveLength(requestCount);
  });

  it('stops after an aborted capability batch before requesting another shard', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const paths: readonly string[] = addPageImages(fixture, 201);
    await fixture.knowledge.prepareReadableSnapshot(reference);
    const controller: AbortController = new AbortController();
    const getAccess = fixture.client.jobs.getSnapshotObjectsAccess.bind(fixture.client.jobs);
    fixture.client.jobs.getSnapshotObjectsAccess = async (
      ...params
    ): Promise<JobSnapshotObjectAccessBatch> => {
      const access = await getAccess(...params);
      controller.abort(new Error('Cancelled after first batch'));
      return access;
    };
    await expect(
      fixture.knowledge.getParsedDocumentObjectUrls({
        ...imageReference,
        paths,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Cancelled after first batch');
    expect(fixture.batchRequests).toEqual([paths.slice(0, 200)]);
  });

  it('reads pinned metadata without image capability requests when asset URLs are disabled', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.denyImageAccess();
    const requestCount: number = fixture.requests.length;
    const read = await fixture.knowledge.readChunks({ ...imageReference, includeAssetUrls: false });
    expect(read.chunks[0]?.content).toBe('Pinned baseline text');
    expect(read.chunks[0]?.metadata.pageAssets).toEqual([{ artifactRef: 'images/page-1.jpg' }]);
    expect(fixture.requests).toHaveLength(requestCount);
  });

  it.each([
    '![one](images/first figure.jpg) and ![two](images/second figure.jpg)',
    '[images/first figure.jpg] and [images/second figure.jpg]',
  ])(
    'keeps same-line image references with spaces separate: %s',
    async (content: string): Promise<void> => {
      const fixture: ReadableFixture = await createFixture();
      updateOriginObject(fixture, 'images/first figure.jpg', Buffer.from('first'));
      updateOriginObject(fixture, 'images/second figure.jpg', Buffer.from('second'));
      updateOriginObject(
        fixture,
        'chunks.json',
        Buffer.from(
          JSON.stringify({
            chunks: [
              {
                chunk_id: 'page_1',
                type: 'page',
                content,
                path: 'manual.pdf/Page 1',
                metadata: {
                  page_assets: [
                    { artifact_ref: 'images/first figure.jpg' },
                    { artifact_ref: 'images/second figure.jpg' },
                  ],
                },
              },
            ],
          }),
        ),
      );
      await fixture.knowledge.prepareReadableSnapshot(reference);
      expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(true);
      expect(fixture.requests.some((request): boolean => request.includes('/origin/images'))).toBe(
        false,
      );
    },
  );

  it('still rejects an undeclared structured image reference alongside valid Markdown links', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    updateOriginObject(
      fixture,
      'chunks.json',
      Buffer.from(
        JSON.stringify({
          chunks: [
            {
              type: 'page',
              content: '![one](images/page-1.jpg)',
              metadata: { page_assets: [{ artifact_ref: 'images/unlisted.jpg' }] },
            },
          ],
        }),
      ),
    );
    await expect(fixture.knowledge.prepareReadableSnapshot(reference)).rejects.toThrow(
      /images\/unlisted.jpg/,
    );
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(false);
  });

  it('keeps damaged uncommitted image URLs on the pinned origin without reading image bodies', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.objects.set('snapshot_baseline/images/page-1.jpg', Buffer.from('damaged replica'));
    fixture.storage.getObjectUrl = (params): Promise<string | null> =>
      Promise.resolve(`https://replica.example/${params.path}`);
    const readObject = fixture.storage.readObject.bind(fixture.storage);
    const bodyReads: string[] = [];
    fixture.storage.readObject = (params): Promise<ParsedDocumentObject | null> => {
      if (params.path.startsWith('images/')) bodyReads.push(params.path);
      return readObject(params);
    };
    const imageUrl = await fixture.knowledge.getParsedDocumentObjectUrl(imageReference);
    expect(imageUrl).toMatch(/\/origin\/images%2Fpage-1.jpg\?token=/);
    expect(
      await fixture.knowledge.getParsedDocumentObjectUrl({ ...imageReference, path: 'source.pdf' }),
    ).toBe('https://replica.example/source.pdf');
    expect(bodyReads).toEqual([]);
    expect(fixture.requests.some((request): boolean => request.includes('/origin/images'))).toBe(
      false,
    );
    await expect(fixture.knowledge.readParsedDocumentObject(imageReference)).rejects.toThrow(
      /replica integrity/i,
    );
  });

  it.each(['documentId', 'revisionKey', 'snapshotId', 'jobResultId', 'checksum', 'stage'])(
    'rejects a full replica certificate with conflicting %s',
    async (field: string): Promise<void> => {
      const fixture: ReadableFixture = await createFixture();
      await fixture.knowledge.prepareReadableSnapshot(reference);
      const commit = createFullCommit(fixture);
      commit[field] = field === 'stage' ? 'final' : 'different';
      fixture.objects.set(
        'snapshot_baseline/.knowhere-sdk/commit.json',
        Buffer.from(JSON.stringify(commit)),
      );
      fixture.storage.getObjectUrl = (): Promise<string | null> =>
        Promise.resolve('https://replica.example/page-1.jpg');
      await expect(
        fixture.knowledge.getParsedDocumentObjectUrl(imageReference),
      ).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it('publishes readable core without image copies or a full-sync commit', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const prepared = await fixture.knowledge.prepareReadableSnapshot(reference);
    expect(prepared.snapshot).toEqual(fixture.snapshot);
    expect(prepared.readable.snapshotId).toBe('snapshot_baseline');
    expect(fixture.objects.has('snapshot_baseline/source.pdf')).toBe(true);
    expect(fixture.objects.has('snapshot_baseline/tables/table-1.html')).toBe(true);
    expect(fixture.objects.has('snapshot_baseline/images/page-1.jpg')).toBe(false);
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/commit.json')).toBe(false);
    expect(fixture.progress.size).toBe(0);
    expect(fixture.requests.some((request): boolean => request.includes('/result.zip'))).toBe(
      false,
    );
    expect(JSON.stringify(prepared.readable)).not.toContain('downloadUrl');
    expect(JSON.stringify(prepared.readable)).not.toContain('resultUrl');
    const read = await fixture.knowledge.readChunks(imageReference);
    expect(read.chunks[0]?.content).toBe('Pinned baseline text');
    expect(read.document.sourceFileName).toBe('manual.pdf');
    expect(read.document.jobId).toBe('job_readable');
    expect((await fixture.knowledge.getDocumentOutline(imageReference)).totalChunks).toBe(1);
    expect(
      (await fixture.knowledge.grepChunks({ ...imageReference, pattern: 'baseline' })).matches,
    ).toHaveLength(1);
    expect(fixture.requests.some((request): boolean => request.includes('/documents/'))).toBe(
      false,
    );
  });

  it('refreshes pinned image access on every origin read and prefers a replica once present', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    const first = await fixture.knowledge.readParsedDocumentObject(imageReference);
    expect(Buffer.from(first?.body ?? []).toString()).toBe('pinned-image-bytes');
    expect(first?.contentType).toBe('image/jpeg');
    expect(fixture.objects.has('snapshot_baseline/images/page-1.jpg')).toBe(false);
    await fixture.knowledge.readParsedDocumentObject(imageReference);
    const imageReads: string[] = fixture.requests.filter((request): boolean =>
      request.includes('/origin/images%2Fpage-1.jpg'),
    );
    expect(imageReads).toHaveLength(2);
    expect(new Set(imageReads).size).toBe(2);
    fixture.objects.set('snapshot_baseline/images/page-1.jpg', Buffer.from('pinned-image-bytes'));
    const requestCount: number = fixture.requests.length;
    await fixture.knowledge.readParsedDocumentObject(imageReference);
    expect(fixture.requests).toHaveLength(requestCount);
    await expect(
      fixture.knowledge.readParsedDocumentObject({ ...imageReference, path: '../secret' }),
    ).rejects.toThrow(/path/i);
  });

  it('resumes interrupted core writes without re-downloading valid durable objects', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const write = fixture.storage.writeObject.bind(fixture.storage);
    fixture.storage.writeObject = (params): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.path === 'source.pdf') return Promise.reject(new Error('Storage interrupted'));
      return write(params);
    };
    await expect(fixture.knowledge.prepareReadableSnapshot(reference)).rejects.toThrow(
      'Storage interrupted',
    );
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(false);
    fixture.storage.writeObject = write;
    const restarted = fixture.client.knowledge.withParsedStorage({ storage: fixture.storage });
    await restarted.prepareReadableSnapshot(reference);
    expect(
      fixture.requests.filter((request): boolean => request.includes('/origin/manifest.json')),
    ).toHaveLength(1);
    const requestsBeforeRepeat: number = fixture.requests.length;
    await restarted.prepareReadableSnapshot(reference);
    expect(fixture.requests).toHaveLength(requestsBeforeRepeat + 1);
  });

  it('rejects missing image references and corrupt essential bytes before readability', async (): Promise<void> => {
    const missing: ReadableFixture = await createFixture();
    missing.inventory.splice(
      missing.inventory.findIndex((object): boolean => object.kind === 'image'),
      1,
    );
    await expect(missing.knowledge.prepareReadableSnapshot(reference)).rejects.toThrow(
      /image|reference/i,
    );
    expect(missing.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(false);
    const corrupt: ReadableFixture = await createFixture();
    corrupt.origins.set('source.pdf', Buffer.from('wrong-source'));
    await expect(corrupt.knowledge.prepareReadableSnapshot(reference)).rejects.toThrow(
      /integrity|checksum|length/i,
    );
    expect(corrupt.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(false);
  });

  it('rejects a changed origin snapshot even when its upstream result ID is unchanged', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.setOriginSnapshot('snapshot_final');
    await expect(fixture.knowledge.readParsedDocumentObject(imageReference)).rejects.toThrow(
      /identity|snapshot/i,
    );
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/commit.json')).toBe(false);
  });

  it('keeps the existing archive checkpoint and full-copy commit barrier', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    let completed: boolean = false;
    for (let segment: number = 0; segment < 12 && !completed; segment += 1) {
      completed = (await fixture.knowledge.syncParsedDocument(reference)).completed;
      if (!completed)
        expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/commit.json')).toBe(false);
    }
    expect(completed).toBe(true);
    expect(fixture.progress.get('snapshot_baseline')?.status).toBe('completed');
    expect(fixture.objects.has('snapshot_baseline/images/page-1.jpg')).toBe(true);
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(true);
  });

  it('repairs missing core after restart before returning an existing readable descriptor', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.objects.delete('snapshot_baseline/source.pdf');
    await fixture.client.knowledge
      .withParsedStorage({ storage: fixture.storage })
      .prepareReadableSnapshot(reference);
    expect(fixture.objects.has('snapshot_baseline/source.pdf')).toBe(true);
  });

  it('does not certify a storage sink that acknowledged corrupt essential bytes', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const write = fixture.storage.writeObject.bind(fixture.storage);
    fixture.storage.writeObject = (params): Promise<ParsedDocumentWriteObjectResult> =>
      write(params.path === 'source.pdf' ? { ...params, body: Buffer.from('corrupt') } : params);
    await expect(fixture.knowledge.prepareReadableSnapshot(reference)).rejects.toThrow(
      /integrity/i,
    );
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(false);
  });

  it('does not expose uncommitted local objects or undeclared origin paths', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    fixture.objects.set('snapshot_baseline/images/page-1.jpg', Buffer.from('partial'));
    expect(await fixture.knowledge.readParsedDocumentObject(imageReference)).toBeNull();
    fixture.objects.delete('snapshot_baseline/images/page-1.jpg');
    await fixture.knowledge.prepareReadableSnapshot(reference);
    const requests: number = fixture.requests.length;
    expect(
      await fixture.knowledge.readParsedDocumentObject({
        ...imageReference,
        path: 'images/unknown.jpg',
      }),
    ).toBeNull();
    expect(fixture.requests).toHaveLength(requests);
  });

  it('waits for an active core write to settle on cancellation and leaves replication untouched', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const controller: AbortController = new AbortController();
    let markStarted: () => void = (): void => {};
    let release: () => void = (): void => {};
    const started: Promise<void> = new Promise((resolve): void => {
      markStarted = resolve;
    });
    const gate: Promise<void> = new Promise((resolve): void => {
      release = resolve;
    });
    const write = fixture.storage.writeObject.bind(fixture.storage);
    fixture.storage.writeObject = async (params): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.path === 'source.pdf') {
        markStarted();
        await gate;
      }
      return write(params);
    };
    let hasSettled: boolean = false;
    const pending = fixture.knowledge.prepareReadableSnapshot({
      ...reference,
      signal: controller.signal,
    });
    void pending.then(
      (): void => {
        hasSettled = true;
      },
      (): void => {
        hasSettled = true;
      },
    );
    await started;
    controller.abort(new Error('Stop core transfer'));
    await Promise.resolve();
    expect(hasSettled).toBe(false);
    release();
    await expect(pending).rejects.toThrow('Stop core transfer');
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(false);
    expect(fixture.progress.size).toBe(0);
    await fixture.knowledge.prepareReadableSnapshot(reference);
  });

  it('preserves full-copy rejection for a missing referenced archive image while core stays readable', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture(true);
    await fixture.knowledge.prepareReadableSnapshot(reference);
    const knowledge = fixture.client.knowledge.withParsedStorage({ storage: fixture.storage });
    await expect(knowledge.syncParsedDocument(reference)).rejects.toThrow(
      /Required parsed result file missing: images\/page-1.jpg/,
    );
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/commit.json')).toBe(false);
    expect(fixture.progress.get('snapshot_baseline')?.status).not.toBe('completed');
    expect((await knowledge.readChunks(imageReference)).chunks[0]?.content).toBe(
      'Pinned baseline text',
    );
    expect(
      Buffer.from(
        (await knowledge.readParsedDocumentObject(imageReference))?.body ?? [],
      ).toString(),
    ).toBe('pinned-image-bytes');
  });

  it('persists only stable inventory fields even when delivery includes an expiring capability', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    Object.assign(fixture.inventory[0], {
      download_url: 'https://origin.example/secret?expires=1',
    });
    const result = await fixture.knowledge.prepareReadableSnapshot(reference);
    expect(JSON.stringify(result.readable)).not.toContain('origin.example');
    expect(
      Buffer.from(
        fixture.objects.get('snapshot_baseline/.knowhere-sdk/readable.json') ?? [],
      ).toString(),
    ).not.toContain('origin.example');
  });

  it('requires pinned origins for navigation resource paths', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    const body: Uint8Array = Buffer.from(
      JSON.stringify({
        sections: [],
        resources: { images: [{ path: 'images/unlisted.jpg' }] },
      }),
    );
    fixture.origins.set('doc_nav.json', body);
    const index: number = fixture.inventory.findIndex(
      (object): boolean => object.path === 'doc_nav.json',
    );
    fixture.inventory[index] = {
      ...fixture.inventory[index],
      size_bytes: body.byteLength,
      checksum_sha256: createHash('sha256').update(body).digest('hex'),
    };
    await expect(fixture.knowledge.prepareReadableSnapshot(reference)).rejects.toThrow(
      /reference|origin/i,
    );
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(false);
  });

  it('rejects corrupt image origin bytes without certifying replication or damaging readable text', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.origins.set('images/page-1.jpg', Buffer.from('corrupt-image'));
    await expect(fixture.knowledge.readParsedDocumentObject(imageReference)).rejects.toThrow(
      /integrity/i,
    );
    expect(fixture.progress.size).toBe(0);
    expect((await fixture.knowledge.readChunks(imageReference)).chunks[0]?.content).toBe(
      'Pinned baseline text',
    );
  });

  it('hydrates uncopied page images with a fresh readable URL and prefers a certified replica URL', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    const read = await fixture.knowledge.readChunks(imageReference);
    const pageAssets = read.chunks[0]?.metadata.pageAssets as { readonly assetUrl?: string }[];
    expect(pageAssets[0]?.assetUrl).toMatch(/^http:\/\//);
    const response: Response = await fetch(pageAssets[0]?.assetUrl ?? '');
    expect(await response.text()).toBe('pinned-image-bytes');
    expect(fixture.objects.has('snapshot_baseline/images/page-1.jpg')).toBe(false);
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/commit.json')).toBe(false);
    const refreshed: string | null =
      await fixture.knowledge.getParsedDocumentObjectUrl(imageReference);
    expect(refreshed).not.toBe(pageAssets[0]?.assetUrl);
    fixture.objects.set('snapshot_baseline/images/page-1.jpg', Buffer.from('pinned-image-bytes'));
    fixture.objects.set(
      'snapshot_baseline/.knowhere-sdk/commit.json',
      Buffer.from(JSON.stringify(createFullCommit(fixture))),
    );
    fixture.storage.getObjectUrl = (params): Promise<string | null> =>
      Promise.resolve(
        params.path === imageReference.path ? 'https://replica.example/page-1.jpg' : null,
      );
    const requestCount: number = fixture.requests.length;
    const readObject = fixture.storage.readObject.bind(fixture.storage);
    const imageBodyReads: string[] = [];
    fixture.storage.readObject = (params): Promise<ParsedDocumentObject | null> => {
      if (params.path.startsWith('images/')) imageBodyReads.push(params.path);
      return readObject(params);
    };
    const localRead = await fixture.knowledge.readChunks(imageReference);
    expect(localRead.chunks[0]?.metadata.pageAssets).toMatchObject([
      { assetUrl: 'https://replica.example/page-1.jpg' },
    ]);
    expect(fixture.requests).toHaveLength(requestCount);
    expect(imageBodyReads).toEqual([]);
  });

  it('rejects wrong-version image capabilities during readChunks URL hydration', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.setOriginSnapshot('snapshot_final');
    await expect(fixture.knowledge.readChunks(imageReference)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it.each(['2000-01-01T00:00:00Z', '2030-99-01T00:00:00Z'])(
    'rejects expired or malformed image capabilities (%s)',
    async (expiresAt: string): Promise<void> => {
      const fixture: ReadableFixture = await createFixture();
      await fixture.knowledge.prepareReadableSnapshot(reference);
      fixture.setCapabilityExpiration(expiresAt);
      await expect(
        fixture.knowledge.getParsedDocumentObjectUrl(imageReference),
      ).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it('propagates a typed authorization failure without replacing the readable snapshot', async (): Promise<void> => {
    const fixture: ReadableFixture = await createFixture();
    await fixture.knowledge.prepareReadableSnapshot(reference);
    fixture.denyImageAccess();
    await expect(fixture.knowledge.readChunks(imageReference)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/readable.json')).toBe(true);
    expect(fixture.objects.has('snapshot_baseline/.knowhere-sdk/commit.json')).toBe(false);
  });
});
