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
} from '../types/result.js';
import type { LoadOptions } from '../types/params.js';
import { ChecksumError, KnowhereError } from '../errors/index.js';
import { sanitizePath, getFileExtension, parseDates, keysToCamel } from './utils.js';

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
  let chunksData = JSON.parse(chunksContent) as Chunk[];
  chunksData = keysToCamel(chunksData);

  // Process chunks and load associated files
  const chunks: Chunk[] = [];

  for (const chunkData of chunksData) {
    const chunk = await processChunk(zip, chunkData);
    chunks.push(chunk);
  }

  // Extract optional files
  let fullMarkdown: string | undefined;
  const fullMdFile = zip.file('full.md');
  if (fullMdFile) {
    fullMarkdown = await fullMdFile.async('string');
  }

  let hierarchy: unknown;
  const hierarchyFile = zip.file('hierarchy.json');
  if (hierarchyFile) {
    const hierarchyContent = await hierarchyFile.async('string');
    hierarchy = JSON.parse(hierarchyContent);
  }

  // Create result object
  const result: ParseResult = {
    manifest,
    chunks,
    fullMarkdown,
    hierarchy,
    rawZip: zipBuffer,

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
      await fs.writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
      );

      // Save chunks
      await fs.writeFile(
        join(directory, 'chunks.json'),
        JSON.stringify(chunks, null, 2),
      );

      // Save full markdown
      if (fullMarkdown) {
        await fs.writeFile(join(directory, 'full.md'), fullMarkdown);
      }

      // Save hierarchy
      if (hierarchy) {
        await fs.writeFile(
          join(directory, 'hierarchy.json'),
          JSON.stringify(hierarchy, null, 2),
        );
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

/**
 * Process individual chunk and load associated files
 */
async function processChunk(zip: JSZip, chunkData: Chunk): Promise<Chunk> {
  if (chunkData.type === 'text') {
    return chunkData;
  }

  if (chunkData.type === 'image') {
    const imageChunk = chunkData;

    // Load image data
    const sanitized = sanitizePath(imageChunk.filePath);
    const imageFile = zip.file(sanitized);
    if (!imageFile) {
      throw new KnowhereError(`Image file not found: ${imageChunk.filePath}`);
    }

    const imageBuffer = await imageFile.async('nodebuffer');

    // Add data and methods
    const enrichedChunk: ImageChunk = {
      ...imageChunk,
      data: imageBuffer,

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
    const tableChunk = chunkData;

    // Load HTML data
    const sanitized = sanitizePath(tableChunk.filePath);
    const htmlFile = zip.file(sanitized);
    if (!htmlFile) {
      throw new KnowhereError(`Table file not found: ${tableChunk.filePath}`);
    }

    const html = await htmlFile.async('string');

    // Add html and methods
    const enrichedChunk: TableChunk = {
      ...tableChunk,
      html,

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

  throw new KnowhereError(`Unknown chunk type: ${(chunkData as Chunk).type}`);
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
