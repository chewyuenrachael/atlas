/**
 * Adapter tests. Exercise the public end-to-end contract:
 *   - `fetch()` discovers events via the injected listing fetcher
 *   - `storeRaw` is idempotent on `lumaEventId`
 *   - `normalize` reads the stored raw and returns the same NormalizedRecord[]
 *     the normalizer would produce directly
 *   - re-running `ingestOne` against the same raw event produces zero new
 *     records (raw store dedupes on lumaEventId)
 *
 * No playwright or network calls — both scraper functions are injected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LumaAdapter, InMemoryRawLumaStore } from './adapter.js';
import { parseCommunityPageHtml, parseEventDetailHtml } from './scraper.js';
import type { CommunityEventListing, RawLumaEvent, ScrapedEventDetail } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(here, '__fixtures__', name), 'utf8');

const FIXED_CLOCK = (): Date => new Date('2026-06-01T12:00:00.000Z');

function buildAdapter(): {
  adapter: LumaAdapter;
  store: InMemoryRawLumaStore;
  listingCalls: number;
  detailCalls: { url: string }[];
} {
  const store = new InMemoryRawLumaStore();
  const detailCalls: { url: string }[] = [];
  let listingCalls = 0;
  const fetchListings = async (): Promise<CommunityEventListing[]> => {
    listingCalls += 1;
    return parseCommunityPageHtml(fixture('community_page.html'), 'https://lu.ma');
  };
  const fetchDetail = async (url: string): Promise<ScrapedEventDetail> => {
    detailCalls.push({ url });
    if (url.endsWith('/cursor-sf-jun')) {
      return parseEventDetailHtml(fixture('event_detail.html'), url);
    }
    return parseEventDetailHtml(fixture('event_detail_minimal.html'), url);
  };
  const adapter = new LumaAdapter({
    store,
    fetchListings,
    fetchDetail,
    now: FIXED_CLOCK,
    retryOptions: { maxAttempts: 1 },
  });
  return {
    adapter,
    store,
    get listingCalls() {
      return listingCalls;
    },
    detailCalls,
  };
}

describe('LumaAdapter', () => {
  it('discovers every community page event and yields raw records', async () => {
    const { adapter, detailCalls } = buildAdapter();
    const raws: RawLumaEvent[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws.length).toBe(3);
    expect(raws.map((r) => r.lumaEventId).sort()).toEqual([
      '9ifuc4yo',
      'cursor-london-launch',
      'cursor-sf-jun',
    ]);
    expect(detailCalls).toHaveLength(3);
  });

  it('produces a stable idempotencyKey per event', async () => {
    const { adapter } = buildAdapter();
    const raws: RawLumaEvent[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const keys = raws.map((r) => adapter.idempotencyKey(r));
    expect(keys.every((k) => k.startsWith('luma:event:'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('storeRaw is idempotent: re-inserting the same event returns the same rawId', async () => {
    const { adapter, store } = buildAdapter();
    const raws: RawLumaEvent[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const first = raws[0];
    if (!first) throw new Error('fixture is empty');

    const a = await adapter.storeRaw(first);
    const b = await adapter.storeRaw(first);
    expect(a.rawId).toBe(b.rawId);
    expect(store.size()).toBe(1);
  });

  it('normalize returns Event + Person records and is byte-for-byte deterministic', async () => {
    const { adapter } = buildAdapter();
    const raws: RawLumaEvent[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    const sf = raws.find((r) => r.lumaEventId === 'cursor-sf-jun');
    if (!sf) throw new Error('fixture missing cursor-sf-jun');

    const { rawId } = await adapter.storeRaw(sf);
    const a = JSON.stringify(await adapter.normalize(rawId));
    const b = JSON.stringify(await adapter.normalize(rawId));
    expect(a).toBe(b);

    const records = await adapter.normalize(rawId);
    expect(records.filter((r) => r.recordType === 'event')).toHaveLength(1);
    expect(records.filter((r) => r.recordType === 'person')).toHaveLength(2);
  });

  it('re-running the full pipeline produces zero new raw records', async () => {
    const { adapter, store } = buildAdapter();
    for await (const r of adapter.fetch()) {
      await adapter.ingestOne(r);
    }
    const sizeAfterFirstRun = store.size();
    expect(sizeAfterFirstRun).toBe(3);

    for await (const r of adapter.fetch()) {
      await adapter.ingestOne(r);
    }
    expect(store.size()).toBe(sizeAfterFirstRun);
  });

  it('survives per-event scrape failures and continues with the rest', async () => {
    const store = new InMemoryRawLumaStore();
    const fetchListings = async (): Promise<CommunityEventListing[]> =>
      parseCommunityPageHtml(fixture('community_page.html'), 'https://lu.ma');
    const fetchDetail = async (url: string): Promise<ScrapedEventDetail> => {
      if (url.endsWith('/cursor-london-launch')) {
        throw new Error('synthetic scrape failure');
      }
      return parseEventDetailHtml(fixture('event_detail.html'), url);
    };
    const adapter = new LumaAdapter({
      store,
      fetchListings,
      fetchDetail,
      retryOptions: { maxAttempts: 1 },
    });
    const raws: RawLumaEvent[] = [];
    for await (const r of adapter.fetch()) raws.push(r);
    expect(raws.length).toBe(2);
    expect(raws.find((r) => r.lumaEventId === 'cursor-london-launch')).toBeUndefined();
  });

  it('rejects normalize for a rawId that does not exist in the store', async () => {
    const { adapter } = buildAdapter();
    await expect(adapter.normalize('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /raw luma event not found/,
    );
  });

  it('computes a deterministic payloadHash on the raw envelope', async () => {
    const { adapter } = buildAdapter();
    const first: RawLumaEvent[] = [];
    for await (const r of adapter.fetch()) first.push(r);
    const second: RawLumaEvent[] = [];
    for await (const r of adapter.fetch()) second.push(r);
    expect(first.map((r) => r.payloadHash).sort()).toEqual(second.map((r) => r.payloadHash).sort());
  });
});
