import { createHash } from 'crypto';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Knowhere } from '../../client.js';
import type { JobResult, JobSnapshot } from '../../types/job.js';
import type {
  ParsedDocumentObject,
  ParsedDocumentStorage,
  ParsedDocumentSyncProgress,
  ParsedDocumentWriteObjectResult,
} from '../../types/storage.js';

interface ProgressiveFixture {
  readonly knowledge: Knowhere['knowledge'];
  readonly client: Knowhere;
  readonly storage: ParsedDocumentStorage;
  readonly job: JobResult;
  readonly baseline: JobSnapshot;
  readonly final: JobSnapshot;
  readonly objects: Map<string, Uint8Array>;
  readonly archives: Map<string, Uint8Array>;
  readonly progress: Map<string, ParsedDocumentSyncProgress>;
  readonly urls: string[];
}

async function createFixture(maxEntriesPerSync = 100): Promise<ProgressiveFixture> {
  const client = new Knowhere({ apiKey: 'test-key' });
  const objects = new Map<string, Uint8Array>();
  const progress = new Map<string, ParsedDocumentSyncProgress>();
  const storage: ParsedDocumentStorage = {
    readObject(params): Promise<ParsedDocumentObject | null> {
      const body = objects.get(`${params.revisionKey}/${params.path}`);
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
  const archives = new Map<string, Uint8Array>();
  async function createSnapshot(stage: 'baseline' | 'final'): Promise<JobSnapshot> {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        job_id: 'job_test',
        source_file_name: 'test.pdf',
        statistics: { total_chunks: 1 },
      }),
    );
    zip.file(
      'chunks.json',
      JSON.stringify({
        chunks: [
          {
            chunk_id: 'chunk',
            type: 'text',
            content: stage,
            path: 'test.pdf/Page 1',
            metadata: {},
          },
        ],
      }),
    );
    const archive = await zip.generateAsync({ type: 'uint8array' });
    const resultUrl = `https://archive.example/${stage}.zip`;
    archives.set(resultUrl, archive);
    return {
      snapshotId: `snapshot_${stage}`,
      stage,
      jobId: 'job_test',
      jobResultId: 'result_same',
      documentId: 'doc_test',
      checksum: createHash('sha256').update(archive).digest('hex'),
      resultUrl,
      resultUrlExpiresAt: new Date('2030-01-01'),
    };
  }
  const baseline = await createSnapshot('baseline');
  const final = await createSnapshot('final');
  const job: JobResult = {
    jobId: 'job_test',
    status: 'done',
    sourceType: 'file',
    createdAt: new Date(),
    documentId: 'doc_test',
    resultUrl: baseline.resultUrl,
    isDone: true,
    isFailed: false,
    isTerminal: true,
    snapshots: [baseline],
    currentSnapshotId: baseline.snapshotId,
  };
  vi.spyOn(client.jobs, 'get').mockImplementation(() => Promise.resolve({ ...job }));
  vi.spyOn(client.documents, 'listChunks').mockResolvedValue({
    documentId: 'doc_test',
    jobId: 'job_test',
    jobResultId: 'result_same',
    namespace: 'default',
    chunks: [],
    pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
  });
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const body = archives.get(url);
      if (!body) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(
        new Response(body, {
          headers: { etag: url.split('?')[0], 'content-length': String(body.length) },
        }),
      );
    }),
  );
  const knowledge = client.knowledge.withParsedStorage({ storage, limits: { maxEntriesPerSync } });
  return { knowledge, client, storage, job, baseline, final, objects, archives, progress, urls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('progressive immutable snapshots', () => {
  it('copies final under a new local key despite sharing the upstream Job Result and keeps pinned baseline readable', async () => {
    const fixture = await createFixture();
    const first = await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    expect(first.revisionKey).toBe(fixture.baseline.snapshotId);
    fixture.job.snapshots = [fixture.baseline, fixture.final];
    fixture.job.currentSnapshotId = fixture.final.snapshotId;
    fixture.job.resultUrl = fixture.final.resultUrl;
    const final = await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    expect(final).toMatchObject({
      revisionKey: fixture.final.snapshotId,
      snapshot: fixture.final,
      completed: true,
      commit: { jobResultId: 'result_same', snapshotId: fixture.final.snapshotId },
    });
    const pinned = await fixture.knowledge.readChunks({
      documentId: 'doc_test',
      revisionKey: fixture.baseline.snapshotId,
    });
    expect(pinned.chunks[0]?.content).toBe('baseline');
    const current = await fixture.knowledge.readChunks({ documentId: 'doc_test' });
    expect(current.chunks[0]?.content).toBe('final');
  });

  it('refreshes a retained baseline URL while final is current and resumes only the pinned checkpoint', async () => {
    const fixture = await createFixture(1);
    const first = await fixture.knowledge.syncParsedDocument({
      jobId: 'job_test',
      revisionKey: fixture.baseline.snapshotId,
    });
    expect(first.completed).toBe(false);
    const refreshed = { ...fixture.baseline, resultUrl: `${fixture.baseline.resultUrl}?refresh=2` };
    fixture.archives.set(refreshed.resultUrl, fixture.archives.get(fixture.baseline.resultUrl)!);
    fixture.job.snapshots = [refreshed, fixture.final];
    fixture.job.currentSnapshotId = fixture.final.snapshotId;
    fixture.job.resultUrl = fixture.final.resultUrl;
    expect(
      (
        await fixture.knowledge.syncParsedDocument({
          jobId: 'job_test',
          revisionKey: first.revisionKey,
        })
      ).completed,
    ).toBe(true);
    expect(fixture.urls).toContain(refreshed.resultUrl);
    expect(fixture.urls).not.toContain(fixture.final.resultUrl);
  });

  it('rejects changed bytes within a committed snapshot and never commits a checksum mismatch', async () => {
    const fixture = await createFixture();
    fixture.job.snapshots = [{ ...fixture.baseline, checksum: '0'.repeat(64) }];
    await expect(fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).rejects.toThrow(
      /checksum/i,
    );
    expect(fixture.objects.has(`${fixture.baseline.snapshotId}/.knowhere-sdk/commit.json`)).toBe(
      false,
    );
  });

  it('does not silently read current content for an unavailable explicit snapshot', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.knowledge.syncParsedDocument({ jobId: 'job_test', revisionKey: 'snapshot_missing' }),
    ).rejects.toThrow(/snapshot/i);
  });
  it('keeps baseline current while the final transfer is incomplete', async () => {
    const fixture = await createFixture(1);
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    await fixture.knowledge.syncParsedDocument({
      jobId: 'job_test',
      revisionKey: fixture.baseline.snapshotId,
    });
    fixture.job.snapshots = [fixture.baseline, fixture.final];
    fixture.job.currentSnapshotId = fixture.final.snapshotId;
    expect((await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' })).completed).toBe(
      false,
    );
    expect(
      (await fixture.knowledge.readChunks({ documentId: 'doc_test' })).chunks[0]?.content,
    ).toBe('baseline');
    expect(
      (
        await fixture.knowledge.syncParsedDocument({
          documentId: 'doc_test',
          revisionKey: fixture.final.snapshotId,
        })
      ).completed,
    ).toBe(true);
    expect(
      (await fixture.knowledge.readChunks({ documentId: 'doc_test' })).chunks[0]?.content,
    ).toBe('final');
  });

  it('rejects byte changes when resynchronizing an already completed immutable generation', async () => {
    const fixture = await createFixture();
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ job_id: 'job_test' }));
    zip.file('chunks.json', '{"chunks":[]}');
    fixture.archives.set(
      fixture.baseline.resultUrl,
      await zip.generateAsync({ type: 'uint8array' }),
    );
    await expect(fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).rejects.toThrow(
      /identity changed/,
    );
  });

  it('validates descriptor identity against upstream revision separately from the local snapshot key', async () => {
    const fixture = await createFixture();
    fixture.job.snapshots = [{ ...fixture.baseline, jobResultId: 'wrong_result' }];
    await expect(
      fixture.knowledge.syncParsedDocument({
        documentId: 'doc_test',
        revisionKey: fixture.baseline.snapshotId,
      }),
    ).rejects.toThrow(/upstream revision/);
    expect(fixture.objects.size).toBe(0);
  });

  it('validates any manifest revision identity before committing its descriptor', async () => {
    const fixture = await createFixture();
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({ job_id: 'job_test', job_result_id: 'other_revision' }),
    );
    zip.file('chunks.json', '{"chunks":[]}');
    const archive = await zip.generateAsync({ type: 'uint8array' });
    fixture.archives.set(fixture.baseline.resultUrl, archive);
    fixture.job.snapshots = [
      { ...fixture.baseline, checksum: createHash('sha256').update(archive).digest('hex') },
    ];
    await expect(fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).rejects.toThrow(
      /manifest.*revision/,
    );
  });
  it('preserves committed content when changed bytes reuse the same HTTP validators', async () => {
    const fixture = await createFixture();
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    const bytes = fixture.archives.get(fixture.baseline.resultUrl);
    if (!bytes) throw new Error('Missing baseline ZIP fixture');
    const zip = await JSZip.loadAsync(bytes);
    const original = await zip.file('chunks.json')?.async('string');
    if (!original) throw new Error('Missing baseline chunks fixture');
    zip.file('chunks.json', original.replace('baseline', 'forged!!'));
    const changed = await zip.generateAsync({ type: 'uint8array' });
    expect(changed.length).toBe(bytes.length);
    fixture.archives.set(fixture.baseline.resultUrl, changed);
    await expect(fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).rejects.toThrow(
      /checksum/,
    );
    expect(
      (
        await fixture.knowledge.readChunks({
          documentId: 'doc_test',
          revisionKey: fixture.baseline.snapshotId,
        })
      ).chunks[0]?.content,
    ).toBe('baseline');
  });
  it('does not let a late baseline transfer replace the committed final reader pointer', async () => {
    const fixture = await createFixture();
    let releaseBaseline: () => void = (): void => {
      throw new Error('Baseline gate not initialized');
    };
    let signalBaseline: () => void = (): void => {
      throw new Error('Baseline signal not initialized');
    };
    const gate: Promise<void> = new Promise((resolve) => {
      releaseBaseline = resolve;
    });
    const started: Promise<void> = new Promise((resolve) => {
      signalBaseline = resolve;
    });
    const write = fixture.storage.writeObject.bind(fixture.storage);
    fixture.storage.writeObject = async (params): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.revisionKey === fixture.baseline.snapshotId && params.path === 'chunks.json') {
        signalBaseline();
        await gate;
      }
      return write(params);
    };
    const baseline = fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    await started;
    fixture.job.snapshots = [fixture.baseline, fixture.final];
    fixture.job.currentSnapshotId = fixture.final.snapshotId;
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    releaseBaseline();
    await baseline;
    expect(
      (await fixture.knowledge.readChunks({ documentId: 'doc_test' })).chunks[0]?.content,
    ).toBe('final');
  });

  it('never substitutes live chunks when a pinned snapshot has no local commit', async () => {
    const fixture = await createFixture();
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    await expect(
      fixture.knowledge.readChunks({ documentId: 'doc_test', revisionKey: 'snapshot_missing' }),
    ).rejects.toThrow(/snapshot.*committed/);
  });
  it('rejects uncommitted progressive pins before any current reader pointer exists', async () => {
    const fixture = await createFixture(1);
    expect((await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).completed).toBe(
      false,
    );
    await expect(
      fixture.knowledge.readChunks({
        documentId: 'doc_test',
        revisionKey: fixture.baseline.snapshotId,
      }),
    ).rejects.toThrow(/snapshot|revision/);
    await expect(
      fixture.knowledge.grepChunks({
        documentId: 'doc_test',
        revisionKey: fixture.baseline.snapshotId,
        pattern: 'baseline',
      }),
    ).rejects.toThrow(/snapshot|revision/);
    await expect(
      fixture.knowledge.getDocumentOutline({
        documentId: 'doc_test',
        revisionKey: fixture.baseline.snapshotId,
      }),
    ).rejects.toThrow(/snapshot|revision/);
  });

  it('rejects extracted ZIP content when a later verification download serves different bytes under identical validators', async () => {
    const fixture = await createFixture();
    const original = fixture.archives.get(fixture.baseline.resultUrl);
    if (!original) throw new Error('Missing archive fixture');
    const zip = await JSZip.loadAsync(original);
    const chunks = await zip.file('chunks.json')?.async('string');
    if (!chunks) throw new Error('Missing chunks fixture');
    zip.file('chunks.json', chunks.replace('baseline', 'forged!!'));
    const forged = await zip.generateAsync({ type: 'uint8array' });
    expect(forged.length).toBe(original.length);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((): Promise<Response> => {
        calls += 1;
        return Promise.resolve(
          new Response(calls === 2 ? forged : original, {
            headers: { etag: 'same', 'content-length': String(original.length) },
          }),
        );
      }),
    );
    await expect(fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).rejects.toThrow(
      /checksum|entry.*changed/,
    );
    expect(fixture.objects.has(`${fixture.baseline.snapshotId}/.knowhere-sdk/commit.json`)).toBe(
      false,
    );
  });

  it('retains an already committed progressive archive on a later explicit retention request', async () => {
    const fixture = await createFixture();
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    expect(fixture.objects.has(`${fixture.baseline.snapshotId}/result.zip`)).toBe(false);
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test', retainResultArchive: true });
    expect(
      Array.from(fixture.objects.get(`${fixture.baseline.snapshotId}/result.zip`) ?? []),
    ).toEqual(Array.from(fixture.archives.get(fixture.baseline.resultUrl) ?? []));
  });

  it('advances ordinary reads to a completed full reparse while retaining historical progressive reads', async () => {
    const fixture = await createFixture();
    await fixture.knowledge.syncParsedDocument({ jobId: 'job_test' });
    fixture.job.snapshots = undefined;
    fixture.job.currentSnapshotId = undefined;
    fixture.job.resultUrl = fixture.final.resultUrl;
    vi.spyOn(fixture.client.documents, 'listChunks').mockResolvedValue({
      documentId: 'doc_test',
      jobId: 'job_test',
      jobResultId: 'result_new',
      namespace: 'default',
      chunks: [],
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
    });
    await fixture.knowledge.syncParsedDocument({ documentId: 'doc_test' });
    expect(
      (await fixture.knowledge.readChunks({ documentId: 'doc_test' })).chunks[0]?.content,
    ).toBe('final');
    expect(
      (
        await fixture.knowledge.readChunks({
          documentId: 'doc_test',
          revisionKey: fixture.baseline.snapshotId,
        })
      ).chunks[0]?.content,
    ).toBe('baseline');
  });
  it('binds Range-extracted entries to the SHA-256 verified archive despite reused HTTP validators', async () => {
    const fixture = await createFixture();
    const original = fixture.archives.get(fixture.baseline.resultUrl);
    if (!original) throw new Error('Missing archive fixture');
    const zip = await JSZip.loadAsync(original);
    const chunks = await zip.file('chunks.json')?.async('string');
    if (!chunks) throw new Error('Missing chunks fixture');
    zip.file('chunks.json', chunks.replace('baseline', 'forged!!'));
    const forged = await zip.generateAsync({ type: 'uint8array' });
    expect(forged.length).toBe(original.length);
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const range = new Headers(init?.headers).get('range');
        if (!range)
          return Promise.resolve(
            new Response(original, {
              headers: { etag: 'same', 'content-length': String(original.length) },
            }),
          );
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) throw new Error('Invalid test Range');
        const start = match[1] ? Number(match[1]) : Math.max(0, forged.length - Number(match[2]));
        const end =
          match[1] && match[2] ? Math.min(Number(match[2]), forged.length - 1) : forged.length - 1;
        return Promise.resolve(
          new Response(forged.slice(start, end + 1), {
            status: 206,
            headers: {
              etag: 'same',
              'content-range': `bytes ${start}-${end}/${forged.length}`,
              'content-length': String(end - start + 1),
            },
          }),
        );
      }),
    );
    await expect(fixture.knowledge.syncParsedDocument({ jobId: 'job_test' })).rejects.toThrow(
      /entry.*changed/,
    );
    expect(fixture.objects.has(`${fixture.baseline.snapshotId}/.knowhere-sdk/commit.json`)).toBe(
      false,
    );
  });

  it('repairs a previously failed optional archive retention without rewriting committed content', async () => {
    const fixture = await createFixture();
    const write = fixture.storage.writeObject.bind(fixture.storage);
    let hasRetentionFailure = true;
    fixture.storage.writeObject = async (params): Promise<ParsedDocumentWriteObjectResult> => {
      if (params.path === 'result.zip' && hasRetentionFailure)
        throw new Error('Temporary retention failure');
      return write(params);
    };
    expect(
      (await fixture.knowledge.syncParsedDocument({ jobId: 'job_test', retainResultArchive: true }))
        .completed,
    ).toBe(true);
    expect(fixture.objects.has(`${fixture.baseline.snapshotId}/result.zip`)).toBe(false);
    hasRetentionFailure = false;
    expect(
      (await fixture.knowledge.syncParsedDocument({ jobId: 'job_test', retainResultArchive: true }))
        .completed,
    ).toBe(true);
    expect(
      Array.from(fixture.objects.get(`${fixture.baseline.snapshotId}/result.zip`) ?? []),
    ).toEqual(Array.from(fixture.archives.get(fixture.baseline.resultUrl) ?? []));
  });
});
