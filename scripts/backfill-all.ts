#!/usr/bin/env node
/**
 * Phase 2D — run HN + Reddit + GitHub ingestion pipelines back-to-back and
 * then refresh the cockpit materialized views.
 *
 * Each pipeline runs in its own try/catch — a failure in one source does not
 * block the others.
 *
 * Usage:
 *   pnpm backfill:all
 */
import { logger } from '@atlas/core';
import { ViewQueries } from '@atlas/db';
import {
  runGithubIngest,
  runHackerNewsIngest,
  runRedditIngest,
} from '@atlas/workflows-shared';

async function main(): Promise<void> {
  const log = logger.child({ script: 'backfill-all' });
  log.info('starting Phase 2D backfill: HN + Reddit + GitHub');

  // Hacker News first — fastest, no auth required.
  try {
    log.info('→ running HN backfill');
    const stats = await runHackerNewsIngest({ logger: log.child({ stage: 'hn' }) });
    log.info(stats, 'HN backfill complete');
  } catch (cause) {
    log.error({ err: cause }, 'HN backfill failed; continuing');
  }

  try {
    log.info('→ running Reddit backfill');
    const stats = await runRedditIngest({ logger: log.child({ stage: 'reddit' }) });
    log.info(stats, 'Reddit backfill complete');
  } catch (cause) {
    log.error({ err: cause }, 'Reddit backfill failed; continuing');
  }

  try {
    log.info('→ running GitHub backfill');
    const stats = await runGithubIngest({ logger: log.child({ stage: 'github' }) });
    log.info(stats, 'GitHub backfill complete');
  } catch (cause) {
    log.error({ err: cause }, 'GitHub backfill failed; continuing');
  }

  // Refresh materialized views so the cockpit reflects the new data.
  try {
    log.info('→ refreshing materialized views');
    const report = await ViewQueries.refreshAllViews();
    log.info({ report }, 'materialized views refreshed');
  } catch (cause) {
    log.error({ err: cause }, 'view refresh failed');
  }

  log.info('backfill:all finished');
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'backfill-all failed');
  process.exitCode = 1;
});
