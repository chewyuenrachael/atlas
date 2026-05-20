/**
 * Normalizer tests for the HN adapter.
 *
 * Exercises every fixture shape the adapter must handle:
 *   - typical story (URL, title, points)
 *   - typical comment (parent_id, story_id, comment_text)
 *   - deleted / dead items (skipped)
 *   - story without URL (Ask HN — content_url falls back to permalink)
 *   - multi-author search page (one Person per distinct author)
 *
 * Also asserts:
 *   - byte-for-byte determinism (re-normalizing the same raw is identical)
 *   - no edges emitted from the normalizer (that's identity resolution's job)
 *   - snapshot match against `expected_normalized.json`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyItemType, isDeletedOrDead, normalizeHackerNewsItem } from './normalizer.js';
import type { HackerNewsAlgoliaHit, RawHackerNewsItem } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(here, '__fixtures__', name), 'utf8');

const loadHits = (name: string): HackerNewsAlgoliaHit[] => {
  const raw = JSON.parse(fixture(name)) as { hits: HackerNewsAlgoliaHit[] };
  return raw.hits;
};

const FIXED_FETCHED_AT = '2026-05-20T12:00:00.000Z';

function buildRaw(hit: HackerNewsAlgoliaHit, fetchedAt = FIXED_FETCHED_AT): RawHackerNewsItem {
  return {
    hnItemId: hit.objectID,
    itemType: classifyItemType(hit),
    hit,
    fetchedAt,
    sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    payloadHash: 'fixed-hash-for-tests',
  };
}

describe('normalizeHackerNewsItem', () => {
  it('produces 1 Communication + 1 Person for a typical story', () => {
    const hit = loadHits('search_story.json')[0];
    if (!hit) throw new Error('fixture is empty');
    const records = normalizeHackerNewsItem(buildRaw(hit));
    expect(records).toHaveLength(2);
    expect(records[0]?.recordType).toBe('communication');
    expect(records[1]?.recordType).toBe('person');
  });

  it('story communication preserves URL, title, points, and tags', () => {
    const hit = loadHits('search_story.json')[0];
    if (!hit) throw new Error('fixture is empty');
    const [communication] = normalizeHackerNewsItem(buildRaw(hit));
    expect(communication?.payload).toMatchObject({
      hn_item_id: '43210001',
      item_type: 'story',
      title: 'Show HN: Cursor 1.0 - The AI Code Editor',
      author_handle: 'amanrs',
      content_url: 'https://cursor.com/blog/1-0',
      points: 387,
      num_comments: 142,
      is_about_cursor: true,
    });
    expect(communication?.payload['topic_tags']).toEqual(['story']);
  });

  it('produces 1 Communication + 1 Person for a typical comment', () => {
    const hit = loadHits('search_comment.json')[0];
    if (!hit) throw new Error('fixture is empty');
    const records = normalizeHackerNewsItem(buildRaw(hit));
    expect(records).toHaveLength(2);
    expect(records[0]?.recordType).toBe('communication');
    expect(records[0]?.payload['item_type']).toBe('comment');
    expect(records[0]?.payload['parent_id']).toBe('43210001');
    expect(records[0]?.payload['story_id']).toBe('43210001');
  });

  it('comment falls back to HN permalink when no story url is on the hit', () => {
    const original = loadHits('search_comment.json')[0];
    if (!original) throw new Error('fixture is empty');
    const hit: HackerNewsAlgoliaHit = { ...original, story_url: null };
    const [communication] = normalizeHackerNewsItem(buildRaw(hit));
    expect(communication?.payload['content_url']).toBe(
      'https://news.ycombinator.com/item?id=43210010',
    );
  });

  it('skips deleted items (null author) and dead items ([dead] body)', () => {
    const hits = loadHits('search_deleted.json');
    for (const hit of hits) {
      expect(isDeletedOrDead(hit)).toBe(true);
      expect(normalizeHackerNewsItem(buildRaw(hit))).toEqual([]);
    }
  });

  it('story without URL surfaces story_text in content_text and uses HN permalink as content_url', () => {
    const hit = loadHits('search_no_url.json')[0];
    if (!hit) throw new Error('fixture is empty');
    const [communication] = normalizeHackerNewsItem(buildRaw(hit));
    expect(communication?.payload['content_url']).toBe(
      'https://news.ycombinator.com/item?id=43210050',
    );
    const text = communication?.payload['content_text'];
    expect(typeof text).toBe('string');
    expect(String(text).startsWith("I've been using Cursor daily")).toBe(true);
  });

  it('multi-author thread emits one Person per distinct author', () => {
    const hits = loadHits('search_multi_author.json');
    const allRecords = hits.flatMap((hit) => normalizeHackerNewsItem(buildRaw(hit)));
    const personRecords = allRecords.filter((r) => r.recordType === 'person');
    const authorSet = new Set(personRecords.map((p) => p.sourceRecordId));
    expect(authorSet).toEqual(
      new Set([
        'hackernews:amanrs',
        'hackernews:devbyemma',
        'hackernews:grizzly_dev',
        'hackernews:quinoa42',
      ]),
    );
    expect(allRecords.filter((r) => r.recordType === 'communication')).toHaveLength(4);
  });

  it('Person record carries the canonical HN profile URL in platform_identities', () => {
    const hit = loadHits('search_story.json')[0];
    if (!hit) throw new Error('fixture is empty');
    const records = normalizeHackerNewsItem(buildRaw(hit));
    const person = records.find((r) => r.recordType === 'person');
    expect(person).toBeDefined();
    const identities = (person?.payload['platform_identities'] ?? []) as Array<{
      platform: string;
      handle: string;
      profile_url: string;
    }>;
    expect(identities).toEqual([
      {
        platform: 'hackernews',
        handle: 'amanrs',
        profile_url: 'https://news.ycombinator.com/user?id=amanrs',
      },
    ]);
  });

  it('does not emit edge records — those belong to identity resolution', () => {
    const hits = loadHits('search_multi_author.json');
    const records = hits.flatMap((hit) => normalizeHackerNewsItem(buildRaw(hit)));
    expect(records.some((r) => (r.recordType as string) === 'edge')).toBe(false);
  });

  it('is deterministic byte-for-byte', () => {
    const hit = loadHits('search_story.json')[0];
    if (!hit) throw new Error('fixture is empty');
    const a = JSON.stringify(normalizeHackerNewsItem(buildRaw(hit)));
    const b = JSON.stringify(normalizeHackerNewsItem(buildRaw(hit)));
    expect(a).toBe(b);
  });

  it('matches the expected_normalized.json fixture snapshot', () => {
    const hits = loadHits('search_multi_author.json');
    const records = hits.flatMap((hit) => normalizeHackerNewsItem(buildRaw(hit)));
    const expected = JSON.parse(fixture('expected_normalized.json')) as unknown;
    expect(records).toEqual(expected);
  });
});

describe('classifyItemType', () => {
  it('classifies story tags', () => {
    expect(classifyItemType({ _tags: ['story', 'author_x'] } as HackerNewsAlgoliaHit)).toBe(
      'story',
    );
  });

  it('classifies comment tags', () => {
    expect(classifyItemType({ _tags: ['comment'] } as HackerNewsAlgoliaHit)).toBe('comment');
  });

  it('falls back to story when only title is present', () => {
    const hit = {
      _tags: [],
      title: 'X',
      comment_text: null,
    } as unknown as HackerNewsAlgoliaHit;
    expect(classifyItemType(hit)).toBe('story');
  });

  it('returns unknown when nothing is identifiable', () => {
    const hit = {
      _tags: [],
      title: null,
      comment_text: null,
    } as unknown as HackerNewsAlgoliaHit;
    expect(classifyItemType(hit)).toBe('unknown');
  });
});
