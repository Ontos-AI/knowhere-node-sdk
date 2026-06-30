import { BaseResource } from './base.js';
import type {
  Document,
  DocumentChunkGetParams,
  DocumentChunkListParams,
  DocumentChunkListResponse,
  DocumentChunkResponse,
  DocumentListParams,
  DocumentListResponse,
} from '../types/document.js';

type RequestConfig = {
  params: Record<string, string | number | boolean>;
};

/**
 * Resource for canonical document lifecycle operations.
 */
export class Documents extends BaseResource {
  /**
   * List canonical documents in a namespace.
   */
  async list(params?: DocumentListParams): Promise<DocumentListResponse> {
    return this.httpClient.get<DocumentListResponse>(
      '/v1/documents',
      this.createDocumentListRequestConfig(params),
    );
  }

  /**
   * Get one canonical document by ID.
   */
  async get(documentId: string): Promise<Document> {
    return this.httpClient.get<Document>(`/v1/documents/${documentId}`);
  }

  /**
   * List current-revision chunks for one canonical document.
   */
  async listChunks(
    documentId: string,
    params?: DocumentChunkListParams,
  ): Promise<DocumentChunkListResponse> {
    return this.httpClient.get<DocumentChunkListResponse>(
      `/v1/documents/${documentId}/chunks`,
      this.createChunkListRequestConfig(params),
    );
  }

  /**
   * Get one current-revision chunk for one canonical document.
   */
  async getChunk(
    documentId: string,
    documentChunkId: string,
    params?: DocumentChunkGetParams,
  ): Promise<DocumentChunkResponse> {
    return this.httpClient.get<DocumentChunkResponse>(
      `/v1/documents/${documentId}/chunks/${documentChunkId}`,
      this.createChunkGetRequestConfig(params),
    );
  }

  /**
   * Archive one canonical document by ID.
   */
  async archive(documentId: string): Promise<Document> {
    return this.httpClient.post<Document>(`/v1/documents/${documentId}/archive`);
  }

  private createDocumentListRequestConfig(params?: DocumentListParams): RequestConfig | undefined {
    if (!params) {
      return undefined;
    }

    const queryParams: Record<string, string | number | boolean> = {};
    if (params.namespace !== undefined) {
      queryParams.namespace = params.namespace;
    }
    if (params.page !== undefined) {
      queryParams.page = params.page;
    }
    if (params.pageSize !== undefined) {
      queryParams.page_size = params.pageSize;
    }

    return Object.keys(queryParams).length > 0 ? { params: queryParams } : undefined;
  }

  private createChunkListRequestConfig(
    params?: DocumentChunkListParams,
  ): RequestConfig | undefined {
    if (!params) {
      return undefined;
    }

    const queryParams: Record<string, string | number | boolean> = {};
    if (params.page !== undefined) {
      queryParams.page = params.page;
    }
    if (params.pageSize !== undefined) {
      queryParams.page_size = params.pageSize;
    }
    if (params.chunkType !== undefined) {
      queryParams.chunk_type = params.chunkType;
    }
    if (params.includeAssetUrls !== undefined) {
      queryParams.include_asset_urls = params.includeAssetUrls;
    }

    return Object.keys(queryParams).length > 0 ? { params: queryParams } : undefined;
  }

  private createChunkGetRequestConfig(params?: DocumentChunkGetParams): RequestConfig | undefined {
    if (params?.includeAssetUrls === undefined) {
      return undefined;
    }

    return {
      params: {
        include_asset_urls: params.includeAssetUrls,
      },
    };
  }
}
