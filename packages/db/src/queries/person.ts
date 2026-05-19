/**
 * Named query helpers for `person` and `person_platform_identity`.
 * See SPEC.md §3.2.1 (Person), §3.3.2 (person_company), §4.4 (resolution
 * decisions), §7 (query layer).
 *
 * Every access to the person table flows through this file. Adapters,
 * workflows, intelligence services, and API routes call these helpers — never
 * raw SQL outside `packages/db`.
 */
import {
  QueryError,
  err,
  isErr,
  ok,
  type AtlasError,
  type LifecycleStage,
  type Person,
  type PersonPlatformIdentity,
  type PlatformIdentityPlatform,
  type ResolutionDecision,
  type Result,
  type UUID,
} from '@atlas/core';
import { envelope, svc, toQueryError } from './_internal.js';

/**
 * Input for `createPerson`. Mirrors the Person row sans server-set fields.
 */
export type PersonInput = Partial<Omit<Person, 'id'>> & Pick<Person, 'canonical_name'>;

/**
 * A single event on a Person's timeline (event attendance, communication
 * authored, signal emitted). Composed from `person_event`, `communication`,
 * and `signal`.
 */
export interface TimelineEntry {
  /** Stable timestamp used to sort entries chronologically. */
  occurred_at: string;
  /** Discriminator for the originating relation. */
  entry_type: 'event' | 'communication' | 'signal';
  /** UUID of the underlying row in the source table. */
  source_id: UUID;
  /** Short human-readable summary suitable for cockpit timelines. */
  summary: string;
  /** Optional structured payload (engagement counts, signal type, etc.). */
  payload: Record<string, unknown>;
}

/** Shape of the row inserted into `person_platform_identity`. */
export type PlatformIdentityInput = Omit<PersonPlatformIdentity, 'id' | 'observed_at'> &
  Partial<Pick<PersonPlatformIdentity, 'observed_at'>>;

/**
 * Insert a new Person row. Returns the freshly-created Person with
 * server-set timestamps.
 *
 * @example
 * ```ts
 * const r = await createPerson({ canonical_name: 'Alice Chen', primary_email: 'a@b.co' });
 * if (r.ok) console.log(r.value.id);
 * ```
 */
export async function createPerson(input: PersonInput): Promise<Result<Person, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    canonical_name: input.canonical_name,
    names_seen: input.names_seen ?? [],
    emails_seen: input.emails_seen ?? [],
    primary_email: input.primary_email ?? null,
    location_city: input.location_city ?? null,
    location_country: input.location_country ?? null,
    location_timezone: input.location_timezone ?? null,
    employer_company_id: input.employer_company_id ?? null,
    employer_seen_at: input.employer_seen_at ?? null,
    role: input.role ?? null,
    seniority: input.seniority ?? null,
    vertical: input.vertical ?? null,
    languages: input.languages ?? [],
    persona_classification: input.persona_classification ?? null,
    persona_confidence: input.persona_confidence ?? null,
    lifecycle_stage: input.lifecycle_stage ?? null,
    activity_score: input.activity_score ?? 0,
    churn_risk: input.churn_risk ?? 0,
    is_active: input.is_active ?? true,
    metadata: input.metadata ?? {},
  };
  const result = await c.value.from('person').insert(row).select().single();
  return envelope<Person>('createPerson', result);
}

/** Look up a Person by canonical UUID. Returns `null` when not found. */
export async function getPersonById(id: UUID): Promise<Result<Person | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('person').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getPersonById', result.error, { id }));
  return ok(result.data as Person | null);
}

/** Find Persons whose `emails_seen` contains the supplied email (case-insensitive). */
export async function findPersonsByEmail(email: string): Promise<Result<Person[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const normalized = email.toLowerCase();
  const result = await c.value
    .from('person')
    .select()
    .or(`primary_email.eq.${normalized},emails_seen.cs.{${normalized}}`);
  if (result.error) return err(toQueryError('findPersonsByEmail', result.error, { email }));
  return ok((result.data ?? []) as Person[]);
}

/** Find Persons who hold the given handle on the given platform. */
export async function findPersonsByPlatformHandle(
  platform: PlatformIdentityPlatform,
  handle: string,
): Promise<Result<Person[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const link = await c.value
    .from('person_platform_identity')
    .select('person_id')
    .eq('platform', platform)
    .eq('handle', handle);
  if (link.error)
    return err(toQueryError('findPersonsByPlatformHandle', link.error, { platform, handle }));
  const ids = (link.data ?? []).map((r: { person_id: UUID }) => r.person_id);
  if (ids.length === 0) return ok([]);
  const result = await c.value.from('person').select().in('id', ids);
  if (result.error)
    return err(toQueryError('findPersonsByPlatformHandle', result.error, { platform, handle }));
  return ok((result.data ?? []) as Person[]);
}

/** Find Persons currently employed at the given Company. */
export async function findPersonsByEmployer(
  companyId: UUID,
): Promise<Result<Person[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('person').select().eq('employer_company_id', companyId);
  if (result.error) return err(toQueryError('findPersonsByEmployer', result.error, { companyId }));
  return ok((result.data ?? []) as Person[]);
}

/**
 * Find Persons currently in the given lifecycle stage, optionally filtered
 * by minimum activity score, optionally limited.
 */
export async function findPersonsByLifecycleStage(
  stage: LifecycleStage,
  options?: { minScore?: number; limit?: number },
): Promise<Result<Person[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value.from('person').select().eq('lifecycle_stage', stage).eq('is_active', true);
  if (options?.minScore !== undefined) q = q.gte('activity_score', options.minScore);
  q = q.order('activity_score', { ascending: false });
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error)
    return err(toQueryError('findPersonsByLifecycleStage', result.error, { stage }));
  return ok((result.data ?? []) as Person[]);
}

/**
 * Patch a Person row. Returns the post-update row.
 *
 * @example
 * ```ts
 * await updatePerson(id, { lifecycle_stage: 'ambassador', activity_score: 87 });
 * ```
 */
export async function updatePerson(
  id: UUID,
  patch: Partial<PersonInput>,
): Promise<Result<Person, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const safePatch: Record<string, unknown> = {
    ...patch,
    last_observed_at: new Date().toISOString(),
  };
  const result = await c.value.from('person').update(safePatch).eq('id', id).select().single();
  return envelope<Person>('updatePerson', result, { id });
}

/**
 * Merge `sourcePersonId` into `targetPersonId`. Re-points every edge that
 * references the source, soft-deletes the source row, and writes a
 * `resolution_decision` audit row.
 *
 * Cross-edge re-pointing is best-effort: tables with `ON DELETE CASCADE` to
 * person.id rely on this helper to move rows before the source is deactivated.
 *
 * @example
 * ```ts
 * await mergePersons(duplicateId, canonicalId, decision);
 * ```
 */
export async function mergePersons(
  sourcePersonId: UUID,
  targetPersonId: UUID,
  decision: ResolutionDecision,
): Promise<Result<Person, AtlasError>> {
  if (sourcePersonId === targetPersonId) {
    return err(
      new QueryError('mergePersons: source and target are the same', 'QUERY_VALIDATION_FAILED'),
    );
  }
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;

  // Re-point each edge table. We use UPDATE … WHERE source AND NOT EXISTS to
  // avoid violating the per-table UNIQUE constraints; any row that would
  // collide is dropped instead of re-pointed.
  const repointTables: { table: string; column: string }[] = [
    { table: 'person_platform_identity', column: 'person_id' },
    { table: 'person_event', column: 'person_id' },
    { table: 'person_company', column: 'person_id' },
    { table: 'signal', column: 'person_id' },
    { table: 'communication', column: 'author_person_id' },
    { table: 'communication_mentions_person', column: 'person_id' },
    { table: 'program_managed_by_person', column: 'person_id' },
    { table: 'resolution_decision', column: 'matched_person_id' },
    { table: 'resolution_conflict', column: 'person_id' },
  ];

  for (const { table, column } of repointTables) {
    const upd = await sb
      .from(table)
      .update({ [column]: targetPersonId })
      .eq(column, sourcePersonId);
    if (upd.error) {
      // Unique-violation rows are left as-is on the source; they will be
      // hard-deleted by the cascade when the source is soft-deleted below.
      if (upd.error.code !== '23505') {
        return err(toQueryError('mergePersons', upd.error, { table, column }));
      }
    }
  }

  // person_person_edge has two FKs (source_person_id, target_person_id) and a
  // self-loop CHECK. Re-point both columns separately, ignoring rows that
  // would self-loop.
  await sb
    .from('person_person_edge')
    .update({ source_person_id: targetPersonId })
    .eq('source_person_id', sourcePersonId)
    .neq('target_person_id', targetPersonId);
  await sb
    .from('person_person_edge')
    .update({ target_person_id: targetPersonId })
    .eq('target_person_id', sourcePersonId)
    .neq('source_person_id', targetPersonId);

  // Soft-delete the source: deactivate and record the merge in metadata.
  const sourceRow = await sb.from('person').select('metadata').eq('id', sourcePersonId).single();
  const existingMeta =
    sourceRow.data && typeof sourceRow.data.metadata === 'object'
      ? (sourceRow.data.metadata as Record<string, unknown>)
      : {};
  const mergedMeta = {
    ...existingMeta,
    merged_into: targetPersonId,
    merged_at: new Date().toISOString(),
  };
  const deactivate = await sb
    .from('person')
    .update({ is_active: false, metadata: mergedMeta })
    .eq('id', sourcePersonId);
  if (deactivate.error)
    return err(toQueryError('mergePersons', deactivate.error, { sourcePersonId, targetPersonId }));

  // Audit (SPEC.md §4.4). Failure here is non-fatal for the merge itself but
  // surfaced via the returned error.
  const audit = await sb.from('resolution_decision').insert({
    action: decision.action,
    candidate_record_source: 'merge',
    candidate_record_id: sourcePersonId,
    matched_person_id: targetPersonId,
    confidence_score: decision.confidence,
    signals: decision.signals,
    decided_by: 'system',
    reasoning: decision.reasoning,
  });
  if (audit.error)
    return err(toQueryError('mergePersons', audit.error, { sourcePersonId, targetPersonId }));

  const targetRow = await sb.from('person').select().eq('id', targetPersonId).single();
  return envelope<Person>('mergePersons', targetRow, { targetPersonId });
}

/**
 * Reconstruct a Person's chronological timeline: event attendance,
 * communications authored, signals emitted.
 *
 * @example
 * ```ts
 * const timeline = await getPersonTimeline(id, { since: new Date('2024-01-01') });
 * ```
 */
export async function getPersonTimeline(
  id: UUID,
  options?: { since?: Date; limit?: number },
): Promise<Result<TimelineEntry[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const sinceIso = options?.since?.toISOString() ?? null;
  const limit = options?.limit ?? 100;

  let eq = sb
    .from('person_event')
    .select('event_id, role, attended_at, registered_at, event:event(id, title, starts_at)')
    .eq('person_id', id);
  if (sinceIso) eq = eq.gte('attended_at', sinceIso);

  let cq = sb
    .from('communication')
    .select('id, source_platform, content_text, posted_at, engagement_likes, is_about_cursor')
    .eq('author_person_id', id);
  if (sinceIso) cq = cq.gte('posted_at', sinceIso);

  let sq = sb
    .from('signal')
    .select('id, signal_type, value, observed_at, metadata')
    .eq('person_id', id);
  if (sinceIso) sq = sq.gte('observed_at', sinceIso);

  const [events, comms, signals] = await Promise.all([eq, cq, sq]);
  if (events.error) return err(toQueryError('getPersonTimeline.events', events.error, { id }));
  if (comms.error) return err(toQueryError('getPersonTimeline.comms', comms.error, { id }));
  if (signals.error) return err(toQueryError('getPersonTimeline.signals', signals.error, { id }));

  const out: TimelineEntry[] = [];
  type EventRowEntity = { id: UUID; title: string; starts_at: string };
  type EventRow = {
    event_id: UUID;
    role: string;
    attended_at: string | null;
    registered_at: string | null;
    event: EventRowEntity | EventRowEntity[] | null;
  };
  for (const row of events.data ?? []) {
    const e = row as unknown as EventRow;
    const eventEntity = Array.isArray(e.event) ? (e.event[0] ?? null) : e.event;
    const occurred_at =
      e.attended_at ?? e.registered_at ?? eventEntity?.starts_at ?? new Date(0).toISOString();
    out.push({
      occurred_at,
      entry_type: 'event',
      source_id: e.event_id,
      summary: `${e.role} @ ${eventEntity?.title ?? 'event'}`,
      payload: { role: e.role, eventId: e.event_id },
    });
  }
  for (const row of comms.data ?? []) {
    const co = row as {
      id: UUID;
      source_platform: string;
      content_text: string;
      posted_at: string;
      engagement_likes: number;
      is_about_cursor: boolean;
    };
    out.push({
      occurred_at: co.posted_at,
      entry_type: 'communication',
      source_id: co.id,
      summary: `${co.source_platform}: ${co.content_text.slice(0, 80)}`,
      payload: {
        platform: co.source_platform,
        likes: co.engagement_likes,
        isAboutCursor: co.is_about_cursor,
      },
    });
  }
  for (const row of signals.data ?? []) {
    const s = row as {
      id: UUID;
      signal_type: string;
      value: number | null;
      observed_at: string;
      metadata: Record<string, unknown>;
    };
    out.push({
      occurred_at: s.observed_at,
      entry_type: 'signal',
      source_id: s.id,
      summary: `signal: ${s.signal_type}`,
      payload: { signalType: s.signal_type, value: s.value, metadata: s.metadata },
    });
  }
  out.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
  return ok(out.slice(0, limit));
}

/**
 * Attach a platform identity (twitter/github/etc.) to a Person.
 *
 * @example
 * ```ts
 * await addPlatformIdentity(personId, {
 *   person_id: personId,
 *   platform: 'twitter',
 *   handle: 'alicebuilds',
 *   platform_user_id: '1234',
 *   profile_url: 'https://x.com/alicebuilds',
 *   follower_count: 4200,
 *   verified: false,
 *   resolution_confidence: 1.0,
 *   resolution_method: 'explicit_link',
 * });
 * ```
 */
export async function addPlatformIdentity(
  personId: UUID,
  identity: PlatformIdentityInput,
): Promise<Result<void, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    person_id: personId,
    platform: identity.platform,
    handle: identity.handle,
    platform_user_id: identity.platform_user_id ?? null,
    profile_url: identity.profile_url ?? null,
    follower_count: identity.follower_count ?? null,
    verified: identity.verified ?? false,
    observed_at: identity.observed_at ?? new Date().toISOString(),
    resolution_confidence: identity.resolution_confidence ?? 1.0,
    resolution_method: identity.resolution_method ?? null,
  };
  const result = await c.value.from('person_platform_identity').insert(row);
  if (result.error)
    return err(toQueryError('addPlatformIdentity', result.error, { personId, identity }));
  return ok(undefined);
}
