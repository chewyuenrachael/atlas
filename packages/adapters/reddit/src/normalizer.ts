/**
 * Reddit normalizer — converts `RawRedditItem` into `NormalizedRecord[]`.
 *
 * Output contract (SPEC.md §5.2.5):
 *   - One Communication `NormalizedRecord` per post or comment.
 *   - Zero or one Person `NormalizedRecord` for the author — emitted only
 *     when the author is identifiable (not `[deleted]`). Reddit usernames
 *     are notoriously hard to resolve; we still emit a record so the
 *     identity resolver has the chance to soft-link via cross-platform
 *     handles (GitHub, Twitter) if they appear in the post body.
 *
 * Edges (person_communication, person_subreddit_membership) are NOT
 * emitted here — the identity resolution service reads NormalizedRecord[]
 * and synthesizes edges based on resolution decisions. This mirrors the
 * pattern established by the Luma normalizer.
 *
 * Normalization is deterministic: the same RawRedditItem always produces
 * the same array of NormalizedRecord, byte-for-byte. Tests rely on this.
 */
import { logger, type Metadata, type NormalizedRecord } from '@atlas/core';
import type {
  RawRedditItem,
  RedditCommentData,
  RedditEnvelope,
  RedditPostData,
} from './types.js';

const log = logger.child({ adapter: 'reddit', component: 'normalizer' });

const SOURCE_PLATFORM_REDDIT = 'reddit';

/** Reddit's two sentinel values for missing authors / content. */
const DELETED_TOKENS = new Set(['[deleted]', '[removed]', '']);

/**
 * Convert one raw Reddit item into the canonical normalized records.
 *
 * @param raw - The raw item as stored in `raw_reddit_item.raw_payload`.
 * @returns One Communication followed by zero or one Person record.
 *   Returns an empty array if the raw item is structurally invalid (no
 *   `thingId`, missing envelope). Posts/comments with `[deleted]`
 *   authors still emit a Communication for thread reconstruction; the
 *   Person record is suppressed because there is nothing to resolve.
 *
 * @example
 * ```ts
 * const records = normalizeRedditItem(raw);
 * const communications = records.filter((r) => r.recordType === 'communication');
 * const persons = records.filter((r) => r.recordType === 'person');
 * ```
 */
export function normalizeRedditItem(raw: RawRedditItem): NormalizedRecord[] {
  if (!raw.thingId || !raw.envelope) {
    log.warn({ fetched_at: raw.fetchedAt }, 'dropping reddit raw without thing_id or envelope');
    return [];
  }

  const observedAt = raw.fetchedAt;
  const out: NormalizedRecord[] = [];
  out.push(buildCommunicationRecord(raw, observedAt));

  const author = pickAuthor(raw.envelope);
  if (author.identifiable) {
    out.push(buildPersonRecord(raw, author, observedAt));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Communication record
// ---------------------------------------------------------------------------

function buildCommunicationRecord(raw: RawRedditItem, observedAt: string): NormalizedRecord {
  const { kind, data } = raw.envelope;
  const author = pickAuthor(raw.envelope);
  const isPost = kind === 't3';
  const body = isPost ? selftextOrEmpty(data as RedditPostData) : (data as RedditCommentData).body;
  const title = isPost ? (data as RedditPostData).title : null;
  const permalink = buildPermalinkUrl((data as RedditPostData | RedditCommentData).permalink);

  const payload: Metadata = {
    thing_id: raw.thingId,
    kind,
    subreddit: raw.subreddit,
    post_fullname: raw.postFullname,
    title,
    body: redactIfDeleted(body),
    author_username: author.username,
    author_fullname: author.fullname,
    author_deleted: !author.identifiable,
    score: data.score,
    created_utc: data.created_utc,
    created_at: new Date(data.created_utc * 1000).toISOString(),
    permalink,
    cursor_relevance_score: raw.cursorRelevance.score,
    cursor_relevance_matched: raw.cursorRelevance.matchedCursor,
    cursor_relevance_boost_terms: raw.cursorRelevance.boostTerms,
    payload_hash: raw.payloadHash,
    source_url: raw.sourceUrl,
  };

  if (isPost) {
    const post = data as RedditPostData;
    payload['num_comments'] = post.num_comments;
    if (post.link_flair_text !== undefined) payload['link_flair_text'] = post.link_flair_text;
    if (post.removed_by_category !== undefined) {
      payload['removed_by_category'] = post.removed_by_category;
    }
    if (post.is_self !== undefined) payload['is_self'] = post.is_self;
    if (post.over_18 !== undefined) payload['over_18'] = post.over_18;
    if (post.url) payload['external_url'] = post.url;
  } else {
    const comment = data as RedditCommentData;
    payload['parent_id'] = comment.parent_id;
    payload['link_id'] = comment.link_id;
    if (comment.is_submitter !== undefined) payload['is_submitter'] = comment.is_submitter;
    if (comment.collapsed !== undefined) payload['collapsed'] = comment.collapsed;
    if (comment.removed !== undefined) payload['removed'] = comment.removed;
  }

  return {
    recordType: 'communication',
    sourcePlatform: SOURCE_PLATFORM_REDDIT,
    sourceRecordId: raw.thingId,
    payload,
    observedAt,
  };
}

function selftextOrEmpty(post: RedditPostData): string {
  return post.selftext ?? '';
}

/**
 * Reddit overwrites the body of a deleted/removed post or comment with
 * the literal string `[deleted]` or `[removed]`. We surface that as
 * `null` so downstream consumers can distinguish "no body" from a
 * legitimate empty link post.
 */
function redactIfDeleted(body: string): string | null {
  if (DELETED_TOKENS.has(body.trim())) return null;
  return body;
}

// ---------------------------------------------------------------------------
// Person record
// ---------------------------------------------------------------------------

interface AuthorInfo {
  username: string | null;
  fullname: string | null;
  identifiable: boolean;
}

function pickAuthor(envelope: RedditEnvelope): AuthorInfo {
  const username = envelope.data.author;
  const fullname = envelope.data.author_fullname ?? null;
  if (DELETED_TOKENS.has(username) || username === '[deleted]') {
    return { username: null, fullname, identifiable: false };
  }
  return { username, fullname, identifiable: true };
}

function buildPersonRecord(
  raw: RawRedditItem,
  author: AuthorInfo,
  observedAt: string,
): NormalizedRecord {
  // username is non-null when identifiable. Narrow once at the boundary.
  const username = author.username as string;
  const handle = username.toLowerCase();
  const profileUrl = `https://www.reddit.com/user/${encodeURIComponent(username)}`;

  const platformIdentities: Array<{
    platform: 'reddit';
    handle: string;
    profile_url: string;
  }> = [
    {
      platform: 'reddit',
      handle,
      profile_url: profileUrl,
    },
  ];

  const payload: Metadata = {
    canonical_name: username,
    names_seen: [username],
    reddit_handle: handle,
    reddit_fullname: author.fullname,
    reddit_profile_url: profileUrl,
    platform_identities: platformIdentities,
    observed_role: raw.envelope.kind === 't3' ? 'post_author' : 'comment_author',
    subreddit_observed: raw.subreddit,
    thing_id: raw.thingId,
    post_fullname: raw.postFullname,
  };

  return {
    recordType: 'person',
    sourcePlatform: SOURCE_PLATFORM_REDDIT,
    // Use the author fullname when available (stable across renames),
    // otherwise fall back to the lowercased handle. Resolver-friendly.
    sourceRecordId: `reddit:author:${author.fullname ?? handle}`,
    payload,
    observedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPermalinkUrl(permalink: string): string {
  if (/^https?:\/\//i.test(permalink)) return permalink;
  const path = permalink.startsWith('/') ? permalink : `/${permalink}`;
  return `https://www.reddit.com${path}`;
}
