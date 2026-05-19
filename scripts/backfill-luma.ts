#!/usr/bin/env node
/**
 * Phase 1D backfill — run the full Luma ingestion pipeline once against the
 * live Supabase database referenced by `SUPABASE_*` / `DATABASE_URL`.
 *
 * Drives `runLumaIngest()` (the same code path the Inngest workflow uses)
 * with `step.run` orchestration replaced by direct calls. Reports:
 *
 *   - Events created (upserted)
 *   - Persons created / merged / human_review / skipped
 *   - resolution_decision audit summary by action
 *   - Raw counts before/after
 *
 * Usage:
 *   pnpm backfill:luma                  # full backfill against live Luma
 *   pnpm backfill:luma -- --limit=5     # smoke test, first 5 events only
 *   pnpm backfill:luma -- --no-cache    # bypass the .cache/luma/* HTML cache
 *
 * @example
 * ```sh
 * pnpm backfill:luma
 * # → events upserted: 14, persons created: 22, persons merged: 5
 * ```
 *
 * SPEC ref: §11 Phase 1 exit criteria.
 */
import { logger } from '@atlas/core';
import { AuditQueries, getServiceClient } from '@atlas/db';
import { LumaAdapter, SupabaseRawLumaStore } from '@atlas/adapter-luma';
import { runLumaIngest } from '@atlas/workflows-shared';

interface CliArgs {
  limit?: number;
  useCache: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { useCache: true };
  for (const raw of argv) {
    if (raw === '--no-cache') {
      args.useCache = false;
      continue;
    }
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

async function preflight(): Promise<void> {
  const svc = getServiceClient();
  if (!svc.ok) {
    process.stderr.write(`[backfill] supabase client not configured: ${svc.error.message}\n`);
    process.exit(1);
  }
  const ping = await svc.value.from('event').select('id', { count: 'exact', head: true });
  if (ping.error) {
    process.stderr.write(`[backfill] supabase ping failed: ${ping.error.message}\n`);
    process.exit(1);
  }
}

async function captureBaseline(): Promise<{
  events: number;
  persons: number;
  decisions: number;
}> {
  const svc = getServiceClient();
  if (!svc.ok) throw svc.error;
  const sb = svc.value;
  const [e, p, d] = await Promise.all([
    sb.from('event').select('id', { count: 'exact', head: true }),
    sb.from('person').select('id', { count: 'exact', head: true }),
    sb.from('resolution_decision').select('id', { count: 'exact', head: true }),
  ]);
  return {
    events: e.count ?? 0,
    persons: p.count ?? 0,
    decisions: d.count ?? 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ script: 'backfill-luma' });
  log.info({ args }, 'starting Phase 1D backfill');

  await preflight();
  const before = await captureBaseline();
  log.info(before, 'baseline counts (before backfill)');

  // Wire up the adapter explicitly so we can control the cache and the
  // raw store from CLI args.
  const rawStore = new SupabaseRawLumaStore();
  const adapter = new LumaAdapter({
    store: rawStore,
    scraperOptions: { useCache: args.useCache },
  });

  const stats = await runLumaIngest({
    adapter,
    rawStore,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    logger: log,
  });

  const after = await captureBaseline();
  const decisionSummary = await AuditQueries.summarizeResolutionDecisionsByAction();

  // Operator-friendly summary on stdout. Structured logs go to the logger.
  const lines: string[] = [
    '',
    'Phase 1D backfill — summary',
    '──────────────────────────────────────',
    `  events discovered:        ${stats.events_discovered}`,
    `  raw events inserted:      ${stats.raw_inserted}`,
    `  raw events already seen:  ${stats.raw_existed}`,
    `  raw persist failures:     ${stats.raw_persist_failures}`,
    '',
    `  events upserted:          ${stats.events_upserted}`,
    `  event upsert failures:    ${stats.event_upsert_failures}`,
    '',
    `  normalized records:       ${stats.normalized_records}`,
    `  normalize failures:       ${stats.normalize_failures}`,
    '',
    '  identity resolution',
    `    persons created:        ${stats.persons_created}`,
    `    persons merged:         ${stats.persons_merged}`,
    `    persons human_review:   ${stats.persons_human_review}`,
    `    persons skipped:        ${stats.persons_skipped}`,
    `    resolve failures:       ${stats.person_resolve_failures}`,
    '',
    `  organizer edges created:  ${stats.organizer_edges_created}`,
    `  organizer edge failures:  ${stats.organizer_edge_failures}`,
    '',
    'database deltas',
    `  event rows:               ${before.events} → ${after.events}  (Δ${after.events - before.events})`,
    `  person rows:              ${before.persons} → ${after.persons}  (Δ${after.persons - before.persons})`,
    `  resolution_decision rows: ${before.decisions} → ${after.decisions}  (Δ${after.decisions - before.decisions})`,
    '',
  ];
  if (decisionSummary.ok) {
    lines.push('resolution_decision audit summary (lifetime)');
    for (const [action, count] of Object.entries(decisionSummary.value)) {
      lines.push(`  ${action.padEnd(14)}: ${count}`);
    }
  } else {
    lines.push(`resolution_decision summary unavailable: ${decisionSummary.error.message}`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'backfill-luma failed');
  process.exitCode = 1;
});
