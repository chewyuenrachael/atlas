/**
 * Reddit JSON client — public unauthenticated endpoints.
 *
 * Two layers, separated so unit tests can exercise parsing against
 * fixtures without ever opening a socket:
 *
 *   1. **Page fetchers** (`searchSubreddit`, `fetchPostWithComments`) make
 *      HTTPS calls to `https://www.reddit.com/...json` and return parsed
 *      JSON. Both honor an injected `httpFetcher` so tests can replay a
 *      stored response and the CLI can hit the live API.
 *   2. **Pure parsers** (`parseSearchListing`, `parsePostThread`) take a
 *      raw JSON object and return the structured posts/comments. They
 *      throw `IngestionError` only on completely malformed payloads —
 *      missing optional fields are tolerated.
 *
 * Reddit's public `.json` endpoint requires only a polite `User-Agent`
 * string; no OAuth is needed for read-only access to public listings
 * (SPEC.md §5.2.5). We respect their 60 req/min rate limit through the
 * adapter's base-class rate limiter.
 *
 * Failure modes:
 *   - HTTP 429 or 5xx: the client throws `IngestionError` and the base
 *     class's retry wrapper takes over.
 *   - Malformed JSON: thrown as `IngestionError` with the URL in metadata.
 *   - Empty listings: parsers return `[]` cleanly.
 *
 * SPEC.md §5.2.5 — Reddit adapter source contract.
 */
import { IngestionError, logger } from '@atlas/core';
import type { RedditCommentData, RedditPostData } from './types.js';

const log = logger.child({ adapter: 'reddit', component: 'client' });

const DEFAULT_BASE_URL = 'https://www.reddit.com';
const DEFAULT_USER_AGENT = 'atlas-community-bot/0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_COMMENT_LIMIT = 50;

/** Reddit's bare listing envelope. */
interface RedditListingResponse {
  kind: 'Listing';
  data: {
    after: string | null;
    children: Array<{ kind: 't1' | 't3'; data: unknown }>;
  };
}

/** A post-with-comments JSON document is `[postListing, commentListing]`. */
type RedditPostThreadResponse = [RedditListingResponse, RedditListingResponse];

export interface ClientOptions {
  /** Override base URL. Defaults to `REDDIT_BASE_URL` env or `https://www.reddit.com`. */
  baseUrl?: string;
  /**
   * User-Agent header sent on every request. Defaults to
   * `atlas-community-bot/0.1`. Reddit rejects requests without a UA and
   * rate-limits anonymous "browser-like" UAs aggressively.
   */
  userAgent?: string;
  /** Per-request timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Injection point for tests. If supplied, the client does not use
   * global `fetch` and instead calls `httpFetcher(url, init)` for every
   * request. Must return a `Response`-like object with `.json()` and
   * `.status`.
   */
  httpFetcher?: (url: string, init?: { headers?: Record<string, string> }) => Promise<{
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

interface Resolved {
  baseUrl: string;
  userAgent: string;
  timeoutMs: number;
  httpFetcher?: ClientOptions['httpFetcher'];
}

function resolve(opts: ClientOptions = {}): Resolved {
  const baseUrl = (opts.baseUrl ?? process.env['REDDIT_BASE_URL'] ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const resolved: Resolved = {
    baseUrl,
    userAgent: opts.userAgent ?? process.env['REDDIT_USER_AGENT'] ?? DEFAULT_USER_AGENT,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (opts.httpFetcher) resolved.httpFetcher = opts.httpFetcher;
  return resolved;
}

// ---------------------------------------------------------------------------
// Public fetch helpers
// ---------------------------------------------------------------------------

export interface SearchOptions extends ClientOptions {
  /** Query string. Defaults to `cursor`. */
  query?: string;
  /** Max posts per request. Reddit caps at 100. */
  limit?: number;
  /** `after` pagination cursor (Reddit fullname). */
  after?: string;
  /** Restrict results to the given subreddit (recommended). */
  restrictToSubreddit?: boolean;
  /** Sort: relevance | hot | top | new | comments. */
  sort?: 'relevance' | 'hot' | 'top' | 'new' | 'comments';
  /** Time window for the search. */
  timeFilter?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
}

/**
 * Search a subreddit's public listing JSON for posts matching the query.
 *
 * @example
 * ```ts
 * const { posts, after } = await searchSubreddit('cursor', { limit: 25 });
 * console.log(`${posts.length} posts; next cursor: ${after}`);
 * ```
 */
export async function searchSubreddit(
  subreddit: string,
  opts: SearchOptions = {},
): Promise<{ posts: RedditPostData[]; after: string | null }> {
  const resolved = resolve(opts);
  const url = buildSearchUrl(resolved.baseUrl, subreddit, opts);
  const json = await fetchJson(url, resolved);
  const listing = json as RedditListingResponse;
  return parseSearchListing(listing);
}

/**
 * Fetch the post envelope plus the top `limit` comments for one post.
 *
 * The Reddit "comments" endpoint returns a two-element array:
 * `[postListing, commentListing]`. We parse both and return them together.
 *
 * @example
 * ```ts
 * const { post, comments } = await fetchPostWithComments('1abc23', 'cursor');
 * console.log(post.title, comments.length);
 * ```
 */
export async function fetchPostWithComments(
  postId: string,
  subreddit: string,
  opts: ClientOptions & { commentLimit?: number; sort?: 'top' | 'new' | 'confidence' } = {},
): Promise<{ post: RedditPostData; comments: RedditCommentData[] }> {
  const resolved = resolve(opts);
  const limit = opts.commentLimit ?? DEFAULT_COMMENT_LIMIT;
  const sort = opts.sort ?? 'top';
  const url = `${resolved.baseUrl}/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(
    postId,
  )}.json?limit=${limit}&sort=${sort}&raw_json=1`;
  const json = await fetchJson(url, resolved);
  return parsePostThread(json);
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/**
 * Parse a Reddit search listing into post records.
 *
 * Tolerant: drops children whose `kind` isn't `t3`, skips items missing
 * the required `id` field, returns whatever fields are present.
 */
export function parseSearchListing(listing: RedditListingResponse): {
  posts: RedditPostData[];
  after: string | null;
} {
  const out: RedditPostData[] = [];
  if (!listing || listing.kind !== 'Listing' || !listing.data) {
    return { posts: [], after: null };
  }
  for (const child of listing.data.children ?? []) {
    if (child.kind !== 't3') continue;
    const post = coercePost(child.data);
    if (post) out.push(post);
  }
  return { posts: out, after: listing.data.after ?? null };
}

/**
 * Parse a Reddit comments endpoint response into a post + flat comments list.
 *
 * Comment trees are flattened depth-first; "more" placeholders are skipped.
 * Returns up to whatever Reddit gave us; the caller is responsible for
 * truncating to the configured cap.
 */
export function parsePostThread(value: unknown): {
  post: RedditPostData;
  comments: RedditCommentData[];
} {
  if (!Array.isArray(value) || value.length < 2) {
    throw new IngestionError(
      'reddit: malformed post-thread response (expected [postListing, commentListing])',
      'INGESTION_FAILED',
    );
  }
  const [postListing, commentListing] = value as RedditPostThreadResponse;
  const { posts } = parseSearchListing(postListing);
  const post = posts[0];
  if (!post) {
    throw new IngestionError(
      'reddit: post listing has no t3 child',
      'INGESTION_FAILED',
    );
  }
  const comments: RedditCommentData[] = [];
  collectComments(commentListing, comments);
  return { post, comments };
}

function collectComments(listing: RedditListingResponse, out: RedditCommentData[]): void {
  if (!listing || !listing.data) return;
  for (const child of listing.data.children ?? []) {
    if (child.kind !== 't1') continue;
    const comment = coerceComment(child.data);
    if (!comment) continue;
    out.push(comment);
    // Comments embed a `replies` listing in their data. Recurse for depth.
    const replies = (child.data as { replies?: unknown }).replies;
    if (replies && typeof replies === 'object' && !Array.isArray(replies)) {
      collectComments(replies as RedditListingResponse, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Coercion helpers (lossless on the subset we read; rest is captured raw)
// ---------------------------------------------------------------------------

function coercePost(value: unknown): RedditPostData | null {
  if (!isObject(value)) return null;
  const v = value;
  const id = asString(v['id']);
  const subreddit = asString(v['subreddit']);
  const title = asString(v['title']);
  const author = asString(v['author']);
  const createdUtc = asNumber(v['created_utc']);
  const permalink = asString(v['permalink']);
  if (!id || !subreddit || !title || !author || createdUtc === null || !permalink) {
    return null;
  }
  const post: RedditPostData = {
    id,
    subreddit,
    title,
    author,
    created_utc: createdUtc,
    score: asNumber(v['score']) ?? 0,
    num_comments: asNumber(v['num_comments']) ?? 0,
    permalink,
  };
  const selftext = asString(v['selftext']);
  if (selftext !== null) post.selftext = selftext;
  const authorFullname = asString(v['author_fullname']);
  if (authorFullname) post.author_fullname = authorFullname;
  const subredditPrefixed = asString(v['subreddit_name_prefixed']);
  if (subredditPrefixed) post.subreddit_name_prefixed = subredditPrefixed;
  const url = asString(v['url']);
  if (url) post.url = url;
  const removedBy = v['removed_by_category'];
  if (removedBy === null || typeof removedBy === 'string') {
    post.removed_by_category = removedBy;
  }
  const isSelf = v['is_self'];
  if (typeof isSelf === 'boolean') post.is_self = isSelf;
  const flair = v['link_flair_text'];
  if (flair === null || typeof flair === 'string') post.link_flair_text = flair;
  const over18 = v['over_18'];
  if (typeof over18 === 'boolean') post.over_18 = over18;
  return post;
}

function coerceComment(value: unknown): RedditCommentData | null {
  if (!isObject(value)) return null;
  const v = value;
  const id = asString(v['id']);
  const parentId = asString(v['parent_id']);
  const linkId = asString(v['link_id']);
  const subreddit = asString(v['subreddit']);
  const author = asString(v['author']);
  const body = asString(v['body']);
  const createdUtc = asNumber(v['created_utc']);
  const permalink = asString(v['permalink']);
  if (
    !id ||
    !parentId ||
    !linkId ||
    !subreddit ||
    !author ||
    body === null ||
    createdUtc === null ||
    !permalink
  ) {
    return null;
  }
  const comment: RedditCommentData = {
    id,
    parent_id: parentId,
    link_id: linkId,
    subreddit,
    author,
    body,
    created_utc: createdUtc,
    score: asNumber(v['score']) ?? 0,
    permalink,
  };
  const authorFullname = asString(v['author_fullname']);
  if (authorFullname) comment.author_fullname = authorFullname;
  const isSubmitter = v['is_submitter'];
  if (typeof isSubmitter === 'boolean') comment.is_submitter = isSubmitter;
  const collapsed = v['collapsed'];
  if (typeof collapsed === 'boolean') comment.collapsed = collapsed;
  const removed = v['removed'];
  if (typeof removed === 'boolean') comment.removed = removed;
  return comment;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function buildSearchUrl(baseUrl: string, subreddit: string, opts: SearchOptions): string {
  const sub = encodeURIComponent(subreddit);
  const query = encodeURIComponent(opts.query ?? 'cursor');
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('limit', String(opts.limit ?? DEFAULT_SEARCH_LIMIT));
  if (opts.restrictToSubreddit !== false) params.set('restrict_sr', '1');
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.timeFilter) params.set('t', opts.timeFilter);
  if (opts.after) params.set('after', opts.after);
  params.set('raw_json', '1');
  return `${baseUrl}/r/${sub}/search.json?${params.toString()}`;
}

async function fetchJson(url: string, resolved: Resolved): Promise<unknown> {
  const init = {
    headers: {
      'User-Agent': resolved.userAgent,
      Accept: 'application/json',
    },
  };
  log.debug({ url }, 'fetching reddit json');
  try {
    const response = resolved.httpFetcher
      ? await resolved.httpFetcher(url, init)
      : await fetchWithTimeout(url, init, resolved.timeoutMs);
    if (response.status === 429) {
      throw new IngestionError(
        `reddit: rate limited (HTTP 429) for ${url}`,
        'INGESTION_FAILED',
        { url, status: response.status },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      let body: string | null = null;
      try {
        body = await response.text();
      } catch {
        // ignore body decode failure
      }
      throw new IngestionError(
        `reddit: HTTP ${response.status} for ${url}`,
        'INGESTION_FAILED',
        { url, status: response.status, body: body?.slice(0, 500) ?? null },
      );
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new IngestionError(
        `reddit: malformed JSON for ${url}`,
        'INGESTION_FAILED',
        { url },
        cause,
      );
    }
  } catch (cause) {
    if (cause instanceof IngestionError) throw cause;
    throw new IngestionError(
      `reddit: fetch failed for ${url}`,
      'INGESTION_FAILED',
      { url },
      cause,
    );
  }
}

/**
 * `fetch` wrapper with an `AbortController`-backed timeout. Node 20 ships
 * both `fetch` and `AbortController` as globals; we use the WHATWG signal
 * pattern rather than `Promise.race` so a slow body read also aborts.
 */
async function fetchWithTimeout(
  url: string,
  init: { headers?: Record<string, string> },
  timeoutMs: number,
): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  // Node 20 exposes both globals; cast through a local interface to avoid
  // pulling in DOM types just for the AbortController shape.
  const Ctor = (
    globalThis as unknown as {
      AbortController: new () => { signal: unknown; abort: () => void };
    }
  ).AbortController;
  const controller = new Ctor();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return (await fetch(url, {
      ...init,
      signal: controller.signal as never,
    })) as { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  } finally {
    clearTimeout(timer);
  }
}
