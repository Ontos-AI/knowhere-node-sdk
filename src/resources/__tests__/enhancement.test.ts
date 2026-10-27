import { describe, expect, it, vi } from 'vitest';
import { keysToCamel, parseDates } from '../../lib/utils.js';
import { HttpClient } from '../../lib/http-client.js';
import { Jobs } from '../jobs.js';

describe('enhancement retry', () => {
  it('posts no body to the enrichment retry command and returns its current state', async () => {
    const http = new HttpClient({ baseURL: 'https://api.example', apiKey: 'test' });
    const response = {
      jobId: 'job_test',
      enhancement: { status: 'running', canRetry: false, attempt: 2, error: null },
    };
    const post = vi.spyOn(http, 'post').mockResolvedValue(response);
    expect(await new Jobs(http).retryEnhancement('job_test')).toEqual(response);
    expect(post).toHaveBeenCalledWith('/v2/jobs/job_test/enrichment/retry');
  });

  it('projects additive snake case snapshot fields and URL expiry through the HTTP conversion', () => {
    const projected = parseDates(
      keysToCamel<Record<string, unknown>>({
        enhancement: { status: 'pending', can_retry: false, attempt: 1, error: null },
        current_snapshot_id: 'opaque',
        snapshots: [
          {
            snapshot_id: 'opaque',
            job_result_id: 'upstream',
            result_url_expires_at: '2026-10-26T20:00:00Z',
          },
        ],
      }),
    );
    expect(projected).toEqual({
      enhancement: { status: 'pending', canRetry: false, attempt: 1, error: null },
      currentSnapshotId: 'opaque',
      snapshots: [
        {
          snapshotId: 'opaque',
          jobResultId: 'upstream',
          resultUrlExpiresAt: new Date('2026-10-26T20:00:00Z'),
        },
      ],
    });
  });
});
