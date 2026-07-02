import { Canvas, createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

interface PdfJsPageRenderTaskInput {
  source: Uint8Array;
  pageNum: number;
  format: 'image/png' | 'image/jpeg';
  scale: number;
  background: string;
  quality?: number;
}

interface PdfJsPageRenderTaskOutput {
  body: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

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

export async function renderPage(
  input: PdfJsPageRenderTaskInput,
): Promise<PdfJsPageRenderTaskOutput> {
  const pdfjs: PdfJsModule = await loadPdfJsModule();
  const loadingTask: PdfLoadingTask = pdfjs.getDocument({
    data: new Uint8Array(input.source),
    useSystemFonts: true,
  });
  const document: PdfDocument = await loadingTask.promise;

  try {
    const page: PdfPage = await document.getPage(input.pageNum);
    const viewport: PdfViewport = page.getViewport({ scale: input.scale });
    const width: number = Math.ceil(viewport.width);
    const height: number = Math.ceil(viewport.height);
    const canvas: Canvas = createCanvas(width, height);
    const context: object = canvas.getContext('2d');

    await page.render({
      canvas: null,
      canvasContext: context,
      viewport,
      background: input.background,
    }).promise;
    page.cleanup();

    const body: Uint8Array =
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
