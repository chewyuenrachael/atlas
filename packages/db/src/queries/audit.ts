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
  type Metadata,
  type ResolutionAction,
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
