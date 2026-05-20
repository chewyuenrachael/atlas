/**
 * HackerNewsAdapter — source adapter for Hacker News.
 *
 * Extends `BaseSourceAdapter<RawHackerNewsItem>` and implements the
 * SourceAdapter contract (SPEC.md §5.1). The base class provides rate-limit
 * enforcement, retry, and structured logging around the abstract hooks below.
 *
 * Persistence boundary: this Phase-2 implementation cannot insert into
 * `raw_hackernews_item` directly because the corresponding query helpers in
 * `packages/db/queries` do not exist yet. The adapter therefore accepts a
 * `RawHackerNewsStore` via the constructor — an `InMemoryRawHackerNewsStore`
 * is provided for tests and the CLI. A Supabase-backed store will land
 * alongside the HN query helpers in a follow-up PR, mirroring the Luma
 * Phase 1A → 1B transition.
 *
 * Pagination: `fetchPage` walks Algolia pages one at a time and surfaces a
 * `Cursor` carrying the next page number. The base class loops on the cursor
 * so all pages are consumed within a single `fetch()` invocation, subject
 * to the `maxPages` safety bound.
 *
 * @example
 * ```ts
 * const adapter = new HackerNewsAdapter();
 * for await (const raw of adapter.fetch()) {
 *   const { rawId } = await adapter.storeRaw(raw);
 *   const records = await adapter.normalize(rawId);
 * }
 * ```
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  IngestionError,
  NormalizationError,
  RATE_LIMIT_HACKERNEWS,
  logger,
  type Cursor,
  type Logger,
  type NormalizedRecord,
  type RateLimitConfig,
  type UUID,
} from '@atlas/core';
import { BaseSourceAdapter, type RetryOptions } from '@atlas/adapters-shared';
import {
  AlgoliaHackerNewsClient,
  type AlgoliaHackerNewsClientOptions,
} from './client.js';
import { classifyItemType, normalizeHackerNewsItem, hnItemPermalink } from './normalizer.js';
import type { HackerNewsAlgoliaHit, RawHackerNewsItem } from './types.js';

/**
 * Storage abstraction over the `raw_hackernews_item` table. The default
 * in-memory implementation is wired up for tests and the CLI. Production
 * wiring is deferred until the corresponding query helpers land in
 * `packages/db/queries` (mirrors the Luma adapter's Phase 1A → 1B path).
 */
export interface RawHackerNewsStore {
  /**
   * Insert one raw item. Idempotent: if a row already exists for the same
   * `hnItemId`, the store must return the existing row's `rawId` without
   * mutating the persisted payload.
   */
  insert(record: RawHackerNewsItem): Promise<{ rawId: UUID; existed: boolean }>;

  /** Read back a raw item by id. */
  getById(rawId: UUID): Promise<RawHackerNewsItem | null>;

  /** Mark a raw row as normalized so we don't re-emit downstream events. */
  markNormalized(rawId: UUID): Promise<void>;
}

/**
 * Simple in-memory implementation of `RawHackerNewsStore`. Keyed on
 * `hnItemId` (the unique constraint in SPEC.md §3.5). Re-inserting the same
 * item returns the same `rawId` without overwriting the stored payload.
 */
export class InMemoryRawHackerNewsStore implements RawHackerNewsStore {
  private readonly byHnId = new Map<string, { rawId: UUID; record: RawHackerNewsItem }>();
  private readonly byRawId = new Map<
    UUID,
    { record: RawHackerNewsItem; normalizedAt: string | null }
  >();

  async insert(
    record: RawHackerNewsItem,
  ): Promise<{ rawId: UUID; existed: boolean }> {
    const existing = this.byHnId.get(record.hnItemId);
    if (existing) {
      return { rawId: existing.rawId, existed: true };
    }
    const rawId: UUID = randomUUID();
    this.byHnId.set(record.hnItemId, { rawId, record });
    this.byRawId.set(rawId, { record, normalizedAt: null });
    return { rawId, existed: false };
  }

  async getById(rawId: UUID): Promise<RawHackerNewsItem | null> {
    return this.byRawId.get(rawId)?.record ?? null;
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const entry = this.byRawId.get(rawId);
    if (entry) entry.normalizedAt = new Date().toISOString();
  }

  /** Test/CLI convenience: snapshot of all stored items. */
  list(): RawHackerNewsItem[] {
    return [...this.byHnId.values()].map((v) => v.record);
  }

  size(): number {
    return this.byHnId.size;
  }
}

/**
 * Configuration for the HN adapter.
 */
export interface HackerNewsAdapterOptions {
  /** Override the raw store. Defaults to a fresh `InMemoryRawHackerNewsStore`. */
  store?: RawHackerNewsStore;
  /** Override or pre-construct the Algolia client. */
  client?: AlgoliaHackerNewsClient;
  /** Client options passed when constructing the default client. */
  clientOptions?: AlgoliaHackerNewsClientOptions;
  /** Retry policy override for the base class. */
  retryOptions?: RetryOptions;
  /** Inject a clock for deterministic tests. */
  now?: () => Date;
  /**
   * Cap on how many Algolia pages to walk in a single `fetch()`. Defaults to
   * 50 (≈ 1000 items at the default `hitsPerPage`). Prevents a runaway poll
   * if a future Cursor surge produces many thousands of new mentions.
   */
  maxPages?: number;
  /**
   * Optional initial `created_at_i` cutoff (unix seconds). When set, the
   * first request includes `numericFilters=created_at_i>sinceUnix`. Used
   * by callers tracking their own external checkpoint.
   */
  sinceUnix?: number;
}

const DEFAULT_MAX_PAGES = 50;

/** Cursor payload encoded into `Cursor.value`. */
interface HackerNewsCursorState {
  page: number;
  sinceUnix: number | null;
}

export class HackerNewsAdapter extends BaseSourceAdapter<RawHackerNewsItem> {
  readonly sourceName = 'hackernews';
  readonly rateLimit: RateLimitConfig = RATE_LIMIT_HACKERNEWS;

  protected readonly store: RawHackerNewsStore;
  protected readonly client: AlgoliaHackerNewsClient;
  protected readonly clock: () => Date;
  protected readonly maxPages: number;
  protected readonly initialSinceUnix: number | undefined;
  protected readonly adapterLog: Logger;

  constructor(options: HackerNewsAdapterOptions = {}) {
    super(options.retryOptions ?? { maxAttempts: 3 });
    this.store = options.store ?? new InMemoryRawHackerNewsStore();
    this.client =
      options.client ?? new AlgoliaHackerNewsClient(options.clientOptions ?? {});
    this.clock = options.now ?? (() => new Date());
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (options.sinceUnix !== undefined) this.initialSinceUnix = options.sinceUnix;
    this.adapterLog = logger.child({ adapter: 'hackernews' });
  }

  override idempotencyKey(record: RawHackerNewsItem): string {
    return `hackernews:item:${record.hnItemId}`;
  }

  /**
   * Fetch one Algolia page and return its items plus the next cursor. The
   * base class iterates until `next` is undefined or `items` is empty,
   * giving us a single-page-per-call rate-limited walk through the search
   * results.
   */
  protected override async fetchPage(
    cursor: Cursor | undefined,
  ): Promise<{ items: RawHackerNewsItem[]; next?: Cursor }> {
    const state = decodeCursor(cursor) ?? {
      page: 0,
      sinceUnix: this.initialSinceUnix ?? null,
    };
    if (state.page >= this.maxPages) {
      this.adapterLog.warn(
        { page: state.page, max_pages: this.maxPages },
        'reached fetchPage safety bound; stopping',
      );
      return { items: [] };
    }

    const searchParams: { page: number; sinceUnix?: number } = { page: state.page };
    if (state.sinceUnix !== null) searchParams.sinceUnix = state.sinceUnix;
    const response = await this.client.search(searchParams);

    this.adapterLog.info(
      {
        page: state.page,
        nb_pages: response.nbPages,
        nb_hits: response.nbHits,
        hits_in_page: response.hits.length,
        since_unix: state.sinceUnix,
      },
      'fetched algolia hn page',
    );

    const items: RawHackerNewsItem[] = response.hits.map((hit) => this.buildRawRecord(hit));

    // Algolia pages are zero-indexed, so the last valid page is `nbPages - 1`.
    const morePages = state.page + 1 < response.nbPages;
    if (!morePages || items.length === 0) {
      return { items };
    }
    const nextState: HackerNewsCursorState = {
      page: state.page + 1,
      sinceUnix: state.sinceUnix,
    };
    return { items, next: encodeCursor(nextState) };
  }

  protected override async persistRaw(
    record: RawHackerNewsItem,
  ): Promise<{ rawId: UUID }> {
    try {
      const { rawId } = await this.store.insert(record);
      return { rawId };
    } catch (cause) {
      throw new IngestionError(
        'failed to persist raw hackernews item',
        'INGESTION_FAILED',
        { hn_item_id: record.hnItemId },
        cause,
      );
    }
  }

  protected override async normalizeRaw(rawId: UUID): Promise<NormalizedRecord[]> {
    const raw = await this.store.getById(rawId);
    if (!raw) {
      throw new NormalizationError('raw hackernews item not found', 'NORMALIZATION_FAILED', {
        raw_id: rawId,
      });
    }
    const records = normalizeHackerNewsItem(raw);
    if (records.length > 0) {
      await this.store.markNormalized(rawId).catch((cause: unknown) => {
        this.adapterLog.warn({ err: cause, raw_id: rawId }, 'markNormalized failed');
      });
    }
    return records;
  }

  /**
   * Wrap an Algolia hit into the durable raw envelope. Computes the
   * `payloadHash` so re-runs that produce identical hits can be skipped
   * downstream.
   */
  protected buildRawRecord(hit: HackerNewsAlgoliaHit): RawHackerNewsItem {
    const fetchedAt = this.clock().toISOString();
    const payloadHash = computePayloadHash(hit);
    const itemType = classifyItemType(hit);
    return {
      hnItemId: hit.objectID,
      itemType,
      hit,
      fetchedAt,
      sourceUrl: hnItemPermalink(hit.objectID),
      payloadHash,
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor encoding — Cursor.value is a string, so we JSON-encode our state.
// ---------------------------------------------------------------------------

function encodeCursor(state: HackerNewsCursorState): Cursor {
  return {
    value: JSON.stringify(state),
    observedAt: null,
  };
}

function decodeCursor(cursor: Cursor | undefined): HackerNewsCursorState | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor.value) as Partial<HackerNewsCursorState> | null;
    if (!parsed || typeof parsed.page !== 'number') return null;
    const page = parsed.page;
    const sinceUnix =
      typeof parsed.sinceUnix === 'number' && Number.isFinite(parsed.sinceUnix)
        ? parsed.sinceUnix
        : null;
    return { page, sinceUnix };
  } catch {
    return null;
  }
}

/**
 * SHA-256 hex digest over a stable JSON serialization of the Algolia hit.
 * Object keys are sorted so the same logical content always hashes the same.
 */
function computePayloadHash(hit: HackerNewsAlgoliaHit): string {
  return createHash('sha256').update(canonicalize(hit)).digest('hex');
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
