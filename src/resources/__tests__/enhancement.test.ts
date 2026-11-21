import { describe, expect, expectTypeOf, it } from 'vitest';
import { Knowhere, type JobEnrichmentFailedEvent } from '../../index.js';
import { keysToCamel, parseDates } from '../../lib/utils.js';

describe('enrichment compatibility', () => {
  it('omits the manual enhancement retry command', (): void => {
    const client: Knowhere = new Knowhere({ apiKey: 'test' });
    expect('retryEnhancement' in client.jobs).toBe(false);
  });

  it('types the raw failure event by failed attempt', (): void => {
    const event = {
      event: 'job.enrichment.failed',
      event_id: 'event-2',
      job_id: 'job-test',
      document_id: 'doc-test',
      job_result_id: 'result-test',
      unit_id: 'chapter-3',
      attempt: 2,
      can_retry: true,
      error: { code: 'INDEXING_FAILED' },
    } satisfies JobEnrichmentFailedEvent;
    expectTypeOf<JobEnrichmentFailedEvent['error']['message']>().toEqualTypeOf<
      string | undefined
    >();
    expect(event.event_id).toBe('event-2');
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
