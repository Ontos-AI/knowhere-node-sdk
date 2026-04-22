import { BaseResource } from './base.js';
import type { Document, DocumentListResponse } from '../types/document.js';

/**
 * Resource for canonical document lifecycle operations.
 */
export class Documents extends BaseResource {
  /**
   * List canonical documents in a namespace.
   */
  async list(params?: { namespace?: string }): Promise<DocumentListResponse> {
    const requestConfig = params?.namespace
      ? {
          params: {
            namespace: params.namespace,
          },
        }
      : undefined;

    return this.httpClient.get<DocumentListResponse>('/v1/documents', requestConfig);
  }

  /**
   * Get one canonical document by ID.
   */
  async get(documentId: string): Promise<Document> {
    return this.httpClient.get<Document>(`/v1/documents/${documentId}`);
  }

  /**
   * Archive one canonical document by ID.
   */
  async archive(documentId: string): Promise<Document> {
    return this.httpClient.post<Document>(`/v1/documents/${documentId}/archive`);
  }
}
