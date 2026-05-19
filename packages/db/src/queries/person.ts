/**
 * Named query helpers for `person` and `person_platform_identity` tables.
 * See SPEC.md §3.2.1.
 *
 * All access to the person table flows through this file. Adapters,
 * workflows, and the API layer call these helpers — never raw SQL outside
 * `packages/db`.
 *
 * Phase 1 fills in real implementations. The signatures below are the
 * contract every consumer can rely on.
 */
import {
  err,
  ok,
  QueryError,
  type AtlasError,
  type Person,
  type Result,
  type UUID,
} from '@atlas/core';

const NOT_IMPLEMENTED = (name: string): AtlasError =>
  new QueryError(`packages/db/queries/person.${name} is a Phase 0 stub`, 'NOT_IMPLEMENTED', {
    helper: name,
  });

/** Look up a Person by canonical UUID. */
export async function findPersonById(_id: UUID): Promise<Result<Person | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findPersonById'));
}

/** Insert a new Person row. Returns the canonical id. */
export async function insertPerson(
  _input: Omit<Person, 'id' | 'first_observed_at' | 'last_observed_at'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('insertPerson'));
}

/** Update a Person row with the given partial. */
export async function updatePerson(
  _id: UUID,
  _patch: Partial<Person>,
): Promise<Result<Person, AtlasError>> {
  return err(NOT_IMPLEMENTED('updatePerson'));
}

/** Find candidate Persons matching any of the supplied emails or handles. */
export async function findPersonCandidates(_args: {
  emails?: string[];
  handles?: { platform: string; handle: string }[];
  name?: string;
  limit?: number;
}): Promise<Result<Person[], AtlasError>> {
  return err(NOT_IMPLEMENTED('findPersonCandidates'));
}

/** Touch a Person's `last_observed_at`. */
export async function touchPerson(_id: UUID): Promise<Result<void, AtlasError>> {
  return err(NOT_IMPLEMENTED('touchPerson'));
}

export const __exportsForTests = { ok, err };
