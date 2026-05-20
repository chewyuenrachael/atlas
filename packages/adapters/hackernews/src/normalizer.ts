/**
 * Hacker News normalizer — converts `RawHackerNewsItem` into `NormalizedRecord[]`.
 *
 * Output contract (SPEC.md §5.2.6):
 *   - One Communication record per HN item (story or comment)
 *   - One Person record per author observed (HN handles are 1:1 per item, so
 *     each non-deleted item emits exactly one Person)
 *
 * Deleted / dead items are skipped — they contribute no useful entity data.
 *
 * Edges (`communication_mentions_person`, `person_platform_identity`) are NOT
 * emitted here. Identity resolution composes them downstream from the
 * `NormalizedRecord[]` stream.
 *
 * Normalization is deterministic: the same RawHackerNewsItem always produces
 * the same array of NormalizedRecord, byte-for-byte. Tests rely on this.
 */
import { logger, type Metadata, type NormalizedRecord } from '@atlas/core';
import type {
  HackerNewsAlgoliaHit,
  HackerNewsItemType,
  RawHackerNewsItem,
} from './types.js';

const log = logger.child({ adapter: 'hackernews', component: 'normalizer' });

const SOURCE_PLATFORM_HN = 'hackernews';

/** Canonical user profile URL on news.ycombinator.com for an HN handle. */
export function hnUserProfileUrl(author: string): string {
  return `https://news.ycombinator.com/user?id=${encodeURIComponent(author)}`;
}

/** Canonical permalink for an HN item id. */
export function hnItemPermalink(itemId: string): string {
  return `https://news.ycombinator.com/item?id=${encodeURIComponent(itemId)}`;
}

/**
 * Detect deleted / dead items that Algolia still indexes. HN marks such
 * items with `null` author and stub-text contents — we treat both signals
 * as authoritative and skip normalization for them.
 */
export function isDeletedOrDead(hit: HackerNewsAlgoliaHit): boolean {
  if (!hit.author || hit.author.trim().length === 0) return true;
  const bodies = [hit.story_text, hit.comment_text, hit.title];
  return bodies.some((body) => body !== null && /^\s*\[(deleted|dead)\]\s*$/i.test(body));
}

/**
 * Resolve the item type from Algolia's `_tags` array. Falls back to inferring
 * from content presence — defensive against shape changes.
 */
export function classifyItemType(hit: HackerNewsAlgoliaHit): HackerNewsItemType {
  for (const tag of hit._tags ?? []) {
    if (tag === 'story') return 'story';
    if (tag === 'comment') return 'comment';
    if (tag === 'poll') return 'poll';
  }
  if (hit.comment_text !== null) return 'comment';
  if (hit.title !== null) return 'story';
  return 'unknown';
}

/**
 * Convert one raw HN item into the canonical normalized records.
 *
 * @param raw - The raw item as stored in `raw_hackernews_item.raw_payload`.
 * @returns One Communication record followed by 0 or 1 Person records.
 *   Returns an empty array if the item is deleted, missing required fields,
 *   or otherwise unusable (e.g. no created_at and no objectID).
 *
 * @example
 * ```ts
 * const records = normalizeHackerNewsItem(raw);
 * const comms = records.filter((r) => r.recordType === 'communication');
 * const persons = records.filter((r) => r.recordType === 'person');
 * ```
 */
export function normalizeHackerNewsItem(raw: RawHackerNewsItem): NormalizedRecord[] {
  if (!raw.hnItemId) {
    log.warn({ fetched_at: raw.fetchedAt }, 'dropping raw record without hn_item_id');
    return [];
  }
  const hit = raw.hit;
  if (isDeletedOrDead(hit)) {
    log.info({ hn_item_id: raw.hnItemId }, 'skipping deleted/dead hn item');
    return [];
  }
  const postedAt = hit.created_at ?? raw.fetchedAt;
  const author = hit.author;
  // `isDeletedOrDead` already guards against `null` author but TS narrows on
  // a fresh local — re-check defensively.
  if (!author) {
    log.warn({ hn_item_id: raw.hnItemId }, 'hn item missing author after dead-check; skipping');
    return [];
  }

  const out: NormalizedRecord[] = [];
  out.push(buildCommunicationRecord(raw, hit, postedAt));
  out.push(buildPersonRecord(author, raw.fetchedAt));
  return out;
}

// ---------------------------------------------------------------------------
// Communication record
// ---------------------------------------------------------------------------

function buildCommunicationRecord(
  raw: RawHackerNewsItem,
  hit: HackerNewsAlgoliaHit,
  postedAt: string,
): NormalizedRecord {
  const itemType = raw.itemType;
  const contentText = deriveContentText(hit, itemType);
  const contentUrl = deriveContentUrl(hit, itemType, raw.sourceUrl);
  const topicTags = (hit._tags ?? []).filter((t) => isTopicTag(t));

  const payload: Metadata = {
    hn_item_id: raw.hnItemId,
    item_type: itemType,
    title: hit.title,
    author_handle: hit.author,
    content_text: contentText,
    content_url: contentUrl,
    permalink: raw.sourceUrl,
    posted_at: hit.created_at,
    posted_at_unix: hit.created_at_i,
    points: hit.points,
    num_comments: hit.num_comments,
    parent_id: hit.parent_id !== null ? String(hit.parent_id) : null,
    story_id: hit.story_id !== null ? String(hit.story_id) : null,
    story_title: hit.story_title,
    story_url: hit.story_url,
    is_about_cursor: true,
    topic_tags: topicTags,
    payload_hash: raw.payloadHash,
  };
  return {
    recordType: 'communication',
    sourcePlatform: SOURCE_PLATFORM_HN,
    sourceRecordId: raw.hnItemId,
    payload,
    observedAt: postedAt,
  };
}

/**
 * Pick the best text body for the item. Order: comment_text for comments,
 * story_text for self-posts (Ask HN / Show HN), title as a last resort. We
 * never silently coalesce to an empty string — null means "no body present".
 */
function deriveContentText(
  hit: HackerNewsAlgoliaHit,
  itemType: HackerNewsItemType,
): string | null {
  if (itemType === 'comment') return hit.comment_text;
  if (hit.story_text !== null && hit.story_text.trim().length > 0) return hit.story_text;
  return hit.title;
}

/**
 * Pick the best link to surface. Stories prefer the linked URL; comments and
 * link-less stories fall back to the HN permalink so the row always has a
 * navigable destination.
 */
function deriveContentUrl(
  hit: HackerNewsAlgoliaHit,
  itemType: HackerNewsItemType,
  permalink: string,
): string {
  if (itemType === 'story' && hit.url && hit.url.trim().length > 0) return hit.url;
  return permalink;
}

/**
 * Drop Algolia's bookkeeping tags (`author_<>`, `story_<>`) which carry no
 * topical signal — they're identifiers, not classifications.
 */
function isTopicTag(tag: string): boolean {
  if (tag.startsWith('author_')) return false;
  if (tag.startsWith('story_')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Person record
// ---------------------------------------------------------------------------

interface PlatformIdentityPayload {
  platform: 'hackernews';
  handle: string;
  profile_url: string;
}

function buildPersonRecord(author: string, observedAt: string): NormalizedRecord {
  const profileUrl = hnUserProfileUrl(author);
  const platformIdentities: PlatformIdentityPayload[] = [
    { platform: 'hackernews', handle: author, profile_url: profileUrl },
  ];
  const payload: Metadata = {
    canonical_name: author,
    names_seen: [author],
    hn_handle: author,
    hn_profile_url: profileUrl,
    platform_identities: platformIdentities,
    observed_role: 'commenter',
  };
  return {
    recordType: 'person',
    sourcePlatform: SOURCE_PLATFORM_HN,
    sourceRecordId: `hackernews:${author}`,
    payload,
    observedAt,
  };
}
