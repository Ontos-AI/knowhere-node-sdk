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
      'knowhere_async_cache_job_result',
      'knowhere_async_get_job_status',
      'knowhere_async_parse_file',
      'knowhere_async_parse_url',
      'knowhere_delete_document',
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

  it('should hide parse and delete tools for read only permission', async () => {
    const { client, server } = await connectTestClient(createClient(), undefined, 'read_only');
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([
      'knowhere_async_cache_job_result',
      'knowhere_async_get_job_status',
      'knowhere_get_document_outline',
      'knowhere_grep_chunks',
      'knowhere_list_documents',
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

  it('should delegate async parse, status, and cache calls to the SDK knowledge module', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    const parseResponse = await client.callTool({
      name: 'knowhere_async_parse_url',
      arguments: {
        url: 'https://example.com/report.pdf',
        localDocumentId: 'local-report',
        parsingParams: {
          model: 'advanced',
        },
      },
    });
    const statusResponse = await client.callTool({
      name: 'knowhere_async_get_job_status',
      arguments: {
        jobId: 'job-async',
      },
    });
    const cacheResponse = await client.callTool({
      name: 'knowhere_async_cache_job_result',
      arguments: {
        jobId: 'job-async',
        localDocumentId: 'local-report',
        verifyChecksum: false,
      },
    });

    expect(knowhereClient.knowledge.startParse).toHaveBeenCalledWith({
      url: 'https://example.com/report.pdf',
      namespace: undefined,
      localDocumentId: 'local-report',
      dataId: undefined,
      model: 'advanced',
      ocr: undefined,
      docType: undefined,
      smartTitleParse: undefined,
      summaryImage: undefined,
      summaryTable: undefined,
      summaryTxt: undefined,
      addFragDesc: undefined,
      kbDir: undefined,
    });
    expect(knowhereClient.knowledge.getJobStatus).toHaveBeenCalledWith('job-async');
    expect(knowhereClient.knowledge.cacheJobResult).toHaveBeenCalledWith({
      jobId: 'job-async',
      localDocumentId: 'local-report',
      verifyChecksum: false,
    });
    expect(parseResponse.structuredContent).toEqual({
      result: {
        job: {
          jobId: 'job-async',
        },
        localDocumentId: 'local-report',
      },
    });
    expect(statusResponse.structuredContent).toEqual({
      result: {
        cache: {
          document: {
            localDocumentId: 'local-report',
          },
          localDocumentId: 'local-report',
          status: 'cached',
        },
        job: {
          jobId: 'job-async',
          status: 'done',
        },
      },
    });
    expect(cacheResponse.structuredContent).toEqual({
      result: {
        document: {
          localDocumentId: 'local-report',
        },
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
    expect(knowhereClient.knowledge.recoverPendingAsyncParseJobs).toHaveBeenCalledOnce();
    expect(knowhereClient.knowledge.listDocuments).toHaveBeenCalledOnce();
    await client.close();
    await server.close();
  });

  it('should delegate delete calls to the SDK document lifecycle resource', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    const response = await client.callTool({
      name: 'knowhere_delete_document',
      arguments: {
        documentId: 'doc-1',
        localDocumentId: 'local-report',
      },
    });

    expect(knowhereClient.archiveDocument).toHaveBeenCalledWith('doc-1');
    expect(response.structuredContent).toEqual({
      result: {
        document: {
          documentId: 'doc-1',
          status: 'archived',
        },
        localDocumentId: 'local-report',
      },
    });
    await client.close();
    await server.close();
  });

  it('should resolve archive calls from a cached local document id', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    const response = await client.callTool({
      name: 'knowhere_delete_document',
      arguments: {
        localDocumentId: 'local-report',
      },
    });

    expect(knowhereClient.knowledge.listDocuments).toHaveBeenCalledOnce();
    expect(knowhereClient.archiveDocument).toHaveBeenCalledWith('doc-1');
    expect(response.structuredContent).toEqual({
      result: {
        document: {
          documentId: 'doc-1',
          status: 'archived',
        },
        localDocumentId: 'local-report',
      },
    });
    await client.close();
    await server.close();
  });

  it('should recover pending async parse jobs when the MCP server starts', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    expect(knowhereClient.knowledge.recoverPendingAsyncParseJobs).toHaveBeenCalledOnce();

    await client.close();
    await server.close();
  });
});

async function connectTestClient(
  knowhereClient: Knowhere,
  cacheDirectory?: string,
  permission?: 'read_only' | 'full_access',
): Promise<{
  client: Client;
  server: Awaited<ReturnType<typeof createKnowhereMcpServer>>;
}> {
  const server = await createKnowhereMcpServer({
    client: knowhereClient,
    cacheDirectory,
    permission,
  });
  const client = new Client({ name: 'knowhere-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function createClient(): Knowhere & {
  archiveDocument: ReturnType<typeof vi.fn>;
  knowledge: KnowledgeWithMocks;
} {
  const knowledge: KnowledgeWithMocks = {
    parse: vi.fn().mockResolvedValue({
      document: { localDocumentId: 'local-report' },
      result: { jobId: 'job-1' },
    }),
    startParse: vi.fn().mockResolvedValue({
      job: { jobId: 'job-async' },
      localDocumentId: 'local-report',
    }),
    getJobStatus: vi.fn().mockResolvedValue({
      job: { jobId: 'job-async', status: 'done' },
      cache: {
        status: 'cached',
        localDocumentId: 'local-report',
        document: { localDocumentId: 'local-report' },
      },
    }),
    cacheJobResult: vi.fn().mockResolvedValue({
      document: { localDocumentId: 'local-report' },
    }),
    recoverPendingAsyncParseJobs: vi.fn().mockResolvedValue({
      checkedJobs: 0,
      results: [],
    }),
    listDocuments: vi.fn().mockResolvedValue([
      {
        localDocumentId: 'local-report',
        documentId: 'doc-1',
      },
    ]),
    getDocumentOutline: vi.fn().mockResolvedValue({ sections: [] }),
    readChunks: vi.fn().mockResolvedValue({ chunks: [] }),
    grepChunks: vi.fn().mockResolvedValue({ matches: [] }),
    search: vi.fn().mockResolvedValue({ results: [] }),
    withCacheDirectory: vi.fn(),
  };
  knowledge.withCacheDirectory.mockReturnValue(knowledge as unknown as Knowledge);
  const archiveDocument = vi.fn().mockResolvedValue({
    documentId: 'doc-1',
    status: 'archived',
  });

  return {
    archiveDocument,
    documents: {
      archive: archiveDocument,
    },
    knowledge,
  } as unknown as Knowhere & {
    archiveDocument: ReturnType<typeof vi.fn>;
    knowledge: KnowledgeWithMocks;
  };
}

type KnowledgeWithMocks = Pick<
  Knowledge,
  | 'parse'
  | 'startParse'
  | 'getJobStatus'
  | 'cacheJobResult'
  | 'recoverPendingAsyncParseJobs'
  | 'listDocuments'
  | 'getDocumentOutline'
  | 'readChunks'
  | 'grepChunks'
  | 'search'
  | 'withCacheDirectory'
> & {
  parse: Mock<Knowledge['parse']>;
  startParse: Mock<Knowledge['startParse']>;
  getJobStatus: Mock<Knowledge['getJobStatus']>;
  cacheJobResult: Mock<Knowledge['cacheJobResult']>;
  recoverPendingAsyncParseJobs: Mock<Knowledge['recoverPendingAsyncParseJobs']>;
  listDocuments: Mock<Knowledge['listDocuments']>;
  getDocumentOutline: Mock<Knowledge['getDocumentOutline']>;
  readChunks: Mock<Knowledge['readChunks']>;
  grepChunks: Mock<Knowledge['grepChunks']>;
  search: Mock<Knowledge['search']>;
  withCacheDirectory: Mock<Knowledge['withCacheDirectory']>;
};
