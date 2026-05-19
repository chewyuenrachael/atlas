/**
 * Named query helpers for `event`, `person_event`, and `raw_luma_event`.
 * See SPEC.md §3.2.3 (Event), §3.3.1 (person_event), §3.5 (raw tables) and
 * §7.2 (traversals).
 */
import {
  QueryError,
  err,
  isErr,
  ok,
  type AtlasError,
  type Event as AtlasEvent,
  type IsoTimestamp,
  type Metadata,
  type NormalizationStatus,
  type Person,
  type PersonEventEdge,
  type PersonEventRole,
  type Result,
  type UUID,
} from '@atlas/core';
import { envelope, svc, toQueryError } from './_internal.js';

export type EventInput = Partial<Omit<AtlasEvent, 'id' | 'created_at' | 'updated_at'>> &
  Pick<AtlasEvent, 'title' | 'starts_at'>;

/**
 * Insert a new Event row.
 *
 * @example
 * ```ts
 * await createEvent({ title: 'Café Cursor Lagos', starts_at: '2026-02-12T18:00:00Z' });
 * ```
 */
export async function createEvent(input: EventInput): Promise<Result<AtlasEvent, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    title: input.title,
    description: input.description ?? null,
    program_id: input.program_id ?? null,
    program_type: input.program_type ?? null,
    event_format: input.event_format ?? null,
    starts_at: input.starts_at,
    ends_at: input.ends_at ?? null,
    timezone: input.timezone ?? null,
    venue_city: input.venue_city ?? null,
    venue_country: input.venue_country ?? null,
    venue_name: input.venue_name ?? null,
    venue_company_id: input.venue_company_id ?? null,
    host_company_id: input.host_company_id ?? null,
    status: input.status ?? null,
    registered_count: input.registered_count ?? 0,
    attended_count: input.attended_count ?? 0,
    repeat_attendee_count: input.repeat_attendee_count ?? 0,
    sentiment_score: input.sentiment_score ?? null,
    source_url: input.source_url ?? null,
    luma_event_id: input.luma_event_id ?? null,
    metadata: input.metadata ?? {},
  };
  const result = await c.value.from('event').insert(row).select().single();
  return envelope<AtlasEvent>('createEvent', result);
}

/** Look up an Event by canonical UUID. */
export async function getEventById(id: UUID): Promise<Result<AtlasEvent | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('event').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getEventById', result.error, { id }));
  return ok(result.data as AtlasEvent | null);
}

/** List Events that took place (or are scheduled) in the given city. */
export async function findEventsByCity(
  city: string,
  country: string,
): Promise<Result<AtlasEvent[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('event')
    .select()
    .eq('venue_city', city)
    .eq('venue_country', country)
    .order('starts_at', { ascending: false });
  if (result.error) return err(toQueryError('findEventsByCity', result.error, { city, country }));
  return ok((result.data ?? []) as AtlasEvent[]);
}

/** List Events that belong to the given Program. */
export async function findEventsByProgram(
  programId: UUID,
): Promise<Result<AtlasEvent[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('event')
    .select()
    .eq('program_id', programId)
    .order('starts_at', { ascending: false });
  if (result.error) return err(toQueryError('findEventsByProgram', result.error, { programId }));
  return ok((result.data ?? []) as AtlasEvent[]);
}

/** List Events within an inclusive [from, to] window (ISO timestamps). */
export async function findEventsByDateRange(
  from: Date | string,
  to: Date | string,
): Promise<Result<AtlasEvent[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const fromIso = typeof from === 'string' ? from : from.toISOString();
  const toIso = typeof to === 'string' ? to : to.toISOString();
  const result = await c.value
    .from('event')
    .select()
    .gte('starts_at', fromIso)
    .lte('starts_at', toIso)
    .order('starts_at', { ascending: true });
  if (result.error)
    return err(toQueryError('findEventsByDateRange', result.error, { fromIso, toIso }));
  return ok((result.data ?? []) as AtlasEvent[]);
}

/** Roles considered as "attendees" for getAttendees. */
const ATTENDEE_ROLES: PersonEventRole[] = ['attendee', 'speaker', 'organizer', 'co_organizer'];
const ORGANIZER_ROLES: PersonEventRole[] = ['organizer', 'co_organizer'];

interface EventEdgeMeta {
  role: PersonEventRole;
  attended_at: string | null;
  registered_at: string | null;
}

interface PersonRowWithRole {
  role: PersonEventRole;
  attended_at: string | null;
  registered_at: string | null;
  person: Person | Person[] | null;
}

async function listPeopleForEvent(
  helper: string,
  eventId: UUID,
  roles: PersonEventRole[],
): Promise<Result<{ person: Person; edge: EventEdgeMeta }[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('person_event')
    .select('role, attended_at, registered_at, person:person(*)')
    .eq('event_id', eventId)
    .in('role', roles);
  if (result.error) return err(toQueryError(helper, result.error, { eventId, roles }));
  const rows = (result.data ?? []) as unknown as PersonRowWithRole[];
  const out: { person: Person; edge: EventEdgeMeta }[] = [];
  for (const row of rows) {
    const p = Array.isArray(row.person) ? (row.person[0] ?? null) : row.person;
    if (p === null) continue;
    out.push({
      person: p,
      edge: { role: row.role, attended_at: row.attended_at, registered_at: row.registered_at },
    });
  }
  return ok(out);
}

/** People who attended (or are scheduled to attend) the given Event. */
export async function getEventAttendees(
  eventId: UUID,
): Promise<Result<{ person: Person; edge: EventEdgeMeta }[], AtlasError>> {
  return listPeopleForEvent('getEventAttendees', eventId, ATTENDEE_ROLES);
}

/** People who organized (or co-organized) the given Event. */
export async function getEventOrganizers(
  eventId: UUID,
): Promise<Result<{ person: Person; edge: EventEdgeMeta }[], AtlasError>> {
  return listPeopleForEvent('getEventOrganizers', eventId, ORGANIZER_ROLES);
}

/**
 * Look up an Event by its source `luma_event_id` slug. Returns `null` when
 * not yet ingested.
 */
export async function findEventByLumaId(
  lumaEventId: string,
): Promise<Result<AtlasEvent | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('event')
    .select()
    .eq('luma_event_id', lumaEventId)
    .maybeSingle();
  if (result.error) return err(toQueryError('findEventByLumaId', result.error, { lumaEventId }));
  return ok(result.data as AtlasEvent | null);
}

/**
 * Idempotent upsert keyed on `luma_event_id`. Inserts the row when missing,
 * otherwise patches mutable fields (title / description / venue / counts /
 * status / metadata) and refreshes `updated_at`.
 *
 * The unique constraint on `event.luma_event_id` (SPEC.md §3.2.3) lets a
 * single round-trip handle "first observation" vs. "re-scrape with corrected
 * data" without the caller branching.
 *
 * @example
 * ```ts
 * const r = await upsertEventByLumaId({
 *   luma_event_id: 'cursor-sf-jun',
 *   title: 'Cafe Cursor SF',
 *   starts_at: '2026-06-16T01:00:00Z',
 * });
 * ```
 */
export async function upsertEventByLumaId(
  input: EventInput & { luma_event_id: string },
): Promise<Result<AtlasEvent, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    luma_event_id: input.luma_event_id,
    title: input.title,
    description: input.description ?? null,
    program_id: input.program_id ?? null,
    program_type: input.program_type ?? null,
    event_format: input.event_format ?? null,
    starts_at: input.starts_at,
    ends_at: input.ends_at ?? null,
    timezone: input.timezone ?? null,
    venue_city: input.venue_city ?? null,
    venue_country: input.venue_country ?? null,
    venue_name: input.venue_name ?? null,
    venue_company_id: input.venue_company_id ?? null,
    host_company_id: input.host_company_id ?? null,
    status: input.status ?? null,
    registered_count: input.registered_count ?? 0,
    attended_count: input.attended_count ?? 0,
    repeat_attendee_count: input.repeat_attendee_count ?? 0,
    sentiment_score: input.sentiment_score ?? null,
    source_url: input.source_url ?? null,
    metadata: input.metadata ?? {},
    updated_at: new Date().toISOString(),
  };
  const result = await c.value
    .from('event')
    .upsert(row, { onConflict: 'luma_event_id' })
    .select()
    .single();
  return envelope<AtlasEvent>('upsertEventByLumaId', result, { lumaEventId: input.luma_event_id });
}

/**
 * Raw envelope persisted in `raw_luma_event`. Matches the SPEC.md §3.5 shape.
 */
export interface RawLumaEventRow {
  id: UUID;
  luma_event_id: string;
  raw_payload: Metadata;
  ingested_at: IsoTimestamp;
  normalized_at: IsoTimestamp | null;
  normalization_status: NormalizationStatus | null;
  normalization_error: string | null;
}

/** Input for {@link insertRawLumaEvent}. */
export interface InsertRawLumaEventInput {
  luma_event_id: string;
  raw_payload: Metadata;
}

/**
 * Idempotent insert into `raw_luma_event`. If a row already exists for
 * `luma_event_id`, returns the existing id with `existed: true` and leaves the
 * stored payload untouched (re-scrapes overwrite higher up — the raw table is
 * intended as a write-once durable snapshot per SPEC.md §3.5).
 *
 * @example
 * ```ts
 * const r = await insertRawLumaEvent({ luma_event_id: 'cursor-sf-jun', raw_payload });
 * if (r.ok) console.log(r.value.id, r.value.existed);
 * ```
 */
export async function insertRawLumaEvent(
  input: InsertRawLumaEventInput,
): Promise<Result<{ id: UUID; existed: boolean }, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const existing = await sb
    .from('raw_luma_event')
    .select('id')
    .eq('luma_event_id', input.luma_event_id)
    .maybeSingle();
  if (existing.error)
    return err(
      toQueryError('insertRawLumaEvent.lookup', existing.error, {
        luma_event_id: input.luma_event_id,
      }),
    );
  if (existing.data) {
    return ok({ id: (existing.data as { id: UUID }).id, existed: true });
  }
  const inserted = await sb
    .from('raw_luma_event')
    .insert({
      luma_event_id: input.luma_event_id,
      raw_payload: input.raw_payload,
      normalization_status: 'pending',
    })
    .select('id')
    .single();
  if (inserted.error)
    return err(
      toQueryError('insertRawLumaEvent.insert', inserted.error, {
        luma_event_id: input.luma_event_id,
      }),
    );
  return ok({ id: (inserted.data as { id: UUID }).id, existed: false });
}

/** Read one raw Luma event by `raw_luma_event.id`. */
export async function getRawLumaEventById(
  id: UUID,
): Promise<Result<RawLumaEventRow | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('raw_luma_event').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getRawLumaEventById', result.error, { id }));
  return ok(result.data as RawLumaEventRow | null);
}

/**
 * Update the normalization status on a raw Luma event row.
 *
 * @example
 * ```ts
 * await markRawLumaEventNormalized(rawId, 'success');
 * await markRawLumaEventNormalized(rawId, 'failed', 'normalizer threw');
 * ```
 */
export async function markRawLumaEventNormalized(
  id: UUID,
  status: NormalizationStatus,
  errorMessage?: string,
): Promise<Result<void, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const patch: Record<string, unknown> = {
    normalization_status: status,
    normalized_at: status === 'pending' ? null : new Date().toISOString(),
    normalization_error: errorMessage ?? null,
  };
  const result = await c.value.from('raw_luma_event').update(patch).eq('id', id);
  if (result.error)
    return err(toQueryError('markRawLumaEventNormalized', result.error, { id, status }));
  return ok(undefined);
}

/**
 * Count raw rows whose normalization is still pending and that were ingested
 * more than `cutoff` ms ago. Used by `pnpm verify:phase-1` to confirm the
 * Phase 1 exit criterion "no raw records stuck in pending".
 */
export async function countStuckRawLumaEvents(
  olderThanMs: number,
): Promise<Result<number, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await c.value
    .from('raw_luma_event')
    .select('id', { count: 'exact', head: true })
    .eq('normalization_status', 'pending')
    .lt('ingested_at', cutoff);
  if (result.error)
    return err(toQueryError('countStuckRawLumaEvents', result.error, { olderThanMs }));
  const count = result.count;
  if (typeof count !== 'number')
    return err(
      new QueryError('countStuckRawLumaEvents: count missing on response', 'QUERY_FAILED'),
    );
  return ok(count);
}

/**
 * Record attendance for a Person at an Event. Upserts on the
 * `(person_id, event_id, role)` unique key.
 *
 * @example
 * ```ts
 * await recordAttendance({ person_id, event_id, role: 'attendee', attended_at: ... });
 * ```
 */
export async function recordAttendance(
  edge: Omit<PersonEventEdge, 'id'>,
): Promise<Result<UUID, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    person_id: edge.person_id,
    event_id: edge.event_id,
    role: edge.role,
    registered_at: edge.registered_at ?? null,
    attended_at: edge.attended_at ?? null,
    luma_role_raw: edge.luma_role_raw ?? null,
    post_event_sentiment: edge.post_event_sentiment ?? null,
    post_event_feedback: edge.post_event_feedback ?? null,
  };
  const result = await c.value
    .from('person_event')
    .upsert(row, { onConflict: 'person_id,event_id,role' })
    .select('id')
    .single();
  if (result.error) return err(toQueryError('recordAttendance', result.error, edge));
  return ok((result.data as { id: UUID }).id);
}
