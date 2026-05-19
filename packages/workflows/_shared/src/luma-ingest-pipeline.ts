/**
 * `luma-ingest-pipeline` — end-to-end Luma ingestion workflow.
 *
 * Phase 1D wiring: this is the production pipeline that connects every layer
 * of SPEC.md Phase 1:
 *
 *   1. Discover events on the Luma community page (Phase 1B adapter).
 *   2. Persist raw events into `raw_luma_event` (Phase 1A schema + Supabase
 *      store).
 *   3. Normalize each raw row into Event + Person `NormalizedRecord`s
 *      (Phase 1B normalizer).
 *   4. Upsert the Event row by `luma_event_id` (Phase 1A `event` table).
 *   5. Run each Person record through the identity resolver (Phase 1C
 *      `IdentityResolver` against the Supabase-backed `PersonStore`).
 *   6. Create `person_event` edges with role=`organizer` for every resolved
 *      Person.
 *
 * Two entry points are exposed:
 *
 *   - {@link runLumaIngest} — pure async function used by the backfill
 *     script and unit-level integration tests. Same logic, no Inngest
 *     orchestration.
 *   - {@link lumaIngestPipeline} — Inngest function wrapping the same logic
 *     in `step.run(...)` calls. Each step is idempotent so durable execution
 *     handles partial failure gracefully.
 *
 * SPEC ref: SPEC.md §5.3 (pipeline orchestration), §5.4 (idempotency),
 * §8.3 (workflow extension), §11 Phase 1 exit criteria.
 */
import {
  LumaAdapter,
  SupabaseRawLumaStore,
  type RawLumaEvent,
  type ScrapedEventDetail,
} from '@atlas/adapter-luma';
import {
  logger,
  type AtlasError,
  type Logger,
  type Metadata,
  type NormalizedRecord,
} from '@atlas/core';
import { EventQueries } from '@atlas/db';
import {
  IdentityResolver,
  SupabasePersonStore,
  SupabaseResolutionAuditStore,
  findEventIdByLumaId,
  type NormalizedPersonPayload,
  type PersonStore,
  type ResolutionAuditStore,
  type ResolutionOutcome,
} from '@atlas/intelligence-identity-resolution';
import { inngest } from './inngest-client.js';

// ---------------------------------------------------------------------------
// Pipeline result shape
// ---------------------------------------------------------------------------

export interface LumaIngestStats {
  events_discovered: number;
  raw_inserted: number;
  raw_existed: number;
  raw_persist_failures: number;
  events_upserted: number;
  event_upsert_failures: number;
  normalized_records: number;
  normalize_failures: number;
  persons_created: number;
  persons_merged: number;
  persons_skipped: number;
  persons_human_review: number;
  person_resolve_failures: number;
  organizer_edges_created: number;
  organizer_edge_failures: number;
}

function emptyStats(): LumaIngestStats {
  return {
    events_discovered: 0,
    raw_inserted: 0,
    raw_existed: 0,
    raw_persist_failures: 0,
    events_upserted: 0,
    event_upsert_failures: 0,
    normalized_records: 0,
    normalize_failures: 0,
    persons_created: 0,
    persons_merged: 0,
    persons_skipped: 0,
    persons_human_review: 0,
    person_resolve_failures: 0,
    organizer_edges_created: 0,
    organizer_edge_failures: 0,
  };
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface LumaIngestDeps {
  /** Adapter instance. Defaults to `new LumaAdapter({ store: new SupabaseRawLumaStore() })`. */
  adapter?: LumaAdapter;
  /** Resolver instance. Defaults to one wired to Supabase stores. */
  resolver?: IdentityResolver;
  /** Override the Supabase raw store (used by the default adapter). */
  rawStore?: SupabaseRawLumaStore;
  /** Override the Supabase person store (used by the default resolver). */
  personStore?: PersonStore;
  /** Override the Supabase audit store (used by the default resolver). */
  auditStore?: ResolutionAuditStore;
  /** Stop after `limit` raw events. Useful for backfill smoke tests. */
  limit?: number;
  /** Optional logger override. */
  logger?: Logger;
}

interface ResolvedDeps {
  adapter: LumaAdapter;
  resolver: IdentityResolver;
  rawStore: SupabaseRawLumaStore;
  log: Logger;
  limit: number | undefined;
}

function resolveDeps(deps: LumaIngestDeps = {}): ResolvedDeps {
  const log = deps.logger ?? logger.child({ workflow: 'luma-ingest-pipeline' });
  const rawStore = deps.rawStore ?? new SupabaseRawLumaStore();
  const adapter = deps.adapter ?? new LumaAdapter({ store: rawStore });
  const personStore = deps.personStore ?? new SupabasePersonStore();
  const auditStore = deps.auditStore ?? new SupabaseResolutionAuditStore();
  const resolver =
    deps.resolver ??
    new IdentityResolver({ store: personStore, audit: auditStore, logger: log });
  return {
    adapter,
    resolver,
    rawStore,
    log,
    limit: deps.limit,
  };
}

// ---------------------------------------------------------------------------
// Phase functions (each one a no-arg block so the Inngest workflow can wrap
// them in `step.run(...)` for durable execution).
// ---------------------------------------------------------------------------

interface PersistedRaw {
  rawId: string;
  lumaEventId: string;
  existed: boolean;
}

async function phaseDiscoverAndStore(
  deps: ResolvedDeps,
  stats: LumaIngestStats,
): Promise<PersistedRaw[]> {
  const persisted: PersistedRaw[] = [];
  for await (const raw of deps.adapter.fetch()) {
    stats.events_discovered += 1;
    try {
      // We bypass `adapter.storeRaw` here because it would call
      // `store.insert` and discard the `existed` flag returned by the store.
      // The store's insert is itself idempotent on `luma_event_id` (SPEC.md
      // §3.5) so we don't lose the safety the adapter usually provides.
      const { rawId, existed } = await deps.rawStore.insert(raw);
      if (existed) stats.raw_existed += 1;
      else stats.raw_inserted += 1;
      persisted.push({ rawId, lumaEventId: raw.lumaEventId, existed });
    } catch (cause) {
      stats.raw_persist_failures += 1;
      deps.log.warn(
        { err: cause, luma_event_id: raw.lumaEventId },
        'failed to persist raw luma event; skipping',
      );
    }
    if (deps.limit !== undefined && persisted.length >= deps.limit) {
      deps.log.info({ limit: deps.limit }, 'limit reached; stopping discovery');
      break;
    }
  }
  deps.log.info(
    {
      events_discovered: stats.events_discovered,
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
  stats: LumaIngestStats,
): Promise<Array<{ rawId: string; lumaEventId: string; records: NormalizedRecord[] }>> {
  const out: Array<{ rawId: string; lumaEventId: string; records: NormalizedRecord[] }> = [];
  for (const item of persisted) {
    try {
      const records = await deps.adapter.normalize(item.rawId);
      stats.normalized_records += records.length;
      out.push({ rawId: item.rawId, lumaEventId: item.lumaEventId, records });
    } catch (cause) {
      stats.normalize_failures += 1;
      // Best-effort: mark the raw row as failed so the verify script doesn't
      // see it stuck at `pending` forever.
      await deps.rawStore
        .markFailed(item.rawId, formatErr(cause))
        .catch((subCause: unknown) =>
          deps.log.warn({ err: subCause, raw_id: item.rawId }, 'markFailed failed'),
        );
      deps.log.warn(
        { err: cause, luma_event_id: item.lumaEventId, raw_id: item.rawId },
        'normalization failed; continuing',
      );
    }
  }
  deps.log.info(
    {
      normalized_records: stats.normalized_records,
      normalize_failures: stats.normalize_failures,
    },
    'phase 2 complete: normalize',
  );
  return out;
}

async function phaseUpsertEvents(
  deps: ResolvedDeps,
  normalized: Array<{ rawId: string; lumaEventId: string; records: NormalizedRecord[] }>,
  stats: LumaIngestStats,
): Promise<Map<string, string>> {
  // Map luma_event_id → atlas event.id, so we can attach person_event edges.
  const eventIdByLuma = new Map<string, string>();
  for (const item of normalized) {
    const eventRecord = item.records.find((r) => r.recordType === 'event');
    if (!eventRecord) continue;
    const payload = eventRecord.payload as Metadata;
    const input = buildEventUpsertInput(item.lumaEventId, payload);
    if (!input) {
      stats.event_upsert_failures += 1;
      deps.log.warn(
        { luma_event_id: item.lumaEventId },
        'event record missing required fields; skipping upsert',
      );
      continue;
    }
    const result = await EventQueries.upsertEventByLumaId(input);
    if (!result.ok) {
      stats.event_upsert_failures += 1;
      deps.log.warn(
        { err: result.error, luma_event_id: item.lumaEventId },
        'event upsert failed; skipping',
      );
      continue;
    }
    stats.events_upserted += 1;
    eventIdByLuma.set(item.lumaEventId, result.value.id);
  }
  deps.log.info(
    {
      events_upserted: stats.events_upserted,
      event_upsert_failures: stats.event_upsert_failures,
    },
    'phase 3 complete: upsert-events',
  );
  return eventIdByLuma;
}

async function phaseResolvePersonsAndAttach(
  deps: ResolvedDeps,
  normalized: Array<{ rawId: string; lumaEventId: string; records: NormalizedRecord[] }>,
  eventIdByLuma: Map<string, string>,
  stats: LumaIngestStats,
): Promise<void> {
  for (const item of normalized) {
    const personRecords = item.records.filter((r) => r.recordType === 'person');
    for (const personRecord of personRecords) {
      const transformed = toResolverPersonRecord(personRecord);
      let outcome: ResolutionOutcome | null = null;
      try {
        const result = await deps.resolver.resolve(transformed);
        if (!result.ok) {
          stats.person_resolve_failures += 1;
          deps.log.warn(
            { err: result.error, source_id: transformed.sourceRecordId },
            'identity resolution returned err',
          );
          continue;
        }
        outcome = result.value;
      } catch (cause) {
        stats.person_resolve_failures += 1;
        deps.log.warn(
          { err: cause, source_id: transformed.sourceRecordId },
          'identity resolution threw',
        );
        continue;
      }
      bumpOutcomeCounts(stats, outcome);

      // Phase 5: attach person_event organizer edge. We do this for both
      // `merge` and `create_new` outcomes — anything that produced a personId.
      const personId = outcome.personId;
      if (!personId) continue;
      const lumaEventId = (personRecord.payload as { luma_event_id?: string }).luma_event_id;
      if (!lumaEventId) continue;
      const eventId =
        eventIdByLuma.get(lumaEventId) ?? (await findEventIdByLumaId(lumaEventId));
      if (!eventId) continue;
      eventIdByLuma.set(lumaEventId, eventId);

      const edgeResult = await EventQueries.recordAttendance({
        person_id: personId,
        event_id: eventId,
        role: 'organizer',
        registered_at: null,
        attended_at: null,
        luma_role_raw: 'organizer',
        post_event_sentiment: null,
        post_event_feedback: null,
      });
      if (!edgeResult.ok) {
        stats.organizer_edge_failures += 1;
        deps.log.warn(
          { err: edgeResult.error, person_id: personId, event_id: eventId },
          'organizer edge insert failed',
        );
      } else {
        stats.organizer_edges_created += 1;
      }
    }
  }
  deps.log.info(
    {
      persons_created: stats.persons_created,
      persons_merged: stats.persons_merged,
      persons_human_review: stats.persons_human_review,
      persons_skipped: stats.persons_skipped,
      person_resolve_failures: stats.person_resolve_failures,
      organizer_edges_created: stats.organizer_edges_created,
      organizer_edge_failures: stats.organizer_edge_failures,
    },
    'phase 4 complete: resolve-and-attach',
  );
}

function bumpOutcomeCounts(stats: LumaIngestStats, outcome: ResolutionOutcome): void {
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

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Run the full Phase 1D pipeline end-to-end. Used by the backfill script
 * and by the Inngest function below (which wraps each phase in `step.run`).
 *
 * @example
 * ```ts
 * const stats = await runLumaIngest({ limit: 5 });
 * console.log(`events: ${stats.events_upserted}, persons: ${stats.persons_created}`);
 * ```
 */
export async function runLumaIngest(deps: LumaIngestDeps = {}): Promise<LumaIngestStats> {
  const resolved = resolveDeps(deps);
  const stats = emptyStats();
  const persisted = await phaseDiscoverAndStore(resolved, stats);
  const normalized = await phaseNormalize(resolved, persisted, stats);
  const eventIdByLuma = await phaseUpsertEvents(resolved, normalized, stats);
  await phaseResolvePersonsAndAttach(resolved, normalized, eventIdByLuma, stats);
  resolved.log.info(stats, 'luma-ingest-pipeline finished');
  return stats;
}

/**
 * Inngest function — same logic as {@link runLumaIngest} but each phase is
 * wrapped in `step.run(...)` so retries are durable and re-runs are safe.
 *
 * Cron: every 4 hours (SPEC.md §5.2.1).
 */
export const lumaIngestPipeline = inngest.createFunction(
  { id: 'luma-ingest-pipeline', name: 'Luma — end-to-end ingest pipeline' },
  { cron: '0 */4 * * *' },
  async ({ step }) => {
    const deps = resolveDeps();
    const stats = emptyStats();

    const persisted = await step.run('discover-and-store-raw', async () => {
      return phaseDiscoverAndStore(deps, stats);
    });

    const normalized = await step.run('normalize', async () => {
      return phaseNormalize(deps, persisted, stats);
    });

    const eventIdByLumaEntries = await step.run('upsert-events', async () => {
      const map = await phaseUpsertEvents(deps, normalized, stats);
      // Serialize Map → entries for step.run output (must be JSON-clean).
      return Array.from(map.entries());
    });

    await step.run('resolve-and-attach', async () => {
      const eventIdByLuma = new Map<string, string>(eventIdByLumaEntries);
      await phaseResolvePersonsAndAttach(deps, normalized, eventIdByLuma, stats);
    });

    return stats;
  },
);

// ---------------------------------------------------------------------------
// Translation: Luma normalizer payload → resolver's NormalizedPersonPayload
// ---------------------------------------------------------------------------

interface LumaPersonPayload extends Metadata {
  canonical_name?: string;
  names_seen?: string[];
  luma_handle?: string;
  luma_profile_url?: string | null;
  avatar_url?: string | null;
  platform_identities?: Array<{
    platform: 'luma' | 'twitter' | 'github' | 'linkedin';
    handle: string;
    profile_url: string | null;
  }>;
  observed_role?: string;
  luma_event_id?: string;
}

/**
 * Project the Luma normalizer's snake_case Person payload onto the camelCase
 * payload shape the resolver consumes. Keeps `luma_event_id` available on
 * the metadata so the pipeline can attach the organizer edge afterwards.
 */
function toResolverPersonRecord(
  record: NormalizedRecord,
): NormalizedRecord<NormalizedPersonPayload> & { recordType: 'person' } {
  const src = record.payload as LumaPersonPayload;
  const identities = src.platform_identities ?? [];
  const luma = identities.find((p) => p.platform === 'luma');
  const platformIdentity = luma ?? identities[0];
  const bioLinks: NormalizedPersonPayload['bioLinks'] = {};
  for (const ident of identities) {
    if (ident === platformIdentity) continue;
    if (ident.platform === 'github') bioLinks.github = ident.handle;
    else if (ident.platform === 'twitter') bioLinks.twitter = ident.handle;
    else if (ident.platform === 'linkedin') bioLinks.linkedin = ident.handle;
  }

  const payload: NormalizedPersonPayload = {
    canonicalName: src.canonical_name,
    namesSeen: src.names_seen ?? (src.canonical_name ? [src.canonical_name] : []),
    bioLinks,
    metadata: {
      luma_event_id: src.luma_event_id ?? null,
      luma_profile_url: src.luma_profile_url ?? null,
      avatar_url: src.avatar_url ?? null,
      observed_role: src.observed_role ?? null,
      source: 'luma',
    },
  };
  if (platformIdentity) {
    payload.platformIdentity = {
      platform: platformIdentity.platform,
      handle: platformIdentity.handle,
    };
    if (platformIdentity.profile_url) {
      payload.platformIdentity.profileUrl = platformIdentity.profile_url;
    }
  }

  return {
    recordType: 'person',
    sourcePlatform: record.sourcePlatform,
    sourceRecordId: record.sourceRecordId,
    payload,
    observedAt: record.observedAt,
  };
}

interface LumaEventPayload extends Metadata {
  title?: string;
  description?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  timezone?: string | null;
  venue_name?: string | null;
  venue_city?: string | null;
  venue_country?: string | null;
  event_format?: 'in_person' | 'virtual' | 'hybrid' | null;
  registered_count?: number | null;
  cover_image_url?: string | null;
  source_url?: string | null;
  status?: 'scheduled' | 'completed' | null;
  organizer_handles?: string[];
  payload_hash?: string;
}

/** Translate the Luma event payload into a row suitable for `event` upsert. */
function buildEventUpsertInput(
  lumaEventId: string,
  payload: Metadata,
): Parameters<typeof EventQueries.upsertEventByLumaId>[0] | null {
  const src = payload as LumaEventPayload;
  if (!src.title || !src.starts_at) return null;
  return {
    luma_event_id: lumaEventId,
    title: src.title,
    description: src.description ?? null,
    starts_at: src.starts_at,
    ends_at: src.ends_at ?? null,
    timezone: src.timezone ?? null,
    venue_city: src.venue_city ?? null,
    venue_country: src.venue_country ?? null,
    venue_name: src.venue_name ?? null,
    event_format: src.event_format ?? null,
    status: src.status ?? null,
    registered_count: src.registered_count ?? 0,
    source_url: src.source_url ?? null,
    metadata: {
      cover_image_url: src.cover_image_url ?? null,
      organizer_handles: src.organizer_handles ?? [],
      payload_hash: src.payload_hash ?? null,
    },
  };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// Re-export AtlasError for callers that want to handle errors structurally.
export type { AtlasError };

// Re-export the raw Luma detail shape so the backfill script can type its
// scrape fixture loader without depending on the adapter package directly.
export type { RawLumaEvent, ScrapedEventDetail };
