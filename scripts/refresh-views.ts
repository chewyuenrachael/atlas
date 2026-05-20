#!/usr/bin/env node
/**
 * Refresh every Atlas materialized view in dependency order.
 *
 * SPEC.md §6.4 calls for materialized views refreshed on a schedule
 * (every 15 minutes) or on demand. Production will wire this into Inngest
 * (Phase 4); for now this script is the on-demand path.
 *
 * Usage:
 *   pnpm refresh:views
 *
 * Exits 0 on success, 1 on failure. Prints per-view durations and a
 * total wall-clock summary suitable for CI / cron logs.
 */
import { isErr } from '@atlas/core';
import { ViewQueries } from '@atlas/db';

async function main(): Promise<void> {
  const result = await ViewQueries.refreshAllViews();
  if (isErr(result)) {
    process.stderr.write(
      `refresh:views failed: ${result.error.message}\n${JSON.stringify(result.error.context, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const report = result.value;
  const lines: string[] = [
    '',
    'Atlas materialized view refresh',
    '──────────────────────────────────────',
  ];
  for (const r of report.results) {
    lines.push(`  ✓ ${r.view.padEnd(32)} ${r.durationMs.toString().padStart(6)}ms`);
  }
  lines.push('');
  lines.push(`Refreshed ${report.results.length} views in ${report.totalDurationMs}ms`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`refresh:views failed: ${message}\n`);
  process.exitCode = 1;
});
