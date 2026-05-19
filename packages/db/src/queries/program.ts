/**
 * Named query helpers for `program` and program edges. See SPEC.md §3.2.6.
 *
 * Phase 1 fills in real implementations.
 */
import {
  err,
  QueryError,
  type AtlasError,
  type Program,
  type Result,
  type UUID,
} from '@atlas/core';

const NOT_IMPLEMENTED = (name: string): AtlasError =>
  new QueryError(`packages/db/queries/program.${name} is a Phase 0 stub`, 'NOT_IMPLEMENTED', {
    helper: name,
  });

export async function findProgramById(_id: UUID): Promise<Result<Program | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findProgramById'));
}

export async function findProgramByName(
  _name: string,
): Promise<Result<Program | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findProgramByName'));
}

export async function upsertProgram(
  _input: Omit<Program, 'id' | 'created_at'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('upsertProgram'));
}

export async function listActivePrograms(): Promise<Result<Program[], AtlasError>> {
  return err(NOT_IMPLEMENTED('listActivePrograms'));
}
