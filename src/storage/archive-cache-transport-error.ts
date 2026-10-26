export class ArchiveCacheTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveCacheTransportError';
  }
}
