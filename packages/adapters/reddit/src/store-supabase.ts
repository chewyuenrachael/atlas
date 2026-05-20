/**
 * Supabase-backed implementation of {@link RawRedditStore}.
 *
 * Mirrors the Luma adapter's `store-supabase.ts` pattern.
 *
 * SPEC ref: SPEC.md §3.5 (raw envelope), §5.2.5 (Reddit source), §5.4 (idempotency).
 */
import { IngestionError, type UUID } from '@atlas/core';
import { RedditQueries } from '@atlas/db';
import type { RawRedditStore } from './adapter.js';
import type { RawRedditItem } from './types.js';

export class SupabaseRawRedditStore implements RawRedditStore {
  async insert(record: RawRedditItem): Promise<{ rawId: UUID; existed: boolean }> {
    const result = await RedditQueries.insertRawRedditPost({
      reddit_post_id: record.thingId,
      raw_payload: serializeRawRedditItem(record),
    });
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawRedditStore.insert failed for thing_id=${record.thingId}`,
        'INGESTION_FAILED',
        { thing_id: record.thingId },
        result.error,
      );
    }
    return { rawId: result.value.id, existed: result.value.existed };
  }

  async getById(rawId: UUID): Promise<RawRedditItem | null> {
    const result = await RedditQueries.getRawRedditPostById(rawId);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawRedditStore.getById failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
    if (!result.value) return null;
    return deserializeRawRedditItem(result.value.raw_payload);
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const result = await RedditQueries.markRawRedditPostNormalized(rawId, 'success');
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawRedditStore.markNormalized failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }

  async markFailed(rawId: UUID, errorMessage: string): Promise<void> {
    const result = await RedditQueries.markRawRedditPostNormalized(rawId, 'failed', errorMessage);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawRedditStore.markFailed failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }
}

function serializeRawRedditItem(record: RawRedditItem): Record<string, unknown> {
  return {
    thing_id: record.thingId,
    kind: record.kind,
    post_fullname: record.postFullname,
    subreddit: record.subreddit,
    envelope: record.envelope,
    cursor_relevance: record.cursorRelevance,
    fetched_at: record.fetchedAt,
    source_url: record.sourceUrl,
    payload_hash: record.payloadHash,
  };
}

function deserializeRawRedditItem(payload: Record<string, unknown>): RawRedditItem {
  const raw = payload as {
    thing_id?: string;
    kind?: RawRedditItem['kind'];
    post_fullname?: string;
    subreddit?: string;
    envelope?: RawRedditItem['envelope'];
    cursor_relevance?: RawRedditItem['cursorRelevance'];
    fetched_at?: string;
    source_url?: string;
    payload_hash?: string;
  };
  return {
    thingId: raw.thing_id ?? '',
    kind: raw.kind ?? 't3',
    postFullname: raw.post_fullname ?? '',
    subreddit: raw.subreddit ?? '',
    envelope: raw.envelope ?? ({} as RawRedditItem['envelope']),
    cursorRelevance:
      raw.cursor_relevance ??
      ({ score: 0, matchedCursor: false, boostTerms: [], tokenCount: 0 } as RawRedditItem['cursorRelevance']),
    fetchedAt: raw.fetched_at ?? '',
    sourceUrl: raw.source_url ?? '',
    payloadHash: raw.payload_hash ?? '',
  };
}
