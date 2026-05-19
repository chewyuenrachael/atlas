/**
 * `luma-fetch-events` — periodic Luma ingestion workflow.
 *
 * Cron: every 4 hours. Matches SPEC.md §5.2.1 schedule for
 * Luma event fetch and §5.3's example orchestration. The workflow:
 *
 *   1. Instantiates a `LumaAdapter` (in-memory raw store until Phase 1B
 *      wires `EventQueries.insertRawLumaEvent`).
 *   2. Discovers events on the community page.
 *   3. Persists each raw event idempotently (`luma_event_id` uniqueness).
 *   4. Normalizes each stored raw record into `NormalizedRecord[]` for
 *      identity resolution to pick up in Phase 1C.
 *   5. Reports counts at each step for operator visibility.
 *
 * Every side effect lives inside its own `step.run('...')` so Inngest's
 * durable-execution guarantees apply — partial failures resume from the
 * last completed step.
 *
 * SPEC ref: §5.2.1 (Luma source spec), §5.3 (pipeline orchestration),
 * §5.4 (idempotency).
 */
import { LumaAdapter, type LumaAdapterOptions } from '@atlas/adapter-luma';
import { logger, type NormalizedRecord } from '@atlas/core';
import { inngest } from './inngest-client.js';

interface FetchStats {
  events_discovered: number;
  raw_stored: number;
  raw_existed: number;
  normalized_records: number;
  event_records: number;
  person_records: number;
  failures: number;
}

/** Build the adapter on each run; the in-memory store is intentionally ephemeral. */
function makeAdapter(options?: LumaAdapterOptions): LumaAdapter {
  return new LumaAdapter(options);
}

/**
 * The Inngest function. Registered automatically when this module is imported
 * by the Inngest serve route (Phase 1B).
 *
 * @example
 * ```ts
 * import { serve } from 'inngest/next';
 * import { fetchLumaEvents } from '@atlas/workflows-shared';
 *
 * export const { GET, POST, PUT } = serve({
 *   client: inngest,
 *   functions: [fetchLumaEvents],
 * });
 * ```
 */
export const fetchLumaEvents = inngest.createFunction(
  { id: 'luma-fetch-events', name: 'Luma — fetch community events' },
  { cron: '0 */4 * * *' },
  async ({ step }) => {
    const log = logger.child({ workflow: 'luma-fetch-events' });
    const adapter = makeAdapter();

    // Step 1: discover + persist all raw events. Wrapped in one step because
    // the raw inserts are idempotent on `luma_event_id` (SPEC.md §3.5 +
    // §5.4) — re-running this step on retry produces no new rows.
    const persisted = await step.run(
      'discover-and-store-raw',
      async (): Promise<Array<{ rawId: string; lumaEventId: string; existed: boolean }>> => {
        const stored: Array<{ rawId: string; lumaEventId: string; existed: boolean }> = [];
        let discovered = 0;
        let failed = 0;
        for await (const raw of adapter.fetch()) {
          discovered += 1;
          try {
            const { rawId } = await adapter.storeRaw(raw);
            // We don't have a per-record `existed` signal at this layer; the
            // adapter's idempotency guarantee covers it. Default to false so
            // downstream counts are conservative.
            stored.push({ rawId, lumaEventId: raw.lumaEventId, existed: false });
          } catch (cause) {
            failed += 1;
            log.warn(
              { err: cause, luma_event_id: raw.lumaEventId },
              'failed to store raw luma event; continuing',
            );
          }
        }
        log.info(
          { events_discovered: discovered, raw_stored: stored.length, failures: failed },
          'discover-and-store-raw complete',
        );
        return stored;
      },
    );

    // Step 2: normalize every stored raw record. One step.run per record so
    // a single normalization failure doesn't block the rest of the batch.
    const normalized: NormalizedRecord[] = [];
    let normalizeFailures = 0;
    for (const item of persisted) {
      try {
        const records = await step.run(`normalize-${item.lumaEventId}`, async () => {
          return await adapter.normalize(item.rawId);
        });
        normalized.push(...records);
      } catch (cause) {
        normalizeFailures += 1;
        log.warn(
          { err: cause, luma_event_id: item.lumaEventId, raw_id: item.rawId },
          'normalization failed; continuing',
        );
      }
    }

    // Step 3: hand off to the identity-resolution trigger. In Phase 1C this
    // emits a `normalization.batch.ready` event; for now it logs counts so
    // operators can see ingestion is healthy in the Inngest dashboard.
    const stats: FetchStats = await step.run('report-counts', async () => {
      const eventRecords = normalized.filter((r) => r.recordType === 'event').length;
      const personRecords = normalized.filter((r) => r.recordType === 'person').length;
      const result: FetchStats = {
        events_discovered: persisted.length,
        raw_stored: persisted.filter((p) => !p.existed).length,
        raw_existed: persisted.filter((p) => p.existed).length,
        normalized_records: normalized.length,
        event_records: eventRecords,
        person_records: personRecords,
        failures: normalizeFailures,
      };
      log.info(result, 'luma-fetch-events finished');
      return result;
    });

    return stats;
  },
);
