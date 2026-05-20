/**
 * Supabase-backed implementation of {@link RawHackerNewsStore}.
 *
 * Mirrors the Luma adapter's `store-supabase.ts` pattern: every interface
 * method wraps a query helper in `@atlas/db`. Errors from the Result-returning
 * helpers are rethrown as `IngestionError` so the adapter's existing error
 * path keeps working.
 *
 * SPEC ref: SPEC.md §3.5 (raw envelope), §5.2.6 (HN source), §5.4 (idempotency).
 */
import { IngestionError, type UUID } from '@atlas/core';
import { HackerNewsQueries } from '@atlas/db';
import type { RawHackerNewsStore } from './adapter.js';
import type { RawHackerNewsItem } from './types.js';

export class SupabaseRawHackerNewsStore implements RawHackerNewsStore {
  async insert(record: RawHackerNewsItem): Promise<{ rawId: UUID; existed: boolean }> {
    const result = await HackerNewsQueries.insertRawHackerNewsItem({
      hn_item_id: record.hnItemId,
      raw_payload: serializeRawHackerNewsItem(record),
    });
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawHackerNewsStore.insert failed for hn_item_id=${record.hnItemId}`,
        'INGESTION_FAILED',
        { hn_item_id: record.hnItemId },
        result.error,
      );
    }
    return { rawId: result.value.id, existed: result.value.existed };
  }

  async getById(rawId: UUID): Promise<RawHackerNewsItem | null> {
    const result = await HackerNewsQueries.getRawHackerNewsItemById(rawId);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawHackerNewsStore.getById failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
    if (!result.value) return null;
    return deserializeRawHackerNewsItem(result.value.raw_payload);
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const result = await HackerNewsQueries.markRawHackerNewsItemNormalized(rawId, 'success');
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawHackerNewsStore.markNormalized failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }

  async markFailed(rawId: UUID, errorMessage: string): Promise<void> {
    const result = await HackerNewsQueries.markRawHackerNewsItemNormalized(
      rawId,
      'failed',
      errorMessage,
    );
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawHackerNewsStore.markFailed failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }
}

function serializeRawHackerNewsItem(record: RawHackerNewsItem): Record<string, unknown> {
  return {
    hn_item_id: record.hnItemId,
    item_type: record.itemType,
    hit: record.hit,
    fetched_at: record.fetchedAt,
    source_url: record.sourceUrl,
    payload_hash: record.payloadHash,
  };
}

function deserializeRawHackerNewsItem(payload: Record<string, unknown>): RawHackerNewsItem {
  const raw = payload as {
    hn_item_id?: string;
    item_type?: RawHackerNewsItem['itemType'];
    hit?: RawHackerNewsItem['hit'];
    fetched_at?: string;
    source_url?: string;
    payload_hash?: string;
  };
  return {
    hnItemId: raw.hn_item_id ?? '',
    itemType: raw.item_type ?? 'unknown',
    hit: raw.hit ?? ({} as RawHackerNewsItem['hit']),
    fetchedAt: raw.fetched_at ?? '',
    sourceUrl: raw.source_url ?? '',
    payloadHash: raw.payload_hash ?? '',
  };
}
