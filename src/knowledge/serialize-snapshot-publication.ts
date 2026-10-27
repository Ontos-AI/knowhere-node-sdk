import type { ParsedDocumentStorage } from '../types/storage.js';

const pendingPublications: WeakMap<
  ParsedDocumentStorage,
  Map<string, Promise<unknown>>
> = new WeakMap();

/** Serialize local pointer writes shared by Knowledge clients using the same adapter. */
export async function serializeSnapshotPublication<Value>(
  storage: ParsedDocumentStorage,
  documentId: string,
  publish: () => Promise<Value>,
): Promise<Value> {
  const publications: Map<string, Promise<unknown>> = pendingPublications.get(storage) ??
  new Map<string, Promise<unknown>>();
  pendingPublications.set(storage, publications);
  const previous: Promise<unknown> = publications.get(documentId) ?? Promise.resolve();
  const current: Promise<Value> = previous.catch(() => undefined).then(publish);
  publications.set(documentId, current);
  try {
    return await current;
  } finally {
    if (publications.get(documentId) === current) publications.delete(documentId);
  }
}
