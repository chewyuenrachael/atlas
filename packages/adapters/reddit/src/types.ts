/**
 * Reddit adapter local types.
 *
 * `RawRedditItem` is the durable on-disk shape that will be stored in
 * `raw_reddit_item.raw_payload` once the corresponding table lands in
 * Phase 2. It is the lossless capture of one Reddit post or comment as
 * observed at fetch time. Anything derived (Person records, Communication
 * records, cursor relevance scoring) is computed downstream — see
 * `normalizer.ts`.
 *
 * Reddit exposes its data as JSON via the public `.json` endpoints — no
 * OAuth is required for read-only access to public listings (SPEC.md
 * §5.2.5). We therefore type only the subset of fields we use; the full
 * `t3` (post) and `t1` (comment) envelopes are preserved on
 * `RawRedditItem.envelope` for forensic replay.
 *
 * SPEC ref: SPEC.md §5.2.5 (Reddit source contract), §3.5 (raw envelope
 * conventions).
 */

/** The Reddit "thing kinds" we ingest. */
export type RedditThingKind = 't1' | 't3';

/**
 * A single Reddit post (`t3`) as exposed on the public search/listing
 * endpoints. Field names match Reddit's JSON wire format (snake_case).
 *
 * Only fields the adapter actually reads are typed; the full envelope is
 * preserved on `RawRedditItem.envelope`.
 */
export interface RedditPostData {
  /** Reddit "thing id" without the `t3_` prefix, e.g. `abc123`. */
  id: string;
  /** Display name of the subreddit, e.g. `cursor`. */
  subreddit: string;
  /** Subreddit prefixed display name, e.g. `r/cursor`. */
  subreddit_name_prefixed?: string;
  /** Post title. */
  title: string;
  /** Markdown body. Empty string for link posts. May be `[deleted]` or `[removed]`. */
  selftext?: string;
  /** Author username. May be `[deleted]` for deleted authors. */
  author: string;
  /**
   * Reddit's stable per-author opaque id. Stays present even when the
   * username flips to `[deleted]` post-delete on some legacy posts.
   * Absent for very old content.
   */
  author_fullname?: string;
  /** Unix seconds when the post was created. */
  created_utc: number;
  /** Net score (ups - downs). */
  score: number;
  /** Number of comments at fetch time. */
  num_comments: number;
  /** Reddit permalink, relative path: `/r/<sub>/comments/<id>/<slug>/`. */
  permalink: string;
  /** External URL for link posts. Equal to the permalink for self posts. */
  url?: string;
  /** True when the post was removed by mods/admins. */
  removed_by_category?: string | null;
  /** True when the post was authored by a verified Reddit employee/sponsor. */
  is_self?: boolean;
  /** Optional flair text. */
  link_flair_text?: string | null;
  /** Whether posts marks NSFW / over_18. */
  over_18?: boolean;
}

/**
 * A single Reddit comment (`t1`) as returned by the comments endpoint.
 * Mirrors the wire-format field names.
 */
export interface RedditCommentData {
  id: string;
  parent_id: string;
  link_id: string;
  subreddit: string;
  author: string;
  author_fullname?: string;
  body: string;
  created_utc: number;
  score: number;
  permalink: string;
  is_submitter?: boolean;
  /**
   * Reddit may set this to `true` for collapsed/deleted/removed comments.
   * When `body === '[deleted]'` or `body === '[removed]'` we still capture
   * the envelope so the normalizer can emit a redacted Communication record
   * for thread-shape reconstruction.
   */
  collapsed?: boolean;
  removed?: boolean;
}

/**
 * A normalized "envelope" combining the thing-kind tag and the parsed data
 * payload. The wire format wraps everything as `{kind, data}` — we keep that
 * shape so callers can switch on `kind` without re-checking field presence.
 */
export type RedditEnvelope =
  | { kind: 't3'; data: RedditPostData }
  | { kind: 't1'; data: RedditCommentData };

/**
 * Cursor-relevance signal computed at ingestion time. We compute it once
 * and persist it on the raw envelope so the normalizer (and downstream
 * filters) don't have to re-tokenize the body on every read.
 *
 * Scoring lives in `relevance.ts` and is deterministic.
 */
export interface CursorRelevance {
  /** Bounded relevance score in [0, 1]. */
  score: number;
  /**
   * True when the body contains a literal `cursor` token (case-insensitive,
   * word-boundary). Posts/comments without this are dropped before
   * persistence (see `adapter.fetchPage`).
   */
  matchedCursor: boolean;
  /**
   * The co-occurring boost terms that fired, e.g. `['ide', 'ai']`. Useful
   * for dashboards and for debugging false positives like cursor-the-DB
   * driver chatter.
   */
  boostTerms: string[];
  /** Token count of the full text (title+body or comment body). */
  tokenCount: number;
}

/**
 * The raw record persisted into `raw_reddit_item.raw_payload`. This is the
 * source-of-truth snapshot — every downstream entity is reproducible from it.
 *
 * Matches the raw envelope pattern in SPEC.md §3.5.
 */
export interface RawRedditItem {
  /**
   * The Reddit fullname (`t1_<id>` or `t3_<id>`). UNIQUE in
   * `raw_reddit_item.thing_id` — guarantees idempotent re-ingest.
   */
  thingId: string;
  /** The wire kind so consumers can switch without re-deriving. */
  kind: RedditThingKind;
  /**
   * For comments, the post fullname (`t3_<id>`) the comment belongs to.
   * For posts this is identical to `thingId`. Used to group comments
   * under their parent communication record.
   */
  postFullname: string;
  /** Subreddit display name (no `r/` prefix), e.g. `cursor`. */
  subreddit: string;
  /** Captured envelope. Always includes both kind and the full data. */
  envelope: RedditEnvelope;
  /** Cursor-relevance signal computed at fetch time. */
  cursorRelevance: CursorRelevance;
  /** ISO-8601 wall-clock at which the fetch completed. */
  fetchedAt: string;
  /**
   * Source URL the JSON was fetched from. Usually
   * `https://www.reddit.com/r/<sub>/search.json?q=cursor` for posts and
   * `https://www.reddit.com/comments/<post_id>.json` for comments. Kept
   * explicit so we can audit alternative entry points later.
   */
  sourceUrl: string;
  /**
   * SHA-256 hex digest over the canonical envelope. Used by downstream
   * deduplication to skip when a re-fetch produced an identical payload.
   */
  payloadHash: string;
}
