import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomFillSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ZipWriter } from '@zip.js/zip.js';

const MEBIBYTE = 1024 * 1024;
const isWorker = process.argv[2] === '--worker';
if (isWorker) {
  await validateWorker(process.argv[3], Number(process.argv[4]), Number(process.argv[5] ?? 1));
} else {
  const directory = await mkdtemp(join(tmpdir(), 'knowhere-memory-validation-'));
  try {
    for (const [sizeMebibytes, imageCount, concurrency] of [
      [281, 922, 1],
      [562, 1844, 1],
      [281, 922, 2],
    ]) {
      const archivePath = join(directory, `${sizeMebibytes}.zip`);
      if (!(await stat(archivePath).catch(() => null)))
        await generateArchive(archivePath, sizeMebibytes * MEBIBYTE, imageCount);
      await runWorker(archivePath, imageCount, concurrency);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function generateArchive(archivePath, totalBytes, imageCount) {
  const writer = new ZipWriter(Writable.toWeb(createWriteStream(archivePath)), {
    level: 0,
    useWebWorkers: false,
  });
  const manifest = JSON.stringify({
    version: '2.0',
    job_id: 'job_memory',
    source_file_name: 'synthetic.pdf',
    statistics: { total_chunks: 0 },
  });
  await writer.add('manifest.json', textStream(manifest));
  await writer.add('chunks.json', textStream('{"chunks":[]}'));
  const block = randomFillSync(Buffer.alloc(64 * 1024));
  let remaining = totalBytes;
  for (let index = 0; index < imageCount; index += 1) {
    let imageBytes = Math.min(remaining, Math.ceil(totalBytes / imageCount));
    remaining -= imageBytes;
    const body = new ReadableStream({
      pull(controller) {
        if (imageBytes === 0) {
          controller.close();
          return;
        }
        const size = Math.min(block.length, imageBytes);
        imageBytes -= size;
        controller.enqueue(block.subarray(0, size));
      },
    });
    await writer.add(`images/image-${index}.png`, body);
  }
  await writer.close();
}

function textStream(value) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    },
  });
}

async function runWorker(archivePath, imageCount, concurrency) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        fileURLToPath(import.meta.url),
        '--worker',
        archivePath,
        String(imageCount),
        String(concurrency),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    child.stdout.pipe(process.stdout);
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Memory worker failed: ${code}`)),
    );
  });
}

async function validateWorker(archivePath, imageCount, concurrency) {
  const { Knowledge } = await import('../../dist/index.mjs');
  const { size } = await stat(archivePath);
  let rangeRequests = 0;
  let wholeRequests = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(403).end();
      return;
    }
    const range = request.headers.range;
    let start = 0;
    let end = size - 1;
    if (range) {
      rangeRequests += 1;
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416).end();
        return;
      }
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      wholeRequests += 1;
    }
    response.writeHead(range ? 206 : 200, {
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      etag: '"synthetic-immutable-archive"',
    });
    const source = createReadStream(archivePath, { start, end, highWaterMark: 64 * 1024 });
    response.on('close', () => source.destroy());
    source.pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/result.zip`;
  let copiedBytes = 0;
  let copiedImages = 0;
  let syncCalls = 0;
  global.gc?.();
  const baselineRssBytes = process.memoryUsage().rss;
  let peakRssBytes = baselineRssBytes;
  const sample = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const timer = setInterval(sample, 5);
  async function copyArchive(copyIndex) {
    const metadata = new Map();
    let progress = null;
    let calls = 0;
    const storage = {
      readObject(params) {
        const body = metadata.get(params.path);
        return Promise.resolve(body ? { ...params, body } : null);
      },
      writeObject(params) {
        metadata.set(params.path, params.body);
        sample();
        return Promise.resolve(params);
      },
      async writeObjectStream(params) {
        const parts = [];
        const isMetadata = params.path === 'manifest.json' || params.path === 'chunks.json';
        for await (const part of params.body) {
          copiedBytes += part.length;
          if (isMetadata) parts.push(part);
          sample();
        }
        if (isMetadata) metadata.set(params.path, Buffer.concat(parts));
        if (params.path.startsWith('images/')) copiedImages += 1;
        return params;
      },
      readSyncProgress() {
        return Promise.resolve(progress);
      },
      writeSyncProgress(value) {
        progress = value;
        return Promise.resolve();
      },
    };
    const client = {
      jobs: {
        get() {
          return Promise.resolve({
            jobId: 'job_memory',
            isDone: true,
            resultUrl: `${url}?signature=${calls}&copy=${copyIndex}`,
          });
        },
        load() {
          throw new Error('Forbidden full ParseResult load');
        },
      },
      documents: {
        listChunks() {
          return Promise.resolve({
            documentId: 'doc_memory',
            jobId: 'job_memory',
            jobResultId: 'revision_memory',
            chunks: [],
            pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
          });
        },
      },
    };
    const knowledge = new Knowledge(client).withParsedStorage({ storage });
    let result;
    do {
      calls += 1;
      syncCalls += 1;
      result = await knowledge.syncParsedDocument({ documentId: 'doc_memory' });
      assert(calls <= Math.ceil((imageCount + 2) / 100) + 1, 'Sync must make bounded progress');
    } while (!result.completed);
    return result;
  }
  try {
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, index) => copyArchive(index)),
    );
    sample();
    assert.equal(copiedImages, imageCount * concurrency);
    assert.equal(wholeRequests, 0, 'Primary path must only issue Range requests');
    assert(peakRssBytes < 512 * MEBIBYTE, `Peak RSS exceeds 512 MiB: ${peakRssBytes}`);
    console.log(
      JSON.stringify({
        archiveMebibytes: Number((size / MEBIBYTE).toFixed(2)),
        imageCount,
        concurrency,
        copiedMebibytes: Number((copiedBytes / MEBIBYTE).toFixed(2)),
        syncCalls,
        rangeRequests,
        wholeRequests,
        baselineRssMebibytes: Number((baselineRssBytes / MEBIBYTE).toFixed(2)),
        peakRssMebibytes: Number((peakRssBytes / MEBIBYTE).toFixed(2)),
        incrementalRssMebibytes: Number(((peakRssBytes - baselineRssBytes) / MEBIBYTE).toFixed(2)),
        completed: results.every((result) => result.completed),
      }),
    );
  } finally {
    clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
  }
}
