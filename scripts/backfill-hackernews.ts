#!/usr/bin/env node
/**
 * Phase 2D backfill — run the HN ingestion pipeline once against the live
 * Supabase database. Same shape as `scripts/backfill-luma.ts`.
 *
 * Usage:
 *   pnpm backfill:hackernews
 *   pnpm backfill:hackernews -- --limit=50
 */
import { logger } from '@atlas/core';
import { getServiceClient } from '@atlas/db';
import { runHackerNewsIngest } from '@atlas/workflows-shared';

interface CliArgs {
  limit?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (key === '--limit') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
    }
  }
  return args;
}

async function captureBaseline(): Promise<{
  persons: number;
  communications: number;
  edges: number;
}> {
  const svc = getServiceClient();
  if (!svc.ok) throw svc.error;
  const sb = svc.value;
  const [p, c, e] = await Promise.all([
    sb.from('person').select('id', { count: 'exact', head: true }),
    sb.from('communication').select('id', { count: 'exact', head: true }),
    sb.from('person_person_edge').select('id', { count: 'exact', head: true }),
  ]);
  return {
    persons: p.count ?? 0,
    communications: c.count ?? 0,
    edges: e.count ?? 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ script: 'backfill-hackernews' });
  log.info({ args }, 'starting Phase 2D HN backfill');

  const before = await captureBaseline();
  const stats = await runHackerNewsIngest({
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    logger: log,
  });
  const after = await captureBaseline();

  const lines: string[] = [
    '',
    'Phase 2D backfill — Hacker News',
    '──────────────────────────────────────',
    `  items discovered:         ${stats.items_discovered}`,
    `  raw items inserted:       ${stats.raw_inserted}`,
    `  raw items already seen:   ${stats.raw_existed}`,
    `  raw persist failures:     ${stats.raw_persist_failures}`,
    '',
    `  normalized records:       ${stats.normalized_records}`,
    `  items skipped (deleted):  ${stats.items_skipped}`,
    `  normalize failures:       ${stats.normalize_failures}`,
    '',
    '  identity resolution',
    `    persons created:        ${stats.persons_created}`,
    `    persons merged:         ${stats.persons_merged}`,
    `    persons human_review:   ${stats.persons_human_review}`,
    `    persons skipped:        ${stats.persons_skipped}`,
    `    resolve failures:       ${stats.person_resolve_failures}`,
    '',
    `  communications upserted:  ${stats.communications_upserted}`,
    `  communication failures:   ${stats.communication_upsert_failures}`,
    '',
    `  mentions edges created:   ${stats.mentions_edges_created}`,
    `  mentions edge failures:   ${stats.mentions_edge_failures}`,
    '',
    'database deltas',
    `  person rows:              ${before.persons} → ${after.persons}  (Δ${after.persons - before.persons})`,
    `  communication rows:       ${before.communications} → ${after.communications}  (Δ${after.communications - before.communications})`,
    `  person_person_edge rows:  ${before.edges} → ${after.edges}  (Δ${after.edges - before.edges})`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'backfill-hackernews failed');
  process.exitCode = 1;
});
