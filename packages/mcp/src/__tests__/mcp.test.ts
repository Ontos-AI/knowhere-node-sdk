import { describe, expect, it, vi, type Mock } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createKnowhereMcpServer } from '../index.js';
import type { Knowhere, Knowledge } from '@ontos-ai/knowhere-sdk';

describe('knowhere MCP wrapper', () => {
  it('should register SDK-backed knowledge tools', async () => {
    const { client, server } = await connectTestClient(createClient());
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([
      'knowhere_get_document_outline',
      'knowhere_grep_chunks',
      'knowhere_list_documents',
      'knowhere_parse_file',
      'knowhere_parse_url',
      'knowhere_read_chunks',
      'knowhere_search',
    ]);
    await client.close();
    await server.close();
  });

  it('should delegate parse and grep calls to the SDK knowledge module', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    const parseResponse = await client.callTool({
      name: 'knowhere_parse_file',
      arguments: {
        file: './report.md',
        localDocumentId: 'local-report',
        parsingParams: {
          model: 'base',
          ocrEnabled: true,
        },
      },
    });
    const grepResponse = await client.callTool({
      name: 'knowhere_grep_chunks',
      arguments: {
        localDocumentId: 'local-report',
        pattern: 'revenue',
      },
    });

    expect(knowhereClient.knowledge.parse).toHaveBeenCalledWith({
      file: './report.md',
      fileName: undefined,
      namespace: undefined,
      localDocumentId: 'local-report',
      dataId: undefined,
      model: 'base',
      ocr: true,
      docType: undefined,
      smartTitleParse: undefined,
      summaryImage: undefined,
      summaryTable: undefined,
      summaryTxt: undefined,
      addFragDesc: undefined,
      kbDir: undefined,
    });
    expect(knowhereClient.knowledge.grepChunks).toHaveBeenCalledWith({
      localDocumentId: 'local-report',
      pattern: 'revenue',
    });
    expect(parseResponse.structuredContent).toEqual({
      result: {
        document: {
          localDocumentId: 'local-report',
        },
        result: {
          jobId: 'job-1',
        },
      },
    });
    expect(grepResponse.structuredContent).toEqual({
      result: {
        matches: [],
      },
    });
    await client.close();
    await server.close();
  });

  it('should use an SDK knowledge adapter scoped to the configured cache directory', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient, '/tmp/knowhere-mcp-cache');

    await client.callTool({
      name: 'knowhere_list_documents',
      arguments: {},
    });

    expect(knowhereClient.knowledge.withCacheDirectory).toHaveBeenCalledWith(
      '/tmp/knowhere-mcp-cache',
    );
    expect(knowhereClient.knowledge.listDocuments).toHaveBeenCalledOnce();
    await client.close();
    await server.close();
  });
});

async function connectTestClient(
  knowhereClient: Knowhere,
  cacheDirectory?: string,
): Promise<{
  client: Client;
  server: ReturnType<typeof createKnowhereMcpServer>;
}> {
  const server = createKnowhereMcpServer({ client: knowhereClient, cacheDirectory });
  const client = new Client({ name: 'knowhere-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function createClient(): Knowhere & { knowledge: KnowledgeWithMocks } {
  const knowledge: KnowledgeWithMocks = {
    parse: vi.fn().mockResolvedValue({
      document: { localDocumentId: 'local-report' },
      result: { jobId: 'job-1' },
    }),
    listDocuments: vi.fn().mockResolvedValue([]),
    getDocumentOutline: vi.fn().mockResolvedValue({ sections: [] }),
    readChunks: vi.fn().mockResolvedValue({ chunks: [] }),
    grepChunks: vi.fn().mockResolvedValue({ matches: [] }),
    search: vi.fn().mockResolvedValue({ results: [] }),
    withCacheDirectory: vi.fn(),
  };
  knowledge.withCacheDirectory.mockReturnValue(knowledge as unknown as Knowledge);

  return {
    knowledge,
  } as unknown as Knowhere & { knowledge: KnowledgeWithMocks };
}

type KnowledgeWithMocks = Pick<
  Knowledge,
  | 'parse'
  | 'listDocuments'
  | 'getDocumentOutline'
  | 'readChunks'
  | 'grepChunks'
  | 'search'
  | 'withCacheDirectory'
> & {
  parse: Mock<Knowledge['parse']>;
  listDocuments: Mock<Knowledge['listDocuments']>;
  getDocumentOutline: Mock<Knowledge['getDocumentOutline']>;
  readChunks: Mock<Knowledge['readChunks']>;
  grepChunks: Mock<Knowledge['grepChunks']>;
  search: Mock<Knowledge['search']>;
  withCacheDirectory: Mock<Knowledge['withCacheDirectory']>;
};
