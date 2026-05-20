/**
 * Named query helpers for `raw_hackernews_item`. See SPEC.md §3.5, §5.2.6.
 *
 * Mirrors the Luma raw-table helpers (`event.ts:insertRawLumaEvent` etc.)
 * so the HN ingest pipeline can swap the in-memory store for the Supabase
 * one without touching adapter or normalizer code.
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

export interface RawHackerNewsItemRow {
  id: UUID;
  hn_item_id: string;
  raw_payload: Metadata;
  ingested_at: IsoTimestamp;
  normalized_at: IsoTimestamp | null;
  normalization_status: NormalizationStatus | null;
  normalization_error: string | null;
}

export interface InsertRawHackerNewsItemInput {
  hn_item_id: string;
  raw_payload: Metadata;
}

/**
 * Idempotent insert into `raw_hackernews_item`. If a row already exists for
 * `hn_item_id`, returns the existing id with `existed: true`.
 */
export async function insertRawHackerNewsItem(
  input: InsertRawHackerNewsItemInput,
): Promise<Result<{ id: UUID; existed: boolean }, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const sb = c.value;
  const existing = await sb
    .from('raw_hackernews_item')
    .select('id')
    .eq('hn_item_id', input.hn_item_id)
    .maybeSingle();
  if (existing.error)
    return err(
      toQueryError('insertRawHackerNewsItem.lookup', existing.error, {
        hn_item_id: input.hn_item_id,
      }),
    );
  if (existing.data) {
    return ok({ id: (existing.data as { id: UUID }).id, existed: true });
  }
  const inserted = await sb
    .from('raw_hackernews_item')
    .insert({
      hn_item_id: input.hn_item_id,
      raw_payload: input.raw_payload,
      normalization_status: 'pending',
    })
    .select('id')
    .single();
  if (inserted.error)
    return err(
      toQueryError('insertRawHackerNewsItem.insert', inserted.error, {
        hn_item_id: input.hn_item_id,
      }),
    );
  return ok({ id: (inserted.data as { id: UUID }).id, existed: false });
}

export async function getRawHackerNewsItemById(
  id: UUID,
): Promise<Result<RawHackerNewsItemRow | null, AtlasError>> {
  const c = svc();
  if (isErr(c)) return c;
  const result = await c.value.from('raw_hackernews_item').select().eq('id', id).maybeSingle();
  if (result.error) return err(toQueryError('getRawHackerNewsItemById', result.error, { id }));
  return ok(result.data as RawHackerNewsItemRow | null);
}

export async function markRawHackerNewsItemNormalized(
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
  const result = await c.value.from('raw_hackernews_item').update(patch).eq('id', id);
  if (result.error)
    return err(toQueryError('markRawHackerNewsItemNormalized', result.error, { id, status }));
  return ok(undefined);
}
