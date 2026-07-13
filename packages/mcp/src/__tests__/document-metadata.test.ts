import { describe, expect, it } from 'vitest';

import { MCP_DOCUMENT_METADATA_DEFAULTS } from '../document-metadata.js';
import { VERSION } from '../version.js';

describe('MCP_DOCUMENT_METADATA_DEFAULTS', () => {
  it('identifies the MCP client with the package version', () => {
    expect(MCP_DOCUMENT_METADATA_DEFAULTS).toEqual({
      createdByClient: 'mcp',
      clientVersion: VERSION,
    });
  });
});
