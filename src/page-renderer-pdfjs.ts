import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

import type { PageRenderer, RenderedPage, RenderPageInput } from './types/index.js';

interface PdfJsModule {
  getDocument(params: PdfDocumentInitParameters): PdfLoadingTask;
}

interface PdfDocumentInitParameters {
  data: Uint8Array;
  useSystemFonts: boolean;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfDocument {
  getPage(pageNum: number): Promise<PdfPage>;
  cleanup(): Promise<unknown>;
}

interface PdfPage {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: PdfRenderParameters): PdfRenderTask;
  cleanup(): void;
}

interface PdfViewport {
  width: number;
  height: number;
}

interface PdfRenderParameters {
  canvas: null;
  canvasContext: object;
  viewport: PdfViewport;
  background: string;
}

interface PdfRenderTask {
  promise: Promise<void>;
}

export interface PdfJsPageRendererOptions {
  background?: string;
}

export function createPdfJsPageRenderer(options: PdfJsPageRendererOptions = {}): PageRenderer {
  const background = options.background ?? 'rgb(255,255,255)';

  return {
    async renderPage(input: RenderPageInput): Promise<RenderedPage> {
      throwIfAborted(input.signal);
      const pdfjs = await loadPdfJsModule();
      const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(input.source),
        useSystemFonts: true,
      });
      const document = await loadingTask.promise;

      try {
        throwIfAborted(input.signal);
        const page = await document.getPage(input.pageNum);
        const viewport = page.getViewport({ scale: input.scale });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');

        throwIfAborted(input.signal);
        await page.render({
          canvas: null,
          canvasContext: context,
          viewport,
          background,
        }).promise;
        page.cleanup();

        const body =
          input.format === 'image/png'
            ? canvas.toBuffer('image/png')
            : canvas.toBuffer('image/jpeg', input.quality);

        return {
          body,
          mimeType: input.format,
          width,
          height,
        };
      } finally {
        await document.cleanup();
        await loadingTask.destroy();
      }
    },
  };
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  installPdfJsDomPolyfills();
  const importedModule: unknown = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (isPdfJsModule(importedModule)) {
    return importedModule;
  }

  throw new Error('pdfjs-dist/build/pdf.mjs did not expose getDocument');
}

function installPdfJsDomPolyfills(): void {
  installGlobalValue('DOMMatrix', DOMMatrix);
  installGlobalValue('ImageData', ImageData);
  installGlobalValue('Path2D', Path2D);
}

function installGlobalValue(name: string, value: unknown): void {
  if (name in globalThis) {
    return;
  }

  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function isPdfJsModule(value: unknown): value is PdfJsModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getDocument' in value &&
    typeof value.getDocument === 'function'
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('PDF page render aborted');
  }
}
