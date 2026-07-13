import type { DocumentMetadata } from '../types/params.js';
import { VERSION } from '../version.js';

/**
 * Official Knowhere client identity written into job `document_metadata`.
 *
 * Wire format (snake_case on the wire after HTTP serialization):
 * `{ created_by_client, client_version }`.
 *
 * Merge rule used by every official client: caller-provided keys win;
 * defaults only fill keys that are missing.
 */
export const NODE_SDK_DOCUMENT_METADATA_DEFAULTS = {
  createdByClient: 'node-sdk',
  clientVersion: VERSION,
} as const satisfies DocumentMetadata;

/**
 * Merge official-client defaults under caller-provided document metadata.
 * Existing keys on `provided` are preserved; defaults fill gaps only.
 */
export function mergeDocumentMetadataDefaults(
  defaults: DocumentMetadata,
  provided?: DocumentMetadata | null,
): DocumentMetadata {
  if (!provided) {
    return { ...defaults };
  }
  return { ...defaults, ...provided };
}
