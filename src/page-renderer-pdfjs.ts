import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';

import Piscina from 'piscina';

import type { RenderedPage, RenderPageInput } from './types/index.js';

const DEFAULT_BACKGROUND: string = 'rgb(255,255,255)';
const DEFAULT_MAX_THREADS: number = 1;
const DEFAULT_IDLE_TIMEOUT_MS: number = 30_000;
const DEFAULT_CONCURRENT_TASKS_PER_WORKER: number = 1;
const PACKAGE_RENDERER_SUBPATH: string = '@ontos-ai/knowhere-sdk/page-renderer-pdfjs';
const WORKER_BASENAME: string = 'page-renderer-pdfjs-worker';
const WORKER_TASK_NAME: string = 'renderPage';

interface PdfJsPageRenderTaskInput {
  source: Uint8Array;
  pageNum: number;
  format: 'image/png' | 'image/jpeg';
  scale: number;
  background: string;
  quality?: number;
}

export interface PdfJsPageRenderer {
  renderPage(input: RenderPageInput): Promise<RenderedPage>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

export interface PdfJsPageRendererOptions {
  background?: string;
  maxThreads?: number;
  idleTimeoutMs?: number;
  workerFile?: string | URL;
}

export function createPdfJsPageRenderer(
  options: PdfJsPageRendererOptions = {},
): PdfJsPageRenderer {
  const background: string = options.background ?? DEFAULT_BACKGROUND;
  const pool: Piscina<PdfJsPageRenderTaskInput, RenderedPage> = createWorkerPool(options);

  return {
    async renderPage(input: RenderPageInput): Promise<RenderedPage> {
      throwIfAborted(input.signal);
      const taskInput: PdfJsPageRenderTaskInput = {
        source: new Uint8Array(input.source),
        pageNum: input.pageNum,
        format: input.format,
        scale: input.scale,
        background,
        quality: input.quality,
      };

      if (input.signal) {
        return pool.run(taskInput, { signal: input.signal });
      }

      return pool.run(taskInput);
    },

    close(): Promise<void> {
      return pool.close();
    },

    destroy(): Promise<void> {
      return pool.destroy();
    },
  };
}

function createWorkerPool(
  options: PdfJsPageRendererOptions,
): Piscina<PdfJsPageRenderTaskInput, RenderedPage> {
  return new Piscina<PdfJsPageRenderTaskInput, RenderedPage>({
    filename: resolveWorkerFilename(options.workerFile),
    name: WORKER_TASK_NAME,
    minThreads: 0,
    maxThreads: normalizeMaxThreads(options.maxThreads),
    idleTimeout: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    concurrentTasksPerWorker: DEFAULT_CONCURRENT_TASKS_PER_WORKER,
  });
}

function normalizeMaxThreads(maxThreads: number | undefined): number {
  if (maxThreads === undefined) {
    return DEFAULT_MAX_THREADS;
  }

  return Math.max(1, Math.min(2, Math.floor(maxThreads)));
}

function resolveWorkerFilename(workerFile: string | URL | undefined): string {
  if (workerFile instanceof URL) {
    return workerFile.href;
  }

  if (workerFile) {
    return workerFile;
  }

  const bundledWorkerFilename: string | undefined = resolveBundledWorkerFilename();
  if (bundledWorkerFilename) {
    return bundledWorkerFilename;
  }

  const sourceWorkerPath: string = path.resolve(process.cwd(), 'src', `${WORKER_BASENAME}.ts`);
  if (existsSync(sourceWorkerPath)) {
    return pathToFileURL(sourceWorkerPath).href;
  }

  throw new Error('Unable to resolve the PDF.js page renderer worker file.');
}

function resolveBundledWorkerFilename(): string | undefined {
  try {
    const projectRequire: NodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const rendererFilename: string = projectRequire.resolve(PACKAGE_RENDERER_SUBPATH);
    const workerFilename: string = path.join(
      path.dirname(rendererFilename),
      `${WORKER_BASENAME}.js`,
    );
    return existsSync(workerFilename) ? pathToFileURL(workerFilename).href : undefined;
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('PDF page render aborted');
  }
}
