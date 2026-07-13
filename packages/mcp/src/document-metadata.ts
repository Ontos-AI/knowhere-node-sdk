import { VERSION } from './version.js';

/**
 * Official MCP client identity for job `document_metadata`.
 * Caller-provided keys win; defaults fill missing keys only when merged
 * upstream by the Node SDK `jobs.create` helper.
 */
export const MCP_DOCUMENT_METADATA_DEFAULTS = {
  createdByClient: 'mcp',
  clientVersion: VERSION,
} as const;
