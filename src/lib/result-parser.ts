import JSZip from 'jszip';
import { promises as fs } from 'fs';
import { join, dirname, resolve, sep } from 'path';
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

interface ParseResultParts {
  manifest: Manifest;
  chunks: Chunk[];
  rawZip: Buffer;
  docNav?: DocNav;
  fullMarkdown?: string;
  chunksSlim?: SlimChunk[];
  hierarchy?: unknown;
  tocHierarchies?: unknown;
  kbCsv?: string;
  hierarchyViewHtml?: string;
}

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

  return parseResultBuffer(zipBuffer);
}

/**
 * Parse result ZIP from an already downloaded buffer.
 */
export async function parseResultBuffer(zipBuffer: Buffer): Promise<ParseResult> {
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

  return createParseResult({
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
  });
}

/**
 * Parse an expanded result directory written by saveExpandedParseResult().
 */
export async function parseResultDirectory(directory: string): Promise<ParseResult> {
  const manifestContent = await readRequiredTextFile(directory, 'manifest.json');
  let manifest = JSON.parse(manifestContent) as Manifest;
  manifest = keysToCamel(manifest);
  manifest = parseDates(manifest);

  const chunksContent = await readRequiredTextFile(directory, 'chunks.json');
  let chunksData = JSON.parse(chunksContent) as ChunkPayload;
  chunksData = keysToCamel(chunksData);
  const rawChunks = extractChunks(chunksData);

  const chunks: Chunk[] = [];
  for (const chunkData of rawChunks) {
    chunks.push(await processDirectoryChunk(directory, chunkData));
  }

  const fullMarkdown = await readOptionalTextFile(directory, 'full.md');
  const rawDocNav = await readOptionalJsonFile(directory, 'doc_nav.json');
  const docNav = rawDocNav === undefined ? undefined : keysToCamel<DocNav>(rawDocNav);
  const hierarchy = await readOptionalJsonFile(directory, 'hierarchy.json');
  const rawChunksSlim = await readOptionalJsonFile(directory, 'chunks_slim.json');
  const chunksSlim =
    rawChunksSlim === undefined
      ? undefined
      : extractSlimChunks(keysToCamel<SlimChunkPayload>(rawChunksSlim));
  const rawTocHierarchies = await readOptionalJsonFile(directory, 'toc_hierarchies.json');
  const tocHierarchies =
    rawTocHierarchies === undefined ? undefined : keysToCamel(rawTocHierarchies);
  const kbCsv = await readOptionalTextFile(directory, 'kb.csv');
  const hierarchyViewHtml = await readOptionalTextFile(directory, 'hierarchy_view.html');

  return createParseResult({
    manifest,
    chunks,
    docNav,
    fullMarkdown,
    rawZip: Buffer.alloc(0),
    chunksSlim,
    hierarchy,
    tocHierarchies,
    kbCsv,
    hierarchyViewHtml,
  });
}

/**
 * Save parsed result files and sidecar assets without persisting the raw ZIP.
 */
export async function saveExpandedParseResult(
  result: ParseResult,
  directory: string,
): Promise<string> {
  if (result.rawZip.length > 0) {
    const didExtractZip = await tryExtractRawZip(result.rawZip, directory);
    if (didExtractZip) {
      return directory;
    }
  }

  await fs.mkdir(directory, { recursive: true });

  await fs.writeFile(join(directory, 'manifest.json'), JSON.stringify(result.manifest, null, 2));

  if (result.docNav) {
    await fs.writeFile(join(directory, 'doc_nav.json'), JSON.stringify(result.docNav, null, 2));
  }

  await fs.writeFile(
    join(directory, 'chunks.json'),
    JSON.stringify(serializeChunks(result.chunks), null, 2),
  );

  if (result.chunksSlim) {
    await fs.writeFile(
      join(directory, 'chunks_slim.json'),
      JSON.stringify({ chunks: result.chunksSlim }, null, 2),
    );
  }

  if (result.fullMarkdown) {
    await fs.writeFile(join(directory, 'full.md'), result.fullMarkdown);
  }

  if (result.hierarchy) {
    await fs.writeFile(
      join(directory, 'hierarchy.json'),
      JSON.stringify(result.hierarchy, null, 2),
    );
  }

  if (result.tocHierarchies) {
    await fs.writeFile(
      join(directory, 'toc_hierarchies.json'),
      JSON.stringify(result.tocHierarchies, null, 2),
    );
  }

  if (result.kbCsv) {
    await fs.writeFile(join(directory, 'kb.csv'), result.kbCsv);
  }

  if (result.hierarchyViewHtml) {
    await fs.writeFile(join(directory, 'hierarchy_view.html'), result.hierarchyViewHtml);
  }

  for (const imageChunk of result.imageChunks) {
    await writeBinaryAsset(directory, imageChunk.filePath, imageChunk.data);
  }

  for (const tableChunk of result.tableChunks) {
    await writeTextAsset(directory, tableChunk.filePath, tableChunk.html);
  }

  return directory;
}

async function tryExtractRawZip(zipBuffer: Buffer, directory: string): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(zipBuffer);
    await fs.mkdir(directory, { recursive: true });

    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry.name === 'result.zip') {
        continue;
      }

      const outputPath = resolveAssetPath(directory, entry.name);
      await fs.mkdir(dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, await entry.async('nodebuffer'));
    }

    return true;
  } catch {
    return false;
  }
}

function createParseResult(parts: ParseResultParts): ParseResult {
  const {
    manifest,
    chunks,
    docNav,
    fullMarkdown,
    rawZip,
    chunksSlim,
    hierarchy,
    tocHierarchies,
    kbCsv,
    hierarchyViewHtml,
  } = parts;

  return {
    manifest,
    chunks,
    docNav,
    fullMarkdown,
    rawZip,
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
      await fs.writeFile(join(directory, 'result.zip'), rawZip);

      return directory;
    },
  };
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

function buildImageChunk(chunkData: RawChunk, filePath: string, imageBuffer: Buffer): ImageChunk {
  return {
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
      return writeBinaryAsset(directory, this.filePath, this.data);
    },
  };
}

function buildTableChunk(chunkData: RawChunk, filePath: string, html: string): TableChunk {
  return {
    chunkId: chunkData.chunkId ?? '',
    type: 'table',
    content: chunkData.content ?? '',
    path: chunkData.path ?? '',
    filePath,
    html,
    metadata: chunkData.metadata ?? {},

    async save(directory: string): Promise<string> {
      return writeTextAsset(directory, this.filePath, this.html);
    },
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
    return buildImageChunk(chunkData, filePath, imageBuffer);
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
    return buildTableChunk(chunkData, filePath, html);
  }

  return buildTextChunk(chunkData);
}

async function processDirectoryChunk(directory: string, chunkData: RawChunk): Promise<Chunk> {
  if (chunkData.type === 'text') {
    return buildTextChunk(chunkData);
  }

  if (chunkData.type === 'image') {
    const filePath = getChunkFilePath(chunkData);

    if (!filePath) {
      throw new KnowhereError(`Image chunk missing file path: ${chunkData.chunkId ?? 'unknown'}`);
    }

    try {
      const imageBuffer = await fs.readFile(resolveAssetPath(directory, filePath));
      return buildImageChunk(chunkData, filePath, imageBuffer);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new KnowhereError(`Image file not found: ${filePath}`);
      }
      throw error;
    }
  }

  if (chunkData.type === 'table') {
    const filePath = getChunkFilePath(chunkData);

    if (!filePath) {
      throw new KnowhereError(`Table chunk missing file path: ${chunkData.chunkId ?? 'unknown'}`);
    }

    try {
      const html = await fs.readFile(resolveAssetPath(directory, filePath), 'utf8');
      return buildTableChunk(chunkData, filePath, html);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new KnowhereError(`Table file not found: ${filePath}`);
      }
      throw error;
    }
  }

  return buildTextChunk(chunkData);
}

function serializeChunks(chunks: Chunk[]): { chunks: RawChunk[] } {
  return {
    chunks: chunks.map((chunk): RawChunk => {
      const rawChunk: RawChunk = {
        chunkId: chunk.chunkId,
        type: chunk.type,
        content: chunk.content,
        path: chunk.path,
        metadata: chunk.metadata,
      };

      if (chunk.type === 'image' || chunk.type === 'table') {
        rawChunk.filePath = chunk.filePath;
      }

      return rawChunk;
    }),
  };
}

async function readRequiredTextFile(directory: string, fileName: string): Promise<string> {
  try {
    return await fs.readFile(join(directory, fileName), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new KnowhereError(`${fileName} not found in result directory`);
    }
    throw error;
  }
}

async function readOptionalTextFile(
  directory: string,
  fileName: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(join(directory, fileName), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readOptionalJsonFile(directory: string, fileName: string): Promise<unknown> {
  const content = await readOptionalTextFile(directory, fileName);
  return content === undefined ? undefined : JSON.parse(content);
}

async function writeBinaryAsset(
  directory: string,
  filePath: string,
  data: Buffer,
): Promise<string> {
  const outputPath = resolveAssetPath(directory, filePath);
  const outputDir = dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, data);
  return outputPath;
}

async function writeTextAsset(directory: string, filePath: string, text: string): Promise<string> {
  const outputPath = resolveAssetPath(directory, filePath);
  const outputDir = dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, text);
  return outputPath;
}

function resolveAssetPath(directory: string, filePath: string): string {
  const root = resolve(directory);
  const outputPath = resolve(root, sanitizePath(filePath));
  if (outputPath !== root && !outputPath.startsWith(`${root}${sep}`)) {
    throw new KnowhereError(`Invalid result asset path: ${filePath}`);
  }
  return outputPath;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
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
