/**
 * Hacker News adapter local types.
 *
 * `RawHackerNewsItem` is the durable on-disk shape stored in
 * `raw_hackernews_item.raw_payload`. It is the lossless capture of one HN
 * item (story or comment) as observed at fetch time. Anything derived
 * (Communication, Person) is computed downstream by `normalizer.ts`.
 *
 * Source: Algolia Hacker News Search API. The API exposes two endpoints
 * relevant here:
 *
 *   - `/api/v1/search?query=…`            (relevance-sorted)
 *   - `/api/v1/search_by_date?query=…`    (newest first; what we use)
 *
 * The adapter pulls stories AND comments mentioning Cursor (SPEC.md §5.2.6).
 *
 * See SPEC.md §3.5 for the raw envelope convention.
 */

/**
 * One Algolia HN hit. Surface only the fields we care about, but we persist
 * the entire upstream blob in `raw_payload` so re-normalization can recover
 * details added in future schema versions.
 *
 * Algolia returns a few additional fields we do NOT depend on:
 *   - `_highlightResult` — only used by Algolia's search UI; safe to ignore.
 *   - `children` — array of comment IDs descending from a story; only on
 *     story hits. We don't need it here.
 *   - `updated_at` — Algolia bookkeeping timestamp.
 */
export interface HackerNewsAlgoliaHit {
  /** HN item id as a string (matches `news.ycombinator.com/item?id=<objectID>`). */
  objectID: string;
  /** ISO-8601 created timestamp, UTC. */
  created_at: string | null;
  /** Unix epoch (seconds) for `created_at`. Used for incremental cursors. */
  created_at_i: number | null;
  /** Story title. Stories only. */
  title: string | null;
  /** Story URL. Stories only. Null for Ask HN / Show HN posts without a link. */
  url: string | null;
  /** Author handle. `null` when the item is deleted or dead. */
  author: string | null;
  /** Points (upvotes). Stories only. */
  points: number | null;
  /** Story body. Present on Ask HN / Show HN; null otherwise. */
  story_text: string | null;
  /** Comment body (HTML). Comments only. */
  comment_text: string | null;
  /** Comment count. Stories only. */
  num_comments: number | null;
  /** Parent story id. Comments only. */
  story_id: number | null;
  /** Parent story title. Comments only — denormalized by Algolia for convenience. */
  story_title: string | null;
  /** Parent story URL. Comments only. */
  story_url: string | null;
  /** Direct parent id (might be a comment or a story). Comments only. */
  parent_id: number | null;
  /**
   * Algolia tag bag. Each hit has at least one of `story|comment|poll`, plus
   * `author_<handle>` and `story_<id>`. The first element identifies the
   * primary item type and is what we key off of.
   */
  _tags: string[];
}

/**
 * One page of Algolia results. We only consume what we need; extra Algolia
 * metadata (`processingTimeMS`, etc) is allowed but ignored.
 */
export interface HackerNewsAlgoliaResponse {
  hits: HackerNewsAlgoliaHit[];
  /** Zero-indexed page number echoed back by Algolia. */
  page: number;
  /** Total pages available for this query. We stop when `page >= nbPages - 1`. */
  nbPages: number;
  /** Total hits for this query, across all pages. */
  nbHits: number;
  /** Page size Algolia served (usually matches what we requested). */
  hitsPerPage: number;
}

/** Resolved item kind, derived from `_tags`. */
export type HackerNewsItemType = 'story' | 'comment' | 'poll' | 'unknown';

/**
 * The raw record persisted into `raw_hackernews_item.raw_payload`. This is
 * the source-of-truth snapshot — every downstream entity is reproducible
 * from it.
 *
 * Matches the raw envelope pattern in SPEC.md §3.5 (`raw_hackernews_item`).
 */
export interface RawHackerNewsItem {
  /** HN item id (Algolia `objectID`). UNIQUE in `raw_hackernews_item.hn_item_id`. */
  hnItemId: string;
  /** Item kind, classified once at ingest time so normalization is purely positional. */
  itemType: HackerNewsItemType;
  /** Verbatim Algolia hit. Re-normalizable by future code without re-fetching. */
  hit: HackerNewsAlgoliaHit;
  /** ISO-8601 wall-clock at which the fetch completed. */
  fetchedAt: string;
  /** Canonical HN URL for the item (`https://news.ycombinator.com/item?id=<id>`). */
  sourceUrl: string;
  /**
   * SHA-256 hex digest of the canonical hit payload. Used by the normalization
   * layer to skip work when a re-fetch produced no change.
   */
  payloadHash: string;
}
