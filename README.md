# Knowhere Node.js SDK

Official Node.js/TypeScript SDK for the [Knowhere](https://knowhereto.ai) document parsing API.

[![npm version](https://badge.fury.io/js/@ontos-ai%2Fknowhere-sdk.svg)](https://www.npmjs.com/package/@ontos-ai/knowhere-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@ontos-ai/knowhere-sdk)](https://nodejs.org)

## Features

- 🚀 **TypeScript-first** - Full type safety with comprehensive type definitions
- 📦 **Stream-based uploads** - Efficient handling of large files
- 🔄 **Automatic retries** - Exponential backoff for transient failures
- 📊 **Adaptive polling** - Smart waiting for job completion
- 🎯 **Progressive API** - High-level convenience methods + low-level control
- ⚡ **Modern JavaScript** - ESM and CommonJS support

## Installation

```bash
npm install @ontos-ai/knowhere-sdk
```

**Requirements:**

- Node.js >= 20.19.0
- npm >= 10.0.0
- TypeScript >= 5.0 (optional, for type checking)

## Quick Start

```typescript
import Knowhere from '@ontos-ai/knowhere-sdk';

// Initialize client
const client = new Knowhere({
  apiKey: process.env.KNOWHERE_API_KEY,
});

// Parse a document from URL
const result = await client.parse({
  url: 'https://example.com/document.pdf',
});

// Access parsed content
console.log(`Found ${result.textChunks.length} text chunks`);
console.log(`Found ${result.imageChunks.length} images`);
console.log(`Found ${result.tableChunks.length} tables`);

// Work with chunks
result.textChunks.forEach((chunk) => {
  console.log(chunk.content);
  console.log(chunk.keywords);
  console.log(chunk.summary);
});

// Save results to disk
await result.save('./output/');
```

## Configuration

### Environment Variables

```bash
KNOWHERE_API_KEY=sk_...                       # Required
KNOWHERE_BASE_URL=https://api.knowhereto.ai   # Optional
```

### Client Options

```typescript
const client = new Knowhere({
  apiKey: 'sk_...', // API authentication key
  baseURL: 'https://...', // API base URL
  timeout: 60000, // Request timeout (ms)
  uploadTimeout: 600000, // Upload timeout (ms)
  maxRetries: 5, // Max retry attempts
});
```

## Usage Examples

### Parse from File

```typescript
// From file path (recommended)
const result = await client.parse({
  file: './document.pdf',
});

// From Buffer
const buffer = await fs.readFile('./document.pdf');
const result = await client.parse({
  file: buffer,
  fileName: 'document.pdf',
});

// From Stream
const stream = fs.createReadStream('./document.pdf');
const result = await client.parse({
  file: stream,
  fileName: 'document.pdf',
});
```

`fileName` 会在 `file` 是本地文件路径时自动推断；当 `file` 是 `Buffer`、`Uint8Array` 或不带路径信息的流时必须显式提供。

### Advanced Options

```typescript
const result = await client.parse({
  url: 'https://example.com/doc.pdf',
  model: 'advanced', // 'base' | 'advanced'
  ocr: true, // Enable OCR
  docType: 'pdf', // Document type hint
  smartTitleParse: true, // Smart title detection
  summaryImage: true, // Generate image summaries
  summaryTable: true, // Generate table summaries
  summaryText: true, // Generate text summaries
  addFragDesc: 'Custom context', // Additional fragment description
  kbDir: 'project_docs', // Knowledge base directory
  pollInterval: 10000, // Polling interval (ms)
  pollTimeout: 1800000, // Max wait time (ms)
  verifyChecksum: true, // Verify ZIP checksum (default: true)
  webhook: {
    // Webhook for completion
    url: 'https://...',
  },
  onUploadProgress: (progress) => {
    console.log(`Upload: ${progress.percent}%`);
  },
  onPollProgress: (status) => {
    console.log(`Status: ${status.status}`);
  },
});
```

### Low-Level API

For granular control over the job lifecycle:

```typescript
// 1. Create job
const job = await client.jobs.create({
  sourceType: 'file',
  fileName: 'document.pdf',
  parsingParams: { model: 'advanced', ocrEnabled: true },
});

// 2. Upload file
await client.jobs.upload(job, {
  file: './document.pdf',
  onProgress: ({ percent }) => console.log(`${percent}%`),
});

// 3. Wait for completion
const jobResult = await client.jobs.wait(job.jobId, {
  pollInterval: 10000,
});

// 4. Load results
const result = await client.jobs.load(jobResult);
```

### Retrieval and Document Lifecycle

Published documents are queryable through the retrieval API after a job
finishes. Persist the returned `documentId` if you need to update or archive the
same document later.

```typescript
const job = await client.jobs.create({
  sourceType: 'url',
  sourceUrl: 'https://example.com/manual.pdf',
  namespace: 'support-center',
});

const jobResult = await client.jobs.wait(job.jobId);
console.log(jobResult.documentId);

const response = await client.retrieval.query({
  namespace: 'support-center',
  query: 'How do I reset Bluetooth pairing?',
  topK: 5,
});

for (const result of response.results) {
  console.log(result.content);
  console.log(result.score);
  console.log(result.source.sourceFileName, result.source.sectionPath);
}
```

Retrieval results use one canonical source object:

```typescript
result.content;
result.chunkType;
result.score;
result.assetUrl;
result.source.documentId;
result.source.sourceFileName;
result.source.sectionPath;
```

Use `documentId` to update or archive a document:

```typescript
const updateJob = await client.jobs.create({
  sourceType: 'url',
  sourceUrl: 'https://example.com/manual-v2.pdf',
  documentId: job.documentId,
});

const documents = await client.documents.list({ namespace: 'support-center' });
const document = await client.documents.get(job.documentId);
const archived = await client.documents.archive(job.documentId);

console.log(documents.documents.length);
console.log(document.status);
console.log(archived.status);
```

Follow-up queries can exclude documents or sections for one request:

```typescript
const followUp = await client.retrieval.query({
  namespace: 'support-center',
  query: 'battery charging',
  excludeDocumentIds: ['doc_old'],
  excludeSections: [{ documentId: 'doc_123', sectionPath: 'Appendix / Legal' }],
});
```

### Error Handling

```typescript
import {
  BadRequestError,
  AuthenticationError,
  RateLimitError,
  PollingTimeoutError,
  JobFailedError,
  ValidationError,
  InvalidStateError,
} from '@ontos-ai/knowhere-sdk';

try {
  const result = await client.parse({ url: '...' });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Invalid parameters:', error.message);
  } else if (error instanceof RateLimitError) {
    // Wait and retry
    await sleep(error.retryAfter * 1000);
  } else if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else if (error instanceof PollingTimeoutError) {
    console.error('Processing timeout');
  } else if (error instanceof JobFailedError) {
    console.error('Job failed:', error.jobResult.error);
  } else if (error instanceof InvalidStateError) {
    console.error('Invalid state:', error.message);
  }
}
```

## Documentation

For complete documentation, visit [https://docs.knowhereto.ai](https://docs.knowhereto.ai)

## Examples

Check out the [examples](./examples) directory for more usage examples:

- [Basic Usage](./examples/basic.ts)
- [File Upload](./examples/file-upload.ts)
- [Error Handling](./examples/error-handling.ts)
- [Low-Level API](./examples/low-level.ts)

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:ci

# Lint code
npm run lint

# Format code
npm run format

# Type check
npm run typecheck

# Build
npm run build
```

## Release Workflow

See [docs/release-workflow.md](./docs/release-workflow.md) for the
Changesets-based stable and beta release process.

## License

[MIT](./LICENSE)

## Support

- 📧 Email: team@knowhereto.ai
- 🐛 Issues: [GitHub Issues](https://github.com/Ontos-AI/knowhere-node-sdk/issues)
- 📚 Documentation: [https://docs.knowhereto.ai](https://docs.knowhereto.ai)

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history.
