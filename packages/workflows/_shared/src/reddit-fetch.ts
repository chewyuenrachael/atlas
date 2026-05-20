/**
 * `reddit-fetch` — hourly Reddit ingestion workflow.
 *
 * Phase 2 wiring: this workflow polls the configured set of subreddits
 * (SPEC.md §5.2.5), persists raw posts and comments into an injected raw
 * store, and normalizes each into `Communication` + `Person`
 * `NormalizedRecord`s.
 *
 * Persistence boundary: this workflow ships against the in-memory raw
 * store provided by `@atlas/adapter-reddit`. The Supabase-backed store
 * will arrive in a follow-up PR once `RedditQueries.insertRawRedditItem`
 * lands — at that point the only change here is swapping the default
 * `new InMemoryRawRedditStore()` for the Supabase implementation. Once
 * that exists, the workflow can also be extended to call into the
 * identity resolver to attach persons (mirroring the Luma pipeline at
 * `luma-ingest-pipeline.ts`).
 *
 * Two entry points are exposed:
 *
 *   - {@link runRedditFetch} — pure async function used by the CLI smoke
 *     test and unit-level integration tests. Same logic, no Inngest
 *     orchestration.
 *   - {@link redditFetchWorkflow} — Inngest function wrapping the same
 *     logic in `step.run(...)` calls. Each step is idempotent so durable
 *     execution handles partial failure gracefully.
 *
 * SPEC ref: SPEC.md §5.2.5 (Reddit source contract), §5.3 (pipeline
 * orchestration), §5.4 (idempotency), §8.3 (workflow extension).
 */
import {
  InMemoryRawRedditStore,
  RedditAdapter,
  type RawRedditItem,
  type RawRedditStore,
  type RedditAdapterOptions,
} from '@atlas/adapter-reddit';
import { logger, type Logger, type NormalizedRecord } from '@atlas/core';
import { inngest } from './inngest-client.js';

/** Shape of the per-run telemetry. */
export interface RedditFetchStats {
  posts_fetched: number;
  comments_fetched: number;
  raw_inserted: number;
  raw_existed: number;
  raw_persist_failures: number;
  normalized_records: number;
  communication_records: number;
  person_records: number;
  normalize_failures: number;
  deleted_authors: number;
  removed_bodies: number;
  /** Per-subreddit raw-item counts for dashboards. */
  per_subreddit: Record<string, number>;
}

function emptyStats(): RedditFetchStats {
  return {
    posts_fetched: 0,
    comments_fetched: 0,
    raw_inserted: 0,
    raw_existed: 0,
    raw_persist_failures: 0,
    normalized_records: 0,
    communication_records: 0,
    person_records: 0,
    normalize_failures: 0,
    deleted_authors: 0,
    removed_bodies: 0,
    per_subreddit: {},
  };
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface RedditFetchDeps {
  /** Adapter instance. Defaults to a fresh adapter wired to an in-memory store. */
  adapter?: RedditAdapter;
  /** Optional raw store override. Used when the default adapter is constructed. */
  rawStore?: RawRedditStore;
  /** Optional adapter options forwarded to the default adapter. */
  adapterOptions?: RedditAdapterOptions;
  /** Stop after `limit` raw items. Useful for backfill smoke tests. */
  limit?: number;
  /** Optional logger override. */
  logger?: Logger;
}

interface ResolvedDeps {
  adapter: RedditAdapter;
  rawStore: RawRedditStore;
  log: Logger;
  limit: number | undefined;
}

function resolveDeps(deps: RedditFetchDeps = {}): ResolvedDeps {
  const log = deps.logger ?? logger.child({ workflow: 'reddit-fetch' });
  const rawStore = deps.rawStore ?? new InMemoryRawRedditStore();
  const adapter =
    deps.adapter ??
    new RedditAdapter({
      ...(deps.adapterOptions ?? {}),
      store: rawStore,
    });
  return {
    adapter,
    rawStore,
    log,
    limit: deps.limit,
  };
}

// ---------------------------------------------------------------------------
// Phase functions
// ---------------------------------------------------------------------------

interface PersistedRaw {
  rawId: string;
  thingId: string;
  kind: RawRedditItem['kind'];
  subreddit: string;
  existed: boolean;
}

async function phaseDiscoverAndStore(
  deps: ResolvedDeps,
  stats: RedditFetchStats,
): Promise<PersistedRaw[]> {
  const persisted: PersistedRaw[] = [];
  for await (const raw of deps.adapter.fetch()) {
    if (raw.kind === 't3') stats.posts_fetched += 1;
    else stats.comments_fetched += 1;
    stats.per_subreddit[raw.subreddit] = (stats.per_subreddit[raw.subreddit] ?? 0) + 1;
    if (raw.envelope.data.author === '[deleted]') stats.deleted_authors += 1;
    if (isRemovedBody(raw)) stats.removed_bodies += 1;
    try {
      const { rawId, existed } = await deps.rawStore.insert(raw);
      if (existed) stats.raw_existed += 1;
      else stats.raw_inserted += 1;
      persisted.push({
        rawId,
        thingId: raw.thingId,
        kind: raw.kind,
        subreddit: raw.subreddit,
        existed,
      });
    } catch (cause) {
      stats.raw_persist_failures += 1;
      deps.log.warn(
        { err: cause, thing_id: raw.thingId },
        'failed to persist raw reddit item; skipping',
      );
    }
    if (deps.limit !== undefined && persisted.length >= deps.limit) {
      deps.log.info({ limit: deps.limit }, 'limit reached; stopping discovery');
      break;
    }
  }
  deps.log.info(
    {
      posts_fetched: stats.posts_fetched,
      comments_fetched: stats.comments_fetched,
      raw_inserted: stats.raw_inserted,
      raw_existed: stats.raw_existed,
      raw_persist_failures: stats.raw_persist_failures,
    },
    'phase 1 complete: discover-and-store-raw',
  );
  return persisted;
}

async function phaseNormalize(
  deps: ResolvedDeps,
  persisted: PersistedRaw[],
  stats: RedditFetchStats,
): Promise<NormalizedRecord[]> {
  const out: NormalizedRecord[] = [];
  for (const item of persisted) {
    try {
      const records = await deps.adapter.normalize(item.rawId);
      stats.normalized_records += records.length;
      for (const r of records) {
        if (r.recordType === 'communication') stats.communication_records += 1;
        if (r.recordType === 'person') stats.person_records += 1;
      }
      out.push(...records);
    } catch (cause) {
      stats.normalize_failures += 1;
      deps.log.warn(
        { err: cause, thing_id: item.thingId, raw_id: item.rawId },
        'normalization failed; continuing',
      );
    }
  }
  deps.log.info(
    {
      normalized_records: stats.normalized_records,
      communication_records: stats.communication_records,
      person_records: stats.person_records,
      normalize_failures: stats.normalize_failures,
    },
    'phase 2 complete: normalize',
  );
  return out;
}

function isRemovedBody(raw: RawRedditItem): boolean {
  if (raw.envelope.kind === 't3') {
    const text = raw.envelope.data.selftext ?? '';
    return text === '[removed]' || text === '[deleted]';
  }
  const body = raw.envelope.data.body;
  return body === '[removed]' || body === '[deleted]';
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Run the full Phase 2 Reddit ingestion end-to-end. Used by the CLI and
 * by the Inngest function below (which wraps each phase in `step.run`).
 *
 * @example
 * ```ts
 * const stats = await runRedditFetch({ limit: 5 });
 * console.log(`posts: ${stats.posts_fetched}, persons: ${stats.person_records}`);
 * ```
 */
export async function runRedditFetch(deps: RedditFetchDeps = {}): Promise<RedditFetchStats> {
  const resolved = resolveDeps(deps);
  const stats = emptyStats();
  const persisted = await phaseDiscoverAndStore(resolved, stats);
  await phaseNormalize(resolved, persisted, stats);
  resolved.log.info(stats, 'reddit-fetch finished');
  return stats;
}

/**
 * Inngest function — same logic as {@link runRedditFetch} but each phase
 * is wrapped in `step.run(...)` so retries are durable and re-runs are
 * safe.
 *
 * Cron: hourly (SPEC.md §5.2.5).
 */
export const redditFetchWorkflow = inngest.createFunction(
  { id: 'reddit-fetch', name: 'Reddit — hourly ingest' },
  { cron: '0 * * * *' },
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
