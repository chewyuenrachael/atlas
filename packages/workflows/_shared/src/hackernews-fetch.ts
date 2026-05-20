/**
 * `hackernews-fetch` — Inngest function that polls the Algolia HN Search API
 * for Cursor mentions every 30 minutes (SPEC.md §5.2.6).
 *
 * Phase 2 wiring is in-memory only — the HN raw store has no Supabase
 * backing yet (the corresponding `packages/db/queries/communication.ts`
 * helpers will land alongside Communication entity ingestion). This file is
 * structured so the Supabase swap is a one-line change at adapter
 * construction:
 *
 *   const adapter = new HackerNewsAdapter({ store: new SupabaseRawHackerNewsStore() });
 *
 * Two entry points are exposed:
 *
 *   - {@link runHackernewsFetch} — pure async function used by integration
 *     tests and ad-hoc scripts. Same logic, no Inngest orchestration.
 *   - {@link hackernewsFetch} — Inngest function on a 30-minute cron
 *     wrapping the same logic in `step.run(...)` calls.
 *
 * SPEC ref: SPEC.md §5.2.6 (HN source), §5.3 (pipeline orchestration),
 * §5.4 (idempotency), §8.3 (workflow extension).
 */
import {
  HackerNewsAdapter,
  InMemoryRawHackerNewsStore,
  type RawHackerNewsItem,
  type RawHackerNewsStore,
} from '@atlas/adapter-hackernews';
import { logger, type Logger, type NormalizedRecord } from '@atlas/core';
import { inngest } from './inngest-client.js';

// ---------------------------------------------------------------------------
// Pipeline stats
// ---------------------------------------------------------------------------

/** Counters returned by the workflow for observability + smoke tests. */
export interface HackernewsFetchStats {
  items_discovered: number;
  raw_inserted: number;
  raw_existed: number;
  raw_persist_failures: number;
  normalized_records: number;
  communication_records: number;
  person_records: number;
  normalize_failures: number;
  /** Items that normalized to zero records (deleted / dead). */
  items_skipped: number;
}

function emptyStats(): HackernewsFetchStats {
  return {
    items_discovered: 0,
    raw_inserted: 0,
    raw_existed: 0,
    raw_persist_failures: 0,
    normalized_records: 0,
    communication_records: 0,
    person_records: 0,
    normalize_failures: 0,
    items_skipped: 0,
  };
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Workflow dependency surface. Every field has a sensible default so the
 * Inngest function can construct itself without arguments, but tests can
 * inject their own adapter / store to avoid live network calls.
 */
export interface HackernewsFetchDeps {
  /** Adapter instance. Defaults to a new `HackerNewsAdapter` with an in-memory store. */
  adapter?: HackerNewsAdapter;
  /** Raw store used to construct the default adapter. */
  rawStore?: RawHackerNewsStore;
  /** Stop after `limit` raw items. Useful for backfill smoke tests. */
  limit?: number;
  /** Optional logger override. */
  logger?: Logger;
}

interface ResolvedDeps {
  adapter: HackerNewsAdapter;
  log: Logger;
  limit: number | undefined;
}

function resolveDeps(deps: HackernewsFetchDeps = {}): ResolvedDeps {
  const log = deps.logger ?? logger.child({ workflow: 'hackernews-fetch' });
  // The HN adapter currently only supports the in-memory store — swap in a
  // Supabase-backed store here when one lands.
  const rawStore = deps.rawStore ?? new InMemoryRawHackerNewsStore();
  const adapter = deps.adapter ?? new HackerNewsAdapter({ store: rawStore });
  return {
    adapter,
    log,
    limit: deps.limit,
  };
}

// ---------------------------------------------------------------------------
// Phase functions
// ---------------------------------------------------------------------------

interface PersistedRaw {
  rawId: string;
  hnItemId: string;
  existed: boolean;
}

async function phaseDiscoverAndStore(
  deps: ResolvedDeps,
  stats: HackernewsFetchStats,
): Promise<PersistedRaw[]> {
  const persisted: PersistedRaw[] = [];
  for await (const raw of deps.adapter.fetch()) {
    stats.items_discovered += 1;
    try {
      const { rawId } = await deps.adapter.storeRaw(raw);
      // The InMemory store internally distinguishes existed/new, but the
      // public `storeRaw` signature collapses it. We re-derive `existed` by
      // peeking at the store on the next read in tests — for now we count
      // every successful store as inserted, which is conservative.
      stats.raw_inserted += 1;
      persisted.push({ rawId, hnItemId: raw.hnItemId, existed: false });
    } catch (cause) {
      stats.raw_persist_failures += 1;
      deps.log.warn(
        { err: cause, hn_item_id: raw.hnItemId },
        'failed to persist raw hackernews item; skipping',
      );
    }
    if (deps.limit !== undefined && persisted.length >= deps.limit) {
      deps.log.info({ limit: deps.limit }, 'limit reached; stopping discovery');
      break;
    }
  }
  deps.log.info(
    {
      items_discovered: stats.items_discovered,
      raw_inserted: stats.raw_inserted,
      raw_persist_failures: stats.raw_persist_failures,
    },
    'phase 1 complete: discover-and-store-raw',
  );
  return persisted;
}

async function phaseNormalize(
  deps: ResolvedDeps,
  persisted: PersistedRaw[],
  stats: HackernewsFetchStats,
): Promise<NormalizedRecord[]> {
  const all: NormalizedRecord[] = [];
  for (const item of persisted) {
    try {
      const records = await deps.adapter.normalize(item.rawId);
      if (records.length === 0) stats.items_skipped += 1;
      stats.normalized_records += records.length;
      for (const r of records) {
        if (r.recordType === 'communication') stats.communication_records += 1;
        if (r.recordType === 'person') stats.person_records += 1;
        all.push(r);
      }
    } catch (cause) {
      stats.normalize_failures += 1;
      deps.log.warn(
        { err: cause, hn_item_id: item.hnItemId, raw_id: item.rawId },
        'normalization failed; continuing',
      );
    }
  }
  deps.log.info(
    {
      normalized_records: stats.normalized_records,
      communication_records: stats.communication_records,
      person_records: stats.person_records,
      items_skipped: stats.items_skipped,
      normalize_failures: stats.normalize_failures,
    },
    'phase 2 complete: normalize',
  );
  return all;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Run the HN fetch pipeline end-to-end. Used by integration tests and the
 * Inngest function below.
 *
 * @example
 * ```ts
 * const stats = await runHackernewsFetch({ limit: 20 });
 * console.log(`fetched ${stats.items_discovered} items, ${stats.person_records} persons`);
 * ```
 */
export async function runHackernewsFetch(
  deps: HackernewsFetchDeps = {},
): Promise<HackernewsFetchStats> {
  const resolved = resolveDeps(deps);
  const stats = emptyStats();
  const persisted = await phaseDiscoverAndStore(resolved, stats);
  await phaseNormalize(resolved, persisted, stats);
  resolved.log.info(stats, 'hackernews-fetch finished');
  return stats;
}

/**
 * Inngest function — same logic as {@link runHackernewsFetch} but each phase
 * is wrapped in `step.run(...)` so retries are durable and re-runs are safe.
 *
 * Cron: every 30 minutes (SPEC.md §5.2.6).
 */
export const hackernewsFetch = inngest.createFunction(
  { id: 'hackernews-fetch', name: 'Hacker News — fetch Cursor mentions' },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    const deps = resolveDeps();
    const stats = emptyStats();

    const persisted = await step.run('discover-and-store-raw', async () => {
      return phaseDiscoverAndStore(deps, stats);
    });

    await step.run('normalize', async () => {
      await phaseNormalize(deps, persisted, stats);
    });

    return stats;
  },
);

// Re-export the raw envelope shape so backfill scripts can declare types
// without depending on the adapter package directly.
export type { RawHackerNewsItem };
