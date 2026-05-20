/**
 * Client tests. Covers pure JSON parsing and the HTTP plumbing layer
 * via an injected `httpFetcher` — no live network calls.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchPostWithComments,
  parsePostThread,
  parseSearchListing,
  searchSubreddit,
} from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(here, '__fixtures__', name), 'utf8'));

describe('parseSearchListing', () => {
  it('extracts t3 posts and forwards the after cursor', () => {
    const listing = fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0];
    const result = parseSearchListing(listing);
    expect(result.after).toBe('t3_def456');
    expect(result.posts).toHaveLength(4);
    expect(result.posts.map((p) => p.id)).toEqual(['abc123', 'def456', 'ghi789', 'jkl012']);
  });

  it('tolerates a deleted author on a post', () => {
    const listing = fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0];
    const result = parseSearchListing(listing);
    const deletedPost = result.posts.find((p) => p.id === 'def456');
    expect(deletedPost?.author).toBe('[deleted]');
    expect(deletedPost?.author_fullname).toBeUndefined();
  });

  it('returns empty posts/after for an empty listing', () => {
    expect(
      parseSearchListing({
        kind: 'Listing',
        data: { after: null, children: [] },
      }),
    ).toEqual({ posts: [], after: null });
  });
});

describe('parsePostThread', () => {
  it('parses the post + comments and skips `more` placeholders', () => {
    const thread = fixture('post_thread.json');
    const { post, comments } = parsePostThread(thread);
    expect(post.id).toBe('abc123');
    expect(comments).toHaveLength(4);
    expect(comments.map((c) => c.id)).toEqual(['c1aaaa', 'c2bbbb', 'c3cccc', 'c4dddd']);
  });

  it('captures a deleted-author / removed-body comment in the envelope', () => {
    const { comments } = parsePostThread(fixture('post_thread.json'));
    const removed = comments.find((c) => c.id === 'c2bbbb');
    expect(removed).toBeDefined();
    expect(removed?.author).toBe('[deleted]');
    expect(removed?.body).toBe('[removed]');
    expect(removed?.removed).toBe(true);
  });

  it('throws on completely malformed input', () => {
    expect(() => parsePostThread({})).toThrow(/malformed/);
  });
});

describe('searchSubreddit (with injected httpFetcher)', () => {
  it('builds the expected search URL and returns parsed posts', async () => {
    const seenUrls: string[] = [];
    const result = await searchSubreddit('cursor', {
      limit: 25,
      httpFetcher: async (url: string) => {
        seenUrls.push(url);
        return {
          status: 200,
          json: async () => fixture('search_cursor.json'),
          text: async () => '',
        };
      },
    });
    expect(seenUrls).toHaveLength(1);
    const url = seenUrls[0] ?? '';
    expect(url).toMatch(/\/r\/cursor\/search\.json/);
    expect(url).toContain('q=cursor');
    expect(url).toContain('limit=25');
    expect(url).toContain('restrict_sr=1');
    expect(result.posts.length).toBe(4);
  });

  it('throws an IngestionError on HTTP 429', async () => {
    await expect(
      searchSubreddit('cursor', {
        httpFetcher: async () => ({
          status: 429,
          json: async () => ({}),
          text: async () => 'slow down',
        }),
      }),
    ).rejects.toThrow(/rate limited/);
  });

  it('throws an IngestionError on non-2xx', async () => {
    await expect(
      searchSubreddit('cursor', {
        httpFetcher: async () => ({
          status: 503,
          json: async () => ({}),
          text: async () => 'service unavailable',
        }),
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe('fetchPostWithComments (with injected httpFetcher)', () => {
  it('fetches the post thread URL and returns post + comments', async () => {
    const seenUrls: string[] = [];
    const { post, comments } = await fetchPostWithComments('abc123', 'cursor', {
      commentLimit: 50,
      httpFetcher: async (url: string) => {
        seenUrls.push(url);
        return {
          status: 200,
          json: async () => fixture('post_thread.json'),
          text: async () => '',
        };
      },
    });
    expect(seenUrls[0]).toMatch(/\/r\/cursor\/comments\/abc123\.json/);
    expect(seenUrls[0]).toContain('limit=50');
    expect(seenUrls[0]).toContain('sort=top');
    expect(post.id).toBe('abc123');
    expect(comments.length).toBe(4);
  });
});
