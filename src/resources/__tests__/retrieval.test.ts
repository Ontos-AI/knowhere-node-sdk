import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Retrieval } from '../retrieval.js';
import type { HttpClient } from '../../lib/http-client.js';

describe('Retrieval Resource', () => {
  let retrieval: Retrieval;
  let mockHttpClient: {
    post: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockHttpClient = {
      post: vi.fn(),
    };
    retrieval = new Retrieval(mockHttpClient as unknown as HttpClient);
  });

  it('should query retrieval results with the canonical source object', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'support-center',
      query: 'refund policy',
      results: [
        {
          content: 'Annual plans may be refunded within 30 days.',
          chunkType: 'text',
          score: 1,
          source: {
            documentId: 'doc-123',
            sourceFileName: 'refund-policy.md',
            sectionPath: 'Policies / Billing / Refunds',
          },
        },
      ],
    });

    const response = await retrieval.query({
      namespace: 'support-center',
      query: 'refund policy',
      topK: 5,
      excludeDocumentIds: ['doc-old'],
      excludeSections: [
        {
          documentId: 'doc-123',
          sectionPath: 'Policies / Draft',
        },
      ],
    });

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v1/retrieval/query', {
      namespace: 'support-center',
      query: 'refund policy',
      topK: 5,
      excludeDocumentIds: ['doc-old'],
      excludeSections: [
        {
          documentId: 'doc-123',
          sectionPath: 'Policies / Draft',
        },
      ],
    });
    expect(response.results[0]).toEqual({
      content: 'Annual plans may be refunded within 30 days.',
      chunkType: 'text',
      score: 1,
      source: {
        documentId: 'doc-123',
        sourceFileName: 'refund-policy.md',
        sectionPath: 'Policies / Billing / Refunds',
      },
    });
    expect('citation' in response.results[0]).toBe(false);
    expect('chunkId' in response.results[0]).toBe(false);
    expect('sectionId' in response.results[0]).toBe(false);
  });

  it('should omit optional request fields when not provided', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'refund policy',
      results: [],
    });

    await retrieval.query({ query: 'refund policy' });

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v1/retrieval/query', {
      query: 'refund policy',
    });
  });
});
