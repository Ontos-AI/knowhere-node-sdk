/**
 * Error handling example
 */

import Knowhere, {
  BadRequestError,
  AuthenticationError,
  RateLimitError,
  PollingTimeoutError,
  JobFailedError,
  NetworkError,
} from '@knowhere-ai/sdk';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const client = new Knowhere({
    apiKey: process.env.KNOWHERE_API_KEY,
  });

  try {
    const result = await client.parse({
      url: 'https://example.com/document.pdf',
    });
    console.log('✅ Success:', result.jobId);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      console.error('❌ Authentication failed. Check your API key.');
      console.error('Set KNOWHERE_API_KEY environment variable or pass apiKey option.');
    } else if (error instanceof RateLimitError) {
      console.error('❌ Rate limit exceeded.');
      if (error.retryAfter) {
        console.error(`Retry after ${error.retryAfter} seconds.`);
        await sleep(error.retryAfter * 1000);
        // Retry the request...
      }
    } else if (error instanceof PollingTimeoutError) {
      console.error('❌ Polling timeout. Document processing took too long.');
      console.error(`Elapsed time: ${error.elapsedMs}ms`);
    } else if (error instanceof JobFailedError) {
      console.error('❌ Job failed:');
      console.error(`  Code: ${error.code}`);
      console.error(`  Message: ${error.message}`);
      console.error(`  Job ID: ${error.jobResult.jobId}`);
      if (error.jobResult.error) {
        console.error(`  Details: ${JSON.stringify(error.jobResult.error)}`);
      }
    } else if (error instanceof BadRequestError) {
      console.error('❌ Bad request:');
      console.error(`  Status: ${error.statusCode}`);
      console.error(`  Message: ${error.message}`);
      console.error(`  Code: ${error.code}`);
      if (error.details) {
        console.error(`  Details: ${JSON.stringify(error.details)}`);
      }
    } else if (error instanceof NetworkError) {
      console.error('❌ Network error:', error.message);
      console.error('Check your internet connection and try again.');
    } else {
      console.error('❌ Unknown error:', error);
    }
    process.exit(1);
  }
}

main();
