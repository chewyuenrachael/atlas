/**
 * `reddit-ingest-pipeline` — Phase 2D end-to-end Reddit ingestion.
 *
 * Mirrors `luma-ingest-pipeline.ts`. See SPEC.md §5.2.5 for the source
 * contract.
 */
import {
  RedditAdapter,
  SupabaseRawRedditStore,
  type RawRedditItem,
} from '@atlas/adapter-reddit';
import {
  logger,
  type AtlasError,
  type Logger,
  type Metadata,
  type NormalizedRecord,
} from '@atlas/core';
import { CommunicationQueries, PersonQueries } from '@atlas/db';
import {
  IdentityResolver,
  SupabasePersonStore,
  SupabaseResolutionAuditStore,
  type NormalizedPersonPayload,
  type PersonStore,
  type ResolutionAuditStore,
  type ResolutionOutcome,
} from '@atlas/intelligence-identity-resolution';
import { inngest } from './inngest-client.js';

export interface RedditIngestStats {
  items_discovered: number;
  raw_inserted: number;
  raw_existed: number;
  raw_persist_failures: number;
  normalized_records: number;
  normalize_failures: number;
  items_skipped: number;
  persons_created: number;
  persons_merged: number;
  persons_skipped: number;
  persons_human_review: number;
  person_resolve_failures: number;
  communications_upserted: number;
  communication_upsert_failures: number;
  mentions_edges_created: number;
  mentions_edge_failures: number;
}

function emptyStats(): RedditIngestStats {
  return {
    items_discovered: 0,
    raw_inserted: 0,
    raw_existed: 0,
    raw_persist_failures: 0,
    normalized_records: 0,
    normalize_failures: 0,
    items_skipped: 0,
    persons_created: 0,
    persons_merged: 0,
    persons_skipped: 0,
    persons_human_review: 0,
    person_resolve_failures: 0,
    communications_upserted: 0,
    communication_upsert_failures: 0,
    mentions_edges_created: 0,
    mentions_edge_failures: 0,
  };
}

export interface RedditIngestDeps {
  adapter?: RedditAdapter;
  rawStore?: SupabaseRawRedditStore;
  resolver?: IdentityResolver;
  personStore?: PersonStore;
  auditStore?: ResolutionAuditStore;
  limit?: number;
  logger?: Logger;
}

interface ResolvedDeps {
  adapter: RedditAdapter;
  rawStore: SupabaseRawRedditStore;
  resolver: IdentityResolver;
  log: Logger;
  limit: number | undefined;
}

function resolveDeps(deps: RedditIngestDeps = {}): ResolvedDeps {
  const log = deps.logger ?? logger.child({ workflow: 'reddit-ingest-pipeline' });
  const rawStore = deps.rawStore ?? new SupabaseRawRedditStore();
  const adapter = deps.adapter ?? new RedditAdapter({ store: rawStore });
  const personStore = deps.personStore ?? new SupabasePersonStore();
  const auditStore = deps.auditStore ?? new SupabaseResolutionAuditStore();
  const resolver =
    deps.resolver ??
    new IdentityResolver({ store: personStore, audit: auditStore, logger: log });
  return { adapter, rawStore, resolver, log, limit: deps.limit };
}

interface PersistedRaw {
  rawId: string;
  thingId: string;
  existed: boolean;
}

async function phaseDiscoverAndStore(
  deps: ResolvedDeps,
  stats: RedditIngestStats,
): Promise<PersistedRaw[]> {
  const persisted: PersistedRaw[] = [];
  for await (const raw of deps.adapter.fetch()) {
    stats.items_discovered += 1;
    try {
      const { rawId, existed } = await deps.rawStore.insert(raw);
      if (existed) stats.raw_existed += 1;
      else stats.raw_inserted += 1;
      persisted.push({ rawId, thingId: raw.thingId, existed });
    } catch (cause) {
      stats.raw_persist_failures += 1;
      deps.log.warn({ err: cause, thing_id: raw.thingId }, 'failed to persist raw reddit item');
    }
    if (deps.limit !== undefined && persisted.length >= deps.limit) break;
  }
  deps.log.info(
    {
      items_discovered: stats.items_discovered,
      raw_inserted: stats.raw_inserted,
      raw_existed: stats.raw_existed,
    },
    'phase 1 complete',
  );
  return persisted;
}

interface NormalizedBucket {
  rawId: string;
  thingId: string;
  records: NormalizedRecord[];
}

async function phaseNormalize(
  deps: ResolvedDeps,
  persisted: PersistedRaw[],
  stats: RedditIngestStats,
): Promise<NormalizedBucket[]> {
  const out: NormalizedBucket[] = [];
  for (const item of persisted) {
    try {
      const records = await deps.adapter.normalize(item.rawId);
      if (records.length === 0) stats.items_skipped += 1;
      stats.normalized_records += records.length;
      out.push({ rawId: item.rawId, thingId: item.thingId, records });
    } catch (cause) {
      stats.normalize_failures += 1;
      await deps.rawStore.markFailed(item.rawId, formatErr(cause)).catch(() => undefined);
      deps.log.warn(
        { err: cause, thing_id: item.thingId, raw_id: item.rawId },
        'normalization failed',
      );
    }
  }
  return out;
}

async function phaseResolveAndPersist(
  deps: ResolvedDeps,
  buckets: NormalizedBucket[],
  stats: RedditIngestStats,
): Promise<void> {
  const personIdByRedditHandle = new Map<string, string>();
  const authorByThingId = new Map<string, string>();

  for (const bucket of buckets) {
    const personRecords = bucket.records.filter((r) => r.recordType === 'person');
    for (const personRecord of personRecords) {
      const transformed = toResolverPersonRecord(personRecord);
      let outcome: ResolutionOutcome | null = null;
      try {
        const r = await deps.resolver.resolve(transformed);
        if (!r.ok) {
          stats.person_resolve_failures += 1;
          deps.log.warn(
            { err: r.error, source_id: transformed.sourceRecordId },
            'resolver returned err',
          );
          continue;
        }
        outcome = r.value;
      } catch (cause) {
        stats.person_resolve_failures += 1;
        deps.log.warn(
          { err: cause, source_id: transformed.sourceRecordId },
          'identity resolution threw',
        );
        continue;
      }
      bumpOutcomeCounts(stats, outcome);
      const personId = outcome.personId;
      if (!personId) continue;
      const handle = (personRecord.payload as { reddit_handle?: string }).reddit_handle;
      if (handle) personIdByRedditHandle.set(handle.toLowerCase(), personId);
      authorByThingId.set(bucket.thingId, personId);
    }
  }

  for (const bucket of buckets) {
    const commRecords = bucket.records.filter((r) => r.recordType === 'communication');
    for (const commRecord of commRecords) {
      const payload = commRecord.payload as RedditCommunicationPayload;
      const authorPersonId = authorByThingId.get(bucket.thingId) ?? null;
      const body = (payload.body ?? '') + ' ' + (payload.title ?? '');
      const result = await CommunicationQueries.createCommunication({
        source_platform: 'reddit',
        source_record_id: commRecord.sourceRecordId,
        author_person_id: authorPersonId,
        author_handle_raw: payload.author_username ?? '[deleted]',
        content_text: body.trim(),
        content_url: payload.permalink ?? null,
        posted_at: (payload.created_at as string) ?? (commRecord.observedAt as string),
        sentiment_score: null,
        topic_tags: [],
        vertical_tags: [],
        engagement_likes: payload.score ?? 0,
        engagement_replies: payload.num_comments ?? 0,
        engagement_shares: 0,
        engagement_views: null,
        is_about_cursor: !!payload.cursor_relevance_matched,
        cursor_relevance_score: payload.cursor_relevance_score ?? null,
      });
      if (!result.ok) {
        stats.communication_upsert_failures += 1;
        deps.log.warn(
          { err: result.error, thing_id: bucket.thingId },
          'communication upsert failed',
        );
        continue;
      }
      stats.communications_upserted += 1;

      if (authorPersonId) {
        const mentions = extractRedditMentions(body, payload.author_username ?? '');
        for (const handle of mentions) {
          const targetId = personIdByRedditHandle.get(handle.toLowerCase());
          if (!targetId || targetId === authorPersonId) continue;
          const edge = await PersonQueries.upsertPersonPersonEdge({
            source_person_id: authorPersonId,
            target_person_id: targetId,
            edge_type: 'mentions',
            metadata: { via: 'reddit', thing_id: bucket.thingId },
          });
          if (!edge.ok) {
            stats.mentions_edge_failures += 1;
          } else {
            stats.mentions_edges_created += 1;
          }
        }
      }
    }
  }
}

interface RedditCommunicationPayload extends Metadata {
  thing_id?: string;
  kind?: string;
  subreddit?: string;
  title?: string | null;
  body?: string | null;
  author_username?: string | null;
  author_deleted?: boolean;
  score?: number | null;
  created_at?: string | null;
  permalink?: string | null;
  cursor_relevance_score?: number | null;
  cursor_relevance_matched?: boolean | null;
  num_comments?: number | null;
}

interface RedditPersonPayload extends Metadata {
  canonical_name?: string;
  names_seen?: string[];
  reddit_handle?: string;
  reddit_profile_url?: string;
  platform_identities?: Array<{ platform: 'reddit'; handle: string; profile_url: string }>;
}

function toResolverPersonRecord(
  record: NormalizedRecord,
): NormalizedRecord<NormalizedPersonPayload> & { recordType: 'person' } {
  const src = record.payload as RedditPersonPayload;
  const identity = src.platform_identities?.[0];
  const payload: NormalizedPersonPayload = {
    canonicalName: src.canonical_name,
    namesSeen: src.names_seen ?? (src.canonical_name ? [src.canonical_name] : []),
    metadata: {
      reddit_handle: src.reddit_handle ?? null,
      reddit_profile_url: src.reddit_profile_url ?? null,
      source: 'reddit',
    },
  };
  if (identity) {
    payload.platformIdentity = {
      platform: identity.platform,
      handle: identity.handle,
      profileUrl: identity.profile_url,
    };
  }
  return {
    recordType: 'person',
    sourcePlatform: record.sourcePlatform,
    sourceRecordId: record.sourceRecordId,
    payload,
    observedAt: record.observedAt,
  };
}

function bumpOutcomeCounts(stats: RedditIngestStats, outcome: ResolutionOutcome): void {
  switch (outcome.action) {
    case 'merge':
      stats.persons_merged += 1;
      break;
    case 'create_new':
      stats.persons_created += 1;
      break;
    case 'human_review':
      stats.persons_human_review += 1;
      break;
    case 'skip':
      stats.persons_skipped += 1;
      break;
  }
}

/** Extract `u/handle` and `/u/handle` mentions from a Reddit body. */
function extractRedditMentions(body: string, authorHandle: string): string[] {
  const hits = new Set<string>();
  const author = authorHandle.toLowerCase();
  for (const m of body.matchAll(/(?:^|\W)\/?u\/([A-Za-z0-9_-]{3,})/g)) {
    if (m[1]) hits.add(m[1].toLowerCase());
  }
  hits.delete(author);
  return [...hits];
}

export async function runRedditIngest(
  deps: RedditIngestDeps = {},
): Promise<RedditIngestStats> {
  const resolved = resolveDeps(deps);
  const stats = emptyStats();
  const persisted = await phaseDiscoverAndStore(resolved, stats);
  const buckets = await phaseNormalize(resolved, persisted, stats);
  await phaseResolveAndPersist(resolved, buckets, stats);
  resolved.log.info(stats, 'reddit-ingest-pipeline finished');
  return stats;
}

export const redditIngestPipeline = inngest.createFunction(
  { id: 'reddit-ingest-pipeline', name: 'Reddit — end-to-end ingest pipeline' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const deps = resolveDeps();
    const stats = emptyStats();
    const persisted = await step.run('discover-and-store-raw', () =>
      phaseDiscoverAndStore(deps, stats),
    );
    const buckets = await step.run('normalize', () => phaseNormalize(deps, persisted, stats));
    await step.run('resolve-and-persist', () => phaseResolveAndPersist(deps, buckets, stats));
    return stats;
  },
);

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export type { AtlasError, RawRedditItem };
