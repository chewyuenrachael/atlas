/**
 * Named query helpers for `raw_reddit_post`. See SPEC.md §3.5, §5.2.5.
 *
 * The Reddit raw table stores both posts (`t3_*`) and comments (`t1_*`) — the
 * `reddit_post_id` column carries the full Reddit "thing id" (`thingId` on
 * the adapter's `RawRedditItem`).
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

export interface RawRedditPostRow {
  id: UUID;
  reddit_post_id: string;
  raw_payload: Metadata;
  ingested_at: IsoTimestamp;
  normalized_at: IsoTimestamp | null;
  normalization_status: NormalizationStatus | null;
  normalization_error: string | null;
}

export interface InsertRawRedditPostInput {
  reddit_post_id: string;
  raw_payload: Metadata;
}

export async function insertRawRedditPost(
  input: InsertRawRedditPostInput,
): Promise<Result<{ id: UUID; existed: boolean }, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const existing = await sb
    .from('raw_reddit_post')
    .select('id')
    .eq('reddit_post_id', input.reddit_post_id)
    .maybeSingle();
  if (existing.error)
    return err(
      toQueryError('insertRawRedditPost.lookup', existing.error, {
        reddit_post_id: input.reddit_post_id,
      }),
    );
  if (existing.data) {
    return ok({ id: (existing.data as { id: UUID }).id, existed: true });
  }
  const inserted = await sb
    .from('raw_reddit_post')
    .insert({
      reddit_post_id: input.reddit_post_id,
      raw_payload: input.raw_payload,
      normalization_status: 'pending',
    })
    .select('id')
    .single();
  if (inserted.error)
    return err(
      toQueryError('insertRawRedditPost.insert', inserted.error, {
        reddit_post_id: input.reddit_post_id,
      }),
    );
  return ok({ id: (inserted.data as { id: UUID }).id, existed: false });
}

export async function getRawRedditPostById(
  id: UUID,
): Promise<Result<RawRedditPostRow | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('raw_reddit_post').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getRawRedditPostById', result.error, { id }));
  return ok(result.data as RawRedditPostRow | null);
}

export async function markRawRedditPostNormalized(
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
  const result = await c.value.from('raw_reddit_post').update(patch).eq('id', id);
  if (result.error)
    return err(toQueryError('markRawRedditPostNormalized', result.error, { id, status }));
  return ok(undefined);
}
