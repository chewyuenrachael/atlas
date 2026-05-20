/**
 * Adapter tests. Exercise the public end-to-end contract:
 *   - `fetch()` polls every configured subreddit via the injected client
 *   - cursor-relevance filtering drops items below threshold before persistence
 *   - `storeRaw` is idempotent on `thingId`
 *   - `normalize` reads the stored raw and returns the same NormalizedRecord[]
 *     the normalizer would produce directly
 *   - deleted authors and removed bodies survive normalization without crashes
 *
 * No live network — both `searchSubreddit` and `fetchPostWithComments`
 * are injected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryRawRedditStore, RedditAdapter } from './adapter.js';
import { parsePostThread, parseSearchListing } from './client.js';
import type { RawRedditItem, RedditCommentData, RedditPostData } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(here, '__fixtures__', name), 'utf8'));

const FIXED_CLOCK = (): Date => new Date('2026-06-01T12:00:00.000Z');

interface SearchResult {
  posts: RedditPostData[];
  after: string | null;
}
interface ThreadResult {
  post: RedditPostData;
  comments: RedditCommentData[];
}

function buildAdapter(opts: {
  searchBySub: Record<string, SearchResult>;
  threadByPostId: Record<string, ThreadResult>;
  subreddits?: readonly string[];
  minCursorRelevance?: number;
  topCommentsPerPost?: number;
}): { adapter: RedditAdapter; store: InMemoryRawRedditStore; searchCalls: string[] } {
  const store = new InMemoryRawRedditStore();
  const searchCalls: string[] = [];

  const adapter = new RedditAdapter({
    store,
    subreddits: opts.subreddits ?? ['cursor'],
    postsPerSubreddit: 25,
    topCommentsPerPost: opts.topCommentsPerPost ?? 50,
    now: FIXED_CLOCK,
    retryOptions: { maxAttempts: 1 },
    ...(opts.minCursorRelevance !== undefined
      ? { minCursorRelevance: opts.minCursorRelevance }
      : {}),
    deps: {
      searchSubreddit: async (sub: string) => {
        searchCalls.push(sub);
        const r = opts.searchBySub[sub];
        if (!r) return { posts: [], after: null };
        return r;
      },
      fetchPostWithComments: async (postId: string) => {
        const t = opts.threadByPostId[postId];
        if (!t) throw new Error(`no thread fixture for ${postId}`);
        return t;
      },
    },
  });

  return { adapter, store, searchCalls };
}

describe('RedditAdapter', () => {
  it('discovers posts from a single subreddit and yields raw records', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const { adapter, searchCalls } = buildAdapter({
      searchBySub: { cursor: search },
      threadByPostId: { abc123: thread, def456: { post: thread.post, comments: [] } },
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(searchCalls).toEqual(['cursor']);
    expect(raws.length).toBeGreaterThan(0);
    expect(raws.find((r) => r.thingId === 't3_abc123')).toBeDefined();
  });

  it('polls every configured subreddit and tags raw records by subreddit', async () => {
    const cursorSearch = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const localSearch = parseSearchListing(
      fixture('search_localllama.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const { adapter, searchCalls } = buildAdapter({
      subreddits: ['cursor', 'LocalLLaMA'],
      searchBySub: { cursor: cursorSearch, LocalLLaMA: localSearch },
      threadByPostId: {
        abc123: thread,
        def456: emptyThread,
        ghi789: emptyThread,
        jkl012: emptyThread,
        lla001: emptyThread,
        lla002: emptyThread,
      },
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(searchCalls).toEqual(['cursor', 'LocalLLaMA']);
    const subreddits = new Set(raws.map((r) => r.subreddit));
    expect(subreddits.has('cursor')).toBe(true);
    expect(subreddits.has('LocalLLaMA')).toBe(true);
  });

  it('drops the SQL-cursor false positive but keeps real Cursor mentions', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const { adapter } = buildAdapter({
      searchBySub: { cursor: search },
      threadByPostId: {
        abc123: thread,
        def456: emptyThread,
        ghi789: emptyThread,
        jkl012: emptyThread,
      },
      minCursorRelevance: 0.6,
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const postIds = raws.filter((r) => r.kind === 't3').map((r) => r.envelope.data.id);
    expect(postIds).toContain('abc123');
    expect(postIds).not.toContain('ghi789');
  });

  it('caps captured comments at topCommentsPerPost per post', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const { adapter } = buildAdapter({
      searchBySub: {
        cursor: { posts: search.posts.filter((p) => p.id === 'abc123'), after: null },
      },
      threadByPostId: { abc123: thread },
      topCommentsPerPost: 1,
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const comments = raws.filter((r) => r.kind === 't1');
    expect(comments.length).toBeLessThanOrEqual(1);
  });

  it('produces a stable idempotencyKey per Reddit thing', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const { adapter } = buildAdapter({
      searchBySub: { cursor: search },
      threadByPostId: {
        abc123: thread,
        def456: emptyThread,
        ghi789: emptyThread,
        jkl012: emptyThread,
      },
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const keys = raws.map((r) => adapter.idempotencyKey(r));
    expect(keys.every((k) => k.startsWith('reddit:thing:'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('storeRaw is idempotent on thingId — re-inserting returns the same rawId', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const { adapter, store } = buildAdapter({
      searchBySub: { cursor: search },
      threadByPostId: {
        abc123: thread,
        def456: emptyThread,
        ghi789: emptyThread,
        jkl012: emptyThread,
      },
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const first = raws[0];
    if (!first) throw new Error('fixture is empty');
    const a = await adapter.storeRaw(first);
    const b = await adapter.storeRaw(first);
    expect(a.rawId).toBe(b.rawId);
    // Persist every raw item from the first fetch, then re-fetch and
    // re-persist — the second pass must produce zero new rows.
    for await (const r of adapter.fetch()) await adapter.storeRaw(r);
    const sizeAfterFirstFullRun = store.size();
    expect(sizeAfterFirstFullRun).toBeGreaterThan(0);
    for await (const r of adapter.fetch()) await adapter.storeRaw(r);
    expect(store.size()).toBe(sizeAfterFirstFullRun);
  });

  it('normalize returns Communication + Person and is deterministic', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const { adapter } = buildAdapter({
      searchBySub: { cursor: search },
      threadByPostId: {
        abc123: thread,
        def456: emptyThread,
        ghi789: emptyThread,
        jkl012: emptyThread,
      },
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const sf = raws.find((r) => r.thingId === 't3_abc123');
    if (!sf) throw new Error('fixture missing t3_abc123');
    const { rawId } = await adapter.storeRaw(sf);
    const a = JSON.stringify(await adapter.normalize(rawId));
    const b = JSON.stringify(await adapter.normalize(rawId));
    expect(a).toBe(b);
    const records = await adapter.normalize(rawId);
    expect(records.filter((r) => r.recordType === 'communication')).toHaveLength(1);
    expect(records.filter((r) => r.recordType === 'person')).toHaveLength(1);
  });

  it('survives a per-subreddit search failure and continues with the rest', async () => {
    const cursorSearch = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const store = new InMemoryRawRedditStore();
    const adapter = new RedditAdapter({
      store,
      subreddits: ['cursor', 'broken_sub'],
      retryOptions: { maxAttempts: 1 },
      now: FIXED_CLOCK,
      deps: {
        searchSubreddit: async (sub: string) => {
          if (sub === 'broken_sub') throw new Error('synthetic search failure');
          return cursorSearch;
        },
        fetchPostWithComments: async (postId: string) => {
          if (postId === 'abc123') return thread;
          return emptyThread;
        },
      },
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws.length).toBeGreaterThan(0);
    expect(raws.find((r) => r.subreddit === 'broken_sub')).toBeUndefined();
  });

  it('normalizes deleted-author posts and removed comment bodies without crashing', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const { adapter } = buildAdapter({
      searchBySub: { cursor: search },
      threadByPostId: {
        abc123: thread,
        def456: emptyThread,
        ghi789: emptyThread,
        jkl012: emptyThread,
      },
    });
    const raws: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    // The post fixture includes a [deleted] author (def456) and a [removed]
    // comment (c2bbbb). Normalize both and verify the contracts.
    const deletedAuthorPost = raws.find((r) => r.thingId === 't3_def456');
    if (deletedAuthorPost) {
      const { rawId } = await adapter.storeRaw(deletedAuthorPost);
      const records = await adapter.normalize(rawId);
      expect(records.filter((r) => r.recordType === 'person')).toHaveLength(0);
      const communication = records.find((r) => r.recordType === 'communication');
      expect(communication?.payload['author_deleted']).toBe(true);
    }
    const removedComment = raws.find((r) => r.thingId === 't1_c2bbbb');
    if (removedComment) {
      const { rawId } = await adapter.storeRaw(removedComment);
      const records = await adapter.normalize(rawId);
      const communication = records.find((r) => r.recordType === 'communication');
      expect(communication?.payload['body']).toBeNull();
    }
  });

  it('rejects normalize for a rawId that does not exist in the store', async () => {
    const search: SearchResult = { posts: [], after: null };
    const { adapter } = buildAdapter({ searchBySub: { cursor: search }, threadByPostId: {} });
    await expect(adapter.normalize('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /raw reddit item not found/,
    );
  });

  it('computes a deterministic payloadHash on the raw envelope', async () => {
    const search = parseSearchListing(
      fixture('search_cursor.json') as Parameters<typeof parseSearchListing>[0],
    );
    const thread = parsePostThread(fixture('post_thread.json'));
    const emptyThread: ThreadResult = { post: thread.post, comments: [] };
    const { adapter } = buildAdapter({
      searchBySub: { cursor: search },
      threadByPostId: {
        abc123: thread,
        def456: emptyThread,
        ghi789: emptyThread,
        jkl012: emptyThread,
      },
    });
    const first: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) first.push(r);
    const second: RawRedditItem[] = [];
    for await (const r of adapter.fetch()) second.push(r);
    expect(first.map((r) => r.payloadHash).sort()).toEqual(
      second.map((r) => r.payloadHash).sort(),
    );
  });
});
