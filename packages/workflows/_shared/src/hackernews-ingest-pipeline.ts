/**
 * `hackernews-ingest-pipeline` — Phase 2D end-to-end HN ingestion.
 *
 * Mirrors `luma-ingest-pipeline.ts`. Stages (SPEC.md §6.1):
 *
 *   1. Fetch via `HackerNewsAdapter` against the Algolia API.
 *   2. Persist raw envelopes into `raw_hackernews_item` (via
 *      `SupabaseRawHackerNewsStore`).
 *   3. Normalize each raw row into Communication + Person `NormalizedRecord`s.
 *   4. Resolve every Person through `IdentityResolver` (Supabase-backed).
 *   5. Persist the Communication row, attributing it to the resolved Person.
 *   6. Generate `person_person_edge` (mentions) rows where the body mentions
 *      another known HN handle.
 *
 * SPEC ref: §5.2.6 (HN source), §5.3 (orchestration), §5.4 (idempotency).
 */
import {
  HackerNewsAdapter,
  SupabaseRawHackerNewsStore,
  type RawHackerNewsItem,
} from '@atlas/adapter-hackernews';
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

export interface HackerNewsIngestStats {
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

function emptyStats(): HackerNewsIngestStats {
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

export interface HackerNewsIngestDeps {
  adapter?: HackerNewsAdapter;
  rawStore?: SupabaseRawHackerNewsStore;
  resolver?: IdentityResolver;
  personStore?: PersonStore;
  auditStore?: ResolutionAuditStore;
  limit?: number;
  logger?: Logger;
}

interface ResolvedDeps {
  adapter: HackerNewsAdapter;
  rawStore: SupabaseRawHackerNewsStore;
  resolver: IdentityResolver;
  log: Logger;
  limit: number | undefined;
}

function resolveDeps(deps: HackerNewsIngestDeps = {}): ResolvedDeps {
  const log = deps.logger ?? logger.child({ workflow: 'hackernews-ingest-pipeline' });
  const rawStore = deps.rawStore ?? new SupabaseRawHackerNewsStore();
  const adapter = deps.adapter ?? new HackerNewsAdapter({ store: rawStore });
  const personStore = deps.personStore ?? new SupabasePersonStore();
  const auditStore = deps.auditStore ?? new SupabaseResolutionAuditStore();
  const resolver =
    deps.resolver ??
    new IdentityResolver({ store: personStore, audit: auditStore, logger: log });
  return { adapter, rawStore, resolver, log, limit: deps.limit };
}

interface PersistedRaw {
  rawId: string;
  hnItemId: string;
  existed: boolean;
}

async function phaseDiscoverAndStore(
  deps: ResolvedDeps,
  stats: HackerNewsIngestStats,
): Promise<PersistedRaw[]> {
  const persisted: PersistedRaw[] = [];
  for await (const raw of deps.adapter.fetch()) {
    stats.items_discovered += 1;
    try {
      const { rawId, existed } = await deps.rawStore.insert(raw);
      if (existed) stats.raw_existed += 1;
      else stats.raw_inserted += 1;
      persisted.push({ rawId, hnItemId: raw.hnItemId, existed });
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
      raw_existed: stats.raw_existed,
      raw_persist_failures: stats.raw_persist_failures,
    },
    'phase 1 complete',
  );
  return persisted;
}

interface NormalizedBucket {
  rawId: string;
  hnItemId: string;
  records: NormalizedRecord[];
}

async function phaseNormalize(
  deps: ResolvedDeps,
  persisted: PersistedRaw[],
  stats: HackerNewsIngestStats,
): Promise<NormalizedBucket[]> {
  const out: NormalizedBucket[] = [];
  for (const item of persisted) {
    try {
      const records = await deps.adapter.normalize(item.rawId);
      if (records.length === 0) stats.items_skipped += 1;
      stats.normalized_records += records.length;
      out.push({ rawId: item.rawId, hnItemId: item.hnItemId, records });
    } catch (cause) {
      stats.normalize_failures += 1;
      await deps.rawStore.markFailed(item.rawId, formatErr(cause)).catch((subCause: unknown) =>
        deps.log.warn({ err: subCause, raw_id: item.rawId }, 'markFailed failed'),
      );
      deps.log.warn(
        { err: cause, hn_item_id: item.hnItemId, raw_id: item.rawId },
        'normalization failed; continuing',
      );
    }
  }
  deps.log.info(
    {
      normalized_records: stats.normalized_records,
      normalize_failures: stats.normalize_failures,
      items_skipped: stats.items_skipped,
    },
    'phase 2 complete',
  );
  return out;
}

/**
 * Phase 3: resolve every Person, persist the Communication row, generate
 * `mentions` edges to other Persons whose HN handle appears in the body.
 *
 * Returns the per-item resolved-person map for downstream stats.
 */
async function phaseResolveAndPersist(
  deps: ResolvedDeps,
  buckets: NormalizedBucket[],
  stats: HackerNewsIngestStats,
): Promise<void> {
  // Per-bucket: resolve → write comm immediately, so if the script crashes we
  // still have durable progress for completed buckets. Build hn-handle and
  // hn-item indices for the deferred edge-generation pass.
  const personIdByHnHandle = new Map<string, string>();
  const authorByHnItem = new Map<string, string>();
  const storyIdByHnItem = new Map<string, string>(); // hnItemId → parent story_id
  const parentByHnItem = new Map<string, string>(); // hnItemId → parent_id

  for (const bucket of buckets) {
    const personRecords = bucket.records.filter((r) => r.recordType === 'person');
    let authorPersonId: string | null = null;
    for (const personRecord of personRecords) {
      const transformed = toResolverPersonRecord(personRecord);
      let outcome: ResolutionOutcome | null = null;
      try {
        const r = await deps.resolver.resolve(transformed);
        if (!r.ok) {
          stats.person_resolve_failures += 1;
          deps.log.warn({ err: r.error, source_id: transformed.sourceRecordId }, 'resolver err');
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
      authorPersonId = personId;
      const hnHandle = (personRecord.payload as { hn_handle?: string }).hn_handle;
      if (hnHandle) personIdByHnHandle.set(hnHandle.toLowerCase(), personId);
      authorByHnItem.set(bucket.hnItemId, personId);
    }

    // Communication write happens immediately so partial progress is durable.
    const commRecords = bucket.records.filter((r) => r.recordType === 'communication');
    for (const commRecord of commRecords) {
      const payload = commRecord.payload as HackerNewsCommunicationPayload;
      if (payload.story_id) storyIdByHnItem.set(bucket.hnItemId, payload.story_id);
      if (payload.parent_id) parentByHnItem.set(bucket.hnItemId, payload.parent_id);

      const result = await CommunicationQueries.createCommunication({
        source_platform: 'hackernews',
        source_record_id: commRecord.sourceRecordId,
        author_person_id: authorPersonId,
        author_handle_raw: payload.author_handle ?? '',
        content_text: payload.content_text ?? payload.title ?? '',
        content_url: payload.content_url ?? null,
        posted_at: (payload.posted_at as string) ?? (commRecord.observedAt as string),
        sentiment_score: null,
        topic_tags: payload.topic_tags ?? [],
        vertical_tags: [],
        engagement_likes: payload.points ?? 0,
        engagement_replies: payload.num_comments ?? 0,
        engagement_shares: 0,
        engagement_views: null,
        is_about_cursor: payload.is_about_cursor ?? true,
        cursor_relevance_score: null,
      });
      if (!result.ok) {
        stats.communication_upsert_failures += 1;
        deps.log.warn(
          { err: result.error, hn_item_id: bucket.hnItemId },
          'communication upsert failed',
        );
        continue;
      }
      stats.communications_upserted += 1;

      // Generate mentions edges where the body references a known HN handle.
      if (authorPersonId) {
        const body = (payload.content_text ?? '') + ' ' + (payload.title ?? '');
        const mentions = extractHnMentions(body, payload.author_handle ?? '');
        for (const handle of mentions) {
          const targetId = personIdByHnHandle.get(handle.toLowerCase());
          if (!targetId || targetId === authorPersonId) continue;
          const edge = await PersonQueries.upsertPersonPersonEdge({
            source_person_id: authorPersonId,
            target_person_id: targetId,
            edge_type: 'mentions',
            metadata: { via: 'hackernews', hn_item_id: bucket.hnItemId },
          });
          if (!edge.ok) {
            stats.mentions_edge_failures += 1;
            deps.log.warn({ err: edge.error }, 'mentions edge insert failed');
          } else {
            stats.mentions_edges_created += 1;
          }
        }
      }
    }
  }

  // Final pass: generate `replies_to` edges from HN parent_id linkages.
  // When two comments share the same parent (i.e. they are direct siblings in
  // a thread), or when comment A's parent_id is comment B's hn_item_id, draw
  // a `replies_to` edge between their authors.
  for (const [hnItemId, parentId] of parentByHnItem) {
    const sourceId = authorByHnItem.get(hnItemId);
    const targetId = authorByHnItem.get(parentId);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const edge = await PersonQueries.upsertPersonPersonEdge({
      source_person_id: sourceId,
      target_person_id: targetId,
      edge_type: 'replies_to',
      metadata: { via: 'hackernews', child_hn_item_id: hnItemId, parent_hn_item_id: parentId },
    });
    if (!edge.ok) {
      stats.mentions_edge_failures += 1;
    } else {
      stats.mentions_edges_created += 1;
    }
  }
  // Suppress unused-variable warning — kept for potential future co-thread edges.
  void storyIdByHnItem;

  deps.log.info(
    {
      persons_created: stats.persons_created,
      persons_merged: stats.persons_merged,
      communications_upserted: stats.communications_upserted,
      mentions_edges_created: stats.mentions_edges_created,
    },
    'phase 3 complete',
  );
}

interface HackerNewsCommunicationPayload extends Metadata {
  hn_item_id?: string;
  item_type?: string;
  title?: string | null;
  author_handle?: string | null;
  content_text?: string | null;
  content_url?: string | null;
  posted_at?: string | null;
  points?: number | null;
  num_comments?: number | null;
  story_id?: string | null;
  parent_id?: string | null;
  topic_tags?: string[];
  is_about_cursor?: boolean;
}

interface HackerNewsPersonPayload extends Metadata {
  canonical_name?: string;
  names_seen?: string[];
  hn_handle?: string;
  hn_profile_url?: string;
  platform_identities?: Array<{ platform: 'hackernews'; handle: string; profile_url: string }>;
}

function toResolverPersonRecord(
  record: NormalizedRecord,
): NormalizedRecord<NormalizedPersonPayload> & { recordType: 'person' } {
  const src = record.payload as HackerNewsPersonPayload;
  const identity = src.platform_identities?.[0];

  const payload: NormalizedPersonPayload = {
    canonicalName: src.canonical_name,
    namesSeen: src.names_seen ?? (src.canonical_name ? [src.canonical_name] : []),
    metadata: {
      hn_handle: src.hn_handle ?? null,
      hn_profile_url: src.hn_profile_url ?? null,
      source: 'hackernews',
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

function bumpOutcomeCounts(stats: HackerNewsIngestStats, outcome: ResolutionOutcome): void {
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

/**
 * Extract `@handle` and HN-style links to other users from a comment body.
 * Returns the handles in lowercase, deduplicated, with the author omitted.
 */
function extractHnMentions(body: string, authorHandle: string): string[] {
  const hits = new Set<string>();
  const author = authorHandle.toLowerCase();
  // 1. `@handle` mentions (common in HN replies)
  for (const m of body.matchAll(/@([A-Za-z0-9_-]{2,})\b/g)) {
    if (m[1]) hits.add(m[1].toLowerCase());
  }
  // 2. HN user-profile URLs (`/user?id=handle`)
  for (const m of body.matchAll(/user\?id=([A-Za-z0-9_-]{2,})/g)) {
    if (m[1]) hits.add(m[1].toLowerCase());
  }
  hits.delete(author);
  return [...hits];
}

export async function runHackerNewsIngest(
  deps: HackerNewsIngestDeps = {},
): Promise<HackerNewsIngestStats> {
  const resolved = resolveDeps(deps);
  const stats = emptyStats();
  const persisted = await phaseDiscoverAndStore(resolved, stats);
  const buckets = await phaseNormalize(resolved, persisted, stats);
  await phaseResolveAndPersist(resolved, buckets, stats);
  resolved.log.info(stats, 'hackernews-ingest-pipeline finished');
  return stats;
}

export const hackernewsIngestPipeline = inngest.createFunction(
  { id: 'hackernews-ingest-pipeline', name: 'Hacker News — end-to-end ingest pipeline' },
  { cron: '*/30 * * * *' },
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

export type { AtlasError, RawHackerNewsItem };
