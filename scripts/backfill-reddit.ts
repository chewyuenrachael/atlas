#!/usr/bin/env node
/**
 * Phase 2D backfill — Reddit pipeline.
 *
 * Usage:
 *   pnpm backfill:reddit
 *   pnpm backfill:reddit -- --limit=50
 */
import { logger } from '@atlas/core';
import { getServiceClient } from '@atlas/db';
import { runRedditIngest } from '@atlas/workflows-shared';

function parseArgs(argv: string[]): { limit?: number } {
  const out: { limit?: number } = {};
  for (const raw of argv) {
    if (raw.startsWith('--limit=')) {
      const n = Number(raw.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
    }
  }
  return out;
}

async function baseline(): Promise<{ persons: number; communications: number; edges: number }> {
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
  const log = logger.child({ script: 'backfill-reddit' });
  log.info({ args }, 'starting Phase 2D Reddit backfill');

  const before = await baseline();
  const stats = await runRedditIngest({
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    logger: log,
  });
  const after = await baseline();

  const lines: string[] = [
    '',
    'Phase 2D backfill — Reddit',
    '──────────────────────────────────────',
    `  items discovered:         ${stats.items_discovered}`,
    `  raw items inserted:       ${stats.raw_inserted}`,
    `  raw items already seen:   ${stats.raw_existed}`,
    `  raw persist failures:     ${stats.raw_persist_failures}`,
    '',
    `  normalized records:       ${stats.normalized_records}`,
    `  items skipped:            ${stats.items_skipped}`,
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
    `  mentions edges created:   ${stats.mentions_edges_created}`,
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
  logger.error({ err: cause }, 'backfill-reddit failed');
  process.exitCode = 1;
});
