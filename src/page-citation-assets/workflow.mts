import { createHash } from 'crypto';

import { Context, Data, Effect, Layer } from 'effect';

import { PageCitationAssetGenerationError, ValidationError } from '../errors/index.js';
import { createLocalKnowhereSdkStorage } from '../storage/local-storage.js';
import type {
  Chunk,
  DocumentPageCitationSource,
  KnowhereSdkStorage,
  KnowhereSdkStorageHead,
  KnowhereSdkStorageObject,
  KnowhereSdkStorageWriteResult,
  PageCitationAsset,
  PageCitationAssetCurrentIndex,
  PageCitationAssetIndex,
  PageCitationAssetMimeType,
  PageCitationAssetSource,
  PageCitationAssetsOptions,
  PageCitationAssetWarning,
  PageCitationAssetWarningCode,
  PageRenderer,
  ParseResult,
  RenderedPage,
  RenderPageInput,
} from '../types/index.js';

const DEFAULT_PAGE_CITATION_ASSET_LIMITS = {
  maxPagesToRenderPerRun: 25,
  totalMs: 120_000,
  sourceFetchMs: 30_000,
  pageRenderMs: 30_000,
  storageOperationMs: 15_000,
} as const;

const DEFAULT_VARIANT = 'default';
const DEFAULT_FORMAT: PageCitationAssetMimeType = 'image/png';
const DEFAULT_SCALE = 1;
const PAGE_ASSET_SOURCE: PageCitationAssetSource = 'client-rendered-pdf-page';
const MISSING_DOCUMENT_ID_MESSAGE: string =
  'documentId is required to generate page citation assets for page chunks.';

export type DocumentPageCitationSourceClient = {
  getPageCitationSource(documentId: string): Promise<DocumentPageCitationSource>;
};

export interface PageCitationWorkflowInput {
  result: ParseResult;
  options: PageCitationAssetsOptions;
  documents: DocumentPageCitationSourceClient;
  fallbackDocumentId?: string;
}

interface PageCitationWorkflowOutput {
  result: ParseResult;
  warnings: readonly PageCitationAssetWarning[];
}

interface NormalizedPageCitationOptions {
  storage: KnowhereSdkStorage;
  renderer?: PageRenderer;
  variant: string;
  format: PageCitationAssetMimeType;
  scale: number;
  quality?: number;
  strict: boolean;
  maxPagesToRenderPerRun: number;
  totalMs: number;
  sourceFetchMs: number;
  pageRenderMs: number;
  storageOperationMs: number;
}

interface PageRequest {
  pageNum: number;
  key: string;
  chunkIds: readonly string[];
}

interface PageAssetContext {
  documentId: string;
  namespace?: string;
  jobId: string;
  jobResultId?: string;
  variant: string;
  format: PageCitationAssetMimeType;
  scale: number;
}

interface SourceFile {
  source: DocumentPageCitationSource;
  body: Uint8Array;
}

type PageCitationSourceServiceShape = {
  readonly getSource: (
    documentId: string,
  ) => Effect.Effect<SourceFile, PageCitationSourceError>;
};

type PageCitationRendererServiceShape = {
  readonly renderPage: (
    input: RenderPageInput,
  ) => Effect.Effect<RenderedPage, PageCitationRenderError | PageCitationRendererUnavailableError>;
};

type PageCitationStorageServiceShape = {
  readonly headObject: (
    key: string,
  ) => Effect.Effect<KnowhereSdkStorageHead | null, PageCitationStorageError>;
  readonly writeObject: (
    input: KnowhereSdkStorageObject,
  ) => Effect.Effect<KnowhereSdkStorageWriteResult, PageCitationStorageError>;
  readonly getObjectUrl: (
    key: string,
  ) => Effect.Effect<string | undefined, PageCitationStorageError>;
};

class PageCitationSourceError extends Data.TaggedError('PageCitationSourceError')<{
  readonly operation: 'resolve_source' | 'fetch_source';
  readonly documentId: string;
  readonly cause: unknown;
}> {}

class PageCitationRenderError extends Data.TaggedError('PageCitationRenderError')<{
  readonly pageNum: number;
  readonly cause: unknown;
}> {}

class PageCitationStorageError extends Data.TaggedError('PageCitationStorageError')<{
  readonly operation: 'head' | 'write' | 'url';
  readonly key: string;
  readonly cause: unknown;
}> {}

class PageCitationRendererUnavailableError extends Data.TaggedError(
  'PageCitationRendererUnavailableError',
)<{
  readonly cause: unknown;
}> {}

class PageCitationSourceService extends Context.Service<
  PageCitationSourceService,
  PageCitationSourceServiceShape
>()('Knowhere/PageCitationSourceService') {}

class PageCitationRendererService extends Context.Service<
  PageCitationRendererService,
  PageCitationRendererServiceShape
>()('Knowhere/PageCitationRendererService') {}

class PageCitationStorageService extends Context.Service<
  PageCitationStorageService,
  PageCitationStorageServiceShape
>()('Knowhere/PageCitationStorageService') {}

export async function enrichParseResultWithPageCitationAssets(
  input: PageCitationWorkflowInput,
): Promise<ParseResult> {
  assertPageCitationAssetDocumentId(input);

  const options = normalizeOptions(input.options);
  const program = generatePageCitationAssets({
    ...input,
    options,
  }).pipe(
    Effect.provide([
      createSourceLayer(input.documents, options.sourceFetchMs),
      createRendererLayer(options),
      createStorageLayer(options.storage, options.storageOperationMs),
    ]),
  );

  const output = await runPromiseWithTimeout(
    () => Effect.runPromise(program),
    options.totalMs,
    'Page citation asset generation timed out',
  ).catch((error: unknown): PageCitationWorkflowOutput => {
    if (options.strict) {
      throw error;
    }

    return {
      result: input.result,
      warnings: [
        createWarning({
          code: 'render_failed',
          message: 'Page citation asset generation timed out or failed before completing.',
          documentId: input.result.documentId ?? input.fallbackDocumentId,
          jobId: input.result.jobId,
          cause: getErrorMessage(error),
        }),
      ],
    };
  });

  if (output.warnings.length > 0) {
    output.result.pageCitationAssetWarnings = output.warnings;
  }

  if (options.strict && output.warnings.length > 0) {
    throw new PageCitationAssetGenerationError(
      'Page citation asset generation failed in strict mode.',
      output.warnings,
    );
  }

  return output.result;
}

const generatePageCitationAssets = Effect.fn('Knowhere.generatePageCitationAssets')(
  function*(
    input: Omit<PageCitationWorkflowInput, 'options'> & {
      readonly options: NormalizedPageCitationOptions;
    },
  ) {
    const pageChunks: Array<Extract<Chunk, { type: 'page' }>> =
      input.result.chunks.filter(isPageChunk);
    if (pageChunks.length === 0) {
      return { result: input.result, warnings: [] };
    }

    const documentId: string | undefined = getPageCitationAssetDocumentId(
      input.result,
      input.fallbackDocumentId,
    );
    if (!documentId) {
      throw new ValidationError(MISSING_DOCUMENT_ID_MESSAGE);
    }

    const warnings: PageCitationAssetWarning[] = [];
    const context: PageAssetContext = {
      documentId,
      namespace: input.result.namespace,
      jobId: input.result.jobId,
      variant: input.options.variant,
      format: input.options.format,
      scale: input.options.scale,
    };
    const pageRequests = buildPageRequests(input.result.chunks, context, warnings);

    if (pageRequests.length === 0) {
      return { result: input.result, warnings };
    }

    const storage = yield* PageCitationStorageService;
    const assetByPageNum = new Map<number, PageCitationAsset>();
    const missingRequests: PageRequest[] = [];

    for (const request of pageRequests) {
      const cachedAsset = yield* readCachedAsset(storage, request, context);
      if (cachedAsset) {
        assetByPageNum.set(request.pageNum, cachedAsset);
      } else {
        missingRequests.push(request);
      }
    }

    const renderableRequests = missingRequests.slice(0, input.options.maxPagesToRenderPerRun);
    const skippedRequests = missingRequests.slice(input.options.maxPagesToRenderPerRun);
    for (const skipped of skippedRequests) {
      warnings.push(
        createWarning({
          code: 'render_limit_exceeded',
          message: `Page ${skipped.pageNum} was not rendered because maxPagesToRenderPerRun was reached.`,
          documentId,
          jobId: context.jobId,
          pageNum: skipped.pageNum,
          key: skipped.key,
        }),
      );
    }

    if (renderableRequests.length > 0) {
      const sourceResult = yield* resolveSourceFile(documentId).pipe(
        Effect.match({
          onFailure: (error) => {
            warnings.push(sourceErrorToWarning(error, context));
            return undefined;
          },
          onSuccess: (source) => source,
        }),
      );

      if (sourceResult) {
        context.namespace = sourceResult.source.namespace ?? context.namespace;
        context.jobResultId = sourceResult.source.jobResultId;
        yield* renderMissingAssets({
          sourceFile: sourceResult,
          pageRequests: renderableRequests,
          context,
          options: input.options,
          warnings,
          assetByPageNum,
        });
      }
    }

    const enrichedChunks = attachAssetsToChunks(input.result.chunks, assetByPageNum);
    input.result.chunks.splice(0, input.result.chunks.length, ...enrichedChunks);

    const concreteAssets = [...assetByPageNum.values()].sort(
      (left, right) => left.pageNum - right.pageNum,
    );
    if (concreteAssets.length > 0) {
      yield* writeAssetIndexes(storage, context, concreteAssets).pipe(
        Effect.match({
          onFailure: (error) => {
            warnings.push(storageErrorToWarning(error, 'index_write_failed', context));
            return undefined;
          },
          onSuccess: () => undefined,
        }),
      );
    }

    return {
      result: input.result,
      warnings,
    };
  },
);

function assertPageCitationAssetDocumentId(input: PageCitationWorkflowInput): void {
  if (!input.result.chunks.some(isPageChunk)) {
    return;
  }

  if (getPageCitationAssetDocumentId(input.result, input.fallbackDocumentId)) {
    return;
  }

  throw new ValidationError(MISSING_DOCUMENT_ID_MESSAGE);
}

function getPageCitationAssetDocumentId(
  result: ParseResult,
  fallbackDocumentId: string | undefined,
): string | undefined {
  return result.documentId ?? fallbackDocumentId;
}

function isPageChunk(chunk: Chunk): chunk is Extract<Chunk, { type: 'page' }> {
  return chunk.type === 'page';
}

const resolveSourceFile = Effect.fn('Knowhere.resolvePageCitationSource')(
  function*(documentId: string) {
    const source = yield* PageCitationSourceService;
    return yield* source.getSource(documentId);
  },
);

const renderMissingAssets = Effect.fn('Knowhere.renderMissingPageCitationAssets')(
  function*(input: {
    readonly sourceFile: SourceFile;
    readonly pageRequests: readonly PageRequest[];
    readonly context: PageAssetContext;
    readonly options: NormalizedPageCitationOptions;
    readonly warnings: PageCitationAssetWarning[];
    readonly assetByPageNum: Map<number, PageCitationAsset>;
  }) {
    const renderer = yield* PageCitationRendererService;
    const storage = yield* PageCitationStorageService;

    for (const request of input.pageRequests) {
      const rendered = yield* renderer
        .renderPage({
          source: input.sourceFile.body,
          pageNum: request.pageNum,
          format: input.options.format,
          scale: input.options.scale,
          quality: input.options.quality,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => {
              input.warnings.push(renderErrorToWarning(error, request, input.context));
              return undefined;
            },
            onSuccess: (page) => page,
          }),
        );

      if (!rendered) {
        continue;
      }

      const asset = yield* writeRenderedPage(storage, request, rendered, input.context).pipe(
        Effect.match({
          onFailure: (error) => {
            input.warnings.push(storageErrorToWarning(error, 'storage_failed', input.context));
            return undefined;
          },
          onSuccess: (writtenAsset) => writtenAsset,
        }),
      );

      if (asset) {
        input.assetByPageNum.set(request.pageNum, asset);
      }
    }
  },
);

function createSourceLayer(
  documents: DocumentPageCitationSourceClient,
  sourceFetchTimeoutMs: number,
): Layer.Layer<PageCitationSourceService> {
  return Layer.succeed(PageCitationSourceService, {
    getSource: Effect.fn('PageCitationSourceService.getSource')(function*(documentId: string) {
      const source = yield* Effect.tryPromise({
        try: () =>
          runPromiseWithTimeout(
            () => documents.getPageCitationSource(documentId),
            sourceFetchTimeoutMs,
            `Timed out resolving page citation source for document ${documentId}`,
          ),
        catch: (cause) =>
          new PageCitationSourceError({
            operation: 'resolve_source',
            documentId,
            cause,
          }),
      });

      const body = yield* Effect.tryPromise({
        try: () => fetchSourceBytes(source.url, sourceFetchTimeoutMs),
        catch: (cause) =>
          new PageCitationSourceError({
            operation: 'fetch_source',
            documentId,
            cause,
          }),
      });

      return { source, body };
    }),
  });
}

function createRendererLayer(
  options: NormalizedPageCitationOptions,
): Layer.Layer<PageCitationRendererService> {
  let cachedRenderer: PageRenderer | undefined = options.renderer;

  return Layer.succeed(PageCitationRendererService, {
    renderPage: Effect.fn('PageCitationRendererService.renderPage')(
      function*(input: RenderPageInput) {
        const renderer = yield* Effect.tryPromise({
          try: async () => {
            cachedRenderer ??= await createDefaultPageRenderer();
            return cachedRenderer;
          },
          catch: (cause) => new PageCitationRendererUnavailableError({ cause }),
        });

        return yield* Effect.tryPromise({
          try: () =>
            runPromiseWithTimeout(
              () => renderer.renderPage(input),
              options.pageRenderMs,
              `Timed out rendering PDF page ${input.pageNum}`,
            ),
          catch: (cause) =>
            new PageCitationRenderError({
              pageNum: input.pageNum,
              cause,
            }),
        });
      },
    ),
  });
}

function createStorageLayer(
  storage: KnowhereSdkStorage,
  storageOperationTimeoutMs: number,
): Layer.Layer<PageCitationStorageService> {
  return Layer.succeed(PageCitationStorageService, {
    headObject: Effect.fn('PageCitationStorageService.headObject')(function*(key: string) {
      return yield* Effect.tryPromise({
        try: () =>
          runPromiseWithTimeout(
            () => storage.headObject(key),
            storageOperationTimeoutMs,
            `Timed out reading storage metadata for ${key}`,
          ),
        catch: (cause) =>
          new PageCitationStorageError({
            operation: 'head',
            key,
            cause,
          }),
      });
    }),
    writeObject: Effect.fn('PageCitationStorageService.writeObject')(
      function*(input: KnowhereSdkStorageObject) {
        return yield* Effect.tryPromise({
          try: () =>
            runPromiseWithTimeout(
              () => storage.writeObject(input),
              storageOperationTimeoutMs,
              `Timed out writing storage object ${input.key}`,
            ),
          catch: (cause) =>
            new PageCitationStorageError({
              operation: 'write',
              key: input.key,
              cause,
            }),
        });
      },
    ),
    getObjectUrl: Effect.fn('PageCitationStorageService.getObjectUrl')(function*(key: string) {
      if (!storage.getObjectUrl) {
        return undefined;
      }

      return yield* Effect.tryPromise({
        try: () =>
          runPromiseWithTimeout(
            () => storage.getObjectUrl?.(key) ?? Promise.resolve(null),
            storageOperationTimeoutMs,
            `Timed out resolving storage URL for ${key}`,
          ),
        catch: (cause) =>
          new PageCitationStorageError({
            operation: 'url',
            key,
            cause,
          }),
      }).pipe(Effect.map((url) => url ?? undefined));
    }),
  });
}

function normalizeOptions(options: PageCitationAssetsOptions): NormalizedPageCitationOptions {
  return {
    storage: options.storage ?? createLocalKnowhereSdkStorage(),
    renderer: options.renderer,
    variant: options.variant ?? DEFAULT_VARIANT,
    format: options.format ?? DEFAULT_FORMAT,
    scale: options.scale ?? DEFAULT_SCALE,
    quality: options.quality,
    strict: options.strict ?? false,
    maxPagesToRenderPerRun:
      options.maxPagesToRenderPerRun ?? DEFAULT_PAGE_CITATION_ASSET_LIMITS.maxPagesToRenderPerRun,
    totalMs: options.timeouts?.totalMs ?? DEFAULT_PAGE_CITATION_ASSET_LIMITS.totalMs,
    sourceFetchMs:
      options.timeouts?.sourceFetchMs ?? DEFAULT_PAGE_CITATION_ASSET_LIMITS.sourceFetchMs,
    pageRenderMs:
      options.timeouts?.pageRenderMs ?? DEFAULT_PAGE_CITATION_ASSET_LIMITS.pageRenderMs,
    storageOperationMs:
      options.timeouts?.storageOperationMs ??
      DEFAULT_PAGE_CITATION_ASSET_LIMITS.storageOperationMs,
  };
}

function buildPageRequests(
  chunks: readonly Chunk[],
  context: PageAssetContext,
  warnings: PageCitationAssetWarning[],
): PageRequest[] {
  const chunkIdsByPageNum = new Map<number, string[]>();

  for (const chunk of chunks) {
    if (chunk.type !== 'page') {
      continue;
    }

    const pageNumbers = getChunkPageNumbers(chunk.metadata);
    if (pageNumbers.invalidCount > 0) {
      warnings.push(
        createWarning({
          code: 'invalid_page_number',
          message: `${pageNumbers.invalidCount} invalid page number value(s) were ignored.`,
          documentId: context.documentId,
          jobId: context.jobId,
          chunkId: chunk.chunkId,
        }),
      );
    }

    for (const pageNum of pageNumbers.validPageNumbers) {
      const chunkIds = chunkIdsByPageNum.get(pageNum) ?? [];
      chunkIds.push(chunk.chunkId);
      chunkIdsByPageNum.set(pageNum, chunkIds);
    }
  }

  return [...chunkIdsByPageNum.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pageNum, chunkIds]) => ({
      pageNum,
      chunkIds,
      key: createPageAssetKey(context, pageNum),
    }));
}

function getChunkPageNumbers(metadata: Record<string, unknown>): {
  validPageNumbers: readonly number[];
  invalidCount: number;
} {
  const values = [metadata.pageNums, metadata.page_nums].filter(isReadonlyUnknownArray);
  const validPageNumbers = new Set<number>();
  let invalidCount = 0;

  for (const value of values) {
    for (const pageNum of value) {
      if (typeof pageNum === 'number' && Number.isInteger(pageNum) && pageNum > 0) {
        validPageNumbers.add(pageNum);
      } else {
        invalidCount += 1;
      }
    }
  }

  return {
    validPageNumbers: [...validPageNumbers].sort((left, right) => left - right),
    invalidCount,
  };
}

function isReadonlyUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

const readCachedAsset = Effect.fn('Knowhere.readCachedPageCitationAsset')(
  function*(
    storage: PageCitationStorageServiceShape,
    request: PageRequest,
    context: PageAssetContext,
  ) {
    const head = yield* storage.headObject(request.key).pipe(
      Effect.match({
        onFailure: () => null,
        onSuccess: (metadata) => metadata,
      }),
    );

    if (!head) {
      return undefined;
    }

    const metadata = head.metadata ?? {};
    const width = readPositiveInteger(metadata.width);
    const height = readPositiveInteger(metadata.height);
    const mimeType = normalizeMimeType(metadata.mimeType ?? head.contentType);

    if (!width || !height || !mimeType) {
      return undefined;
    }

    const assetUrl = yield* storage.getObjectUrl(request.key).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (url) => url,
      }),
    );

    return {
      pageNum: request.pageNum,
      key: request.key,
      assetUrl,
      mimeType,
      width,
      height,
      source: PAGE_ASSET_SOURCE,
      variant: context.variant,
    };
  },
);

const writeRenderedPage = Effect.fn('Knowhere.writeRenderedPageCitationAsset')(
  function*(
    storage: PageCitationStorageServiceShape,
    request: PageRequest,
    rendered: RenderedPage,
    context: PageAssetContext,
  ) {
    const writeResult = yield* storage.writeObject({
      key: request.key,
      body: rendered.body,
      contentType: rendered.mimeType,
      metadata: {
        pageNum: String(request.pageNum),
        width: String(rendered.width),
        height: String(rendered.height),
        mimeType: rendered.mimeType,
        source: PAGE_ASSET_SOURCE,
        variant: context.variant,
        documentId: context.documentId,
        jobId: context.jobId,
      },
    });
    const assetUrl =
      writeResult.url ??
      (yield* storage.getObjectUrl(request.key).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (url) => url,
        }),
      ));

    return {
      pageNum: request.pageNum,
      key: request.key,
      assetUrl,
      mimeType: rendered.mimeType,
      width: rendered.width,
      height: rendered.height,
      source: PAGE_ASSET_SOURCE,
      variant: context.variant,
    };
  },
);

function writeAssetIndexes(
  storage: PageCitationStorageServiceShape,
  context: PageAssetContext,
  assets: readonly PageCitationAsset[],
): Effect.Effect<void, PageCitationStorageError> {
  const generatedAt = new Date().toISOString();
  const indexKey = createPageAssetIndexKey(context);
  const currentKey = createPageAssetCurrentIndexKey(context);
  const index: PageCitationAssetIndex = {
    version: 1,
    documentId: context.documentId,
    namespace: context.namespace,
    jobId: context.jobId,
    jobResultId: context.jobResultId,
    variant: context.variant,
    generatedAt,
    assets,
  };
  const current: PageCitationAssetCurrentIndex = {
    version: 1,
    documentId: context.documentId,
    namespace: context.namespace,
    jobId: context.jobId,
    jobResultId: context.jobResultId,
    variant: context.variant,
    indexKey,
    updatedAt: generatedAt,
  };

  return Effect.gen(function*() {
    yield* storage.writeObject({
      key: indexKey,
      body: Buffer.from(JSON.stringify(index, null, 2)),
      contentType: 'application/json',
      metadata: {
        documentId: context.documentId,
        jobId: context.jobId,
        variant: context.variant,
      },
    });
    yield* storage.writeObject({
      key: currentKey,
      body: Buffer.from(JSON.stringify(current, null, 2)),
      contentType: 'application/json',
      metadata: {
        documentId: context.documentId,
        jobId: context.jobId,
        variant: context.variant,
      },
    });
  });
}

function attachAssetsToChunks(
  chunks: readonly Chunk[],
  assetByPageNum: ReadonlyMap<number, PageCitationAsset>,
): Chunk[] {
  return chunks.map((chunk) => {
    if (chunk.type !== 'page') {
      return chunk;
    }

    const assets = getChunkPageNumbers(chunk.metadata).validPageNumbers
      .map((pageNum) => assetByPageNum.get(pageNum))
      .filter((asset): asset is PageCitationAsset => asset !== undefined);

    if (assets.length === 0) {
      return chunk;
    }

    return {
      ...chunk,
      pageAssets: assets,
    };
  });
}

function createPageAssetKey(context: PageAssetContext, pageNum: number): string {
  const extension = context.format === 'image/png' ? 'png' : 'jpg';
  return [
    'page-citation-assets',
    'documents',
    toSafeKeySegment(context.documentId),
    'jobs',
    toSafeKeySegment(context.jobId),
    'variants',
    toSafeKeySegment(context.variant),
    `scale-${toSafeKeySegment(String(context.scale))}`,
    `page-${String(pageNum).padStart(6, '0')}.${extension}`,
  ].join('/');
}

function createPageAssetIndexKey(context: PageAssetContext): string {
  return [
    'page-citation-assets',
    'documents',
    toSafeKeySegment(context.documentId),
    'jobs',
    toSafeKeySegment(context.jobId),
    'variants',
    toSafeKeySegment(context.variant),
    'index.json',
  ].join('/');
}

function createPageAssetCurrentIndexKey(context: PageAssetContext): string {
  return [
    'page-citation-assets',
    'documents',
    toSafeKeySegment(context.documentId),
    'current.json',
  ].join('/');
}

function toSafeKeySegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized.length > 0 && normalized === value) {
    return normalized;
  }

  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${(normalized || 'value').slice(0, 48)}-${hash}`;
}

async function createDefaultPageRenderer(): Promise<PageRenderer> {
  const rendererModule = await import('../page-renderer-pdfjs.js');
  return rendererModule.createPdfJsPageRenderer();
}

async function fetchSourceBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Source fetch failed with HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function createWarning(params: {
  code: PageCitationAssetWarningCode;
  message: string;
  documentId?: string;
  jobId?: string;
  chunkId?: string;
  pageNum?: number;
  key?: string;
  cause?: string;
}): PageCitationAssetWarning {
  return {
    code: params.code,
    message: params.message,
    documentId: params.documentId,
    jobId: params.jobId,
    chunkId: params.chunkId,
    pageNum: params.pageNum,
    key: params.key,
    cause: params.cause,
  };
}

function sourceErrorToWarning(
  error: PageCitationSourceError,
  context: PageAssetContext,
): PageCitationAssetWarning {
  return createWarning({
    code: 'source_fetch_failed',
    message: `Unable to ${error.operation === 'resolve_source' ? 'resolve' : 'fetch'} page citation source.`,
    documentId: context.documentId,
    jobId: context.jobId,
    cause: getErrorMessage(error.cause),
  });
}

function renderErrorToWarning(
  error: PageCitationRenderError | PageCitationRendererUnavailableError,
  request: PageRequest,
  context: PageAssetContext,
): PageCitationAssetWarning {
  if (error._tag === 'PageCitationRendererUnavailableError') {
    return createWarning({
      code: 'renderer_unavailable',
      message: 'The page citation renderer could not be loaded.',
      documentId: context.documentId,
      jobId: context.jobId,
      pageNum: request.pageNum,
      key: request.key,
      cause: getErrorMessage(error.cause),
    });
  }

  return createWarning({
    code: 'render_failed',
    message: `Unable to render PDF page ${request.pageNum}.`,
    documentId: context.documentId,
    jobId: context.jobId,
    pageNum: request.pageNum,
    key: request.key,
    cause: getErrorMessage(error.cause),
  });
}

function storageErrorToWarning(
  error: PageCitationStorageError,
  code: 'storage_failed' | 'index_write_failed',
  context: PageAssetContext,
): PageCitationAssetWarning {
  return createWarning({
    code,
    message:
      code === 'index_write_failed'
        ? 'Unable to write the page citation asset index.'
        : `Unable to ${error.operation} page citation asset storage object.`,
    documentId: context.documentId,
    jobId: context.jobId,
    key: error.key,
    cause: getErrorMessage(error.cause),
  });
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeMimeType(value: string | undefined): PageCitationAssetMimeType | undefined {
  if (value === 'image/png' || value === 'image/jpeg') {
    return value;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function runPromiseWithTimeout<T>(
  promiseFactory: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    void promiseFactory()
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}
