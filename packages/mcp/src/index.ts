import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DiskParsedDocumentStorage,
  Knowhere,
  VERSION,
  ValidationError,
  type AuthTokenProvider,
  type Knowledge,
  type KnowledgeParseParams,
  type LocalKnowledgeDocument,
} from '@ontos-ai/knowhere-sdk';
import * as z from 'zod/v4';

import type { Permission } from './auth.js';
import { createKnowhereToolResult } from './tool-result-formatter.js';

const parsingParamsSchema = z
  .object({
    model: z.enum(['base', 'advanced']).optional(),
    ocrEnabled: z.boolean().optional(),
    kbDir: z.string().optional(),
    docType: z.enum(['auto', 'pdf', 'docx', 'txt', 'md']).optional(),
    smartTitleParse: z.boolean().optional(),
    summaryImage: z.boolean().optional(),
    summaryTable: z.boolean().optional(),
    summaryTxt: z.boolean().optional(),
    addFragDesc: z.string().optional(),
  })
  .optional();

export interface KnowhereMcpServerOptions {
  client?: Knowhere;
  authTokenProvider?: AuthTokenProvider;
  baseURL?: string;
  cacheDirectory?: string;
  permission?: Permission;
  recoverPendingJobsOnStart?: boolean;
}

export async function createKnowhereMcpServer(
  options?: KnowhereMcpServerOptions,
): Promise<McpServer> {
  const client =
    options?.client ??
    new Knowhere({
      authTokenProvider: options?.authTokenProvider,
      baseURL: options?.baseURL,
    });
  const knowledge: Knowledge = createKnowledgeClient(client, options?.cacheDirectory);
  if (options?.recoverPendingJobsOnStart !== false) {
    await knowledge.recoverPendingAsyncParseJobs();
  }
  const server = new McpServer({
    name: 'knowhere-local-knowledge',
    version: VERSION,
  });
  const permission = options?.permission ?? 'full_access';
  const hasWritePermission = permission === 'full_access';

  if (hasWritePermission) {
    server.registerTool(
      'knowhere_async_parse_url',
      {
        description:
          'Start parsing a remote URL through Knowhere and return immediately with the parse job. When checking status, call knowhere_async_get_job_status with exponential backoff: 5s, 10s, 20s, 40s, 80s, then cap at 120s. Large or OCR-heavy documents can take 10+ minutes; prefer sparse follow-up status checks over rapid repeated calls. After completion, use the returned localDocumentId, documentId, or jobId with outline/read/grep tools.',
        inputSchema: {
          url: z.string().url(),
          namespace: z.string().optional(),
          localDocumentId: z.string().optional(),
          dataId: z.string().optional(),
          parsingParams: parsingParamsSchema,
        },
      },
      async (input) =>
        createToolResult(
          'asyncParseUrl',
          await knowledge.startParse({
            url: input.url,
            namespace: input.namespace,
            localDocumentId: input.localDocumentId,
            dataId: input.dataId,
            ...toFlatParsingParams(input.parsingParams),
          }),
        ),
    );

    server.registerTool(
      'knowhere_async_parse_file',
      {
        description:
          'Start parsing a local file path available to this MCP process, upload it if needed, and return immediately with the parse job. The file path is resolved on the machine running this stdio MCP server, not on a remote chat client. When checking status, call knowhere_async_get_job_status with exponential backoff: 5s, 10s, 20s, 40s, 80s, then cap at 120s. Large PDFs or OCR-heavy files can take 10+ minutes; prefer sparse follow-up status checks over rapid repeated calls. After completion, use the returned localDocumentId, documentId, or jobId with outline/read/grep tools.',
        inputSchema: {
          file: z.string().describe('Local file path available to this MCP server process.'),
          fileName: z.string().optional(),
          namespace: z.string().optional(),
          localDocumentId: z.string().optional(),
          dataId: z.string().optional(),
          parsingParams: parsingParamsSchema,
        },
      },
      async (input) =>
        createToolResult(
          'asyncParseFile',
          await knowledge.startParse({
            file: input.file,
            fileName: input.fileName,
            namespace: input.namespace,
            localDocumentId: input.localDocumentId,
            dataId: input.dataId,
            ...toFlatParsingParams(input.parsingParams),
          }),
        ),
    );
  }

  server.registerTool(
    'knowhere_async_get_job_status',
    {
      description:
        'Fetch the current status for a Knowhere parse job. For follow-up status checks on non-completed jobs, use exponential backoff: 5s, 10s, 20s, 40s, 80s, then cap at 120s. Large PDFs or OCR-heavy files can take 10+ minutes; do not treat unchanged progress as failure unless the job reports isFailed or an explicit error. After completion, use the returned localDocumentId, documentId, or jobId with outline/read/grep tools.',
      inputSchema: {
        jobId: z.string(),
      },
    },
    async (input) => createToolResult('jobStatus', await knowledge.getJobStatus(input.jobId)),
  );

  server.registerTool(
    'knowhere_list_documents',
    {
      description:
        'List published Knowhere documents from the remote API, optionally filtered by namespace. Returned documentIds can be passed to outline/read/grep tools.',
      inputSchema: {
        namespace: z.string().optional(),
      },
    },
    async (input) =>
      createToolResult(
        'listDocuments',
        await client.documents.list({
          namespace: input.namespace,
        }),
      ),
  );

  if (hasWritePermission) {
    server.registerTool(
      'knowhere_delete_document',
      {
        description:
          'Archive, or soft-delete, a published Knowhere document through the Knowhere API. Provide documentId directly, or localDocumentId for a cached parse result that has a server documentId.',
        inputSchema: {
          documentId: z.string().optional(),
          localDocumentId: z.string().optional(),
        },
      },
      async (input) =>
        createToolResult(
          'deleteDocument',
          await archiveDocument({ client, knowledge, params: input }),
        ),
    );
  }

  server.registerTool(
    'knowhere_get_document_outline',
    {
      description:
        'Return the outline for one parsed document. Pass localDocumentId, published documentId, or completed jobId. The SDK reads configured parsed storage first, falls back to remote document chunks for documentId reads, and schedules bounded sync only when parsed storage is explicitly configured.',
      inputSchema: {
        localDocumentId: z.string().optional(),
        documentId: z.string().optional(),
        jobId: z.string().optional(),
        revisionKey: z.string().optional(),
      },
    },
    async (input) => createToolResult('outline', await knowledge.getDocumentOutline(input)),
  );

  server.registerTool(
    'knowhere_read_chunks',
    {
      description:
        'Read exact chunks from one parsed document. Pass localDocumentId, published documentId, or completed jobId. page/pageSize are for display reads and cannot be combined with sectionPath/startChunk/endChunk/chunkId. The SDK reads configured parsed storage first, falls back to remote document chunks for documentId reads, and returns asset URLs when the source or storage provides them. Page screenshots are returned as tagged <pageAssets> entries before preview text, not as image chunks.',
      inputSchema: {
        localDocumentId: z.string().optional(),
        documentId: z.string().optional(),
        jobId: z.string().optional(),
        revisionKey: z.string().optional(),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().optional(),
        sectionPath: z.string().optional(),
        startChunk: z.number().int().positive().optional(),
        endChunk: z.number().int().positive().optional(),
        chunkId: z.string().optional(),
        chunkType: z.enum(['text', 'image', 'table', 'page']).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (input) => createToolResult('readChunks', await knowledge.readChunks(input)),
  );

  server.registerTool(
    'knowhere_grep_chunks',
    {
      description:
        'Run grep-style literal or regex matching against one parsed document. Pass localDocumentId, published documentId, or completed jobId. Broad workspace search belongs to knowhere_search; grep matches include file paths and snippets, not asset URL fields.',
      inputSchema: {
        localDocumentId: z.string().optional(),
        documentId: z.string().optional(),
        jobId: z.string().optional(),
        revisionKey: z.string().optional(),
        pattern: z.string(),
        continuationCursor: z.string().optional(),
        isRegex: z.boolean().optional(),
        isCaseSensitive: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
        chunkType: z.enum(['text', 'image', 'table', 'page']).optional(),
        sectionPathPrefix: z.string().optional(),
        contextChars: z.number().int().nonnegative().optional(),
      },
    },
    async (input) => createToolResult('grepChunks', await knowledge.grepChunks(input)),
  );

  server.registerTool(
    'knowhere_search',
    {
      description:
        'Search published Knowhere documents with the Knowhere API retrieval query. localDocumentIds only map returned server document IDs back to local cache IDs when available. Page results are marked with hasPageAssets="true"; use follow-up read calls to get tagged <pageAssets> entries.',
      inputSchema: {
        query: z.string(),
        namespace: z.string().optional(),
        topK: z.number().int().positive().optional(),
        localDocumentIds: z.array(z.string()).optional(),
        useAgentic: z.boolean().optional(),
      },
    },
    async (input) => createToolResult('search', await knowledge.search(input)),
  );

  return server;
}

export async function runKnowhereMcpServer(options?: KnowhereMcpServerOptions): Promise<void> {
  const server = await createKnowhereMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function createKnowledgeClient(client: Knowhere, cacheDirectory: string | undefined): Knowledge {
  if (cacheDirectory === undefined) {
    return client.knowledge;
  }

  return client.knowledge.withCacheDirectory(cacheDirectory).withParsedStorage({
    storage: new DiskParsedDocumentStorage(path.join(cacheDirectory, 'parsed-documents')),
  });
}

function createToolResult(operation: string, result: unknown): CallToolResult {
  return createKnowhereToolResult({ operation, result });
}

function toFlatParsingParams(
  parsingParams: z.infer<NonNullable<typeof parsingParamsSchema>> | undefined,
): Partial<KnowledgeParseParams> {
  if (!parsingParams) {
    return {};
  }

  return {
    model: parsingParams.model,
    ocr: parsingParams.ocrEnabled,
    docType: parsingParams.docType,
    smartTitleParse: parsingParams.smartTitleParse,
    summaryImage: parsingParams.summaryImage,
    summaryTable: parsingParams.summaryTable,
    summaryTxt: parsingParams.summaryTxt,
    addFragDesc: parsingParams.addFragDesc,
    kbDir: parsingParams.kbDir,
  };
}

async function archiveDocument(params: {
  client: Knowhere;
  knowledge: Knowledge;
  params: {
    documentId?: string;
    localDocumentId?: string;
  };
}): Promise<{
  document: Awaited<ReturnType<Knowhere['documents']['archive']>>;
  localDocumentId?: string;
}> {
  const archiveTarget = await resolveArchiveTarget(params.knowledge, params.params);
  const document = await params.client.documents.archive(archiveTarget.documentId);
  return {
    document,
    localDocumentId: archiveTarget.localDocumentId,
  };
}

async function resolveArchiveTarget(
  knowledge: Knowledge,
  params: {
    documentId?: string;
    localDocumentId?: string;
  },
): Promise<{
  documentId: string;
  localDocumentId?: string;
}> {
  if (params.documentId) {
    return {
      documentId: params.documentId,
      localDocumentId: params.localDocumentId,
    };
  }

  if (!params.localDocumentId) {
    throw new ValidationError('documentId or localDocumentId is required');
  }

  const document = await findLocalDocument(knowledge, params.localDocumentId);
  if (!document) {
    throw new Error(`Local Knowhere document not found: ${params.localDocumentId}`);
  }
  if (!document.documentId) {
    throw new Error(`Local Knowhere document has no server documentId: ${params.localDocumentId}`);
  }

  return {
    documentId: document.documentId,
    localDocumentId: document.localDocumentId,
  };
}

async function findLocalDocument(
  knowledge: Knowledge,
  localDocumentId: string,
): Promise<LocalKnowledgeDocument | undefined> {
  const documents = await knowledge.listDocuments();
  return documents.find((document) => document.localDocumentId === localDocumentId);
}
