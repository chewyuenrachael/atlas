/**
 * Named query helpers for the audit and event-log tables.
 * See SPEC.md §4.4 (resolution_decision), §6.2 (entity_event_log),
 * §10.5 (access_audit_log).
 */
import {
  err,
  isErr,
  ok,
  type AccessAuditLogRecord,
  type AtlasError,
  type EntityEventLogRecord,
  type IsoTimestamp,
  type Metadata,
  type ResolutionAction,
  type ResolutionConflict,
  type ResolutionConflictStatus,
  type ResolutionDecisionRecord,
  type ResolutionSignal,
  type Result,
  type UUID,
} from '@atlas/core';
import { envelope, svc, toQueryError } from './_internal.js';

/** Input for `logResolution`. The `id` and `decided_at` are server-set. */
export interface LogResolutionInput {
  action: ResolutionAction;
  candidateRecordSource: string;
  candidateRecordId: string;
  matchedPersonId: UUID | null;
  confidenceScore: number;
  signals: ResolutionSignal[];
  decidedBy: 'system' | 'human';
  humanReviewer?: string | null;
  reasoning?: string | null;
}

/**
 * Append a row to `resolution_decision` (SPEC.md §4.4). Returns the
 * persisted record.
 *
 * @example
 * ```ts
 * await logResolution({
 *   action: 'merge', candidateRecordSource: 'luma', candidateRecordId: 'luma:abc',
 *   matchedPersonId: id, confidenceScore: 0.92, signals: [], decidedBy: 'system', reasoning: '...'
 * });
 * ```
 */
export async function logResolution(
  input: LogResolutionInput,
): Promise<Result<ResolutionDecisionRecord, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    action: input.action,
    candidate_record_source: input.candidateRecordSource,
    candidate_record_id: input.candidateRecordId,
    matched_person_id: input.matchedPersonId,
    confidence_score: input.confidenceScore,
    signals: input.signals,
    decided_by: input.decidedBy,
    human_reviewer: input.humanReviewer ?? null,
    reasoning: input.reasoning ?? null,
  };
  const result = await c.value.from('resolution_decision').insert(row).select().single();
  return envelope<ResolutionDecisionRecord>('logResolution', result);
}

/** Input for `logAccess`. */
export interface LogAccessInput {
  userId: string;
  action: string;
  resourceType: string;
  resourceId?: UUID | null;
  success: boolean;
  metadata?: Metadata;
}

/**
 * Append a row to `access_audit_log` (SPEC.md §10.5). Used by any helper
 * that reads or writes confidential data; the caller decides what counts.
 */
export async function logAccess(
  input: LogAccessInput,
): Promise<Result<AccessAuditLogRecord, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    user_id: input.userId,
    action: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId ?? null,
    success: input.success,
    metadata: input.metadata ?? {},
  };
  const result = await c.value.from('access_audit_log').insert(row).select().single();
  return envelope<AccessAuditLogRecord>('logAccess', result);
}

/** Input for `logEntityEvent`. */
export interface LogEntityEventInput {
  entityType: string;
  entityId: UUID;
  eventType: string;
  actor: string;
  payload: Metadata;
  causationId?: UUID | null;
  correlationId?: UUID | null;
}

/**
 * Append a row to `entity_event_log` (SPEC.md §6.2). Every state-changing
 * operation in the system should leave a trace here.
 */
export async function logEntityEvent(
  input: LogEntityEventInput,
): Promise<Result<EntityEventLogRecord, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    entity_type: input.entityType,
    entity_id: input.entityId,
    event_type: input.eventType,
    actor: input.actor,
    payload: input.payload,
    causation_id: input.causationId ?? null,
    correlation_id: input.correlationId ?? null,
  };
  const result = await c.value.from('entity_event_log').insert(row).select().single();
  return envelope<EntityEventLogRecord>('logEntityEvent', result);
}

/** Input for {@link enqueueReviewItem}. */
export interface EnqueueReviewItemInput {
  itemType: string;
  payload: Metadata;
}

/**
 * Append a `pending` row to `human_review_queue`. The Phase 1 identity
 * resolver enqueues `identity_resolution_review` items here when confidence
 * lands in the [0.65, 0.85) review band (SPEC.md §4.2).
 */
export async function enqueueReviewItem(
  input: EnqueueReviewItemInput,
): Promise<Result<UUID, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('human_review_queue')
    .insert({ item_type: input.itemType, payload: input.payload, status: 'pending' })
    .select('id')
    .single();
  if (result.error)
    return err(toQueryError('enqueueReviewItem', result.error, { itemType: input.itemType }));
  return ok((result.data as { id: UUID }).id);
}

/** Input for {@link writeResolutionConflict}. */
export interface WriteResolutionConflictInput {
  personId: UUID;
  conflictingEvidence: Metadata;
  status: ResolutionConflictStatus;
  detectedAt?: IsoTimestamp;
  resolutionNote?: string | null;
}

/**
 * Append a row to `resolution_conflict` (SPEC.md §4.5). Flagged by the
 * resolver when a merge would contradict existing employer/city data; left
 * for human review.
 */
export async function writeResolutionConflict(
  input: WriteResolutionConflictInput,
): Promise<Result<ResolutionConflict, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    person_id: input.personId,
    conflicting_evidence: input.conflictingEvidence,
    status: input.status,
    detected_at: input.detectedAt ?? new Date().toISOString(),
    resolution_note: input.resolutionNote ?? null,
  };
  const result = await c.value.from('resolution_conflict').insert(row).select().single();
  return envelope<ResolutionConflict>('writeResolutionConflict', result);
}

/**
 * Count distinct `matched_person_id`s with at least one `resolution_decision`
 * row. Used by `pnpm verify:phase-1` to confirm the Phase 1 exit criterion
 * "≥1 resolution_decision per Person".
 */
export async function countPersonsWithResolutionDecisions(): Promise<Result<number, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  // Supabase's PostgREST doesn't expose `DISTINCT count` directly, so fetch
  // the distinct ids and count client-side. For Phase 1 scale (<= low
  // thousands) this is cheap; if it ever grows we move to a SQL function.
  const result = await c.value
    .from('resolution_decision')
    .select('matched_person_id')
    .not('matched_person_id', 'is', null);
  if (result.error)
    return err(toQueryError('countPersonsWithResolutionDecisions', result.error, {}));
  const rows = (result.data ?? []) as Array<{ matched_person_id: UUID | null }>;
  const ids = new Set<UUID>();
  for (const r of rows) {
    if (r.matched_person_id) ids.add(r.matched_person_id);
  }
  return ok(ids.size);
}

/**
 * Aggregate `resolution_decision.action` counts. Used by the backfill script
 * to surface a summary at the end of a run.
 */
export async function summarizeResolutionDecisionsByAction(): Promise<
  Result<Record<ResolutionAction, number>, AtlasError>
> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('resolution_decision').select('action');
  if (result.error)
    return err(toQueryError('summarizeResolutionDecisionsByAction', result.error, {}));
  const rows = (result.data ?? []) as Array<{ action: ResolutionAction }>;
  const counts: Record<ResolutionAction, number> = {
    merge: 0,
    create_new: 0,
    human_review: 0,
    skip: 0,
  };
  for (const row of rows) counts[row.action] = (counts[row.action] ?? 0) + 1;
  return ok(counts);
}

/**
 * Read the full event history for one entity (most recent first).
 *
 * @example
 * ```ts
 * const history = await queryEntityHistory('person', personId, { limit: 50 });
 * ```
 */
export async function queryEntityHistory(
  entityType: string,
  entityId: UUID,
  options?: { since?: Date | string; limit?: number },
): Promise<Result<EntityEventLogRecord[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value
    .from('entity_event_log')
    .select()
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('occurred_at', { ascending: false });
  if (options?.since !== undefined) {
    const since = typeof options.since === 'string' ? options.since : options.since.toISOString();
    q = q.gte('occurred_at', since);
  }
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error)
    return err(toQueryError('queryEntityHistory', result.error, { entityType, entityId }));
  return ok((result.data ?? []) as EntityEventLogRecord[]);
}
