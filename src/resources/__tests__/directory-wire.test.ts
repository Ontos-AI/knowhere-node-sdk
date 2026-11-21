import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { expect, expectTypeOf, it } from 'vitest';
import { Knowhere } from '../../index.js';

it.each([0, 1, 3])('reads pinned directory version %i', async (version: number): Promise<void> => {
  let receivedUrl: string | undefined;
  let authorization: string | undefined;
  const wireSections = [
    {
      section_id: 'section-one',
      parent_section_id: null,
      section_path: 'Chapter',
      section_title: null,
      section_level: 1,
      sort_order: 0,
      page_nums: [1, 2],
    },
  ] as const;
  const server: Server = createServer((request, response): void => {
    receivedUrl = request.url;
    authorization = request.headers.authorization;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        document_id: 'doc-one',
        job_id: 'job-one',
        job_result_id: 'result-one',
        namespace: 'project/one',
        directory_version: version,
        directory_committed_at: version > 0 ? '2026-10-29T17:00:00+00:00' : null,
        sections: version > 0 ? wireSections : [],
      }),
    );
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
    const client = new Knowhere({
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      maxRetries: 0,
    });
    const directory = await client.documents.getStructure('doc-one', {
      jobResultId: 'result-one',
      namespace: 'project/one',
    });
    expectTypeOf(directory.directoryVersion).toEqualTypeOf<number>();
    expect(directory.directoryVersion).toBe(version);
    expect(receivedUrl).toBe(
      '/v2/documents/doc-one/structure?job_result_id=result-one&namespace=project%2Fone',
    );
    expect(authorization).toBe('Bearer test-key');
    if (version === 0) {
      expect(directory.directoryCommittedAt).toBeNull();
      expect(directory.sections).toEqual([]);
      return;
    }
    expect(directory.directoryCommittedAt).toEqual(new Date('2026-10-29T17:00:00Z'));
    expect(directory.sections[0]).toEqual({
      sectionId: 'section-one',
      parentSectionId: null,
      sectionPath: 'Chapter',
      sectionTitle: null,
      sectionLevel: 1,
      sortOrder: 0,
      pageNums: [1, 2],
    });
  } finally {
    await new Promise<void>((resolve, reject): void => {
      server.close((err): void => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    });
  }
});
