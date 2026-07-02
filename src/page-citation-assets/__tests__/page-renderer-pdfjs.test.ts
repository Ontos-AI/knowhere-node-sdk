import { readFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { createPdfJsPageRenderer } from '../../page-renderer-pdfjs.js';

describe('createPdfJsPageRenderer', () => {
  it('renders a tiny PDF fixture page to PNG', async () => {
    const renderer = createPdfJsPageRenderer();
    const source = await readFile(
      path.join(process.cwd(), 'src', 'page-citation-assets', '__fixtures__', 'tiny.pdf'),
    );

    const rendered = await renderer.renderPage({
      source,
      pageNum: 1,
      format: 'image/png',
      scale: 1,
    });

    expect(rendered.mimeType).toBe('image/png');
    expect(rendered.width).toBeGreaterThan(0);
    expect(rendered.height).toBeGreaterThan(0);
    expect(Buffer.from(rendered.body).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
