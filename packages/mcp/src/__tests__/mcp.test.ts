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
    const statusTool = tools.tools.find((tool) => tool.name === 'knowhere_async_get_job_status');
    const listTool = tools.tools.find((tool) => tool.name === 'knowhere_list_documents');
    const parseFileTool = tools.tools.find((tool) => tool.name === 'knowhere_parse_file');
    const asyncParseFileTool = tools.tools.find(
      (tool) => tool.name === 'knowhere_async_parse_file',
    );
    const readTool = tools.tools.find((tool) => tool.name === 'knowhere_read_chunks');
    const searchTool = tools.tools.find((tool) => tool.name === 'knowhere_search');

    expect(toolNames).toEqual([
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
    expect(statusTool?.description).toContain('5s, 10s, 20s, 40s, 80s');
    expect(statusTool?.description).toContain('Large PDFs or OCR-heavy files can take 10+ minutes');
    expect(listTool?.description).toContain('remote API');
    expect(parseFileTool?.description).toContain(
      'resolved on the machine running this stdio MCP server',
    );
    expect(asyncParseFileTool?.description).toContain(
      'resolved on the machine running this stdio MCP server',
    );
    expect(readTool?.description).toContain('configured parsed storage first');
    expect(readTool?.description).toContain('returns asset URLs');
    expect(readTool?.description).toContain('metadata.pageAssets');
    expect(searchTool?.description).toContain('metadata.pageAssets');
    await client.close();
    await server.close();
  });

  it('should hide parse and delete tools for read only permission', async () => {
    const { client, server } = await connectTestClient(createClient(), undefined, 'read_only');
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([
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

  it('should list published documents from the remote document API', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    const response = await client.callTool({
      name: 'knowhere_list_documents',
      arguments: {
        namespace: 'support-center',
      },
    });

    expect(knowhereClient.listRemoteDocuments).toHaveBeenCalledWith({
      namespace: 'support-center',
    });
    expect(knowhereClient.knowledge.listDocuments).not.toHaveBeenCalled();
    expect(response.structuredContent).toEqual({
      result: {
        namespace: 'support-center',
        documents: [
          {
            documentId: 'doc-remote-1',
            namespace: 'support-center',
            status: 'active',
          },
        ],
      },
    });
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

    expect(knowhereClient.knowledge.parseToLocalCache).toHaveBeenCalledWith({
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

  it('should pass remote document ids through read-related tools', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    await client.callTool({
      name: 'knowhere_get_document_outline',
      arguments: {
        documentId: 'doc_remote',
      },
    });
    await client.callTool({
      name: 'knowhere_read_chunks',
      arguments: {
        documentId: 'doc_remote',
        revisionKey: 'jres_remote',
        page: 1,
        pageSize: 3,
        chunkType: 'page',
        limit: 3,
      },
    });
    await client.callTool({
      name: 'knowhere_grep_chunks',
      arguments: {
        documentId: 'doc_remote',
        revisionKey: 'jres_remote',
        pattern: 'revenue',
        continuationCursor: 'cursor-1',
        chunkType: 'page',
      },
    });

    expect(knowhereClient.knowledge.getDocumentOutline).toHaveBeenCalledWith({
      documentId: 'doc_remote',
    });
    expect(knowhereClient.knowledge.readChunks).toHaveBeenCalledWith({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      page: 1,
      pageSize: 3,
      chunkType: 'page',
      limit: 3,
    });
    expect(knowhereClient.knowledge.grepChunks).toHaveBeenCalledWith({
      documentId: 'doc_remote',
      revisionKey: 'jres_remote',
      pattern: 'revenue',
      continuationCursor: 'cursor-1',
      chunkType: 'page',
    });
    await client.close();
    await server.close();
  });

  it('should pass completed job ids through read-related tools', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    await client.callTool({
      name: 'knowhere_get_document_outline',
      arguments: {
        jobId: 'job_remote',
        localDocumentId: 'local-from-job',
      },
    });
    await client.callTool({
      name: 'knowhere_read_chunks',
      arguments: {
        jobId: 'job_remote',
        localDocumentId: 'local-from-job',
        sectionPath: 'Overview',
        limit: 3,
      },
    });
    await client.callTool({
      name: 'knowhere_grep_chunks',
      arguments: {
        jobId: 'job_remote',
        localDocumentId: 'local-from-job',
        pattern: 'revenue',
      },
    });

    expect(knowhereClient.knowledge.getDocumentOutline).toHaveBeenCalledWith({
      jobId: 'job_remote',
      localDocumentId: 'local-from-job',
    });
    expect(knowhereClient.knowledge.readChunks).toHaveBeenCalledWith({
      jobId: 'job_remote',
      localDocumentId: 'local-from-job',
      sectionPath: 'Overview',
      limit: 3,
    });
    expect(knowhereClient.knowledge.grepChunks).toHaveBeenCalledWith({
      jobId: 'job_remote',
      localDocumentId: 'local-from-job',
      pattern: 'revenue',
    });
    await client.close();
    await server.close();
  });

  it('should delegate async parse and status calls to the SDK knowledge module', async () => {
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
    await client.close();
    await server.close();
  });

  it('should use an SDK knowledge adapter scoped to the configured cache directory', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient, '/tmp/knowhere-mcp-cache');

    await client.callTool({
      name: 'knowhere_read_chunks',
      arguments: {
        localDocumentId: 'local-report',
      },
    });

    expect(knowhereClient.knowledge.withCacheDirectory).toHaveBeenCalledWith(
      '/tmp/knowhere-mcp-cache',
    );
    expect(knowhereClient.knowledge.withParsedStorage).toHaveBeenCalledOnce();
    expect(knowhereClient.knowledge.recoverPendingAsyncParseJobs).toHaveBeenCalledOnce();
    expect(knowhereClient.knowledge.readChunks).toHaveBeenCalledWith({
      localDocumentId: 'local-report',
    });
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
  listRemoteDocuments: ReturnType<typeof vi.fn>;
  knowledge: KnowledgeWithMocks;
} {
  const knowledge: KnowledgeWithMocks = {
    parseToLocalCache: vi.fn().mockResolvedValue({
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
    importJobResult: vi.fn().mockResolvedValue({
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
    withParsedStorage: vi.fn(),
  };
  knowledge.withCacheDirectory.mockReturnValue(knowledge as unknown as Knowledge);
  knowledge.withParsedStorage.mockReturnValue(knowledge as unknown as Knowledge);
  const archiveDocument = vi.fn().mockResolvedValue({
    documentId: 'doc-1',
    status: 'archived',
  });
  const listRemoteDocuments = vi.fn().mockResolvedValue({
    namespace: 'support-center',
    documents: [
      {
        documentId: 'doc-remote-1',
        namespace: 'support-center',
        status: 'active',
      },
    ],
  });

  return {
    archiveDocument,
    listRemoteDocuments,
    documents: {
      list: listRemoteDocuments,
      archive: archiveDocument,
    },
    knowledge,
  } as unknown as Knowhere & {
    archiveDocument: ReturnType<typeof vi.fn>;
    listRemoteDocuments: ReturnType<typeof vi.fn>;
    knowledge: KnowledgeWithMocks;
  };
}

type KnowledgeWithMocks = Pick<
  Knowledge,
  | 'parseToLocalCache'
  | 'startParse'
  | 'getJobStatus'
  | 'importJobResult'
  | 'recoverPendingAsyncParseJobs'
  | 'listDocuments'
  | 'getDocumentOutline'
  | 'readChunks'
  | 'grepChunks'
  | 'search'
  | 'withCacheDirectory'
  | 'withParsedStorage'
> & {
  parseToLocalCache: Mock<Knowledge['parseToLocalCache']>;
  startParse: Mock<Knowledge['startParse']>;
  getJobStatus: Mock<Knowledge['getJobStatus']>;
  importJobResult: Mock<Knowledge['importJobResult']>;
  recoverPendingAsyncParseJobs: Mock<Knowledge['recoverPendingAsyncParseJobs']>;
  listDocuments: Mock<Knowledge['listDocuments']>;
  getDocumentOutline: Mock<Knowledge['getDocumentOutline']>;
  readChunks: Mock<Knowledge['readChunks']>;
  grepChunks: Mock<Knowledge['grepChunks']>;
  search: Mock<Knowledge['search']>;
  withCacheDirectory: Mock<Knowledge['withCacheDirectory']>;
  withParsedStorage: Mock<Knowledge['withParsedStorage']>;
};
