/**
 * Named query helpers for the `company` table. See SPEC.md §3.2.2.
 *
 * Phase 1 fills in real implementations.
 */
import {
  err,
  QueryError,
  type AtlasError,
  type Company,
  type Result,
  type UUID,
} from '@atlas/core';

const NOT_IMPLEMENTED = (name: string): AtlasError =>
  new QueryError(`packages/db/queries/company.${name} is a Phase 0 stub`, 'NOT_IMPLEMENTED', {
    helper: name,
  });

export async function findCompanyById(_id: UUID): Promise<Result<Company | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findCompanyById'));
}

export async function findCompanyByDomain(
  _domain: string,
): Promise<Result<Company | null, AtlasError>> {
  return err(NOT_IMPLEMENTED('findCompanyByDomain'));
}

export async function upsertCompany(
  _input: Omit<Company, 'id' | 'first_observed_at' | 'last_updated_at'>,
): Promise<Result<UUID, AtlasError>> {
  return err(NOT_IMPLEMENTED('upsertCompany'));
}

export async function listChampionsForCompany(
  _companyId: UUID,
): Promise<Result<UUID[], AtlasError>> {
  return err(NOT_IMPLEMENTED('listChampionsForCompany'));
}
