/**
 * Named query helpers for the `company` table. See SPEC.md §3.2.2 and
 * §7.2 (champion enumeration).
 */
import { err, isErr, ok, type AtlasError, type Company, type Result, type UUID } from '@atlas/core';
import { envelope, svc, toQueryError } from './_internal.js';

/** Server-set fields are omitted; everything else is optional. */
export type CompanyInput = Partial<Omit<Company, 'id' | 'first_observed_at' | 'last_updated_at'>> &
  Pick<Company, 'canonical_name'>;

/**
 * Insert a new Company row.
 *
 * @example
 * ```ts
 * const r = await createCompany({ canonical_name: 'JPMorgan Chase', domain: 'jpmorgan.com' });
 * ```
 */
export async function createCompany(input: CompanyInput): Promise<Result<Company, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    canonical_name: input.canonical_name,
    domain: input.domain ?? null,
    aliases: input.aliases ?? [],
    vertical: input.vertical ?? null,
    employee_count_tier: input.employee_count_tier ?? null,
    fortune_rank: input.fortune_rank ?? null,
    geographic_hq_city: input.geographic_hq_city ?? null,
    geographic_hq_country: input.geographic_hq_country ?? null,
    target_account_status: input.target_account_status ?? null,
    enterprise_account_id: input.enterprise_account_id ?? null,
    aggregate_seat_count: input.aggregate_seat_count ?? 0,
    aggregate_composer_adoption: input.aggregate_composer_adoption ?? null,
    metadata: input.metadata ?? {},
  };
  const result = await c.value.from('company').insert(row).select().single();
  return envelope<Company>('createCompany', result);
}

/** Look up a Company by canonical UUID. Returns `null` when not found. */
export async function getCompanyById(id: UUID): Promise<Result<Company | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('company').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getCompanyById', result.error, { id }));
  return ok(result.data as Company | null);
}

/** Find a Company by exact-match domain (e.g. `jpmorgan.com`). */
export async function findCompanyByDomain(
  domain: string,
): Promise<Result<Company | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value
    .from('company')
    .select()
    .eq('domain', domain.toLowerCase())
    .maybeSingle();
  if (result.error) return err(toQueryError('findCompanyByDomain', result.error, { domain }));
  return ok(result.data as Company | null);
}

/** Find a Company by exact-match canonical_name. */
export async function findCompanyByName(name: string): Promise<Result<Company | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('company').select().eq('canonical_name', name).maybeSingle();
  if (result.error) return err(toQueryError('findCompanyByName', result.error, { name }));
  return ok(result.data as Company | null);
}

/** Find Companies whose `aliases` array contains the given alias. */
export async function findCompaniesByAliases(
  aliases: string[],
): Promise<Result<Company[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  if (aliases.length === 0) return ok([]);
  const result = await c.value.from('company').select().overlaps('aliases', aliases);
  if (result.error) return err(toQueryError('findCompaniesByAliases', result.error, { aliases }));
  return ok((result.data ?? []) as Company[]);
}

/**
 * Champion candidates within a Company: currently-employed Persons whose
 * lifecycle stage is `champion` or whose activity score is high.
 *
 * Matches the spirit of SPEC.md Appendix A.4 ("Enterprise Champions by
 * Company") but returns ids rather than the full join, so the caller can
 * hydrate as much detail as it needs.
 */
export async function findChampionsForCompany(
  companyId: UUID,
): Promise<Result<UUID[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const result = await sb
    .from('person_company')
    .select('person_id, is_current, person:person(id, lifecycle_stage, activity_score, is_active)')
    .eq('company_id', companyId)
    .eq('is_current', true);
  if (result.error)
    return err(toQueryError('findChampionsForCompany', result.error, { companyId }));
  // Supabase JS surfaces foreign-table selects as arrays in the TS layer even
  // when the relation is many → one. Cast through unknown and pick the first.
  type Row = {
    person_id: UUID;
    person:
      | { id: UUID; lifecycle_stage: string | null; activity_score: number; is_active: boolean }
      | { id: UUID; lifecycle_stage: string | null; activity_score: number; is_active: boolean }[]
      | null;
  };
  const rows = (result.data ?? []) as unknown as Row[];
  const ids: UUID[] = [];
  for (const r of rows) {
    const p = Array.isArray(r.person) ? (r.person[0] ?? null) : r.person;
    if (p === null) continue;
    if (!p.is_active) continue;
    if (p.lifecycle_stage === 'champion' || p.activity_score >= 50) ids.push(r.person_id);
  }
  return ok(ids);
}
