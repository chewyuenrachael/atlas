/**
 * Regenerate `src/__fixtures__/expected_normalized.json` from the
 * `search_multi_author.json` fixture. Run after intentional normalizer changes:
 *
 *   pnpm tsx packages/adapters/hackernews/scripts/generate-fixture.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { classifyItemType, normalizeHackerNewsItem } from '../src/normalizer.js';
import type {
  HackerNewsAlgoliaHit,
  HackerNewsAlgoliaResponse,
  RawHackerNewsItem,
} from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'src', '__fixtures__');

const FIXED_FETCHED_AT = '2026-05-20T12:00:00.000Z';

const response = JSON.parse(
  readFileSync(path.join(fixturesDir, 'search_multi_author.json'), 'utf8'),
) as HackerNewsAlgoliaResponse;

const records = response.hits.flatMap((hit: HackerNewsAlgoliaHit) => {
  const raw: RawHackerNewsItem = {
    hnItemId: hit.objectID,
    itemType: classifyItemType(hit),
    hit,
    fetchedAt: FIXED_FETCHED_AT,
    sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    payloadHash: 'fixed-hash-for-tests',
  };
  return normalizeHackerNewsItem(raw);
});

writeFileSync(
  path.join(fixturesDir, 'expected_normalized.json'),
  JSON.stringify(records, null, 2) + '\n',
  'utf8',
);
console.warn(
  `wrote expected_normalized.json with ${String(records.length)} record(s) ` +
    `from ${String(response.hits.length)} hit(s)`,
);
