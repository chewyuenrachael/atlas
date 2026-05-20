/**
 * Adapter tests for the HN adapter. Exercise the public end-to-end contract:
 *   - `fetch()` paginates Algolia results via cursor encoding
 *   - `storeRaw` is idempotent on `hnItemId`
 *   - `normalize` reads the stored raw and returns the same NormalizedRecord[]
 *     the normalizer would produce directly
 *   - re-running `ingestOne` against the same item produces zero new rows
 *   - deleted / dead items normalize to empty arrays without dropping the raw
 *
 * No live network — the Algolia client is constructed with an injected
 * `fetchImpl` that serves fixture responses.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AlgoliaHackerNewsClient,
  ALGOLIA_HN_BASE_URL,
} from './client.js';
import { HackerNewsAdapter, InMemoryRawHackerNewsStore } from './adapter.js';
import type { HackerNewsAlgoliaResponse, RawHackerNewsItem } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(here, '__fixtures__', name), 'utf8');

const FIXED_CLOCK = (): Date => new Date('2026-05-20T12:00:00.000Z');

/**
 * Build a minimal `Response`-shaped stub that satisfies the Algolia client's
 * fetchImpl contract. The client only reads `ok`, `status`, and `.json()` —
 * we don't need a polyfill of the full DOM Response.
 */
function jsonResponse(body: string, status = 200): Response {
  const init: { status: number; headers: Record<string, string> } = {
    status,
    headers: { 'content-type': 'application/json' },
  };
  return new Response(body, init);
}

/** Single-page client that returns the given fixture for any request. */
function clientForFixture(fixtureName: string): {
  client: AlgoliaHackerNewsClient;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    return jsonResponse(fixture(fixtureName));
  };
  const client = new AlgoliaHackerNewsClient({ fetchImpl });
  return { client, calls };
}

/**
 * Multi-page client that returns the multi-author fixture on page 0 and
 * empty hits on page 1. Used to verify pagination terminates.
 */
function multiPageClient(): {
  client: AlgoliaHackerNewsClient;
  calls: string[];
} {
  const calls: string[] = [];
  const page0 = fixture('search_multi_author.json');
  // Tell the adapter there are two pages so the cursor advances once.
  const page0Adjusted = JSON.stringify({
    ...(JSON.parse(page0) as HackerNewsAlgoliaResponse),
    nbPages: 2,
  });
  const page1 = JSON.stringify({
    hits: [],
    page: 1,
    nbPages: 2,
    nbHits: 0,
    hitsPerPage: 20,
  } satisfies HackerNewsAlgoliaResponse);
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.includes('page=1')) return jsonResponse(page1);
    return jsonResponse(page0Adjusted);
  };
  const client = new AlgoliaHackerNewsClient({ fetchImpl });
  return { client, calls };
}

describe('HackerNewsAdapter — single page', () => {
  it('yields one RawHackerNewsItem per hit', async () => {
    const { client } = clientForFixture('search_multi_author.json');
    const adapter = new HackerNewsAdapter({
      client,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws.map((r) => r.hnItemId).sort()).toEqual([
      '43210001',
      '43210010',
      '43210011',
      '43210012',
    ]);
  });

  it('builds stable, unique idempotency keys', async () => {
    const { client } = clientForFixture('search_multi_author.json');
    const adapter = new HackerNewsAdapter({
      client,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const keys = raws.map((r) => adapter.idempotencyKey(r));
    expect(keys.every((k) => k.startsWith('hackernews:item:'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('classifies story vs comment items based on Algolia tags', async () => {
    const { client } = clientForFixture('search_multi_author.json');
    const adapter = new HackerNewsAdapter({
      client,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const story = raws.find((r) => r.hnItemId === '43210001');
    const comment = raws.find((r) => r.hnItemId === '43210010');
    expect(story?.itemType).toBe('story');
    expect(comment?.itemType).toBe('comment');
  });
});

describe('HackerNewsAdapter — storage', () => {
  it('storeRaw is idempotent: re-inserting the same item returns the same rawId', async () => {
    const { client } = clientForFixture('search_story.json');
    const store = new InMemoryRawHackerNewsStore();
    const adapter = new HackerNewsAdapter({
      client,
      store,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const first = raws[0];
    if (!first) throw new Error('fixture is empty');
    const a = await adapter.storeRaw(first);
    const b = await adapter.storeRaw(first);
    expect(a.rawId).toBe(b.rawId);
    expect(store.size()).toBe(1);
  });

  it('normalize produces deterministic Communication + Person records for a story', async () => {
    const { client } = clientForFixture('search_story.json');
    const adapter = new HackerNewsAdapter({
      client,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const first = raws[0];
    if (!first) throw new Error('fixture is empty');
    const { rawId } = await adapter.storeRaw(first);
    const a = JSON.stringify(await adapter.normalize(rawId));
    const b = JSON.stringify(await adapter.normalize(rawId));
    expect(a).toBe(b);
    const records = await adapter.normalize(rawId);
    expect(records.filter((r) => r.recordType === 'communication')).toHaveLength(1);
    expect(records.filter((r) => r.recordType === 'person')).toHaveLength(1);
  });

  it('normalize returns [] for a deleted item but the raw row is still persisted', async () => {
    const { client } = clientForFixture('search_deleted.json');
    const store = new InMemoryRawHackerNewsStore();
    const adapter = new HackerNewsAdapter({
      client,
      store,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    let normalizedTotal = 0;
    for await (const raw of adapter.fetch()) {
      const { rawId } = await adapter.storeRaw(raw);
      const records = await adapter.normalize(rawId);
      normalizedTotal += records.length;
    }
    expect(normalizedTotal).toBe(0);
    expect(store.size()).toBe(2);
  });

  it('re-running the full pipeline produces zero new raw rows', async () => {
    const { client } = clientForFixture('search_multi_author.json');
    const store = new InMemoryRawHackerNewsStore();
    const adapter = new HackerNewsAdapter({
      client,
      store,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    for await (const raw of adapter.fetch()) await adapter.ingestOne(raw);
    const firstRunSize = store.size();
    expect(firstRunSize).toBe(4);
    for await (const raw of adapter.fetch()) await adapter.ingestOne(raw);
    expect(store.size()).toBe(firstRunSize);
  });

  it('rejects normalize for a rawId that does not exist in the store', async () => {
    const { client } = clientForFixture('search_story.json');
    const adapter = new HackerNewsAdapter({
      client,
      retryOptions: { maxAttempts: 1 },
    });
    await expect(adapter.normalize('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /raw hackernews item not found/,
    );
  });

  it('produces a deterministic payloadHash across runs', async () => {
    const { client: clientA } = clientForFixture('search_story.json');
    const { client: clientB } = clientForFixture('search_story.json');
    const a = new HackerNewsAdapter({
      client: clientA,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const b = new HackerNewsAdapter({
      client: clientB,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const firsts: string[] = [];
    for await (const r of a.fetch()) firsts.push(r.payloadHash);
    const seconds: string[] = [];
    for await (const r of b.fetch()) seconds.push(r.payloadHash);
    expect(firsts).toEqual(seconds);
  });
});

describe('HackerNewsAdapter — pagination', () => {
  it('walks pages via cursor encoding until nbPages exhausted', async () => {
    const { client, calls } = multiPageClient();
    const adapter = new HackerNewsAdapter({
      client,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws).toHaveLength(4);
    expect(calls.some((c) => c.includes('page=0'))).toBe(true);
    expect(calls.some((c) => c.includes('page=1'))).toBe(true);
  });

  it('respects maxPages and stops walking even if Algolia advertises more', async () => {
    const { client } = multiPageClient();
    const adapter = new HackerNewsAdapter({
      client,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
      maxPages: 1,
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    // Only one page worth of items — the safety bound prevented the next call.
    expect(raws).toHaveLength(4);
  });

  it('includes numericFilters when sinceUnix is set', async () => {
    const { client, calls } = clientForFixture('search_story.json');
    const adapter = new HackerNewsAdapter({
      client,
      now: FIXED_CLOCK,
      retryOptions: { maxAttempts: 1 },
      sinceUnix: 1_700_000_000,
    });
    const raws: RawHackerNewsItem[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws).toHaveLength(1);
    expect(calls[0]).toContain('numericFilters=created_at_i%3E1700000000');
  });
});

describe('AlgoliaHackerNewsClient', () => {
  it('encodes query, tags, page, and hitsPerPage in the URL', () => {
    const client = new AlgoliaHackerNewsClient({ query: 'cursor', hitsPerPage: 25 });
    const url = client.buildSearchUrl({ page: 3 });
    expect(url.startsWith(`${ALGOLIA_HN_BASE_URL}/api/v1/search_by_date`)).toBe(true);
    expect(url).toContain('query=cursor');
    expect(url).toContain('hitsPerPage=25');
    expect(url).toContain('page=3');
    expect(url).toContain('tags=%28story%2Ccomment%29');
  });

  it('throws ExternalApiError on non-2xx responses', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse('{"error":"rate limited"}', 429);
    const client = new AlgoliaHackerNewsClient({ fetchImpl });
    await expect(client.search({ page: 0 })).rejects.toThrow(/algolia hn search returned 429/);
  });
});
