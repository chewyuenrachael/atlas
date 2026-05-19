/**
 * Scraper tests. Covers pure HTML parsing only — no live network or
 * playwright invocation. Live behavior is exercised manually via `cli.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseCommunityPageHtml,
  parseEventDetailHtml,
  scrapeCommunityPage,
  scrapeEventDetail,
} from './scraper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(here, '__fixtures__', name), 'utf8');

describe('parseCommunityPageHtml', () => {
  it('extracts events from __NEXT_DATA__ and anchor hrefs', () => {
    const html = fixture('community_page.html');
    const listings = parseCommunityPageHtml(html, 'https://lu.ma');
    const slugs = listings.map((l) => l.slug).sort();
    expect(slugs).toEqual(['9ifuc4yo', 'cursor-london-launch', 'cursor-sf-jun']);
  });

  it('hydrates listing URLs and titles when available', () => {
    const html = fixture('community_page.html');
    const listings = parseCommunityPageHtml(html, 'https://lu.ma');
    const sf = listings.find((l) => l.slug === 'cursor-sf-jun');
    expect(sf).toBeDefined();
    expect(sf?.url).toBe('https://lu.ma/cursor-sf-jun');
    expect(sf?.title).toBe('Cafe Cursor SF — June Edition');
  });

  it('returns no listings for empty or unrelated HTML', () => {
    expect(parseCommunityPageHtml('<html><body>nothing here</body></html>')).toEqual([]);
  });

  it('skips navigation/auth slugs and short slugs', () => {
    const html = `
      <a href="https://lu.ma/login">Log in</a>
      <a href="https://lu.ma/discover">Discover</a>
      <a href="https://lu.ma/ab">Too short</a>
      <a href="https://lu.ma/Capitalized">Bad case</a>
    `;
    expect(parseCommunityPageHtml(html, 'https://lu.ma')).toEqual([]);
  });

  it('is deterministic for the same input', () => {
    const html = fixture('community_page.html');
    const a = parseCommunityPageHtml(html, 'https://lu.ma');
    const b = parseCommunityPageHtml(html, 'https://lu.ma');
    expect(a).toEqual(b);
  });
});

describe('parseEventDetailHtml', () => {
  it('parses a typical event with full JSON-LD + __NEXT_DATA__', () => {
    const html = fixture('event_detail.html');
    const detail = parseEventDetailHtml(html, 'https://lu.ma/cursor-sf-jun');
    expect(detail.slug).toBe('cursor-sf-jun');
    expect(detail.title).toBe('Cafe Cursor SF — June Edition');
    expect(detail.description).toBe('Monthly Cafe Cursor for SF Bay Area builders.');
    expect(detail.startsAt).toBeTruthy();
    expect(detail.endsAt).toBeTruthy();
    expect(detail.timezone).toBe('America/Los_Angeles');
    expect(detail.venueName).toBe('Cursor HQ');
    expect(detail.venueCity).toBe('San Francisco');
    expect(detail.venueCountry).toBe('United States');
    expect(detail.eventFormat).toBe('in_person');
    expect(detail.registeredCount).toBe(128);
  });

  it('returns two organizers with merged external links', () => {
    const html = fixture('event_detail.html');
    const detail = parseEventDetailHtml(html, 'https://lu.ma/cursor-sf-jun');
    expect(detail.organizers).toHaveLength(2);
    const alice = detail.organizers.find((o) => o.name === 'Alice Chen');
    expect(alice).toBeDefined();
    expect(alice?.lumaHandle).toBe('alicechen');
    expect(alice?.externalLinks.map((l) => l.platform).sort()).toEqual(['github', 'twitter']);
    const bruno = detail.organizers.find((o) => o.name === 'Bruno Tavares');
    expect(bruno?.lumaHandle).toBe('brunot');
    expect(bruno?.externalLinks.map((l) => l.platform)).toEqual(['linkedin']);
  });

  it('produces best-effort output when only minimal metadata is available', () => {
    const html = fixture('event_detail_minimal.html');
    const detail = parseEventDetailHtml(html, 'https://lu.ma/mystery-meetup');
    expect(detail.slug).toBe('mystery-meetup');
    expect(detail.title).toBe('Mystery Meetup');
    expect(detail.startsAt).toBeNull();
    expect(detail.organizers).toEqual([]);
    expect(detail.venueName).toBeNull();
  });

  it('does not throw on malformed HTML', () => {
    const html = fixture('event_detail_malformed.html');
    const detail = parseEventDetailHtml(html, 'https://lu.ma/broken-event');
    expect(detail.slug).toBe('broken-event');
    expect(typeof detail.title).toBe('string');
    expect(detail.organizers).toEqual([]);
  });
});

describe('scrapeCommunityPage / scrapeEventDetail (injected fetcher)', () => {
  it('uses the injected htmlFetcher and never touches playwright', async () => {
    const html = fixture('community_page.html');
    let called = 0;
    const listings = await scrapeCommunityPage({
      baseUrl: 'https://lu.ma',
      communitySlug: 'cursorcommunity',
      useCache: false,
      htmlFetcher: async (url) => {
        called += 1;
        expect(url).toBe('https://lu.ma/cursorcommunity');
        return html;
      },
    });
    expect(called).toBe(1);
    expect(listings.length).toBeGreaterThanOrEqual(3);
  });

  it('scrapeEventDetail returns a structured snapshot via the injected fetcher', async () => {
    const html = fixture('event_detail.html');
    const detail = await scrapeEventDetail('https://lu.ma/cursor-sf-jun', {
      useCache: false,
      htmlFetcher: async () => html,
    });
    expect(detail.title).toBe('Cafe Cursor SF — June Edition');
    expect(detail.organizers).toHaveLength(2);
  });
});
