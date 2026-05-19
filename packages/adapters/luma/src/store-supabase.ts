/**
 * Supabase-backed implementation of {@link RawLumaStore}.
 *
 * Phase 1B shipped the adapter against an in-memory store while the
 * `raw_luma_event` query helpers in `@atlas/db` were stubs. With Phase 1A
 * merged, `EventQueries.insertRawLumaEvent` / `getRawLumaEventById` /
 * `markRawLumaEventNormalized` exist. This module is the production wiring
 * that the Phase 1D ingestion pipeline injects into `new LumaAdapter({ store })`.
 *
 * Result handling: the Supabase query helpers return `Result<T, AtlasError>`,
 * but the `RawLumaStore` interface predates Result and uses throwing async
 * APIs (the adapter wraps thrown errors in `IngestionError` at the boundary).
 * We honor the interface by unwrapping `Result` and rethrowing as
 * `IngestionError` so the adapter's existing error path keeps working.
 *
 * SPEC ref: SPEC.md §3.5 (raw envelope), §5.2.1 (Luma source), §5.4 (idempotency).
 */
import { IngestionError, type UUID } from '@atlas/core';
import { EventQueries } from '@atlas/db';
import type { RawLumaStore } from './adapter.js';
import type { RawLumaEvent } from './types.js';

/**
 * Persist `RawLumaEvent` records into the `raw_luma_event` table.
 *
 * Idempotency: insert by `luma_event_id` and return the existing row's id
 * when one is already present (SPEC.md §5.4). Re-runs after partial failure
 * are safe — no duplicate raw rows ever exist.
 *
 * @example
 * ```ts
 * const adapter = new LumaAdapter({ store: new SupabaseRawLumaStore() });
 * for await (const raw of adapter.fetch()) await adapter.storeRaw(raw);
 * ```
 */
export class SupabaseRawLumaStore implements RawLumaStore {
  async insert(record: RawLumaEvent): Promise<{ rawId: UUID; existed: boolean }> {
    const result = await EventQueries.insertRawLumaEvent({
      luma_event_id: record.lumaEventId,
      raw_payload: serializeRawLumaEvent(record),
    });
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawLumaStore.insert failed for luma_event_id=${record.lumaEventId}`,
        'INGESTION_FAILED',
        { luma_event_id: record.lumaEventId },
        result.error,
      );
    }
    return { rawId: result.value.id, existed: result.value.existed };
  }

  async getById(rawId: UUID): Promise<RawLumaEvent | null> {
    const result = await EventQueries.getRawLumaEventById(rawId);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawLumaStore.getById failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
    if (!result.value) return null;
    return deserializeRawLumaEvent(result.value.raw_payload);
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const result = await EventQueries.markRawLumaEventNormalized(rawId, 'success');
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawLumaStore.markNormalized failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }

  /**
   * Surface a normalization failure to operators. Not on the `RawLumaStore`
   * interface; called by the pipeline's catch handler so the row doesn't
   * sit at `pending` forever (SPEC.md §3.5 — operator visibility).
   */
  async markFailed(rawId: UUID, errorMessage: string): Promise<void> {
    const result = await EventQueries.markRawLumaEventNormalized(rawId, 'failed', errorMessage);
    if (!result.ok) {
      throw new IngestionError(
        `SupabaseRawLumaStore.markFailed failed for raw_id=${rawId}`,
        'INGESTION_FAILED',
        { raw_id: rawId },
        result.error,
      );
    }
  }
}

/**
 * `raw_payload` is a JSONB column. Serialize the in-memory `RawLumaEvent` to
 * a plain object that round-trips through JSONB without losing fields.
 */
function serializeRawLumaEvent(record: RawLumaEvent): Record<string, unknown> {
  return {
    luma_event_id: record.lumaEventId,
    detail: record.detail,
    scraped_at: record.scrapedAt,
    source_url: record.sourceUrl,
    payload_hash: record.payloadHash,
  };
}

/**
 * Inverse of {@link serializeRawLumaEvent}. The raw payload was written by
 * us, so we trust the shape; missing keys produce a partial reconstruction
 * that downstream `normalizeLumaEvent` will reject loudly.
 */
function deserializeRawLumaEvent(payload: Record<string, unknown>): RawLumaEvent {
  const raw = payload as {
    luma_event_id?: string;
    detail?: RawLumaEvent['detail'];
    scraped_at?: string;
    source_url?: string;
    payload_hash?: string;
  };
  return {
    lumaEventId: raw.luma_event_id ?? '',
    detail: raw.detail ?? ({} as RawLumaEvent['detail']),
    scrapedAt: raw.scraped_at ?? '',
    sourceUrl: raw.source_url ?? '',
    payloadHash: raw.payload_hash ?? '',
  };
}
