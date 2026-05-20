#!/usr/bin/env node
/**
 * Phase 2D backfill — GitHub pipeline.
 *
 * Runs profile-refresh + repo-search. Skips gracefully when GITHUB_TOKEN is
 * not set (logs a warning, exits 0).
 *
 * Usage:
 *   pnpm backfill:github
 *   pnpm backfill:github -- --profile-limit=10 --repo-limit=20
 */
import { logger } from '@atlas/core';
import { getServiceClient } from '@atlas/db';
import { runGithubIngest } from '@atlas/workflows-shared';

function parseArgs(argv: string[]): { profileLimit?: number; repoLimit?: number } {
  const out: { profileLimit?: number; repoLimit?: number } = {};
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq);
    const v = Number(raw.slice(eq + 1));
    if (!Number.isFinite(v) || v <= 0) continue;
    if (key === '--profile-limit') out.profileLimit = Math.floor(v);
    if (key === '--repo-limit') out.repoLimit = Math.floor(v);
  }
  return out;
}

async function baseline(): Promise<{
  persons: number;
  communications: number;
  artifacts: number;
}> {
  const svc = getServiceClient();
  if (!svc.ok) throw svc.error;
  const sb = svc.value;
  const [p, c, a] = await Promise.all([
    sb.from('person').select('id', { count: 'exact', head: true }),
    sb.from('communication').select('id', { count: 'exact', head: true }),
    sb.from('artifact').select('id', { count: 'exact', head: true }),
  ]);
  return {
    persons: p.count ?? 0,
    communications: c.count ?? 0,
    artifacts: a.count ?? 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ script: 'backfill-github' });
  log.info({ args }, 'starting Phase 2D GitHub backfill');

  const before = await baseline();
  const stats = await runGithubIngest({
    ...(args.profileLimit !== undefined ? { profileLimit: args.profileLimit } : {}),
    ...(args.repoLimit !== undefined ? { repoLimit: args.repoLimit } : {}),
    logger: log,
  });
  const after = await baseline();

  const lines: string[] = ['', 'Phase 2D backfill — GitHub', '──────────────────────────────────────'];
  if (stats.skipped_no_token) {
    lines.push('  SKIPPED: GITHUB_TOKEN env var not set');
    lines.push('');
    process.stdout.write(lines.join('\n'));
    return;
  }
  lines.push(
    `  profiles discovered:      ${stats.profiles_discovered}`,
    `  profiles raw inserted:    ${stats.profiles_raw_inserted}`,
    `  profiles normalized:      ${stats.profiles_normalized}`,
    '',
    `  repos discovered:         ${stats.repos_discovered}`,
    `  repos raw inserted:       ${stats.repos_raw_inserted}`,
    `  repos normalized:         ${stats.repos_normalized}`,
    '',
    `  raw persist failures:     ${stats.raw_persist_failures}`,
    `  normalize failures:       ${stats.normalize_failures}`,
    '',
    '  identity resolution',
    `    persons created:        ${stats.persons_created}`,
    `    persons merged:         ${stats.persons_merged}`,
    `    persons human_review:   ${stats.persons_human_review}`,
    `    persons skipped:        ${stats.persons_skipped}`,
    `    resolve failures:       ${stats.person_resolve_failures}`,
    '',
    `  artifacts created:        ${stats.artifacts_created}`,
    `  artifact failures:        ${stats.artifact_failures}`,
    '',
    `  communications upserted:  ${stats.communications_upserted}`,
    `  communication failures:   ${stats.communication_upsert_failures}`,
    '',
    'database deltas',
    `  person rows:              ${before.persons} → ${after.persons}  (Δ${after.persons - before.persons})`,
    `  communication rows:       ${before.communications} → ${after.communications}  (Δ${after.communications - before.communications})`,
    `  artifact rows:            ${before.artifacts} → ${after.artifacts}  (Δ${after.artifacts - before.artifacts})`,
    '',
  );
  process.stdout.write(lines.join('\n'));
}

main().catch((cause: unknown) => {
  logger.error({ err: cause }, 'backfill-github failed');
  process.exitCode = 1;
});
