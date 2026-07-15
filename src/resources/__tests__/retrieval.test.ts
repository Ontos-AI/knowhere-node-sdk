import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Retrieval } from '../retrieval.js';
import type { HttpClient } from '../../lib/http-client.js';
import type { RetrievalQueryResponse, RetrievalReferencedChunk } from '../../types/retrieval.js';

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
      answerText: null,
      referencedChunks: [],
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
      chunkTypes: ['text', 'table', 'page'],
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

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v2/retrieval/query', {
      namespace: 'support-center',
      query: 'refund policy',
      topK: 5,
      dataType: 6,
      chunkTypes: ['text', 'table', 'page'],
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
      routerUsed: 'small_corpus_all',
      answerText: null,
      referencedChunks: [],
      results: [],
    });

    await retrieval.query({ query: 'refund policy' });

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v2/retrieval/query', {
      query: 'refund policy',
    });
  });

  it('should send llmConfig parameter', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'test',
      routerUsed: 'workflow_single_step',
      answerText: null,
      referencedChunks: [],
      results: [],
    });

    await retrieval.query({
      query: 'test',
      useAgentic: true,
      llmConfig: {
        text: {
          apiKey: 'sk-text',
          model: 'gpt-4o-mini',
          baseUrl: 'https://api.openai.com/v1',
        },
        vision: {
          apiKey: 'sk-vision',
          model: 'gpt-4o',
        },
      },
    });

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v2/retrieval/query', {
      query: 'test',
      useAgentic: true,
      llmConfig: {
        text: {
          apiKey: 'sk-text',
          model: 'gpt-4o-mini',
          baseUrl: 'https://api.openai.com/v1',
        },
        vision: {
          apiKey: 'sk-vision',
          model: 'gpt-4o',
        },
      },
    });
  });

  it('should send useAgentic parameter', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'test',
      routerUsed: 'workflow_single_step',
      answerText: 'Generated answer',
      referencedChunks: [
        {
          chunkId: 'chunk-1',
          documentId: 'doc-1',
          chunkType: 'image',
          sectionPath: 'Images',
          filePath: 'images/chunk-1.png',
          jobId: 'job-1',
          assetUrl: 'https://example.com',
        },
      ],
      results: [],
    });

    await retrieval.query({ query: 'test', useAgentic: true });

    expect(mockHttpClient.post).toHaveBeenCalledWith('/v2/retrieval/query', {
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
      evidenceText: 'Rendered retrieval evidence',
      stopReason: 'answer_done',
      failureReason: 'insufficient evidence',
      decisionTrace: [
        { phase: 'discovery', action: 'select_documents', selected: ['doc-1'] },
        {
          phase: 'terminal',
          action: 'complete',
          stopReason: 'answer_done',
          failureReason: 'insufficient evidence',
        },
      ],
      referencedChunks: [
        {
          chunkId: 'chunk-1',
          documentId: 'doc-1',
          chunkType: 'page',
          sectionPath: 'Page 4',
          filePath: null,
          jobId: 'job-1',
          assetUrl: 'https://assets.example/page-4.png',
          metadata: {
            pageAssets: [
              {
                pageNum: 4,
                artifactRef: 'page_citation_assets/page-4.png',
                assetUrl: 'https://assets.example/page-4.png',
                contentType: 'image/png',
                source: 'knowhere-rendered-page-citation-source',
              },
            ],
          },
        },
      ],
      results: [],
    });

    const response = await retrieval.query({ query: 'test', useAgentic: true });
    const typedResponse: RetrievalQueryResponse = response;
    const referencedChunk: RetrievalReferencedChunk | undefined = response.referencedChunks[0];

    expect(typedResponse.answerText).toBe('LLM-generated answer');
    expect(response.evidenceText).toBe('Rendered retrieval evidence');
    expect(response.stopReason).toBe('answer_done');
    expect(response.failureReason).toBe('insufficient evidence');
    expect(response.referencedChunks).toHaveLength(1);
    expect(referencedChunk?.chunkId).toBe('chunk-1');
    expect(referencedChunk?.filePath).toBeNull();
    expect(referencedChunk?.metadata?.pageAssets).toEqual([
      expect.objectContaining({
        assetUrl: 'https://assets.example/page-4.png',
      }),
    ]);
    expect(referencedChunk).not.toHaveProperty('pageAssets');
    expect(response.decisionTrace).toHaveLength(2);
    expect(response.decisionTrace![0]).toHaveProperty('phase', 'discovery');
    expect(response.decisionTrace![1]).toHaveProperty('phase', 'terminal');
  });

  it('should handle legacy response without agentic fields', async () => {
    mockHttpClient.post.mockResolvedValue({
      namespace: 'default',
      query: 'refund policy',
      routerUsed: 'small_corpus_all',
      answerText: null,
      referencedChunks: [],
      results: [],
    });

    const response = await retrieval.query({ query: 'refund policy' });

    expect(response.answerText).toBeNull();
    expect(response.referencedChunks).toEqual([]);
    expect(response.results).toEqual([]);
    expect(response.decisionTrace).toBeUndefined();
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
