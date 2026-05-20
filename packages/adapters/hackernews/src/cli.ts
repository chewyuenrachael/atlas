#!/usr/bin/env node
/**
 * One-shot Hacker News fetch CLI.
 *
 * Polls the live Algolia HN Search API for items mentioning Cursor, runs
 * the full normalization pipeline against an in-memory raw store, and
 * reports counts. The CLI is the operator-facing smoke test for the
 * adapter — running it against the live API is the "Definition of done"
 * exit criterion in the task brief for SPEC.md §5.2.6.
 *
 * @example
 * ```sh
 * pnpm tsx packages/adapters/hackernews/src/cli.ts
 * # → items fetched: 60, communications: 60, persons: 47
 * ```
 *
 * Flags:
 *   --base-url=<url>      Override the Algolia origin (default https://hn.algolia.com)
 *   --query=<term>        Override the search query (default cursor)
 *   --max-pages=<n>       Cap on Algolia pages to walk per run (default 50)
 *   --since-unix=<n>      Only return items newer than this unix-second epoch
 *   --json                Emit the full NormalizedRecord[] as JSON on stdout
 *   --limit=<n>           Stop after fetching N raw items (smoke test)
 */
import { logger, type NormalizedRecord } from '@atlas/core';
import { HackerNewsAdapter, type HackerNewsAdapterOptions } from './adapter.js';

interface CliArgs {
  baseUrl?: string;
  query?: string;
  maxPages?: number;
  sinceUnix?: number;
  emitJson: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { emitJson: false, limit: null };
  for (const raw of argv) {
    if (raw === '--json') {
      args.emitJson = true;
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    switch (key) {
      case '--base-url':
        args.baseUrl = value;
        break;
      case '--query':
        args.query = value;
        break;
      case '--max-pages': {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) args.maxPages = Math.floor(n);
        break;
      }
      case '--since-unix': {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) args.sinceUnix = Math.floor(n);
        break;
      }
      case '--limit': {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
        break;
      }
      default:
        break;
    }
  }
  return args;
}

interface RunStats {
  itemsFetched: number;
  itemsStored: number;
  itemsExisted: number;
  itemsSkipped: number;
  normalizedRecords: number;
  communicationRecords: number;
  personRecords: number;
  failedDuringStore: number;
  failedDuringNormalize: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ component: 'hackernews-cli' });

  const adapterOptions: HackerNewsAdapterOptions = {
    clientOptions: {
      ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      ...(args.query ? { query: args.query } : {}),
    },
    ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
    ...(args.sinceUnix !== undefined ? { sinceUnix: args.sinceUnix } : {}),
  };

  log.info(
    {
      base_url: args.baseUrl ?? '(env or default)',
      query: args.query ?? '(env or default)',
      max_pages: args.maxPages ?? '(default 50)',
      since_unix: args.sinceUnix ?? null,
      limit: args.limit,
    },
    'starting hackernews one-shot fetch',
  );

  const adapter = new HackerNewsAdapter(adapterOptions);
  const stats: RunStats = {
    itemsFetched: 0,
    itemsStored: 0,
    itemsExisted: 0,
    itemsSkipped: 0,
    normalizedRecords: 0,
    communicationRecords: 0,
    personRecords: 0,
    failedDuringStore: 0,
    failedDuringNormalize: 0,
  };
  const allRecords: NormalizedRecord[] = [];

  for await (const raw of adapter.fetch()) {
    stats.itemsFetched += 1;
    let rawId: string;
    try {
      ({ rawId } = await adapter.storeRaw(raw));
      stats.itemsStored += 1;
    } catch (cause) {
      stats.failedDuringStore += 1;
      log.warn({ err: cause, hn_item_id: raw.hnItemId }, 'store failed; skipping');
      continue;
    }
    let records: NormalizedRecord[];
    try {
      records = await adapter.normalize(rawId);
    } catch (cause) {
      stats.failedDuringNormalize += 1;
      log.warn({ err: cause, raw_id: rawId }, 'normalize failed; skipping');
      continue;
    }
    if (records.length === 0) stats.itemsSkipped += 1;
    stats.normalizedRecords += records.length;
    for (const r of records) {
      if (r.recordType === 'communication') stats.communicationRecords += 1;
      if (r.recordType === 'person') stats.personRecords += 1;
      allRecords.push(r);
    }
    if (args.limit !== null && stats.itemsFetched >= args.limit) break;
  }

  log.info(
    {
      items_fetched: stats.itemsFetched,
      items_stored: stats.itemsStored,
      items_existed: stats.itemsExisted,
      items_skipped_after_normalize: stats.itemsSkipped,
      normalized_records: stats.normalizedRecords,
      communication_records: stats.communicationRecords,
      person_records: stats.personRecords,
      failed_during_store: stats.failedDuringStore,
      failed_during_normalize: stats.failedDuringNormalize,
    },
    'hackernews fetch complete',
  );

  process.stdout.write(
    [
      'hackernews one-shot fetch — summary',
      `  items fetched:         ${String(stats.itemsFetched)}`,
      `  items stored:          ${String(stats.itemsStored)}`,
      `  normalized records:    ${String(stats.normalizedRecords)}`,
      `    communications:      ${String(stats.communicationRecords)}`,
      `    persons:             ${String(stats.personRecords)}`,
      `  skipped (deleted etc): ${String(stats.itemsSkipped)}`,
      `  store failures:        ${String(stats.failedDuringStore)}`,
      `  normalize failures:    ${String(stats.failedDuringNormalize)}`,
      '',
    ].join('\n'),
  );

  if (args.emitJson) {
    process.stdout.write(JSON.stringify(allRecords, null, 2) + '\n');
  }
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'hackernews cli failed');
  process.exitCode = 1;
});
