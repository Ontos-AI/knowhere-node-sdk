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
      routerUsed: 'discovery+agent',
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
      dataType: 6,
      signalPaths: ['Billing', 'Refunds'],
      filterMode: 'keep',
      channels: ['path', 'term'],
      channelWeights: { path: 2, term: 0.5 },
      rerank: true,
      threshold: 0.2,
      internalRecallK: 25,
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
      dataType: 6,
      signalPaths: ['Billing', 'Refunds'],
      filterMode: 'keep',
      channels: ['path', 'term'],
      channelWeights: { path: 2, term: 0.5 },
      rerank: true,
      threshold: 0.2,
      internalRecallK: 25,
      excludeDocumentIds: ['doc-old'],
      excludeSections: [
        {
          documentId: 'doc-123',
          sectionPath: 'Policies / Draft',
        },
      ],
    });
    expect(response.routerUsed).toBe('discovery+agent');
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

  it('should send useAgentic parameter', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'test',
      routerUsed: 'workflow_single_step',
      answerText: 'Generated answer',
      referencedChunks: [{ chunkId: 'chunk-1', assetUrl: 'https://example.com' }],
      results: [],
    });

    await retrieval.query({ query: 'test', useAgentic: true });

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v1/retrieval/query', {
      query: 'test',
      useAgentic: true,
    });
  });

  it('should handle agentic response fields', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'test',
      routerUsed: 'workflow_single_step',
      answerText: 'LLM-generated answer',
      referencedChunks: [
        { chunkId: 'chunk-1', documentId: 'doc-1', assetUrl: 'https://example.com/1' },
      ],
      results: [],
    });

    const response = await retrieval.query({ query: 'test', useAgentic: true });

    expect(response.answerText).toBe('LLM-generated answer');
    expect(response.referencedChunks).toHaveLength(1);
    expect(response.referencedChunks?.[0]?.chunkId).toBe('chunk-1');
  });

  it('should handle legacy response without agentic fields', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'refund policy',
      results: [],
    });

    const response = await retrieval.query({ query: 'refund policy' });

    expect(response.answerText).toBeUndefined();
    expect(response.referencedChunks).toBeUndefined();
    expect(response.results).toEqual([]);
  });

  it('should handle null answerText', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'test',
      routerUsed: 'small_kb_all',
      answerText: null,
      referencedChunks: [],
      results: [],
    });

    const response = await retrieval.query({ query: 'test', useAgentic: true });

    expect(response.answerText).toBeNull();
    expect(response.referencedChunks).toEqual([]);
  });
});
