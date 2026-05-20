/**
 * Materialized view refresh helpers.
 *
 * SPEC.md §6.4 calls for materialized views populated by Layer 2 and
 * refreshed on a schedule (15 minutes) or on demand. The three views landed
 * by `infra/migrations/0002_materialized_views.sql` back the cockpit map and
 * supporting panels:
 *
 *   - `mv_city_signal`              — per-(city, country) rollup of people,
 *                                     ambassadors, events, and communications.
 *   - `mv_events_with_organizers`   — denormalized event row with the
 *                                     organizer list pre-aggregated.
 *   - `mv_person_activity_summary`  — per-Person event/comm/artifact counts
 *                                     and recency_score.
 *
 * Each `refresh*` helper issues `REFRESH MATERIALIZED VIEW CONCURRENTLY`
 * so cockpit reads do not block during the refresh. CONCURRENTLY requires
 * a UNIQUE index on each view — those are created in 0002.
 *
 * The Supabase JS client speaks PostgREST and cannot execute arbitrary DDL,
 * so these helpers use the raw `pg.Client` from `../pg-client.ts`. That
 * client is otherwise reserved for migrations; this is the second blessed
 * caller. Callers must have `DATABASE_URL` set (server-only).
 *
 * @example
 * ```ts
 * import { refreshAllViews } from '@atlas/db';
 * const result = await refreshAllViews();
 * if (!result.ok) console.error(result.error);
 * ```
 */
import {
  ConfigError,
  QueryError,
  err,
  isErr,
  ok,
  type AtlasError,
  type Result,
  type UUID,
} from '@atlas/core';
import { openPgClient, readDatabaseUrl, type PgClient } from '../pg-client.js';
import { svc, toQueryError } from './_internal.js';

/** Name of every materialized view managed by this module. */
export const MATERIALIZED_VIEW_NAMES = [
  'mv_city_signal',
  'mv_events_with_organizers',
  'mv_person_activity_summary',
] as const;

export type MaterializedViewName = (typeof MATERIALIZED_VIEW_NAMES)[number];

/** Per-view outcome surfaced by {@link refreshAllViews}. */
export interface ViewRefreshResult {
  view: MaterializedViewName;
  durationMs: number;
}

/** Aggregate outcome from {@link refreshAllViews}. */
export interface RefreshAllReport {
  results: ViewRefreshResult[];
  totalDurationMs: number;
}

/**
 * Open a pg.Client, run `fn`, and close the client. Pg connections are
 * cheap to open against Supabase's pooler endpoint, and centralizing the
 * acquire/release here keeps each refresh helper self-contained.
 */
async function withPgClient<T>(
  helper: string,
  fn: (client: PgClient) => Promise<T>,
): Promise<Result<T, AtlasError>> {
  const url = readDatabaseUrl();
  if (isErr(url)) return url;
  let client: PgClient;
  try {
    client = await openPgClient(url.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(
      new ConfigError(`${helper}: pg connect failed: ${message}`, 'INVALID_CONFIG', {}, cause),
    );
  }
  try {
    const value = await fn(client);
    return ok(value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new QueryError(`${helper}: ${message}`, 'QUERY_FAILED', { helper }, cause));
  } finally {
    await client.end().catch(() => {
      /* swallow secondary failure during close */
    });
  }
}

/**
 * Issue `REFRESH MATERIALIZED VIEW CONCURRENTLY <view>` and return the
 * duration in ms.
 *
 * CONCURRENTLY needs a UNIQUE index on the view and runs in a transaction
 * of its own (Postgres takes a short ACCESS EXCLUSIVE lock at the very end
 * to swap the storage). It blocks new refreshes of the same view but does
 * not block readers, which is what the cockpit needs.
 *
 * Falls back to a non-concurrent refresh if CONCURRENTLY is rejected (most
 * commonly because the view was just created and has never been populated;
 * the first refresh of an empty matview must be non-concurrent).
 */
async function refreshOne(
  helper: string,
  view: MaterializedViewName,
): Promise<Result<ViewRefreshResult, AtlasError>> {
  return withPgClient(helper, async (client) => {
    const t0 = Date.now();
    try {
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // First refresh after CREATE MATERIALIZED VIEW (WITH NO DATA) requires
      // a non-concurrent refresh; surface that quietly by retrying.
      // Postgres SQLSTATE 55000 ("object_not_in_prerequisite_state") covers
      // both "has not been populated" and "cannot run concurrently".
      if (/has not been populated|cannot.+CONCURRENTLY|55000/i.test(message)) {
        await client.query(`REFRESH MATERIALIZED VIEW ${view}`);
      } else {
        throw cause;
      }
    }
    return { view, durationMs: Date.now() - t0 };
  });
}

/** Refresh `mv_city_signal`. */
export async function refreshCitySignal(): Promise<Result<ViewRefreshResult, AtlasError>> {
  return refreshOne('refreshCitySignal', 'mv_city_signal');
}

/** Refresh `mv_events_with_organizers`. */
export async function refreshEventsWithOrganizers(): Promise<
  Result<ViewRefreshResult, AtlasError>
> {
  return refreshOne('refreshEventsWithOrganizers', 'mv_events_with_organizers');
}

/** Refresh `mv_person_activity_summary`. */
export async function refreshPersonActivitySummary(): Promise<
  Result<ViewRefreshResult, AtlasError>
> {
  return refreshOne('refreshPersonActivitySummary', 'mv_person_activity_summary');
}

/**
 * Refresh every materialized view sequentially. Stops at the first failure
 * and returns the error — partial successes are reported in the
 * AtlasError context under `priorResults` so the caller can show what
 * landed before the break.
 *
 * Views are refreshed in dependency order (cheapest first), but in practice
 * none of the three views reference each other so order is only a
 * convenience for monitoring output.
 */
export async function refreshAllViews(): Promise<Result<RefreshAllReport, AtlasError>> {
  const t0 = Date.now();
  const results: ViewRefreshResult[] = [];
  const helpers: { name: string; fn: () => Promise<Result<ViewRefreshResult, AtlasError>> }[] = [
    { name: 'mv_city_signal', fn: refreshCitySignal },
    { name: 'mv_events_with_organizers', fn: refreshEventsWithOrganizers },
    { name: 'mv_person_activity_summary', fn: refreshPersonActivitySummary },
  ];
  for (const { name, fn } of helpers) {
    const r = await fn();
    if (isErr(r)) {
      return err(
        new QueryError(
          `refreshAllViews: ${name} failed: ${r.error.message}`,
          'QUERY_FAILED',
          { failedView: name, priorResults: results },
          r.error,
        ),
      );
    }
    results.push(r.value);
  }
  return ok({ results, totalDurationMs: Date.now() - t0 });
}

// ===========================================================================
// Read helpers for the cockpit. Server components and API routes call these
// instead of going through Supabase directly so the view shape lives in one
// place.
// ===========================================================================

/** One row of `mv_city_signal`. Mirrors the SQL column types. */
export interface CitySignalRow {
  location_city: string;
  location_country: string | null;
  total_known_people: number;
  ambassador_count: number;
  event_count_last_180d: number;
  total_event_count: number;
  avg_activity_score: number;
  recent_mentions: number;
  total_communication_count: number;
  ambassador_names: string[];
  latitude: number | null;
  longitude: number | null;
}

/** One organizer entry inside `mv_events_with_organizers.organizers`. */
export interface EventOrganizerEntry {
  person_id: UUID;
  name: string;
  role: 'organizer' | 'co_organizer';
}

/** One row of `mv_events_with_organizers`. */
export interface EventWithOrganizersRow {
  id: UUID;
  title: string;
  description: string | null;
  program_id: UUID | null;
  program_type: string | null;
  event_format: string | null;
  starts_at: string;
  ends_at: string | null;
  timezone: string | null;
  venue_city: string | null;
  venue_country: string | null;
  venue_name: string | null;
  venue_company_id: UUID | null;
  host_company_id: UUID | null;
  status: string | null;
  registered_count: number;
  attended_count: number;
  sentiment_score: number | null;
  source_url: string | null;
  luma_event_id: string | null;
  created_at: string;
  updated_at: string;
  latitude: number | null;
  longitude: number | null;
  organizers: EventOrganizerEntry[];
  organizer_names_csv: string;
}

/** One row of `mv_person_activity_summary`. */
export interface PersonActivitySummaryRow {
  person_id: UUID;
  canonical_name: string;
  location_city: string | null;
  location_country: string | null;
  lifecycle_stage: string | null;
  activity_score: number;
  event_count: number;
  organizer_event_count: number;
  communication_count: number;
  artifact_count: number;
  last_activity_at: string;
  recency_score: number;
}

/** Options accepted by {@link getCitySignalRows}. */
export interface CitySignalQueryOptions {
  /** Only return cities with a known latitude/longitude (i.e. plottable). */
  onlyWithCoordinates?: boolean;
  /** Cap on rows returned. */
  limit?: number;
}

/**
 * Read every row of `mv_city_signal`, optionally filtered to plottable
 * cities. The cockpit map uses `onlyWithCoordinates: true` so unmapped
 * cities don't clutter the result.
 */
export async function getCitySignalRows(
  options?: CitySignalQueryOptions,
): Promise<Result<CitySignalRow[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value.from('mv_city_signal').select('*');
  if (options?.onlyWithCoordinates) {
    q = q.not('latitude', 'is', null).not('longitude', 'is', null);
  }
  q = q.order('total_known_people', { ascending: false });
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error) return err(toQueryError('getCitySignalRows', result.error, { options }));
  return ok((result.data ?? []) as CitySignalRow[]);
}

/** Options accepted by {@link getEventsWithOrganizers}. */
export interface EventsWithOrganizersQueryOptions {
  /** Only return events with a known latitude/longitude (i.e. plottable). */
  onlyWithCoordinates?: boolean;
  /** Restrict to events whose `starts_at` is within this many days of now. */
  withinDays?: number;
  /** Cap on rows returned. */
  limit?: number;
}

/**
 * Read rows from `mv_events_with_organizers`. The cockpit map uses
 * `onlyWithCoordinates: true` so unmapped events are skipped — they still
 * surface in the table view, just not as map pins.
 */
export async function getEventsWithOrganizers(
  options?: EventsWithOrganizersQueryOptions,
): Promise<Result<EventWithOrganizersRow[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value.from('mv_events_with_organizers').select('*');
  if (options?.onlyWithCoordinates) {
    q = q.not('latitude', 'is', null).not('longitude', 'is', null);
  }
  if (options?.withinDays !== undefined) {
    const cutoff = new Date(Date.now() - options.withinDays * 86_400_000).toISOString();
    q = q.gte('starts_at', cutoff);
  }
  q = q.order('starts_at', { ascending: false });
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error) return err(toQueryError('getEventsWithOrganizers', result.error, { options }));
  return ok((result.data ?? []) as EventWithOrganizersRow[]);
}

/** Look up one row of `mv_events_with_organizers` by event id. */
export async function getEventWithOrganizersById(
  id: UUID,
): Promise<Result<EventWithOrganizersRow | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('mv_events_with_organizers')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (result.error) return err(toQueryError('getEventWithOrganizersById', result.error, { id }));
  return ok((result.data as EventWithOrganizersRow | null) ?? null);
}

/**
 * Read rows from `mv_person_activity_summary`. Optional filter by city
 * (used by the city-detail side panel on the cockpit map).
 */
export async function getPersonActivitySummary(options?: {
  city?: string;
  country?: string;
  limit?: number;
}): Promise<Result<PersonActivitySummaryRow[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value.from('mv_person_activity_summary').select('*');
  if (options?.city !== undefined) q = q.eq('location_city', options.city);
  if (options?.country !== undefined) q = q.eq('location_country', options.country);
  q = q.order('activity_score', { ascending: false }).order('recency_score', { ascending: false });
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error) return err(toQueryError('getPersonActivitySummary', result.error, { options }));
  return ok((result.data ?? []) as PersonActivitySummaryRow[]);
}
