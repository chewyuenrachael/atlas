/**
 * Named query helpers for `program`. See SPEC.md §3.2.6 and §7.2 (program
 * KPIs are tracked as JSONB and updated by the workflow layer).
 */
import {
  err,
  isErr,
  ok,
  type AtlasError,
  type Metadata,
  type Program,
  type Result,
  type UUID,
} from '@atlas/core';
import { envelope, svc, toQueryError } from './_internal.js';

export type ProgramInput = Partial<Omit<Program, 'id' | 'created_at'>> &
  Pick<Program, 'name' | 'program_type'>;

/**
 * Insert a new Program row.
 *
 * @example
 * ```ts
 * await createProgram({ name: 'Café Cursor', program_type: 'cafe_cursor' });
 * ```
 */
export async function createProgram(input: ProgramInput): Promise<Result<Program, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const row: Record<string, unknown> = {
    name: input.name,
    program_type: input.program_type,
    owner_person_id: input.owner_person_id ?? null,
    description: input.description ?? null,
    is_vertical: input.is_vertical ?? false,
    vertical: input.vertical ?? null,
    active_cities: input.active_cities ?? [],
    target_cities: input.target_cities ?? [],
    kpis: input.kpis ?? {},
    is_active: input.is_active ?? true,
    metadata: input.metadata ?? {},
  };
  const result = await c.value.from('program').insert(row).select().single();
  return envelope<Program>('createProgram', result);
}

/** Look up a Program by canonical UUID. */
export async function getProgramById(id: UUID): Promise<Result<Program | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('program').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getProgramById', result.error, { id }));
  return ok(result.data as Program | null);
}

/** List Programs, optionally filtered to active ones. */
export async function listPrograms(options?: {
  activeOnly?: boolean;
}): Promise<Result<Program[], AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  let q = c.value.from('program').select().order('name', { ascending: true });
  if (options?.activeOnly) q = q.eq('is_active', true);
  const result = await q;
  if (result.error) return err(toQueryError('listPrograms', result.error));
  return ok((result.data ?? []) as Program[]);
}

/**
 * Merge a KPI patch into a Program's `kpis` JSONB. Existing keys are
 * overwritten; missing keys are preserved.
 *
 * @example
 * ```ts
 * await updateProgramKPIs(programId, { events_run_2026: 18, attendance: 412 });
 * ```
 */
export async function updateProgramKPIs(
  id: UUID,
  kpiPatch: Metadata,
): Promise<Result<Program, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const existing = await c.value.from('program').select('kpis').eq('id', id).single();
  if (existing.error) return err(toQueryError('updateProgramKPIs.read', existing.error, { id }));
  const merged: Metadata = {
    ...((existing.data as { kpis: Metadata }).kpis ?? {}),
    ...kpiPatch,
  };
  const result = await c.value
    .from('program')
    .update({ kpis: merged })
    .eq('id', id)
    .select()
    .single();
  return envelope<Program>('updateProgramKPIs', result, { id });
}
