import { describe, expect, it } from 'vitest';

import { VERSION } from '../../version.js';
import {
  mergeDocumentMetadataDefaults,
  NODE_SDK_DOCUMENT_METADATA_DEFAULTS,
} from '../document-metadata.js';

describe('mergeDocumentMetadataDefaults', () => {
  it('fills createdByClient and clientVersion when metadata is omitted', () => {
    expect(mergeDocumentMetadataDefaults(NODE_SDK_DOCUMENT_METADATA_DEFAULTS)).toEqual({
      createdByClient: 'node-sdk',
      clientVersion: VERSION,
    });
  });

  it('fills only missing keys when caller provides partial metadata', () => {
    expect(
      mergeDocumentMetadataDefaults(NODE_SDK_DOCUMENT_METADATA_DEFAULTS, {
        title: 'Report.pdf',
      }),
    ).toEqual({
      createdByClient: 'node-sdk',
      clientVersion: VERSION,
      title: 'Report.pdf',
    });
  });

  it('lets caller overrides win for createdByClient and clientVersion', () => {
    expect(
      mergeDocumentMetadataDefaults(NODE_SDK_DOCUMENT_METADATA_DEFAULTS, {
        createdByClient: 'cli',
        clientVersion: '9.9.9',
        title: 'Report.pdf',
      }),
    ).toEqual({
      createdByClient: 'cli',
      clientVersion: '9.9.9',
      title: 'Report.pdf',
    });
  });
});
