import { KnowhereError } from './base.js';
import type { PageCitationAssetWarning } from '../types/index.js';

export class PageCitationAssetGenerationError extends KnowhereError {
  readonly warnings: readonly PageCitationAssetWarning[];

  constructor(message: string, warnings: readonly PageCitationAssetWarning[]) {
    super(message);
    this.name = 'PageCitationAssetGenerationError';
    this.warnings = warnings;
  }
}
