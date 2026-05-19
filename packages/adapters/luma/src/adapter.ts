/**
 * LumaAdapter — source adapter for Luma events.
 *
 * Extends `BaseSourceAdapter<RawLumaEvent>` and implements the SourceAdapter
 * contract (SPEC.md §5.1). The base class provides rate-limit enforcement,
 * retry, and structured logging around the abstract hooks below.
 *
 * Persistence boundary: this Phase-1A implementation cannot insert into
 * `raw_luma_event` directly because the corresponding query helper in
 * `packages/db/queries/event.ts` is a stub. The adapter therefore accepts a
 * `RawLumaStore` via the constructor — an `InMemoryRawLumaStore` is provided
 * for tests and the CLI, and Phase 1B will swap in a Supabase-backed store
 * once `EventQueries.insertRawLumaEvent` lands. See README "Phase 1B follow-up".
 *
 * @example
 * ```ts
 * const adapter = new LumaAdapter();
 * for await (const raw of adapter.fetch()) {
 *   const { rawId } = await adapter.storeRaw(raw);
 *   const records = await adapter.normalize(rawId);
 * }
 * ```
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import {
  IngestionError,
  NormalizationError,
  RATE_LIMIT_LUMA,
  logger,
  type Cursor,
  type Logger,
  type NormalizedRecord,
  type RateLimitConfig,
  type UUID,
} from '@atlas/core';
import { BaseSourceAdapter, type RetryOptions } from '@atlas/adapters-shared';
import { normalizeLumaEvent } from './normalizer.js';
import { scrapeCommunityPage, scrapeEventDetail, type ScraperOptions } from './scraper.js';
import type { RawLumaEvent, ScrapedEventDetail } from './types.js';

/**
 * Storage abstraction over the `raw_luma_event` table. The default in-memory
 * implementation is wired up for tests and the CLI. Production wiring is
 * deferred to Phase 1B once `packages/db/queries/event.ts` exposes the
 * corresponding helpers (`insertRawLumaEvent`, `getRawLumaEventById`).
 */
export interface RawLumaStore {
  /**
   * Insert one raw event. Idempotent: if a row already exists for the same
   * `lumaEventId`, the store must return the existing row's `rawId`.
   */
  insert(record: RawLumaEvent): Promise<{ rawId: UUID; existed: boolean }>;

  /** Read back a raw event by id. */
  getById(rawId: UUID): Promise<RawLumaEvent | null>;

  /** Mark a raw row as normalized so we don't re-emit downstream events. */
  markNormalized(rawId: UUID): Promise<void>;
}

/**
 * Simple in-memory implementation of `RawLumaStore`. Keyed on `lumaEventId`
 * (the unique constraint in SPEC.md §3.5). Re-inserting the same event
 * returns the same `rawId` without overwriting the stored payload.
 */
export class InMemoryRawLumaStore implements RawLumaStore {
  private readonly byLumaId = new Map<string, { rawId: UUID; record: RawLumaEvent }>();
  private readonly byRawId = new Map<UUID, { record: RawLumaEvent; normalizedAt: string | null }>();

  async insert(record: RawLumaEvent): Promise<{ rawId: UUID; existed: boolean }> {
    const existing = this.byLumaId.get(record.lumaEventId);
    if (existing) {
      return { rawId: existing.rawId, existed: true };
    }
    const rawId: UUID = randomUUID();
    this.byLumaId.set(record.lumaEventId, { rawId, record });
    this.byRawId.set(rawId, { record, normalizedAt: null });
    return { rawId, existed: false };
  }

  async getById(rawId: UUID): Promise<RawLumaEvent | null> {
    return this.byRawId.get(rawId)?.record ?? null;
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const entry = this.byRawId.get(rawId);
    if (entry) entry.normalizedAt = new Date().toISOString();
  }

  /** Test/CLI convenience: snapshot of all stored events. */
  list(): RawLumaEvent[] {
    return [...this.byLumaId.values()].map((v) => v.record);
  }

  size(): number {
    return this.byLumaId.size;
  }
}

export interface LumaAdapterOptions {
  /** Override the raw store. Defaults to a fresh `InMemoryRawLumaStore`. */
  store?: RawLumaStore;
  /** Scraper configuration overrides — base URL, cache, etc. */
  scraperOptions?: ScraperOptions;
  /** Override the retry policy for the base class. */
  retryOptions?: RetryOptions;
  /** Inject a clock for deterministic tests. */
  now?: () => Date;
  /**
   * Optional alternative scraper functions — primarily for tests that want to
   * exercise the adapter without monkey-patching modules. Both default to the
   * playwright-backed implementations in `./scraper.ts`.
   */
  fetchListings?: typeof scrapeCommunityPage;
  fetchDetail?: typeof scrapeEventDetail;
}

export class LumaAdapter extends BaseSourceAdapter<RawLumaEvent> {
  readonly sourceName = 'luma';
  readonly rateLimit: RateLimitConfig = RATE_LIMIT_LUMA;

  protected readonly store: RawLumaStore;
  protected readonly scraperOptions: ScraperOptions;
  protected readonly fetchListings: typeof scrapeCommunityPage;
  protected readonly fetchDetail: typeof scrapeEventDetail;
  protected readonly clock: () => Date;
  protected readonly adapterLog: Logger;

  constructor(options: LumaAdapterOptions = {}) {
    super(options.retryOptions ?? { maxAttempts: 3 });
    this.store = options.store ?? new InMemoryRawLumaStore();
    this.scraperOptions = options.scraperOptions ?? {};
    this.fetchListings = options.fetchListings ?? scrapeCommunityPage;
    this.fetchDetail = options.fetchDetail ?? scrapeEventDetail;
    this.clock = options.now ?? (() => new Date());
    this.adapterLog = logger.child({ adapter: 'luma' });
  }

  override idempotencyKey(record: RawLumaEvent): string {
    return `luma:event:${record.lumaEventId}`;
  }

  /**
   * Discover events on the community page, then fetch each detail page and
   * yield the raw record envelope.
   *
   * The fetch is single-page: we discover all listings once, then iterate.
   * Pagination is not relevant for the community-events page itself — Luma
   * renders all upcoming events on a single SPA route. A future page-token
   * cursor would only be needed if Luma adds a paginated archive view.
   */
  protected override async fetchPage(
    _cursor: Cursor | undefined,
  ): Promise<{ items: RawLumaEvent[]; next?: Cursor }> {
    const listings = await this.fetchListings(this.scraperOptions);
    this.adapterLog.info({ listing_count: listings.length }, 'discovered events on community page');

    const items: RawLumaEvent[] = [];
    for (const listing of listings) {
      try {
        const detail = await this.fetchDetail(listing.url, this.scraperOptions);
        const raw = this.buildRawRecord(detail, listing.url);
        items.push(raw);
      } catch (cause) {
        // Per task brief: HTML structure change / per-event scrape failure
        // logs the error, skips the event, and continues with the rest.
        this.adapterLog.warn(
          { err: cause, slug: listing.slug, url: listing.url },
          'failed to fetch event detail; skipping',
        );
      }
    }
    return { items };
  }

  protected override async persistRaw(record: RawLumaEvent): Promise<{ rawId: UUID }> {
    try {
      const { rawId } = await this.store.insert(record);
      return { rawId };
    } catch (cause) {
      throw new IngestionError(
        'failed to persist raw luma event',
        'INGESTION_FAILED',
        { luma_event_id: record.lumaEventId },
        cause,
      );
    }
  }

  protected override async normalizeRaw(rawId: UUID): Promise<NormalizedRecord[]> {
    const raw = await this.store.getById(rawId);
    if (!raw) {
      throw new NormalizationError('raw luma event not found', 'NORMALIZATION_FAILED', {
        raw_id: rawId,
      });
    }
    const records = normalizeLumaEvent(raw);
    if (records.length > 0) {
      await this.store.markNormalized(rawId).catch((cause: unknown) => {
        this.adapterLog.warn({ err: cause, raw_id: rawId }, 'markNormalized failed');
      });
    }
    return records;
  }

  /**
   * Wrap a scraped detail snapshot into the durable raw envelope. Computes
   * the `payloadHash` so re-runs that produce identical detail snapshots
   * can be skipped downstream.
   */
  protected buildRawRecord(detail: ScrapedEventDetail, sourceUrl: string): RawLumaEvent {
    const scrapedAt = this.clock().toISOString();
    const payloadHash = computePayloadHash(detail);
    return {
      lumaEventId: detail.slug,
      detail,
      scrapedAt,
      sourceUrl,
      payloadHash,
    };
  }
}

/**
 * SHA-256 hex digest over a stable JSON serialization of the detail. Object
 * keys are sorted so the same logical content always hashes the same.
 */
function computePayloadHash(detail: ScrapedEventDetail): string {
  return createHash('sha256').update(canonicalize(detail)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const obj = value as Record<string, unknown>;
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
