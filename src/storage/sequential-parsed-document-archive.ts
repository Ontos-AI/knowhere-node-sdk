import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { mkdtemp, open, rm, type FileHandle } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { crc32 } from 'zlib';
import { ZipReader, Reader, type FileEntry } from '@zip.js/zip.js';
import Parse from 'unzipper/lib/parse.js';
import type { Entry as SequentialEntry } from 'unzipper';
import { ParsedDocumentArchiveError } from '../errors/parsed-document-archive-error.js';
import { normalizeResultPath } from './parsed-document-storage.js';
import {
  isSnapshotPath,
  createDownloadIdentity,
  type ArchiveSource,
  type ArchiveEntry,
  type StreamedSyncParams,
} from './streamed-parsed-document-sync.js';

export async function openSequentialArchive(
  params: StreamedSyncParams,
  identity: string,
  validateResponse?: (response: Response) => Response,
): Promise<ArchiveSource> {
  // Cached verification streams the entire pinned object through its Range validator.
  let response: Response = await fetch(params.resultUrl, {
    signal: params.signal,
    headers: validateResponse ? { Range: 'bytes=0-' } : undefined,
  });
  if (!response.ok || !response.body)
    throw new Error(`Parsed result download failed (HTTP ${response.status}).`);
  if (validateResponse) response = validateResponse(response);
  else if (createDownloadIdentity(params.jobId, response) !== identity) {
    await response.body.cancel();
    throw new Error('Parsed result archive identity changed before sequential download.');
  }
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (!body) throw new Error('Parsed result download returned an empty body.');
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), 'knowhere-sync-'));
  } catch (error) {
    await body.cancel();
    throw new ParsedDocumentArchiveError(error);
  }
  let file: FileHandle;
  try {
    file = await open(join(directory, 'archive.zip'), 'w+');
  } catch (error) {
    await body.cancel();
    await rm(directory, { recursive: true, force: true });
    throw new ParsedDocumentArchiveError(error);
  }
  const input: Readable = Readable.fromWeb(body);
  const parser = Parse({ forceStream: true });
  const checksums: Map<string, { readonly checksum: number; readonly size: number }> = new Map();
  let archiveSize: number = 0;
  const archiveHash = createHash('sha256');
  // unzipper extracts sequentially, but does not verify CRCs. Spool compressed bytes to disk
  // for a central-directory check after extraction, including entries with data descriptors.
  const spool: Transform = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      archiveSize += chunk.length;
      archiveHash.update(chunk);
      void file.writeFile(chunk).then(
        (): void => {
          callback(null, chunk);
        },
        (error: Error): void => {
          callback(new ParsedDocumentArchiveError(error));
        },
      );
    },
  });
  const completed: Promise<void> = pipeline(input, spool, parser, { signal: params.signal });
  // A bounded return or storage failure destroys this pipeline in close().
  void completed.catch((): void => undefined);
  return {
    identity,
    downloadIdentity: identity,
    canSkipEntries: false,
    readArchive: (): ReadableStream<Uint8Array> => {
      let position: number = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          params.signal?.throwIfAborted();
          if (position >= archiveSize) {
            controller.close();
            return;
          }
          const body: Uint8Array = new Uint8Array(Math.min(65_536, archiveSize - position));
          const { bytesRead } = await file.read(body, 0, body.length, position);
          if (bytesRead !== body.length) throw new Error('Truncated verified archive spool.');
          position += bytesRead;
          controller.enqueue(body);
        },
      });
    },
    entries: (async function* (): AsyncGenerator<ArchiveEntry> {
      for await (const value of parser) {
        const entry: SequentialEntry = value as SequentialEntry;
        if (entry.type === 'Directory' || !isSnapshotPath(entry.path)) {
          await entry.autodrain().promise();
          continue;
        }
        const path: string = normalizeResultPath(entry.path);
        yield {
          path,
          contentLength:
            !(entry.vars.flags & 0x08) &&
            'uncompressedSize' in entry.vars &&
            typeof entry.vars.uncompressedSize === 'number'
              ? entry.vars.uncompressedSize
              : undefined,
          read: (): ReadableStream<Uint8Array> => {
            let checksum: number = 0;
            let size: number = 0;
            return (Readable.toWeb(entry) as ReadableStream<Uint8Array>).pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller): void {
                  checksum = crc32(chunk, checksum);
                  size += chunk.length;
                  controller.enqueue(chunk);
                },
                flush(): void {
                  checksums.set(path, { checksum, size });
                },
              }),
            );
          },
        };
      }
      await completed;
      if (params.snapshot && archiveHash.digest('hex') !== params.snapshot.checksum)
        throw new Error('Parsed snapshot archive checksum mismatch for extracted bytes.');
      const reader = new ZipReader(new DiskArchiveReader(file, archiveSize), {
        useWebWorkers: false,
      });
      try {
        const files = (await reader.getEntries()).filter(
          (entry): entry is FileEntry => !entry.directory && isSnapshotPath(entry.filename),
        );
        if (files.length !== checksums.size)
          throw new Error('Parsed result ZIP directory does not match sequential entries.');
        for (const entry of files) {
          const actual = checksums.get(normalizeResultPath(entry.filename));
          if (
            !actual ||
            actual.checksum !== entry.signature ||
            actual.size !== entry.uncompressedSize
          )
            throw new Error(`Invalid parsed result ZIP checksum or size: ${entry.filename}`);
        }
      } finally {
        await reader.close();
      }
    })(),
    close: async (): Promise<void> => {
      input.destroy();
      spool.destroy();
      parser.destroy();
      await completed.catch((): void => undefined);
      try {
        await file.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

class DiskArchiveReader extends Reader<FileHandle> {
  constructor(
    private readonly file: FileHandle,
    size: number,
  ) {
    super(file);
    this.size = size;
  }
  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const body: Uint8Array = new Uint8Array(length);
    const { bytesRead } = await this.file.read(body, 0, length, index);
    if (bytesRead !== length) throw new Error('Truncated parsed result ZIP.');
    return body;
  }
}
