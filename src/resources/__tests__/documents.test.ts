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
    });

    const response = await documents.list({ namespace: 'support-center' });

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents', {
      params: { namespace: 'support-center' },
    });
    expect(response.documents[0]?.documentId).toBe('doc-123');
  });

  it('should omit namespace query params when not provided', async () => {
    mockHttpClient.get.mockResolvedValue({
      namespace: 'default',
      documents: [],
    });

    await documents.list();

    expect(mockHttpClient.get).toHaveBeenCalledWith('/v1/documents', undefined);
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
