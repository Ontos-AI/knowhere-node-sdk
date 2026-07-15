import path from 'path';
import type { ReadStream } from 'fs';

import type { KnowhereOptions } from './types/client.js';
import type { CreateJobParams, ParseParams } from './types/params.js';
import type { Job } from './types/job.js';
import type { ParseResult } from './types/result.js';
import { HttpClient } from './lib/http-client.js';
import { Jobs } from './resources/jobs.js';
import { Retrieval } from './resources/retrieval.js';
import { Documents } from './resources/documents.js';
import { Knowledge } from './knowledge/index.js';
import { DEFAULT_BASE_URL, ENV } from './constants.js';
import { ValidationError } from './errors/index.js';
import { enrichParseResult } from './lib/utils.js';
import { storeParseResultAssets } from './storage/asset-storage.js';

function inferFileName(file: ParseParams['file'], explicitFileName?: string): string | undefined {
  if (explicitFileName) {
    return explicitFileName;
  }

  if (typeof file === 'string') {
    return path.basename(file);
  }

  if (isReadStream(file) && typeof file.path === 'string') {
    return path.basename(file.path);
  }

  return undefined;
}

function isReadStream(file: ParseParams['file']): file is ReadStream {
  return (
    typeof file === 'object' && file !== null && 'pipe' in file && typeof file.pipe === 'function'
  );
}

function buildParsingParams(params: ParseParams): CreateJobParams['parsingParams'] {
  const parsingParams = {
    model: params.model,
    ocrEnabled: params.ocr,
    docType: params.docType,
    smartTitleParse: params.smartTitleParse,
    summaryImage: params.summaryImage,
    summaryTable: params.summaryTable,
    summaryTxt: params.summaryTxt,
    addFragDesc: params.addFragDesc,
    kbDir: params.kbDir,
  };

  Object.keys(parsingParams).forEach((key) => {
    if (parsingParams[key as keyof typeof parsingParams] === undefined) {
      delete parsingParams[key as keyof typeof parsingParams];
    }
  });

  return Object.keys(parsingParams).length > 0 ? parsingParams : undefined;
}

/**
 * Main Knowhere SDK client
 */
export class Knowhere {
  /** Jobs resource for low-level API */
  public readonly jobs: Jobs;
  /** Retrieval resource for querying published documents */
  public readonly retrieval: Retrieval;
  /** Documents resource for canonical document lifecycle operations */
  public readonly documents: Documents;
  /** Client-side local knowledge tools over parsed Knowhere results */
  public readonly knowledge: Knowledge;

  private httpClient: HttpClient;

  /**
   * Create a new Knowhere client
   */
  constructor(options: KnowhereOptions = {}) {
    // Resolve API authentication
    const apiKey = options.apiKey ?? process.env[ENV.API_KEY];
    const authTokenProvider = apiKey ? undefined : options.authTokenProvider;
    if (!apiKey && !authTokenProvider) {
      throw new ValidationError(
        `API authentication is required. Provide it via options.apiKey, options.authTokenProvider, or ${ENV.API_KEY} environment variable.`,
      );
    }

    // Resolve base URL
    const baseURL = options.baseURL ?? process.env[ENV.BASE_URL] ?? DEFAULT_BASE_URL;

    // Create HTTP client
    this.httpClient = new HttpClient({
      baseURL,
      apiKey,
      authTokenProvider,
      timeout: options.timeout,
      uploadTimeout: options.uploadTimeout,
      maxRetries: options.maxRetries,
      defaultHeaders: options.defaultHeaders,
      httpAgent: options.httpAgent,
      httpsAgent: options.httpsAgent,
    });

    // Initialize resources
    this.jobs = new Jobs(this.httpClient);
    this.retrieval = new Retrieval(this.httpClient);
    this.documents = new Documents(this.httpClient);
    this.knowledge = new Knowledge(this);
  }

  /**
   * High-level API: Parse a document and return structured results
   *
   * @example
   * ```typescript
   * // Parse from URL
   * const result = await client.parse({ url: 'https://example.com/doc.pdf' });
   *
   * // Parse from file
   * const result = await client.parse({ file: './document.pdf' });
   *
   * // Parse with options
   * const result = await client.parse({
   *   url: 'https://example.com/doc.pdf',
   *   model: 'advanced',
   *   ocr: true,
   *   onUploadProgress: (p) => console.log(`${p.percent}%`),
   * });
   * ```
   */
  async parse(params: ParseParams): Promise<ParseResult> {
    const job = await this.startParse(params);

    // Wait for completion
    const jobResult = await this.jobs.wait(job.jobId, {
      pollInterval: params.pollInterval,
      pollTimeout: params.pollTimeout,
      onProgress: params.onPollProgress,
      signal: params.signal,
    });

    // Load result
    const result = await this.jobs.load(jobResult, {
      verifyChecksum: params.verifyChecksum,
    });

    const enrichedResult = enrichParseResult(result, {
      namespace: jobResult.namespace,
      documentId: jobResult.documentId ?? params.documentId,
    });

    const storedResult = await storeParseResultAssets(enrichedResult, params.storageAdapter);
    return storedResult.result;
  }

  /**
   * Start a parse job and return immediately after the URL job is created or
   * the local file is uploaded. Use jobs.get()/jobs.wait() and jobs.load()
   * to inspect completion and load results later.
   */
  async startParse(params: ParseParams): Promise<Job> {
    // Validate params
    if (!params.url && !params.file) {
      throw new ValidationError('Either url or file must be provided');
    }

    if (params.url && params.file) {
      throw new ValidationError('Only one of url or file can be provided');
    }

    // Determine source type
    const sourceType = params.url ? 'url' : 'file';
    const resolvedFileName = inferFileName(params.file, params.fileName);

    if (params.file && !resolvedFileName) {
      throw new ValidationError(
        'fileName is required when file is a Buffer, Uint8Array, or stream without a path.',
      );
    }

    // Build webhook config
    const webhook = params.webhook;

    // Create job
    const job = await this.jobs.create({
      sourceType,
      sourceUrl: params.url,
      fileName: resolvedFileName,
      dataId: params.dataId,
      namespace: params.namespace,
      documentId: params.documentId,
      documentMetadata: params.documentMetadata,
      parsingParams: buildParsingParams(params),
      llmConfig: params.llmConfig,
      webhook,
    });

    // Upload file if needed
    if (params.file) {
      await this.jobs.upload(job, {
        file: params.file,
        onProgress: params.onUploadProgress,
        signal: params.signal,
      });
    }

    return job;
  }
}

// Export as default
export default Knowhere;
