/**
 * Basic usage example - Parse document from URL
 */

import Knowhere from '@knowhere-ai/sdk';

async function main() {
  // Initialize client with API key
  const client = new Knowhere({
    apiKey: process.env.KNOWHERE_API_KEY,
  });

  try {
    // Parse document from URL
    console.log('Starting document parsing...');
    const result = await client.parse({
      url: 'https://example.com/sample.pdf',
    });

    // Print statistics
    console.log('\n📊 Parsing complete!');
    console.log(`├─ Text chunks: ${result.textChunks.length}`);
    console.log(`├─ Image chunks: ${result.imageChunks.length}`);
    console.log(`├─ Table chunks: ${result.tableChunks.length}`);
    console.log(`└─ Job ID: ${result.jobId}`);

    // Print first text chunk
    if (result.textChunks.length > 0) {
      const firstChunk = result.textChunks[0];
      console.log('\n📄 First text chunk:');
      console.log(`Content: ${firstChunk.content.substring(0, 100)}...`);
      console.log(`Keywords: ${firstChunk.keywords?.join(', ')}`);
    }

    // Save results to disk
    await result.save('./output');
    console.log('\n💾 Results saved to ./output');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
