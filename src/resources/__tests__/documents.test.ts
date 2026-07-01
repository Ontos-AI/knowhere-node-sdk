import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Documents } from '../documents.js';
import type { HttpClient } from '../../lib/http-client.js';

describe('Documents Resource', () => {
  let documents: Documents;
  let mockHttpClient: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockHttpClient = {
      get: vi.fn(),
      post: vi.fn(),
    };
    documents = new Documents(mockHttpClient as unknown as HttpClient);
  });

  it('should list documents in a namespace', async () => {
    mockHttpClient.get.mockResolvedValue({
      namespace: 'support-center',
      documents: [
        {
          documentId: 'doc-123',
          namespace: 'support-center',
          status: 'active',
          currentJobResultId: 'result-123',
          sourceFileName: 'refund-policy.md',
        },
      ],
      pagination: {
        page: 2,
        pageSize: 25,
        total: 26,
        totalPages: 2,
      },
    });

    const response = await documents.list({
      namespace: 'support-center',
      page: 2,
      pageSize: 25,
    });

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents', {
      params: { namespace: 'support-center', page: 2, page_size: 25 },
    });
    expect(response.documents[0]?.documentId).toBe('doc-123');
    expect(response.pagination.totalPages).toBe(2);
  });

  it('should omit namespace query params when not provided', async () => {
    mockHttpClient.get.mockResolvedValue({
      namespace: 'default',
      documents: [],
      pagination: {
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 0,
      },
    });

    await documents.list();

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents', undefined);
  });

  it('should synthesize document pagination for legacy API responses', async () => {
    mockHttpClient.get.mockResolvedValue({
      namespace: 'default',
      documents: [
        {
          documentId: 'doc-123',
          namespace: 'default',
          status: 'active',
        },
      ],
    });

    const response = await documents.list();

    expect(response.pagination).toEqual({
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    });
  });

  it('should get one document by id', async () => {
    mockHttpClient.get.mockResolvedValue({
      documentId: 'doc-123',
      namespace: 'support-center',
      status: 'active',
    });

    const document = await documents.get('doc-123');

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents/doc-123');
    expect(document.documentId).toBe('doc-123');
  });

  it('should list current document chunks with optional filters', async () => {
    mockHttpClient.get.mockResolvedValue({
      documentId: 'doc-123',
      namespace: 'support-center',
      jobResultId: 'result-123',
      jobId: 'job-123',
      chunks: [
        {
          id: 'dchk-123',
          chunkId: 'parser-chunk-1',
          chunkType: 'page',
          contentSource: 'summary',
          content: 'Revenue rose across the covered pages.',
          sectionId: 'sec-123',
          sectionPath: 'Chapter 1',
          sourceChunkPath: 'Chapter 1/Pages 4-6',
          filePath: null,
          sortOrder: 0,
          metadata: { summary: 'Revenue rose across the covered pages.', pageNums: [4, 5, 6] },
          assetUrl: null,
          createdAt: new Date('2026-04-27T04:00:00Z'),
        },
      ],
      pagination: {
        page: 2,
        pageSize: 10,
        total: 11,
        totalPages: 2,
      },
    });

    const response = await documents.listChunks('doc-123', {
      page: 2,
      pageSize: 10,
      chunkType: 'page',
      includeAssetUrls: true,
    });

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents/doc-123/chunks', {
      params: {
        page: 2,
        page_size: 10,
        chunk_type: 'page',
        include_asset_urls: true,
      },
    });
    expect(response.chunks[0]?.id).toBe('dchk-123');
    expect(response.chunks[0]?.chunkType).toBe('page');
    expect(response.chunks[0]?.contentSource).toBe('summary');
    expect(response.pagination.totalPages).toBe(2);
  });

  it('should route document chunk reads to v2 when requested', async () => {
    mockHttpClient.get.mockResolvedValue({
      documentId: 'doc-123',
      namespace: 'support-center',
      jobResultId: null,
      jobId: null,
      chunks: [],
      pagination: {
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 0,
      },
    });

    await documents.listChunks('doc-123', {
      apiVersion: 'v2',
      chunkType: 'page',
    });

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v2/documents/doc-123/chunks', {
      params: {
        chunk_type: 'page',
      },
    });
  });

  it('should omit chunk query params when defaults are used', async () => {
    mockHttpClient.get.mockResolvedValue({
      documentId: 'doc-123',
      namespace: 'support-center',
      jobResultId: null,
      jobId: null,
      chunks: [],
      pagination: {
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 0,
      },
    });

    await documents.listChunks('doc-123');

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents/doc-123/chunks', undefined);
  });

  it('should allow explicit document chunk asset URL control', async () => {
    mockHttpClient.get.mockResolvedValue({
      documentId: 'doc-123',
      namespace: 'support-center',
      jobResultId: 'result-123',
      jobId: 'job-123',
      chunks: [],
      pagination: {
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 0,
      },
    });

    await documents.listChunks('doc-123', {
      includeAssetUrls: false,
    });

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents/doc-123/chunks', {
      params: {
        include_asset_urls: false,
      },
    });
  });

  it('should get one document chunk with explicit asset URL control', async () => {
    mockHttpClient.get.mockResolvedValue({
      documentId: 'doc-123',
      namespace: 'support-center',
      jobResultId: 'result-123',
      jobId: 'job-123',
      chunk: {
        id: 'dchk-123',
        chunkId: 'parser-chunk-1',
        chunkType: 'image',
        content: 'Figure summary',
        sectionId: 'sec-123',
        sectionPath: 'Chapter 1',
        sourceChunkPath: 'Chapter 1/Figure',
        filePath: 'images/figure-1.png',
        sortOrder: 0,
        metadata: { summary: 'Figure' },
        assetUrl: 'https://assets.example/figure-1.png',
        createdAt: new Date('2026-04-27T04:00:00Z'),
      },
    });

    const response = await documents.getChunk('doc-123', 'dchk-123', {
      includeAssetUrls: true,
    });

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents/doc-123/chunks/dchk-123', {
      params: {
        include_asset_urls: true,
      },
    });
    expect(response.chunk.assetUrl).toBe('https://assets.example/figure-1.png');
  });

  it('should archive using the canonical route', async () => {
    mockHttpClient.post.mockResolvedValue({
      documentId: 'doc-123',
      namespace: 'support-center',
      status: 'archived',
      archivedAt: new Date('2026-04-21T16:13:42Z'),
    });

    const document = await documents.archive('doc-123');

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v1/documents/doc-123/archive');
    expect(document.status).toBe('archived');
    expect(document.archivedAt).toBeInstanceOf(Date);
  });
});
