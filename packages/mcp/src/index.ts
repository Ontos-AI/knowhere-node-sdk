import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  Knowhere,
  VERSION,
  type Knowledge,
  type KnowledgeParseParams,
} from '@ontos-ai/knowhere-sdk';
import * as z from 'zod/v4';

type ToolResult = object;

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

const objectOutputSchema = {
  result: z.record(z.string(), z.unknown()),
};

export interface KnowhereMcpServerOptions {
  client?: Knowhere;
  cacheDirectory?: string;
  recoverPendingJobsOnStart?: boolean;
}

export async function createKnowhereMcpServer(
  options?: KnowhereMcpServerOptions,
): Promise<McpServer> {
  const client = options?.client ?? new Knowhere();
  const knowledge: Knowledge =
    options?.cacheDirectory === undefined
      ? client.knowledge
      : client.knowledge.withCacheDirectory(options.cacheDirectory);
  if (options?.recoverPendingJobsOnStart !== false) {
    await knowledge.recoverPendingAsyncParseJobs();
  }
  const server = new McpServer({
    name: 'knowhere-local-knowledge',
    version: VERSION,
  });

  server.registerTool(
    'knowhere_parse_url',
    {
      description:
        'Blocking parse: submit a remote URL to Knowhere, wait for completion, then cache the parse result locally for outline/read/grep/search tools.',
      inputSchema: {
        url: z.string().url(),
        namespace: z.string().optional(),
        localDocumentId: z.string().optional(),
        dataId: z.string().optional(),
        parsingParams: parsingParamsSchema,
      },
      outputSchema: objectOutputSchema,
    },
    async (input) =>
      createToolResult(
        await knowledge.parse({
          url: input.url,
          namespace: input.namespace,
          localDocumentId: input.localDocumentId,
          dataId: input.dataId,
          ...toFlatParsingParams(input.parsingParams),
        }),
      ),
  );

  server.registerTool(
    'knowhere_parse_file',
    {
      description:
        'Blocking parse: submit a local file path available to this MCP process, wait for completion, then cache the parse result locally.',
      inputSchema: {
        file: z.string().describe('Local file path available to this MCP server process.'),
        fileName: z.string().optional(),
        namespace: z.string().optional(),
        localDocumentId: z.string().optional(),
        dataId: z.string().optional(),
        parsingParams: parsingParamsSchema,
      },
      outputSchema: objectOutputSchema,
    },
    async (input) =>
      createToolResult(
        await knowledge.parse({
          file: input.file,
          fileName: input.fileName,
          namespace: input.namespace,
          localDocumentId: input.localDocumentId,
          dataId: input.dataId,
          ...toFlatParsingParams(input.parsingParams),
        }),
      ),
  );

  server.registerTool(
    'knowhere_async_parse_url',
    {
      description:
        'Start parsing a remote URL through Knowhere and return immediately with the parse job. Poll with knowhere_async_get_job_status; completed tracked jobs are cached locally automatically.',
      inputSchema: {
        url: z.string().url(),
        namespace: z.string().optional(),
        localDocumentId: z.string().optional(),
        dataId: z.string().optional(),
        parsingParams: parsingParamsSchema,
      },
      outputSchema: objectOutputSchema,
    },
    async (input) =>
      createToolResult(
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
        'Start parsing a local file path available to this MCP process, upload it if needed, and return immediately with the parse job. Poll with knowhere_async_get_job_status; completed tracked jobs are cached locally automatically.',
      inputSchema: {
        file: z.string().describe('Local file path available to this MCP server process.'),
        fileName: z.string().optional(),
        namespace: z.string().optional(),
        localDocumentId: z.string().optional(),
        dataId: z.string().optional(),
        parsingParams: parsingParamsSchema,
      },
      outputSchema: objectOutputSchema,
    },
    async (input) =>
      createToolResult(
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

  server.registerTool(
    'knowhere_async_get_job_status',
    {
      description:
        'Fetch the current status for a Knowhere parse job. If the job was started by an async parse tool and is done, this also caches the result locally for outline/read/grep/search.',
      inputSchema: {
        jobId: z.string(),
      },
      outputSchema: objectOutputSchema,
    },
    async (input) => createToolResult(await knowledge.getJobStatus(input.jobId)),
  );

  server.registerTool(
    'knowhere_async_cache_job_result',
    {
      description:
        'Manually load a completed Knowhere parse job result and cache it locally. Usually not needed for jobs started by async parse tools because knowhere_async_get_job_status auto-caches them when done.',
      inputSchema: {
        jobId: z.string(),
        localDocumentId: z.string().optional(),
        verifyChecksum: z.boolean().optional(),
      },
      outputSchema: objectOutputSchema,
    },
    async (input) =>
      createToolResult(
        await knowledge.cacheJobResult({
          jobId: input.jobId,
          localDocumentId: input.localDocumentId,
          verifyChecksum: input.verifyChecksum,
        }),
      ),
  );

  server.registerTool(
    'knowhere_list_documents',
    {
      description: 'List parse results cached locally by this SDK-backed MCP server.',
      inputSchema: {},
      outputSchema: objectOutputSchema,
    },
    async () => createToolResult({ documents: await knowledge.listDocuments() }),
  );

  server.registerTool(
    'knowhere_get_document_outline',
    {
      description: 'Return the local outline for a cached parsed document.',
      inputSchema: {
        localDocumentId: z.string(),
      },
      outputSchema: objectOutputSchema,
    },
    async (input) => createToolResult(await knowledge.getDocumentOutline(input.localDocumentId)),
  );

  server.registerTool(
    'knowhere_read_chunks',
    {
      description: 'Read exact chunks from a cached local parse result.',
      inputSchema: {
        localDocumentId: z.string(),
        sectionPath: z.string().optional(),
        startChunk: z.number().int().positive().optional(),
        endChunk: z.number().int().positive().optional(),
        chunkId: z.string().optional(),
        chunkType: z.enum(['text', 'image', 'table']).optional(),
        limit: z.number().int().positive().optional(),
      },
      outputSchema: objectOutputSchema,
    },
    async (input) => createToolResult(await knowledge.readChunks(input)),
  );

  server.registerTool(
    'knowhere_grep_chunks',
    {
      description: 'Run grep-style literal or regex matching against cached local chunks.',
      inputSchema: {
        localDocumentId: z.string(),
        pattern: z.string(),
        isRegex: z.boolean().optional(),
        isCaseSensitive: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
        chunkType: z.enum(['text', 'image', 'table']).optional(),
        sectionPathPrefix: z.string().optional(),
        contextChars: z.number().int().nonnegative().optional(),
      },
      outputSchema: objectOutputSchema,
    },
    async (input) => createToolResult(await knowledge.grepChunks(input)),
  );

  server.registerTool(
    'knowhere_search',
    {
      description:
        'Search published Knowhere documents with the Knowhere API retrieval query. localDocumentIds only map returned server document IDs back to local cache IDs when available.',
      inputSchema: {
        query: z.string(),
        namespace: z.string().optional(),
        topK: z.number().int().positive().optional(),
        localDocumentIds: z.array(z.string()).optional(),
        useAgentic: z.boolean().optional(),
      },
      outputSchema: objectOutputSchema,
    },
    async (input) => createToolResult(await knowledge.search(input)),
  );

  return server;
}

export async function runKnowhereMcpServer(options?: KnowhereMcpServerOptions): Promise<void> {
  const server = await createKnowhereMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function createToolResult(result: ToolResult): {
  content: { type: 'text'; text: string }[];
  structuredContent: { result: ToolResult };
} {
  const structuredContent = { result };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
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
