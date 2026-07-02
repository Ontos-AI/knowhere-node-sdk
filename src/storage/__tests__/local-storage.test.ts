import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalKnowhereSdkStorage } from '../local-storage.js';

describe('LocalKnowhereSdkStorage', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    tempDirectories.length = 0;
  });

  it('writes objects with metadata sidecars and optional public URLs', async () => {
    const rootDirectory = await createTempDirectory(tempDirectories);
    const storage = new LocalKnowhereSdkStorage({
      rootDirectory,
      publicBaseUrl: 'https://cdn.example/assets/',
    });

    const write = await storage.writeObject({
      key: 'documents/doc-1/page.png',
      body: new TextEncoder().encode('image'),
      contentType: 'image/png',
      metadata: { width: '120', height: '240' },
    });
    const head = await storage.headObject('documents/doc-1/page.png');
    const read = await storage.readObject('documents/doc-1/page.png');
    const sidecar = await readFile(
      path.join(rootDirectory, 'documents', 'doc-1', 'page.png.metadata.json'),
      'utf8',
    );

    expect(write.url).toBe('https://cdn.example/assets/documents/doc-1/page.png');
    expect(head).toMatchObject({
      contentType: 'image/png',
      metadata: { width: '120', height: '240' },
    });
    expect(Buffer.from(read?.body ?? new Uint8Array()).toString('utf8')).toBe('image');
    expect(JSON.parse(sidecar)).toMatchObject({
      contentType: 'image/png',
      metadata: { width: '120', height: '240' },
    });
  });

  it('rejects unsafe keys', async () => {
    const rootDirectory = await createTempDirectory(tempDirectories);
    const storage = new LocalKnowhereSdkStorage({ rootDirectory });

    await expect(
      storage.writeObject({
        key: '../escape.txt',
        body: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/relative POSIX path/);
    await expect(storage.headObject('/absolute.txt')).rejects.toThrow(/relative POSIX path/);
  });

  it('deletes prefixes inside the storage root', async () => {
    const rootDirectory = await createTempDirectory(tempDirectories);
    const storage = new LocalKnowhereSdkStorage({ rootDirectory });

    await storage.writeObject({
      key: 'documents/doc-1/page.png',
      body: new Uint8Array([1]),
    });
    await storage.deletePrefix('documents/doc-1');

    expect(await storage.headObject('documents/doc-1/page.png')).toBeNull();
  });
});

async function createTempDirectory(tempDirectories: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'knowhere-storage-'));
  tempDirectories.push(directory);
  return directory;
}
