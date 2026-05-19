/**
 * Named query helpers for `signal`. See SPEC.md §3.2.7.
 *
 * Signals are the atomic unit of derived intelligence. Insertions are
 * frequent — scoring engines and adapters both write here. Phase 1 fills in
 * real implementations.
 */
import {
  err,
  QueryError,
  type AtlasError,
  type Result,
  type Signal,
  type SignalType,
  type UUID,
} from '@atlas/core';

const NOT_IMPLEMENTED = (name: string): AtlasError =>
  new QueryError(`packages/db/queries/signal.${name} is a Phase 0 stub`, 'NOT_IMPLEMENTED', {
    helper: name,
  });

export async function insertSignal(
  _input: Omit<Signal, 'id'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('insertSignal'));
}

export async function listSignalsForPerson(
  _personId: UUID,
  _opts?: { signalType?: SignalType; since?: string; limit?: number },
): Promise<Result<Signal[], AtlasError>> {
  return err(NOT_IMPLEMENTED('listSignalsForPerson'));
}

export async function pruneDecayedSignals(): Promise<Result<{ removed: number }, AtlasError>> {
  return err(NOT_IMPLEMENTED('pruneDecayedSignals'));
}
