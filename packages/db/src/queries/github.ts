/**
 * Named query helpers for `raw_github_profile` and `raw_github_repo`.
 * See SPEC.md §3.5, §5.2.2.
 *
 * Two raw tables in this module:
 *   - `raw_github_profile` — keyed on lower-cased GitHub login.
 *   - `raw_github_repo` — keyed on REST numeric `repo_id` (Phase 2D migration
 *     0004 added this table; the SPEC's `raw_github_commit` is reserved for a
 *     different future feed).
 */
import {
  err,
  isErr,
  ok,
  type AtlasError,
  type IsoTimestamp,
  type Metadata,
  type NormalizationStatus,
  type Result,
  type UUID,
} from '@atlas/core';
import { svc, toQueryError } from './_internal.js';

// ---------------------------------------------------------------------------
// raw_github_profile
// ---------------------------------------------------------------------------

export interface RawGithubProfileRow {
  id: UUID;
  github_login: string;
  raw_payload: Metadata;
  ingested_at: IsoTimestamp;
  normalized_at: IsoTimestamp | null;
  normalization_status: NormalizationStatus | null;
  normalization_error: string | null;
}

export interface InsertRawGithubProfileInput {
  github_login: string;
  raw_payload: Metadata;
}

/**
 * Idempotent upsert into `raw_github_profile`. Profile refreshes are
 * intentionally destructive — the most recent snapshot wins — but the row id
 * is stable per login.
 */
export async function insertRawGithubProfile(
  input: InsertRawGithubProfileInput,
): Promise<Result<{ id: UUID; existed: boolean }, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const existing = await sb
    .from('raw_github_profile')
    .select('id')
    .eq('github_login', input.github_login)
    .maybeSingle();
  if (existing.error)
    return err(
      toQueryError('insertRawGithubProfile.lookup', existing.error, {
        github_login: input.github_login,
      }),
    );
  if (existing.data) {
    const update = await sb
      .from('raw_github_profile')
      .update({
        raw_payload: input.raw_payload,
        normalization_status: 'pending',
        normalized_at: null,
        normalization_error: null,
      })
      .eq('id', (existing.data as { id: UUID }).id);
    if (update.error)
      return err(
        toQueryError('insertRawGithubProfile.update', update.error, {
          github_login: input.github_login,
        }),
      );
    return ok({ id: (existing.data as { id: UUID }).id, existed: true });
  }
  const inserted = await sb
    .from('raw_github_profile')
    .insert({
      github_login: input.github_login,
      raw_payload: input.raw_payload,
      normalization_status: 'pending',
    })
    .select('id')
    .single();
  if (inserted.error)
    return err(
      toQueryError('insertRawGithubProfile.insert', inserted.error, {
        github_login: input.github_login,
      }),
    );
  return ok({ id: (inserted.data as { id: UUID }).id, existed: false });
}

export async function getRawGithubProfileById(
  id: UUID,
): Promise<Result<RawGithubProfileRow | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('raw_github_profile').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getRawGithubProfileById', result.error, { id }));
  return ok(result.data as RawGithubProfileRow | null);
}

export async function markRawGithubProfileNormalized(
  id: UUID,
  status: NormalizationStatus,
  errorMessage?: string,
): Promise<Result<void, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const patch: Record<string, unknown> = {
    normalization_status: status,
    normalized_at: status === 'pending' ? null : new Date().toISOString(),
    normalization_error: errorMessage ?? null,
  };
  const result = await c.value.from('raw_github_profile').update(patch).eq('id', id);
  if (result.error)
    return err(toQueryError('markRawGithubProfileNormalized', result.error, { id, status }));
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// raw_github_repo
// ---------------------------------------------------------------------------

export interface RawGithubRepoRow {
  id: UUID;
  repo_id: number;
  repo_node_id: string;
  raw_payload: Metadata;
  ingested_at: IsoTimestamp;
  normalized_at: IsoTimestamp | null;
  normalization_status: NormalizationStatus | null;
  normalization_error: string | null;
}

export interface InsertRawGithubRepoInput {
  repo_id: number;
  repo_node_id: string;
  raw_payload: Metadata;
}

export async function insertRawGithubRepo(
  input: InsertRawGithubRepoInput,
): Promise<Result<{ id: UUID; existed: boolean }, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const existing = await sb
    .from('raw_github_repo')
    .select('id')
    .eq('repo_id', input.repo_id)
    .maybeSingle();
  if (existing.error)
    return err(
      toQueryError('insertRawGithubRepo.lookup', existing.error, { repo_id: input.repo_id }),
    );
  if (existing.data) {
    const update = await sb
      .from('raw_github_repo')
      .update({
        repo_node_id: input.repo_node_id,
        raw_payload: input.raw_payload,
        normalization_status: 'pending',
        normalized_at: null,
        normalization_error: null,
      })
      .eq('id', (existing.data as { id: UUID }).id);
    if (update.error)
      return err(
        toQueryError('insertRawGithubRepo.update', update.error, { repo_id: input.repo_id }),
      );
    return ok({ id: (existing.data as { id: UUID }).id, existed: true });
  }
  const inserted = await sb
    .from('raw_github_repo')
    .insert({
      repo_id: input.repo_id,
      repo_node_id: input.repo_node_id,
      raw_payload: input.raw_payload,
      normalization_status: 'pending',
    })
    .select('id')
    .single();
  if (inserted.error)
    return err(
      toQueryError('insertRawGithubRepo.insert', inserted.error, { repo_id: input.repo_id }),
    );
  return ok({ id: (inserted.data as { id: UUID }).id, existed: false });
}

export async function getRawGithubRepoById(
  id: UUID,
): Promise<Result<RawGithubRepoRow | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('raw_github_repo').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getRawGithubRepoById', result.error, { id }));
  return ok(result.data as RawGithubRepoRow | null);
}

export async function markRawGithubRepoNormalized(
  id: UUID,
  status: NormalizationStatus,
  errorMessage?: string,
): Promise<Result<void, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const patch: Record<string, unknown> = {
    normalization_status: status,
    normalized_at: status === 'pending' ? null : new Date().toISOString(),
    normalization_error: errorMessage ?? null,
  };
  const result = await c.value.from('raw_github_repo').update(patch).eq('id', id);
  if (result.error)
    return err(toQueryError('markRawGithubRepoNormalized', result.error, { id, status }));
  return ok(undefined);
}
