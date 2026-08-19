import { describe, expect, it, vi, type Mock } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { MCP_DOCUMENT_METADATA_DEFAULTS } from '../document-metadata.js';
import { createKnowhereMcpServer } from '../index.js';
import type {
  Knowhere,
  Knowledge,
  KnowledgeChunkType,
  LocalKnowledgeDocument,
} from '@ontos-ai/knowhere-sdk';

describe('knowhere MCP wrapper', () => {
  it('should register SDK-backed text-output knowledge tools', async () => {
    const { client, server } = await connectTestClient(createClient());
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    const statusTool = tools.tools.find((tool) => tool.name === 'knowhere_async_get_job_status');
    const listTool = tools.tools.find((tool) => tool.name === 'knowhere_list_documents');
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
      'knowhere_read_chunks',
      'knowhere_search',
    ]);
    for (const tool of tools.tools) {
      expect(tool).not.toHaveProperty('outputSchema');
    }
    expect(statusTool?.description).toContain('5s, 10s, 20s, 40s, 80s');
    expect(statusTool?.description).toContain('Large PDFs or OCR-heavy files can take 10+ minutes');
    expect(listTool?.description).toContain('remote API');
    expect(asyncParseFileTool?.description).toContain(
      'resolved on the machine running this stdio MCP server',
    );
    expect(readTool?.description).toContain('configured parsed storage first');
    expect(readTool?.description).toContain('returns asset URLs');
    expect(readTool?.description).toContain('<pageAssets>');
    expect(searchTool?.description).toContain('hasPageAssets="true"');
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

  it('should list published documents from the remote document API as tagged text', async () => {
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
    expectToolText(
      response,
      `<knowhere operation="listDocuments">
  <documents namespace="support-center" count="1">
    <document documentId="doc-remote-1" namespace="support-center" sourceFileName="remote-report.pdf" status="active" currentJobResultId="jres-1">
      <chunkCounts />
    </document>
    <pagination page="1" pageSize="50" total="1" totalPages="1" />
  </documents>
</knowhere>`,
    );
    await client.close();
    await server.close();
  });

  it('should delegate async parse and grep calls to the SDK knowledge module', async () => {
    const knowhereClient = createClient();
    const { client, server } = await connectTestClient(knowhereClient);

    const parseResponse = await client.callTool({
      name: 'knowhere_async_parse_file',
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

    expect(knowhereClient.knowledge.startParse).toHaveBeenCalledWith({
      file: './report.md',
      fileName: undefined,
      namespace: undefined,
      localDocumentId: 'local-report',
      dataId: undefined,
      documentMetadata: { ...MCP_DOCUMENT_METADATA_DEFAULTS },
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
    expectToolText(
      parseResponse,
      `<knowhere operation="asyncParseFile">
  <job localDocumentId="local-report" jobId="job-async" status="running" sourceType="file" documentId="doc-async" namespace="support-center" />
</knowhere>`,
    );
    expectToolText(
      grepResponse,
      `<knowhere operation="grepChunks">
  <document localDocumentId="local-report" documentId="doc-1" jobId="job-1" namespace="support-center" sourceFileName="report.md" storageRoot="/tmp/knowhere/local-report">
    <chunkCounts total="3" text="1" image="0" table="0" page="2" />
  </document>
  <grep scannedChunks="3" truncated="false" count="0">
  </grep>
</knowhere>`,
    );
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
      documentMetadata: { ...MCP_DOCUMENT_METADATA_DEFAULTS },
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
    expectToolText(
      parseResponse,
      `<knowhere operation="asyncParseUrl">
  <job localDocumentId="local-report" jobId="job-async" status="running" sourceType="url" documentId="doc-async" namespace="support-center" />
</knowhere>`,
    );
    expectToolText(
      statusResponse,
      `<knowhere operation="jobStatus">
  <job jobId="job-async" status="done" sourceType="url" documentId="doc-async" namespace="support-center" isDone="true" isFailed="false" />
  <cache status="cached" localDocumentId="local-report">
    <document localDocumentId="local-report" documentId="doc-1" jobId="job-1" namespace="support-center" sourceFileName="report.md" storageRoot="/tmp/knowhere/local-report">
      <chunkCounts total="3" text="1" image="0" table="0" page="2" />
    </document>
  </cache>
</knowhere>`,
    );
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
    expectToolText(
      response,
      `<knowhere operation="deleteDocument">
  <deleteResult localDocumentId="local-report">
    <document documentId="doc-1" status="archived">
      <chunkCounts />
    </document>
  </deleteResult>
</knowhere>`,
    );
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
    expectToolText(
      response,
      `<knowhere operation="deleteDocument">
  <deleteResult localDocumentId="local-report">
    <document documentId="doc-1" status="archived">
      <chunkCounts />
    </document>
  </deleteResult>
</knowhere>`,
    );
    await client.close();
    await server.close();
  });

  it('should format outlines as tagged text', async () => {
    const knowhereClient = createClient();
    knowhereClient.knowledge.getDocumentOutline.mockResolvedValueOnce({
      document: createLocalDocument(),
      totalChunks: 3,
      typeCounts: createTypeCounts(),
      sections: [],
      sectionTree: [
        {
          sectionPath: 'Overview',
          sectionTitle: 'Overview',
          sectionLevel: 1,
          summary: 'Intro & context',
          startChunk: 1,
          endChunk: 2,
          chunkCount: 2,
          typeCounts: {
            text: 1,
            image: 0,
            table: 0,
            page: 1,
          },
          children: [],
        },
      ],
    });
    const { client, server } = await connectTestClient(knowhereClient);

    const response = await client.callTool({
      name: 'knowhere_get_document_outline',
      arguments: {
        localDocumentId: 'local-report',
      },
    });

    expectToolText(
      response,
      `<knowhere operation="outline">
  <document localDocumentId="local-report" documentId="doc-1" jobId="job-1" namespace="support-center" sourceFileName="report.md" storageRoot="/tmp/knowhere/local-report">
    <chunkCounts total="3" text="1" image="0" table="0" page="2" />
  </document>
  <outline totalChunks="3">
    <chunkCounts total="3" text="1" image="0" table="0" page="2" />
    <section sectionPath="Overview" sectionTitle="Overview" sectionLevel="1" startChunk="1" endChunk="2" chunkCount="2">
      <summary>Intro &amp; context</summary>
      <chunkCounts total="2" text="1" image="0" table="0" page="1" />
    </section>
  </outline>
</knowhere>`,
    );
    await client.close();
    await server.close();
  });

  it('should format local read chunks with chunk storage locations', async () => {
    const knowhereClient = createClient();
    knowhereClient.knowledge.readChunks.mockResolvedValueOnce({
      document: createLocalDocument(),
      chunks: [
        {
          position: 1,
          chunkId: 'chunk-text-1',
          chunkType: 'text',
          content: 'raw text',
          readableContent: 'Hello <world> & team',
          sectionPath: 'Overview',
          sourceChunkPath: 'chunks/text-1.md',
          pageNumbers: [1],
          metadata: {},
        },
        {
          position: 2,
          chunkId: 'chunk-table-1',
          chunkType: 'table',
          content: '<table></table>',
          readableContent: 'Revenue table',
          sectionPath: 'Tables',
          sourceChunkPath: 'chunks/table-1.md',
          filePath: 'tables/revenue.html',
          assetUrl: 'https://assets.example/table.html',
          metadata: {},
        },
      ],
      nextChunk: 3,
    });
    const { client, server } = await connectTestClient(knowhereClient);

    const response = await client.callTool({
      name: 'knowhere_read_chunks',
      arguments: {
        localDocumentId: 'local-report',
        limit: 2,
      },
    });

    expectToolText(
      response,
      `<knowhere operation="readChunks">
  <document localDocumentId="local-report" documentId="doc-1" jobId="job-1" namespace="support-center" sourceFileName="report.md" storageRoot="/tmp/knowhere/local-report">
    <chunkCounts total="3" text="1" image="0" table="0" page="2" />
  </document>
  <pagination nextChunk="3" />
  <chunks count="2">
    <chunk position="1" chunkId="chunk-text-1" chunkType="text" sectionPath="Overview" chunkPath="chunks/text-1.md" pageNumbers="1" storageLocation="/tmp/knowhere/local-report/chunks/text-1.md">
      <previewText>Hello &lt;world&gt; &amp; team</previewText>
    </chunk>
    <chunk position="2" chunkId="chunk-table-1" chunkType="table" sectionPath="Tables" chunkPath="chunks/table-1.md" filePath="tables/revenue.html" assetUrl="https://assets.example/table.html" storageLocation="/tmp/knowhere/local-report/tables/revenue.html">
      <previewText>Revenue table</previewText>
    </chunk>
  </chunks>
</knowhere>`,
    );
    await client.close();
    await server.close();
  });

  it('should format page assets and marker storage roots in read chunks', async () => {
    const knowhereClient = createClient();
    knowhereClient.knowledge.readChunks
      .mockResolvedValueOnce({
        document: createMarkerDocument('parsed-storage:doc_remote'),
        chunks: [
          {
            position: 1,
            chunkId: 'chunk-page-1',
            chunkType: 'page',
            content: '',
            readableContent: 'Page 1 summary',
            sectionPath: 'Page 1',
            sourceChunkPath: 'chunks/page-1.md',
            metadata: {
              pageAssets: [
                {
                  pageNum: 1,
                  artifactRef: 'page_citation_assets/page-1.png',
                  assetUrl: 'https://blob.example/page-1.png',
                  contentType: 'image/png',
                  width: 1200,
                  height: 1600,
                },
              ],
            },
          },
        ],
        page: 1,
        pageSize: 1,
        totalChunks: 2,
        totalPages: 2,
      })
      .mockResolvedValueOnce({
        document: createMarkerDocument('remote:doc_remote'),
        chunks: [
          {
            position: 2,
            chunkId: 'chunk-page-2',
            chunkType: 'page',
            content: '',
            readableContent: 'Page 2 summary',
            sectionPath: 'Page 2',
            sourceChunkPath: 'chunks/page-2.md',
            metadata: {
              page_assets: [
                {
                  page_num: 2,
                  artifact_ref: 'page_citation_assets/page-2.png',
                  content_type: 'image/png',
                  width: 1200,
                  height: 1600,
                },
              ],
            },
          },
        ],
      });
    const { client, server } = await connectTestClient(knowhereClient);

    const readablePageResponse = await client.callTool({
      name: 'knowhere_read_chunks',
      arguments: {
        documentId: 'doc_remote',
        page: 1,
        pageSize: 1,
      },
    });
    const unreadablePageResponse = await client.callTool({
      name: 'knowhere_read_chunks',
      arguments: {
        documentId: 'doc_remote',
        chunkId: 'chunk-page-2',
      },
    });

    expectToolText(
      readablePageResponse,
      `<knowhere operation="readChunks">
  <document localDocumentId="doc_remote" documentId="doc_remote" jobId="job-remote" namespace="support-center" sourceFileName="remote-report.pdf" storageRoot="parsed-storage:doc_remote">
    <chunkCounts total="2" text="0" image="0" table="0" page="2" />
  </document>
  <pagination page="1" pageSize="1" totalChunks="2" totalPages="2" />
  <chunks count="1">
    <chunk position="1" chunkId="chunk-page-1" chunkType="page" sectionPath="Page 1" chunkPath="chunks/page-1.md" storageLocation="parsed-storage:doc_remote/chunks/page-1.md">
      <pageAssets primary="true">
        <pageAsset pageNum="1" artifactRef="page_citation_assets/page-1.png" assetUrl="https://blob.example/page-1.png" contentType="image/png" width="1200" height="1600" />
      </pageAssets>
      <instruction>Open or fetch the listed assetUrl before relying on preview text.</instruction>
      <previewText>Page 1 summary</previewText>
    </chunk>
  </chunks>
</knowhere>`,
    );
    expectToolText(
      unreadablePageResponse,
      `<knowhere operation="readChunks">
  <document localDocumentId="doc_remote" documentId="doc_remote" jobId="job-remote" namespace="support-center" sourceFileName="remote-report.pdf" storageRoot="remote:doc_remote">
    <chunkCounts total="2" text="0" image="0" table="0" page="2" />
  </document>
  <pagination />
  <chunks count="1">
    <chunk position="2" chunkId="chunk-page-2" chunkType="page" sectionPath="Page 2" chunkPath="chunks/page-2.md" storageLocation="remote:doc_remote/chunks/page-2.md">
      <pageAssets primary="true">
        <pageAsset pageNum="2" artifactRef="page_citation_assets/page-2.png" contentType="image/png" width="1200" height="1600" />
      </pageAssets>
      <instruction>A page asset exists, but it is not directly readable because no assetUrl was returned.</instruction>
      <previewText>Page 2 summary</previewText>
    </chunk>
  </chunks>
</knowhere>`,
    );
    await client.close();
    await server.close();
  });

  it('should format grep truncation and continuation metadata', async () => {
    const knowhereClient = createClient();
    knowhereClient.knowledge.grepChunks.mockResolvedValueOnce({
      document: createMarkerDocument('parsed-storage:doc_remote'),
      matches: [
        {
          position: 2,
          chunkId: 'chunk-table-1',
          chunkType: 'table',
          sectionPath: 'Tables',
          sourceChunkPath: 'chunks/table-1.md',
          filePath: 'tables/revenue.html',
          startOffset: 5,
          endOffset: 12,
          snippet: '2026 revenue grew',
          pageNumbers: [4],
        },
      ],
      scannedChunks: 20,
      truncated: true,
      continuationCursor: 'cursor-next',
    });
    const { client, server } = await connectTestClient(knowhereClient);

    const response = await client.callTool({
      name: 'knowhere_grep_chunks',
      arguments: {
        documentId: 'doc_remote',
        pattern: 'revenue',
        maxResults: 1,
      },
    });

    expectToolText(
      response,
      `<knowhere operation="grepChunks">
  <document localDocumentId="doc_remote" documentId="doc_remote" jobId="job-remote" namespace="support-center" sourceFileName="remote-report.pdf" storageRoot="parsed-storage:doc_remote">
    <chunkCounts total="2" text="0" image="0" table="0" page="2" />
  </document>
  <grep scannedChunks="20" truncated="true" continuationCursor="cursor-next" count="1">
    <match position="2" chunkId="chunk-table-1" chunkType="table" sectionPath="Tables" chunkPath="chunks/table-1.md" filePath="tables/revenue.html" storageLocation="parsed-storage:doc_remote/tables/revenue.html" pageNumbers="4" startOffset="5" endOffset="12">
      <snippet>2026 revenue grew</snippet>
    </match>
  </grep>
</knowhere>`,
    );
    await client.close();
    await server.close();
  });

  it('should format search evidence and page-result guidance', async () => {
    const knowhereClient = createClient();
    knowhereClient.knowledge.search.mockResolvedValueOnce({
      namespace: 'support-center',
      query: 'revenue',
      evidenceText: 'Evidence <tree>',
      references: [
        {
          localDocumentId: 'local-report',
          documentId: 'doc-1',
          chunkId: 'chunk-page-1',
          chunkType: 'page',
          sectionPath: 'Page 1',
          score: 0.9,
        },
        {
          documentId: 'doc-1',
          chunkId: 'chunk-text-1',
          chunkType: 'text',
          sectionPath: 'Overview',
        },
      ],
      results: [
        {
          localDocumentId: 'local-report',
          documentId: 'doc-1',
          chunkId: 'chunk-page-1',
          chunkType: 'page',
          content: 'Page preview',
          score: 0.91,
          sectionPath: 'Page 1',
          sourceFileName: 'report.md',
        },
      ],
      rawResponse: {
        ignored: true,
      },
    });
    const { client, server } = await connectTestClient(knowhereClient);

    const response = await client.callTool({
      name: 'knowhere_search',
      arguments: {
        namespace: 'support-center',
        query: 'revenue',
        topK: 3,
      },
    });

    expect(knowhereClient.knowledge.search).toHaveBeenCalledWith({
      namespace: 'support-center',
      query: 'revenue',
      topK: 3,
      localDocumentIds: undefined,
      useAgentic: undefined,
    });
    expectToolText(
      response,
      `<knowhere operation="search">
  <search namespace="support-center" query="revenue" referenceCount="2" resultCount="1">
    <instruction>Page results and references marked hasPageAssets="true" only include preview text here. Call knowhere_read_chunks with the documentId and chunkId to get readable page asset URLs and chunk storage locations.</instruction>
    <evidenceText>Evidence &lt;tree&gt;</evidenceText>
    <references count="2">
      <reference localDocumentId="local-report" documentId="doc-1" chunkId="chunk-page-1" chunkType="page" sectionPath="Page 1" score="0.9" hasPageAssets="true" />
      <reference documentId="doc-1" chunkId="chunk-text-1" chunkType="text" sectionPath="Overview" />
    </references>
    <results count="1">
      <result localDocumentId="local-report" documentId="doc-1" chunkId="chunk-page-1" chunkType="page" sectionPath="Page 1" sourceFileName="report.md" score="0.91" hasPageAssets="true">
        <previewText>Page preview</previewText>
      </result>
    </results>
  </search>
</knowhere>`,
    );
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
    startParse: vi.fn().mockImplementation((params: Parameters<Knowledge['startParse']>[0]) =>
      Promise.resolve({
        job: {
          jobId: 'job-async',
          status: 'running',
          sourceType: 'file' in params ? 'file' : 'url',
          documentId: 'doc-async',
          namespace: 'support-center',
        },
        localDocumentId: 'local-report',
      }),
    ),
    getJobStatus: vi.fn().mockResolvedValue({
      job: {
        jobId: 'job-async',
        status: 'done',
        sourceType: 'url',
        documentId: 'doc-async',
        namespace: 'support-center',
        isDone: true,
        isFailed: false,
      },
      cache: {
        status: 'cached',
        localDocumentId: 'local-report',
        document: createLocalDocument(),
      },
    }),
    importJobResult: vi.fn().mockResolvedValue({
      document: createLocalDocument(),
    }),
    recoverPendingAsyncParseJobs: vi.fn().mockResolvedValue({
      checkedJobs: 0,
      results: [],
    }),
    listDocuments: vi.fn().mockResolvedValue([createLocalDocument()]),
    getDocumentOutline: vi.fn().mockResolvedValue({
      document: createLocalDocument(),
      totalChunks: 3,
      typeCounts: createTypeCounts(),
      sections: [],
      sectionTree: [],
    }),
    readChunks: vi.fn().mockResolvedValue({
      document: createLocalDocument(),
      chunks: [],
    }),
    grepChunks: vi.fn().mockResolvedValue({
      document: createLocalDocument(),
      matches: [],
      scannedChunks: 3,
      truncated: false,
    }),
    search: vi.fn().mockResolvedValue({
      query: 'empty',
      references: [],
      results: [],
      rawResponse: {},
    }),
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
        sourceFileName: 'remote-report.pdf',
        status: 'active',
        currentJobResultId: 'jres-1',
      },
    ],
    pagination: {
      page: 1,
      pageSize: 50,
      total: 1,
      totalPages: 1,
    },
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

function createLocalDocument(): LocalKnowledgeDocument {
  return {
    localDocumentId: 'local-report',
    jobId: 'job-1',
    documentId: 'doc-1',
    namespace: 'support-center',
    sourceFileName: 'report.md',
    chunkCount: 3,
    typeCounts: createTypeCounts(),
    resultDirectoryPath: '/tmp/knowhere/local-report',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function createMarkerDocument(storageRoot: string): LocalKnowledgeDocument {
  return {
    localDocumentId: 'doc_remote',
    jobId: 'job-remote',
    documentId: 'doc_remote',
    namespace: 'support-center',
    sourceFileName: 'remote-report.pdf',
    chunkCount: 2,
    typeCounts: {
      text: 0,
      image: 0,
      table: 0,
      page: 2,
    },
    resultDirectoryPath: storageRoot,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function createTypeCounts(): Record<KnowledgeChunkType, number> {
  return {
    text: 1,
    image: 0,
    table: 0,
    page: 2,
  };
}

function expectToolText(response: ToolCallResponse, expectedText: string): void {
  expect(response).not.toHaveProperty('structuredContent');
  if (!('content' in response)) {
    throw new Error('Expected MCP tool response to include content');
  }
  expect(response.content).toEqual([
    {
      type: 'text',
      text: expectedText,
    },
  ]);
}

type ToolCallResponse = Awaited<ReturnType<Client['callTool']>>;

type KnowledgeWithMocks = Pick<
  Knowledge,
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
