#!/usr/bin/env node
/**
 * One-shot Luma fetch CLI.
 *
 * Discovers events on the configured community page, scrapes each event
 * detail page, runs the full normalization pipeline against an in-memory
 * raw store, and reports counts. The CLI is the operator-facing smoke test
 * for the adapter — running it against the live community page is the
 * "Definition of done" exit criterion in the task brief for SPEC.md §5.2.1.
 *
 * @example
 * ```sh
 * pnpm tsx packages/adapters/luma/src/cli.ts
 * # → events scraped: 12, organizers identified: 18, normalized records: 30
 * ```
 *
 * Flags:
 *   --base-url=<url>           Override LUMA_BASE_URL (default https://lu.ma)
 *   --community=<slug>         Override LUMA_COMMUNITY_SLUG (default cursorcommunity)
 *   --no-cache                 Bypass the .cache/luma/* HTML cache
 *   --json                     Emit the full NormalizedRecord[] as JSON
 *   --limit=<n>                Stop after fetching N events (smoke test)
 */
import { logger, type NormalizedRecord } from '@atlas/core';
import { LumaAdapter } from './adapter.js';
import type { ScraperOptions } from './scraper.js';

interface CliArgs {
  baseUrl?: string;
  communitySlug?: string;
  useCache: boolean;
  emitJson: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { useCache: true, emitJson: false, limit: null };
  for (const raw of argv) {
    if (raw === '--no-cache') {
      args.useCache = false;
      continue;
    }
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
      case '--community':
        args.communitySlug = value;
        break;
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
  eventsScraped: number;
  organizersIdentified: number;
  normalizedRecords: number;
  personRecords: number;
  eventRecords: number;
  failedDuringStore: number;
  failedDuringNormalize: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ component: 'luma-cli' });

  const scraperOptions: ScraperOptions = { useCache: args.useCache };
  if (args.baseUrl) scraperOptions.baseUrl = args.baseUrl;
  if (args.communitySlug) scraperOptions.communitySlug = args.communitySlug;

  log.info(
    {
      base_url: args.baseUrl ?? '(env or default)',
      community: args.communitySlug ?? '(env or default)',
      cache_enabled: args.useCache,
      limit: args.limit,
    },
    'starting luma one-shot fetch',
  );

  const adapter = new LumaAdapter({ scraperOptions });
  const stats: RunStats = {
    eventsScraped: 0,
    organizersIdentified: 0,
    normalizedRecords: 0,
    personRecords: 0,
    eventRecords: 0,
    failedDuringStore: 0,
    failedDuringNormalize: 0,
  };
  const allRecords: NormalizedRecord[] = [];

  for await (const raw of adapter.fetch()) {
    stats.eventsScraped += 1;
    let rawId: string;
    try {
      ({ rawId } = await adapter.storeRaw(raw));
    } catch (cause) {
      stats.failedDuringStore += 1;
      log.warn({ err: cause, luma_event_id: raw.lumaEventId }, 'store failed; skipping');
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
    stats.normalizedRecords += records.length;
    for (const r of records) {
      if (r.recordType === 'event') stats.eventRecords += 1;
      if (r.recordType === 'person') stats.personRecords += 1;
      allRecords.push(r);
    }
    stats.organizersIdentified += records.filter((r) => r.recordType === 'person').length;
    if (args.limit !== null && stats.eventsScraped >= args.limit) break;
  }

  log.info(
    {
      events_scraped: stats.eventsScraped,
      organizers_identified: stats.organizersIdentified,
      normalized_records: stats.normalizedRecords,
      event_records: stats.eventRecords,
      person_records: stats.personRecords,
      failed_during_store: stats.failedDuringStore,
      failed_during_normalize: stats.failedDuringNormalize,
    },
    'luma fetch complete',
  );

  // Operator-friendly summary on stdout. Logs above go to the structured
  // logger (stdout in dev, configurable in prod).
  process.stdout.write(
    [
      'luma one-shot fetch — summary',
      `  events scraped:        ${stats.eventsScraped}`,
      `  organizers identified: ${stats.organizersIdentified}`,
      `  normalized records:    ${stats.normalizedRecords}`,
      `    events:              ${stats.eventRecords}`,
      `    persons:             ${stats.personRecords}`,
      `  store failures:        ${stats.failedDuringStore}`,
      `  normalize failures:    ${stats.failedDuringNormalize}`,
      '',
    ].join('\n'),
  );

  if (args.emitJson) {
    process.stdout.write(JSON.stringify(allRecords, null, 2) + '\n');
  }
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'luma cli failed');
  process.exitCode = 1;
});
