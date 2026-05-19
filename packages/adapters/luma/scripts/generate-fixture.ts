/**
 * Regenerate `src/__fixtures__/expected_normalized.json` from the typical
 * event detail fixture. Run after changes to the normalizer that *intentionally*
 * change output shape:
 *
 *   pnpm tsx packages/adapters/luma/scripts/generate-fixture.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { parseEventDetailHtml } from '../src/scraper.js';
import { normalizeLumaEvent } from '../src/normalizer.js';
import type { RawLumaEvent } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'src', '__fixtures__');

const html = readFileSync(path.join(fixturesDir, 'event_detail.html'), 'utf8');
const detail = parseEventDetailHtml(html, 'https://lu.ma/cursor-sf-jun');
const raw: RawLumaEvent = {
  lumaEventId: detail.slug,
  detail,
  scrapedAt: '2026-06-01T12:00:00.000Z',
  sourceUrl: detail.url,
  payloadHash: 'fixed-hash-for-tests',
};
const records = normalizeLumaEvent(raw);

writeFileSync(
  path.join(fixturesDir, 'expected_normalized.json'),
  JSON.stringify(records, null, 2) + '\n',
  'utf8',
);
console.warn(
  `wrote expected_normalized.json with ${records.length} record(s) ` +
    `(1 event + ${records.length - 1} person)`,
);
