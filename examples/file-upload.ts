/**
 * File upload example - Parse local file
 */

import Knowhere from '@knowhere-ai/sdk';
import { createReadStream } from 'fs';

async function main() {
  const client = new Knowhere({
    apiKey: process.env.KNOWHERE_API_KEY,
  });

  try {
    // Example 1: Upload from file path (recommended)
    console.log('📤 Uploading from file path...');
    const result1 = await client.parse({
      file: './sample.pdf',
      onUploadProgress: (progress) => {
        console.log(`Upload progress: ${progress.percent}%`);
      },
      onPollProgress: (status) => {
        console.log(`Job status: ${status.status}`);
      },
    });
    console.log('✅ Parsing complete:', result1.jobId);

    // Example 2: Upload from stream
    console.log('\n📤 Uploading from stream...');
    const stream = createReadStream('./sample.pdf');
    const result2 = await client.parse({
      file: stream,
      fileName: 'sample.pdf',
    });
    console.log('✅ Parsing complete:', result2.jobId);

    // Example 3: Upload with advanced options
    console.log('\n📤 Uploading with advanced options...');
    const result3 = await client.parse({
      file: './sample.pdf',
      model: 'advanced',
      ocr: true,
      smartTitleParse: true,
      summaryImage: true,
      summaryTable: true,
      summaryText: true,
    });
    console.log('✅ Parsing complete:', result3.jobId);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
