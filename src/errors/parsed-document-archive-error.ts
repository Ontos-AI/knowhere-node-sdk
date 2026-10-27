import { KnowhereError } from './base.js';

/** Sequential ZIP extraction or snapshot verification could not access temporary storage. */
export class ParsedDocumentArchiveError extends KnowhereError {
  readonly code = 'ARCHIVE_SPOOL_FAILED' as const;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Parsed result ZIP temporary storage is unavailable.');
    this.name = 'ParsedDocumentArchiveError';
    this.cause = cause;
  }
}
