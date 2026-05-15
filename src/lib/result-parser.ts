import JSZip from 'jszip';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { HttpClient } from './http-client.js';
import type {
  ParseResult,
  Manifest,
  Chunk,
  TextChunk,
  ImageChunk,
  TableChunk,
  Statistics,
  SlimChunk,
  DocNav,
} from '../types/result.js';
import type { LoadOptions } from '../types/params.js';
import { ChecksumError, KnowhereError } from '../errors/index.js';
import { sanitizePath, getFileExtension, parseDates, keysToCamel } from './utils.js';

type RawChunk = {
  chunkId?: string;
  type?: string;
  content?: string;
  path?: string;
  filePath?: string;
  metadata?: Record<string, unknown>;
};

type ChunkPayload = RawChunk[] | { chunks?: RawChunk[] };
type SlimChunkPayload = SlimChunk[] | { chunks?: SlimChunk[] };

/**
 * Parse result ZIP from URL
 */
export async function parseResult(
  httpClient: HttpClient,
  resultUrl: string,
  options?: LoadOptions,
): Promise<ParseResult> {
  // Download ZIP
  const zipBuffer = await httpClient.download(resultUrl);

  // Verify checksum if requested
  if (options?.verifyChecksum !== false) {
    // Note: Checksum verification would require the expected checksum from the API
    // For now, we'll skip this but keep the structure
  }

  // Parse ZIP
  const zip = await JSZip.loadAsync(zipBuffer);

  // Extract manifest
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new KnowhereError('manifest.json not found in ZIP');
  }

  const manifestContent = await manifestFile.async('string');
  let manifest = JSON.parse(manifestContent) as Manifest;
  manifest = keysToCamel(manifest);
  manifest = parseDates(manifest);

  // Extract chunks
  const chunksFile = zip.file('chunks.json');
  if (!chunksFile) {
    throw new KnowhereError('chunks.json not found in ZIP');
  }

  const chunksContent = await chunksFile.async('string');
  let chunksData = JSON.parse(chunksContent) as ChunkPayload;
  chunksData = keysToCamel(chunksData);
  const rawChunks = extractChunks(chunksData);

  // Process chunks and load associated files
  const chunks: Chunk[] = [];

  for (const chunkData of rawChunks) {
    const chunk = await processChunk(zip, chunkData);
    chunks.push(chunk);
  }

  // Extract optional files
  let fullMarkdown: string | undefined;
  const fullMdFile = zip.file('full.md');
  if (fullMdFile) {
    fullMarkdown = await fullMdFile.async('string');
  }

  // DocNav (current worker output)
  let docNav: DocNav | undefined;
  const docNavFile = zip.file('doc_nav.json');
  if (docNavFile) {
    const docNavContent = await docNavFile.async('string');
    const rawDocNav: unknown = JSON.parse(docNavContent);
    docNav = keysToCamel<DocNav>(rawDocNav);
  }

  let hierarchy: unknown;
  const hierarchyFile = zip.file('hierarchy.json');
  if (hierarchyFile) {
    const hierarchyContent = await hierarchyFile.async('string');
    hierarchy = JSON.parse(hierarchyContent);
  }

  let chunksSlim: SlimChunk[] | undefined;
  const chunksSlimFile = zip.file('chunks_slim.json');
  if (chunksSlimFile) {
    const chunksSlimContent = await chunksSlimFile.async('string');
    let chunksSlimData = JSON.parse(chunksSlimContent) as SlimChunkPayload;
    chunksSlimData = keysToCamel(chunksSlimData);
    chunksSlim = extractSlimChunks(chunksSlimData);
  }

  let tocHierarchies: unknown;
  const tocHierarchiesFile = zip.file('toc_hierarchies.json');
  if (tocHierarchiesFile) {
    const tocHierarchiesContent = await tocHierarchiesFile.async('string');
    tocHierarchies = keysToCamel(JSON.parse(tocHierarchiesContent));
  }

  let kbCsv: string | undefined;
  const kbCsvFile = zip.file('kb.csv');
  if (kbCsvFile) {
    kbCsv = await kbCsvFile.async('string');
  }

  let hierarchyViewHtml: string | undefined;
  const hierarchyViewFile = zip.file('hierarchy_view.html');
  if (hierarchyViewFile) {
    hierarchyViewHtml = await hierarchyViewFile.async('string');
  }

  // Create result object
  const result: ParseResult = {
    manifest,
    chunks,
    docNav,
    fullMarkdown,
    rawZip: zipBuffer,
    // Legacy
    chunksSlim,
    hierarchy,
    tocHierarchies,
    kbCsv,
    hierarchyViewHtml,

    get textChunks(): TextChunk[] {
      return chunks.filter((c): c is TextChunk => c.type === 'text');
    },

    get imageChunks(): ImageChunk[] {
      return chunks.filter((c): c is ImageChunk => c.type === 'image');
    },

    get tableChunks(): TableChunk[] {
      return chunks.filter((c): c is TableChunk => c.type === 'table');
    },

    get jobId(): string {
      return manifest.jobId;
    },

    get statistics(): Statistics {
      return manifest.statistics;
    },

    getChunk(chunkId: string): Chunk | undefined {
      return chunks.find((c) => c.chunkId === chunkId);
    },

    async save(directory: string): Promise<string> {
      // Create directory
      await fs.mkdir(directory, { recursive: true });

      // Save manifest
      await fs.writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // Save doc_nav
      if (docNav) {
        await fs.writeFile(join(directory, 'doc_nav.json'), JSON.stringify(docNav, null, 2));
      }

      // Save chunks
      await fs.writeFile(join(directory, 'chunks.json'), JSON.stringify(chunks, null, 2));

      if (chunksSlim) {
        await fs.writeFile(
          join(directory, 'chunks_slim.json'),
          JSON.stringify({ chunks: chunksSlim }, null, 2),
        );
      }

      // Save full markdown
      if (fullMarkdown) {
        await fs.writeFile(join(directory, 'full.md'), fullMarkdown);
      }

      // Save hierarchy
      if (hierarchy) {
        await fs.writeFile(join(directory, 'hierarchy.json'), JSON.stringify(hierarchy, null, 2));
      }

      if (tocHierarchies) {
        await fs.writeFile(
          join(directory, 'toc_hierarchies.json'),
          JSON.stringify(tocHierarchies, null, 2),
        );
      }

      if (kbCsv) {
        await fs.writeFile(join(directory, 'kb.csv'), kbCsv);
      }

      if (hierarchyViewHtml) {
        await fs.writeFile(join(directory, 'hierarchy_view.html'), hierarchyViewHtml);
      }

      // Save images
      for (const imageChunk of this.imageChunks) {
        await imageChunk.save(directory);
      }

      // Save tables
      for (const tableChunk of this.tableChunks) {
        await tableChunk.save(directory);
      }

      // Save raw ZIP
      await fs.writeFile(join(directory, 'result.zip'), zipBuffer);

      return directory;
    },
  };

  return result;
}

function extractChunks(payload: ChunkPayload): RawChunk[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.chunks)) {
    return payload.chunks;
  }

  return [];
}

function extractSlimChunks(payload: SlimChunkPayload): SlimChunk[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.chunks)) {
    return payload.chunks;
  }

  return [];
}

function getChunkFilePath(chunkData: RawChunk): string | undefined {
  const metadata = chunkData.metadata;
  return chunkData.filePath ?? (metadata?.filePath as string | undefined) ?? chunkData.path;
}

function buildTextChunk(chunkData: RawChunk): TextChunk {
  return {
    chunkId: chunkData.chunkId ?? '',
    type: 'text',
    content: chunkData.content ?? '',
    path: chunkData.path ?? '',
    metadata: chunkData.metadata ?? {},
  };
}

async function processChunk(zip: JSZip, chunkData: RawChunk): Promise<Chunk> {
  if (chunkData.type === 'text') {
    return buildTextChunk(chunkData);
  }

  if (chunkData.type === 'image') {
    const filePath = getChunkFilePath(chunkData);

    if (!filePath) {
      throw new KnowhereError(`Image chunk missing file path: ${chunkData.chunkId ?? 'unknown'}`);
    }

    // Load image data
    const sanitized = sanitizePath(filePath);
    const imageFile = zip.file(sanitized);
    if (!imageFile) {
      throw new KnowhereError(`Image file not found: ${filePath}`);
    }

    const imageBuffer = await imageFile.async('nodebuffer');

    // Add data and methods
    const enrichedChunk: ImageChunk = {
      chunkId: chunkData.chunkId ?? '',
      type: 'image',
      content: chunkData.content ?? '',
      path: chunkData.path ?? '',
      filePath,
      data: imageBuffer,
      metadata: chunkData.metadata ?? {},

      get format(): string {
        return getFileExtension(this.filePath);
      },

      async save(directory: string): Promise<string> {
        const outputPath = join(directory, sanitizePath(this.filePath));
        const outputDir = dirname(outputPath);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(outputPath, this.data);
        return outputPath;
      },
    };

    return enrichedChunk;
  }

  if (chunkData.type === 'table') {
    const filePath = getChunkFilePath(chunkData);

    if (!filePath) {
      throw new KnowhereError(`Table chunk missing file path: ${chunkData.chunkId ?? 'unknown'}`);
    }

    // Load HTML data
    const sanitized = sanitizePath(filePath);
    const htmlFile = zip.file(sanitized);
    if (!htmlFile) {
      throw new KnowhereError(`Table file not found: ${filePath}`);
    }

    const html = await htmlFile.async('string');

    // Add html and methods
    const enrichedChunk: TableChunk = {
      chunkId: chunkData.chunkId ?? '',
      type: 'table',
      content: chunkData.content ?? '',
      path: chunkData.path ?? '',
      filePath,
      html,
      metadata: chunkData.metadata ?? {},

      async save(directory: string): Promise<string> {
        const outputPath = join(directory, sanitizePath(this.filePath));
        const outputDir = dirname(outputPath);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(outputPath, this.html);
        return outputPath;
      },
    };

    return enrichedChunk;
  }

  return buildTextChunk(chunkData);
}

/**
 * Verify SHA-256 checksum
 */
export function verifyChecksum(data: Buffer, expected: string): void {
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) {
    throw new ChecksumError('Checksum verification failed', expected, actual);
  }
}
