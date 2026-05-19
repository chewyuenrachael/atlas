/**
 * Normalizer tests. Exercise determinism and edge cases — multiple organizers,
 * missing optional fields, and the contract that no edges are produced at
 * this stage (identity resolution owns edge synthesis).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEventDetailHtml } from './scraper.js';
import { normalizeLumaEvent } from './normalizer.js';
import type { RawLumaEvent, ScrapedEventDetail } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(here, '__fixtures__', name), 'utf8');

const FIXED_OBSERVED_AT = '2026-06-01T12:00:00.000Z';

function buildRaw(detail: ScrapedEventDetail, observedAt = FIXED_OBSERVED_AT): RawLumaEvent {
  return {
    lumaEventId: detail.slug,
    detail,
    scrapedAt: observedAt,
    sourceUrl: detail.url,
    payloadHash: 'fixed-hash-for-tests',
  };
}

describe('normalizeLumaEvent', () => {
  it('produces 1 Event record and N Person records for a typical event', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail.html'),
      'https://lu.ma/cursor-sf-jun',
    );
    const records = normalizeLumaEvent(buildRaw(detail));
    expect(records).toHaveLength(3);
    expect(records[0]?.recordType).toBe('event');
    expect(records.slice(1).every((r) => r.recordType === 'person')).toBe(true);
  });

  it('emits one Person per organizer with stable sourceRecordId', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail.html'),
      'https://lu.ma/cursor-sf-jun',
    );
    const records = normalizeLumaEvent(buildRaw(detail));
    const persons = records.filter((r) => r.recordType === 'person');
    expect(persons.map((p) => p.sourceRecordId).sort()).toEqual([
      'cursor-sf-jun:alicechen',
      'cursor-sf-jun:brunot',
    ]);
  });

  it('records platform_identities for organizers including Luma + external links', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail.html'),
      'https://lu.ma/cursor-sf-jun',
    );
    const records = normalizeLumaEvent(buildRaw(detail));
    const alice = records
      .filter((r) => r.recordType === 'person')
      .find((p) => p.sourceRecordId === 'cursor-sf-jun:alicechen');
    expect(alice).toBeDefined();
    const identities = (alice?.payload['platform_identities'] as Array<{ platform: string }>) ?? [];
    expect(identities.map((i) => i.platform).sort()).toEqual(['github', 'luma', 'twitter']);
  });

  it('skips events that lack a title', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail.html'),
      'https://lu.ma/cursor-sf-jun',
    );
    const broken: RawLumaEvent = buildRaw({ ...detail, title: '' });
    expect(normalizeLumaEvent(broken)).toEqual([]);
  });

  it('still emits an Event when optional fields are missing', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail_minimal.html'),
      'https://lu.ma/mystery-meetup',
    );
    const records = normalizeLumaEvent(buildRaw(detail));
    expect(records).toHaveLength(1);
    const event = records[0];
    expect(event?.recordType).toBe('event');
    expect(event?.payload['starts_at']).toBeNull();
    expect(event?.payload['venue_city']).toBeNull();
  });

  it('does not emit Person-Event edge records — that is identity resolution territory', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail.html'),
      'https://lu.ma/cursor-sf-jun',
    );
    const records = normalizeLumaEvent(buildRaw(detail));
    expect(records.some((r) => (r.recordType as string) === 'edge')).toBe(false);
  });

  it('is deterministic byte-for-byte', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail.html'),
      'https://lu.ma/cursor-sf-jun',
    );
    const a = JSON.stringify(normalizeLumaEvent(buildRaw(detail)));
    const b = JSON.stringify(normalizeLumaEvent(buildRaw(detail)));
    expect(a).toBe(b);
  });

  it('matches the expected_normalized.json fixture snapshot', () => {
    const detail = parseEventDetailHtml(
      fixture('event_detail.html'),
      'https://lu.ma/cursor-sf-jun',
    );
    const records = normalizeLumaEvent(buildRaw(detail));
    const expected = JSON.parse(fixture('expected_normalized.json')) as unknown;
    expect(records).toEqual(expected);
  });
});
