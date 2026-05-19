/**
 * Named query helpers for `signal` (SPEC.md §3.2.7). Emitting a signal also
 * appends to `entity_event_log` (SPEC.md §6.2) so downstream CDC subscribers
 * can react to it.
 */
import {
  err,
  isErr,
  ok,
  type AtlasError,
  type Result,
  type Signal,
  type SignalType,
  type UUID,
} from '@atlas/core';
import { envelope, svc, toQueryError } from './_internal.js';

export type SignalInput = Omit<Signal, 'id'>;

/**
 * Atomically insert a Signal row and append a `signal.emitted` event to
 * `entity_event_log`. Failure of the audit append rolls back the signal row.
 *
 * Atomicity caveat: PostgREST does not expose multi-statement transactions
 * directly. We approximate atomicity by issuing the audit append immediately
 * after the signal insert and, on failure of the second write, deleting the
 * first. Workflows that need true cross-table atomicity should use a stored
 * procedure (Phase 2 will introduce one).
 *
 * @example
 * ```ts
 * await emitSignal({
 *   person_id: id,
 *   signal_type: 'event_attended',
 *   value: 1,
 *   confidence: 1.0,
 *   observed_at: new Date().toISOString(),
 *   source_event_id: eventId,
 *   source_communication_id: null,
 *   source_artifact_id: null,
 *   decays_by: null,
 *   metadata: {},
 * });
 * ```
 */
export async function emitSignal(input: SignalInput): Promise<Result<Signal, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const row: Record<string, unknown> = {
    person_id: input.person_id,
    signal_type: input.signal_type,
    value: input.value ?? null,
    confidence: input.confidence ?? 1.0,
    observed_at: input.observed_at,
    source_communication_id: input.source_communication_id ?? null,
    source_event_id: input.source_event_id ?? null,
    source_artifact_id: input.source_artifact_id ?? null,
    decays_by: input.decays_by ?? null,
    metadata: input.metadata ?? {},
  };
  const insertResult = await sb.from('signal').insert(row).select().single();
  const signalRow = envelope<Signal>('emitSignal', insertResult);
  if (isErr(signalRow)) return signalRow;

  const auditResult = await sb.from('entity_event_log').insert({
    entity_type: 'signal',
    entity_id: signalRow.value.id,
    event_type: 'signal.emitted',
    actor: 'system',
    payload: {
      person_id: input.person_id,
      signal_type: input.signal_type,
      value: input.value,
      observed_at: input.observed_at,
    },
  });
  if (auditResult.error) {
    // Best-effort rollback: drop the just-inserted signal so we don't leave a
    // signal without its audit row.
    await sb.from('signal').delete().eq('id', signalRow.value.id);
    return err(toQueryError('emitSignal.audit', auditResult.error));
  }
  return ok(signalRow.value);
}

/** List Signals for a Person, optionally filtered by type and since-timestamp. */
export async function findSignalsByPerson(
  personId: UUID,
  options?: { signalType?: SignalType; since?: Date | string; limit?: number },
): Promise<Result<Signal[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value
    .from('signal')
    .select()
    .eq('person_id', personId)
    .order('observed_at', { ascending: false });
  if (options?.signalType) q = q.eq('signal_type', options.signalType);
  if (options?.since !== undefined) {
    const since = typeof options.since === 'string' ? options.since : options.since.toISOString();
    q = q.gte('observed_at', since);
  }
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error) return err(toQueryError('findSignalsByPerson', result.error, { personId }));
  return ok((result.data ?? []) as Signal[]);
}

/** Cross-Person view: list all Signals of a given type within an optional window. */
export async function findSignalsByType(
  type: SignalType,
  options?: { since?: Date | string; limit?: number },
): Promise<Result<Signal[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value
    .from('signal')
    .select()
    .eq('signal_type', type)
    .order('observed_at', { ascending: false });
  if (options?.since !== undefined) {
    const since = typeof options.since === 'string' ? options.since : options.since.toISOString();
    q = q.gte('observed_at', since);
  }
  if (options?.limit !== undefined) q = q.limit(options.limit);
  const result = await q;
  if (result.error) return err(toQueryError('findSignalsByType', result.error, { type }));
  return ok((result.data ?? []) as Signal[]);
}
