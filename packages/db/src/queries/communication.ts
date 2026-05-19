/**
 * Named query helpers for `communication` and its edge tables.
 * See SPEC.md §3.2.4 / §3.3.4.
 *
 * Phase 1 fills in real implementations.
 */
import {
  err,
  QueryError,
  type AtlasError,
  type Communication,
  type Result,
  type UUID,
} from '@atlas/core';

const NOT_IMPLEMENTED = (name: string): AtlasError =>
  new QueryError(
    `packages/db/queries/communication.${name} is a Phase 0 stub`,
    'NOT_IMPLEMENTED',
    { helper: name },
  );

export async function findCommunicationBySourceId(
  _platform: string,
  _sourceRecordId: string,
): Promise<Result<Communication | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findCommunicationBySourceId'));
}

export async function insertCommunication(
  _input: Omit<Communication, 'id' | 'ingested_at'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('insertCommunication'));
}

export async function listCommunicationsByAuthor(
  _personId: UUID,
  _opts?: { since?: string; limit?: number },
): Promise<Result<Communication[], AtlasError>> {
  return err(NOT_IMPLEMENTED('listCommunicationsByAuthor'));
}
