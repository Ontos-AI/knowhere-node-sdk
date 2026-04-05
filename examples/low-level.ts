/**
 * Low-level API example - Granular control over job lifecycle
 */

import Knowhere, { type PollProgress, type UploadProgress } from '@knowhere-ai/sdk';

async function main() {
  const client = new Knowhere({
    apiKey: process.env.KNOWHERE_API_KEY,
  });

  try {
    // Step 1: Create job
    console.log('1️⃣  Creating job...');
    const job = await client.jobs.create({
      sourceType: 'file',
      fileName: 'document.pdf',
      parsingParams: {
        model: 'advanced',
        ocrEnabled: true,
        smartTitleParse: true,
      },
    });
    console.log(`✅ Job created: ${job.jobId}`);
    console.log(`   Upload URL: ${job.uploadUrl}`);

    // Step 2: Upload file
    console.log('\n2️⃣  Uploading file...');
    await client.jobs.upload(job, {
      file: './document.pdf',
      onProgress: (progress: UploadProgress) => {
        console.log(`   Progress: ${progress.percent}%`);
      },
    });
    console.log('✅ File uploaded');

    // Step 3: Poll job status
    console.log('\n3️⃣  Waiting for processing...');
    const jobResult = await client.jobs.wait(job.jobId, {
      pollInterval: 5000,
      onProgress: (status: PollProgress) => {
        console.log(`   Status: ${status.status} (${status.elapsedSeconds}s)`);
      },
    });
    console.log(`✅ Processing complete: ${jobResult.status}`);

    // Step 4: Load results
    console.log('\n4️⃣  Loading results...');
    const result = await client.jobs.load(jobResult);
    console.log('✅ Results loaded');
    console.log(`   Text chunks: ${result.textChunks.length}`);
    console.log(`   Image chunks: ${result.imageChunks.length}`);
    console.log(`   Table chunks: ${result.tableChunks.length}`);

    // Step 5: Process chunks
    console.log('\n5️⃣  Processing chunks...');
    for (const textChunk of result.textChunks) {
      console.log(`\n   Chunk ${textChunk.chunkId}:`);
      console.log(`   - Content: ${textChunk.content.substring(0, 50)}...`);
      console.log(`   - Keywords: ${textChunk.keywords?.join(', ')}`);
      console.log(`   - Summary: ${textChunk.summary}`);
    }

    // Save to disk
    await result.save('./output');
    console.log('\n💾 Results saved to ./output');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
