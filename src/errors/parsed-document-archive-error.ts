import { KnowhereError } from './base.js';

/** The sequential ZIP fallback could not access its SDK-owned temporary storage. */
export class ParsedDocumentArchiveError extends KnowhereError {
  readonly code = 'ARCHIVE_SPOOL_FAILED' as const;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      'Parsed result ZIP temporary storage is unavailable. Range-enabled object storage avoids temporary disk usage.',
    );
    this.name = 'ParsedDocumentArchiveError';
    this.cause = cause;
  }
}
