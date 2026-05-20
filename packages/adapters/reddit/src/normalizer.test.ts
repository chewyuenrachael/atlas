/**
 * Normalizer tests. Exercise determinism and edge cases — posts vs
 * comments, deleted authors, removed bodies, and the contract that
 * no edges are produced at this stage (identity resolution owns edge
 * synthesis).
 */
import { describe, expect, it } from 'vitest';
import { normalizeRedditItem } from './normalizer.js';
import { computeCursorRelevance } from './relevance.js';
import type { RawRedditItem, RedditCommentData, RedditPostData } from './types.js';

const FIXED_FETCHED_AT = '2026-06-01T12:00:00.000Z';

function buildRawPost(overrides: Partial<RedditPostData> = {}): RawRedditItem {
  const post: RedditPostData = {
    id: 'abc123',
    subreddit: 'cursor',
    title: 'Cursor 0.45 just shipped',
    selftext: 'Just upgraded the Cursor IDE and the composer is snappier.',
    author: 'vibe_coder',
    author_fullname: 't2_aaaaa1',
    created_utc: 1748952000,
    score: 412,
    num_comments: 87,
    permalink: '/r/cursor/comments/abc123/cursor_045_just_shipped/',
    is_self: true,
    ...overrides,
  };
  const text = `${post.title}\n${post.selftext ?? ''}`;
  return {
    thingId: `t3_${post.id}`,
    kind: 't3',
    postFullname: `t3_${post.id}`,
    subreddit: post.subreddit,
    envelope: { kind: 't3', data: post },
    cursorRelevance: computeCursorRelevance(text, post.subreddit),
    fetchedAt: FIXED_FETCHED_AT,
    sourceUrl: `https://www.reddit.com/r/${post.subreddit}/search.json?q=cursor`,
    payloadHash: 'fixed-hash-for-tests',
  };
}

function buildRawComment(overrides: Partial<RedditCommentData> = {}): RawRedditItem {
  const comment: RedditCommentData = {
    id: 'c1aaaa',
    parent_id: 't3_abc123',
    link_id: 't3_abc123',
    subreddit: 'cursor',
    author: 'agent_fan',
    author_fullname: 't2_ddddd4',
    body: 'The cursor agent loop with Claude is doing real work.',
    created_utc: 1748952500,
    score: 64,
    permalink: '/r/cursor/comments/abc123/cursor_045_just_shipped/c1aaaa/',
    ...overrides,
  };
  return {
    thingId: `t1_${comment.id}`,
    kind: 't1',
    postFullname: comment.link_id,
    subreddit: comment.subreddit,
    envelope: { kind: 't1', data: comment },
    cursorRelevance: computeCursorRelevance(comment.body, comment.subreddit),
    fetchedAt: FIXED_FETCHED_AT,
    sourceUrl: `https://www.reddit.com/r/${comment.subreddit}/comments/abc123.json`,
    payloadHash: 'fixed-hash-for-tests',
  };
}

describe('normalizeRedditItem', () => {
  it('produces 1 Communication and 1 Person record for a typical post', () => {
    const raw = buildRawPost();
    const records = normalizeRedditItem(raw);
    expect(records).toHaveLength(2);
    expect(records[0]?.recordType).toBe('communication');
    expect(records[1]?.recordType).toBe('person');
  });

  it('produces 1 Communication + 1 Person for a comment as well', () => {
    const raw = buildRawComment();
    const records = normalizeRedditItem(raw);
    expect(records).toHaveLength(2);
    const communication = records.find((r) => r.recordType === 'communication');
    expect(communication?.payload['kind']).toBe('t1');
    expect(communication?.payload['parent_id']).toBe('t3_abc123');
  });

  it('skips the Person record when the author is [deleted]', () => {
    const raw = buildRawPost({ author: '[deleted]', author_fullname: undefined });
    const records = normalizeRedditItem(raw);
    expect(records).toHaveLength(1);
    expect(records[0]?.recordType).toBe('communication');
    expect(records[0]?.payload['author_deleted']).toBe(true);
    expect(records[0]?.payload['author_username']).toBeNull();
  });

  it('redacts the body to null when content was removed', () => {
    const raw = buildRawComment({ body: '[removed]' });
    const records = normalizeRedditItem(raw);
    const communication = records.find((r) => r.recordType === 'communication');
    expect(communication?.payload['body']).toBeNull();
  });

  it('captures cursor_relevance signals on the Communication payload', () => {
    const raw = buildRawPost({
      title: 'Cursor IDE editor AI coding',
      selftext: '',
    });
    const records = normalizeRedditItem(raw);
    const communication = records.find((r) => r.recordType === 'communication');
    expect(communication?.payload['cursor_relevance_matched']).toBe(true);
    expect(communication?.payload['cursor_relevance_score']).toBeGreaterThan(0.5);
    const boosts = communication?.payload['cursor_relevance_boost_terms'] as string[];
    expect(boosts).toContain('ide');
    expect(boosts).toContain('editor');
  });

  it('uses author_fullname for the Person sourceRecordId when present (stable)', () => {
    const raw = buildRawPost({ author: 'newname', author_fullname: 't2_stable_id' });
    const records = normalizeRedditItem(raw);
    const person = records.find((r) => r.recordType === 'person');
    expect(person?.sourceRecordId).toBe('reddit:author:t2_stable_id');
  });

  it('falls back to lowercased handle for sourceRecordId when fullname is absent', () => {
    const raw = buildRawPost({ author: 'CamelCase', author_fullname: undefined });
    const records = normalizeRedditItem(raw);
    const person = records.find((r) => r.recordType === 'person');
    expect(person?.sourceRecordId).toBe('reddit:author:camelcase');
  });

  it('emits a reddit platform identity with the canonical profile URL', () => {
    const raw = buildRawPost({ author: 'vibe_coder' });
    const records = normalizeRedditItem(raw);
    const person = records.find((r) => r.recordType === 'person');
    const identities = person?.payload['platform_identities'] as Array<{
      platform: string;
      handle: string;
      profile_url: string;
    }>;
    expect(identities).toHaveLength(1);
    expect(identities[0]?.platform).toBe('reddit');
    expect(identities[0]?.profile_url).toBe('https://www.reddit.com/user/vibe_coder');
  });

  it('distinguishes post_author vs comment_author observed_role', () => {
    const post = normalizeRedditItem(buildRawPost()).find((r) => r.recordType === 'person');
    const comment = normalizeRedditItem(buildRawComment()).find((r) => r.recordType === 'person');
    expect(post?.payload['observed_role']).toBe('post_author');
    expect(comment?.payload['observed_role']).toBe('comment_author');
  });

  it('does not emit edge records — identity resolution territory', () => {
    const records = normalizeRedditItem(buildRawPost());
    expect(records.some((r) => (r.recordType as string) === 'edge')).toBe(false);
  });

  it('is deterministic byte-for-byte', () => {
    const raw = buildRawPost();
    const a = JSON.stringify(normalizeRedditItem(raw));
    const b = JSON.stringify(normalizeRedditItem(raw));
    expect(a).toBe(b);
  });

  it('drops raw items with an empty thingId', () => {
    const raw = buildRawPost();
    const broken: RawRedditItem = { ...raw, thingId: '' };
    expect(normalizeRedditItem(broken)).toEqual([]);
  });
});
