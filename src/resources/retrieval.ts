import { BaseResource } from './base.js';
import type { RetrievalQueryParams, RetrievalQueryResponse } from '../types/retrieval.js';

/**
 * Resource for querying published retrieval documents.
 */
export class Retrieval extends BaseResource {
  /**
   * Query published documents.
   */
  async query(params: RetrievalQueryParams): Promise<RetrievalQueryResponse> {
    return this.httpClient.post<RetrievalQueryResponse>('/v1/retrieval/query', params);
  }
}
