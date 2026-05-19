#!/usr/bin/env node
/**
 * Phase 1 exit-criteria verifier.
 *
 * Runs the checks listed in the Phase 1D task brief (which itself codifies
 * SPEC.md §11 Phase 1 exit criteria) and prints a pass/fail report:
 *
 *   - Schema: every Section 3 table exists in the public schema
 *   - Data:   ≥ 20 Event rows
 *   - Data:   ≥ 50 Person rows
 *   - Data:   ≥ 1 resolution_decision audit row per Person (matched_person_id)
 *   - Data:   no raw_luma_event rows stuck in normalization_status='pending'
 *             for more than 5 minutes
 *   - Health: schema-level smoke (a representative read query succeeds)
 *
 * Exits 0 if every check passes, 1 otherwise.
 *
 * Usage:
 *   pnpm verify:phase-1
 *
 * SPEC ref: §11 Phase 1 exit criteria, §3 (canonical schema).
 */
import { isErr } from '@atlas/core';
import { AuditQueries, EventQueries, getServiceClient } from '@atlas/db';
import { openPgClient, readDatabaseUrl } from '@atlas/db/pg-client';

const REQUIRED_TABLES = [
  // Entities (SPEC.md §3.2)
  'company',
  'person',
  'person_platform_identity',
  'program',
  'event',
  'communication',
  'artifact',
  'signal',
  // Edges (SPEC.md §3.3)
  'person_event',
  'person_company',
  'person_person_edge',
  'communication_mentions_person',
  'communication_mentions_company',
  'artifact_uses_artifact',
  'program_managed_by_person',
  'event_part_of_program',
  // Raw tables (SPEC.md §3.5)
  'raw_luma_event',
  'raw_twitter_post',
  'raw_github_profile',
  'raw_github_commit',
  'raw_linkedin_profile',
  'raw_reddit_post',
  'raw_hackernews_item',
  'raw_youtube_video',
  'raw_cursor_forum_post',
  'raw_cursor_product_event',
  // Audit / event-sourcing / queue (SPEC.md §4.4, §4.5, §6.2, §10.5)
  'entity_event_log',
  'resolution_decision',
  'resolution_conflict',
  'access_audit_log',
  'human_review_queue',
] as const;

const MIN_EVENTS = 20;
const MIN_PERSONS = 50;
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function checkSchema(): Promise<CheckResult> {
  const urlResult = readDatabaseUrl();
  if (isErr(urlResult)) {
    return { name: 'schema', pass: false, detail: urlResult.error.message };
  }
  let client;
  try {
    client = await openPgClient(urlResult.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { name: 'schema', pass: false, detail: `pg connect failed: ${message}` };
  }
  try {
    const result = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const present = new Set(result.rows.map((r) => r.tablename));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length > 0) {
      return {
        name: 'schema',
        pass: false,
        detail: `missing tables: ${missing.join(', ')}`,
      };
    }
    return {
      name: 'schema',
      pass: true,
      detail: `${REQUIRED_TABLES.length}/${REQUIRED_TABLES.length} required tables present`,
    };
  } finally {
    await client.end();
  }
}

async function countRows(table: string): Promise<number> {
  const svc = getServiceClient();
  if (isErr(svc)) throw svc.error;
  const result = await svc.value.from(table).select('id', { count: 'exact', head: true });
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

async function checkEventCount(): Promise<CheckResult> {
  try {
    const count = await countRows('event');
    return {
      name: 'event_count',
      pass: count >= MIN_EVENTS,
      detail: `event rows = ${count} (need ≥ ${MIN_EVENTS})`,
    };
  } catch (cause) {
    return {
      name: 'event_count',
      pass: false,
      detail: `query failed: ${formatErr(cause)}`,
    };
  }
}

async function checkPersonCount(): Promise<CheckResult> {
  try {
    const count = await countRows('person');
    return {
      name: 'person_count',
      pass: count >= MIN_PERSONS,
      detail: `person rows = ${count} (need ≥ ${MIN_PERSONS})`,
    };
  } catch (cause) {
    return {
      name: 'person_count',
      pass: false,
      detail: `query failed: ${formatErr(cause)}`,
    };
  }
}

async function checkResolutionPerPerson(): Promise<CheckResult> {
  try {
    const personCount = await countRows('person');
    const decisionPersonCount = await AuditQueries.countPersonsWithResolutionDecisions();
    if (isErr(decisionPersonCount)) {
      return {
        name: 'resolution_per_person',
        pass: false,
        detail: `query failed: ${decisionPersonCount.error.message}`,
      };
    }
    const haveResolved = decisionPersonCount.value;
    // We want ≥1 audit row per Person. Strict equality might fail if a
    // legacy person sneaked in without going through the resolver; require
    // at least personCount audit-resolved Persons.
    return {
      name: 'resolution_per_person',
      pass: haveResolved >= personCount,
      detail: `${haveResolved}/${personCount} persons have ≥ 1 resolution_decision row`,
    };
  } catch (cause) {
    return {
      name: 'resolution_per_person',
      pass: false,
      detail: `query failed: ${formatErr(cause)}`,
    };
  }
}

async function checkNoStuckRaw(): Promise<CheckResult> {
  const result = await EventQueries.countStuckRawLumaEvents(STUCK_THRESHOLD_MS);
  if (isErr(result)) {
    return {
      name: 'no_stuck_raw',
      pass: false,
      detail: `query failed: ${result.error.message}`,
    };
  }
  return {
    name: 'no_stuck_raw',
    pass: result.value === 0,
    detail: `raw_luma_event rows stuck pending > 5m: ${result.value}`,
  };
}

async function checkHealth(): Promise<CheckResult> {
  // A representative read that touches the entity layer, joins, and the
  // RLS-respecting selection path the cockpit will use. If this succeeds,
  // the database is up and reachable through @atlas/db.
  const svc = getServiceClient();
  if (isErr(svc)) {
    return { name: 'health', pass: false, detail: svc.error.message };
  }
  const r = await svc.value
    .from('event')
    .select('id, title, starts_at')
    .order('starts_at', { ascending: false })
    .limit(1);
  if (r.error) {
    return { name: 'health', pass: false, detail: r.error.message };
  }
  return {
    name: 'health',
    pass: true,
    detail: `latest event probe returned ${(r.data ?? []).length} row(s)`,
  };
}

function formatErr(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function main(): Promise<void> {
  const checks: CheckResult[] = [];
  checks.push(await checkSchema());
  checks.push(await checkEventCount());
  checks.push(await checkPersonCount());
  checks.push(await checkResolutionPerPerson());
  checks.push(await checkNoStuckRaw());
  checks.push(await checkHealth());

  const passing = checks.filter((c) => c.pass).length;
  const failing = checks.length - passing;

  const lines: string[] = [
    '',
    'Phase 1 exit-criteria verification',
    '──────────────────────────────────────',
  ];
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    lines.push(`  [${tag}] ${c.name.padEnd(22)} — ${c.detail}`);
  }
  lines.push('');
  lines.push(`Result: ${passing}/${checks.length} checks passed`);
  lines.push('');
  process.stdout.write(lines.join('\n'));

  if (failing > 0) {
    process.exitCode = 1;
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(`verify:phase-1 failed: ${formatErr(cause)}\n`);
  process.exitCode = 1;
});
