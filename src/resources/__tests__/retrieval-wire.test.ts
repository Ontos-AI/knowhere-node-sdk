import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Knowhere, type RetrievalQueryParams } from '../../index.js';

describe.each(['apiKey', 'authTokenProvider'] as const)('Retrieval wire payload (%s)', (auth) => {
  beforeEach(() => {
    vi.stubEnv('KNOWHERE_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each<{ name: string; params: RetrievalQueryParams; body: string }>([
    {
      name: 'includes overlapping include/exclude IDs and section exclusions',
      params: {
        query: 'battery charging',
        includeDocumentIds: ['doc_123', 'doc_old'],
        excludeDocumentIds: ['doc_old'],
        excludeSections: [{ documentId: 'doc_123', sectionPath: 'Appendix / Legal' }],
      },
      body: '{"query":"battery charging","include_document_ids":["doc_123","doc_old"],"exclude_document_ids":["doc_old"],"exclude_sections":[{"document_id":"doc_123","section_path":"Appendix / Legal"}]}',
    },
    {
      name: 'preserves empty inclusion and exclusion arrays',
      params: { query: 'battery charging', includeDocumentIds: [], excludeDocumentIds: [] },
      body: '{"query":"battery charging","include_document_ids":[],"exclude_document_ids":[]}',
    },
    {
      name: 'omits document filters when not supplied',
      params: { query: 'battery charging' },
      body: '{"query":"battery charging"}',
    },
  ])('$name', async ({ params, body }) => {
    let receivedBody = '';
    let receivedMethod: string | undefined;
    let receivedUrl: string | undefined;
    let receivedAuthorization: string | undefined;
    const server = createServer((request, response) => {
      receivedMethod = request.method;
      receivedUrl = request.url;
      receivedAuthorization = request.headers.authorization;
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        receivedBody += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"results":[]}');
      });
    });

    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const client = new Knowhere({
        baseURL: `http://127.0.0.1:${address.port}`,
        ...(auth === 'apiKey'
          ? { apiKey: 'test-key' }
          : { authTokenProvider: (): string => 'test-token' }),
        maxRetries: 0,
      });

      await client.retrieval.query(params);

      expect(receivedMethod).toBe('POST');
      expect(receivedUrl).toBe('/v2/retrieval/query');
      expect(receivedAuthorization).toBe(
        auth === 'apiKey' ? 'Bearer test-key' : 'Bearer test-token',
      );
      expect(receivedBody).toBe(body);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
});

describe('Retrieval wire response', () => {
  it('keeps composed evidence and camelCases image media type', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          namespace: 'default',
          query: 'refund policy',
          router_used: 'small_corpus_all',
          evidence: [
            { type: 'text', text: 'before' },
            { type: 'image', media_type: 'image/png', data: 'abc' },
          ],
          evidence_text: 'beforedata:image/png;base64,abc',
          results: [
            {
              content: '[images/a.png]',
              chunk_type: 'text',
              score: 1,
              source: { document_id: 'doc-1' },
            },
          ],
        }),
      );
    });

    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      const client = new Knowhere({
        baseURL: `http://127.0.0.1:${address.port}`,
        apiKey: 'test-key',
        maxRetries: 0,
      });

      const result = await client.retrieval.query({ query: 'refund policy' });

      expect(result.evidence).toEqual([
        { type: 'text', text: 'before' },
        { type: 'image', mediaType: 'image/png', data: 'abc' },
      ]);
      expect(result.results[0]?.content).toBe('[images/a.png]');
      expect(result.results[0]).not.toHaveProperty('composed');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
});
