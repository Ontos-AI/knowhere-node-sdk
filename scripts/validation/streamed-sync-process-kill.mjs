import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

if (process.argv[2] === '--child') await runChild();
else await runParent();

async function runChild() {
  const { Knowledge, DiskParsedDocumentStorage } = await import('../../dist/index.mjs');
  const [directory, url, mode] = process.argv.slice(3);
  const storage = new DiskParsedDocumentStorage(directory);
  const writes = [];
  const originalWrite = storage.writeObject.bind(storage);
  storage.writeObject = async (parameters) => {
    const written = await originalWrite(parameters);
    if (!parameters.path.startsWith('.knowhere-sdk/')) writes.push(parameters.path);
    return written;
  };
  const writeProgress = storage.writeSyncProgress.bind(storage);
  storage.writeSyncProgress = async (progress, options) => {
    if (mode === 'kill' && progress.status === 'running') {
      process.send({ phase: 'checkpoint-held', entry: progress.nextArchiveEntry, writes });
      await new Promise(() => {});
    }
    await writeProgress(progress, options);
  };
  const client = {
    jobs: {
      get: async () => ({ jobId: 'job_kill', isDone: true, resultUrl: url }),
      load() {
        throw new Error('Full ParseResult load forbidden');
      },
    },
    documents: {
      listChunks: async () => ({
        documentId: 'doc_kill',
        jobId: 'job_kill',
        jobResultId: 'revision_kill',
        chunks: [],
        pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
      }),
    },
  };
  const knowledge = new Knowledge(client).withParsedStorage({
    storage,
    limits: { maxConcurrentFiles: 4, checkpointFileInterval: 10, checkpointIntervalMs: 2000 },
  });
  const result = await knowledge.syncParsedDocument({ documentId: 'doc_kill' });
  assert(result.completed);
  process.send({ phase: 'resumed', completed: result.completed, writes });
  process.disconnect();
}

async function runParent() {
  const directory = await mkdtemp(join(tmpdir(), 'knowhere-kill-validation-'));
  const zip = new JSZip();
  zip.file('manifest.json', '{"job_id":"job_kill"}');
  zip.file('chunks.json', '[]');
  for (let index = 0; index < 30; index += 1)
    zip.file(`images/${index}.png`, Buffer.alloc(64 * 1024, index));
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const server = createServer((request, response) => {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), archive.length - 1) : archive.length - 1;
    response.writeHead(match ? 206 : 200, {
      'content-length': end - start + 1,
      etag: '"kill-fixture"',
      ...(match ? { 'content-range': `bytes ${start}-${end}/${archive.length}` } : {}),
    });
    response.end(archive.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/archive.zip`;
  try {
    const killed = await launch('kill');
    assert(
      killed.entry > 0 && killed.entry <= 13,
      `Uncheckpointed successes exceed13: ${killed.entry}`,
    );
    assert.equal(killed.writes.length, killed.entry);
    const resumed = await launch('resume');
    assert(resumed.completed);
    const retransmitted = resumed.writes.filter((path) => killed.writes.includes(path));
    assert.equal(retransmitted.length, killed.writes.length);
    assert(retransmitted.length <= 13);
    const evidence = {
      fileConcurrency: 4,
      checkpointFileInterval: 10,
      signal: 'SIGKILL',
      unpersistedSuccessfulFiles: killed.entry,
      retransmittedFiles: retransmitted.length,
      completed: true,
      fixtureDirectory: directory,
    };
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  function launch(mode) {
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ['--child', directory, url, mode], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      let message;
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Process validation timed out'));
      }, 30000);
      child.on('error', reject);
      child.on('message', (value) => {
        message = value;
        if (mode === 'kill' && value.phase === 'checkpoint-held') child.kill('SIGKILL');
      });
      child.on('exit', (code, signal) => {
        clearTimeout(deadline);
        if (mode === 'kill' ? signal === 'SIGKILL' : code === 0) resolve(message);
        else reject(new Error(`Unexpected child exit: ${code}/${signal}`));
      });
    });
  }
}
