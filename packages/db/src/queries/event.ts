/**
 * Named query helpers for `event` and `person_event`. See SPEC.md §3.2.3 / §3.3.1.
 *
 * Phase 1 fills in real implementations.
 */
import {
  err,
  QueryError,
  type AtlasError,
  type Event as AtlasEvent,
  type PersonEventEdge,
  type Result,
  type UUID,
} from '@atlas/core';

const NOT_IMPLEMENTED = (name: string): AtlasError =>
  new QueryError(`packages/db/queries/event.${name} is a Phase 0 stub`, 'NOT_IMPLEMENTED', {
    helper: name,
  });

export async function findEventById(_id: UUID): Promise<Result<AtlasEvent | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findEventById'));
}

export async function findEventByLumaId(
  _lumaEventId: string,
): Promise<Result<AtlasEvent | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findEventByLumaId'));
}

export async function upsertEvent(
  _input: Omit<AtlasEvent, 'id' | 'created_at' | 'updated_at'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('upsertEvent'));
}

export async function upsertPersonEventEdge(
  _edge: Omit<PersonEventEdge, 'id'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('upsertPersonEventEdge'));
}

export async function listEventsByCity(_args: {
  city: string;
  country: string;
  fromDate?: string;
  programType?: string;
}): Promise<Result<AtlasEvent[], AtlasError>> {
  return err(NOT_IMPLEMENTED('listEventsByCity'));
}
