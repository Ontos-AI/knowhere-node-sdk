import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { VERSION } from '../index.js';
import { NODE_SDK_DOCUMENT_METADATA_DEFAULTS } from '../lib/document-metadata.js';

it('reports the package version in public exports and default document metadata', async (): Promise<void> => {
  const manifest: unknown = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error('Expected the SDK package manifest to declare its version');
  }

  expect({
    exportedVersion: VERSION,
    clientVersion: NODE_SDK_DOCUMENT_METADATA_DEFAULTS.clientVersion,
  }).toEqual({ exportedVersion: manifest.version, clientVersion: manifest.version });
});
