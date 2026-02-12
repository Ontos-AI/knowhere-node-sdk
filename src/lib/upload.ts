import { createReadStream, promises as fs } from 'fs';
import type { ReadStream } from 'fs';
import type { HttpClient } from './http-client.js';
import type { UploadProgress } from '../types/params.js';
import { ValidationError } from '../errors/index.js';

/**
 * Upload file to presigned URL
 */
export async function uploadFile(
  httpClient: HttpClient,
  uploadUrl: string,
  file: string | Buffer | ReadStream | Uint8Array,
  options?: {
    headers?: Record<string, string>;
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  let data: Buffer | ReadStream;
  let contentLength: number | undefined;

  // Convert file input to uploadable format
  if (typeof file === 'string') {
    // File path - use stream for efficiency
    const stats = await fs.stat(file);
    contentLength = stats.size;
    data = createReadStream(file);
  } else if (file instanceof Buffer) {
    // Buffer - direct upload
    contentLength = file.length;
    data = file;
  } else if (isReadStream(file)) {
    // Stream - direct upload
    data = file;
    // Try to get content length if available (streams may have bytesRead property)
    const streamWithBytes = file as ReadStream & { bytesRead?: number };
    contentLength = streamWithBytes.bytesRead;
  } else if (file instanceof Uint8Array) {
    // Uint8Array - convert to Buffer
    contentLength = file.length;
    data = Buffer.from(file);
  } else {
    throw new ValidationError('Unsupported file type');
  }

  // Upload with progress tracking
  await httpClient.upload(uploadUrl, data, {
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(contentLength ? { 'Content-Length': contentLength.toString() } : {}),
      ...options?.headers,
    },
    onProgress: options?.onProgress,
    signal: options?.signal,
  });
}

/**
 * Type guard for ReadStream
 */
function isReadStream(obj: unknown): obj is ReadStream {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'pipe' in obj &&
    'read' in obj &&
    typeof (obj as ReadStream).pipe === 'function'
  );
}
