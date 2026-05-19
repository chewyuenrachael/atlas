/**
 * BaseSourceAdapter — the abstract class every concrete adapter extends.
 *
 * Concrete adapters (Luma, GitHub, Twitter, etc.) supply source-specific
 * fetch / store / normalize logic and inherit:
 *   - rate-limited iteration around fetch
 *   - retry around storeRaw and normalize
 *   - structured logging with correlation context
 *   - Result-based error reporting at module boundaries
 *
 * See SPEC.md §5.1 for the contract and §5.2 for per-source specifics.
 *
 * @example
 * ```ts
 * export class LumaAdapter extends BaseSourceAdapter<RawLumaEvent> {
 *   readonly sourceName = 'luma';
 *   readonly rateLimit = RATE_LIMIT_LUMA;
 *
 *   idempotencyKey(record: RawLumaEvent): string {
 *     return `luma:event:${record.id}`;
 *   }
 *
 *   protected async fetchPage(cursor?: Cursor): Promise<{ items: RawLumaEvent[]; next?: Cursor }> {
 *     // call lu.ma
 *   }
 *
 *   protected async persistRaw(record: RawLumaEvent): Promise<{ rawId: UUID }> {
 *     // insert into raw_luma_event, returning ON CONFLICT DO NOTHING
 *   }
 *
 *   protected async normalizeRaw(rawId: UUID): Promise<NormalizedRecord[]> {
 *     // map the raw payload onto Event + Person + PersonEventEdge
 *   }
 * }
 * ```
 */
import {
  err,
  fromUnknown,
  IngestionError,
  isAtlasError,
  logger,
  NormalizationError,
  ok,
  type AtlasError,
  type Cursor,
  type Logger,
  type NormalizedRecord,
  type RateLimitConfig,
  type Result,
  type SourceAdapter,
  type UUID,
} from '@atlas/core';
import { RateLimiter } from './rate-limiter.js';
import { withRetry, type RetryOptions } from './retry.js';

export abstract class BaseSourceAdapter<TRawRecord> implements SourceAdapter<TRawRecord> {
  abstract readonly sourceName: string;
  abstract readonly rateLimit: RateLimitConfig;

  protected readonly log: Logger;
  protected readonly limiter: RateLimiter;
  protected readonly retryOptions: RetryOptions;

  constructor(retryOptions: RetryOptions = {}) {
    // Defer limiter construction until subclass field initializers have run —
    // rateLimit is declared in the subclass and may not be assigned yet here.
    // We initialize lazily on first use; for type-safety we set a placeholder.
    this.log = logger.child({ adapter: this.constructor.name });
    this.retryOptions = retryOptions;
    // `this.rateLimit` is set by the subclass field initializer which runs
    // before any method call on the instance. Safe to construct here in
    // subclass `super()` epoch only if subclass initialized rateLimit first;
    // we therefore lazy-init in `getLimiter()`.
    this.limiter = undefined as unknown as RateLimiter;
  }

  abstract idempotencyKey(record: TRawRecord): string;

  /**
   * Source-specific paginated pull. The base class wraps this with the rate
   * limiter and yields items one at a time. Subclasses should not call the
   * rate limiter themselves.
   */
  protected abstract fetchPage(
    cursor: Cursor | undefined,
  ): Promise<{ items: TRawRecord[]; next?: Cursor }>;

  /** Source-specific persistence into the `raw_<source>_*` table. */
  protected abstract persistRaw(record: TRawRecord): Promise<{ rawId: UUID }>;

  /** Source-specific normalization. Reads a stored raw record by id. */
  protected abstract normalizeRaw(rawId: UUID): Promise<NormalizedRecord[]>;

  /**
   * Public `fetch` — rate-limits and surfaces records as an AsyncIterable.
   * Honors `Cursor` for incremental pulls. Errors propagate via throwing
   * because AsyncIterable does not have a natural Result envelope; callers
   * inside Inngest steps catch + log via `tryAsync` at the boundary.
   */
  async *fetch(cursor?: Cursor): AsyncIterable<TRawRecord> {
    const limiter = this.getLimiter();
    let nextCursor = cursor;
    let safety = 0;
    while (safety < 10_000) {
      safety += 1;
      await limiter.acquire();
      const page = await withRetry(
        () => this.fetchPage(nextCursor),
        { fallbackCode: 'INGESTION_FAILED', ...this.retryOptions },
      );
      for (const item of page.items) yield item;
      if (!page.next || page.items.length === 0) return;
      nextCursor = page.next;
    }
    throw new IngestionError(
      `${this.sourceName}: fetch pagination exceeded safety bound`,
      'INGESTION_FAILED',
      { sourceName: this.sourceName, safety },
    );
  }

  /**
   * Public `storeRaw` — idempotent insert + retry. Returns Result so callers
   * can branch without try/catch.
   */
  async storeRaw(record: TRawRecord): Promise<{ rawId: UUID }> {
    const key = this.idempotencyKey(record);
    this.log.debug({ idempotency_key: key }, 'storing raw record');
    try {
      return await withRetry(
        () => this.persistRaw(record),
        { fallbackCode: 'INGESTION_FAILED', ...this.retryOptions },
      );
    } catch (cause) {
      const e = isAtlasError(cause)
        ? cause
        : new IngestionError(
            `${this.sourceName}: failed to store raw record`,
            'INGESTION_FAILED',
            { idempotency_key: key },
            cause,
          );
      this.log.error({ err: e }, 'storeRaw failed');
      throw e;
    }
  }

  /**
   * Public `normalize` — wraps subclass implementation with retry and logging.
   * Returns the normalized records, or throws an `AtlasError`.
   */
  async normalize(rawId: UUID): Promise<NormalizedRecord[]> {
    this.log.debug({ raw_id: rawId }, 'normalizing raw record');
    try {
      return await withRetry(
        () => this.normalizeRaw(rawId),
        { fallbackCode: 'NORMALIZATION_FAILED', ...this.retryOptions },
      );
    } catch (cause) {
      const e = isAtlasError(cause)
        ? cause
        : new NormalizationError(
            `${this.sourceName}: failed to normalize raw record`,
            'NORMALIZATION_FAILED',
            { raw_id: rawId },
            cause,
          );
      this.log.error({ err: e, raw_id: rawId }, 'normalize failed');
      throw e;
    }
  }

  /**
   * Convenience wrapper: ingest one record end-to-end (store + normalize),
   * returning a Result so callers can branch cleanly. Used by simpler
   * adapters that don't want to manage two steps.
   */
  async ingestOne(
    record: TRawRecord,
  ): Promise<Result<{ rawId: UUID; normalized: NormalizedRecord[] }, AtlasError>> {
    try {
      const stored = await this.storeRaw(record);
      const normalized = await this.normalize(stored.rawId);
      return ok({ rawId: stored.rawId, normalized });
    } catch (cause) {
      return err(fromUnknown(cause, 'INGESTION_FAILED', { sourceName: this.sourceName }));
    }
  }

  private getLimiter(): RateLimiter {
    // Lazy-init: rateLimit is a subclass field assigned after super().
    // Cast away the readonly-undefined placeholder set in the constructor.
    const self = this as unknown as { limiter: RateLimiter };
    if (!self.limiter) self.limiter = new RateLimiter(this.rateLimit);
    return self.limiter;
  }
}
