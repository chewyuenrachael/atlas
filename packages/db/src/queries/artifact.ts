/**
 * Named query helpers for `artifact`. See SPEC.md §3.2.5.
 *
 * Phase 1 fills in real implementations.
 */
import {
  err,
  QueryError,
  type Artifact,
  type AtlasError,
  type Result,
  type UUID,
} from '@atlas/core';

const NOT_IMPLEMENTED = (name: string): AtlasError =>
  new QueryError(`packages/db/queries/artifact.${name} is a Phase 0 stub`, 'NOT_IMPLEMENTED', {
    helper: name,
  });

export async function findArtifactById(_id: UUID): Promise<Result<Artifact | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findArtifactById'));
}

export async function insertArtifact(
  _input: Omit<Artifact, 'id' | 'created_at'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('insertArtifact'));
}

export async function listArtifactsByEvent(
  _eventId: UUID,
): Promise<Result<Artifact[], AtlasError>> {
  return err(NOT_IMPLEMENTED('listArtifactsByEvent'));
}
