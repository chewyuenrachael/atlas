/**
 * RedditAdapter — source adapter for public Reddit posts and comments.
 *
 * Extends `BaseSourceAdapter<RawRedditItem>` and implements the
 * SourceAdapter contract (SPEC.md §5.1). The base class provides
 * rate-limit enforcement, retry, and structured logging around the
 * abstract hooks below.
 *
 * Persistence boundary: this Phase-2 implementation cannot insert into
 * `raw_reddit_item` directly because the corresponding query helper in
 * `packages/db` has not been written yet. The adapter therefore accepts a
 * `RawRedditStore` via the constructor — an `InMemoryRawRedditStore` is
 * provided for tests and the CLI, and a future Phase-2B PR will swap in
 * a Supabase-backed store once `RedditQueries.insertRawRedditItem` lands.
 * See README "Persistence boundary".
 *
 * What we fetch (SPEC.md §5.2.5):
 *   - For each configured subreddit, the public `r/<sub>/search.json?q=cursor`
 *     listing endpoint. We accept whatever sort Reddit gives us; the API
 *     defaults to relevance which is appropriate for hourly polling.
 *   - For each post that survives the cursor-relevance filter, the
 *     `r/<sub>/comments/<id>.json` thread endpoint (top 50 comments).
 *
 * Filtering policy:
 *   - Every post and every comment is scored via `computeCursorRelevance`.
 *   - Items whose `matchedCursor` flag is false are skipped without
 *     persisting. This keeps the raw table free of noise. Posts surfaced
 *     by Reddit's search but whose body doesn't actually mention `cursor`
 *     at a word boundary do exist (Reddit's full-text search is loose).
 *
 * @example
 * ```ts
 * const adapter = new RedditAdapter();
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
  RATE_LIMIT_REDDIT,
  logger,
  type Cursor,
  type Logger,
  type NormalizedRecord,
  type RateLimitConfig,
  type UUID,
} from '@atlas/core';
import { BaseSourceAdapter, type RetryOptions } from '@atlas/adapters-shared';
import {
  fetchPostWithComments,
  searchSubreddit,
  type ClientOptions,
} from './client.js';
import { normalizeRedditItem } from './normalizer.js';
import { computeCursorRelevance } from './relevance.js';
import type {
  CursorRelevance,
  RawRedditItem,
  RedditCommentData,
  RedditEnvelope,
  RedditPostData,
} from './types.js';

/**
 * Subreddits searched on every poll. SPEC.md §5.2.5 enumerates the
 * starting set; we keep it readonly so workflows can extend it via the
 * adapter constructor rather than mutating the module-level constant.
 */
export const DEFAULT_SUBREDDITS: readonly string[] = [
  'cursor',
  'MachineLearning',
  'LocalLLaMA',
  'programming',
  'webdev',
  'learnprogramming',
];

const DEFAULT_TOP_COMMENTS_PER_POST = 50;
const DEFAULT_POSTS_PER_SUBREDDIT = 25;

// ---------------------------------------------------------------------------
// Raw store abstraction
// ---------------------------------------------------------------------------

/**
 * Storage abstraction over the `raw_reddit_item` table. The default
 * in-memory implementation is wired up for tests and the CLI. Production
 * wiring is deferred to a follow-up PR once
 * `packages/db/queries/reddit.ts` exposes the corresponding helpers.
 */
export interface RawRedditStore {
  /**
   * Insert one raw item. Idempotent: if a row already exists for the
   * same `thingId`, the store must return the existing row's `rawId`
   * and set `existed: true`.
   */
  insert(record: RawRedditItem): Promise<{ rawId: UUID; existed: boolean }>;

  /** Read back a raw item by id. */
  getById(rawId: UUID): Promise<RawRedditItem | null>;

  /** Mark a raw row as normalized so we don't re-emit downstream events. */
  markNormalized(rawId: UUID): Promise<void>;
}

/**
 * Simple in-memory implementation of `RawRedditStore`. Keyed on
 * `thingId` (the unique constraint mirrored from SPEC.md §3.5).
 * Re-inserting the same item returns the same `rawId` without
 * overwriting the stored payload.
 */
export class InMemoryRawRedditStore implements RawRedditStore {
  private readonly byThingId = new Map<string, { rawId: UUID; record: RawRedditItem }>();
  private readonly byRawId = new Map<UUID, { record: RawRedditItem; normalizedAt: string | null }>();

  async insert(record: RawRedditItem): Promise<{ rawId: UUID; existed: boolean }> {
    const existing = this.byThingId.get(record.thingId);
    if (existing) {
      return { rawId: existing.rawId, existed: true };
    }
    const rawId: UUID = randomUUID();
    this.byThingId.set(record.thingId, { rawId, record });
    this.byRawId.set(rawId, { record, normalizedAt: null });
    return { rawId, existed: false };
  }

  async getById(rawId: UUID): Promise<RawRedditItem | null> {
    return this.byRawId.get(rawId)?.record ?? null;
  }

  async markNormalized(rawId: UUID): Promise<void> {
    const entry = this.byRawId.get(rawId);
    if (entry) entry.normalizedAt = new Date().toISOString();
  }

  /** Test/CLI convenience: snapshot of all stored items. */
  list(): RawRedditItem[] {
    return [...this.byThingId.values()].map((v) => v.record);
  }

  size(): number {
    return this.byThingId.size;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Injection point for tests: pluggable post-search and thread-fetch fns. */
export interface RedditAdapterDeps {
  searchSubreddit?: typeof searchSubreddit;
  fetchPostWithComments?: typeof fetchPostWithComments;
}

export interface RedditAdapterOptions {
  /** Override the raw store. Defaults to a fresh `InMemoryRawRedditStore`. */
  store?: RawRedditStore;
  /** Subreddits to poll. Defaults to {@link DEFAULT_SUBREDDITS}. */
  subreddits?: readonly string[];
  /** Max posts to pull per subreddit per poll. Defaults to 25. */
  postsPerSubreddit?: number;
  /** Cap on comments captured per post. Defaults to 50 (SPEC.md §5.2.5). */
  topCommentsPerPost?: number;
  /** HTTP client configuration (base URL, UA, timeouts). */
  clientOptions?: ClientOptions;
  /** Override the retry policy for the base class. */
  retryOptions?: RetryOptions;
  /** Inject a clock for deterministic tests. */
  now?: () => Date;
  /** Test seam for the network layer. */
  deps?: RedditAdapterDeps;
  /**
   * Items below this `cursor_relevance_score` are dropped before
   * persistence. Defaults to 0 (only the "must contain cursor" filter
   * applies). Set to e.g. 0.5 for stricter downstream pipelines.
   */
  minCursorRelevance?: number;
}

export class RedditAdapter extends BaseSourceAdapter<RawRedditItem> {
  readonly sourceName = 'reddit';
  readonly rateLimit: RateLimitConfig = RATE_LIMIT_REDDIT;

  protected readonly store: RawRedditStore;
  protected readonly subreddits: readonly string[];
  protected readonly postsPerSubreddit: number;
  protected readonly topCommentsPerPost: number;
  protected readonly clientOptions: ClientOptions;
  protected readonly searchSubreddit: typeof searchSubreddit;
  protected readonly fetchPostWithComments: typeof fetchPostWithComments;
  protected readonly clock: () => Date;
  protected readonly adapterLog: Logger;
  protected readonly minCursorRelevance: number;

  constructor(options: RedditAdapterOptions = {}) {
    super(options.retryOptions ?? { maxAttempts: 3 });
    this.store = options.store ?? new InMemoryRawRedditStore();
    this.subreddits = options.subreddits ?? DEFAULT_SUBREDDITS;
    this.postsPerSubreddit = options.postsPerSubreddit ?? DEFAULT_POSTS_PER_SUBREDDIT;
    this.topCommentsPerPost = options.topCommentsPerPost ?? DEFAULT_TOP_COMMENTS_PER_POST;
    this.clientOptions = options.clientOptions ?? {};
    this.searchSubreddit = options.deps?.searchSubreddit ?? searchSubreddit;
    this.fetchPostWithComments = options.deps?.fetchPostWithComments ?? fetchPostWithComments;
    this.clock = options.now ?? (() => new Date());
    this.adapterLog = logger.child({ adapter: 'reddit' });
    this.minCursorRelevance = options.minCursorRelevance ?? 0;
  }

  override idempotencyKey(record: RawRedditItem): string {
    return `reddit:thing:${record.thingId}`;
  }

  /**
   * Discover posts across every configured subreddit, then fetch top
   * comments for the survivors. Yields every (post + comment) that
   * passes the cursor-relevance filter.
   *
   * The fetch is single-page per subreddit: we discover up to
   * `postsPerSubreddit` posts per poll. Pagination via Reddit's `after`
   * cursor is supported by the client but not used here — hourly polling
   * with a 25-post window comfortably covers Cursor-related volume per
   * SPEC.md §5.2.5.
   */
  protected override async fetchPage(
    _cursor: Cursor | undefined,
  ): Promise<{ items: RawRedditItem[]; next?: Cursor }> {
    const items: RawRedditItem[] = [];
    for (const subreddit of this.subreddits) {
      try {
        const { posts } = await this.searchSubreddit(subreddit, {
          ...this.clientOptions,
          query: 'cursor',
          limit: this.postsPerSubreddit,
          restrictToSubreddit: true,
        });
        this.adapterLog.info(
          { subreddit, posts_returned: posts.length },
          'reddit search returned posts',
        );
        for (const post of posts) {
          const postRaw = this.buildRawFromPost(post, subreddit);
          if (!this.passesRelevance(postRaw.cursorRelevance)) {
            this.adapterLog.debug(
              {
                subreddit,
                thing_id: postRaw.thingId,
                score: postRaw.cursorRelevance.score,
              },
              'dropping post below cursor-relevance threshold',
            );
            continue;
          }
          items.push(postRaw);
          // Top comments per post.
          try {
            const { comments } = await this.fetchPostWithComments(post.id, subreddit, {
              ...this.clientOptions,
              commentLimit: this.topCommentsPerPost,
              sort: 'top',
            });
            const capped = comments.slice(0, this.topCommentsPerPost);
            for (const comment of capped) {
              const commentRaw = this.buildRawFromComment(comment, subreddit, post.id);
              if (!this.passesRelevance(commentRaw.cursorRelevance)) continue;
              items.push(commentRaw);
            }
          } catch (cause) {
            this.adapterLog.warn(
              { err: cause, subreddit, post_id: post.id },
              'failed to fetch comments for post; skipping comments',
            );
          }
        }
      } catch (cause) {
        // One subreddit failing should never poison the entire poll —
        // log, skip, and move on. SPEC.md §5.2.5 expects per-source
        // resilience and per-subreddit failures are first-class here.
        this.adapterLog.warn(
          { err: cause, subreddit },
          'subreddit search failed; skipping subreddit',
        );
      }
    }
    return { items };
  }

  protected override async persistRaw(record: RawRedditItem): Promise<{ rawId: UUID }> {
    try {
      const { rawId } = await this.store.insert(record);
      return { rawId };
    } catch (cause) {
      throw new IngestionError(
        'failed to persist raw reddit item',
        'INGESTION_FAILED',
        { thing_id: record.thingId },
        cause,
      );
    }
  }

  protected override async normalizeRaw(rawId: UUID): Promise<NormalizedRecord[]> {
    const raw = await this.store.getById(rawId);
    if (!raw) {
      throw new NormalizationError('raw reddit item not found', 'NORMALIZATION_FAILED', {
        raw_id: rawId,
      });
    }
    const records = normalizeRedditItem(raw);
    if (records.length > 0) {
      await this.store.markNormalized(rawId).catch((cause: unknown) => {
        this.adapterLog.warn({ err: cause, raw_id: rawId }, 'markNormalized failed');
      });
    }
    return records;
  }

  // -------------------------------------------------------------------------
  // Raw envelope construction
  // -------------------------------------------------------------------------

  protected buildRawFromPost(post: RedditPostData, subreddit: string): RawRedditItem {
    const thingId = `t3_${post.id}`;
    const envelope: RedditEnvelope = { kind: 't3', data: post };
    const relevanceText = `${post.title}\n${post.selftext ?? ''}`;
    return this.buildRawCommon(
      thingId,
      thingId,
      subreddit,
      envelope,
      relevanceText,
      `https://www.reddit.com/r/${subreddit}/search.json?q=cursor`,
    );
  }

  protected buildRawFromComment(
    comment: RedditCommentData,
    subreddit: string,
    postId: string,
  ): RawRedditItem {
    const thingId = `t1_${comment.id}`;
    const postFullname = `t3_${postId}`;
    const envelope: RedditEnvelope = { kind: 't1', data: comment };
    return this.buildRawCommon(
      thingId,
      postFullname,
      subreddit,
      envelope,
      comment.body,
      `https://www.reddit.com/r/${subreddit}/comments/${postId}.json`,
    );
  }

  protected buildRawCommon(
    thingId: string,
    postFullname: string,
    subreddit: string,
    envelope: RedditEnvelope,
    relevanceText: string,
    sourceUrl: string,
  ): RawRedditItem {
    const fetchedAt = this.clock().toISOString();
    const cursorRelevance = computeCursorRelevance(relevanceText, subreddit);
    const payloadHash = computePayloadHash(envelope);
    return {
      thingId,
      kind: envelope.kind,
      postFullname,
      subreddit,
      envelope,
      cursorRelevance,
      fetchedAt,
      sourceUrl,
      payloadHash,
    };
  }

  /**
   * A record passes the relevance filter when (a) "cursor" appears at a
   * word boundary in its body, AND (b) the computed score is at or above
   * the configured `minCursorRelevance` threshold.
   */
  protected passesRelevance(relevance: CursorRelevance): boolean {
    if (!relevance.matchedCursor) return false;
    return relevance.score >= this.minCursorRelevance;
  }
}

/** SHA-256 hex digest over a stable JSON serialization of the envelope. */
function computePayloadHash(envelope: RedditEnvelope): string {
  return createHash('sha256').update(canonicalize(envelope)).digest('hex');
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
