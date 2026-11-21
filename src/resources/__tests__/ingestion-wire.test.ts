import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { expect, it } from 'vitest';
import { Knowhere, type WebhookConfig } from '../../index.js';

it('submits a replacement admission hint and the explicit Hipo event selection', async (): Promise<void> => {
  const webhook: WebhookConfig = {
    url: 'https://example.com/knowhere-callback',
    events: [
      'job.completed',
      'job.failed',
      'job.document.directory_ready',
      'job.enrichment.failed',
    ],
  };
  const requests: unknown[] = [];
  const server: Server = createServer((request, response): void => {
    void buffer(request).then((body): void => {
      const params: unknown = JSON.parse(body.toString());
      requests.push(params);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          job_id: 'job-replacement',
          status: 'pending',
          source_type: 'url',
          created_at: '2026-11-20T12:00:00Z',
          document_id: 'doc-new',
        }),
      );
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
    const client: Knowhere = new Knowhere({
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      maxRetries: 0,
    });
    const job = await client.startParse({
      url: 'https://example.com/original.pdf',
      namespace: 'project',
      replacesDocumentId: 'doc-old',
      webhook,
    });
    await client.jobs.create({
      sourceType: 'url',
      sourceUrl: 'https://example.com/demo.pdf',
      namespace: '__knowhere_demo__',
      dataId: 'catalog-entry',
      documentId: 'doc-demo',
      webhook: { url: webhook.url },
    });

    expect(job.documentId).toBe('doc-new');
    expect(requests[0]).toMatchObject({
      source_url: 'https://example.com/original.pdf',
      namespace: 'project',
      replaces_document_id: 'doc-old',
      webhook,
    });
    expect(requests[0]).not.toHaveProperty('document_id');
    expect(requests[1]).toMatchObject({
      namespace: '__knowhere_demo__',
      data_id: 'catalog-entry',
      document_id: 'doc-demo',
      webhook: { url: webhook.url },
    });
    expect(requests[1]).not.toHaveProperty('replaces_document_id');
    expect(requests[1]).not.toHaveProperty('webhook.events');
  } finally {
    await new Promise<void>((resolve, reject): void => {
      server.close((error): void => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
